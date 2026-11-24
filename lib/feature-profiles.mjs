import { createHash } from 'node:crypto';
import { imageName } from './feature-app.mjs';
import { CrewError } from './contracts.mjs';

const roleTools = {
  planner: ['list', 'read'],
  engineer: ['read', 'edit', 'test', 'finish'],
  reviewer: ['list', 'read'],
  security: ['list', 'read'],
  qa: ['list', 'read', 'author-tests', 'independent-tests', 'preview-health', 'operator-acceptance'],
};
const allowedFields = ['id', 'model', 'instructions', 'workerImage', 'access', 'reasoningEffort', 'skills', 'extraTools'];
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export const reasoningEfforts = Object.freeze(['minimal', 'low', 'medium', 'high', 'xhigh']);
export const skillLimits = Object.freeze({ count: 6, name: 80, bytes: 16_384 });
export const optionalRoleTools = Object.freeze({
  'git-history': { label: 'Git history', description: 'Include the IDs and subjects of the latest eight commits.' },
  'git-changes': { label: 'Latest commit files', description: 'Include eligible project paths changed in the latest commit.' },
});

export function validateSkillAttachments(skills) {
  if (!Array.isArray(skills) || skills.length > skillLimits.count)
    throw new CrewError(`Attach up to ${skillLimits.count} skills per role.`, 2);
  const names = new Set();
  return skills.map(skill => {
    if (!plainObject(skill) || Object.keys(skill).some(key => !['name', 'content'].includes(key)) ||
      typeof skill.name !== 'string' || !skill.name.trim() || skill.name.length > skillLimits.name || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(skill.name))
      throw new CrewError(`Give each skill a name of up to ${skillLimits.name} characters on one line.`, 2);
    if (typeof skill.content !== 'string' || !skill.content.trim() || skill.content.includes('\0') ||
      Buffer.byteLength(skill.content) > skillLimits.bytes)
      throw new CrewError(`Each skill needs Markdown text of up to ${skillLimits.bytes / 1024} KiB.`, 2);
    const name = skill.name.trim();
    if (names.has(name.toLowerCase())) throw new CrewError('Give each attached skill a unique name.', 2);
    names.add(name.toLowerCase());
    return Object.freeze({ name, content: skill.content });
  });
}

export function skillRecords(skills = []) {
  return skills.map(({ name, content }) => ({ name, sha256: createHash('sha256').update(content).digest('hex') }));
}

export const featureRoleIds = Object.freeze(Object.keys(roleTools));
export const agentNameLimit = 80;
const namedAgentId = /^agent-[a-f0-9]{32}$/;
export const validAgentName = name => typeof name === 'string' && Boolean(name.trim()) &&
  name.length <= agentNameLimit && !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(name);

function resolveRoleProfile(role, item, { model, agentImage, verifyApp }, name) {
  const defaults = roleTools[role];
  if (!plainObject(item)) throw new Error('Expected an object for role ' + role);
  for (const key of Object.keys(item)) {
    if (!allowedFields.includes(key)) throw new Error('Unsupported profile field ' + role + '.' + key);
  }
  const id = Object.hasOwn(item, 'id') ? item.id : role;
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(id)) throw new Error('Invalid profile ID for ' + role);
  const selectedModel = Object.hasOwn(item, 'model') ? item.model : model;
  if ((Object.hasOwn(item, 'model') || selectedModel != null) && (typeof selectedModel !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/.test(selectedModel))) throw new CrewError('Invalid Codex model for ' + role, 2);
  const instructions = Object.hasOwn(item, 'instructions') ? item.instructions : '';
  if (typeof instructions !== 'string' || instructions.includes('\0') || instructions.length > 8000)
    throw new CrewError('Invalid role instructions for ' + role + '. Use up to 8,000 characters without null bytes.', 2);
  const access = Object.hasOwn(item, 'access') ? item.access : role === 'engineer' ? 'workspace-write' : 'read-only';
  if (access !== 'read-only' && (role !== 'engineer' || access !== 'workspace-write')) throw new Error('Unsupported workspace access for ' + role);
  let workerImage;
  try { workerImage = imageName(Object.hasOwn(item, 'workerImage') ? item.workerImage : agentImage); }
  catch { throw new CrewError('Use a valid locally installed Docker image name for ' + role + '.', 2); }
  const effort = Object.hasOwn(item, 'reasoningEffort') ? item.reasoningEffort : 'medium';
  if (!reasoningEfforts.includes(effort)) throw new CrewError('Choose a supported reasoning effort for ' + role + '.', 2);
  const skills = Object.hasOwn(item, 'skills') ? validateSkillAttachments(item.skills) : [];
  const extraTools = Object.hasOwn(item, 'extraTools') ? item.extraTools : [];
  if (!Array.isArray(extraTools) || extraTools.some(tool => typeof tool !== 'string' || !Object.hasOwn(optionalRoleTools, tool)) ||
    new Set(extraTools).size !== extraTools.length) throw new CrewError('Choose available tools once per role.', 2);
  const tools = defaults.filter(tool => (tool !== 'operator-acceptance' || Boolean(verifyApp)) && (tool !== 'edit' || access === 'workspace-write'));
  const config = { role, id, ...(name && { name }), model: selectedModel ?? null, modelSource: selectedModel ? 'configured' : 'codex-default',
    instructions, workerImage, access, tools, network: 'none',
    ...(effort !== 'medium' && { reasoningEffort: effort }),
    ...(skills.length && { skills: Object.freeze(skills) }),
    ...(extraTools.length && { extraTools: Object.freeze([...extraTools]) }),
  };
  return Object.freeze({ ...config, digest: createHash('sha256').update(JSON.stringify(config)).digest('hex') });
}

export function resolveRoleProfiles(roles = {}, options) {
  if (!plainObject(roles)) throw new Error('Project roles must be a JSON object');
  for (const role of Object.keys(roles)) {
    if (!Object.hasOwn(roleTools, role)) throw new Error('Unknown project role ' + role);
  }
  return Object.fromEntries(featureRoleIds.map(role =>
    [role, resolveRoleProfile(role, Object.hasOwn(roles, role) ? roles[role] : {}, options)]));
}

export function resolveProjectAgents({ roles, agents = {}, activeAgents = {} }, options) {
  if (!plainObject(agents) || !plainObject(activeAgents)) throw new Error('Expected project agents and role assignments as JSON objects');
  const baseProfiles = resolveRoleProfiles(roles, options);
  const namedProfiles = Object.fromEntries(Object.entries(agents).map(([id, agent]) => {
    if (!namedAgentId.test(id) || !plainObject(agent) || !Object.hasOwn(roleTools, agent.role) ||
      !validAgentName(agent.name) || !plainObject(agent.settings ?? {})) throw new Error('Invalid named agent ' + id);
    const profile = resolveRoleProfile(agent.role, { ...agent.settings, id }, options, agent.name.trim());
    return [id, profile];
  }));
  const profiles = { ...baseProfiles };
  for (const [role, id] of Object.entries(activeAgents)) {
    if (!Object.hasOwn(roleTools, role) || !Object.hasOwn(namedProfiles, id) || namedProfiles[id].role !== role)
      throw new Error('Invalid active agent for ' + role);
    profiles[role] = namedProfiles[id];
  }
  return { profiles, baseProfiles, namedProfiles };
}
