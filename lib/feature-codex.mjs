import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { codexModelTelemetry } from './feature-codex-telemetry.mjs';
import { callInput, callOutput } from './feature-call-artifacts.mjs';
import { skillRecords } from './feature-profiles.mjs';
import { codexHookProjectTrust, codexLaunch } from './feature-codex-command.mjs';
import { CrewError, responseSchema } from './contracts.mjs';
import { imageBase64Limit } from './agent-images.mjs';
import { nativeWorkflowSkill, prepareWorkflowAgentTools, workflowAgentServer } from './workflow-agent-tools.mjs';
import { openWorkflowSubmissionBridge } from './workflow-submissions.mjs';
import { openMusicPracticeBridge } from './workflow-music-practice.mjs';
import { openMusicBrowserBridge } from './workflow-music-browser.mjs';
import { codexReplyBytes, codexServiceTierLabel, stageWorkflowWorkspace, validCodexServiceTier } from './workflow-native.mjs';
import { captureWorkflowWorkspace, workspaceFileBytes } from './workflow-workspace.mjs';
import { skillAssetDetails } from './workflow-skills.mjs';
import { codexHostEnvironment, codexHostMcpCatalog, enabledCodexServers, referencedMcpEnvironment } from './codex-host-mcp.mjs';
import { codexHostPluginCatalog, codexPluginOverride, codexPluginReadPaths, enabledCodexPlugins } from './codex-host-plugins.mjs';
import { projectMcpIdentity, resolveProjectMcpServers } from './project-mcp.mjs';
import { stageSubagentRoles } from './workflow-subagents.mjs';
import { prepareWorkflowHooks, workflowHookServers } from './workflow-hooks.mjs';
import { codexAppsServer, prepareCodexApps } from './codex-host-apps.mjs';
import { CodexTurnInterrupted, workflowAppServer } from './workflow-app-server.mjs';

const string = { type: 'string' };
const strings = { type: 'array', items: string };
const object = properties => ({
  type: 'object', properties, required: Object.keys(properties), additionalProperties: false,
});

const engineerActions = ['read', 'edit', 'test', 'finish'];
function engineerSchema(actions) {
  if (!actions.length || actions.some(action => !engineerActions.includes(action))) throw new Error('Invalid engineer action set');
  const emptyCheckout = actions.length === 1 && actions[0] === 'edit';
  const fileChange = object({
    action: { type: 'string', enum: emptyCheckout ? ['write'] : ['write', 'delete'] },
    path: string,
    content: string,
  });
  return object({
    action: { type: 'string', enum: actions },
    summary: string,
    paths: strings,
    changes: { type: 'array', items: fileChange, ...(emptyCheckout && { minItems: 1 }) },
  });
}

export const stageSchemas = {
  planner: object({ summary: string, steps: strings, acceptance: strings }),
  engineer: engineerSchema(engineerActions),
  reviewer: object({ passed: { type: 'boolean' }, summary: string, findings: strings }),
  security: object({ passed: { type: 'boolean' }, summary: string, findings: strings }),
  qa: object({ summary: string, testSource: string }),
};

const modelId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/.test(value);
let workerDefault;

function shellCommandEvidence(item, started, runPaths) {
  const clean = value => runPaths.reduce((text, path) => text.replaceAll(path, '$RUN_DIR'),
    stripVTControlCharacters(typeof value === 'string' ? value : '').replace(/\r\n?/g, '\n')
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, ''));
  const command = clean(item.command);
  const output = started ? '' : clean(item.aggregated_output);
  return {
    ...(command && { command: command.slice(0, 2000), ...(command.length > 2000 && { commandTruncated: true }) }),
    ...(!started && Number.isSafeInteger(item.exit_code) && { exitCode: item.exit_code }),
    ...(!started && Number.isSafeInteger(item.duration_ms) && item.duration_ms >= 0 && { durationMs: item.duration_ms }),
    ...(output && { output: output.slice(-4000), ...(output.length > 4000 && { outputTruncated: true }) }),
  };
}

