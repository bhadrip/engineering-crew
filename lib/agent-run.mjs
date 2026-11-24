import { CrewError, requireField, text } from './contracts.mjs';
import { artifact, artifactDigest, observeRunWorkers, runStore } from './run-store.mjs';
import { buildWorkflowSnapshot, workflowInputBytes } from './workflow-editor.mjs';
import { prepareWorkflowRun, summarize } from './workflow.mjs';
import { agentSkillAttachments } from './agent-library.mjs';
import { projectSkillsEnabled } from './project-skills.mjs';
import { nativeSkillChoices, validateSkillInvocations } from './workflow-skills.mjs';
import { agentImageArtifacts, agentImagesEnabled, normalizeAgentImages } from './agent-images.mjs';
import { repositoryInstructionPaths } from './workflow-workspace.mjs';

export const agentRunTask = 'run-agent';
export const agentRunIdPattern = /^agent-run-[a-f0-9]{32}$/;
export const agentDraftArtifactId = 'agent-draft-definition';

export async function listAgentRuns(db, projectId, agentId) {
  const { rows } = await db.query(`SELECT record FROM engineering_crew.runs
    WHERE project_id=$1 AND record#>>'{agentRun,agentId}'=$2 ORDER BY record->>'startedAt' DESC, id DESC LIMIT 20`,
  [projectId, agentId]);
  return (await observeRunWorkers(db, rows.map(row => row.record))).map(summarize);
}

export function canStageAgentDelivery(project, agent) {
  return project.id === 'music-transcribe' && ['read-only', 'workspace-write'].includes(agent.definition.runtime?.workspace);
}

export function savesAgentRunWorkspace(project, agent) {
  return project.id === 'music-transcribe' && agent.definition.runtime?.workspace === 'workspace-write' && agent.definition.runtime.saveThread;
}

export function agentRunSkillChoices(project, agent) {
  if (!projectSkillsEnabled(project.id)) return [];
  return nativeSkillChoices(agent.definition.runtime?.workspace, agentSkillAttachments(agent.definition).map(({ name }) => name));
}

export function createAgentDraftRun(db, { baseAgent, definition, ...request }) {
  requireField(request.project.id === 'music-transcribe' && definition.projectId === request.project.id,
    'Open the Music Transcribe agent editor to test a draft.');
  const draft = { artifactId: agentDraftArtifactId, digest: artifactDigest(JSON.stringify(definition)),
    baseVersion: baseAgent?.version ?? 0, ...(baseAgent && { baseAgentId: baseAgent.id }) };
  return createAgentRun(db, { ...request, agent: { definition, draft } });
}

export async function createAgentRun(db, { project, agent, runId, sourceCommit, prompt, reference, deliveryRunId, repositoryBaseline,
  invokeSkills = [], images = [] }) {
  requireField(agentRunIdPattern.test(runId), 'Open the agent runner to start a new run.');
  text(prompt, 'agent run prompt', workflowInputBytes);
  requireField(typeof reference === 'string' && Buffer.byteLength(reference) <= workflowInputBytes && !reference.includes('\0'),
    'Enter reference material of up to 12,000 bytes.');
  const { id: agentId, version, definition, draft } = agent;
  requireField(deliveryRunId === undefined || canStageAgentDelivery(project, agent), 'Choose a native Music Transcribe agent to use a published workspace.');
  requireField(!repositoryBaseline || (project.id === 'music-transcribe' && definition.runtime?.repositoryInstructions && !deliveryRunId &&
    sourceCommit === repositoryBaseline.commit && repositoryBaseline.files.length > 0 &&
    repositoryBaseline.files.every(({ path }) => repositoryInstructionPaths.includes(path))),
  'The committed repository instructions do not match this agent run.');
  const selection = validateSkillInvocations(invokeSkills, agentRunSkillChoices(project, agent));
  const skillSelection = selection.length ? { invokeSkills: selection } : {};
  const attachments = normalizeAgentImages(images);
  requireField(!attachments.length || agentImagesEnabled(project.id), 'Image attachments are unavailable for this project.');
  const requestDigest = artifactDigest(JSON.stringify({ project: project.id, agentId, version, draft, prompt, reference, deliveryRunId, ...skillSelection,
    ...(repositoryBaseline && { repositoryBaseline: artifactDigest(JSON.stringify(repositoryBaseline)) }),
    ...(attachments.length && { images: attachments.map(({ name, sha256 }) => [name, sha256]) }) }));
  const store = runStore(db, runId);
  const replay = existing => {
    if (existing.agentRun?.requestDigest !== requestDigest)
      throw new CrewError('This run was already submitted. Open a new run form to change its inputs.', 3);
    return { needsDispatch: !existing.tasks[0].attempts.length };
  };
  const existing = await store.read().catch(error => {
    if (!(error instanceof CrewError) || error.code !== 4) throw error;
    return null;
  });
  if (existing) return replay(existing);
  const inputRows = reference.trim() ? [{ ref: 'reference', id: 'reference', title: 'Run reference', content: reference }] : [];
  const snapshot = await buildWorkflowSnapshot(db, { project, workflowId: runId, sourceCommit, workspaceBaseline: repositoryBaseline,
    ...(draft && { draftAgent: agent }), draft: {
    title: draft ? 'Agent draft test' : 'Agent run',
    goal: draft ? 'Test the draft agent using the supplied prompt.' : 'Run the saved agent using the supplied prompt.', brief: prompt, inputRows,
    steps: [{ id: agentRunTask, title: (draft ? 'Test ' : 'Run ') + definition.name, objective: 'Complete the request in the pinned agent run prompt.',
      owner: 'Project owner', agent: draft ? 'workflow:draft-agent' : `library:${agentId}:${version}`, prerequisites: [],
      ...(deliveryRunId && { workspaceSource: 'delivery' }),
      ...(repositoryBaseline && { workspaceSource: 'baseline' }),
      ...(savesAgentRunWorkspace(project, agent) && { captureWorkspace: true }),
      inputs: ['brief', ...inputRows.map(input => input.id)],
      outputs: [{ id: 'result', title: 'Result', kind: 'markdown', required: true, acceptance: 'Answer the run prompt.' }] }],
  } });
  const preview = prompt.trim().split(/\n/, 1)[0];
  const agentRun = { ...(draft ? { draft } : { agentId, version }), requestDigest,
    preview: preview.length > 120 ? preview.slice(0, 119) + '…' : preview, ...skillSelection };
  try {
    const run = await prepareWorkflowRun(db, { ...snapshot, agentRun }, runId,
      { deliveryRunId, agentImages: agentImageArtifacts(attachments, 1) });
    if (draft) run.artifacts.push(artifact(draft.artifactId, 'Tested agent definition', 'json', JSON.stringify(definition),
      { source: 'agent-draft', runId, sourceCommit, baseVersion: draft.baseVersion, baseAgentId: draft.baseAgentId }));
    await store.create(run);
    return { needsDispatch: true };
  } catch (error) {
    if (!(error instanceof CrewError) || error.code !== 3) throw error;
    return replay(await store.read());
  }
}
