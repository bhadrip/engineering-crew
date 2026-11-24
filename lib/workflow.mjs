import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { CrewError, id, parseReviewFindings, requireField, text, validateResponse } from './contracts.mjs';
import { artifact, artifactDigest, findPublishedWorkspaceRun } from './run-store.mjs';
import { inputOnlyPolicy } from './codex.mjs';
import { executeWorkflowCodex } from './workflow-codex.mjs';
import { codexReplyBytes, musicCodexAgent, savesWorkspaceCheckpoint } from './workflow-native.mjs';
import { browserActivitySlot, isBrowserOutput, isEvidenceOutput, isImageOutput, isRuntimeEvidenceSlot,
  validateWorkflowArtifacts, workflowOutputSlot } from './workflow-artifacts.mjs';
import { evaluateWorkflowCondition, validateWorkflowRouting } from './workflow-routing.mjs';
import { validateWorkflowPolicies } from './workflow-policy.mjs';
import { listGeneratedImagesTool, workflowSubmissionTools, workspaceCheckpointTool } from './workflow-submissions.mjs';
import { discardCodexCheckpoint, readWorkspaceCheckpoint, recordCodexCheckpoint, recordWorkspaceCheckpoint,
  workspaceCheckpointReference } from './workflow-checkpoint.mjs';
import { validateRuntimeEvidenceRouting, validateWorkflowImageRouting, workflowBriefInput, workflowRequestBrief,
  workflowRequestImageSteps } from './workflow-intake.mjs';
import { readWorkspaceArtifact, usesPublishedWorkspace, validateRepositoryInstructionWorkspace, validateWorkspaceSteps, workspaceFiles,
  workspaceRepositoryInstruction } from './workflow-workspace.mjs';
import { runMusicWorkspaceChecks, validateMusicWorkspaceChecks } from './workflow-music-checks.mjs';
import { agentConversationEnabled, agentConversationHistory, agentMessageLimit, canAllowAdditionalAttempt, canReuseCodexHistory, finishWorkflowSession, infrastructureRetry,
  packetAttemptsUsed, savedCodexHistory, workflowAttemptLimit, workflowSessionControls } from './workflow-session.mjs';
import { executeEvidence } from './checks.mjs';
import { langfuseConfig, langfuseSpan, publishLangfuse } from './langfuse.mjs';
import { elapsedMs, estimateAttemptUsd, runUsage, taskUsage } from './usage.mjs';
import { currentAttempt } from './attempts.mjs';
import { subagentRoleToml } from './workflow-subagents.mjs';
import { workflowHookPolicy, workflowHooksJson } from './workflow-hooks.mjs';
import { nativeSkillChoices, validateSkillInvocations } from './workflow-skills.mjs';
import { agentImageArtifacts, agentImageLimits, agentImagesEnabled, browserScreenshotArtifact, codexGeneratedImage, codexGeneratedImageArtifact,
  imageArtifactReferences, normalizeAgentImages, readAgentImage } from './agent-images.mjs';
import { isProvisioning, openResources, provisionResource, recordResourceRequests, recordResourceResolution, resourceWait } from './resources.mjs';

export async function prepareWorkflowRun(db, snapshot, runId, { deliveryRunId, ...options } = {}) {
  const usesDelivery = usesPublishedWorkspace(snapshot.project);
  if (deliveryRunId !== undefined) {
    id(deliveryRunId, 'delivery run ID');
    requireField(usesDelivery, 'Choose a workflow version that uses a published workspace.');
  }
  const sourceDelivery = usesDelivery ? await findPublishedWorkspaceRun(db, snapshot.project.id, deliveryRunId) : undefined;
  if (deliveryRunId && !sourceDelivery) throw new CrewError('Published delivery unavailable in this project.', 4);
  requireField(sourceDelivery || snapshot.workspaceBaseline?.files.length ||
    !snapshot.project.tasks.some(task => task.workspaceSource === 'delivery' && task.workspaceCheck),
  'This workflow checks the starting workspace. Publish a delivery or pin committed project files before starting it.');
  return newRun(snapshot, runId, undefined, { ...options, sourceDelivery, deliveryRunId });
}

export function newRun(snapshot, runId, projectPath,
  { pauseDispatch = false, requestBrief, sourceDelivery, deliveryRunId, agentImages = [], requestImages = [], workflowTest } = {}) {
  const { project, files, sourceCommit, sourceFiles, raw, agentRun } = snapshot;
  const version = workflowTest ? undefined : snapshot.version;
  validateWorkflowPolicies(project, profileId => Array.isArray(snapshot.agentOrigins?.[profileId]?.codexTools));
  validateWorkflowRouting(project.tasks);
  validateRuntimeEvidenceRouting(project, snapshot.agentOrigins);
  validateWorkflowImageRouting(project, snapshot.agentOrigins);
  validateWorkspaceSteps(project, profileId => snapshot.agentOrigins?.[profileId]?.codexRuntime, snapshot.workspaceBaseline);
  validateMusicWorkspaceChecks(project);
  const fromGit = (id, title, kind, path) => artifact(id, title, kind, files.get(path), { source: 'git', sourceCommit, path });
  const configuration = workflowTest ? { source: 'workflow-test', sourceCommit, baseVersion: workflowTest.baseVersion } :
    version ? { source: 'postgres', version, sourceCommit } : agentRun?.draft ?
    { source: 'agent-draft', sourceCommit, baseVersion: agentRun.draft.baseVersion, baseAgentId: agentRun.draft.baseAgentId } : agentRun ?
    { source: 'agent-run', version: agentRun.version, sourceCommit } : { source: 'git', path: projectPath, sourceCommit };
  const artifacts = [artifact('project-config', workflowTest ? 'Tested workflow configuration' : agentRun ? 'Agent run configuration' : 'Project configuration',
    'json', raw ?? files.get(projectPath), configuration), ...agentImages];
  requireField(!agentImages.length || (agentRun && agentImagesEnabled(project.id) && project.tasks.length === 1),
    'Image attachments require a Music Transcribe agent run.');
  requireField(!requestImages.length || (!agentRun && requestBrief !== undefined && version && workflowRequestImageSteps(project).length),
    'The selected workflow version has no steps configured to receive request images.');
  requireField(requestImages.every(image => image.kind === 'agent-image' && image.provenance?.source === 'workflow-request-image' &&
    image.provenance.runId === runId), 'The attachments do not match the workflow request.');
  let workspaceBaseline;
  if (snapshot.workspaceBaseline) {
    const { commit, files } = snapshot.workspaceBaseline;
    requireField(/^[a-f0-9]{40,64}$/.test(commit), 'Expected a pinned workspace revision.');
    const saved = workspaceFiles(files);
    const record = artifact('workspace-baseline', 'Pinned project workspace', 'workspace', JSON.stringify({ schemaVersion: 1, files: saved.files }),
      { source: 'git-workspace', sourceCommit: commit });
    artifacts.push(record);
    workspaceBaseline = { artifactId: record.id, digest: record.digest, sourceCommit: commit, fileCount: files.length, bytes: saved.bytes };
  }
  let workspaceDeliveryBase;
  if (sourceDelivery) {
    requireField(usesPublishedWorkspace(project) && sourceDelivery.project.id === project.id &&
      (!deliveryRunId || sourceDelivery.id === deliveryRunId), 'The selected delivery does not belong to this workflow project.');
    const { candidate, deliveryDigest, files } = publishedWorkspace(sourceDelivery);
    if (project.id === 'music-transcribe' && project.tasks.some(task => task.workspaceSource === 'delivery' &&
      snapshot.agentOrigins?.[task.profileId]?.codexRuntime?.repositoryInstructions) && workspaceRepositoryInstruction(files))
      validateRepositoryInstructionWorkspace(files);
    const source = findArtifact(sourceDelivery, candidate.workspace.artifactId);
    const record = artifact('workspace-delivery-base', 'Published workspace base', 'workspace', source.content,
      { source: 'published-workspace-base', runId: sourceDelivery.id, artifactId: source.id, deliveryDigest });
    artifacts.push(record);
    workspaceDeliveryBase = { artifactId: record.id, digest: record.digest, sourceRunId: sourceDelivery.id,
      sourceArtifactId: source.id, sourceReceiptId: candidate.checks.artifactId, deliveryDigest,
      publishedAt: sourceDelivery.workspaceDelivery.publishedAt };
  }
  const overrides = new Map(snapshot.inputOverrides);
  let request;
  if (requestBrief !== undefined) {
    const input = workflowBriefInput(project);
    requireField(version && input, 'Choose a saved workflow version with a brief input used by the workflow.');
    const body = workflowRequestBrief(requestBrief);
    const line = body.split('\n').find(value => value.trim()).trim();
    const title = line.length > 120 ? line.slice(0, 119).trimEnd() + '…' : line;
    const brief = artifact(`input-${input.id}`, 'Request brief', 'text', body, { source: 'workflow-request', runId });
    request = { title, briefArtifactId: brief.id, briefDigest: brief.digest,
      ...(requestImages.length && { imageInputs: imageArtifactReferences(requestImages) }) };
    artifacts.push(brief, ...requestImages);
  }
  for (const input of project.inputs) {
    const inputId = `input-${input.id}`;
    if (inputId === request?.briefArtifactId) continue;
    artifacts.push(overrides.has(input.id)
      ? artifact(inputId, agentRun && input.id === 'brief' ? 'Agent run prompt' : input.title, 'text', overrides.get(input.id), configuration)
      : fromGit(inputId, input.title, 'text', input.path));
  }
  const profiles = project.profiles.map(profile => {
    const instructionId = `profile-${profile.id}`;
    const origin = snapshot.agentOrigins?.[profile.id];
    const profileProvenance = origin?.draft ? { ...configuration, definitionDigest: origin.draft.digest } :
      origin && { source: 'agent-library', agentId: origin.agentId, version: origin.version,
        ...(origin.featureSource && { featureSource: origin.featureSource }) };
    const fromProfile = (id, title, path) => profileProvenance
      ? artifact(id, title, 'text', files.get(path), profileProvenance)
      : fromGit(id, title, 'text', path);
    artifacts.push(fromProfile(instructionId, `${profile.name} instructions`, profile.instructions));
    const projectSkill = index => {
      const ref = origin?.projectSkillRefs?.find(value => value.index === index);
      return ref && { source: 'project-skill', skillId: ref.id, version: ref.version,
        ...(origin.draft ? { agentDraft: true } : { agentId: origin.agentId, agentVersion: origin.version }) };
    };
    const skillIds = profile.skills.map((path, index) => {
      const skillId = `${instructionId}-skill-${index + 1}`;
      const provenance = projectSkill(index);
      const title = origin?.skillNames?.[index] ?? path;
      artifacts.push(provenance ? artifact(skillId, title, 'text', files.get(path), provenance) : fromProfile(skillId, title, path));
      return skillId;
    });
    const skillBundles = origin?.skillBundles?.map((bundle, index) => bundle && ({
      directory: bundle.directory, files: bundle.files.map(({ key, path, bytes, sha256 }, fileIndex) => {
        const artifactId = skillIds[index] + '-file-' + (fileIndex + 1);
        artifacts.push(artifact(artifactId, path, 'skill-resource', snapshot.skillAssets[key],
          { ...(projectSkill(index) ?? profileProvenance), path, bytes, sha256 }));
        return { path, artifactId };
      }),
    }));
    const subagentRoleIds = (origin?.codexRuntime?.subagentRoles ?? []).map((role, index) => {
      const roleId = instructionId + '-specialist-' + (index + 1);
      artifacts.push(artifact(roleId, role.name + '.toml', 'text', subagentRoleToml(role),
        profileProvenance));
      return roleId;
    });
    const hooks = origin?.codexRuntime?.hooks;
    const hookConfigId = hooks && instructionId + '-hooks';
    if (hooks) artifacts.push(artifact(hookConfigId, 'Codex hooks.json', 'json', workflowHooksJson(hooks),
      profileProvenance));
    return { ...profile, instructionId, skillIds, ...(skillBundles && { skillBundles }),
      ...(subagentRoleIds.length && { subagentRoleIds }),
      ...(hookConfigId && { hookConfigId }),
      ...(origin && { codexTools: origin.codexTools, skillNames: origin.skillNames, codexRuntime: origin.codexRuntime }),
      ...(origin?.projectMcp?.length && { projectMcp: origin.projectMcp }),
      ...(origin?.musicPracticeProfile && { musicPracticeProfile: origin.musicPracticeProfile }),
      ...(origin?.musicBrowserProfile && { musicBrowserProfile: origin.musicBrowserProfile }) };
  });
  const tasks = project.tasks.map(({ alternateProfiles, ...task }) => {
    const profile = profiles.find(profile => profile.id === task.profileId);
    const images = task.receiveRequestImages ? requestImages : agentImages;
    const packet = { ...task, outputs: task.outputs.map(workflowOutputSlot), schemaVersion: 1, runId, taskId: task.id, packetRevision: task.revision, sourceCommit,
      budget: { ...task.budget, costOwner: task.budget.costOwner ?? project.costOwner ?? task.acceptedBy },
      profileRef: { id: profile.id, revision: profile.revision },
      ...(images.length && { imageInputIds: images.map(image => image.id) }),
      inputArtifacts: task.inputs.map(input => `input-${input}`) };
    const packetId = `packet-${task.id}`;
    artifacts.push(artifact(packetId, `${task.title} packet`, 'json', JSON.stringify(packet, null, 2),
      configuration));
    return { packet, packetId, attempts: [], ...(alternateProfiles ? { alternateProfiles } : {}) };
  });
  requireField(new Set(artifacts.map(value => value.id)).size === artifacts.length, 'Conflicting generated artifact IDs');
  const run = { schemaVersion: 1, id: runId, startedAt: new Date().toISOString(), epic: project.epic,
    project: { id: project.id, name: project.name, crewName: project.crewName, runtime: project.runtime,
      ...(version ? { configurationVersion: version } : { path: projectPath }) },
    sourceCommit, sourceFiles, profiles, tasks, artifacts,
    ...(request && { workflowRequest: request }),
    ...(workspaceBaseline && { workspaceBaseline }),
    ...(workspaceDeliveryBase && { workspaceDeliveryBase }),
    ...(deliveryRunId && { requestedDeliveryRunId: deliveryRunId }),
    ...(project.workspaceCheckProfile && { workspaceCheckProfile: project.workspaceCheckProfile }),
    ...(project.dispatchMode === 'automatic' && { automation: { enabled: !pauseDispatch, pending: false } }),
    ...(agentRun && { agentRun }),
    ...(workflowTest && { workflowTest }),
    ...(project.resourcePolicy ? { resourcePolicy: project.resourcePolicy } : {}),
    ...(project.orchestration ? { orchestration: project.orchestration, fixLoops: [] } : {}) };
  const { mode = 'static', briefInput = 'brief', owners } = project.triage ?? {};
  const brief = artifacts.find(value => value.id === `input-${briefInput}`);
  run.triage = { mode, status: 'pending',
    ...(brief ? { brief: { artifactId: brief.id, digest: brief.digest } } : {}),
    ...(owners ? { owners } : {}) };
  if (mode === 'static') recordTeam(run, { recordedAt: run.startedAt });
  return run;
}

