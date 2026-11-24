import { isDeepStrictEqual } from 'node:util';
import { CrewError, id, requireField, text, uniqueBy } from './contracts.mjs';
import { artifactOutputKinds, browserActivitySlot, workflowOutputSlot } from './workflow-artifacts.mjs';
import { validateTriage } from './git-control.mjs';
import { agentSkillAttachments, loadReusableAgent } from './agent-library.mjs';
import { workflowNativeSettings } from './workflow-native.mjs';
import { conditionFromDraft, validateWorkflowRouting } from './workflow-routing.mjs';
import { validateWorkflowPolicies } from './workflow-policy.mjs';
import { validateWorkspaceSteps } from './workflow-workspace.mjs';
import { validateMusicWorkspaceChecks } from './workflow-music-checks.mjs';
import { nativeSkillChoices, skillAssetDetails, skillBundleLimits, validateSkillInvocations } from './workflow-skills.mjs';
import { loadProjectMcp, pinnedProjectMcp } from './project-mcp.mjs';
import { projectSkillsEnabled } from './project-skills.mjs';
import { validateWorkflowImageRouting, validateWorkflowProject } from './workflow-intake.mjs';

const briefPath = 'crew-workflow/brief.md';
const defaultAcceptance = 'Answer the step objective and cite the supplied evidence.';
const defaultResult = Object.freeze({ id: 'result', title: 'Result', kind: 'markdown', required: true, acceptance: defaultAcceptance });
const lockedOutputKinds = new Set(['source', 'check-cases', 'review-findings']);
export const workflowInputLimit = 20;
export const workflowInputBytes = 12_000;
export const stepOutputLimit = 6;
export const stepBudgetDefaults = Object.freeze({ targetTotalTokens: 40_000, timeoutSeconds: 180, maxAttempts: 2 });

function editableInputs(snapshot) {
  const overrides = new Map(snapshot?.inputOverrides);
  return (snapshot?.project.inputs ?? []).filter(input => snapshot.editorInputIds?.includes(input.id))
    .map(({ id, title }) => ({ ref: id, id, title, content: overrides.get(id) ?? '' }));
}

export function workflowInputChoices(snapshot, rows) {
  const fixed = snapshot ? snapshot.project.inputs.filter(input => !snapshot.editorInputIds?.includes(input.id))
    : [{ id: 'brief', title: 'Workflow brief', path: briefPath }];
  return [...fixed.map(input => ({ ...input, ref: input.id })), ...(rows ?? editableInputs(snapshot))];
}

export function nextWorkflowRow(rows, prefix) {
  let n = 1;
  while (rows.some(row => row.ref === prefix + '-' + n || row.id === prefix + '-' + n)) n++;
  return prefix + '-' + n;
}

function draftOutput(slot) {
  return { ...workflowOutputSlot(slot), ref: slot.id, ...(lockedOutputKinds.has(slot.kind) && { locked: true }) };
}

export function newWorkflowOutput(outputs) {
  const ref = nextWorkflowRow(outputs, 'output');
  return { ...defaultResult, ref, id: ref, title: '' };
}

export function handoffChoices(step, { includeOptional = false } = {}) {
  const evidence = step.execution === 'build' ? [
    { ref: 'candidate', title: 'Candidate revision' }, { ref: 'candidate-diff', title: 'Candidate Git diff' },
    { ref: 'check-receipt', title: 'Docker check receipt' },
  ] : step.execution === 'verify' ? [{ ref: 'check-receipt', title: 'Docker check receipt' }]
    : step.workspaceCheck ? [{ ref: 'check-receipt', title: 'Music Transcribe acceptance receipt' }] : [];
  return [...(step.outputs ?? []).filter(slot => slot.required || includeOptional), ...evidence];
}

