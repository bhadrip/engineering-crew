const roles = {
  planner: 'Planner', engineer: 'Engineer', qa: 'QA agent', reviewer: 'Code reviewer',
  security: 'Security reviewer', controller: 'Crew controller',
};
const actions = {
  intake: 'Receive request', plan: 'Plan the work', qa: 'Run QA tests', reviewer: 'Review code',
  security: 'Check security', repair: 'Request changes', verify: 'Verify build', promote: 'Deliver build',
  preview: 'Start local preview',
};
const agentTasks = { planner: 'plan', engineer: 'build', qa: 'qa', reviewer: 'reviewer', security: 'security' };

export const featureRole = role => Object.hasOwn(roles, role) ? roles[role] : role;
export const buildName = attempt => attempt > 1 ? 'repair ' + (attempt - 1) : 'the first build';
export function featureAction(action, attempt = 1) {
  if (action === 'build') return attempt > 1 ? 'Attempt ' + buildName(attempt) : 'Build first version';
  return Object.hasOwn(actions, action) ? actions[action] : action;
}

export function featureTaskAction({ role, phase, attempt }) {
  return featureAction(Object.hasOwn(agentTasks, role) ? agentTasks[role] : phase, attempt);
}