function recordTeam(run, decision) {
  const { mode, brief, owners } = run.triage;
  const artifactId = 'triage-decision';
  run.triage = { mode, brief, owners, status: 'assigned', ...decision, artifactId,
    assignments: run.tasks.map(({ packet }) => ({
      taskId: packet.id, profileId: packet.profileRef.id, profileRevision: packet.profileRef.revision,
    })) };
  run.artifacts.push(artifact(artifactId, 'Team assignment record', 'json',
    JSON.stringify({ schemaVersion: 1, runId: run.id, ...run.triage }, null, 2), { source: 'triage', sourceCommit: run.sourceCommit }));
  queueAutomaticDispatch(run);
  return run.triage;
}

export function triageRun(store, owner, note, overrides = [], { pauseDispatch = false } = {}) {
  text(note, 'triage reason', 2_000);
  return store.update(run => {
    if (run.triage?.status !== 'pending') throw new CrewError('This run is not awaiting triage', 3);
    requireField(run.triage.owners.includes(owner), 'Select a configured triage owner');
    const { artifactId, digest } = run.triage.brief;
    requireField(findArtifact(run, artifactId).digest === digest, 'The pinned brief no longer matches the run');
    const assigned = new Set();
    for (const { taskId, profileId } of overrides) {
      requireField(!assigned.has(taskId), `Duplicate assignment for ${taskId}`);
      assigned.add(taskId);
      const task = findTask(run, taskId);
      if (profileId === task.packet.profileId) continue;
      requireField(!task.packet.invokeSkills?.length, `${task.packet.title} invokes skills from its pinned agent version`);
      requireField(task.alternateProfiles?.includes(profileId), `Profile ${profileId} is not eligible for ${taskId}`);
      const profile = run.profiles.find(profile => profile.id === profileId);
      requireField(!task.packet.imageInputIds?.length || Array.isArray(profile.codexTools),
        `${task.packet.title} requires a Codex agent that can receive its images`);
      const revision = task.packet.revision + 1;
      task.packet = { ...task.packet, profileId, profileRef: { id: profileId, revision: profile.revision },
        revision, packetRevision: revision };
      task.packetId = `assigned-packet-${taskId}`;
      run.artifacts.push(artifact(task.packetId, `${task.packet.title} packet`, 'json', JSON.stringify(task.packet, null, 2),
        { source: 'triage', sourceCommit: run.sourceCommit, decisionId: 'triage-decision' }));
    }
    if (pauseDispatch && run.automation) run.automation.enabled = false;
    return recordTeam(run, { owner, note, recordedAt: new Date().toISOString() });
  });
}

function findTask(run, taskId) {
  id(taskId, 'task ID');
  const task = run.tasks.find(task => task.packet.id === taskId);
  if (!task) throw new CrewError(`Task ${taskId} does not exist`, 4);
  return task;
}

export function queueAgentFollowUp(store, taskId, { attemptId, kind, message, invokeSkills = [], images = [] }) {
  requireField(kind === 'resume' || kind === 'fork', 'Choose whether to continue or fork the Codex conversation.');
  const body = text(message, 'follow-up message', agentMessageLimit).replace(/\r\n?/g, '\n');
  requireField(Buffer.byteLength(body) <= agentMessageLimit && !body.includes('\0'), 'Enter a follow-up of up to 12,000 bytes.');
  const attachments = normalizeAgentImages(images);
  return store.update(run => {
    const task = findTask(run, taskId);
    const profile = run.profiles.find(profile => profile.id === task.packet.profileId);
    const selection = validateSkillInvocations(invokeSkills, nativeSkillChoices(profile.codexRuntime?.workspace, profile.skillNames));
    const prior = task.packet.agentFollowUp;
    if (prior?.history.attemptId === attemptId && prior.history.kind === kind && prior.messageDigest === artifactDigest(body) &&
      isDeepStrictEqual(prior.invokeSkills ?? [], selection) && isDeepStrictEqual(
        (task.packet.imageInputIds ?? []).map(id => {
          const record = findArtifact(run, id);
          return [record.title, record.provenance.sha256];
        }), attachments.map(({ name, sha256 }) => [name, sha256]))) return;
    const attempt = currentAttempt(task);
    if (!attempt || attempt.id !== attemptId)
      throw new CrewError('This turn is no longer current. Review the latest reply before sending another message.', 3);
    const history = agentConversationHistory(run, task, attempt);
    const receipt = runtimeRecord(run, attempt, attempt.receiptId);
    if (!history || receipt?.threadId !== history.threadId || receipt?.turnId !== history.turnId ||
      !hasEvidence(run, task.packet, attempt))
      throw new CrewError('The latest turn has no matching saved Codex conversation. Reopen the agent run.', 3);
    const revision = task.packet.revision + 1;
    const turn = artifact('agent-message-' + revision, 'Follow-up message ' + revision, 'text', body,
      { source: 'agent-follow-up', runId: run.id, attemptId, turn: revision });
    const imageRecords = agentImageArtifacts(attachments, revision);
    const { imageInputIds: _priorImageIds, ...priorPacket } = task.packet;
    task.packet = { ...priorPacket, revision, packetRevision: revision, objective: 'Respond to the latest message in this Codex conversation.',
      inputArtifacts: [turn.id, ...task.packet.inputArtifacts.slice(1)],
      ...(imageRecords.length && { imageInputIds: imageRecords.map(image => image.id) }),
      agentFollowUp: { history: { kind, taskId, ...history }, messageArtifactId: turn.id, messageDigest: turn.digest,
        ...(selection.length && { invokeSkills: selection }) },
      ...(profile.codexRuntime.workspace === 'workspace-write' && { captureWorkspace: true }) };
    task.packetId = 'packet-' + taskId + '-r' + revision;
    run.artifacts.push(turn, ...imageRecords, artifact(task.packetId, task.packet.title + ' · turn ' + revision, 'json', JSON.stringify(task.packet, null, 2),
      turn.provenance));
    task.activeFrom = task.attempts.length;
    delete task.dispatchIssue;
    run.automation = { enabled: true, pending: true, changedAt: new Date().toISOString() };
  });
}

export function findArtifact(run, artifactId) {
  const value = run.artifacts.find(item => item.id === artifactId);
  if (!value) throw new CrewError('Artifact does not exist', 4);
  requireField(typeof value.content === 'string' && artifactDigest(value.content) === value.digest,
    `Artifact ${artifactId} does not match its recorded digest`);
  return value;
}

function verifyAgentDraft(run, profile) {
  const draft = run.agentRun?.draft;
  if (!draft) return;
  const record = findArtifact(run, draft.artifactId);
  const instructions = findArtifact(run, profile.instructionId);
  requireField(record.digest === draft.digest && record.provenance.source === 'agent-draft' &&
    record.provenance.runId === run.id && record.provenance.sourceCommit === run.sourceCommit &&
    instructions.provenance.definitionDigest === draft.digest, 'The tested agent definition does not match this run.');
  return draft;
}

function recentConversation(run, task) {
  const turns = new Map(task.attempts.map(attempt => [attempt.packetRevision, attempt]));
  if (!currentAttempt(task)) turns.set(task.packet.revision, null);
  const content = artifactId => {
    if (!artifactId) return;
    try { return findArtifact(run, artifactId).content; }
    catch (error) { if (!(error instanceof CrewError)) throw error; }
  };
  return Array.from(turns).slice(-6).map(([number, attempt]) => {
    const inputId = (attempt?.inputArtifacts ?? task.packet.inputArtifacts)[0];
    const outputId = attempt?.result?.artifacts?.result;
    return { number, inputId, message: content(inputId), outputId, response: content(outputId),
      imageIds: attempt ? (attempt.imageInputs ?? []).map(image => image.artifactId) : task.packet.imageInputIds ?? [],
      ...(attempt?.generatedImages?.length && { generatedImageIds: attempt.generatedImages.map(image => image.artifactId) }),
      ...(attempt && { attemptId: attempt.id, attemptNumber: attempt.number }),
      mode: attempt?.codexHistory?.kind ?? (number === task.packet.revision ? task.packet.agentFollowUp?.history.kind : undefined) };
  });
}

export function summarize(run, { includeAgentConversation = false } = {}) {
  const { artifacts, sourceFiles, ...rest } = run;
  const tasks = run.tasks.map(task => {
    const attempts = task.attempts.map(({ candidateFiles, candidateFilesDigest, candidateDiff, ...attempt }) => {
      const running = attempt.outcome === 'running';
      let packet = task.packet;
      if (run.agentRun && attempt.packetRevision !== packet.revision) {
        try { packet = JSON.parse(findArtifact(run, attempt.packetId).content); }
        catch (error) { if (!(error instanceof CrewError || error instanceof SyntaxError)) throw error; packet = null; }
      }
      const evidenceStatus = running ? 'pending' : packet && hasEvidence(run, packet, attempt) ? 'recorded' : 'missing';
      const receipt = runtimeRecord(run, attempt, attempt.receiptId);
      return { ...attempt, evidenceStatus, verification: verificationOf(run, attempt), trace: traceOf(run, attempt),
        durationMs: running ? null : elapsedMs(attempt.startedAt, attempt.endedAt),
        codexDurationMs: running ? null : elapsedMs(receipt?.startedAt, receipt?.endedAt),
        estimatedUsd: estimateAttemptUsd(attempt.usage, attempt.runtime, attempt.codexSpeed?.applied ?? attempt.requestedServiceTier),
        reviewFindings: evidenceStatus === 'recorded' ? reviewOf(run, task, attempt)?.findings : undefined };
    });
    return { ...task, attempts, ...(task.routing && { routingVerified: hasRoutingEvidence(run, task) }),
      ...(task.packet.workspaceRepair && { workspaceRepairStatus: workspaceRepairStatus(run, task) }),
      ...(includeAgentConversation && run.agentRun && run.project.id === 'music-transcribe' && { conversation: recentConversation(run, task) }),
      usage: taskUsage({ packet: task.packet, attempts }) };
  });
  const fix = run.orchestration ? fixStatus(run) : undefined;
  return { ...rest, tasks, ...runOverview(run), epic: epicOf(run), fix,
    usage: runUsage(tasks, run.profiles), quality: runQuality(tasks),
    ...(fix ? { backlog: reviewBacklog(tasks, run.orchestration.reviewTasks) } : {}),
    artifacts: artifacts.map(({ content, ...metadata }) => metadata) };
}

function traceOf(run, attempt) {
  if (attempt.trace?.status !== 'verified') return attempt.trace;
  try {
    if (findArtifact(run, attempt.receiptId).digest === attempt.trace.receiptDigest &&
      Object.entries(attempt.trace.activityDigests ?? {}).every(([id, digest]) => findArtifact(run, id).digest === digest)) return attempt.trace;
  } catch (error) { if (!(error instanceof CrewError)) throw error; }
  return { status: 'unverified', error: 'The trace no longer matches the local attempt records.' };
}

export async function publishAttemptTrace(store, control, taskId, attemptId, env = process.env, { includeActivity = false } = {}) {
  const run = await store.read();
  const task = findTask(run, taskId);
  const attempt = attemptId ? task.attempts.find(attempt => attempt.id === attemptId) : currentAttempt(task);
  requireField(attempt && attempt.outcome !== 'running' && attempt.receiptId, 'Select an attempt with a recorded Codex receipt');
  const record = findArtifact(run, attempt.receiptId);
  const receipt = JSON.parse(record.content);
  requireField(record.provenance.source === 'runtime' && record.provenance.attemptId === attempt.id &&
    receipt.attemptId === attempt.id && receipt.runId === run.id && receipt.taskId === taskId &&
    receipt.sourceCommit === run.sourceCommit, 'Codex receipt does not match the selected attempt');
  let activity;
  let activityDigests;
  let checks;
  let candidate;
  if (includeActivity) {
    requireField(attempt.activityId, 'This attempt has no captured prompt and response. Use --capture-activity on a new dispatch.');
    activityDigests = {};
    const readActivityRecord = id => {
      const value = findArtifact(run, id);
      requireField(value.provenance.source === 'runtime' && value.provenance.attemptId === attempt.id,
        'Activity record does not match the selected attempt');
      activityDigests[id] = value.digest;
      return JSON.parse(value.content);
    };
    activity = readActivityRecord(attempt.activityId);
    if (attempt.runnerArtifacts?.['check-receipt']) checks = readActivityRecord(attempt.runnerArtifacts['check-receipt']);
    if (attempt.runnerArtifacts?.candidate) candidate = readActivityRecord(attempt.runnerArtifacts.candidate);
  }
  const config = await langfuseConfig(control, env);
  const span = langfuseSpan({ run, task, attempt, record, receipt, activity, activityDigests, checks, candidate }, config.projectId);

  function persist(trace) {
    return store.update(current => {
      const target = findTask(current, taskId).attempts.find(value => value.id === attempt.id);
      requireField(target && findArtifact(current, target.receiptId).digest === record.digest &&
        Object.entries(activityDigests ?? {}).every(([id, digest]) => findArtifact(current, id).digest === digest),
      'The local attempt records changed during export');
      const previous = traceOf(current, target);
      if (previous?.status !== 'verified' || (trace.status === 'verified' && (includeActivity || !previous.activityDigests))) {
        target.trace = trace;
      }
    });
  }

  let trace;
  try { trace = await publishLangfuse(config, span); }
  catch (error) {
    if (!(error instanceof CrewError)) throw error;
    await persist({ status: 'unverified', error: error.message });
    throw error;
  }
  const verified = { ...trace, receiptDigest: record.digest, ...(includeActivity ? { activityDigests } : {}) };
  await persist(verified);
  return verified;
}

