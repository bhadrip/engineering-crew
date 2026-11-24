import { join } from 'node:path';
import { codexAppsServer } from './codex-host-apps.mjs';

const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_.:/-]{1,160}$/.test(value) ? value : undefined;

export function codexRuntimeRequest(config) {
  return {
    model: config.requestedModel,
    reasoningEffort: config.reasoningEffort,
    serviceTier: config.serviceTier ?? null,
    workspace: config.nativeWorkspace ?? 'tools',
    approval: config.approval,
    webSearch: config.webSearch,
    persistentHistory: !config.ephemeral,
    flags: Object.fromEntries([...(config.disabledFeatures ?? []).map(name => [name, false]),
      ...(config.enabledFeatures ?? []).map(name => [name, true])]),
    servers: [
      ...(config.mcp ? [{ id: config.mcp.name, name: 'Crew tools' }] : []),
      ...(config.hostMcp?.attached ?? []).map(id => ({ id, name: id })),
      ...(config.hostPlugins?.mcpServers ?? []).map(id => ({ id, name: id })),
      ...(config.hostApps ? [{ id: codexAppsServer, name: 'Connected Codex apps' }] : []),
      ...(config.projectMcp ?? []).map(({ server, name, version }) => ({ id: server, name, version })),
    ],
  };
}

export function codexThreadReport(started, verified) {
  return {
    verified,
    model: identifier(started.model),
    modelProvider: identifier(started.modelProvider),
    reasoningEffort: identifier(started.reasoningEffort),
    sandbox: identifier(started.sandbox?.type),
    permissionProfile: identifier(started.activePermissionProfile?.id),
    approval: identifier(started.approvalPolicy),
    persistentHistory: typeof started.thread?.ephemeral === 'boolean' ? !started.thread.ephemeral : undefined,
  };
}

export function codexFlagReport(result, names) {
  if (!Array.isArray(result?.data)) return null;
  return Object.fromEntries(result.data.filter(row => names.has(row?.name) && typeof row.enabled === 'boolean')
    .map(({ name, enabled }) => [name, enabled]));
}

export function codexSkillReport(result, cwd, paths) {
  const catalog = Array.isArray(result?.data) && result.data.find(row => row?.cwd === cwd)?.skills;
  if (!Array.isArray(catalog)) return null;
  return paths.map((manifestPath, index) => {
    const skill = catalog.find(row => row?.path === join(cwd, manifestPath));
    return { number: index + 1, ...(skill && { name: identifier(skill.name) }),
      state: !skill ? 'unlisted' : skill.enabled === true ? 'available' : skill.enabled === false ? 'disabled' : 'unreported' };
  });
}

export function codexMcpReport(result, id) {
  if (!Array.isArray(result?.data)) return { id, state: 'unreported' };
  const row = result.data.find(row => row?.name === id);
  if (!row) return { id, state: 'unlisted' };
  const state = row.authStatus === 'notLoggedIn' ? 'authenticationRequired' :
    ['notStarted', 'starting', 'connected', 'authenticationRequired', 'failed', 'cancelled', 'disabled'].includes(row.runtimeStatus)
      ? row.runtimeStatus : 'unreported';
  const names = row.tools && typeof row.tools === 'object' ?
    Object.entries(row.tools).filter(([key, tool]) => identifier(key) && tool?.name === key).map(([key]) => key).sort() : [];
  return { id, state, ...(row.toolsError ? { discoveryFailed: true } :
    row.tools && typeof row.tools === 'object' ? { tools: names.slice(0, 80), toolCount: names.length } : {}) };
}

export function codexObservedTools(calls = []) {
  const tools = new Map();
  for (const { server, tool, status } of calls) {
    if (typeof server !== 'string' || typeof tool !== 'string') continue;
    const key = JSON.stringify([server, tool]);
    if (!tools.has(key)) tools.set(key, { server, tool, statuses: {} });
    const { statuses } = tools.get(key);
    const state = ['running', 'completed', 'failed', 'declined'].includes(status) ? status : 'incomplete';
    statuses[state] = (statuses[state] ?? 0) + 1;
  }
  return [...tools.values()];
}
