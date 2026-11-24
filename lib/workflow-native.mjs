import { mkdir, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join, resolve } from 'node:path';
import { CrewError, repoPath } from './contracts.mjs';
import { reasoningEfforts } from './feature-profiles.mjs';
import { validCodexServerName } from './codex-host-mcp.mjs';
import { validCodexPluginId } from './codex-host-plugins.mjs';
import { validateSubagentRoles } from './workflow-subagents.mjs';
import { validateWorkflowHooks } from './workflow-hooks.mjs';
import { validCodexAppId } from './codex-host-apps.mjs';

export const workspaceModes = Object.freeze({
  'tools': 'MCP tools only',
  'read-only': 'Read-only workspace',
  'workspace-write': 'Editable workspace',
});
export const webSearchModes = Object.freeze({
  disabled: 'Off',
  cached: 'Cached search',
  indexed: 'Indexed search',
  live: 'Live search',
});
export const approvalModes = Object.freeze({
  never: 'No approval prompts', 'on-request': 'Review when Codex requests it', untrusted: 'Review untrusted actions',
});
export const limitedExecution = Object.freeze({ workspace: 'tools', webSearch: 'disabled', reasoningEffort: '' });
export const workflowPermissionProfile = 'crew-workspace';
export const codexReplyBytes = 1_000_000;
const scratchDirectory = '.crew-tmp';

const codexServiceTierLabels = Object.freeze({ default: 'Standard', priority: 'Fast', fast: 'Fast', ultrafast: 'Ultrafast' });
export const validCodexServiceTier = value => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(value);
export const codexServiceTierLabel = tier => !tier ? 'Worker default' :
  Object.hasOwn(codexServiceTierLabels, tier) ? codexServiceTierLabels[tier] : tier;

export const musicCodexAgent = (projectId, profile) => projectId === 'music-transcribe' && Array.isArray(profile.codexTools);
export const savesWorkspaceCheckpoint = (projectId, profile, task) =>
  musicCodexAgent(projectId, profile) && task.captureWorkspace === true && profile.codexRuntime?.workspace === 'workspace-write';

function delegationSettings(value) {
  if (value == null) return null;
  const { maxConcurrent, model = '', reasoningEffort = '' } = value;
  if (typeof value !== 'object' || Array.isArray(value) ||
      (maxConcurrent != null && (!Number.isSafeInteger(maxConcurrent) || maxConcurrent <= 0)) ||
      typeof model !== 'string' || (model !== '' && !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/.test(model)) ||
      (reasoningEffort !== '' && !reasoningEfforts.includes(reasoningEffort)))
    throw new CrewError('Choose a valid subagent model, reasoning effort, and positive concurrency limit.', 2);
  return { ...(maxConcurrent != null && { maxConcurrent }), ...(model && { model }), ...(reasoningEffort && { reasoningEffort }) };
}

