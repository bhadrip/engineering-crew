import { randomUUID } from 'node:crypto';
import { CrewError, id, parseReviewFindings, requireField, text, validateResponse } from './contracts.mjs';
import { artifact, artifactDigest } from './run-store.mjs';
import { executeCodex, inputOnlyPolicy } from './codex.mjs';
import { executeEvidence } from './checks.mjs';
import { langfuseConfig, langfuseSpan, publishLangfuse } from './langfuse.mjs';
import { elapsedMs, estimateAttemptUsd, runUsage, taskUsage } from './usage.mjs';
import { currentAttempt, currentAttempts } from './attempts.mjs';
import { isProvisioning, openResources, provisionResource, recordResourceRequests, recordResourceResolution, resourceWait } from './resources.mjs';

export function newRun(snapshot, runId, projectPath) {
  const { project, files, sourceCommit, version, sourceFiles, raw } = snapshot;
  const fromGit = (id, title, kind, path) => artifact(id, title, kind, files.get(path), { source: 'git', sourceCommit, path });
  const configuration = version ? { source: 'postgres', version, sourceCommit } : { source: 'git', path: projectPath, sourceCommit };
  const artifacts = [artifact('project-config', 'Project configuration', 'json', raw ?? files.get(projectPath), configuration)];
  const overrides = new Map(snapshot.inputOverrides);
  for (const input of project.inputs) {
    const inputId = `input-${input.id}`;
    artifacts.push(overrides.has(input.id)
      ? artifact(inputId, input.title, 'text', overrides.get(input.id), configuration)
      : fromGit(inputId, input.title, 'text', input.path));
  }
  const profiles = project.profiles.map(profile => {
    const instructionId = `profile-${profile.id}`;
    artifacts.push(fromGit(instructionId, `${profile.name} instructions`, 'text', profile.instructions));
    const skillIds = profile.skills.map((path, index) => {
      const skillId = `${instructionId}-skill-${index + 1}`;
      artifacts.push(fromGit(skillId, path, 'text', path));
      return skillId;
    });
    return { ...profile, instructionId, skillIds };
  });
  const tasks = project.tasks.map(({ alternateProfiles, ...task }) => {
    const profile = profiles.find(profile => profile.id === task.profileId);
    const packet = { ...task, schemaVersion: 1, runId, taskId: task.id, packetRevision: task.revision, sourceCommit,
      budget: { ...task.budget, costOwner: task.budget.costOwner ?? project.costOwner ?? task.acceptedBy },
      profileRef: { id: profile.id, revision: profile.revision },
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
  return run.triage;
}

export function triageRun(store, owner, note, overrides = []) {
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
      requireField(task.alternateProfiles?.includes(profileId), `Profile ${profileId} is not eligible for ${taskId}`);
      const profile = run.profiles.find(profile => profile.id === profileId);
      const revision = task.packet.revision + 1;
      task.packet = { ...task.packet, profileId, profileRef: { id: profileId, revision: profile.revision },
        revision, packetRevision: revision };
      task.packetId = `assigned-packet-${taskId}`;
      run.artifacts.push(artifact(task.packetId, `${task.packet.title} packet`, 'json', JSON.stringify(task.packet, null, 2),
        { source: 'triage', sourceCommit: run.sourceCommit, decisionId: 'triage-decision' }));
    }
    return recordTeam(run, { owner, note, recordedAt: new Date().toISOString() });
  });
}

function findTask(run, taskId) {
  id(taskId, 'task ID');
  const task = run.tasks.find(task => task.packet.id === taskId);
  if (!task) throw new CrewError(`Task ${taskId} does not exist`, 4);
  return task;
}

export function findArtifact(run, artifactId) {
  const value = run.artifacts.find(item => item.id === artifactId);
  if (!value) throw new CrewError('Artifact does not exist', 4);
  requireField(typeof value.content === 'string' && artifactDigest(value.content) === value.digest,
    `Artifact ${artifactId} does not match its recorded digest`);
  return value;
}