function hasEvidence(run, packet, attempt) {
  const references = [attempt.receiptId];
  if (attempt.outcome === 'completed' && attempt.requestedServiceTier) {
    const speed = runtimeRecord(run, attempt, attempt.receiptId)?.codexSpeed;
    if (!isDeepStrictEqual(speed, attempt.codexSpeed) || speed?.requested !== attempt.requestedServiceTier || speed.applied !== speed.requested)
      return false;
  }
  if (run.agentRun?.draft) {
    try {
      const draft = verifyAgentDraft(run, run.profiles.find(profile => profile.id === packet.profileId));
      if (!isDeepStrictEqual(runtimeRecord(run, attempt, attempt.receiptId)?.agentDraft, draft)) return false;
    } catch (error) { if (error instanceof CrewError) return false; throw error; }
  }
  if (packet.responseMode === 'free-form' && attempt.result) {
    const receipt = runtimeRecord(run, attempt, attempt.receiptId);
    const activity = runtimeRecord(run, attempt, attempt.activityId);
    if (receipt?.responseFormat !== 'free-form' || activity?.responseFormat !== 'free-form' || typeof activity.response !== 'string' ||
        artifactDigest(activity.response) !== receipt.replyDigest) return false;
    try {
      const outputs = Object.entries(attempt.result.artifacts);
      if (!isDeepStrictEqual(receipt.submittedOutputDigests,
        Object.fromEntries(outputs.map(([slot, id]) => {
          const record = findArtifact(run, id);
          const kind = packet.outputs.find(output => output.id === slot)?.kind;
          if (isEvidenceOutput(kind)) {
            const evidence = workflowEvidenceOf(run, attempt, kind, id);
            if (isBrowserOutput(kind)) requireField(receipt.browserActionIds?.includes(evidence.browserActionId),
              'The output has no matching browser action in the execution receipt.');
          }
          else requireField(record.kind !== 'agent-image', 'The submitted image does not match its output slot.');
          return [slot, record.digest];
        })))) return false;
      references.push(attempt.activityId, ...outputs.map(([, id]) => id));
    } catch (error) { if (error instanceof CrewError) return false; throw error; }
  }
  if (attempt.outcome === 'completed' && attempt.repositoryInstruction) {
    const source = attempt.repositoryInstruction;
    try {
      const record = findArtifact(run, source.artifactId);
      if (!isDeepStrictEqual(runtimeRecord(run, attempt, attempt.receiptId)?.repositoryInstruction, source) ||
          record.digest !== source.digest || record.provenance.attemptId !== attempt.id) return false;
    } catch (error) { if (error instanceof CrewError) return false; throw error; }
  }
  if (attempt.outcome === 'completed' && attempt.skillInputs?.length) {
    const supplied = runtimeRecord(run, attempt, attempt.receiptId)?.explicitSkills;
    if (!Array.isArray(supplied) || supplied.length !== attempt.skillInputs.length || !attempt.skillInputs.every(({ artifactId, digest }, index) => {
      try { return supplied[index]?.artifactId === artifactId && supplied[index]?.digest === digest &&
        findArtifact(run, artifactId).digest === digest; }
      catch (error) { if (error instanceof CrewError) return false; throw error; }
    })) return false;
  }
  if (attempt.outcome === 'completed' && attempt.imageInputs?.length) {
    const received = runtimeRecord(run, attempt, attempt.receiptId)?.imageInputs;
    if (!isDeepStrictEqual(received, attempt.imageInputs) || !attempt.imageInputs.every(({ artifactId, sha256, handoff }) => {
      try {
        const record = findArtifact(run, artifactId);
        if (handoff) {
          const producer = findTask(run, handoff.taskId);
          const source = producer.attempts.find(value => value.id === handoff.attemptId);
          const kind = producer.packet.outputs.find(value => value.id === handoff.slot)?.kind;
          if (source?.decision?.disposition !== 'accepted' || source.result?.artifacts?.[handoff.slot] !== artifactId ||
              handoff.artifactId !== artifactId || handoff.digest !== record.digest ||
              !attempt.handoffs?.some(value => isDeepStrictEqual(value, handoff))) return false;
          if (!isImageOutput(kind)) return false;
          workflowEvidenceOf(run, source, kind, artifactId);
        }
        return record.kind === 'agent-image' && record.provenance.sha256 === sha256;
      } catch (error) { if (error instanceof CrewError) return false; throw error; }
    })) return false;
  }
  if (attempt.generatedImages?.length) {
    const receiptImages = runtimeRecord(run, attempt, attempt.receiptId)?.generatedImages;
    if (!isDeepStrictEqual(receiptImages, attempt.generatedImages) || !attempt.generatedImages.every(image => {
      try { return generatedImageOf(run, attempt, image.artifactId) === image; }
      catch (error) { if (error instanceof CrewError) return false; throw error; }
    })) return false;
  }
  if (packet.execution && attempt.result?.state === 'completed') {
    references.push(attempt.runnerArtifacts?.['check-receipt']);
    if (packet.execution.kind === 'build') references.push(attempt.runnerArtifacts?.candidate);
  }
  if (attempt.result?.state === 'completed') {
    references.push(...packet.outputs.filter(slot => slot.required).map(slot => attempt.result.artifacts[slot.id]));
    if (packet.captureWorkspace) references.push(attempt.workspaceOutput?.artifactId);
    if (packet.workspaceCheck && verificationOf(run, attempt)?.kind !== 'workspace-acceptance') return false;
    try {
      if (isRuntimeHandoff(run, packet.id, browserActivitySlot) &&
          run.tasks.some(task => task.packet.handoffInputs?.some(input => input.task === packet.id && input.slot === browserActivitySlot)))
        browserActivityRecords(run, packet.id, attempt);
      if (!runtimeHandoffsMatch(run, packet, attempt)) return false;
    } catch (error) { if (error instanceof CrewError) return false; throw error; }
  }
  const routing = [...(attempt.routingDecision ? [{ taskId: packet.id, ...attempt.routingDecision }] : []),
    ...(attempt.skippedPrerequisites ?? [])];
  const workspace = [attempt.workspaceInput, attempt.workspaceOutput].filter(Boolean);
  if (attempt.workspaceRepair) {
    const repair = run.workspaceRepairs?.find(record => record.id === attempt.workspaceRepair.id);
    try {
      if (!repair || findArtifact(run, repair.id).digest !== repair.digest) return false;
    } catch (error) { if (error instanceof CrewError) return false; throw error; }
  }
  return references.every(reference => {
    try { return findArtifact(run, reference).provenance.attemptId === attempt.id; }
    catch (error) { if (error instanceof CrewError) return false; throw error; }
  }) && workspace.every(({ artifactId, digest }) => {
    try { const record = findArtifact(run, artifactId); return record.kind === 'workspace' && record.digest === digest; }
    catch (error) { if (error instanceof CrewError) return false; throw error; }
  }) && routing.every(({ taskId, artifactId, digest }) => {
    try {
      const record = findArtifact(run, artifactId);
      return record.digest === digest && record.provenance.source === 'routing' && record.provenance.taskId === taskId;
    } catch (error) { if (error instanceof CrewError) return false; throw error; }
  });
}

function generatedImageOf(run, attempt, artifactId) {
  const image = attempt.generatedImages?.find(value => value.artifactId === artifactId);
  requireField(image, 'Choose a generated image saved by this attempt. Use list_generated_images to find its artifact ID.');
  const record = findArtifact(run, artifactId);
  requireField(record.kind === 'agent-image' && record.digest === image.digest && record.provenance.source === 'codex-generated-image' &&
    record.provenance.attemptId === attempt.id && record.provenance.itemId === image.itemId && record.provenance.sha256 === image.sha256,
  'The generated image does not match its recorded evidence.');
  return image;
}

function workflowEvidenceOf(run, attempt, kind, artifactId) {
  if (kind === 'image') return generatedImageOf(run, attempt, artifactId);
  const screenshot = kind === 'browser-screenshot';
  const browserActionId = screenshot ? artifactId.replace(/^browser-screenshot-/, 'browser-action-') : artifactId;
  const report = attempt.browserActionIds?.includes(browserActionId) && runtimeRecord(run, attempt, browserActionId);
  requireField(report?.kind === 'workspace-browser' && !report.error && report.runId === run.id &&
    report.attemptId === attempt.id && /^[a-f0-9]{64}$/.test(report.workspaceDigest),
  'Choose a successful browser action recorded by this attempt.');
  if (attempt.workspaceInput && attempt.effectivePermissions?.sandbox === 'read-only')
    requireField(report.workspaceDigest === attempt.workspaceInput.digest && report.workspaceArtifactId === attempt.workspaceInput.artifactId,
      'The browser tested a different workspace than the assignment received.');
  const record = findArtifact(run, artifactId);
  if (screenshot) {
    requireField(report.action === 'screenshot' && report.imageEvidence?.artifactId === record.id &&
      record.provenance.source === 'codex-browser-screenshot' && record.provenance.attemptId === attempt.id,
    'Choose the image artifact from a browser screenshot recorded by this attempt.');
    const { sha256, mimeType, bytes } = readAgentImage(record);
    requireField(report.imageEvidence.sha256 === sha256 && report.imageEvidence.mimeType === mimeType && report.imageEvidence.bytes === bytes,
      'The screenshot does not match its recorded browser action.');
  }
  return { artifactId: record.id, digest: record.digest, browserActionId };
}

function runtimeRecord(run, attempt, reference) {
  if (!reference) return undefined;
  try {
    const record = findArtifact(run, reference);
    if (record.provenance.source === 'runtime' && record.provenance.attemptId === attempt.id) return JSON.parse(record.content);
  }
  catch (error) { if (error instanceof CrewError || error instanceof SyntaxError) return undefined; throw error; }
}

function browserActivityRecords(run, taskId, attempt) {
  const ids = attempt.browserActionIds;
  const receipt = runtimeRecord(run, attempt, attempt.receiptId);
  requireField(ids?.length && new Set(ids).size === ids.length &&
    isDeepStrictEqual(receipt?.browserActionIds, ids),
  'Browser activity is required and must match the producing execution receipt.');
  return ids.map(id => {
    const record = findArtifact(run, id);
    const report = runtimeRecord(run, attempt, id);
    requireField(record.digest === receipt.browserActionDigests?.[id] && report?.kind === 'workspace-browser' && report.runId === run.id &&
      report.taskId === taskId && report.attemptId === attempt.id, 'Browser activity is missing or belongs to another attempt.');
    if (!report.error && attempt.workspaceInput && attempt.effectivePermissions?.sandbox === 'read-only')
      requireField(report.workspaceDigest === attempt.workspaceInput.digest && report.workspaceArtifactId === attempt.workspaceInput.artifactId,
        'The browser activity does not match the workspace from the producing attempt.');
    return record;
  });
}

function isRuntimeHandoff(run, taskId, slot) {
  return run.project.id === 'music-transcribe' && isRuntimeEvidenceSlot(findTask(run, taskId).packet, slot);
}

function runtimeHandoffRecords(run, taskId, slot, source) {
  if (slot === browserActivitySlot) return browserActivityRecords(run, taskId, source);
  const verification = verificationOf(run, source);
  requireField(verification?.kind === 'workspace-acceptance' && verification.passed && verification.taskId === taskId,
    'Acceptance checks must pass on the workspace from the producing attempt.');
  return [findArtifact(run, source.runnerArtifacts['check-receipt'])];
}

function handoffReference(taskId, slot, attemptId, { id, digest }) {
  return { taskId, slot, attemptId, artifactId: id, digest };
}

function runtimeHandoffsMatch(run, packet, attempt) {
  const routes = (packet.handoffInputs ?? []).filter(({ task, slot }) => isRuntimeHandoff(run, task, slot) &&
    !attempt.skippedPrerequisites?.some(({ taskId }) => taskId === task));
  if (!routes.length) return true;
  const recorded = (attempt.handoffs ?? []).filter(({ taskId, slot }) => isRuntimeHandoff(run, taskId, slot));
  const expected = routes.flatMap(({ task, slot }) => {
    const producerId = recorded.find(item => item.taskId === task && item.slot === slot)?.attemptId;
    const producer = findTask(run, task).attempts.find(value => value.id === producerId);
    requireField(producer?.decision?.disposition === 'accepted', 'Runtime evidence must come from an accepted attempt.');
    return runtimeHandoffRecords(run, task, slot, producer).map(record => handoffReference(task, slot, producer.id, record));
  });
  return isDeepStrictEqual(recorded, expected) &&
    isDeepStrictEqual(runtimeRecord(run, attempt, attempt.receiptId)?.runtimeHandoffs, expected) &&
    expected.every(({ artifactId }) => attempt.inputArtifacts?.includes(artifactId));
}