export function workflowNativeSettings(settings = limitedExecution) {
  const { workspace, webSearch, reasoningEffort, mcpServers = [], plugins = [], pluginEnv = [], apps = [], imageInspection = false,
    serviceTier = '' } = settings;
  if (!Object.hasOwn(workspaceModes, workspace) || !Object.hasOwn(webSearchModes, webSearch) ||
    (reasoningEffort !== '' && !reasoningEfforts.includes(reasoningEffort))) throw new CrewError('Choose valid Codex execution settings.', 2);
  if (serviceTier !== '' && !validCodexServiceTier(serviceTier)) throw new CrewError('Choose a valid Codex speed.', 2);
  if (!Array.isArray(mcpServers) || !mcpServers.every(validCodexServerName) || new Set(mcpServers).size !== mcpServers.length)
    throw new CrewError('Choose each Codex MCP server once.', 2);
  if (!Array.isArray(plugins) || !plugins.every(validCodexPluginId) || new Set(plugins).size !== plugins.length)
    throw new CrewError('Choose each installed Codex plugin once.', 2);
  if (!Array.isArray(apps) || !apps.every(app => validCodexAppId(app?.id) &&
    typeof app.name === 'string' && app.name.trim() && app.name.length <= 200) || new Set(apps.map(app => app.id)).size !== apps.length)
    throw new CrewError('Choose each connected Codex app once.', 2);
  if (!Array.isArray(pluginEnv) || !pluginEnv.every(name => typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) ||
      new Set(pluginEnv).size !== pluginEnv.length)
    throw new CrewError('Enter distinct worker environment variable names for Codex plugins.', 2);
  if (typeof imageInspection !== 'boolean' || (imageInspection && workspace === 'tools'))
    throw new CrewError('Image inspection requires a read-only or editable workspace.', 2);
  const { commandEvidence = false, repositoryInstructions = false, imageGeneration = false } = settings;
  if (typeof imageGeneration !== 'boolean') throw new CrewError('Choose whether Codex can generate images.', 2);
  if (typeof commandEvidence !== 'boolean' || (commandEvidence && workspace === 'tools'))
    throw new CrewError('Saving shell command details requires a read-only or editable workspace.', 2);
  if (typeof repositoryInstructions !== 'boolean' || (repositoryInstructions && workspace === 'tools'))
    throw new CrewError('Repository instructions require a read-only or editable workspace.', 2);
  const delegation = delegationSettings(settings.delegation);
  const subagentRoles = validateSubagentRoles(settings.subagentRoles);
  const hooks = validateWorkflowHooks(settings.hooks);
  const { hostHooks = false, liveSession = false, saveThread = false, approvalMode = 'never' } = settings;
  if (typeof hostHooks !== 'boolean') throw new CrewError('Choose whether to use trusted host hooks.', 2);
  if (typeof liveSession !== 'boolean') throw new CrewError('Choose a Codex session mode.', 2);
  if (typeof saveThread !== 'boolean' || (saveThread && !liveSession)) throw new CrewError('Saving the Codex thread requires a live session.', 2);
  if (!Object.hasOwn(approvalModes, approvalMode) || (approvalMode !== 'never' && !liveSession))
    throw new CrewError('Choose a Codex approval mode for a live session.', 2);
  return { workspace, webSearch, reasoningEffort, ...(mcpServers.length && { mcpServers: [...mcpServers].sort() }),
    ...(serviceTier && { serviceTier }),
    ...(plugins.length && { plugins: [...plugins].sort(), ...(pluginEnv.length && { pluginEnv: [...pluginEnv].sort() }) }),
    ...(apps.length && { apps: apps.map(({ id, name }) => ({ id, name: name.trim() })).sort((a, b) => a.id.localeCompare(b.id)) }),
    ...(imageInspection && { imageInspection }), ...(imageGeneration && { imageGeneration }), ...(commandEvidence && { commandEvidence }),
    ...(repositoryInstructions && { repositoryInstructions }),
    ...(delegation && { delegation }), ...(subagentRoles.length && { subagentRoles }),
    ...(hooks && { hooks }), ...(hostHooks && { hostHooks }), ...(liveSession && { liveSession }), ...(saveThread && { saveThread }),
    ...(approvalMode !== 'never' && { approvalMode }) };
}

export function workspaceItems(inputs, sources, files = []) {
  let folder = 'crew-inputs';
  const paths = [...sources, ...files].map(file => file.path.toLowerCase());
  while (paths.some(path => path === folder || path.startsWith(folder + '/'))) folder += '-inputs';
  return [...inputs.map((input, index) => ({ ...input, path: folder + '/input-' + (index + 1) + '.txt' })), ...sources];
}

export async function stageWorkflowWorkspace(directory, inputs, files = []) {
  await mkdir(directory, { mode: 0o700 });
  await mkdir(join(directory, scratchDirectory), { mode: 0o700 });
  for (const { path, content, mode } of [...inputs, ...files.map(file => ({ ...file, content: Buffer.from(file.data, 'base64') }))]) {
    const destination = join(directory, repoPath(path));
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, content, { flag: 'wx', mode: mode === '100755' ? 0o700 : 0o600 });
  }
}

export function workflowPermissionArgs(workspace, cwd, pluginReadPaths = [], protectProjectConfig = false) {
  const nodeBin = dirname(process.execPath);
  const nodeRoot = resolve(nodeBin, '..');
  const [brewPrefix] = nodeRoot.includes('/Cellar/') ? nodeRoot.split('/Cellar/') : [];
  const brew = brewPrefix ? ['bin', 'opt', 'Cellar', 'etc/openssl@3'].map(path => join(brewPrefix, path)) : [];
  const tooling = [nodeBin, ...(brew.length ? [brew[0]] : []), '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  const access = workspace === 'workspace-write' ? 'write' : 'read';
  const scratch = cwd && JSON.stringify(join(cwd, scratchDirectory));
  const filesystem = [
    '":root"="deny"', '":minimal"="read"', '":workspace_roots"={"."=' + JSON.stringify(access) + '}',
    ...(scratch && access === 'read' ? [scratch + '="write"'] : []),
    ...(protectProjectConfig ? ['.codex', 'config.toml'].map(path => JSON.stringify(join(cwd, path)) + '="deny"') : []),
    ...[nodeRoot, ...brew, ...pluginReadPaths].map(path => JSON.stringify(path) + '="read"'),
  ].join(',');
  return [
    'default_permissions=' + JSON.stringify(workflowPermissionProfile),
    'permissions.crew-workspace.filesystem={' + filesystem + '}',
    'permissions.crew-workspace.network.enabled=false',
    'shell_environment_policy.inherit="none"',
    'shell_environment_policy.set.PATH=' + JSON.stringify(tooling.join(delimiter)),
    ...(scratch ? ['shell_environment_policy.set.TMPDIR=' + scratch] : []),
  ].flatMap(setting => ['-c', setting]);
}
