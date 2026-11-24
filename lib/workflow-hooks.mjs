import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { isDeepStrictEqual } from 'node:util';
import { codexHostEnvironment } from './codex-host-mcp.mjs';
import { codexToml } from './codex-toml.mjs';
import { CrewError } from './contracts.mjs';

export const hookConfigLimit = 24_576;
export const hookEditorLimit = 65_536;
const sessionFlags = '/<session-flags>/config.toml';
const sessionKey = /^\/<session-flags>\/config\.toml:[a-z_]+:\d+:\d+$/;
const nativeHash = /^sha256:[0-9a-f]{64}$/;
const eventName = /^[A-Z][A-Za-z]{1,50}$/;
const plainObject = value => value && typeof value === 'object' && !Array.isArray(value);
const invalid = message => new CrewError(message, 2);

function validateEvents(events) {
  if (!plainObject(events) || !Object.keys(events).length)
    throw invalid('Enter a non-empty Codex hooks object up to 24 KiB.');
  function checkValue(value, depth) {
    if (depth > 32 || value == null || (typeof value === 'number' && !Number.isFinite(value)))
      throw invalid('Use TOML-compatible hook values. Omit optional fields instead of entering null.');
    if (typeof value === 'object') for (const child of Object.values(value)) checkValue(child, depth + 1);
  }
  checkValue(events, 0);
  if (Buffer.byteLength(JSON.stringify(events)) > hookConfigLimit)
    throw invalid('Enter a non-empty Codex hooks object up to 24 KiB.');
  let count = 0;
  for (const [event, groups] of Object.entries(events)) {
    if (!eventName.test(event) || !Array.isArray(groups) || !groups.length)
      throw invalid('Use native Codex hook event names and matcher groups.');
    for (const group of groups) {
      if (!Array.isArray(group?.hooks) || !group.hooks.length)
        throw invalid('Every matcher group needs at least one hook.');
      for (const hook of group.hooks) {
        if (!plainObject(hook) || !['command', 'mcp_tool'].includes(hook.type))
          throw invalid('Use Codex command or MCP tool hooks.');
        count++;
      }
    }
  }
  return count;
}

export function validateWorkflowHooks(value) {
  if (value == null) return null;
  if (value.description !== undefined && (typeof value.description !== 'string' || Buffer.byteLength(value.description) > 1_000))
    throw invalid('Use a hooks.json description up to 1,000 bytes.');
  const count = validateEvents(value.events);
  const records = value.trust;
  if (!Array.isArray(records) || records.length !== count ||
      records.some(row => !sessionKey.test(row?.key) || !nativeHash.test(row?.hash)) ||
      new Set(records.map(row => row.key)).size !== count)
    throw invalid('Review the Codex hook definitions before saving them.');
  return { ...(value.description !== undefined && { description: value.description }), events: value.events,
    trust: records.map(({ key, hash }) => ({ key, hash })).sort((a, b) => a.key.localeCompare(b.key)) };
}

export function workflowHooksJson({ description, events }) {
  const config = { ...(description !== undefined && { description }), hooks: events };
  const readable = JSON.stringify(config, null, 2);
  return (readable.length < hookEditorLimit ? readable : JSON.stringify(config)) + '\n';
}

export function hookDefinitionArgs(events) {
  return Object.entries(events ?? {}).flatMap(([event, groups]) => ['-c', 'hooks.' + event + '=' + codexToml(groups)]);
}

export function hookStateArgs(trust = [], disabled = []) {
  const state = Object.fromEntries([
    ...disabled.map(key => [key, { enabled: false }]),
    ...trust.map(({ key, hash }) => [key, { trusted_hash: hash }]),
  ]);
  return Object.keys(state).length ? ['-c', 'hooks.state=' + codexToml(state)] : [];
}

export function workflowHookPolicy({ hooks, hostHooks } = {}) {
  return { ...(hooks && { lifecycleHooks: Object.keys(hooks.events).sort() }), ...(hostHooks && { hostHooks: true }) };
}

export function workflowHookServers(hooks) {
  const handlers = Object.values(hooks?.events ?? {}).flatMap(groups => groups.flatMap(group => group.hooks));
  return new Set(handlers.filter(hook => hook.type === 'mcp_tool').map(hook => hook.server));
}

