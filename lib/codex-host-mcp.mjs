import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';

const run = promisify(execFile);
const serverName = /^[A-Za-z0-9_-]+$/;
const envName = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const validCodexServerName = name => typeof name === 'string' && serverName.test(name);

export const codexHostEnvironment = () => Object.fromEntries(
  ['PATH', 'HOME', 'CODEX_HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL']
    .filter(key => process.env[key]).map(key => [key, process.env[key]]),
);

export function referencedMcpEnvironment(transport) {
  const stdio = Array.isArray(transport.env_vars) ? transport.env_vars : [];
  return [...new Set([
    ...stdio.filter(entry => typeof entry === 'string' || entry?.source === 'local' || entry?.source === undefined)
      .map(entry => typeof entry === 'string' ? entry : entry?.name),
    transport.bearer_token_env_var, ...Object.values(transport.env_http_headers ?? {}),
  ].filter(name => typeof name === 'string' && envName.test(name)))];
}

// Codex reads its own host settings and returns the catalog without calling a
// tool. Retain only metadata and references to environment variables.
export async function codexHostMcpCatalog({ cwd = tmpdir(), signal, env = codexHostEnvironment(), plugins, overrides = [] } = {}) {
  try {
    const flags = plugins ? ['--enable', 'plugins', '--disable', 'remote_plugin', '-c', plugins] : ['--disable', 'plugins'];
    const { stdout } = await run('codex', ['mcp', 'list', '--json', ...flags, ...overrides], {
      cwd, env, signal, timeout: 4_000, maxBuffer: 2_000_000,
    });
    const entries = JSON.parse(stdout);
    if (!Array.isArray(entries)) return null;
    const servers = new Map();
    for (const entry of entries) {
      if (!validCodexServerName(entry?.name) || typeof entry.enabled !== 'boolean' ||
          !entry.transport || servers.has(entry.name)) return null;
      servers.set(entry.name, { name: entry.name, enabled: entry.enabled, transport: entry.transport.type,
        authStatus: entry.auth_status, envNames: referencedMcpEnvironment(entry.transport) });
    }
    return servers;
  } catch { return null; }
}

export function enabledCodexServers(catalog, names) {
  if (!catalog) throw new Error('Could not read the Codex host MCP catalog.');
  return names.map(name => {
    if (!validCodexServerName(name)) throw new Error('Choose a server from the Codex host catalog.');
    const server = catalog.get(name);
    if (!server?.enabled) throw new Error('Attached Codex MCP server ' + name + ' is unavailable on this host.');
    return server;
  });
}