function verificationOf(run, attempt) {
  const receipt = runtimeRecord(run, attempt, attempt.runnerArtifacts?.['check-receipt']);
  if (receipt?.kind === 'workspace-acceptance' && (receipt.workspaceArtifactId !== attempt.workspaceInput?.artifactId ||
      receipt.workspaceDigest !== attempt.workspaceInput?.digest || receipt.image !== run.workspaceCheckProfile?.image ||
      receipt.verifierDigest !== run.workspaceCheckProfile?.verifierDigest || !isDeepStrictEqual(receipt.fixtures, run.workspaceCheckProfile?.fixtures))) return;
  if (receipt?.checks?.length && Array.isArray(receipt.checks) && receipt.checks.every(check => typeof check?.passed === 'boolean')) return receipt;
}

function workspaceDeliveryCandidate(run, handoffs = handoffCounts(run)) {
  if (run.workflowTest) return;
  const task = run.tasks.find(step => step.packet.publishWorkspace === true);
  if (!task) return;
  const attempt = currentAttempt(task);
  const report = attempt && verificationOf(run, attempt);
  const status = { taskId: task.packet.id, attemptId: attempt?.id, canPublish: false };
  if (attempt?.decision?.disposition !== 'accepted' || report?.kind !== 'workspace-acceptance' || !report.passed ||
      !hasEvidence(run, task.packet, attempt)) return { ...status, reason: 'Accept the handoff with passing checks on this workspace.' };
  if (handoffs.accepted + (handoffs.skipped ?? 0) !== handoffs.total)
    return { ...status, reason: 'Finish the remaining workflow handoffs before publishing.' };
  const receipt = findArtifact(run, attempt.runnerArtifacts['check-receipt']);
  const workspace = findArtifact(run, attempt.workspaceInput.artifactId);
  const candidate = { taskId: task.packet.id, attemptId: attempt.id, image: report.image, sourceCommit: run.sourceCommit,
    workspace: { artifactId: workspace.id, digest: workspace.digest }, checks: { artifactId: receipt.id, digest: receipt.digest } };
  return { ...status, candidate, canPublish: true };
}

function publishedDeliveryMatches(run, candidate) {
  const delivery = run.workspaceDelivery;
  if (!candidate || !delivery || !isDeepStrictEqual(delivery.candidate, candidate)) return false;
  try {
    const record = findArtifact(run, delivery.artifactId);
    return record.digest === delivery.digest && record.provenance.source === 'workspace-delivery' && record.provenance.attemptId === candidate.attemptId;
  } catch (error) { if (error instanceof CrewError) return false; throw error; }
}

export function publishWorkspaceDelivery(store, attemptId) {
  return store.update(run => {
    if (run.workflowTest) throw new CrewError('Local delivery is available from saved workflow runs.', 3);
    const status = workspaceDeliveryCandidate(run);
    if (!status || !attemptId || status.attemptId !== attemptId) throw new CrewError('The selected verification changed. Reopen the workflow run.', 3);
    if (!status.canPublish) throw new CrewError(status.reason, 3);
    if (run.workspaceDelivery) {
      if (publishedDeliveryMatches(run, status.candidate)) return run.workspaceDelivery;
      throw new CrewError('The published delivery no longer matches its verification evidence.', 3);
    }
    const data = { schemaVersion: 1, runId: run.id, projectId: run.project.id,
      ...(run.project.configurationVersion && { configurationVersion: run.project.configurationVersion }),
      candidate: status.candidate, publishedAt: new Date().toISOString() };
    const record = artifact('workspace-delivery', 'Local delivery record', 'json', JSON.stringify(data, null, 2),
      { source: 'workspace-delivery', attemptId });
    run.artifacts.push(record);
    run.workspaceDelivery = { ...data, artifactId: record.id, digest: record.digest };
    return run.workspaceDelivery;
  });
}

export function publishedWorkspace(run) {
  const candidate = workspaceDeliveryCandidate(run)?.candidate;
  if (!publishedDeliveryMatches(run, candidate)) throw new CrewError('A published delivery with verified workspace evidence is required.', 3);
  const { files } = readWorkspaceArtifact(findArtifact(run, candidate.workspace.artifactId).content);
  return { projectId: run.project.id, candidate, files, deliveryDigest: run.workspaceDelivery.digest };
}

function runQuality(tasks) {
  const checks = { passed: 0, total: 0, missingReceipts: 0 };
  let reworkDecisions = 0;
  for (const task of tasks) {
    const attempt = currentAttempt(task);
    reworkDecisions += task.attempts.filter(value => value.decision?.disposition === 'rework').length;
    if ((!task.packet.execution && !task.packet.workspaceCheck) || !attempt || attempt.outcome === 'running') continue;
    if (attempt.verification) {
      checks.total += attempt.verification.checks.length;
      checks.passed += attempt.verification.checks.filter(check => check.passed).length;
    } else if (attempt.result?.state === 'completed' || attempt.outcome === 'check-failed') checks.missingReceipts++;
  }
  return { checks, reworkDecisions };
}

function reviewOf(run, task, attempt) {
  const slot = task.packet.outputs?.find(slot => slot.kind === 'review-findings');
  if (!slot || attempt?.outcome !== 'completed' || attempt.result?.state !== 'completed') return;
  try {
    const record = findArtifact(run, attempt.result.artifacts[slot.id]);
    if (record.provenance.attemptId === attempt.id) return { record, findings: parseReviewFindings(record.content) };
  } catch (error) { if (!(error instanceof CrewError)) throw error; }
}

function reviewBacklog(tasks, reviewTasks) {
  const backlog = new Map();
  for (const task of tasks.filter(task => reviewTasks.includes(task.packet.id))) {
    for (const attempt of task.attempts) {
      if (attempt.evidenceStatus !== 'recorded') continue;
      for (const finding of attempt.reviewFindings ?? []) {
        const key = `${task.packet.id}/${finding.id}`;
        if (finding.severity === 'backlog') backlog.set(key, { ...finding, taskId: task.packet.id, attempt: attempt.number });
        else backlog.delete(key);
      }
    }
  }
  return [...backlog.values()];
}

function affectedTasks(run, taskId = run.orchestration.buildTask) {
  const affected = new Set([taskId]);
  for (let previous = 0; previous !== affected.size;) {
    previous = affected.size;
    for (const task of run.tasks) {
      if (task.packet.prerequisites.some(id => affected.has(id))) affected.add(task.packet.id);
    }
  }
  return run.tasks.filter(task => affected.has(task.packet.id));
}

function workspaceRepairStatus(run, task) {
  const { workspaceRepair, workspaceSource } = task.packet;
  if (!workspaceRepair) return;
  const targetTaskId = workspaceSource.slice(5);
  const target = findTask(run, targetTaskId);
  const source = currentAttempt(target);
  const failed = currentAttempt(task);
  const report = failed && verificationOf(run, failed);
  const checkFailure = failed?.outcome === 'check-failed' && report?.checks.some(check => check.state === 'failed');
  const reviewFinding = run.project.id === 'music-transcribe' && failed?.outcome === 'completed' && report?.passed &&
    !failed.decision && !run.workspaceDelivery;
  const trigger = checkFailure ? 'check-failure' : reviewFinding ? 'review-finding' : undefined;
  const used = (run.workspaceRepairs ?? []).filter(record => record.verificationTaskId === task.packet.id).length;
  const { limit } = workspaceRepair;
  let reason;
  if (used >= limit) reason = 'This verification step has reached its repair limit.';
  else if (!trigger || failed?.result?.state !== 'completed' || !report || report.kind !== 'workspace-acceptance' || report.error ||
      !hasEvidence(run, task.packet, failed)) reason = 'Repair requires recorded verification evidence on this workspace.';
  else if (source?.decision?.disposition !== 'accepted' || !hasEvidence(run, target.packet, source) || !source.workspaceOutput ||
      source.workspaceOutput.artifactId !== failed.workspaceInput?.artifactId || source.workspaceOutput.digest !== failed.workspaceInput?.digest)
    reason = 'The verification no longer matches the accepted workspace.';
  else if (affectedTasks(run, targetTaskId).some(step => currentAttempt(step)?.outcome === 'running' || resourceWait(run, step).some(isProvisioning)))
    reason = 'Wait for active attempts and resource setup on this workspace to finish.';
  return { targetTaskId, attemptId: failed?.id, used, limit, canRequest: !reason, reason, trigger };
}

function recordWorkspaceRepair(run, task, status, note, actor) {
  const failed = currentAttempt(task);
  const source = currentAttempt(findTask(run, status.targetTaskId));
  const evidence = findArtifact(run, failed.runnerArtifacts['check-receipt']);
  const reports = task.packet.outputs.filter(slot => slot.required).map(slot => findArtifact(run, failed.result.artifacts[slot.id]));
  const record = {
    id: 'repair-' + randomUUID(), round: status.used + 1, targetTaskId: status.targetTaskId, sourceAttemptId: source.id,
    verificationTaskId: task.packet.id, verificationAttemptId: failed.id, workspace: source.workspaceOutput,
    evidence: [evidence, ...reports].map(({ id, digest }) => ({ id, digest })),
    note, actor, trigger: status.trigger, recordedAt: new Date().toISOString(),
  };
  const artifactRecord = artifact(record.id, 'Workspace repair decision', 'json', JSON.stringify({ schemaVersion: 1, runId: run.id, ...record }, null, 2),
    { source: 'workspace-repair', attemptId: failed.id });
  run.artifacts.push(artifactRecord);
  (run.workspaceRepairs ??= []).push({ ...record, digest: artifactRecord.digest });
  for (const affected of affectedTasks(run, status.targetTaskId)) {
    affected.activeFrom = affected.attempts.length;
    delete affected.routing;
    delete affected.dispatchIssue;
    delete affected.workspaceRepairId;
  }
  findTask(run, status.targetTaskId).workspaceRepairId = record.id;
  if (run.tasks.some(step => step.packet.runWhen)) recordWorkflowRouting(run, record.recordedAt);
  queueAutomaticDispatch(run);
  return record;
}

export function requestWorkspaceRepair(store, taskId, attemptId, note) {
  text(note, 'repair reason', 2_000);
  return store.update(run => {
    const task = findTask(run, taskId);
    const status = workspaceRepairStatus(run, task);
    if (!status || status.attemptId !== attemptId) throw new CrewError('The verification changed. Reopen the handoff.', 3);
    if (!status.canRequest) throw new CrewError(status.reason, 3);
    return recordWorkspaceRepair(run, task, status, note.trim(), task.packet.acceptedBy);
  });
}

function advanceWorkspaceRepairs(run) {
  for (const task of run.tasks) {
    if (task.packet.workspaceRepair?.mode !== 'automatic' || currentAttempt(task)?.decision) continue;
    const status = workspaceRepairStatus(run, task);
    if (status.canRequest && status.trigger === 'check-failure')
      recordWorkspaceRepair(run, task, status, 'Repair the workspace using the recorded verification failures.', 'Workflow');
  }
}

function fixStatus(run) {
  const { buildTask, reviewTasks, maxFixLoops } = run.orchestration;
  const build = currentAttempt(findTask(run, buildTask));
  const reviews = reviewTasks.map(id => {
    const task = findTask(run, id);
    const attempt = currentAttempt(task);
    const report = reviewOf(run, task, attempt);
    return report && attempt.decision?.disposition !== 'rework' && hasEvidence(run, task.packet, attempt) &&
      attempt.prerequisites.some(source => source.taskId === buildTask && source.attemptId === build?.id)
      ? { ...report, attempt } : undefined;
  });
  const used = run.fixLoops.length;
  const blockers = reviews.flatMap(review => review?.findings.filter(finding => finding.severity === 'blocker') ?? []).length;
  let reason;
  if (maxFixLoops === 0) reason = 'Fix loops are disabled for this run';
  else if (used >= maxFixLoops) reason = 'Fix loop limit reached';
  else if (build?.decision?.disposition !== 'accepted' || !build.candidate || reviews.some(review => !review)) {
    reason = 'Waiting for a candidate and all implementation review findings';
  } else if (!blockers) reason = 'No implementation blockers to route back to build';
  else if (affectedTasks(run).some(task => currentAttempt(task)?.outcome === 'running')) {
    reason = 'Wait for active attempts on this candidate to finish';
  }
  return { used, limit: maxFixLoops, blockers, canRequest: !reason, reason, buildAttemptId: build?.id };
}

export function requestFix(store, buildAttemptId, note) {
  text(note, 'fix loop reason', 2_000);
  return store.update(run => {
    requireField(run.orchestration, 'Implementation review loops are not configured for this run');
    const status = fixStatus(run);
    requireField(status.buildAttemptId === buildAttemptId, 'The build candidate changed before this decision');
    requireField(status.canRequest, status.reason);
    const { buildTask, decisionOwner, reviewTasks } = run.orchestration;
    const build = acceptedAttempt(run, buildTask);
    const diff = findArtifact(run, build.runnerArtifacts['candidate-diff']);
    requireField(diff.provenance.attemptId === build.id, 'The candidate diff does not match the accepted build');
    const reviews = reviewTasks.map(taskId => {
      const task = findTask(run, taskId);
      const attempt = currentAttempt(task);
      return { taskId, attemptId: attempt.id, record: reviewOf(run, task, attempt).record };
    });
    const loop = {
      number: status.used + 1, candidate: build.candidate.commit, buildAttemptId: build.id,
      owner: decisionOwner, note, recordedAt: new Date().toISOString(),
      reviews: reviews.map(({ taskId, attemptId }) => ({ taskId, attemptId })),
      artifacts: [diff, ...reviews.map(review => review.record)].map(({ id, digest }) => ({ id, digest })),
    };
    for (const task of affectedTasks(run)) {
      task.activeFrom = task.attempts.length;
      delete task.routing;
      delete task.dispatchIssue;
    }
    run.fixLoops.push(loop);
    queueAutomaticDispatch(run);
    return loop;
  });
}