export function summarize(run) {
  const { artifacts, sourceFiles, ...rest } = run;
  const tasks = run.tasks.map(task => {
    const attempts = task.attempts.map(({ candidateFiles, candidateFilesDigest, candidateDiff, ...attempt }) => {
      const running = attempt.outcome === 'running';
      const evidenceStatus = running ? 'pending' : hasEvidence(run, task.packet, attempt) ? 'recorded' : 'missing';
      const receipt = runtimeRecord(run, attempt, attempt.receiptId);
      return { ...attempt, evidenceStatus, verification: verificationOf(run, attempt), trace: traceOf(run, attempt),
        durationMs: running ? null : elapsedMs(attempt.startedAt, attempt.endedAt),
        codexDurationMs: running ? null : elapsedMs(receipt?.startedAt, receipt?.endedAt),
        estimatedUsd: estimateAttemptUsd(attempt.usage, attempt.runtime),
        reviewFindings: evidenceStatus === 'recorded' ? reviewOf(run, task, attempt)?.findings : undefined };
    });
    return { ...task, attempts, usage: taskUsage({ packet: task.packet, attempts }) };
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
  if (packet.execution && attempt.result?.state === 'completed') {
    references.push(attempt.runnerArtifacts?.['check-receipt']);
    if (packet.execution.kind === 'build') references.push(attempt.runnerArtifacts?.candidate);
  }
  if (attempt.result?.state === 'completed') {
    references.push(...packet.outputs.filter(slot => slot.required).map(slot => attempt.result.artifacts[slot.id]));
  }
  return references.every(reference => {
    try { return findArtifact(run, reference).provenance.attemptId === attempt.id; }
    catch (error) { if (error instanceof CrewError) return false; throw error; }
  });
}

function runtimeRecord(run, attempt, reference) {
  if (!reference) return undefined;
  try {
    const record = findArtifact(run, reference);
    if (record.provenance.source === 'runtime' && record.provenance.attemptId === attempt.id) return JSON.parse(record.content);
  }
  catch (error) { if (error instanceof CrewError || error instanceof SyntaxError) return undefined; throw error; }
}

function verificationOf(run, attempt) {
  const receipt = runtimeRecord(run, attempt, attempt.runnerArtifacts?.['check-receipt']);
  if (receipt?.checks?.length && Array.isArray(receipt.checks) && receipt.checks.every(check => typeof check?.passed === 'boolean')) return receipt;
}

function runQuality(tasks) {
  const checks = { passed: 0, total: 0, missingReceipts: 0 };
  let reworkDecisions = 0;
  for (const task of tasks) {
    const attempt = currentAttempt(task);
    reworkDecisions += task.attempts.filter(value => value.decision?.disposition === 'rework').length;
    if (!task.packet.execution || !attempt || attempt.outcome === 'running') continue;
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

function affectedTasks(run) {
  const affected = new Set([run.orchestration.buildTask]);
  for (let previous = 0; previous !== affected.size;) {
    previous = affected.size;
    for (const task of run.tasks) {
      if (task.packet.prerequisites.some(id => affected.has(id))) affected.add(task.packet.id);
    }
  }
  return run.tasks.filter(task => affected.has(task.packet.id));
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
    for (const task of affectedTasks(run)) task.activeFrom = task.attempts.length;
    run.fixLoops.push(loop);
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

function handoffCounts(run) {
  const counts = { total: run.tasks.length, accepted: 0, running: 0, review: 0, attention: 0 };
  for (const task of run.tasks) {
    const attempt = currentAttempt(task);
    if (!attempt) continue;
    if (attempt.outcome === 'running') counts.running++;
    else if (handoffNeedsAttention(run, task, attempt)) counts.attention++;
    else if (attempt.decision?.disposition === 'accepted') counts.accepted++;
    else counts.review++;
  }
  return counts;
}

function handoffNeedsAttention(run, task, attempt) {
  return attempt && attempt.outcome !== 'running' && (attempt.outcome !== 'completed' ||
    attempt.result?.state !== 'completed' || attempt.decision?.disposition === 'rework' ||
    !hasEvidence(run, task.packet, attempt) || reviewOf(run, task, attempt)?.findings.some(finding => finding.severity === 'blocker'));
}

function runOverview(run) {
  const handoffs = handoffCounts(run);
  const recent = run.tasks.flatMap(({ packet, attempts }) => attempts.map(attempt => ({
    taskId: packet.id, title: packet.title, at: attempt.decision?.recordedAt ?? attempt.endedAt ?? attempt.startedAt,
    action: attempt.decision?.disposition ?? attempt.outcome, attempt: attempt.number,
    detail: attempt.decision?.note,
  }))).sort((a, b) => b.at.localeCompare(a.at));
  const qaPassed = run.tasks.some(task => {
    const attempt = currentAttempt(task);
    return task.packet.execution?.kind === 'verify' && attempt?.decision?.disposition === 'accepted' && verificationOf(run, attempt)?.passed;
  });
  const triagePending = run.triage?.status === 'pending';
  const triageActivity = run.triage?.recordedAt ? { title: 'Team', action: 'assigned', at: run.triage.recordedAt } : undefined;
  const pendingResources = openResources(run).map(({ id, action, target, taskId }) => ({ id, action, target, taskId }));
  const attentionTasks = run.tasks.filter(task => {
    const attempt = currentAttempt(task);
    return handoffNeedsAttention(run, task, attempt) && !resourceWait(run, task).some(resource => !resource.resolution);
  }).map(({ packet }) => ({ id: packet.id, title: packet.title }));
  return { handoffs, pendingResources, attentionTasks, triagePending,
    latestActivity: recent[0] ?? triageActivity, recentDecisions: recent.filter(event => event.detail).slice(0, 3),
    readyForProjectReview: handoffs.accepted === handoffs.total && qaPassed };
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

function prepareDispatch(run, taskId) {
  if (run.triage?.status === 'pending') throw new CrewError('Confirm team assignments before dispatching work', 3);
  const task = findTask(run, taskId);
  const previous = currentAttempt(task);
  const waiting = resourceWait(run, task);
  if (waiting.some(resource => !resource.resolution)) throw new CrewError('Resolve the resource requests before resuming this handoff', 3);
  if (waiting.length) requireField(hasEvidence(run, task.packet, previous), 'The resource request has no matching execution receipt');
  if (previous && !waiting.length && previous.decision?.disposition !== 'rework') {
    throw new CrewError('Record a rework decision before dispatching another attempt', 3);
  }
  const attemptsAtRevision = currentAttempts(task).filter(attempt => attempt.packetRevision === task.packet.revision && !attempt.resourceIds?.length).length;
  if (attemptsAtRevision >= task.packet.budget.maxAttempts) throw new CrewError('Packet attempt limit reached', 3);
  const profile = run.profiles.find(profile => profile.id === task.packet.profileId);
  const prerequisites = new Map(task.packet.prerequisites.map(id => [id, acceptedAttempt(run, id)]));
  const handoffs = [];
  const received = (task.packet.handoffInputs ?? []).map(({ task: taskId, slot }) => {
    const source = prerequisites.get(taskId);
    const input = findArtifact(run, source.result.artifacts[slot] ?? source.runnerArtifacts?.[slot]);
    requireField(input.provenance.attemptId === source.id, `Handoff ${taskId}/${slot} does not match its accepted attempt`);
    handoffs.push({ taskId, slot, attemptId: source.id, artifactId: input.id, digest: input.digest });
    return input;
  });
  const build = prerequisites.get(task.packet.execution?.candidateFrom);
  const fix = taskId === run.orchestration?.buildTask ? run.fixLoops.at(-1) : undefined;
  const previousCandidateFiles = fix ? task.attempts.find(value => value.id === fix.buildAttemptId)?.candidateFiles : undefined;
  const fixInputs = fix ? fix.artifacts.map(({ id, digest }) => {
    const input = findArtifact(run, id);
    requireField(input.digest === digest, 'Fix loop evidence no longer matches the decision');
    return input;
  }) : [];
  const resourceInputs = (run.resources ?? []).filter(resource => resource.resolution)
    .map(resource => findArtifact(run, resource.resolution.artifactId));
  const inputs = [...task.packet.inputArtifacts.map(id => findArtifact(run, id)), ...received, ...fixInputs, ...resourceInputs];
  const rework = previous?.decision ? { attemptId: previous.id, note: previous.decision.note } : previous?.rework;
  const attempt = {
    id: randomUUID(), number: task.attempts.length + 1, packetRevision: task.packet.revision,
    profileRevision: profile.revision, sourceCommit: run.sourceCommit, startedAt: new Date().toISOString(),
    outcome: 'running', runtime: run.project.runtime, effectivePermissions: inputOnlyPolicy,
    packetId: task.packetId,
    ...(run.triage?.artifactId ? { triageArtifactId: findArtifact(run, run.triage.artifactId).id } : {}),
    inputArtifacts: inputs.map(input => input.id),
    handoffs,
    ...(fix ? { fixLoop: { number: fix.number, note: fix.note, previousCandidate: fix.candidate } } : {}),
    ...(rework ? { rework } : {}),
    ...(waiting.length ? { resumedFrom: previous.id } : {}),
    prerequisites: [...prerequisites].map(([taskId, attempt]) => ({ taskId, attemptId: attempt.id })),
  };
  const instructions = [profile.instructionId, ...profile.skillIds].map(id => findArtifact(run, id).content);
  task.attempts.push(attempt);
  return { attempt, task: { ...task.packet, inputArtifacts: attempt.inputArtifacts, handoffs, rework: attempt.rework, fixLoop: attempt.fixLoop },
    candidate: build?.candidate, candidateFiles: build?.candidateFiles, candidateFilesDigest: build?.candidateFilesDigest,
    previousCandidateFiles,
    sourceFiles: run.sourceFiles, profile, inputs, instructions,
    projectId: run.project.id, model: run.project.runtime.model };
}

export async function dispatch(store, taskId, signal, onStart, execute = executeCodex, db, options) {
  const job = await store.update(run => prepareDispatch(run, taskId));
  onStart?.(job.attempt.id);
  return executeDispatch(store, job, signal, execute, db, options);
}

export async function dispatchInitial(store, signal, onStart, execute = executeCodex, db, options) {
  const jobs = await store.update(run => {
    if (run.triage?.status !== 'assigned') return [];
    return run.tasks.filter(task => !task.packet.prerequisites.length && !task.attempts.length)
      .map(({ packet }) => prepareDispatch(run, packet.id));
  });
  onStart?.(jobs.map(({ task, attempt }) => ({ taskId: task.id, attemptId: attempt.id })));
  return executeJobs(store, jobs, signal, execute, db, options);
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

function prepareResourceResumes(run) {
  return run.tasks.flatMap(task => {
    const waiting = resourceWait(run, task);
    if (!waiting.length || waiting.some(resource => !resource.resolution)) return [];
    try { return [prepareDispatch(run, task.packet.id)]; }
    catch (error) {
      if (!(error instanceof CrewError)) throw error;
      return [];
    }
  });
}

export async function resolveResource(store, resourceId, note, signal, onStart, execute = executeCodex, db, options) {
  text(note, 'resource resolution note', 1_000);
  const { resolution, jobs } = await store.update(run => {
    const resource = openResources(run).find(resource => resource.id === resourceId);
    requireField(resource, 'This resource request is no longer open');
    requireField(!isProvisioning(resource), 'Automatic setup is still in progress');
    const task = findTask(run, resource.taskId);
    const attempt = task.attempts.find(attempt => attempt.id === resource.attemptId);
    requireField(attempt && hasEvidence(run, task.packet, attempt), 'The resource request has no matching execution receipt');
    const resolution = recordResourceResolution(run, resource, resource.mode === 'deny' ? 'declined' : 'ready', 'operator', note);
    return { resolution, jobs: prepareResourceResumes(run) };
  });
  onStart?.(jobs.map(({ task, attempt }) => ({ taskId: task.id, attemptId: attempt.id })));
  const attempts = await executeJobs(store, jobs, signal, execute, db, options);
  return { resolution, attempts };
}

async function executeDispatch(store, job, signal, execute, db, { captureActivity = false } = {}) {
  const taskId = job.task.id;
  const deadline = AbortSignal.timeout(job.task.budget.timeoutSeconds * 1000);
  const attemptSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;

  let observation;
  let result;
  try {
    observation = await execute({ ...job, signal: attemptSignal, captureActivity });
    if (observation.outcome === 'completed') {
      result = validateResponse(observation.response, job.task);
      requireField(!result.resourceRequests?.length || observation.receipt, 'A resource request needs a recorded execution receipt');
    }
  } catch (error) {
    result = undefined;
    observation = { ...observation, outcome: observation ? 'invalid-result' : 'execution-failed',
      error: error instanceof CrewError ? error.message : 'Could not complete the local Codex attempt' };
  }
  let checked;
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
    const attempt = task.attempts.find(attempt => attempt.id === job.attempt.id);
    const { receipt, outcome, error } = observation;
    Object.assign(attempt, { outcome, error, endedAt: new Date().toISOString(), usage: receipt?.usage ?? null });
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
    if (receipt) {
      const receiptId = `receipt-${attempt.id}`;
      run.artifacts.push(artifact(receiptId, 'Codex execution receipt', 'json', JSON.stringify({
        schemaVersion: 1, runId: run.id, taskId, attemptId: attempt.id, sourceCommit: run.sourceCommit,
        outcome: checked || outcome === 'check-failed' ? 'completed' : attempt.outcome, ...receipt,
      }, null, 2), { source: 'runtime', attemptId: attempt.id }));
      attempt.receiptId = receiptId;
      if (captureActivity && observation.activity) {
        const activityId = `activity-${attempt.id}`;
        run.artifacts.push(artifact(activityId, 'Captured Codex prompt and response', 'json', JSON.stringify(observation.activity),
          { source: 'runtime', attemptId: attempt.id }));
        attempt.activityId = activityId;
      }
    }
    if (checked) {
      attempt.candidate = checked.candidate;
      if (checked.files) attempt.candidateFiles = checked.files;
      attempt.runnerArtifacts = {};
      const evidence = { ...checked.receipt, runId: run.id, taskId, attemptId: attempt.id };
      const entries = [['check-receipt', checked.receipt.kind === 'independent-qa' ? 'Independent QA · Docker receipt' : 'Author tests · Docker receipt', evidence]];
      if (task.packet.execution.kind === 'build') entries.push(['candidate', 'Candidate revision', checked.candidate]);
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
          run.artifacts.push(artifact(artifactId, slot.title ?? output.slot, slot.kind, output.content,
            { source: 'agent-result', attemptId: attempt.id }));
          return [output.slot, artifactId];
        })) };
    }
    return { attempt, claims, ready: attempt.resourceIds?.length && !claims.length ? prepareResourceResumes(run) : [] };
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
      return prepareResourceResumes(run);
    });
  }
  const resumed = await executeJobs(store, jobs, signal, execute, db, { captureActivity });
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
      if (attempt.outcome !== 'completed' || attempt.result?.state !== 'completed') {
        throw new CrewError('Only a completed handoff with valid outputs can be accepted', 3);
      }
      requireField(hasEvidence(run, task.packet, attempt), 'Required outputs and evidence must come from the current attempt');
      if (task.packet.outputs.some(slot => slot.kind === 'review-findings')) {
        const review = reviewOf(run, task, attempt);
        requireField(review && review.findings.every(finding => finding.severity !== 'blocker'),
          'Implementation review has unresolved blockers');
      }
    }
    attempt.decision = { disposition, note, owner: task.packet.acceptedBy, recordedAt: new Date().toISOString() };
    return attempt.decision;
  });
}