export function workflowDraft(snapshot) {
  const project = snapshot?.project;
  return {
    title: project?.epic.title ?? '',
    goal: project?.epic.goal ?? '',
    dispatchMode: project?.dispatchMode ?? 'manual',
    workspacePaths: snapshot?.workspaceBaseline?.files.map(file => file.path).join('\n') ?? '',
    ...(snapshot?.inlineBrief ? { brief: new Map(snapshot.inputOverrides).get('brief') ?? '' } : snapshot ? {} : { brief: '' }),
    inputRows: editableInputs(snapshot),
    steps: project ? project.tasks.map(task => ({
      id: task.id, title: task.title, objective: task.objective, owner: task.acceptedBy, reviewMode: task.reviewMode ?? 'human',
      responseMode: task.responseMode ?? 'structured',
      outputFollowUps: task.outputFollowUps ?? 0,
      agent: 'workflow:' + task.profileId, prerequisites: task.prerequisites, inputs: task.inputs,
      ...(task.invokeSkills?.length && { skillSelections: task.invokeSkills.map(number => task.profileId + '/' + number) }),
      receiveRequestImages: task.receiveRequestImages ?? false,
      historyFrom: task.codexHistoryFrom ?? '',
      workspaceSource: task.workspaceSource ?? '', captureWorkspace: task.captureWorkspace ?? false,
      workspaceCheck: task.workspaceCheck ?? '',
      workspaceRepair: task.workspaceRepair ?? null,
      publishWorkspace: task.publishWorkspace ?? false,
      joinPrerequisites: task.joinPrerequisites ?? [],
      ...(task.runWhen && { runWhen: { step: task.runWhen.task, output: task.runWhen.slot, pointer: task.runWhen.pointer,
        operator: task.runWhen.operator, value: JSON.stringify(task.runWhen.expected) ?? '' } }),
      outputs: task.outputs.map(draftOutput), routes: task.handoffInputs?.map(({ task, slot }) => ({ step: task, output: slot })) ?? [],
      ...(task.execution && { execution: task.execution.kind }), budget: task.budget,
    })) : [newWorkflowStep([], ['brief'])],
  };
}

export function newWorkflowStep(steps, inputs, reserved = []) {
  let n = steps.length + 1;
  while (steps.some(step => step.id === 'step-' + n) || reserved.some(step => step.id === 'step-' + n)) n++;
  return { id: 'step-' + n, title: '', objective: '', owner: 'Project owner', agent: '', prerequisites: [],
    inputs: inputs.slice(0, 1), outputs: [draftOutput(defaultResult)], routes: [], budget: stepBudgetDefaults };
}

function markdownResult(task) {
  return task?.outputs.length === 1 && task.outputs[0].kind === 'markdown' ? task.outputs[0] : null;
}

function originalWorkflow(project, workflowId, sourceCommit) {
  return {
    project: {
      schemaVersion: 1, id: project.id, name: project.name, crewName: project.crewName || 'Engineering Crew',
      epic: { id: workflowId }, runtime: { kind: 'codex' }, inputs: [{ id: 'brief', title: 'Workflow brief', path: briefPath }],
      profiles: [], tasks: [],
    },
    sourceCommit, inlineBrief: true, inputOverrides: [], sourceFiles: {}, files: new Map(),
  };
}

function inputDefinitions(base, draft) {
  if (!draft.inputRows) return { inputs: base.project.inputs, overrides: new Map(base.inputOverrides), editorInputIds: base.editorInputIds };
  const fixed = base.project.inputs.filter(input => !base.editorInputIds?.includes(input.id));
  const fixedIds = new Set(fixed.map(input => input.id));
  const overrides = new Map((base.inputOverrides ?? []).filter(([id]) => fixedIds.has(id)));
  const authored = draft.inputRows.map(row => {
    requireField(!fixedIds.has(row.ref), 'A workflow input conflicts with a pinned input.');
    id(row.id, 'workflow input ID');
    text(row.title, 'workflow input name', 120);
    requireField(typeof row.content === 'string' && row.content.trim() && !row.content.includes('\0') &&
      Buffer.byteLength(row.content) <= workflowInputBytes, 'Enter content of up to 12,000 bytes for “' + row.title + '”.');
    overrides.set(row.id, row.content);
    return { id: row.id, title: row.title, path: 'crew-workflow/inputs/' + row.id + '.txt' };
  });
  const inputs = [...fixed, ...authored];
  uniqueBy(inputs, 'id', 'workflow input ID');
  return { inputs, overrides, editorInputIds: authored.length ? authored.map(input => input.id) : undefined };
}

