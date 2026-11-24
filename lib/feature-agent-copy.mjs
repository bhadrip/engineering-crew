import { createHash } from 'node:crypto';
import { CrewError } from './contracts.mjs';
import { featureRoleIds } from './feature-profiles.mjs';
import { rolePromptTemplate } from './feature-prompts.mjs';

const roles = {
  planner: ['Planner', 'Define implementation steps and acceptance checks.', rolePromptTemplate('planner').role],
  engineer: ['Engineer', 'Implement and verify the requested change.',
    'Inspect the supplied project context, implement the requested behavior, and run relevant available checks. Preserve unrelated behavior and report the changes and observed results.'],
  reviewer: ['Code reviewer', 'Review implementation for correctness and regressions.',
    'Review the supplied implementation against the request and acceptance criteria. Report blocking findings with concrete file or function evidence, then describe any checks you performed.'],
  security: ['Security reviewer', 'Review changes for security issues in intended operation.',
    'Review the supplied source and evidence for vulnerabilities in intended use. Prioritize trust boundaries, upload handling, file access, process invocation, and stored data. Cite concrete evidence and give remediation for each finding.'],
  qa: ['QA agent', 'Prepare and run independent acceptance checks.',
    'Use the supplied acceptance criteria to prepare independent, executable checks for the expected behavior and failure paths. Run the checks when the available tools and inputs permit, and distinguish proposed checks from observed results.'],
};

function describeFeatureSource(role, key, profile, active) {
  const [label, remit, assignment] = roles[role];
  return { role, key, profile, active, label, name: profile.name ?? label, remit, assignment };
}

export function featureAgentSources(settings) {
  if (!settings) return [];
  const active = featureRoleIds.map(role => describeFeatureSource(role, settings.activeAgents[role] ?? 'default', settings.profiles[role], true));
  const named = Object.entries(settings.agents).flatMap(([key, { profile }]) => settings.activeAgents[profile.role] === key ? [] :
    [describeFeatureSource(profile.role, key, profile, false)]);
  return [...active, ...named];
}

export function featureAgentCopy(settings, role, key) {
  const profile = featureRoleIds.includes(role) && (key === 'default' ? settings?.baseProfiles[role] : settings?.agents[key]?.profile);
  if (!profile || profile.role !== role) throw new CrewError('This Feature agent is unavailable for the selected role.', 4);
  const source = describeFeatureSource(role, key, profile, settings.activeAgents[role] === key ||
    (key === 'default' && !settings.activeAgents[role]));
  const origin = { role, key, profileId: profile.id, digest: profile.digest };
  const id = 'agent-' + createHash('sha256').update(JSON.stringify([settings.projectId, origin])).digest('hex').slice(0, 32);
  const draft = {
    name: source.name, remit: source.remit, expectedVersion: 0, model: profile.model ?? '',
    instructions: [source.assignment, profile.instructions].filter(Boolean).join('\n\n'), skills: profile.skills ?? [],
    tools: [...(profile.tools.includes('list') ? ['list_inputs'] : []), ...(profile.tools.includes('read') ? ['read_input'] : [])],
    runtime: { workspace: profile.access, webSearch: 'disabled', reasoningEffort: profile.reasoningEffort ?? 'medium' },
  };
  return { id, origin, source, draft };
}