function workflowMessage(item) {
  if (item?.type !== 'agent_message' || typeof item.text !== 'string' ||
      ['final_answer', 'finalAnswer'].includes(item.phase)) return null;
  const text = item.text.trim();
  if (!text) return null;
  if (text.startsWith('{')) {
    try {
      const result = JSON.parse(text);
      if (responseSchema.properties.state.enum.includes(result?.state) &&
          typeof result.summary === 'string' && Array.isArray(result.outputs)) return null;
    } catch {}
  }
  return text.length > 3_000 ? text.slice(0, 3_000).toWellFormed().trimEnd() + '…' : text;
}

// Enumerating models uses the subscription CLI without opening a thread or
// running a model turn. Only a fully read catalog can establish its default.
export function codexModelCatalog({ cwd = tmpdir(), env = codexHostEnvironment(), timeoutMs = 4000, signal } = {}) {
  if (signal?.aborted) return Promise.resolve(null);
  return new Promise(resolve => {
    const group = process.platform !== 'win32';
    const child = spawn('codex', ['app-server', '--listen', 'stdio://', '-c', 'model_provider="openai"'], {
      cwd, env, detached: group, stdio: ['pipe', 'pipe', 'ignore'],
    });
    let line = '', pending = 1, stopping = false, answer = null, killTimer;
    const models = new Set(), defaults = new Set(), cursors = new Set(), serviceTiers = new Map();
    const kill = sig => {
      if (child.pid) try { process.kill(group ? -child.pid : child.pid, sig); } catch {}
    };
    function stop(catalog = null) {
      if (stopping) return;
      stopping = true;
      answer = catalog;
      child.stdin.end();
      kill('SIGTERM');
      killTimer = setTimeout(() => kill('SIGKILL'), 250);
      killTimer.unref();
    }
    const abort = () => stop();
    const timer = setTimeout(abort, timeoutMs);
    timer.unref();
    signal?.addEventListener('abort', abort, { once: true });
    const send = message => child.stdin.write(JSON.stringify(message) + '\n');
    function list(cursor) {
      send({ id: ++pending, method: 'model/list', params: { modelProvider: 'openai', includeHidden: false, limit: 100, ...(cursor ? { cursor } : {}) } });
    }
    function consume(raw) {
      if (stopping) return;
      let msg;
      try { msg = JSON.parse(raw); } catch { return stop(); }
      if (msg?.id !== pending) return;
      if (msg.error || !msg.result) return stop();
      if (pending === 1) {
        send({ method: 'initialized', params: {} });
        return list();
      }
      if (!Array.isArray(msg.result.data)) return stop();
      for (const item of msg.result.data) {
        if (item?.hidden === true) continue;
        if (!modelId(item?.model)) {
          if (item?.isDefault === true) return stop();
          continue;
        }
        models.add(item.model);
        if (item.isDefault === true) defaults.add(item.model);
        const tiers = Array.isArray(item.serviceTiers) && item.serviceTiers.length ? item.serviceTiers :
          Array.isArray(item.additionalSpeedTiers) ? item.additionalSpeedTiers.map(id => ({ id })) : [];
        if (!tiers.length) continue;
        const advertised = serviceTiers.get(item.model) ?? new Map();
        for (const tier of tiers) {
          if (!validCodexServiceTier(tier?.id) || tier.id === 'default') continue;
          const name = typeof tier.name === 'string' && tier.name.trim() && tier.name.length <= 80 && !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(tier.name) ?
            tier.name.trim() : codexServiceTierLabel(tier.id);
          advertised.set(tier.id, { id: tier.id, name });
        }
        if (advertised.size) serviceTiers.set(item.model, advertised);
      }
      const cursor = msg.result.nextCursor;
      if (cursor == null || cursor === '') return stop({ defaultModel: defaults.size === 1 ? [...defaults][0] : null, models: [...models],
        ...(serviceTiers.size && { serviceTiers: Object.fromEntries([...serviceTiers].map(([model, tiers]) => [model, [...tiers.values()]])) }) });
      if (typeof cursor !== 'string' || cursors.has(cursor)) return stop();
      cursors.add(cursor);
      list(cursor);
    }
    child.stdout.setEncoding('utf8').on('data', chunk => {
      const lines = (line + chunk).split('\n');
      line = lines.pop();
      if (line.length > 2_000_000) return stop();
      for (const raw of lines) if (raw.trim()) consume(raw);
    });
    child.stdin.on('error', abort);
    child.on('error', abort);
    child.on('close', () => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', abort);
      resolve(answer);
    });
    send({ id: pending, method: 'initialize', params: { clientInfo: { name: 'engineering_crew_model_catalog', title: 'Engineering Crew', version: '1' } } });
  });
}