function resolvedOutputs(step, old) {
  if (!step.outputs) {
    const outputs = old?.outputs ?? [defaultResult];
    return step.acceptance !== undefined && markdownResult({ outputs }) ?
      [{ ...outputs[0], acceptance: step.acceptance }] : outputs;
  }
  const locked = new Map((old?.outputs ?? []).filter(slot => lockedOutputKinds.has(slot.kind)).map(slot => [slot.id, slot]));
  const outputs = step.outputs.map(({ ref, id: slotId, title, kind, required, acceptance }) => {
    if (locked.has(ref)) return locked.get(ref);
    requireField(Object.hasOwn(artifactOutputKinds, kind), 'Choose a type for output “' + (title || slotId) + '”.');
    if (title) text(title, 'output name', 120);
    return { id: slotId, ...(title && { title }), kind: 'markdown', ...(kind !== 'markdown' && { format: kind }), required, acceptance };
  });
  requireField([...locked.values()].every(slot => outputs.includes(slot)), 'Keep the outputs required by the configured runner or review.');
  return outputs;
}

function keepSelectionOrder(selected, previous, key = value => value) {
  if (!previous?.length) return selected;
  const position = new Map(previous.map((value, index) => [key(value), index]));
  return selected.toSorted((a, b) => (position.get(key(a)) ?? previous.length) - (position.get(key(b)) ?? previous.length));
}

async function pinAgent(db, projectId, reference, profiles, origins, files, skillAssets) {
  if (reference.startsWith('workflow:')) {
    const profile = profiles.get(reference.slice('workflow:'.length));
    requireField(profile, 'Choose an agent available to this workflow.');
    return profile.id;
  }
  const match = /^library:(agent-[a-f0-9]{32}):([1-9]\d{0,4})$/.exec(reference);
  requireField(match, 'Choose an agent for every step.');
  const [, agentId, version] = match;
  const profileId = agentId + '-v' + version;
  const pinned = profiles.get(profileId);
  if (pinned) {
    requireField(origins[profileId]?.agentId === agentId && origins[profileId]?.version === Number(version), 'The agent ID conflicts with a workflow profile.');
    return profileId;
  }
  const agent = await loadReusableAgent(db, agentId, projectId, Number(version));
  return pinAgentDefinition(db, projectId, agent, profileId, profiles, origins, files, skillAssets);
}

async function pinAgentDefinition(db, projectId, agent, profileId, profiles, origins, files, skillAssets) {
  const { name, remit, model, instructions, tools = [], runtime, projectMcp = [], projectSkills = [], musicPracticeProfile, musicBrowserProfile } = agent.definition;
  requireField(!runtime?.imageGeneration || projectId === 'music-transcribe', 'Choose an agent without image generation for this project.');
  requireField(!runtime?.serviceTier || projectId === 'music-transcribe', 'Choose an agent with worker-default Codex speed for this project.');
  const skills = agentSkillAttachments(agent.definition);
  const connections = await Promise.all(projectMcp.map(async ({ id, version }) =>
    pinnedProjectMcp(projectId, await loadProjectMcp(db, projectId, id, version))));
  const path = 'crew-library/' + profileId + '/';
  const profile = {
    id: profileId, revision: agent.version ?? 1, name, remit, ...(model && { model }),
    instructions: path + 'instructions.md', skills: skills.map((_, index) => path + 'skill-' + (index + 1) + '.md'), tools: [],
  };
  files.set(profile.instructions, instructions);
  skills.forEach((skill, index) => files.set(profile.skills[index], skill.content));
  const skillBundles = skills.map((skill, index) => {
    if (!skill.bundle) return null;
    return { directory: skill.bundle.directory, files: skill.bundle.files.map(file => {
      const key = profile.skills[index] + '/' + file.path;
      skillAssets[key] = file.data;
      return { key, ...skillAssetDetails(file) };
    }) };
  });
  origins[profileId] = { ...(agent.draft ? { draft: agent.draft } : { agentId: agent.id, version: agent.version }),
    skillNames: skills.map(skill => skill.name),
    ...(skillBundles.some(Boolean) && { skillBundles }),
    ...(projectSkills.length && { projectSkillRefs: projectSkills.map(({ id, version }, i) =>
      ({ id, version, index: agent.definition.skills.length + i })) }),
    ...(connections.length && { projectMcp: connections }),
    ...(musicPracticeProfile && { musicPracticeProfile }),
    ...(musicBrowserProfile && { musicBrowserProfile }),
    ...(agent.definition.featureSource && { featureSource: agent.definition.featureSource }),
    codexTools: tools, codexRuntime: workflowNativeSettings(runtime) };
  profiles.set(profileId, profile);
  return profileId;
}