function acceptedAttempt(run, taskId) {
  const task = findTask(run, taskId);
  const attempt = currentAttempt(task);
  if (attempt?.decision?.disposition !== 'accepted' || !hasEvidence(run, task.packet, attempt)) {
    throw new CrewError(`Waiting for accepted handoff: ${task.packet.title}`, 3);
  }
  return attempt;
}

function routingArtifact(run, task) {
  const record = findArtifact(run, task.routing?.artifactId);
  requireField(record.provenance.source === 'routing' && record.provenance.taskId === task.packet.id &&
    record.digest === task.routing.digest, 'The workflow routing decision does not match its evidence.');
  return record;
}

function hasRoutingEvidence(run, task) {
  try { return Boolean(routingArtifact(run, task)); }
  catch (error) { if (error instanceof CrewError) return false; throw error; }
}

function recordWorkflowRouting(run, recordedAt) {
  const byId = new Map(run.tasks.map(task => [task.packet.id, task]));
  const visited = new Set();
  function resolve(task) {
    const { packet } = task;
    if (visited.has(packet.id)) return;
    visited.add(packet.id);
    const prerequisites = packet.prerequisites.map(id => byId.get(id));
    prerequisites.forEach(resolve);
    if (task.routing || currentAttempt(task)) return;
    const skipped = prerequisites.find(parent => parent.routing?.status === 'skipped' && !packet.joinPrerequisites?.includes(parent.packet.id));
    const condition = packet.runWhen;
    let decision;
    if (skipped && hasRoutingEvidence(run, skipped)) {
      decision = { status: 'skipped', reason: 'prerequisite-skipped', source: { taskId: skipped.packet.id,
        artifactId: skipped.routing.artifactId, digest: skipped.routing.digest } };
    } else if (!skipped && condition && prerequisites.every(parent => parent.routing?.status === 'skipped' ||
      currentAttempt(parent)?.decision?.disposition === 'accepted')) {
      try {
        const attempt = acceptedAttempt(run, condition.task);
        const source = findArtifact(run, attempt.result.artifacts[condition.slot]);
        const evaluation = evaluateWorkflowCondition(condition, source.content);
        decision = { status: evaluation.matched ? 'matched' : 'skipped', reason: 'condition', condition, ...evaluation,
          source: { taskId: condition.task, attemptId: attempt.id, artifactId: source.id, digest: source.digest } };
      } catch (error) { if (!(error instanceof CrewError || error instanceof SyntaxError)) throw error; }
    }
    if (!decision) return;
    const id = 'routing-' + randomUUID();
    const record = artifact(id, `${packet.title} routing decision`, 'json', JSON.stringify({ schemaVersion: 1,
      runId: run.id, taskId: packet.id, packetRevision: packet.revision, recordedAt, ...decision }, null, 2),
    { source: 'routing', taskId: packet.id, status: decision.status, recordedAt });
    run.artifacts.push(record);
    task.routing = { status: decision.status, reason: decision.reason, source: decision.source, artifactId: id, digest: record.digest };
  }
  run.tasks.forEach(resolve);
}

function handoffCounts(run) {
  const counts = { total: run.tasks.length, accepted: 0, running: 0, review: 0, attention: 0 };
  for (const task of run.tasks) {
    const attempt = currentAttempt(task);
    if (task.routing && !hasRoutingEvidence(run, task)) { counts.attention++; continue; }
    if (task.routing?.status === 'skipped') { counts.skipped = (counts.skipped ?? 0) + 1; continue; }
    if (!attempt) continue;
    if (attempt.outcome === 'running' && attempt.workerStatus !== 'disconnected') counts.running++;
    else if (handoffNeedsAttention(run, task, attempt)) counts.attention++;
    else if (attempt.decision?.disposition === 'accepted') counts.accepted++;
    else counts.review++;
  }
  return counts;
}

function handoffNeedsAttention(run, task, attempt) {
  if (!attempt && task.dispatchIssue) return true;
  if (!attempt || attempt.outcome === 'running') return attempt?.workerStatus === 'disconnected';
  return attempt.outcome !== 'completed' ||
    attempt.result?.state !== 'completed' || attempt.decision?.disposition === 'rework' ||
    !hasEvidence(run, task.packet, attempt) || reviewOf(run, task, attempt)?.findings.some(finding => finding.severity === 'blocker');
}

function runOverview(run) {
  const handoffs = handoffCounts(run);
  const delivery = workspaceDeliveryCandidate(run, handoffs);
  const published = publishedDeliveryMatches(run, delivery?.candidate);
  const recent = run.tasks.flatMap(({ packet, attempts }) => attempts.map(attempt => ({
    taskId: packet.id, title: packet.title, at: attempt.decision?.recordedAt ?? attempt.endedAt ?? attempt.startedAt,
    action: attempt.decision?.disposition ?? attempt.outcome, attempt: attempt.number,
    detail: attempt.decision?.note,
  }))).sort((a, b) => b.at.localeCompare(a.at));
  const qaPassed = run.tasks.some(task => {
    const attempt = currentAttempt(task);
    return (task.packet.execution?.kind === 'verify' || task.packet.workspaceCheck) &&
      attempt?.decision?.disposition === 'accepted' && verificationOf(run, attempt)?.passed;
  });
  const triagePending = run.triage?.status === 'pending';
  const triageActivity = run.triage?.recordedAt ? { title: 'Team', action: 'assigned', at: run.triage.recordedAt } : undefined;
  const pendingResources = openResources(run).map(({ id, action, target, taskId }) => ({ id, action, target, taskId }));
  const attentionTasks = run.tasks.filter(task => {
    const attempt = currentAttempt(task);
    return (task.routing && !hasRoutingEvidence(run, task)) ||
      (handoffNeedsAttention(run, task, attempt) && !resourceWait(run, task).some(resource => !resource.resolution));
  }).map(({ packet }) => ({ id: packet.id, title: packet.title }));
  return { handoffs, pendingResources, attentionTasks, triagePending,
    ...(delivery && { workspaceDeliveryStatus: { ...delivery, published, canPublish: delivery.canPublish && !run.workspaceDelivery,
      ...(run.workspaceDelivery && !published && { reason: 'The published delivery no longer matches its verification evidence.' }) } }),
    latestActivity: recent[0] ?? triageActivity, recentDecisions: recent.filter(event => event.detail).slice(0, 3),
    readyForProjectReview: handoffs.accepted + (handoffs.skipped ?? 0) === handoffs.total && qaPassed };
}

function epicOf(run) {
  return run.epic ?? { id: 'epic-1', title: 'Epic 1', goal: run.tasks[0].packet.objective };
}

export function workspaceCatalog(runs) {
  const projects = new Map();
  for (const run of runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt))) {
    const epic = epicOf(run);
    if (!projects.has(run.project.id)) projects.set(run.project.id, {
      id: run.project.id, name: run.project.name, crewName: run.project.crewName, profiles: [],
      configurationRun: run.id, epics: [],
    });
    const project = projects.get(run.project.id);
    let entry = project.epics.find(value => value.id === epic.id);
    if (!entry) {
      entry = { ...epic, runs: [] };
      project.epics.push(entry);
      for (const profile of run.profiles) {
        if (!project.profiles.some(value => value.id === profile.id)) {
          project.profiles.push({ ...profile, configurationRun: run.id });
        }
      }
    }
    entry.runs.push({ id: run.id, startedAt: run.startedAt, sourceCommit: run.sourceCommit, configurationVersion: run.project.configurationVersion, ...runOverview(run) });
  }
  return [...projects.values()];
}

