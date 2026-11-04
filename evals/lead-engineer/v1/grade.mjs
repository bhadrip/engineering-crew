import { validateResponse } from '../../../lib/contracts.mjs';

export function grade(observation, task, rubric) {
  if (observation.outcome !== 'completed') return { pass: false, issues: [observation.outcome] };
  let result;
  try { result = validateResponse(observation.response, task); }
  catch (error) { return { pass: false, issues: [error.message] }; }

  const issues = [];
  if (result.state !== rubric.state) issues.push(`Expected ${rubric.state}; got ${result.state}`);
  if (result.state === 'completed' && result.blockers.length) issues.push('Completed response still claims blockers');
  const deliverable = result.outputs.find(output => output.slot === task.outputs[0].id)?.content;
  // A decision is useful only if the downstream artifact contains it.
  if (!deliverable) return { pass: false, issues: [...issues, 'Missing downstream artifact'] };
  for (const [label, anchors] of Object.entries(rubric.checks)) {
    if (!anchors.every(anchor => new RegExp(anchor, 'i').test(deliverable))) issues.push(label);
  }
  return { pass: issues.length === 0, issues };
}