export async function buildWorkflowSnapshot(db, { project, workflowId, baseline, sourceCommit, draft, workspaceBaseline = baseline?.workspaceBaseline,
  workspaceCheckProfile = baseline?.project.workspaceCheckProfile, draftAgent }) {
  id(workflowId, 'workflow ID');
  if (!draft.steps.length || draft.steps.length > 20) throw new CrewError('A workflow needs between 1 and 20 steps.', 2);
  if (new Set(draft.steps.map(step => step.id)).size !== draft.steps.length) throw new CrewError('Duplicate workflow step.', 2);
  const { version: _version, ...base } = baseline ?? originalWorkflow(project, workflowId, sourceCommit);
  const previous = new Map(base.project.tasks.map(task => [task.id, task]));
  const { inputs: projectInputs, overrides, editorInputIds } = inputDefinitions(base, draft);
  const inputRefs = new Map(workflowInputChoices(base, draft.inputRows).map(input => [input.ref, input.id]));
  const profiles = new Map(base.project.profiles.map(profile => [profile.id, profile]));
  const agentOrigins = { ...base.agentOrigins };
  const skillAssets = { ...base.skillAssets };
  const files = new Map(base.files);
  if (draftAgent) {
    requireField(project.id === 'music-transcribe' && !baseline && draft.steps.length === 1 && draft.steps[0].agent === 'workflow:draft-agent',
      'An agent draft requires a single Music Transcribe test assignment.');
    await pinAgentDefinition(db, project.id, draftAgent, 'draft-agent', profiles, agentOrigins, files, skillAssets);
  }
  const tasks = [];
  for (const step of draft.steps) {
    id(step.id, 'step ID');
    const old = previous.get(step.id);
    const profileId = await pinAgent(db, project.id, step.agent, profiles, agentOrigins, files, skillAssets);
    const inputs = keepSelectionOrder(step.inputs, old?.inputs).map(ref => {
      requireField(inputRefs.has(ref), 'Unknown step input: ' + ref);
      return inputRefs.get(ref);
    });
    const paths = inputs.map(input => {
      const definition = projectInputs.find(value => value.id === input);
      requireField(definition, 'Unknown step input: ' + input);
      return definition.path;
    });
    const task = {
      ...(old ?? {
        id: step.id, revision: 1, criteria: [], budget: stepBudgetDefaults,
        permissions: { mode: 'read-only', toolNetwork: 'denied', tools: [], externalActions: [], writePaths: [] },
      }),
      title: step.title, objective: step.objective, acceptedBy: step.owner, profileId, inputs,
      outputs: resolvedOutputs(step, old), prerequisites: keepSelectionOrder(step.prerequisites, old?.prerequisites),
    };
    task.permissions = { ...task.permissions, readPaths: [...new Set(paths)] };
    if (step.receiveRequestImages === false) delete task.receiveRequestImages;
    else if (step.receiveRequestImages !== undefined) task.receiveRequestImages = step.receiveRequestImages;
    if (step.skillSelections !== undefined || profileId !== old?.profileId) {
      const selections = step.skillSelections ?? [];
      const prefix = profileId + '/';
      requireField(Array.isArray(selections) && selections.every(value => typeof value === 'string' && value.startsWith(prefix) &&
        /^[1-9]\d*$/.test(value.slice(prefix.length))), 'Choose explicit skills for the assigned agent version.');
      const origin = agentOrigins[profileId];
      const choices = projectSkillsEnabled(project.id) && !task.execution
        ? nativeSkillChoices(origin?.codexRuntime?.workspace, origin?.skillNames) : [];
      const numbers = validateSkillInvocations(selections.map(value => Number(value.slice(prefix.length))), choices);
      if (numbers.length) task.invokeSkills = numbers;
      else delete task.invokeSkills;
    }
    if (step.reviewMode === 'human') delete task.reviewMode;
    else if (step.reviewMode !== undefined) task.reviewMode = step.reviewMode;
    if (step.responseMode === 'structured') delete task.responseMode;
    else if (step.responseMode !== undefined) task.responseMode = step.responseMode;
    if (step.outputFollowUps === 0 || (step.responseMode === 'structured' && step.outputFollowUps === undefined)) delete task.outputFollowUps;
    else if (step.outputFollowUps !== undefined) task.outputFollowUps = step.outputFollowUps;
    if (step.captureWorkspace === false) delete task.captureWorkspace;
    else if (step.captureWorkspace !== undefined) task.captureWorkspace = step.captureWorkspace;
    if (step.workspaceSource === '') delete task.workspaceSource;
    else if (step.workspaceSource !== undefined) task.workspaceSource = step.workspaceSource;
    if (step.workspaceCheck === '') delete task.workspaceCheck;
    else if (step.workspaceCheck !== undefined) task.workspaceCheck = step.workspaceCheck;
    if (step.workspaceRepair === null) delete task.workspaceRepair;
    else if (step.workspaceRepair !== undefined) task.workspaceRepair = step.workspaceRepair;
    if (step.publishWorkspace === false) delete task.publishWorkspace;
    else if (step.publishWorkspace !== undefined) task.publishWorkspace = step.publishWorkspace;
    if (step.budget) task.budget = { ...task.budget, ...step.budget };
    tasks.push(task);
  }
  const drafts = new Map(draft.steps.map(step => [step.id, step]));
  for (const task of tasks) {
    const old = previous.get(task.id);
    const { routes, historyFrom = old?.codexHistoryFrom, runWhen, joinPrerequisites = old?.joinPrerequisites } = drafts.get(task.id);
    if (joinPrerequisites?.length) task.joinPrerequisites = keepSelectionOrder(joinPrerequisites, old?.joinPrerequisites);
    else delete task.joinPrerequisites;
    if (runWhen) {
      const slot = drafts.get(runWhen.step)?.outputs?.find(output => output.ref === runWhen.output);
      requireField(slot, 'Choose a JSON output for the run condition on “' + task.title + '”.');
      task.runWhen = conditionFromDraft(runWhen, slot.id);
    } else if (runWhen === null) delete task.runWhen;
    if (historyFrom) {
      const parent = tasks.find(candidate => candidate.id === historyFrom);
      requireField(task.prerequisites.includes(historyFrom) && parent?.profileId === task.profileId &&
        agentOrigins[task.profileId]?.codexRuntime?.saveThread,
        'Choose a direct prerequisite using the same agent version with saved Codex history for “' + task.title + '”.');
      task.codexHistoryFrom = historyFrom;
    } else delete task.codexHistoryFrom;
    if (routes) {
      const previousRoutes = old?.handoffInputs?.map(({ task, slot }) => ({ step: task, output: slot }));
      task.handoffInputs = keepSelectionOrder(routes, previousRoutes, route => route.step + '/' + route.output).map(({ step, output }) => {
        const parent = drafts.get(step);
        const selected = parent && handoffChoices(parent).find(slot => slot.ref === output);
        requireField((selected || (project.id === 'music-transcribe' && parent && output === browserActivitySlot)) && task.prerequisites.includes(step),
          'Choose an output or recorded evidence from a prerequisite for “' + task.title + '”.');
        return { task: step, slot: selected?.id ?? output };
      });
      if (!task.handoffInputs.length && old && !old.handoffInputs) delete task.handoffInputs;
    } else {
      const handoffs = (old?.handoffInputs ?? []).filter(input => task.prerequisites.includes(input.task));
      for (const parentId of task.prerequisites.filter(id => !old?.prerequisites.includes(id))) {
        const parent = tasks.find(task => task.id === parentId);
        requireField(parent, 'Unknown prerequisite: ' + parentId);
        handoffs.push(...parent.outputs.filter(output => output.required).map(output => ({ task: parentId, slot: output.id })));
      }
      if (handoffs.length || old?.handoffInputs || !old) task.handoffInputs = handoffs;
    }
    requireField(task.inputs.length || task.handoffInputs?.length,
      'Select a workflow input or a prerequisite artifact for “' + task.title + '”.');
    if (old && !isDeepStrictEqual(task, old)) task.revision++;
  }
  const assigned = new Set(tasks.flatMap(task => [task.profileId, ...(task.alternateProfiles ?? [])]));
  for (const [profileId, profile] of profiles) {
    if (Object.hasOwn(agentOrigins, profileId) && !assigned.has(profileId)) {
      profiles.delete(profileId);
      for (const bundle of agentOrigins[profileId].skillBundles ?? [])
        for (const file of bundle?.files ?? []) delete skillAssets[file.key];
      delete agentOrigins[profileId];
      for (const path of [profile.instructions, ...profile.skills]) files.delete(path);
    }
  }
  const updated = { ...base.project, epic: { ...base.project.epic, title: draft.title, goal: draft.goal },
    inputs: projectInputs, tasks, profiles: [...profiles.values()] };
  if (draft.dispatchMode === 'manual') delete updated.dispatchMode;
  else if (draft.dispatchMode !== undefined) updated.dispatchMode = draft.dispatchMode;
  if (tasks.some(task => task.workspaceCheck)) updated.workspaceCheckProfile = workspaceCheckProfile;
  else delete updated.workspaceCheckProfile;
  validateWorkflowProject(updated, agentOrigins);
  validateWorkflowPolicies(updated, profileId => Array.isArray(agentOrigins[profileId]?.codexTools));
  validateWorkflowRouting(tasks);
  validateWorkflowImageRouting(updated, agentOrigins);
  validateWorkspaceSteps(updated, profileId => agentOrigins[profileId]?.codexRuntime, workspaceBaseline);
  validateMusicWorkspaceChecks(updated);
  validateTriage(updated);
  if (base.inlineBrief) {
    if (!draft.brief?.trim() || draft.brief.includes('\0') || Buffer.byteLength(draft.brief) > 12_000)
      throw new CrewError('Add a workflow brief of up to 12,000 bytes.', 2);
    overrides.set('brief', draft.brief);
  }
  const inputOverrides = projectInputs.filter(input => overrides.has(input.id)).map(input => [input.id, overrides.get(input.id)]);
  if (baseline && isDeepStrictEqual(updated, base.project) && isDeepStrictEqual(inputOverrides, base.inputOverrides) &&
      isDeepStrictEqual(workspaceBaseline ?? null, base.workspaceBaseline ?? null)) return base;
  const raw = JSON.stringify(updated, null, 2);
  const nativeDefinitions = Object.values(agentOrigins).flatMap(({ codexRuntime }) => [
    ...(codexRuntime?.subagentRoles ?? []).map(role => JSON.stringify(role)),
    ...(codexRuntime?.hooks ? [JSON.stringify(codexRuntime.hooks)] : []),
  ]);
  requireField([raw, ...files.values(), ...inputOverrides.map(([, content]) => content), ...nativeDefinitions]
    .reduce((bytes, content) => bytes + Buffer.byteLength(content), 0) <= 180_000, 'The workflow and its pinned inputs exceed the project size limit.');
  requireField(Object.values(skillAssets).reduce((bytes, data) => bytes + Buffer.byteLength(data, 'base64'), 0) <= skillBundleLimits.workflowBytes,
    'The workflow exceeds the total size limit for pinned skill resources.');
  const { editorInputIds: _previousEditorInputs, workspaceBaseline: _previousWorkspace, ...rest } = base;
  return { ...rest, project: updated, raw, inputOverrides, files, agentOrigins, skillAssets, ...(editorInputIds && { editorInputIds }),
    ...(workspaceBaseline && { workspaceBaseline }) };
}