function prepareDispatch(run, taskId, { resumeAttemptId, workerId } = {}) {
  if (run.triage?.status === 'pending') throw new CrewError('Confirm team assignments before dispatching work', 3);
  const task = findTask(run, taskId);
  if (task.routing?.status === 'skipped') {
    routingArtifact(run, task);
    throw new CrewError('This step was skipped by its workflow routing decision.', 3);
  }
  const previous = currentAttempt(task);
  const waiting = resourceWait(run, task);
  if (waiting.some(resource => !resource.resolution)) throw new CrewError('Resolve the resource requests before resuming this handoff', 3);
  if (waiting.length) requireField(hasEvidence(run, task.packet, previous), 'The resource request has no matching execution receipt');
  if (previous && !waiting.length && previous.decision?.disposition !== 'rework' && !infrastructureRetry(previous)) {
    throw new CrewError('Record a rework decision before dispatching another attempt', 3);
  }
  const limit = workflowAttemptLimit(task);
  if (packetAttemptsUsed(task) >= limit) throw new CrewError('Packet attempt limit reached', 3);
  const budgetChange = task.attemptBudgetChange?.packetRevision === task.packet.revision ? task.attemptBudgetChange : undefined;
  if (budgetChange) {
    const evidence = findArtifact(run, budgetChange.artifactId);
    requireField(evidence.digest === budgetChange.digest && evidence.provenance.source === 'attempt-budget' &&
      evidence.provenance.taskId === taskId, 'The additional attempt approval no longer matches its record.');
  }
  const profile = run.profiles.find(profile => profile.id === task.packet.profileId);
  const agentDraft = verifyAgentDraft(run, profile);
  const prerequisites = new Map();
  const skippedPrerequisites = [];
  for (const id of task.packet.prerequisites) {
    const parent = findTask(run, id);
    if (parent.routing?.status === 'skipped' && task.packet.joinPrerequisites?.includes(id)) {
      const record = routingArtifact(run, parent);
      skippedPrerequisites.push({ taskId: id, artifactId: record.id, digest: record.digest });
    } else prerequisites.set(id, acceptedAttempt(run, id));
  }
  let route;
  const condition = task.packet.runWhen;
  if (condition) {
    const source = prerequisites.get(condition.task);
    const input = findArtifact(run, source.result.artifacts[condition.slot]);
    const prior = task.routing?.source;
    if (task.routing?.status !== 'matched' || prior?.attemptId !== source.id || prior.artifactId !== input.id || prior.digest !== input.digest)
      throw new CrewError('The run condition needs a verified routing decision for the accepted handoff.', 3);
    route = routingArtifact(run, task);
  }
  let repair, repairSource;
  const repairInputs = [];
  if (task.workspaceRepairId) {
    const saved = run.workspaceRepairs?.find(record => record.id === task.workspaceRepairId);
    const record = findArtifact(run, task.workspaceRepairId);
    requireField(saved && record.digest === saved.digest && record.provenance.source === 'workspace-repair', 'The workspace repair evidence changed.');
    repair = JSON.parse(record.content);
    repairSource = task.attempts.find(attempt => attempt.id === repair.sourceAttemptId);
    requireField(repair.targetTaskId === taskId && repairSource?.workspaceOutput && isDeepStrictEqual(repairSource.workspaceOutput, repair.workspace),
      'The workspace repair does not match its source attempt.');
    repairInputs.push(record, ...repair.evidence.map(({ id, digest }) => {
      const input = findArtifact(run, id);
      requireField(input.digest === digest && input.provenance.attemptId === repair.verificationAttemptId, 'The workspace repair inputs changed.');
      return input;
    }));
  }
  const repairHistory = repairSource && !previous && profile.codexRuntime?.saveThread && savedCodexHistory(repairSource);
  const followUp = task.packet.agentFollowUp;
  let followUpSource, agentMessage;
  if (followUp) {
    const { attemptId, threadId, turnId } = followUp.history;
    followUpSource = task.attempts.find(attempt => attempt.id === attemptId);
    const saved = savedCodexHistory(followUpSource);
    agentMessage = findArtifact(run, followUp.messageArtifactId);
    requireField(agentConversationEnabled(run, task) && saved?.threadId === threadId && saved?.turnId === turnId &&
      agentMessage.id === task.packet.inputArtifacts[0] && agentMessage.digest === followUp.messageDigest &&
      agentMessage.provenance.source === 'agent-follow-up' && agentMessage.provenance.attemptId === attemptId &&
      agentMessage.provenance.runId === run.id && agentMessage.provenance.turn === task.packet.revision,
    'The saved Codex conversation no longer matches this follow-up.');
  }
  let codexHistory;
  if (resumeAttemptId !== undefined) {
    const saved = previous?.id === resumeAttemptId && profile.codexRuntime?.saveThread && canReuseCodexHistory(task, previous);
    if (!saved) throw new CrewError('The saved Codex thread is unavailable for this attempt. Reopen the handoff.', 3);
    codexHistory = { kind: 'resume', taskId, ...saved };
  } else if (followUp) {
    codexHistory = followUp.history;
  } else if (repairHistory) {
    codexHistory = { kind: 'fork', taskId, ...repairHistory };
  } else if (task.packet.codexHistoryFrom) {
    const sourceId = task.packet.codexHistoryFrom;
    const sourceTask = findTask(run, sourceId);
    const saved = savedCodexHistory(prerequisites.get(sourceId));
    if (!profile.codexRuntime?.saveThread || sourceTask.packet.profileId !== profile.id || !saved)
      throw new CrewError('The prerequisite has no saved Codex history for this agent version.', 3);
    codexHistory = { kind: 'fork', taskId: sourceId, ...saved };
  }
  const handoffs = [];
  const receivedImages = [];
  const received = (task.packet.handoffInputs ?? []).flatMap(({ task: taskId, slot }) => {
    const source = prerequisites.get(taskId);
    if (!source) return [];
    if (isRuntimeHandoff(run, taskId, slot)) {
      const records = runtimeHandoffRecords(run, taskId, slot, source);
      handoffs.push(...records.map(record => handoffReference(taskId, slot, source.id, record)));
      return records;
    }
    const input = findArtifact(run, source.result.artifacts[slot] ?? source.runnerArtifacts?.[slot]);
    requireField(input.provenance.attemptId === source.id, `Handoff ${taskId}/${slot} does not match its accepted attempt`);
    const handoff = handoffReference(taskId, slot, source.id, input);
    handoffs.push(handoff);
    const output = findTask(run, taskId).packet.outputs.find(value => value.id === slot);
    if (isEvidenceOutput(output?.kind)) workflowEvidenceOf(run, source, output.kind, input.id);
    if (isImageOutput(output?.kind)) {
      receivedImages.push({ ...readAgentImage(input), name: output.title ?? output.id, handoff });
      return [];
    }
    return [input];
  });
  const build = prerequisites.get(task.packet.execution?.candidateFrom);
  const interrupted = previous?.outcome === 'worker-disconnected' ? previous : previous?.outcome === 'history-unavailable' ?
    task.attempts.find(attempt => attempt.id === previous.restartedFrom && attempt.outcome === 'worker-disconnected') : undefined;
  const recovery = run.project.id === 'music-transcribe' && interrupted?.recoveryId ? findArtifact(run, interrupted.recoveryId) : undefined;
  if (recovery) requireField(recovery.provenance.source === 'recovery' && recovery.provenance.attemptId === interrupted.id,
    'The worker recovery record does not match the interrupted attempt.');
  const saveCheckpoint = savesWorkspaceCheckpoint(run.project.id, profile, task.packet);
  const retryCheckpoint = saveCheckpoint && (recovery ? JSON.parse(recovery.content).workspaceCheckpoint :
    previous?.outcome === 'history-unavailable' ? previous.workspaceCheckpointFrom :
      previous?.decision?.disposition === 'rework' && !previous.workspaceOutput ? workspaceCheckpointReference(previous) : undefined);
  const restored = retryCheckpoint && readWorkspaceCheckpoint(run, task, retryCheckpoint);
  const workspaceSource = task.packet.workspaceSource;
  const workspaceTaskId = workspaceSource?.startsWith('step:') ? workspaceSource.slice(5) : undefined;
  const workspaceAttempt = task.packet.captureWorkspace && previous?.decision?.disposition === 'rework' && previous.workspaceOutput ? previous :
    repairSource ?? (followUpSource?.workspaceOutput ? followUpSource : prerequisites.get(workspaceTaskId));
  const workspaceInput = restored?.checkpoint ?? (workspaceAttempt ? workspaceAttempt.workspaceOutput : workspaceSource === 'delivery' ?
    run.workspaceDeliveryBase ?? run.workspaceBaseline : workspaceSource === 'baseline' ? run.workspaceBaseline : undefined);
  let stagedWorkspace;
  if (restored) stagedWorkspace = restored.files;
  else if (workspaceInput) {
    const record = findArtifact(run, workspaceInput.artifactId);
    const publishedBase = workspaceInput === run.workspaceDeliveryBase;
    requireField(record.kind === 'workspace' && record.digest === workspaceInput.digest &&
      (workspaceAttempt ? record.provenance.attemptId === workspaceAttempt.id : publishedBase ?
        record.provenance.source === 'published-workspace-base' && record.provenance.runId === workspaceInput.sourceRunId &&
          record.provenance.artifactId === workspaceInput.sourceArtifactId &&
          record.provenance.deliveryDigest === workspaceInput.deliveryDigest : record.provenance.source === 'git-workspace'),
    'The selected workspace does not match its recorded evidence.');
    stagedWorkspace = readWorkspaceArtifact(record.content).files;
  } else if (workspaceAttempt || (workspaceSource && (workspaceSource !== 'delivery' || task.packet.workspaceCheck))) {
    throw new CrewError('The selected workspace has no captured or pinned files.', 3);
  } else if (workspaceSource === 'delivery') {
    stagedWorkspace = [];
  }
  const fix = taskId === run.orchestration?.buildTask ? run.fixLoops.at(-1) : undefined;
  const previousCandidateFiles = fix ? task.attempts.find(value => value.id === fix.buildAttemptId)?.candidateFiles : undefined;
  const fixInputs = fix ? fix.artifacts.map(({ id, digest }) => {
    const input = findArtifact(run, id);
    requireField(input.digest === digest, 'Fix loop evidence no longer matches the decision');
    return input;
  }) : [];
  const resourceInputs = (run.resources ?? []).filter(resource => resource.resolution)
    .map(resource => findArtifact(run, resource.resolution.artifactId));
  const uniqueReceived = [...new Map(received.map(record => [record.id, record])).values()];
  const inputs = [...task.packet.inputArtifacts.map(id => findArtifact(run, id)), ...uniqueReceived, ...fixInputs, ...repairInputs, ...resourceInputs,
    ...(recovery ? [recovery] : [])];
  const rework = previous?.decision ? { attemptId: previous.id, note: previous.decision.note } : previous?.rework;
  const invokeSkills = validateSkillInvocations((followUp ? followUp.invokeSkills : run.agentRun?.invokeSkills ?? task.packet.invokeSkills) ?? [],
    nativeSkillChoices(profile.codexRuntime?.workspace, profile.skillNames));
  const turnImages = [...(task.packet.imageInputIds ?? []).map(id => {
    const record = findArtifact(run, id);
    const provenance = record.provenance;
    const selected = provenance.source === 'workflow-request-image'
      ? task.packet.receiveRequestImages && provenance.runId === run.id &&
        run.workflowRequest?.imageInputs?.some(input => input.artifactId === id && input.digest === record.digest)
      : run.agentRun && provenance.turn === task.packet.revision;
    requireField(selected && agentImagesEnabled(run.project.id) && Array.isArray(profile.codexTools),
      'The saved image is outside this assignment’s configured inputs.');
    return readAgentImage(record);
  }), ...receivedImages];
  requireField(turnImages.length <= agentImageLimits.count && turnImages.reduce((total, image) => total + image.bytes, 0) <= agentImageLimits.totalBytes,
    'This assignment exceeds four image inputs or 6 MiB. Route fewer or smaller images.');
  const imageInputs = turnImages.map(({ data, extension, ...image }) => image);
  const skillInputs = invokeSkills.map(number => {
    const { id, digest, provenance } = findArtifact(run, profile.skillIds[number - 1]);
    return { artifactId: id, digest, ...(provenance.source === 'project-skill' && {
      projectSkill: { id: provenance.skillId, version: provenance.version },
    }) };
  });
  const { runtime } = run.project;
  const model = profile.model ?? runtime.model;
  const attemptRuntime = model === runtime.model ? runtime : { kind: runtime.kind, model };
  const outputTools = task.packet.responseMode === 'free-form' ? [...Object.keys(workflowSubmissionTools),
    ...(task.packet.outputs.some(slot => slot.kind === 'image') ? [listGeneratedImagesTool] : [])] : [];
  const liveControls = profile.codexRuntime?.liveSession || ((run.agentRun || outputTools.length) && musicCodexAgent(run.project.id, profile));
  const repository = musicCodexAgent(run.project.id, profile) && profile.codexRuntime?.repositoryInstructions && workspaceRepositoryInstruction(stagedWorkspace);
  if (repository) {
    validateRepositoryInstructionWorkspace(stagedWorkspace);
    requireField(Buffer.from(repository.content).equals(repository.data) && !repository.content.includes('\0'),
      'Save ' + repository.path + ' as UTF-8 text to use it as native repository instructions.');
  }
  const attempt = {
    id: randomUUID(), number: task.attempts.length + 1, packetRevision: task.packet.revision,
    profileRevision: profile.revision, sourceCommit: run.sourceCommit, startedAt: new Date().toISOString(),
    ...(workerId && { workerId }),
    outcome: 'running', runtime: attemptRuntime, effectivePermissions: Array.isArray(profile.codexTools) ?
      { ...inputOnlyPolicy, sandbox: profile.codexRuntime?.workspace === 'workspace-write' ? 'workspace-write' : 'read-only',
        approval: profile.codexRuntime?.approvalMode ?? 'never',
        inputScope: 'pinned workflow inputs', projectWorkspaceMounted: false,
        isolatedWorkspace: profile.codexRuntime?.workspace !== undefined && profile.codexRuntime.workspace !== 'tools',
        webSearch: profile.codexRuntime?.webSearch ?? 'disabled',
        ...(liveControls && { liveSession: true }),
        ...(profile.codexRuntime?.saveThread && { saveThread: true }),
        ...(repository && { repositoryInstructions: true }),
        ...workflowHookPolicy(profile.codexRuntime),
        ...(profile.codexRuntime?.imageInspection && { imageInspection: true }),
        ...(profile.codexRuntime?.imageGeneration && { imageGeneration: true }),
        ...(profile.codexRuntime?.commandEvidence && { commandEvidence: true }),
        ...(profile.codexRuntime?.delegation && { delegation: profile.codexRuntime.delegation }),
        ...(profile.codexRuntime?.delegation && profile.codexRuntime.subagentRoles?.length && {
          subagentRoles: profile.codexRuntime.subagentRoles.map(role => role.name),
        }),
        ...(profile.codexRuntime?.mcpServers?.length && { codexMcpServers: profile.codexRuntime.mcpServers }),
        ...(profile.codexRuntime?.plugins?.length && { codexPlugins: profile.codexRuntime.plugins }),
        ...(profile.codexRuntime?.apps?.length && { codexApps: profile.codexRuntime.apps }),
        ...(profile.projectMcp?.length && { projectMcp: profile.projectMcp.map(({ id, version, name }) => ({ id, version, name })) }),
        tools: [...profile.codexTools, ...outputTools, ...(saveCheckpoint ? [workspaceCheckpointTool] : []), ...(profile.skillIds.length ? ['read_skill'] : []),
          ...(profile.skillBundles?.some(bundle => bundle?.files.length) ? ['read_skill_file'] : [])] }
      : inputOnlyPolicy,
    ...(profile.codexRuntime?.serviceTier && { requestedServiceTier: profile.codexRuntime.serviceTier }),
    packetId: task.packetId,
    ...(agentDraft && { agentDraft }),
    ...(run.triage?.artifactId ? { triageArtifactId: findArtifact(run, run.triage.artifactId).id } : {}),
    inputArtifacts: inputs.map(input => input.id),
    ...(imageInputs.length && { imageInputs }),
    ...(skillInputs.length && { skillInputs }),
    ...(route && { routingDecision: { artifactId: route.id, digest: route.digest } }),
    ...(skippedPrerequisites.length && { skippedPrerequisites }),
    ...(workspaceInput && { workspaceInput }),
    ...(restored && { workspaceCheckpointFrom: {
      attemptId: retryCheckpoint.attemptId, artifactId: workspaceInput.artifactId, digest: workspaceInput.digest,
    } }),
    ...(repair && { workspaceRepair: { id: repair.id, round: repair.round, note: repair.note,
      verificationTaskId: repair.verificationTaskId, verificationAttemptId: repair.verificationAttemptId } }),
    handoffs,
    ...(fix ? { fixLoop: { number: fix.number, note: fix.note, previousCandidate: fix.candidate } } : {}),
    ...(rework ? { rework } : {}),
    ...(waiting.length ? { resumedFrom: previous.id } : {}),
    ...(interrupted && { restartedFrom: interrupted.id }),
    ...(budgetChange && { attemptBudgetId: budgetChange.artifactId }),
    ...(codexHistory && { codexHistory }),
    prerequisites: [...prerequisites].map(([taskId, attempt]) => ({ taskId, attemptId: attempt.id })),
  };
  const instructions = [profile.instructionId, ...profile.skillIds].map(id => findArtifact(run, id).content);
  const skillBundles = profile.skillBundles?.map(bundle => bundle && ({
    directory: bundle.directory, files: bundle.files.map(({ path, artifactId }) => ({ path, data: findArtifact(run, artifactId).content })),
  }));
  if (repository) {
    const record = artifact(`repository-instructions-${attempt.id}`, 'Repository instructions · ' + repository.path, 'text', repository.content,
      { source: 'repository-instructions', attemptId: attempt.id, workspaceArtifactId: workspaceInput.artifactId, path: repository.path });
    run.artifacts.push(record);
    attempt.repositoryInstruction = { artifactId: record.id, path: repository.path, digest: record.digest, bytes: repository.data.length };
  }
  task.attempts.push(attempt);
  delete task.dispatchIssue;
  return { attempt, task: { ...task.packet, inputArtifacts: attempt.inputArtifacts, handoffs, rework: attempt.rework, fixLoop: attempt.fixLoop,
    ...(route && { routingDecision: attempt.routingDecision }), ...(skippedPrerequisites.length && { skippedPrerequisites }),
    ...(workspaceInput && { workspaceInput }), ...(attempt.workspaceRepair && { activeWorkspaceRepair: attempt.workspaceRepair }) },
    candidate: build?.candidate, candidateFiles: build?.candidateFiles, candidateFilesDigest: build?.candidateFilesDigest,
    previousCandidateFiles,
    sourceFiles: run.sourceFiles, profile, inputs, instructions, ...(skillBundles && { skillBundles }),
    ...(stagedWorkspace && { workspaceFiles: stagedWorkspace }),
    ...(task.packet.workspaceCheck && { workspaceCheckProfile: run.workspaceCheckProfile }),
    projectId: run.project.id, model, ...(run.agentRun && { standaloneAgent: true }), ...(agentMessage && { agentMessage }),
    ...(turnImages.length && { turnImages }),
    ...(invokeSkills.length && { invokeSkills }) };
}

function withWorkflowWorker(store, signal, execute) {
  if (!store.withWorker) return execute(store, signal);
  return store.withWorker((worker, connection) => execute(worker, signal ? AbortSignal.any([signal, connection]) : connection));
}

export async function dispatch(store, taskId, signal, onStart, execute = executeWorkflowCodex, db, options) {
  return withWorkflowWorker(store, signal, async (worker, activeSignal) => {
    const job = await worker.update(run => prepareDispatch(run, taskId, { resumeAttemptId: options?.resumeAttemptId, workerId: worker.workerId }));
    onStart?.(job.attempt.id);
    return executeDispatch(worker, job, activeSignal, execute, db, options);
  });
}

