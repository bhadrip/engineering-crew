import { join } from 'node:path';
import { codexModelLogFilter } from './feature-codex-telemetry.mjs';
import { workflowPermissionArgs, workflowPermissionProfile } from './workflow-native.mjs';
import { codexPluginOverride } from './codex-host-plugins.mjs';
import { subagentRolePath } from './workflow-subagents.mjs';
import { hookDefinitionArgs, hookStateArgs } from './workflow-hooks.mjs';
import { codexToml as toml } from './codex-toml.mjs';
import { codexAppArgs } from './codex-host-apps.mjs';
import { musicBrowserTool, musicPracticeTool } from './workflow-agent-tools.mjs';

export const codexHookProjectTrust = (cwd, trusted = false) => ['-c', 'projects.' + toml(cwd) + '.trust_level=' + toml(trusted ? 'trusted' : 'untrusted'),
  ...(trusted ? ['-c', 'project_root_markers=[]', '-c', 'project_doc_fallback_filenames=[]'] : [])];

export function projectMcpArgs(servers) {
  return servers.flatMap(({ server, settings }) => Object.entries(settings)
    .flatMap(([key, value]) => ['-c', 'mcp_servers.' + server + '.' + key + '=' + toml(value)]));
}

export function codexLaunch(config, directory, projectServers = []) {
  const mcp = config.mcp;
  const connected = mcp ? Object.entries({ command: mcp.program, args: [mcp.script, join(directory, mcp.file)],
    enabled_tools: mcp.enabled, required: true,
    ...([musicPracticeTool, musicBrowserTool].some(tool => mcp.enabled.includes(tool)) && { tool_timeout_sec: 180 }) }).flatMap(([key, value]) =>
    ['-c', 'mcp_servers.' + mcp.name + '.' + key + '=' + JSON.stringify(value)]) : [];
  const hostOverrides = config.hostMcp ? ['-c', 'model_provider="openai"', ...config.hostMcp.disabled
    .flatMap(name => ['-c', 'mcp_servers.' + name + '.enabled=false'])] : [];
  const pluginOverrides = config.hostPlugins ? ['-c', codexPluginOverride(config.hostPlugins)] : [];
  const appOverrides = config.hostApps ? codexAppArgs(config.hostApps) : [];
  const projectOverrides = projectMcpArgs(projectServers);
  const delegation = config.nativeCapabilities?.delegation;
  const specialists = delegation ? (config.nativeCapabilities.subagentRoles ?? []) : [];
  const delegationArgs = config.nativeCapabilities ? [
    'agents.enabled=' + Boolean(delegation),
    ...(delegation?.maxConcurrent ? ['agents.max_concurrent_threads_per_session=' + delegation.maxConcurrent] : []),
    ...(delegation?.model ? ['agents.default_subagent_model=' + JSON.stringify(delegation.model)] : []),
    ...(delegation?.reasoningEffort ? ['agents.default_subagent_reasoning_effort=' + JSON.stringify(delegation.reasoningEffort)] : []),
    ...specialists.flatMap(role => [
      'agents.' + role.name + '.description=' + toml(role.description),
      'agents.' + role.name + '.config_file=' + toml(subagentRolePath(directory, role.name)),
    ]),
  ].flatMap(setting => ['-c', setting]) : [];
  const cwd = config.nativeWorkspace ? join(directory, 'workspace') : directory;
  const hookSetup = config.nativeCapabilities?.hookSetup;
  const nativeInstructions = config.projectDocMaxBytes > 0;
  const projectTrust = codexHookProjectTrust(cwd, nativeInstructions);
  const hookArgs = hookSetup ? [
    ...projectTrust, ...hookDefinitionArgs(hookSetup.hooks?.events),
    ...hookStateArgs(hookSetup.hooks?.trust, hookSetup.disabledHooks),
  ] : [];
  const permissions = config.nativeWorkspace ? workflowPermissionArgs(config.nativeWorkspace, cwd, config.hostPlugins?.readPaths, nativeInstructions) :
    ['--sandbox', config.sandbox];
  const common = [...(config.enabledFeatures ?? []).flatMap(feature => ['--enable', feature]),
    ...(config.nativeCapabilities?.imageGeneration ? ['--disable', 'omit_app_server_notification_media'] : []),
    ...config.disabledFeatures.flatMap(feature => ['--disable', feature]), '-c', 'web_search=' + JSON.stringify(config.webSearch),
    '-c', 'project_doc_max_bytes=' + config.projectDocMaxBytes, '-c', 'model_reasoning_effort=' + JSON.stringify(config.reasoningEffort),
    ...hostOverrides, ...pluginOverrides, ...appOverrides, ...connected, ...projectOverrides, ...delegationArgs, ...hookArgs];
  if (config.liveSession) return {
    program: 'codex',
    args: ['app-server', '--listen', 'stdio://', '--enable', 'default_mode_request_user_input', ...(config.nativeWorkspace ? permissions : []),
      ...(!hookSetup ? projectTrust : []), ...common],
    rustLog: codexModelLogFilter,
    thread: { cwd, ephemeral: config.ephemeral, approvalPolicy: config.approval,
      ...(config.approval !== 'never' && { approvalsReviewer: 'user' }),
      ...(config.requestedModel && { model: config.requestedModel }),
      ...(config.serviceTier && { serviceTier: config.serviceTier }),
      ...(config.developerInstructions && { developerInstructions: config.developerInstructions }),
      ...(config.nativeWorkspace ? { permissions: workflowPermissionProfile } : { sandbox: config.sandbox }) },
  };
  const args = ['--ask-for-approval', config.approval, 'exec', ...permissions, '--cd', cwd,
    '--skip-git-repo-check', ...(config.ignoreUserConfig ? ['--ignore-user-config'] : []),
    ...(config.ignoreRules ? ['--ignore-rules'] : []), ...(config.ephemeral ? ['--ephemeral'] : []), ...common,
    '--color', 'never', '--json', '--output-schema', join(directory, 'schema.json'), '--output-last-message', join(directory, 'answer.json'),
    ...(config.requestedModel ? ['--model', config.requestedModel] : []), '-'];
  return { program: 'codex', args, rustLog: codexModelLogFilter };
}