async function codexHooks({ cwd, env, overrides = [], strict = false, signal }) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn('codex', ['app-server', '--listen', 'stdio://', '--enable', 'hooks',
      '--disable', 'apps', ...(strict ? ['--strict-config'] : []), ...overrides], {
      cwd, env, signal, stdio: ['pipe', 'pipe', 'ignore'],
    });
    const rows = createInterface({ input: child.stdout });
    let answer;
    const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    const send = message => child.stdin.write(JSON.stringify(message) + '\n');
    child.stdin.on('error', () => {});
    child.on('error', () => {});
    child.on('close', () => {
      clearTimeout(timer);
      rows.close();
      if (answer) resolve(answer);
      else reject(signal?.reason ?? invalid('Could not read hooks from the local Codex worker.'));
    });
    rows.on('line', line => {
      if (line.length > 2_000_000) return child.kill('SIGKILL');
      let msg;
      try { msg = JSON.parse(line); } catch { return child.kill(); }
      if (msg.id === 1 && msg.result) {
        send({ method: 'initialized', params: {} });
        return send({ id: 2, method: 'hooks/list', params: { cwds: [cwd] } });
      }
      if (msg.id !== 2 && msg.id !== 1) return;
      const entry = msg.result?.data?.[0];
      if (Array.isArray(entry?.hooks) && Array.isArray(entry?.errors)) answer = entry;
      child.kill();
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'engineering_crew_hooks', version: '1' },
      capabilities: { experimentalApi: true } } });
  });
}

function reviewedRows(entry) {
  return entry.hooks.filter(row => row.sourcePath === sessionFlags && row.source === 'sessionFlags');
}

export async function reviewWorkflowHooks(text, previous, approved) {
  if (!text.trim()) return null;
  if (text.length > hookEditorLimit) throw invalid('Enter up to 65,536 characters of hooks.json content.');
  let config;
  try { config = JSON.parse(text); } catch { throw invalid('Enter valid hooks.json content.'); }
  if (!plainObject(config) || Object.keys(config).some(key => !['description', 'hooks'].includes(key)))
    throw invalid('Use a hooks.json object with a hooks field and an optional description.');
  const events = config.hooks;
  const count = validateEvents(events);
  if (!approved && previous && isDeepStrictEqual(previous.events, events))
    return validateWorkflowHooks({ ...previous, description: config.description });
  if (!approved) throw invalid('Review and trust the new hook definitions before saving this agent.');
  const cwd = await mkdtemp(join(tmpdir(), 'crew-codex-hook-review-'));
  try {
    const entry = await codexHooks({ cwd, env: { ...codexHostEnvironment(), CODEX_HOME: cwd }, strict: true,
      overrides: ['--disable', 'plugins', '-c', 'analytics.enabled=false', ...hookDefinitionArgs(events)] });
    const rows = reviewedRows(entry);
    if (rows.length !== count || entry.errors.some(error => error.path === sessionFlags))
      throw invalid('The local Codex worker could not load every hook. Check the event names and handler settings.');
    return validateWorkflowHooks({ events, description: config.description, trust: rows.map(row => ({ key: row.key, hash: row.currentHash })) });
  } finally { await rm(cwd, { recursive: true, force: true }); }
}

export async function prepareWorkflowHooks(runtime, { cwd, env, signal, pluginOverrides = [], projectTrust = [] }) {
  const { hooks, hostHooks } = runtime;
  const entry = await codexHooks({ cwd, env, signal, overrides: [
    ...pluginOverrides, ...projectTrust, ...hookDefinitionArgs(hooks?.events), ...hookStateArgs(hooks?.trust),
  ] });
  const rows = reviewedRows(entry);
  if (rows.length !== (hooks?.trust.length ?? 0) || hooks?.trust.some(({ key, hash }) =>
      !rows.some(row => row.key === key && row.currentHash === hash && row.trustStatus === 'trusted' && row.enabled)))
    throw new Error('Codex could not verify the pinned hook definitions. Review them in the current Codex version and save a new agent revision.');
  const disabled = hostHooks ? [] : entry.hooks.filter(row => !row.isManaged && row.source !== 'sessionFlags').map(row => row.key);
  if (disabled.some(key => typeof key !== 'string' || !key.length))
    throw new Error('Could not scope Codex lifecycle hooks to this agent.');
  return { ...runtime, disabledHooks: [...new Set(disabled)] };
}