export async function defaultCodexModel(options) {
  return (await codexModelCatalog(options))?.defaultModel ?? null;
}

// The host owns login and the JSON transport. All model-directed project IO
// is handled by the controller, against its immutable Git snapshot.
export async function callFeatureCodex({ role, prompt, model, profile, allowedActions, signal, onEvent, developmentProbe = false, workflow }) {
  signal?.throwIfAborted();
  const temp = await mkdtemp(join(tmpdir(), 'crew-feature-codex-'));
  const schema = join(temp, 'schema.json');
  const output = join(temp, 'answer.json');
  let practiceBridge, browserBridge, submissionBridge;
  try {
    const explicitSkills = (workflow?.invokeSkills ?? []).map(number => nativeWorkflowSkill(workflow.skills[number - 1], number - 1));
    const images = [];
    for (const [index, { data, extension, ...image }] of (workflow?.turnImages ?? []).entries()) {
      const path = join(temp, 'turn-image-' + (index + 1) + '.' + extension);
      await writeFile(path, data, { flag: 'wx', mode: 0o600 });
      images.push({ path, image });
    }
    const liveSession = Boolean(workflow?.appServer || workflow?.runtime?.liveSession || explicitSkills.length || images.length);
    const turnPrompt = explicitSkills.length ? explicitSkills.map(skill => '$' + skill.name).join(' ') + '\n' + prompt : prompt;
    const nativeWorkspace = workflow?.runtime?.workspace !== 'tools' ? workflow?.runtime?.workspace : null;
    const commandEvidence = Boolean(nativeWorkspace && workflow?.runtime?.commandEvidence);
    const nativeInstructions = Boolean(nativeWorkspace && workflow?.repositoryInstruction);
    const runPaths = commandEvidence ? [...new Set([await realpath(temp), temp])] : [];
    const cwd = nativeWorkspace ? join(temp, 'workspace') : temp;
    if (nativeWorkspace) await stageWorkflowWorkspace(cwd, workflow.inputs, workflow.workspaceFiles);
    const launchDirectory = nativeInstructions ? await realpath(temp) : temp;
    const outputSchema = workflow ? workflow.freeForm ? undefined : responseSchema :
      role === 'engineer' && allowedActions ? engineerSchema(allowedActions) : stageSchemas[role];
    if (!liveSession) await writeFile(schema, JSON.stringify(outputSchema), { mode: 0o600 });
    const env = codexHostEnvironment();
    const selectedModel = model || await (workerDefault ??= defaultCodexModel({ cwd: temp, env, signal }).catch(() => null));
    const attachedServers = workflow?.runtime?.mcpServers ?? [];
    const attachedPluginIds = workflow?.runtime?.plugins ?? [];
    const attachedAppIds = (workflow?.runtime?.apps ?? []).map(app => app.id);
    const projectConnections = workflow?.projectMcp ?? [];
    const hostHooks = workflow?.runtime?.hostHooks;
    const hooks = workflow?.runtime?.hooks;
    const hookServers = workflowHookServers(hooks);
    const loadHost = liveSession || attachedServers.length > 0 || attachedPluginIds.length > 0 || attachedAppIds.length > 0 ||
      hostHooks || projectConnections.some(connection => connection.oauth);
    const [hostCatalog, pluginCatalog, apps] = await Promise.all([
      loadHost ? codexHostMcpCatalog({ cwd, env, signal }) : null,
      attachedPluginIds.length ? codexHostPluginCatalog({ cwd, env, signal, includeAvailable: true }) : null,
      attachedAppIds.length ? prepareCodexApps(attachedAppIds, { cwd, env, signal }) : null,
    ]);
    signal?.throwIfAborted();
    const hostServers = loadHost ? enabledCodexServers(hostCatalog, attachedServers) : [];
    const plugins = attachedPluginIds.length ? enabledCodexPlugins(pluginCatalog, attachedPluginIds) : [];
    const pluginSelection = plugins.length ? {
      attached: plugins.map(({ id, version }) => ({ id, version })),
      disabled: [...pluginCatalog.keys()].filter(id => !attachedPluginIds.includes(id)),
    } : null;
    const bundledCatalog = pluginSelection ?
      await codexHostMcpCatalog({ cwd, env, signal, plugins: codexPluginOverride(pluginSelection) }) : null;
    signal?.throwIfAborted();
    if (pluginSelection && !bundledCatalog) throw new Error('Could not discover MCP tools for the attached Codex plugins.');
    const bundledServers = bundledCatalog ? [...bundledCatalog.values()].filter(server => server.enabled && !hostCatalog.has(server.name)) : [];
    const bundledNames = new Set(bundledServers.map(server => server.name));
    if (apps && (hostCatalog.has(codexAppsServer) || bundledNames.has(codexAppsServer)))
      throw new Error('An MCP server on this worker uses the Codex connected-app server name.');
    const disabledServers = hostCatalog ? [...hostCatalog.keys()].filter(name => !attachedServers.includes(name)) : [];
    const occupied = new Set([...(hostCatalog?.keys() ?? []), ...(bundledCatalog?.keys() ?? []), ...(apps ? [codexAppsServer] : [])]);
    let serverName = workflowAgentServer;
    while (occupied.has(serverName)) serverName += '_inputs';
    occupied.add(serverName);
    const projectServers = resolveProjectMcpServers(projectConnections, occupied, hookServers);
    const projectNames = new Set(projectServers.map(connection => connection.server));
    const generatedImages = new Map();
    let pendingImages = Promise.resolve();
    let pendingCheckpoint = Promise.resolve();
    const saveWorkspace = workflow?.onWorkspaceCheckpoint && ((note, activeSignal) => {
      const saved = pendingCheckpoint.then(async () => {
        const files = await captureWorkflowWorkspace(cwd, workflow.inputFolder, activeSignal);
        activeSignal?.throwIfAborted();
        const checkpoint = await workflow.onWorkspaceCheckpoint({ files, note });
        return { files, checkpoint };
      });
      pendingCheckpoint = saved.catch(() => {});
      return saved;
    });
    if (workflow?.musicPractice) practiceBridge = await openMusicPracticeBridge({
      ...workflow.musicPractice, workspace: cwd, inputFolder: workflow.inputFolder, signal,
      ...(saveWorkspace && { capture: activeSignal => saveWorkspace('Staged for the Music Transcribe development check.', activeSignal).then(value => value.files) }),
    });
    if (workflow?.musicBrowser) browserBridge = await openMusicBrowserBridge({
      ...workflow.musicBrowser, workspace: cwd, inputFolder: workflow.inputFolder, signal,
      ...(saveWorkspace && { capture: activeSignal => saveWorkspace('Staged for the Music Transcribe workspace browser.', activeSignal).then(value => value.files) }),
    });
    if (workflow?.outputSlots || saveWorkspace) submissionBridge = await openWorkflowSubmissionBridge({ slots: workflow.outputSlots,
      persist: workflow.onSubmission, signal, ...(saveWorkspace && { checkpoint: async note =>
        ({ saved: true, ...(await saveWorkspace(note, signal)).checkpoint }) }),
      ...(workflow.outputSlots?.some(slot => slot.kind === 'image') && { listImages: async () => {
        await pendingImages;
        return [...generatedImages.values()];
      } }),
    });
    const mcp = workflow ? await prepareWorkflowAgentTools(temp, { ...workflow, serverName, submissions: submissionBridge?.connection,
      practiceConnection: practiceBridge?.connection, browserConnection: browserBridge?.connection }, cwd) : null;
    const activeServers = new Set([...attachedServers, ...bundledNames, ...projectNames, ...(mcp ? [mcp.name] : [])]);
    for (const server of hookServers) if (!activeServers.has(server))
      throw new Error('Attach MCP server ' + server + ' before running this agent’s lifecycle hook.');
    const envNames = [...[...hostServers, ...bundledServers].flatMap(server => server.envNames),
      ...projectServers.flatMap(connection => referencedMcpEnvironment(connection.settings)), ...(workflow?.runtime?.pluginEnv ?? [])];
    for (const name of envNames) if (process.env[name] !== undefined) env[name] = process.env[name];
    const disabled = ['shell_tool', 'apps', 'hooks', 'multi_agent', 'plugins', 'browser_use',
      'computer_use', 'view_image', 'image_generation', 'memories', 'skill_search', 'in_app_browser',
      'code_mode', 'unified_exec'];
    const delegation = workflow?.runtime?.delegation;
    const subagentRoles = delegation ? (workflow.runtime.subagentRoles ?? []) : [];
    await stageSubagentRoles(temp, subagentRoles);
    const imageInspection = Boolean(nativeWorkspace && workflow?.runtime?.imageInspection);
    const imageGeneration = Boolean(workflow?.appServer && workflow.runtime?.imageGeneration && workflow.onGeneratedImage);
    const hookSetup = (hooks || hostHooks) ? await prepareWorkflowHooks({ hooks, hostHooks }, { cwd, env, signal,
      projectTrust: codexHookProjectTrust(nativeInstructions ? await realpath(cwd) : cwd, nativeInstructions), pluginOverrides: pluginSelection ?
        ['--enable', 'plugins', '--disable', 'remote_plugin', '-c', codexPluginOverride(pluginSelection)] : ['--disable', 'plugins'],
    }) : null;
    const nativeCapabilities = {
      ...(delegation && { delegation }), ...(imageInspection && { imageInspection }), ...(imageGeneration && { imageGeneration }),
      ...(subagentRoles.length && { subagentRoles }),
      ...(commandEvidence && { commandEvidence }),
      ...(hookSetup && { hookSetup }),
    };
    const approval = workflow?.runtime?.approvalMode ?? 'never';
    const nativeActions = [...(nativeWorkspace ? ['shell_tool', 'unified_exec'] : []),
      ...(nativeWorkspace && approval !== 'never' ? ['request_permissions_tool'] : []),
      ...(delegation ? ['multi_agent'] : []), ...(imageInspection ? ['view_image'] : []), ...(imageGeneration ? ['image_generation'] : [])];
    const enabledFeatures = [...nativeActions, ...(plugins.length ? ['plugins'] : []), ...(hookSetup ? ['hooks'] : []), ...(apps ? ['apps'] : [])];
    const disabledFeatures = disabled.filter(feature => !enabledFeatures.includes(feature));
    if (plugins.length) disabledFeatures.push('remote_plugin');
    const webSearch = workflow?.runtime?.webSearch ?? 'disabled';
    const roleTools = profile.tools ?? [];
    const config = {
      harness: 'codex', role, profileId: profile.id, profileDigest: profile.digest, profileInstructions: profile.instructions ?? '',
      ...(profile.name && { profileName: profile.name }),
      requestedModel: selectedModel || null, modelSelection: model ? 'configured' : selectedModel ? 'catalog-default' : 'cli-default',
      workerImage: profile.workerImage ?? null, workspaceAccess: profile.access ?? null, workspaceNetwork: profile.network ?? null,
      roleTools, agentActions: role === 'engineer' ? outputSchema.properties.action.enum : [],
      controllerActions: [...(role === 'engineer' ? ['list'] : roleTools), ...(profile.extraTools ?? [])],
      ...(profile.skills?.length && { skills: skillRecords(profile.skills).map((record, index) => {
        const bundle = profile.skills[index].bundle;
        return bundle ? { ...record, directory: bundle.directory, files: bundle.files.map(skillAssetDetails) } : record;
      }) }),
      ...(mcp && { mcp }),
      ...(loadHost && { hostMcp: { attached: attachedServers, disabled: disabledServers } }),
      ...(apps && { hostApps: apps.config }),
      ...(pluginSelection && { hostPlugins: {
        ...pluginSelection, mcpServers: [...bundledNames],
        readPaths: nativeWorkspace ? await codexPluginReadPaths(plugins, env) : [],
        environment: workflow.runtime.pluginEnv ?? [],
      } }),
      ...(projectServers.length && { projectMcp: projectServers.map(projectMcpIdentity) }),
      ...(nativeWorkspace && { nativeWorkspace }),
      ...(liveSession && { liveSession }),
      ...(workflow && { nativeCapabilities }),
      ...(enabledFeatures.length && { enabledFeatures }),
      nativeTools: [...(mcp?.enabled ?? []), ...nativeActions, ...(webSearch !== 'disabled' ? ['web_search'] : [])],
      developmentProbe: role === 'engineer' && developmentProbe, disabledFeatures,
      sandbox: nativeWorkspace || 'read-only', approval, webSearch,
      reasoningEffort: workflow?.runtime?.reasoningEffort || profile.reasoningEffort || 'medium',
      ...(workflow?.appServer && workflow.runtime?.serviceTier && { serviceTier: workflow.runtime.serviceTier }),
      ephemeral: !workflow?.runtime?.saveThread, ignoreUserConfig: !loadHost, ignoreRules: !loadHost,
      projectDocMaxBytes: nativeInstructions ? workspaceFileBytes : 0, outputSchema,
      ...(workflow?.developerInstructions && { developerInstructions: workflow.developerInstructions }),
    };
    const launch = codexLaunch(config, launchDirectory, projectServers);
    config.launch = codexLaunch(config, '$RUN_DIR', projectServers);
    const input = callInput(turnPrompt, config);
    const receipt = { role, profileId: profile.id, profileDigest: profile.digest, model: selectedModel || 'codex default',
      modelSelection: config.modelSelection, callId: randomUUID(), inputDigest: input.digest,
      startedAt: new Date().toISOString(), usage: null };
    await onEvent({ type: 'agent.started', evidence: { ...receipt, harness: config.harness, sandbox: config.sandbox } }, { input });
    let liveOutput;
    const completed = await new Promise((resolve, reject) => {
      const group = process.platform !== 'win32';
      const telemetry = codexModelTelemetry();
      const child = spawn(launch.program, launch.args, { cwd, env: { ...env, RUST_LOG: launch.rustLog }, detached: group, stdio: ['pipe', 'pipe', 'pipe'] });
      let line = '';
      const diagnostics = { quota: false, login: false, network: false };
      let failure;
      let stopping = false;
      let turnComplete = false;
      let followUpsRemaining = workflow?.outputFollowUps ?? 0;
      let eventQueue = Promise.resolve();
      const eventByteLimit = 2_000_000 + (imageGeneration ? imageBase64Limit : 0);
      let killTimer;
      const kill = sig => {
        if (child.pid) try { process.kill(group ? -child.pid : child.pid, sig); } catch {}
      };
      function stop(reason) {
        if (stopping) return;
        stopping = true;
        failure ??= reason;
        kill('SIGTERM');
        killTimer = setTimeout(() => kill('SIGKILL'), 1200);
        killTimer.unref();
      }
      const abort = () => stop(signal.reason ?? new Error('Codex interrupted'));
      function record(event) {
        if (['thread.started', 'turn.started', 'turn.completed'].includes(event.type) && modelId(event.model)) {
          receipt.reportedModel = event.model;
          receipt.reportedModelSource = 'codex-json';
        }
        if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
          const threadId = event.thread_id;
          receipt.threadId = threadId;
          telemetry.thread(threadId);
          eventQueue = eventQueue.then(() => onEvent({ type: 'agent.thread', evidence: { threadId } })).catch(stop);
        }
        if (event.type === 'turn.started' && typeof event.turn_id === 'string') {
          const turnId = event.turn_id;
          eventQueue = eventQueue.then(() => onEvent({ type: 'agent.turn', evidence: { turnId } })).catch(stop);
        }
        if (event.type === 'turn.follow-up')
          eventQueue = eventQueue.then(() => onEvent({ type: 'agent.follow-up', at: new Date().toISOString(), evidence: event.followUp })).catch(stop);
        if (event.type === 'thread.speed')
          eventQueue = eventQueue.then(() => onEvent({ type: 'agent.speed', evidence: event.speed })).catch(stop);
        if (event.type === 'turn.skills')
          eventQueue = eventQueue.then(() => onEvent({ type: 'agent.skills', evidence: { skills: explicitSkills } })).catch(stop);
        if (event.type === 'turn.images')
          eventQueue = eventQueue.then(() => onEvent({ type: 'agent.images', evidence: { images: images.map(({ image }) => image) } })).catch(stop);
        if (event.type === 'agent.reply')
          eventQueue = eventQueue.then(() => onEvent({ type: 'agent.reply', evidence: event.reply })).catch(stop);
        if (event.type === 'turn.completed') {
          turnComplete = true;
          receipt.usage = Object.fromEntries(Object.entries(event.usage ?? {}).filter(([, n]) => Number.isSafeInteger(n) && n >= 0));
        }
        const item = event.item;
        const type = item?.type;
        if (workflow && event.type === 'item.completed') {
          const message = workflowMessage(item);
          if (message) {
            const evidence = { text: message, at: new Date().toISOString() };
            eventQueue = eventQueue.then(() => onEvent({ type: 'agent.message', evidence })).catch(stop);
          }
        }
        const mcpCall = type === 'mcp_tool_call' && typeof item.tool === 'string' && typeof item.server === 'string';
        const connectedTool = mcpCall &&
          ((mcp && item.server === mcp.name && mcp.enabled.includes(item.tool)) ||
            attachedServers.includes(item.server) || projectNames.has(item.server));
        const pluginTool = mcpCall && bundledNames.has(item.server);
        const appId = mcpCall && item.server === codexAppsServer ? apps?.tools.get(item.tool) : undefined;
        const localTool = nativeWorkspace && ['command_execution', 'file_change'].includes(type);
        const searchTool = type === 'web_search' && webSearch !== 'disabled';
        const imageTool = imageGeneration && type === 'image_generation';
        const delegationTool = delegation && ['collab_tool_call', 'collab_agent_tool_call'].includes(type);
        if (connectedTool || pluginTool || appId || localTool || searchTool || imageTool || delegationTool) {
          if (event.type === 'item.started' || event.type === 'item.completed') {
            const started = event.type === 'item.started';
            const at = new Date().toISOString();
            const subagentIds = delegationTool && Array.isArray(item.receiver_thread_ids)
              ? item.receiver_thread_ids.filter(id => typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id)) : [];
            const shell = commandEvidence && type === 'command_execution' && shellCommandEvidence(item, started, runPaths);
            let savedImage;
            if (imageTool && !started && item.status === 'completed' && !item.error) {
              savedImage = pendingImages.then(async () => {
                try {
                  const image = await workflow.onGeneratedImage({ itemId: item.id, encoded: item.result });
                  generatedImages.set(item.id, image);
                  return { generatedImage: image };
                } catch (error) {
                  if (!(error instanceof CrewError)) throw error;
                  return { imageSaveError: error.message };
                }
              });
              pendingImages = savedImage.catch(() => {});
            }
            eventQueue = eventQueue.then(async () => {
              await onEvent({ type: started ? 'tool.started' : 'tool.completed', at, evidence: {
                ...(typeof item.id === 'string' && { id: item.id }),
                server: connectedTool || pluginTool || appId ? item.server : 'codex',
                tool: connectedTool || pluginTool || appId || (delegationTool && typeof item.tool === 'string') ? item.tool : type,
                ...(pluginTool && { source: 'plugin' }),
                ...(appId && { source: 'app', appId }),
                ...(delegationTool && { source: 'subagent', ...(subagentIds.length && { subagentIds }) }),
                ...(shell && Object.keys(shell).length && { shell }),
                ...(savedImage && await savedImage),
                status: started ? 'running' : item.status === 'declined' ? 'declined' :
                  searchTool || (item.status === 'completed' && !item.error && !item.exit_code) ? 'completed' : 'failed',
              } });
            }).catch(stop);
          }
        } else if (['command_execution', 'mcp_tool_call', 'file_change', 'web_search',
          'dynamic_tool_call', 'collab_tool_call', 'collab_agent_tool_call', 'image_generation'].includes(type)) {
          stop(new Error(workflow ? 'Codex requested a tool outside the configured workspace' : 'Codex requested a tool outside the role workspace bridge'));
        }
        if (event.type === 'turn.failed') {
          const message = String(event.error?.message || '');
          failure = new Error(/limit|quota|usage/i.test(message) ? 'Codex usage limit reached'
            : /auth|log.?in|401/i.test(message) ? 'Codex requires sign-in' : 'Codex turn failed');
        }
      }
      const appServer = launch.thread && workflowAppServer({ child, thread: launch.thread, history: workflow.history, schema: outputSchema,
        reportSpeed: workflow.appServer,
        prompt: turnPrompt, explicitSkills, imagePaths: images.map(({ path }) => path), streamReply: workflow.freeForm,
        controls: workflow.controls, record, stop,
        followUp: followUpsRemaining > 0 && submissionBridge ? async () => {
          if (!followUpsRemaining || stopping || failure || signal?.aborted) return;
          await eventQueue;
          const { outputs, blocker } = await submissionBridge.submissions();
          if (blocker || stopping || failure || signal?.aborted) return;
          const saved = new Set(outputs.map(output => output.slot));
          const missingOutputs = workflow.outputSlots.filter(slot => slot.required && !saved.has(slot.id)).map(slot => slot.id);
          if (!missingOutputs.length) return;
          followUpsRemaining--;
          return { missingOutputs, prompt: [
            'Engineering Crew handoff check. Required outputs still missing: ' + missingOutputs.join(', ') + '.',
            'Continue the same assignment. Use the existing workspace and evidence to submit each missing slot with submit_workflow_output. Keep the outputs already saved.',
            'If you cannot complete the handoff, explain the reason with report_workflow_blocker.',
          ].join('\n\n') };
        } : undefined,
        finish(result) {
          if (result.status === 'interrupted') failure ??= new CodexTurnInterrupted('Codex stopped the active turn');
          else if (result.status !== 'completed') record({ type: 'turn.failed', error: result.error });
          else {
            liveOutput = result.text;
            record({ type: 'turn.completed', usage: result.usage });
          }
        },
      });
      function receive(raw) {
        let event;
        try { event = JSON.parse(raw); } catch { return; }
        if (appServer) appServer.receive(event);
        else record(event);
      }
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', chunk => {
        telemetry.write(chunk);
        diagnostics.quota ||= /quota|usage limit|rate limit/i.test(chunk);
        diagnostics.login ||= /login|log in|unauthorized|401/i.test(chunk);
        diagnostics.network ||= /connect|dns|network/i.test(chunk);
      });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        const lines = (line + chunk).split('\n');
        line = lines.pop();
        for (const text of lines) receive(text);
        if (line.length > eventByteLimit) stop(new Error('Codex event exceeds workspace limits'));
      });
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      child.on('error', error => stop(new Error('Could not launch Codex CLI (' + error.code + ')')));
      child.stdin.on('error', error => { if (appServer) stop(error); });
      if (appServer) appServer.start();
      else child.stdin.end(turnPrompt);
      child.on('close', async code => {
        receive(line);
        await appServer?.closed();
        const responseModel = telemetry.finish(receipt.threadId);
        if (responseModel) {
          receipt.reportedModel = responseModel;
          receipt.reportedModelSource = 'codex-response';
        }
        clearTimeout(killTimer);
        signal?.removeEventListener('abort', abort);
        await eventQueue;
        if (failure) return reject(failure);
        if (code !== 0 || !turnComplete) {
          const detail = diagnostics.quota ? 'usage limit' : diagnostics.login ? 'check local Codex sign-in'
            : diagnostics.network ? 'check model network access' : 'check Codex availability and sign-in';
          return reject(new Error('Codex exited without a completed turn (' + code + ', ' + detail + ')'));
        }
        resolve(true);
      });
    });
    if (completed) {
      const raw = liveSession ? liveOutput : await readFile(output, 'utf8');
      if (typeof raw !== 'string' || !raw.trim()) throw new Error('Codex completed the turn without a reply');
      if (Buffer.byteLength(raw) > codexReplyBytes) throw new Error('Codex response exceeds workspace limits');
      const value = workflow?.freeForm ? raw : JSON.parse(raw);
      if (role === 'engineer' && config.agentActions.includes(value?.action)) receipt.workspaceAction = value.action;
      const answer = callOutput(raw);
      receipt.outputDigest = answer.digest;
      receipt.endedAt = new Date().toISOString();
      await onEvent({ type: 'agent.completed', evidence: receipt }, { output: answer });
      const submitted = await submissionBridge?.finish();
      const files = workflow?.captureWorkspace && !submitted?.blocker && (workflow.freeForm || value.state === 'completed') ?
        await captureWorkflowWorkspace(cwd, workflow.inputFolder, signal) : undefined;
      return { value, receipt, ...(submitted && { submitted }), ...(files && { workspaceFiles: files }) };
    }
  } finally {
    await Promise.all([practiceBridge?.close(), browserBridge?.close(), submissionBridge?.close()]);
    await rm(temp, { recursive: true, force: true });
  }
}
