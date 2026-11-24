import { isDeepStrictEqual } from 'node:util';
import { CrewError, requireField } from './contracts.mjs';
import { workflowOutputSlot } from './workflow-artifacts.mjs';

export const conditionOperators = Object.freeze({ equals: 'Equals', different: 'Does not equal', exists: 'Exists', missing: 'Is missing' });

export function conditionFromDraft(condition, output) {
  const { step, pointer, operator, value } = condition;
  const compare = operator === 'equals' || operator === 'different';
  let expected;
  if (compare) {
    try { expected = JSON.parse(value); }
    catch { throw new CrewError('Use valid JSON for the comparison value, including quotes around text.', 2); }
  }
  return { task: step, slot: output, pointer, operator, ...(compare && { expected }) };
}

export function validateWorkflowRouting(tasks) {
  for (const task of tasks) {
    const joins = task.joinPrerequisites ?? [];
    requireField(Array.isArray(joins) && new Set(joins).size === joins.length && joins.every(parent => task.prerequisites.includes(parent)),
      'Branch joins must refer to distinct prerequisites of “' + task.title + '”.');
    requireField(!joins.includes(task.codexHistoryFrom) && !joins.includes(task.execution?.candidateFrom),
      'A prerequisite that supplies Codex history or a build candidate must produce an accepted result.');
    const condition = task.runWhen;
    if (!condition) continue;
    const source = tasks.find(item => item.id === condition.task);
    const slot = source?.outputs.find(item => item.id === condition.slot);
    requireField(task.prerequisites.includes(condition.task) && !joins.includes(condition.task) &&
      slot?.required && workflowOutputSlot(slot).kind === 'json',
      'The run condition for “' + task.title + '” needs a required JSON output from a prerequisite with an accepted result.');
    requireField(typeof condition.pointer === 'string' && condition.pointer.length <= 512 &&
      (condition.pointer === '' || /^\/(?:[^~]|~[01])*$/.test(condition.pointer)), 'Use a JSON pointer such as /route or /lesson/tempo.');
    requireField(Object.hasOwn(conditionOperators, condition.operator), 'Choose a comparison for the run condition.');
    if (condition.operator === 'equals' || condition.operator === 'different')
      requireField(condition.expected !== undefined, 'Add a JSON comparison value.');
  }
}

export function evaluateWorkflowCondition(condition, content) {
  let actual = JSON.parse(content);
  for (const token of condition.pointer ? condition.pointer.slice(1).split('/') : []) {
    const key = token.replaceAll('~1', '/').replaceAll('~0', '~');
    if (actual === null || typeof actual !== 'object' || (Array.isArray(actual) && !/^(0|[1-9][0-9]*)$/.test(key)) ||
      !Object.hasOwn(actual, key)) {
      actual = undefined;
      break;
    }
    actual = actual[key];
  }
  const found = actual !== undefined;
  const equal = found && isDeepStrictEqual(actual, condition.expected);
  const matched = { equals: equal, different: !equal, exists: found, missing: !found }[condition.operator];
  return { matched, found, ...(found && { actual }) };
}
