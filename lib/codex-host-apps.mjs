import { readCodexAppServer } from './codex-app-server.mjs';

export const codexAppsServer = 'codex_apps';
export const validCodexAppId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(value);

function installedApps(result) {
  if (!Array.isArray(result?.apps)) return null;
  const apps = new Map();
  for (const row of result.apps) {
    if (!validCodexAppId(row?.id) || typeof row.enabled !== 'boolean' || typeof row.callable !== 'boolean' || apps.has(row.id)) return null;
    const name = typeof row.runtimeName === 'string' ? row.runtimeName.trim().slice(0, 200) : '';
    apps.set(row.id, { id: row.id, name: name || row.id, enabled: row.enabled, callable: row.callable });
  }
  return apps;
}

export async function codexHostAppCatalog(options) {
  const answer = await readCodexAppServer([
    ['app/installed', { forceRefresh: true }], ['config/read', { includeLayers: false }],
  ], options);
  if (!answer) return null;
  const apps = installedApps(answer[0]);
  const config = answer[1]?.config;
  if (!apps || !config || typeof config !== 'object') return null;
  const explicit = Object.keys(config.apps ?? {}).filter(id => id !== '_default');
  if (!explicit.every(validCodexAppId)) return null;
  return { apps, explicit };
}

export function enabledCodexApps(catalog, ids) {
  if (!catalog) throw new Error('Could not read connected apps from the Codex worker.');
  return ids.map(id => {
    if (!validCodexAppId(id)) throw new Error('Choose an app from the Codex worker.');
    const app = catalog.apps.get(id);
    if (!app?.enabled || !app.callable) throw new Error('Connected app ' + (app?.name ?? id) + ' is unavailable on the Codex worker.');
    return { id, name: app.name };
  });
}

export function codexAppArgs({ attached, disabled }) {
  return ['-c', 'apps._default.enabled=false',
    ...disabled.flatMap(id => ['-c', 'apps.' + id + '.enabled=false']),
    ...attached.flatMap(({ id }) => ['-c', 'apps.' + id + '.enabled=true'])];
}

export async function prepareCodexApps(ids, options) {
  const catalog = await codexHostAppCatalog(options);
  options?.signal?.throwIfAborted();
  const attached = enabledCodexApps(catalog, ids);
  const selected = new Set(ids);
  const disabled = [...new Set([...catalog.apps.keys(), ...catalog.explicit])].filter(id => !selected.has(id)).sort();
  const config = { attached, disabled };
  const answer = await readCodexAppServer([
    ['app/installed', { forceRefresh: true }],
    ['mcpServerStatus/list', { serverName: codexAppsServer, detail: 'toolsAndAuthOnly', limit: 1 }],
  ], { ...options, overrides: ['--enable', 'apps', ...codexAppArgs(config)] });
  options?.signal?.throwIfAborted();
  const scoped = installedApps(answer?.[0]);
  if (!scoped || ids.some(id => !scoped.get(id)?.callable || !scoped.get(id)?.enabled) ||
      [...scoped.values()].some(app => app.callable && !selected.has(app.id)))
    throw new Error('Codex could not verify that only the selected connected apps are callable.');
  const inventory = answer?.[1];
  const server = Array.isArray(inventory?.data) && inventory.data.find(row => row.name === codexAppsServer);
  if (!server || inventory.nextCursor || !server.tools || server.toolsError)
    throw new Error('Could not read the selected connected app tools from Codex.');
  const tools = new Map();
  for (const [name, tool] of Object.entries(server.tools)) {
    const appId = tool?._meta?.connector_id;
    if (typeof tool?.name === 'string' && tool.name === name && selected.has(appId)) tools.set(name, appId);
  }
  const covered = new Set(tools.values());
  if (ids.some(id => !covered.has(id))) throw new Error('Codex did not report tools for every selected connected app.');
  return { config, tools };
}
