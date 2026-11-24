import { isDeepStrictEqual } from 'node:util';
import { artifactDigest } from './run-store.mjs';
import { workflowResponseModes } from './workflow-policy.mjs';

const labels = {
  acceptedBy: 'Decision owner', agent: 'Assigned agent', apps: 'Connected Codex apps', approvalMode: 'Codex approvals',
  budget: 'Execution budget', codexHistoryFrom: 'Codex conversation source', crewName: 'Crew name', dispatchMode: 'Dispatch mode',
  handoffInputs: 'Artifact handoffs', hostHooks: 'Trusted worker hooks', invokeSkills: 'Explicit skill inputs',
  joinPrerequisites: 'Branch joins', liveSession: 'Live workflow controls', mcpServers: 'Worker MCP servers', pluginEnv: 'Plugin environment variables',
  projectMcp: 'Project MCP connections', remit: 'Responsibilities', runWhen: 'Run condition', shared: 'Shared with other projects',
  responseMode: 'Codex response mode', outputFollowUps: 'Missing output follow-up turns',
  saveThread: 'Save Codex thread history', sourceCommit: 'Git source revision', workspaceSource: 'Workspace source',
};

function settings(values) {
  return Object.entries(values).map(([key, value]) => ({ key, label: labels[key] ?? key.replace(/[A-Z]/g, letter => ' ' + letter.toLowerCase())
    .replace(/^./, letter => letter.toUpperCase()), value }));
}

function fileSummary({ data, mode }) {
  const bytes = Buffer.from(data, 'base64');
  return { bytes: bytes.length, sha256: artifactDigest(bytes), ...(mode && { mode }) };
}

const row = (key, label, value) => ({ key, label, value });
const section = (key, title, rows) => ({ key, title, rows });

function agentSections({ definition }) {
  const { runtime = {}, tools = [], skills = [], projectSkills = [], projectMcp = [], ...general } = definition;
  const native = { liveSession: false, saveThread: false, imageInspection: false, imageGeneration: false, commandEvidence: false, repositoryInstructions: false,
    hostHooks: false, approvalMode: 'never', serviceTier: '', ...runtime };
  return [
    section('agent', 'Agent settings', settings(general)),
    section('runtime', 'Codex runtime', settings(native)),
    section('tools', 'Tools', [row('built-ins', 'Crew tools', tools), row('project-mcp', 'Project MCP connection versions', projectMcp)]),
    section('skill-order', 'Skill order', [row('order', 'Attached skill order', [...skills.map(({ name }) => name),
      ...projectSkills.map(({ definition }) => definition.name)])]),
    ...skills.map(skill => skillSection('attached:' + skill.name, skill)),
    ...projectSkills.map(({ id, version, definition }) => skillSection('project:' + id, definition, { id, version })),
  ];
}

function skillSection(key, skill, reference) {
  return section(key, 'Skill · ' + skill.name, [
    ...(reference ? [row('version', 'Project skill version', reference)] : []),
    row('name', 'Skill name', skill.name), row('instructions', 'Instructions', skill.content),
    ...(skill.bundle ? [row('directory', 'Skill folder', skill.bundle.directory)] : []),
    ...((skill.bundle?.files ?? []).map(file => row('file:' + file.path, file.path, fileSummary(file)))),
  ]);
}

function workflowSections(snapshot) {
  if (!snapshot) return [];
  const { project, sourceCommit, workspaceBaseline, sourceFiles = {}, skillAssets = {}, agentOrigins = {}, files, inputOverrides } = snapshot;
  const { epic, tasks, profiles, inputs, id: _projectId, schemaVersion: _schemaVersion, ...general } = project;
  const { id: _epicId, ...epicFields } = epic;
  const overrides = new Map(inputOverrides);
  const byProfile = new Map(profiles.map(profile => [profile.id, profile]));
  const inputSpecs = [];
  for (const input of inputs) {
    inputSpecs.push(row(input.id, input.title, { id: input.id, title: input.title, path: input.path }),
      row('content:' + input.id, input.title + ' · content', overrides.get(input.id) ?? files.get(input.path)));
  }
  const inputPaths = new Set(inputs.map(input => input.path));
  return [
    section('workflow', 'Workflow settings', settings({ ...epicFields, sourceCommit, ...general,
      stepOrder: tasks.map(task => task.id) })),
    section('inputs', 'Workflow inputs', inputSpecs),
    ...tasks.map(({ id, revision: _revision, profileId, responseMode = 'structured', outputFollowUps = 0, ...task }) => {
      const profile = byProfile.get(profileId);
      const origin = agentOrigins[profileId];
      const agent = { name: profile?.name ?? profileId, version: origin?.version ?? profile?.revision,
        ...(origin?.agentId ? { id: origin.agentId } : { id: profileId }) };
      return section('step:' + id, 'Step · ' + task.title, settings({ ...task, agent, responseMode: workflowResponseModes[responseMode], outputFollowUps }));
    }),
    section('profiles', 'Pinned agent definitions', profiles.map(profile => row(profile.id, profile.name + ' · v' + profile.revision,
      { ...profile, ...(agentOrigins[profile.id] && { settings: agentOrigins[profile.id] }) }))),
    section('workspace', 'Pinned workspace files', [
      ...(workspaceBaseline ? [row('revision', 'Workspace Git revision', workspaceBaseline.commit)] : []),
      ...(workspaceBaseline?.files ?? []).map(file => row('file:' + file.path, file.path, fileSummary(file))),
    ]),
    section('files', 'Pinned configuration files', [
      ...[...files].filter(([path]) => !inputPaths.has(path)).map(([path, content]) => row('file:' + path, path, content)),
      ...Object.entries(sourceFiles).map(([path, { content, mode }]) => row('source:' + path, path, { sha256: artifactDigest(content), mode })),
      ...Object.entries(skillAssets).map(([path, data]) => row('skill:' + path, path, fileSummary({ data }))),
    ]),
  ];
}

function comparisons(left, right, compare) {
  const before = new Map(left.map(item => [item.key, item]));
  const after = new Map(right.map(item => [item.key, item]));
  return [...new Set([...before.keys(), ...after.keys()])].flatMap(key => compare(before.get(key), after.get(key)) ?? []);
}

export function compareRevisions(kind, before, after) {
  const sections = kind === 'agent' ? agentSections : workflowSections;
  return comparisons(sections(before), sections(after), (left, right) => {
    const rows = comparisons(left?.rows ?? [], right?.rows ?? [], (old, current) => {
      if (isDeepStrictEqual(old?.value, current?.value)) return;
      return { label: current?.label ?? old.label, before: old?.value, after: current?.value };
    });
    if (rows.length) return { title: right?.title ?? left.title, rows };
  });
}
