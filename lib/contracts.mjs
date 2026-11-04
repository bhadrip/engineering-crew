export class CrewError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

export function requireField(condition, message) {
  if (!condition) throw new CrewError(message);
}

export function id(value, label) {
  requireField(typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value), `Invalid ${label}`);
  return value;
}

export function text(value, label, limit = 20_000) {
  requireField(typeof value === 'string' && value.trim() && value.length <= limit, `Invalid ${label}`);
  return value;
}

function list(value, label, limit = 20) {
  requireField(Array.isArray(value) && value.length <= limit, `Invalid ${label}`);
  return value;
}

function integer(value, label, maximum) {
  requireField(Number.isInteger(value) && value >= 1 && value <= maximum, `Invalid ${label}`);
}

export function repoPath(value) {
  text(value, 'Git path', 500);
  requireField(value.split('/').every(part => /^[\w.-]+$/.test(part) && !['.', '..', '.git'].includes(part)),
    `Invalid Git path: ${value}`);
  return value;
}

export function uniqueBy(items, field, label) {
  requireField(new Set(items.map(item => item[field])).size === items.length, `Duplicate ${label}`);
}

export function validateProject(project) {
  requireField(project?.schemaVersion === 1, 'Expected project schemaVersion 1');
  id(project.id, 'project ID');
  text(project.name, 'project name', 120);
  text(project.crewName, 'crew display name', 120);
  id(project.epic?.id, 'epic ID');
  text(project.epic.title, 'epic title', 120);
  text(project.epic.goal, 'epic goal', 1_000);
  requireField(project.runtime?.kind === 'codex', 'The first slice supports the Codex runtime');
  if (project.runtime.model !== undefined) text(project.runtime.model, 'model', 120);
  for (const input of list(project.inputs, 'project inputs')) {
    id(input?.id, 'input ID');
    text(input.title, 'input title', 120);
    repoPath(input.path);
  }
  uniqueBy(project.inputs, 'id', 'input ID');

  for (const profile of list(project.profiles, 'profiles')) {
    id(profile?.id, 'profile ID');
    integer(profile.revision, 'profile revision', 10_000);
    text(profile.name, 'profile name', 120);
    text(profile.remit, 'profile remit', 1_000);
    repoPath(profile.instructions);
    list(profile.skills, 'profile skills').forEach(repoPath);
    requireField(Array.isArray(profile.tools) && profile.tools.length === 0,
      `Profile ${profile.id} requests tools. This slice supports input-only profiles.`);
  }
  uniqueBy(project.profiles, 'id', 'profile ID');

  requireField(list(project.tasks, 'tasks').length, 'At least one task is required');
  for (const task of project.tasks) validateTask(task, project);
  uniqueBy(project.tasks, 'id', 'task ID');
  const visited = new Set();
  function visit(task, stack = []) {
    requireField(!stack.includes(task.id), `Handoff cycle involving ${task.id}`);
    if (visited.has(task.id)) return;
    for (const prerequisite of task.prerequisites) visit(project.tasks.find(value => value.id === prerequisite), [...stack, task.id]);
    visited.add(task.id);
  }
  for (const task of project.tasks) visit(task);
  requireField(project.inputs.length + project.tasks.length + project.profiles.length <= 40, 'Project is too large for one pilot run');
  return project;
}

