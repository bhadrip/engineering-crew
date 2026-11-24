import { readCodexAppServer } from './codex-app-server.mjs';
import { codexHostEnvironment, codexHostMcpCatalog, referencedMcpEnvironment } from './codex-host-mcp.mjs';
import { projectMcpArgs } from './feature-codex-command.mjs';
import { resolveProjectMcpServers } from './project-mcp.mjs';

export async function checkProjectMcp(connection, { signal } = {}) {
  const env = codexHostEnvironment();
  const host = await codexHostMcpCatalog({ env, signal });
  if (!host) return { state: 'worker-unavailable' };
  if (connection.oauth && host.has(connection.server)) return { state: 'name-conflict' };
  const [configured] = resolveProjectMcpServers([connection], new Set(host.keys()));
  const { server, settings } = configured;
  const missingEnv = [];
  for (const name of referencedMcpEnvironment(settings)) {
    if (process.env[name] === undefined) missingEnv.push(name);
    else env[name] = process.env[name];
  }
  const overrides = ['--disable', 'apps',
    ...[...host.keys()].flatMap(name => ['-c', 'mcp_servers.' + name + '.enabled=false']),
    ...projectMcpArgs([configured])];
  const answer = await readCodexAppServer([
    ['mcpServerStatus/list', { serverName: server, detail: 'toolsAndAuthOnly', limit: 1 }],
  ], { env, signal, overrides, clientName: 'engineering_crew_mcp_check' });
  const catalog = answer?.[0];
  const status = Array.isArray(catalog?.data) && catalog.data.find(row => row.name === server);
  const result = { missingEnv, server, authStatus: status?.authStatus };
  if (status?.authStatus === 'notLoggedIn' || status?.runtimeStatus === 'authenticationRequired')
    return { ...result, state: 'sign-in-required' };
  if (!status?.tools || catalog.nextCursor || status.toolsError || status.runtimeStatus === 'failed')
    return { ...result, state: 'discovery-failed' };
  const allowed = new Set(settings.enabled_tools ?? []);
  const denied = new Set(settings.disabled_tools ?? []);
  const discovered = Object.entries(status.tools).filter(([name, tool]) => name && tool?.name === name).map(([name]) => name).sort();
  const tools = discovered.filter(name => (!allowed.size || allowed.has(name)) && !denied.has(name)).map(name => ({
    name, approval: settings.tools?.[name]?.approval_mode ?? settings.default_tools_approval_mode,
  }));
  return { ...result, state: 'checked', tools };
}