export async function dispatchInitial(store, signal, onStart, execute = executeWorkflowCodex, db, options) {
  return withWorkflowWorker(store, signal, async (worker, activeSignal) => {
    const jobs = await worker.update(run => {
      if (run.triage?.status !== 'assigned') return [];
      return run.tasks.filter(task => !task.packet.prerequisites.length && !task.attempts.length)
        .map(({ packet }) => prepareDispatch(run, packet.id, { workerId: worker.workerId }));
    });
    onStart?.(jobs.map(({ task, attempt }) => ({ taskId: task.id, attemptId: attempt.id })));
    return executeJobs(worker, jobs, activeSignal, execute, db, options);
  });
}

function automaticDispatchCandidates(run) {
  return run.tasks.filter(task => !currentAttempt(task) && !task.dispatchIssue && task.routing?.status !== 'skipped' &&
    task.packet.prerequisites.every(id => {
      const parent = findTask(run, id);
      return currentAttempt(parent)?.decision?.disposition === 'accepted' ||
        (parent.routing?.status === 'skipped' && task.packet.joinPrerequisites?.includes(id));
    }));
}

function queueAutomaticDispatch(run) {
  if (run.automation?.enabled && run.triage?.status === 'assigned') run.automation.pending = automaticDispatchCandidates(run).length > 0;
}

export function setWorkflowAutomation(store, enabled) {
  return store.update(run => {
    requireField(run.automation, 'This workflow version uses manual dispatch.');
    if (run.automation.enabled === enabled) return run.automation;
    run.automation = { enabled, pending: false, changedAt: new Date().toISOString() };
    if (enabled) {
      for (const task of run.tasks) delete task.dispatchIssue;
      queueAutomaticDispatch(run);
    }
    return run.automation;
  });
}

export async function dispatchNext(store, signal, onStart, execute = executeWorkflowCodex, db, options) {
  return withWorkflowWorker(store, signal, async (worker, activeSignal) => {
    const job = await worker.update(run => {
      activeSignal?.throwIfAborted();
      if (!run.automation?.enabled || !run.automation.pending) return;
      const eligible = automaticDispatchCandidates(run);
      run.automation.pending = false;
      while (eligible.length) {
        const task = eligible.shift();
        try {
          const job = prepareDispatch(run, task.packet.id, { workerId: worker.workerId });
          job.attempt.dispatchSource = 'workflow';
          run.automation.pending = eligible.length > 0;
          return job;
        } catch (error) {
          if (!(error instanceof CrewError)) throw error;
          task.dispatchIssue = { message: error.message, recordedAt: new Date().toISOString() };
        }
      }
    });
    if (!job) return null;
    onStart?.({ taskId: job.task.id, attemptId: job.attempt.id });
    return executeDispatch(worker, job, activeSignal, execute, db, options);
  });
}

async function executeJobs(store, jobs, signal, execute, db, options) {
  const results = await Promise.allSettled(jobs.map(job => executeDispatch(store, job, signal, execute, db, options)));
  const attempts = results.map(result => {
    if (result.status === 'rejected') throw result.reason;
    return result.value;
  });
  if (!attempts.some(attempt => attempt.resourceIds?.length)) return attempts;
  const run = await store.read();
  return attempts.map((attempt, index) => attempt.resourceIds?.length
    ? currentAttempt(findTask(run, jobs[index].task.id)) ?? attempt : attempt);
}

function prepareResourceResumes(run, workerId) {
  return run.tasks.flatMap(task => {
    const waiting = resourceWait(run, task);
    if (!waiting.length || waiting.some(resource => !resource.resolution)) return [];
    try { return [prepareDispatch(run, task.packet.id, { workerId })]; }
    catch (error) {
      if (!(error instanceof CrewError)) throw error;
      return [];
    }
  });
}

export async function resolveResource(store, resourceId, note, signal, onStart, execute = executeWorkflowCodex, db, options) {
  text(note, 'resource resolution note', 1_000);
  return withWorkflowWorker(store, signal, async (worker, activeSignal) => {
    const { resolution, jobs } = await worker.update(run => {
      const resource = openResources(run).find(resource => resource.id === resourceId);
      requireField(resource, 'This resource request is no longer open');
      requireField(!isProvisioning(resource), 'Automatic setup is still in progress');
      const task = findTask(run, resource.taskId);
      const attempt = task.attempts.find(attempt => attempt.id === resource.attemptId);
      requireField(attempt && hasEvidence(run, task.packet, attempt), 'The resource request has no matching execution receipt');
      const resolution = recordResourceResolution(run, resource, resource.mode === 'deny' ? 'declined' : 'ready', 'operator', note);
      return { resolution, jobs: prepareResourceResumes(run, worker.workerId) };
    });
    onStart?.(jobs.map(({ task, attempt }) => ({ taskId: task.id, attemptId: attempt.id })));
    const attempts = await executeJobs(worker, jobs, activeSignal, execute, db, options);
    return { resolution, attempts };
  });
}

async function executeDispatch(store, job, signal, execute, db, { captureActivity = false, repo = process.cwd() } = {}) {
  const taskId = job.task.id;
  const deadline = AbortSignal.timeout(job.task.budget.timeoutSeconds * 1000);
  const attemptSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;

  let observation;
  let result;
  let workspace;
  const savesProgress = musicCodexAgent(job.projectId, job.profile);
  const onCodexCheckpoint = event => store.update(run => {
    const attempt = currentAttempt(findTask(run, taskId));
    requireField(attempt?.id === job.attempt.id && attempt.outcome === 'running', 'The worker no longer owns this Codex attempt.');
    const kind = event.kind === 'submission' && job.task.outputs.find(slot => slot.id === event.output?.slot)?.kind;
    if (isEvidenceOutput(kind)) {
      const output = { ...event.output, [kind === 'image' ? 'image' : 'evidence']: workflowEvidenceOf(run, attempt, kind, event.output.content) };
      recordCodexCheckpoint(run, taskId, attempt, { ...event, output });
      return output;
    }
    recordCodexCheckpoint(run, taskId, attempt, event);
  });
  const onWorkspaceCheckpoint = snapshot => store.update(run => {
    const attempt = currentAttempt(findTask(run, taskId));
    requireField(attempt?.id === job.attempt.id && attempt.outcome === 'running', 'The worker no longer owns this Codex workspace.');
    return recordWorkspaceCheckpoint(run, taskId, attempt, snapshot);
  });
  const onGeneratedImage = ({ itemId, encoded }) => store.update(run => {
    const attempt = currentAttempt(findTask(run, taskId));
    requireField(attempt?.id === job.attempt.id && attempt.outcome === 'running', 'The worker no longer owns this Codex attempt.');
    text(itemId, 'Codex image item ID', 200);
    const images = attempt.generatedImages ??= [];
    const existing = images.find(image => image.itemId === itemId);
    const number = images.length + 1;
    const image = codexGeneratedImage(encoded, number);
    if (existing) {
      requireField(existing.sha256 === image.sha256, 'Codex sent different data for the same image item.');
      return existing;
    }
    requireField(number <= agentImageLimits.count && images.reduce((total, saved) => total + saved.bytes, image.data.length) <= agentImageLimits.totalBytes,
      'Crew can save up to four generated images and 6 MiB per attempt.');
    const record = codexGeneratedImageArtifact(image, attempt.id, itemId, number);
    run.artifacts.push(record);
    const evidence = { artifactId: record.id, digest: record.digest, itemId, name: record.title,
      mimeType: image.mimeType, bytes: image.data.length, sha256: image.sha256 };
    images.push(evidence);
    return evidence;
  });
  const onAgentActivity = entry => store.update(run => {
    const attempt = findTask(run, taskId).attempts.find(attempt => attempt.id === job.attempt.id);
    if (attempt?.outcome !== 'running') return;
    if (entry.kind === 'speed') {
      attempt.codexSpeed = entry.speed;
      return;
    }
    if (entry.kind === 'reply') {
      attempt.agentReply = { text: entry.text, truncated: entry.truncated };
      return;
    }
    if (entry.kind === 'follow-up') {
      delete attempt.agentReply;
      attempt.outputFollowUpCount = (attempt.outputFollowUpCount ?? 0) + 1;
    }
    attempt.agentActivity = [...(attempt.agentActivity ?? []), entry].slice(-12);
    if (entry.kind !== 'tool') return;
    const item = entry.call;
    if (savesProgress && item.id) {
      const pending = (attempt.pendingToolCalls ?? []).filter(tool => tool.id !== item.id);
      if (item.status === 'running') pending.push(item);
      attempt.pendingToolCalls = pending;
    }
    const tools = attempt.toolActivity ?? [];
    const existing = item.id && tools.findIndex(tool => tool.id === item.id);
    if (Number.isInteger(existing) && existing >= 0) tools[existing] = item;
    else tools.push(item);
    attempt.toolActivity = tools.slice(-12);
  });
  const onDevelopmentCheck = receipt => store.update(run => {
    const attempt = currentAttempt(findTask(run, taskId));
    requireField(attempt?.id === job.attempt.id && attempt.outcome === 'running', 'The worker no longer owns this development check.');
    const checks = attempt.developmentCheckIds ??= [];
    const record = artifact(`development-${attempt.id}-${checks.length + 1}`, 'Music Transcribe development check ' + (checks.length + 1),
      'json', JSON.stringify({ ...receipt, runId: run.id, taskId, attemptId: attempt.id,
        ...(attempt.workspaceInput?.digest === receipt.workspaceDigest && { workspaceArtifactId: attempt.workspaceInput.artifactId }) }, null, 2),
      { source: 'runtime', attemptId: attempt.id });
    run.artifacts.push(record);
    checks.push(record.id);
    return record.id;
  });
  const onBrowserAction = (report, screenshot) => store.update(run => {
    const attempt = currentAttempt(findTask(run, taskId));
    requireField(attempt?.id === job.attempt.id && attempt.outcome === 'running', 'The worker no longer owns this browser session.');
    const actions = attempt.browserActionIds ??= [];
    const number = actions.length + 1;
    let savedImage;
    if (screenshot) {
      const bytes = (attempt.browserScreenshotBytes ?? 0) + screenshot.length;
      requireField(bytes <= agentImageLimits.totalBytes, 'This attempt has reached its 6 MiB screenshot limit.');
      const [image] = normalizeAgentImages([{ name: 'Browser screenshot ' + number, data: screenshot }]);
      const record = browserScreenshotArtifact(image, attempt.id, number);
      run.artifacts.push(record);
      attempt.browserScreenshotBytes = bytes;
      savedImage = { artifactId: record.id, mimeType: image.mimeType, bytes: image.data.length, sha256: image.sha256 };
    }
    const record = artifact(`browser-action-${attempt.id}-${number}`, 'Browser · ' + report.action + ' · ' + number,
      'json', JSON.stringify({ ...report, runId: run.id, taskId, attemptId: attempt.id,
        ...(report.workspaceDigest && attempt.workspaceInput?.digest === report.workspaceDigest && {
          workspaceArtifactId: attempt.workspaceInput.artifactId,
        }), ...(savedImage && { imageEvidence: savedImage }) }, null, 2), { source: 'runtime', attemptId: attempt.id });
    run.artifacts.push(record);
    actions.push(record.id);
    return { evidenceId: record.id, ...(savedImage && { imageEvidence: savedImage }) };
  });
  try {
    observation = await execute({ ...job, signal: attemptSignal, captureActivity,
      ...(savesProgress && { onCodexCheckpoint }),
      ...(savesProgress && job.profile.codexRuntime?.imageGeneration && { onGeneratedImage }),
      ...(savesWorkspaceCheckpoint(job.projectId, job.profile, job.task) && { onWorkspaceCheckpoint }),
      ...(job.profile.musicPracticeProfile && { repo, onDevelopmentCheck }),
      ...(job.profile.musicBrowserProfile && { repo, onBrowserAction }),
      ...(job.attempt.effectivePermissions.liveSession && { sessionControls: workflowSessionControls(store, taskId, job.attempt.id) }),
      ...(Array.isArray(job.profile.codexTools) && { onAgentActivity }) });
    if (observation.outcome === 'completed') {
      const freeForm = job.standaloneAgent && musicCodexAgent(job.projectId, job.profile);
      const response = observation.response;
      if (freeForm && typeof response === 'string') {
        const [slot] = job.task.outputs;
        requireField(job.task.outputs.length === 1 && slot.id === 'result' && slot.kind === 'markdown', 'Invalid agent reply slot');
        result = { state: 'completed', summary: 'Codex returned a reply.', outputs: [{ slot: slot.id,
          content: text(response, 'Codex reply', codexReplyBytes) }], decisions: [], questions: [], blockers: [] };
      } else if (job.task.responseMode === 'free-form') {
        text(response, 'Codex reply', codexReplyBytes);
        const { outputs, blocker } = observation.submitted ?? { outputs: [] };
        result = validateResponse({ state: blocker ? 'blocked' : 'completed',
          summary: blocker?.reason ?? 'Codex returned a reply and submitted the workflow outputs.', outputs,
          decisions: [], questions: [], blockers: blocker ? [blocker.reason] : [],
          ...(blocker?.resource && { resourceRequests: [blocker.resource] }),
        }, job.task);
      } else result = validateResponse(response, job.task);
      validateWorkflowArtifacts(result, job.task);
      if (job.task.captureWorkspace && result.state === 'completed') workspace = workspaceFiles(observation.workspaceFiles);
      requireField(!result.resourceRequests?.length || observation.receipt, 'A resource request needs a recorded execution receipt');
    }
  } catch (error) {
    result = undefined;
    observation = { ...observation, outcome: observation ? 'invalid-result' : 'execution-failed',
      error: error instanceof CrewError ? error.message : 'Could not complete the local Codex attempt' };
  }
  let checked;
  if (job.task.workspaceCheck && result?.state === 'completed') {
    await store.update(run => {
      const attempt = currentAttempt(findTask(run, taskId));
      requireField(attempt?.id === job.attempt.id && attempt.outcome === 'running', 'The worker no longer owns this handoff attempt.');
      attempt.workspaceChecksStartedAt = new Date().toISOString();
      finishWorkflowSession(attempt);
    });
    checked = { receipt: await runMusicWorkspaceChecks(job, repo, attemptSignal) };
    if (!checked.receipt.passed) observation = { ...observation, outcome: 'check-failed',
      error: checked.receipt.error ?? 'The captured workspace did not pass the local acceptance checks.' };
  }
  if (job.task.execution && result?.state === 'completed') {
    try {
      checked = await executeEvidence(job, result, attemptSignal);
      if (!checked.receipt.passed) observation = { ...observation, outcome: 'check-failed', error: 'One or more Docker checks failed' };
    } catch (error) {
      observation = { ...observation, outcome: 'check-failed', error: error instanceof CrewError ? error.message : 'Could not execute Docker checks' };
    }
  }

  const { attempt, claims, ready } = await store.update(run => {
    const task = findTask(run, taskId);
    const attempt = currentAttempt(task);
    if (attempt?.id !== job.attempt.id || attempt.outcome !== 'running')
      throw new CrewError('The worker no longer owns this handoff attempt.', 3);
    const { receipt, outcome, error } = observation;
    Object.assign(attempt, { outcome, error, endedAt: new Date().toISOString(), usage: receipt?.usage ?? null });
    try {
      for (const output of result?.outputs ?? []) {
        const kind = task.packet.outputs.find(slot => slot.id === output.slot)?.kind;
        if (isEvidenceOutput(kind))
          requireField(isDeepStrictEqual(output.evidence ?? output.image, workflowEvidenceOf(run, attempt, kind, output.content)),
            'The returned evidence does not match the submitted artifact.');
      }
    } catch (error) {
      if (!(error instanceof CrewError)) throw error;
      Object.assign(attempt, { outcome: 'invalid-result', error: error.message });
      result = undefined;
    }
    if (result) delete attempt.agentReply;
    if (result && receipt && observation.activity) discardCodexCheckpoint(run, attempt);
    if (outcome === 'completed') delete attempt.pendingToolCalls;
    finishWorkflowSession(attempt);
    let claims = [];
    if (result?.resourceRequests?.length) {
      try { claims = recordResourceRequests(run, attempt, taskId, result.resourceRequests); }
      catch (error) {
        if (!(error instanceof CrewError)) throw error;
        Object.assign(attempt, { outcome: 'invalid-result', error: error.message });
        result = undefined;
      }
    }
    attempt.overTokenTarget = attempt.usage ? attempt.usage.total > task.packet.budget.targetTotalTokens : null;
    if (result && workspace) {
      const record = artifact('workspace-' + attempt.id, 'Captured workspace files', 'workspace',
        JSON.stringify({ schemaVersion: 1, files: workspace.files }), { source: 'workspace-capture', attemptId: attempt.id });
      run.artifacts.push(record);
      attempt.workspaceOutput = { artifactId: record.id, digest: record.digest, fileCount: workspace.files.length, bytes: workspace.bytes };
    }
    if (receipt) {
      const receiptId = `receipt-${attempt.id}`;
      const runtimeHandoffs = (attempt.handoffs ?? []).filter(({ taskId, slot }) => isRuntimeHandoff(run, taskId, slot));
      run.artifacts.push(artifact(receiptId, 'Codex execution receipt', 'json', JSON.stringify({
        schemaVersion: 1, runId: run.id, taskId, attemptId: attempt.id, sourceCommit: run.sourceCommit,
        outcome: checked || outcome === 'check-failed' ? 'completed' : attempt.outcome, ...receipt,
        ...(attempt.agentDraft && { agentDraft: attempt.agentDraft }),
        ...(attempt.generatedImages?.length && { generatedImages: attempt.generatedImages }),
        ...(attempt.browserActionIds?.length && { browserActionIds: attempt.browserActionIds,
          browserActionDigests: Object.fromEntries(attempt.browserActionIds.map(id => [id, findArtifact(run, id).digest])) }),
        ...(runtimeHandoffs.length && { runtimeHandoffs }),
        ...(attempt.workspaceInput && { workspaceInput: attempt.workspaceInput }),
        ...(attempt.workspaceCheckpointFrom && { workspaceCheckpointFrom: attempt.workspaceCheckpointFrom }),
        ...(attempt.workspaceOutput && { workspaceOutput: attempt.workspaceOutput }),
        ...(attempt.workspaceRepair && { workspaceRepair: attempt.workspaceRepair }),
      }, null, 2), { source: 'runtime', attemptId: attempt.id }));
      attempt.receiptId = receiptId;
      if ((captureActivity || Array.isArray(job.profile.codexTools)) && observation.activity) {
        const activityId = `activity-${attempt.id}`;
        const activity = { ...observation.activity, ...(attempt.codexSession && { codexSession: attempt.codexSession }) };
        run.artifacts.push(artifact(activityId, observation.activity.launch ? 'Codex activity, launch, and prompt' : 'Captured Codex prompt and response',
          'json', JSON.stringify(activity),
          { source: 'runtime', attemptId: attempt.id }));
        attempt.activityId = activityId;
      }
    }
    if (checked) {
      if (checked.candidate) attempt.candidate = checked.candidate;
      if (checked.files) attempt.candidateFiles = checked.files;
      attempt.runnerArtifacts = {};
      const evidence = { ...checked.receipt, runId: run.id, taskId, attemptId: attempt.id };
      const checkTitle = checked.receipt.kind === 'workspace-acceptance' ? 'Music Transcribe acceptance receipt' :
        checked.receipt.kind === 'independent-qa' ? 'Independent QA · Docker receipt' : 'Author tests · Docker receipt';
      const entries = [['check-receipt', checkTitle, evidence]];
      if (task.packet.execution?.kind === 'build') entries.push(['candidate', 'Candidate revision', checked.candidate]);
      for (const [slot, title, data] of entries) {
        const artifactId = `evidence-${attempt.id}-${slot}`;
        run.artifacts.push(artifact(artifactId, title, 'json', JSON.stringify(data, null, 2), { source: 'runtime', attemptId: attempt.id }));
        attempt.runnerArtifacts[slot] = artifactId;
      }
      if (checked.diff) {
        const artifactId = `evidence-${attempt.id}-candidate-diff`;
        run.artifacts.push(artifact(artifactId, 'Candidate Git diff', 'text', checked.diff,
          { source: 'runtime', attemptId: attempt.id, sourceCommit: checked.candidate.commit }));
        attempt.runnerArtifacts['candidate-diff'] = artifactId;
      }
    }
    if (result) {
      const { outputs, ...summary } = result;
      attempt.result = { ...summary, schemaVersion: 1, runId: run.id, taskId, packetRevision: attempt.packetRevision,
        artifacts: Object.fromEntries(outputs.map(output => {
          const artifactId = `output-${attempt.id}-${output.slot}`;
          const slot = task.packet.outputs.find(slot => slot.id === output.slot);
          if (isEvidenceOutput(slot.kind)) return [output.slot, (output.evidence ?? output.image).artifactId];
          run.artifacts.push(artifact(artifactId, slot.title ?? output.slot, slot.kind, output.content,
            { source: 'agent-result', attemptId: attempt.id }));
          return [output.slot, artifactId];
        })) };
    }
    if (task.packet.reviewMode === 'automatic' && !attempt.resourceIds?.length && !acceptanceIssue(run, task, attempt)) {
      recordHandoffDecision(run, attempt, 'accepted', 'Required outputs and execution evidence passed workflow validation.', 'Workflow', true);
    }
    advanceWorkspaceRepairs(run);
    return { attempt, claims, ready: attempt.resourceIds?.length && !claims.length ? prepareResourceResumes(run, store.workerId) : [] };
  });
  if (!attempt.resourceIds?.length) return attempt;
  let jobs = ready;
  if (claims.length) {
    const outcomes = await Promise.all(claims.map(resource => provisionResource(db, job.projectId, resource, signal)));
    jobs = await store.update(run => {
      for (const [index, resource] of claims.entries()) {
        const current = run.resources.find(item => item.id === resource.id);
        if (current.resolution) continue;
        current.automatic = outcomes[index];
        if (current.automatic.status === 'succeeded') {
          recordResourceResolution(run, current, 'ready', 'provisioner', current.automatic.detail);
        }
      }
      return prepareResourceResumes(run, store.workerId);
    });
  }
  const resumed = await executeJobs(store, jobs, signal, execute, db, { captureActivity, repo });
  return resumed[jobs.findIndex(next => next.task.id === taskId)] ?? attempt;
}

