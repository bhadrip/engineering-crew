import { validateResponse } from '../../../lib/contracts.mjs';

export function grade(observation, task, rubric) {
  if (observation.outcome !== 'completed') return { pass: false, issues: [observation.outcome] };
  let result;
  try { result = validateResponse(observation.response, task); }
  catch (error) { return { pass: false, issues: [error.message] }; }

  const issues = [];
  if (result.state !== rubric.state) issues.push(`Expected ${rubric.state}; got ${result.state}`);
  const deliverable = result.outputs.map(output => output.content).join('\n');
  const all = [result.summary, ...result.decisions, ...result.questions, ...result.blockers, deliverable].join('\n');
  const fields = { all, deliverable };
  for (const [name, check] of Object.entries(rubric.checks)) {
    if (!check.all.every(pattern => new RegExp(pattern, 'i').test(fields[check.in]))) issues.push(name);
  }
  for (const pattern of rubric.forbid ?? []) {
    if (new RegExp(pattern, 'i').test(all)) issues.push('Leaked author-only implementation detail');
  }
  return { pass: issues.length === 0, issues };
}