function validateTask(task, project) {
  id(task?.id, 'task ID');
  id(task.profileId, 'task profile ID');
  requireField(project.profiles.some(profile => profile.id === task.profileId), `Unknown task profile: ${task.profileId}`);
  integer(task.revision, 'packet revision', 10_000);
  text(task.title, 'task title', 120);
  text(task.objective, 'task objective', 2_000);
  text(task.acceptedBy, 'decision owner', 120);
  list(task.criteria, 'criterion IDs').forEach(criterion => text(criterion, 'criterion ID', 80));
  list(task.prerequisites, 'prerequisites').forEach(prerequisite => {
    requireField(project.tasks.some(value => value?.id === prerequisite), `Unknown prerequisite: ${prerequisite}`);
  });
  list(task.handoffInputs ?? [], 'handoff inputs').forEach(input => {
    requireField(task.prerequisites.includes(input?.task), 'Handoff input must name a direct prerequisite');
    const producer = project.tasks.find(value => value.id === input.task);
    requireField(producer.outputs?.some(slot => slot.id === input.slot && slot.required) ||
      (producer.execution && input.slot === 'check-receipt') ||
      (producer.execution?.kind === 'build' && ['candidate', 'candidate-diff'].includes(input.slot)),
    'Handoff input must name a required output or runner artifact');
  });
  requireField(list(task.inputs, 'task inputs').length || task.handoffInputs?.length, 'A task must name an input');
  for (const inputId of task.inputs) {
    requireField(project.inputs.some(input => input.id === inputId), `Unknown task input: ${inputId}`);
  }
  requireField(list(task.outputs, 'output slots', 6).length, 'A task must name an output');
  for (const slot of task.outputs) {
    id(slot?.id, 'slot ID');
    requireField(['markdown', 'source', 'check-cases'].includes(slot.kind) && typeof slot.required === 'boolean', 'Invalid output slot kind or required flag');
    if (slot.kind === 'source') repoPath(slot.path);
    text(slot.acceptance, 'output acceptance', 1_000);
  }
  uniqueBy(task.outputs, 'id', 'output slot');
  requireField(!task.outputs.some(slot => ['candidate', 'candidate-diff', 'check-receipt'].includes(slot.id)), 'Output slot collides with runner evidence');
  const sourceSlots = task.outputs.filter(slot => slot.kind === 'source');
  const checkSlots = task.outputs.filter(slot => slot.kind === 'check-cases');
  if (task.execution) {
    const execution = task.execution;
    requireField(['build', 'verify'].includes(execution.kind), 'Unknown execution kind');
    requireField(/^node@sha256:[a-f0-9]{64}$/.test(execution.image), 'Execution needs a pinned Node Docker image');
    list(execution.files, 'execution files').forEach(repoPath);
    requireField(execution.files.includes(repoPath(execution.entry)), 'Execution entry must be in its file allowlist');
    if (execution.kind === 'build') {
      requireField(sourceSlots.length && sourceSlots.every(slot => slot.required && execution.files.includes(slot.path)) && !checkSlots.length,
        'Build requires source slots within the execution file allowlist');
      uniqueBy(sourceSlots, 'path', 'source path');
      requireField(execution.files.includes(repoPath(execution.tests)), 'Author test file must be in its file allowlist');
    } else {
      requireField(!sourceSlots.length && checkSlots.length === 1 && checkSlots[0].required, 'Verification requires one check-cases output');
      const builder = project.tasks.find(value => value.id === execution.candidateFrom);
      requireField(task.prerequisites.includes(execution.candidateFrom) && builder?.execution?.kind === 'build', 'Verification requires an accepted build');
      requireField(builder.execution.entry === execution.entry && builder.execution.image === execution.image &&
        execution.files.every(path => builder.execution.files.includes(path)), 'QA must use the build entry, image, and allowed source files');
    }
  } else requireField(!sourceSlots.length && !checkSlots.length, 'Executable outputs require a runner');
  integer(task.budget?.targetTotalTokens, 'token target', 1_000_000);
  integer(task.budget?.timeoutSeconds, 'timeout in seconds', 600);
  integer(task.budget?.maxAttempts, 'attempt limit', 5);

  const policy = task.permissions;
  requireField(policy?.mode === 'read-only' && policy.toolNetwork === 'denied' &&
    ['tools', 'writePaths', 'externalActions'].every(key => Array.isArray(policy[key]) && !policy[key].length),
  `Task ${task.id} must use input-only permissions with no writes, tools, or external actions`);
  list(policy.readPaths, 'read paths').forEach(repoPath);
  const paths = task.inputs.map(inputId => project.inputs.find(input => input.id === inputId).path);
  requireField(new Set(paths).size === policy.readPaths.length && paths.every(path => policy.readPaths.includes(path)),
    'Read paths must match the named task inputs exactly');
}

const string = { type: 'string' };
const strings = { type: 'array', items: string };
function shape(properties) {
  return { type: 'object', additionalProperties: false, required: Object.keys(properties), properties };
}

export const responseSchema = shape({
  state: { type: 'string', enum: ['completed', 'blocked', 'failed'] },
  summary: string,
  outputs: { type: 'array', items: shape({ slot: string, content: string }) },
  decisions: strings,
  questions: strings,
  blockers: strings,
});

export function validateResponse(response, task) {
  requireField(responseSchema.properties.state.enum.includes(response?.state), 'Invalid result state');
  text(response.summary, 'result summary', 2_000);
  for (const key of ['decisions', 'questions', 'blockers']) {
    list(response[key], key).forEach(value => text(value, key, 2_000));
  }
  for (const output of list(response.outputs, 'returned outputs', 6)) {
    requireField(task.outputs.some(slot => slot.id === output?.slot), `Undeclared output slot: ${output?.slot}`);
    text(output.content, 'output content');
  }
  uniqueBy(response.outputs, 'slot', 'returned slot');
  if (response.state === 'completed') {
    for (const slot of task.outputs.filter(slot => slot.required)) {
      requireField(response.outputs.some(output => output.slot === slot.id), `Missing required output: ${slot.id}`);
    }
  }
  return response;
}