export function attachCandidateDiff(store, taskId, buildId) {
  return store.update(run => {
    const task = findTask(run, taskId);
    const prior = currentAttempt(task);
    requireField(prior?.decision?.disposition === 'rework' && prior.packetRevision === task.packet.revision,
      'Record a rework decision for the current packet first');
    requireField(task.packet.prerequisites.includes(buildId), 'Build must be a direct prerequisite');
    const build = acceptedAttempt(run, buildId);
    requireField(findTask(run, buildId).packet.execution?.kind === 'build' && build.candidate?.commit,
      'An accepted candidate is required');
    const input = { task: buildId, slot: 'candidate-diff' };
    const inputs = task.packet.handoffInputs ?? [];
    requireField(!inputs.some(value => value.task === buildId && value.slot === input.slot), 'This packet already receives the candidate diff');
    build.runnerArtifacts ??= {};
    if (!build.runnerArtifacts['candidate-diff']) {
      requireField(typeof build.candidateDiff === 'string', 'The accepted build has no stored candidate diff');
      const artifactId = `evidence-${build.id}-candidate-diff`;
      run.artifacts.push(artifact(artifactId, 'Candidate Git diff', 'text', build.candidateDiff,
        { source: 'git-candidate', attemptId: build.id, sourceCommit: build.candidate.commit }));
      build.runnerArtifacts['candidate-diff'] = artifactId;
    }
    prior.packetId ??= task.packetId;
    const revision = task.packet.revision + 1;
    task.packet = { ...task.packet, revision, packetRevision: revision, handoffInputs: [...inputs, input] };
    task.packetId = `packet-${taskId}-r${revision}`;
    run.artifacts.push(artifact(task.packetId, `${task.packet.title} packet · revision ${revision}`, 'json',
      JSON.stringify(task.packet, null, 2), { source: 'revised-after-review', attemptId: prior.id, sourceCommit: run.sourceCommit }));
    return { packetRevision: revision, packetId: task.packetId, diffId: build.runnerArtifacts['candidate-diff'] };
  });
}

function acceptanceIssue(run, task, attempt) {
  if (attempt.outcome !== 'completed' || attempt.result?.state !== 'completed')
    return new CrewError('Only a completed handoff with valid outputs can be accepted', 3);
  if (!hasEvidence(run, task.packet, attempt)) return new CrewError('Required outputs and evidence must come from the current attempt');
  if (task.packet.outputs.some(slot => slot.kind === 'review-findings')) {
    const review = reviewOf(run, task, attempt);
    if (!review || review.findings.some(finding => finding.severity === 'blocker')) return new CrewError('Implementation review has unresolved blockers');
  }
}

function recordHandoffDecision(run, attempt, disposition, note, owner, automatic = false) {
  attempt.decision = { disposition, note, owner, recordedAt: new Date().toISOString(), ...(automatic && { source: 'workflow' }) };
  if (disposition === 'accepted') {
    if (run.tasks.some(task => task.packet.runWhen)) recordWorkflowRouting(run, attempt.decision.recordedAt);
    queueAutomaticDispatch(run);
  }
  return attempt.decision;
}

export function allowAdditionalAttempt(store, taskId, attemptId, note) {
  text(note, 'additional attempt reason', 2_000);
  return store.update(run => {
    const task = findTask(run, taskId);
    const attempt = currentAttempt(task);
    if (run.project.id !== 'music-transcribe' || attempt?.id !== attemptId || !canAllowAdditionalAttempt(task, attempt))
      throw new CrewError('An additional attempt is unavailable for this handoff. Reopen the handoff to see its status.', 3);
    const from = workflowAttemptLimit(task);
    const change = { schemaVersion: 1, runId: run.id, taskId, attemptId, packetRevision: task.packet.revision,
      from, limit: from + 1, owner: task.packet.acceptedBy, note: note.trim(), recordedAt: new Date().toISOString() };
    const record = artifact('attempt-budget-' + attemptId, 'Additional attempt approval', 'json', JSON.stringify(change, null, 2),
      { source: 'attempt-budget', taskId, attemptId });
    run.artifacts.push(record);
    task.attemptBudgetChange = { ...change, artifactId: record.id, digest: record.digest };
    return task.attemptBudgetChange;
  });
}

export function decide(store, taskId, attemptId, disposition, note) {
  requireField(['accepted', 'rework'].includes(disposition), 'Decision must be accepted or rework');
  text(note, 'decision reason', 2_000);
  return store.update(run => {
    const task = findTask(run, taskId);
    const attempt = currentAttempt(task);
    if (attempt?.id !== attemptId) throw new CrewError('Decision must target the current attempt', 3);
    if (attempt.decision) throw new CrewError('This attempt already has a decision', 3);
    if (attempt.outcome === 'running') throw new CrewError('This attempt is still running', 3);
    requireField(!attempt.resourceIds?.length, 'Resolve the resource requests to continue this handoff');
    if (disposition === 'accepted') {
      const issue = acceptanceIssue(run, task, attempt);
      if (issue) throw issue;
    }
    return recordHandoffDecision(run, attempt, disposition, note, task.packet.acceptedBy);
  });
}
