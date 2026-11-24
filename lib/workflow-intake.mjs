import { CrewError, requireField, text, validateProject } from './contracts.mjs';
import { agentImageLimits, agentImagesEnabled } from './agent-images.mjs';
import { browserActivitySlot, isBrowserOutput, isImageOutput, isRuntimeEvidenceSlot, workflowOutputSlot } from './workflow-artifacts.mjs';
import { musicBrowserTool } from './workflow-agent-tools.mjs';

export function workflowBriefInput(project) {
  const id = project.triage?.briefInput ?? 'brief';
  return project.inputs.find(input => input.id === id &&
    (project.triage?.mode === 'manual' || project.tasks.some(task => task.inputs.includes(id))));
}

export function workflowRequestBrief(value) {
  text(value, 'request brief', 12_000);
  const brief = value.replace(/\r\n?/g, '\n').trim();
  if (brief.includes('\0') || Buffer.byteLength(brief) > 12_000)
    throw new CrewError('Enter a request brief of up to 12,000 bytes.', 2);
  return brief;
}

export function workflowRequestImageSteps(project) {
  return project.tasks.filter(task => task.receiveRequestImages === true);
}

export function validateRuntimeEvidenceRouting(project, agentOrigins) {
  if (project.id !== 'music-transcribe') return;
  const tasks = new Map(project.tasks.map(task => [task.id, task]));
  for (const task of tasks.values()) {
    const inputs = task.handoffInputs ?? [];
    const evidence = inputs.filter(({ task: sourceId, slot }) => isRuntimeEvidenceSlot(tasks.get(sourceId), slot));
    if (!evidence.length) continue;
    requireField(inputs.length <= 20 && new Set(inputs.map(({ task, slot }) => task + '/' + slot)).size === inputs.length,
      'Use distinct prerequisite inputs, up to 20 per step.');
    for (const { task: sourceId, slot } of evidence) {
      requireField(task.prerequisites.includes(sourceId), 'Runtime evidence must come from a direct prerequisite.');
      if (slot !== browserActivitySlot) continue;
      const source = tasks.get(sourceId);
      requireField(project.id === 'music-transcribe' && !source?.execution && source &&
        [source.profileId, ...(source.alternateProfiles ?? [])].every(id =>
          agentOrigins?.[id]?.musicBrowserProfile && agentOrigins[id].codexTools?.includes(musicBrowserTool)),
      'Attach the workspace browser to each agent assigned to “' + (source?.title ?? sourceId) + '” before routing browser activity.');
      requireField(!task.execution && [task.profileId, ...(task.alternateProfiles ?? [])].every(id => {
        const profile = agentOrigins?.[id];
        return Array.isArray(profile?.codexTools) &&
          (['read-only', 'workspace-write'].includes(profile.codexRuntime?.workspace) || profile.codexTools.includes('read_input'));
      }), 'Choose a workspace agent or attach Read input to each “' + task.title + '” agent to receive browser activity.');
    }
  }
}

export function validateWorkflowProject(project, agentOrigins) {
  if (project.id !== 'music-transcribe') return validateProject(project);
  validateRuntimeEvidenceRouting(project, agentOrigins);
  const tasks = new Map(project.tasks.map(task => [task.id, task]));
  // The shared project contract validates authored outputs. Runtime evidence
  // has its own validation above and independently satisfies the input requirement.
  return validateProject({ ...project, tasks: project.tasks.map(task => {
    const handoffInputs = (task.handoffInputs ?? []).filter(({ task: source, slot }) => !isRuntimeEvidenceSlot(tasks.get(source), slot));
    if (handoffInputs.length === (task.handoffInputs?.length ?? 0)) return task;
    if (task.inputs.length || handoffInputs.length) return { ...task, handoffInputs };
    const [input] = project.inputs;
    requireField(input && Array.isArray(task.permissions?.readPaths) && !task.permissions.readPaths.length,
      'Runtime evidence without a named input must not grant repository read paths.');
    return { ...task, handoffInputs, inputs: [input.id], permissions: { ...task.permissions, readPaths: [input.path] } };
  }) });
}

export function validateWorkflowImageRouting(project, agentOrigins) {
  const byId = new Map(project.tasks.map(task => [task.id, task]));
  for (const task of project.tasks) {
    const profiles = [task.profileId, ...(task.alternateProfiles ?? [])].map(id => agentOrigins?.[id]);
    const native = agentImagesEnabled(project.id) && profiles.every(profile => Array.isArray(profile?.codexTools));
    const outputs = task.outputs.map(workflowOutputSlot);
    const imageOutputs = outputs.filter(slot => slot.kind === 'image');
    const browserOutputs = outputs.filter(slot => isBrowserOutput(slot.kind));
    const imageInputs = (task.handoffInputs ?? []).filter(({ task: source, slot }) =>
      byId.get(source)?.outputs.map(workflowOutputSlot).some(output => output.id === slot && isImageOutput(output.kind)));
    if (imageOutputs.length) {
      requireField(native && !task.execution && task.responseMode === 'free-form' && profiles.every(profile => profile.codexRuntime?.imageGeneration),
        'Choose free-form replies and a Music Transcribe agent with image generation for “' + task.title + '”.');
    }
    if (browserOutputs.length) {
      requireField(native && !task.execution && task.responseMode === 'free-form' &&
        profiles.every(profile => profile.codexTools.includes(musicBrowserTool) && profile.musicBrowserProfile),
      'Choose free-form replies and a Music Transcribe agent with the workspace browser for “' + task.title + '”.');
    }
    requireField(outputs.filter(slot => isImageOutput(slot.kind)).length <= agentImageLimits.count,
      'A step can declare up to four image outputs.');
    if (imageInputs.length) {
      requireField(native, 'Choose a Music Transcribe Codex agent for “' + task.title + '” to receive image handoffs.');
      requireField(imageInputs.length <= agentImageLimits.count, 'A step can receive up to four image handoffs.');
    }
    requireField(task.receiveRequestImages === undefined || typeof task.receiveRequestImages === 'boolean',
      'Choose whether the step receives request images.');
    if (task.receiveRequestImages) requireField(agentImagesEnabled(project.id) && Array.isArray(agentOrigins?.[task.profileId]?.codexTools),
      'Choose a reusable Music Transcribe Codex agent for “' + task.title + '” to receive request images.');
    if (byId.get(task.codexHistoryFrom)?.receiveRequestImages)
      requireField(task.receiveRequestImages, 'Enable request images on “' + task.title + '” to copy Codex history from a step that receives them.');
  }
}
