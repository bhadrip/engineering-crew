import { execFile } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { codexHostEnvironment } from './codex-host-mcp.mjs';

const run = promisify(execFile);
const revision = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
export const validCodexPluginId = value => typeof value === 'string' &&
  /^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);

export function codexPluginOverride({ attached, disabled }) {
  const setting = (id, enabled) => JSON.stringify(id) + '={"enabled"=' + enabled + '}';
  return 'plugins={' + [...attached.map(({ id }) => setting(id, true)), ...disabled.map(id => setting(id, false))].join(',') + '}';
}

export async function codexHostPluginCatalog({ cwd = tmpdir(), env = codexHostEnvironment(), signal, includeAvailable = false } = {}) {
  try {
    const args = ['plugin', 'list', '--json', '--disable', 'remote_plugin', ...(includeAvailable ? ['--available'] : [])];
    const { stdout } = await run('codex', args, {
      cwd, env, signal, timeout: 4_000, maxBuffer: 4_000_000,
    });
    const { installed, available } = JSON.parse(stdout);
    if (!Array.isArray(installed) || (includeAvailable && !Array.isArray(available))) return null;
    const plugins = new Map();
    for (const entry of installed) {
      const id = entry?.pluginId;
      if (!validCodexPluginId(id) || typeof entry.enabled !== 'boolean' || plugins.has(id)) return null;
      const [name, marketplace] = id.split('@');
      const version = typeof entry.version === 'string' && revision.test(entry.version) ? entry.version : null;
      plugins.set(id, { id, name, marketplace, version, enabled: entry.enabled, supported: entry.source?.source !== 'remote' });
    }
    if (includeAvailable) for (const { pluginId } of available) {
      if (!validCodexPluginId(pluginId)) return null;
      if (!plugins.has(pluginId)) plugins.set(pluginId, { id: pluginId, enabled: false });
    }
    return plugins;
  } catch { return null; }
}

export function enabledCodexPlugins(catalog, ids) {
  if (!catalog) throw new Error('Could not read the Codex host plugin catalog.');
  return ids.map(id => {
    if (!validCodexPluginId(id)) throw new Error('Choose a plugin from the Codex host catalog.');
    const plugin = catalog.get(id);
    if (!plugin?.enabled || !plugin.supported) throw new Error('Attached Codex plugin ' + id + ' is unavailable on this host.');
    return plugin;
  });
}

export async function codexPluginReadPaths(plugins, env) {
  const cache = await realpath(join(env.CODEX_HOME || join(env.HOME || homedir(), '.codex'), 'plugins', 'cache')).catch(() => null);
  if (!cache) return [];
  const paths = await Promise.all(plugins.map(async ({ marketplace, name, version }) => {
    if (!version) return null;
    try {
      const root = await realpath(join(cache, marketplace, name, version));
      const location = relative(cache, root);
      const expected = join(marketplace, name);
      if (!location.startsWith(expected + sep) || !(await stat(root)).isDirectory()) return null;
      return root;
    } catch { return null; }
  }));
  return paths.filter(Boolean);
}