export function describeCodexLaunch(config) {
  if (config?.harness !== 'codex') return null;
  const { launch } = config;
  if (launch?.program === 'codex' && typeof launch.rustLog === 'string' && Array.isArray(launch.args) &&
    launch.args.every(arg => typeof arg === 'string')) return { ...launch, recorded: true };
  if (!['approval', 'sandbox', 'webSearch', 'reasoningEffort'].every(key => typeof config[key] === 'string') ||
    !['ignoreUserConfig', 'ignoreRules', 'ephemeral'].every(key => typeof config[key] === 'boolean') ||
    !Number.isSafeInteger(config.projectDocMaxBytes) || !Object.hasOwn(config, 'requestedModel') ||
    !(config.requestedModel === null || typeof config.requestedModel === 'string') ||
    !Array.isArray(config.disabledFeatures) || !config.disabledFeatures.every(feature => typeof feature === 'string')) return null;
  return codexLaunch(config, '$RUN_DIR');
}

function shellWord(argument) {
  if (/^[A-Za-z0-9_./:@-]+$/.test(argument)) return argument;
  return "'" + argument.replaceAll("'", "'\\''") + "'";
}

function shellArgument(argument) {
  if (/^\$RUN_DIR(?:\/[A-Za-z0-9/_.-]+)?$/.test(argument)) return '"' + argument + '"';
  return argument.includes('$RUN_DIR') ? argument.split('$RUN_DIR').map(part => part && shellWord(part)).join('"$RUN_DIR"') : shellWord(argument);
}

export function formatCodexLaunch(launch) {
  const lines = ['RUST_LOG=' + shellArgument(launch.rustLog)];
  let line = launch.program;
  for (const argument of launch.args) {
    const word = shellArgument(argument);
    if (argument.startsWith('-') && argument !== '-' && line.length + word.length > 72) {
      lines.push(line);
      line = '  ' + word;
    } else line += ' ' + word;
  }
  lines.push(line);
  return lines.join(' \\\n');
}
