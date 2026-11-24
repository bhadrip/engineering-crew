#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
const config = name => JSON.parse(args.find(arg => arg.startsWith(name + '='))?.slice(name.length + 1) ?? 'null');

async function exerciseWorkflowSubmissions(assignment, item, turn) {
  const setting = args.find(arg => /^mcp_servers\.crew_workflow(?:_inputs)?\.command=/.test(arg));
  const prefix = setting.split('command=')[0];
  const server = spawn(config(prefix + 'command'), config(prefix + 'args'), { stdio: ['pipe', 'pipe', 'inherit'] });
  const ended = new Promise(resolve => server.once('close', resolve));
  const replies = createInterface({ input: server.stdout })[Symbol.asyncIterator]();
  let seq = 0;
  const request = async (method, params) => {
    const id = ++seq;
    server.stdin.write(JSON.stringify({ id, jsonrpc: '2.0', method, params }) + '\n');
    const response = JSON.parse((await replies.next()).value);
    assert.equal(response.id, id);
    return response.result;
  };
  const invoke = async (tool, parameters) => {
    const result = await request('tools/call', { name: tool, arguments: parameters });
    item({ type: 'mcpToolCall', id: 'submission-' + seq, server: prefix.split('.')[1], tool,
      status: result.isError ? 'failed' : 'completed' });
    return result;
  };
  try {
    const { tools } = await request('tools/list');
    const [submit, report] = tools;
    assert.equal(submit.name, 'submit_workflow_output');
    assert.equal(report.name, 'report_workflow_blocker');
    assert.deepEqual(submit.inputSchema.properties.slot.enum, assignment.outputs.map(slot => slot.id));
    const slot = assignment.outputs[0].id;
    if (assignment.objective === 'Recover a partial handoff.') {
      const selected = assignment.outputs[turn - 1];
      assert.equal((await invoke(submit.name, { slot: selected.id, content: JSON.stringify({ turn }) })).isError, undefined);
      return;
    }
    if (assignment.objective === 'Leave required outputs missing.') return;
    assert.equal((await invoke(submit.name, { slot, content: 'malformed JSON' })).isError, true);
    assert.equal((await invoke(submit.name, { slot: 'undeclared', content: '{}' })).isError, true);
    if (assignment.objective === 'Record a blocker.') {
      assert.equal((await invoke(report.name, { reason: 'The timing source is missing.', action: 'supply-recording', target: 'lesson-sample' })).isError, undefined);
      return;
    }
    assert.equal((await invoke(submit.name, { slot, content: '{"route":"draft"}' })).isError, undefined);
    assert.equal((await invoke(submit.name, { slot, content: '{"route":"practice"}' })).isError, undefined);
  } finally {
    server.stdin.end();
    await ended;
  }
}

if (args[0] === 'app-server') {
  const replies = createInterface({ input: process.stdin });
  const emit = event => process.stdout.write(JSON.stringify(event) + '\n');
  const threadId = 'fixture-thread';
  let developerInstructions, streamReplies, unavailableSpeed, turn = 0;
  const scoped = args.includes('apps._default.enabled=false');
  const apps = [
    { id: 'connector_music_fixture', runtimeName: 'Music Notes', enabled: true, callable: true },
    { id: 'connector_unselected_fixture', runtimeName: 'Other Notes', enabled: true, callable: true },
    { id: 'connector_blocked_fixture', runtimeName: 'Blocked Notes', enabled: false, callable: false },
  ];
  for await (const line of replies) {
    const { method, id, params } = JSON.parse(line);
    if (id === undefined) continue;
    let result;
    if (method === 'initialize') {
      streamReplies = !params.capabilities?.optOutNotificationMethods?.includes('item/agentMessage/delta');
      result = { userAgent: 'codex-fixture' };
    }
    else if (method === 'config/read') result = { config: { apps: { connector_explicit_fixture: { enabled: true } } } };
    else if (method === 'app/installed') result = { apps: apps.map(app => scoped && !args.includes('apps.' + app.id + '.enabled=true') ?
      { ...app, enabled: false, callable: false } : app) };
    else if (method === 'mcpServerStatus/list' && params.serverName === 'codex_apps') result = { data: [{ name: 'codex_apps', tools: {
      'music_notes.read_excerpt': { name: 'music_notes.read_excerpt', _meta: { connector_id: 'connector_music_fixture' } },
      'other_notes.read_excerpt': { name: 'other_notes.read_excerpt', _meta: { connector_id: 'connector_unselected_fixture' } },
    } }], nextCursor: null };
    else if (method === 'mcpServerStatus/list' && params.serverName.endsWith('_timing')) {
      assert.equal(params.detail, 'toolsAndAuthOnly');
      assert.ok(args.includes('mcp_servers.lesson-timing.enabled=false'));
      const prefix = 'mcp_servers.' + params.serverName + '.';
      const stdio = args.includes(prefix + 'command="timing-fixture"');
      const http = args.includes(prefix + 'url="https://mcp.example.com/mcp"');
      assert.ok(stdio || http);
      result = { data: [{ name: params.serverName, authStatus: 'unsupported',
        ...(http && { toolsError: 'Private fixture error with transport details' }),
        tools: stdio ? { inspect_tempo: { name: 'inspect_tempo' }, excluded_tool: { name: 'excluded_tool' } } : {} }], nextCursor: null };
    }
    else if (method === 'thread/start') {
      developerInstructions = params.developerInstructions;
      unavailableSpeed = params.serviceTier === 'ultrafast';
      result = { thread: { id: threadId, ephemeral: params.ephemeral }, cwd: params.cwd, approvalPolicy: params.approvalPolicy,
        ...(params.serviceTier && { serviceTier: unavailableSpeed ? null : params.serviceTier, model: params.model }),
        ...(params.permissions ? { activePermissionProfile: { id: params.permissions } } : { sandbox: { type: 'readOnly', networkAccess: false } }) };
    } else if (method === 'turn/start') {
      const turnId = ++turn === 1 ? 'fixture-turn' : 'fixture-turn-' + turn;
      assert.ok(!unavailableSpeed, 'A rejected explicit speed must stop before starting the turn.');
      assert.equal(params.threadId, threadId);
      const freeForm = Boolean(developerInstructions);
      assert.equal(streamReplies, freeForm);
      assert.equal(Object.hasOwn(params, 'outputSchema'), !freeForm);
      const assignment = freeForm && JSON.parse(developerInstructions.split('\n\n').at(-1)).assignment;
      if (freeForm) {
        if (turn === 1) assert.equal(params.input[0].text,
          assignment ? assignment.objective + '\n\nRequest brief\n\nWrite the timing notes.' : 'Write the timing notes.');
        else {
          const missing = assignment.objective === 'Recover a partial handoff.' ? assignment.outputs[1].id : assignment.outputs[0].id;
          assert.match(params.input[0].text, new RegExp('Required outputs still missing: ' + missing + '\\.'));
          assert.equal(params.input.length, 1);
        }
        assert.match(developerInstructions, /Use the pinned practice notes/);
      }
      emit({ method: 'turn/started', params: { threadId, turn: { id: turnId } } });
      emit({ id, result: { turn: { id: turnId } } });
      const item = item => emit({ method: 'item/completed', params: { threadId, turnId, item } });
      if (args[args.indexOf('image_generation') - 1] === '--enable') {
        assert.equal(args[args.indexOf('omit_app_server_notification_media') - 1], '--disable');
        const native = { type: 'imageGeneration', id: 'native-image', status: 'in_progress', result: '' };
        emit({ method: 'item/started', params: { threadId, turnId, item: native } });
        const result = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aYyUAAAAASUVORK5CYII=';
        item({ ...native, status: 'completed', result, savedPath: '/not-accessed/native-image.png' });
        item({ ...native, id: 'invalid-image', status: 'completed', result: 'invalid image data' });
      }
      if (assignment) await exerciseWorkflowSubmissions(assignment, item, turn);
      if (!freeForm) {
        const { assignment } = JSON.parse(params.input[0].text.split('\n').at(-1));
        const [connection] = assignment.permissions.projectMcp ?? [];
        if (connection) {
          assert.equal(connection.version, 1);
          const setting = args.find(arg => /^mcp_servers\.(crew_[a-f0-9]+_timing)\.command="timing-fixture"$/.test(arg));
          assert.ok(setting, 'Expected the pinned stdio connection for timing');
          item({ type: 'agentMessage', id: 'progress', text: 'I’ll inspect the <timing notes> first.' });
          item({ type: 'reasoning', id: 'reasoning', text: 'Private fixture reasoning must stay out of activity.' });
          item({ type: 'mcpToolCall', id: 'timing', server: setting.split('.')[1], tool: 'inspect_tempo', status: 'completed' });
        }
      }
      const text = freeForm ? '# Timing notes\n\nRepeat the phrase slowly.' : JSON.stringify({ state: 'completed', summary: 'Timing notes ready.',
        outputs: [{ slot: 'result', content: 'Repeat the phrase slowly.' }], decisions: [], questions: [], blockers: [], resourceRequests: [] });
      const itemId = 'reply';
      if (freeForm) {
        emit({ method: 'item/agentMessage/delta', params: { threadId, turnId: 'previous-turn', itemId, delta: 'Stale reply.' } });
        for (const delta of ['# Timing notes\n\n', 'Repeat the phrase slowly.'])
          emit({ method: 'item/agentMessage/delta', params: { threadId, turnId, itemId, delta } });
      }
      item({ id: itemId, type: 'agentMessage', phase: 'finalAnswer', text });
      emit({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } });
      continue;
    }
    emit({ id, ...(result ? { result } : { error: { code: -32601 } }) });
  }
  process.exit(0);
}
if (args[0] === 'mcp' && args[1] === 'list') {
  process.stdout.write(JSON.stringify([
    { name: 'lesson-timing', enabled: true, auth_status: 'unsupported', transport: { type: 'stdio', env_vars: [] } },
    { name: 'unused-server', enabled: false, auth_status: 'unsupported', transport: { type: 'stdio', env_vars: [] } },
    { name: 'crew_workflow', enabled: true, auth_status: 'unsupported', transport: { type: 'stdio', env_vars: [] } },
    ...(args.includes('--enable') ? [{ name: 'tempo-fixture', enabled: true, auth_status: 'unsupported',
      transport: { type: 'stdio', env_vars: [] } }] : []),
  ]));
  process.exit(0);
}
if (args[0] === 'plugin' && args[1] === 'list') {
  process.stdout.write(JSON.stringify({ installed: [
    { pluginId: 'tempo@crew-fixture', enabled: true, version: '1.2.0', source: { source: 'local' } },
    { pluginId: 'extra@crew-fixture', enabled: true, version: '2.0.0', source: { source: 'local' } },
    { pluginId: 'unavailable@crew-fixture', enabled: false, version: '1.0.0', source: { source: 'local' } },
  ], available: [{ pluginId: 'catalog-only@crew-fixture' }] }));
  process.exit(0);
}
const option = name => args[args.indexOf(name) + 1];
const prompt = readFileSync(0, 'utf8');
const assignment = JSON.parse(prompt.split('\n').at(-1));
const prefix = args.find(arg => /^mcp_servers\.crew_workflow(?:_inputs)?\.command=/.test(arg)).split('command=')[0];
const crewServer = prefix.split('.')[1];
const server = spawn(config(prefix + 'command'), config(prefix + 'args'), { stdio: ['pipe', 'pipe', 'inherit'] });
const replies = createInterface({ input: server.stdout })[Symbol.asyncIterator]();
const event = value => process.stdout.write(JSON.stringify(value) + '\n');
let requestId = 0;
const send = async (method, params) => {
  const id = ++requestId;
  server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  const { value } = await replies.next();
  const reply = JSON.parse(value);
  assert.equal(reply.id, id);
  return reply;
};
const invoke = async (tool, args) => {
  const { result } = await send('tools/call', { name: tool, arguments: args });
  assert.equal(result?.isError, undefined);
  event({ type: 'item.completed', item: { type: 'mcp_tool_call', server: crewServer, tool, status: 'completed' } });
  return JSON.parse(result.content[0].text);
};

try {
  event({ type: 'thread.started', thread_id: 'synthetic-workflow-thread' });
  event({ type: 'item.completed', item: { type: 'agent_message', text: 'I’ll inspect the <timing notes> first.' } });
  event({ type: 'item.completed', item: { type: 'reasoning', text: 'Private fixture reasoning must stay out of activity.' } });
  const manifest = await send('initialize', { protocolVersion: '2025-06-18' });
  assert.equal(manifest.result.protocolVersion, '2025-06-18');
  const { result: { tools } } = await send('tools/list');
  assert.deepEqual(tools.map(tool => tool.name), config(prefix + 'enabled_tools'));
  const inputs = await invoke('list_inputs', {});
  const matches = await invoke('search_inputs', { query: 'timing' });
  assert.ok(matches.some(match => match.id === inputs[0].id));
  const observed = await invoke('read_input', { id: inputs[0].id });
  event({ type: 'item.completed', item: { type: 'agent_message', text: 'I found the pinned timing evidence.' } });
  assert.ok(observed.text.includes('timing'));
  const inaccessible = await send('tools/call', { name: 'read_input', arguments: { id: '../../unbound-file' } });
  assert.equal(inaccessible.result.isError, true);
  const skill = await invoke('read_skill', { id: assignment.skills[0].id });
  const stagedPath = join(option('--cd'), assignment.skills[0].manifestPath ?? '.agents/skills/' + assignment.skills[0].id + '/SKILL.md');
  const staged = readFileSync(stagedPath, 'utf8');
  assert.ok(staged.includes('description:'));
  if (skill.files) {
    assert.equal(staged, skill.instructions);
    for (const path of skill.files) {
      const file = await invoke('read_skill_file', { id: assignment.skills[0].id, path });
      const bytes = file.encoding === 'base64' ? Buffer.from(file.data, 'base64') : Buffer.from(file.text, 'utf8');
      assert.deepEqual(readFileSync(join(dirname(stagedPath), path)), bytes);
    }
  } else assert.ok(staged.includes(skill.name));
  if (args.includes('default_permissions="crew-workspace"')) {
    assert.equal(assignment.assignment.permissions.workspace, 'workspace-write');
    const local = assignment.inputs.find(input => input.id === observed.id);
    assert.equal(readFileSync(join(option('--cd'), local.path), 'utf8'), observed.text);
    assert.ok(args.includes('--enable') && args.includes('shell_tool'));
    writeFileSync(join(option('--cd'), 'timing-notes.txt'), 'Reviewed ' + observed.id);
    event({ type: 'item.completed', item: { type: 'command_execution', status: 'completed', exit_code: 0,
      command: 'node --test ' + join(option('--cd'), 'test.mjs'), duration_ms: 12,
      aggregated_output: 'omitted' + 'x'.repeat(4000) + '\x1b[32m\r\nTests passed\x1b[0m\n' } });
    event({ type: 'item.completed', item: { type: 'file_change', status: 'completed' } });
  }
  if (args.includes('web_search="cached"')) {
    assert.equal(assignment.assignment.permissions.webSearch, 'cached');
    event({ type: 'item.completed', item: { type: 'web_search', query: 'music timing' } });
  }
  const permissions = assignment.assignment.permissions;
  if (permissions.imageInspection) assert.ok(args.includes('view_image') && args[args.indexOf('view_image') - 1] === '--enable');
  if (permissions.delegation) {
    assert.equal(config('agents.enabled'), true);
    assert.equal(config('agents.max_concurrent_threads_per_session'), permissions.delegation.maxConcurrent);
    assert.equal(config('agents.default_subagent_model'), permissions.delegation.model);
    assert.equal(config('agents.default_subagent_reasoning_effort'), permissions.delegation.reasoningEffort);
    for (const name of permissions.subagentRoles ?? []) {
      const path = config('agents.' + name + '.config_file');
      assert.ok(path.endsWith('/subagents/' + name + '.toml'));
      assert.equal(config('agents.' + name + '.description'), 'Review the timing independently.');
      assert.match(readFileSync(path, 'utf8'), /developer_instructions = "Use the slow tāḷa reference\.\\nGive feedback\."/);
    }
    const receiver_thread_ids = ['31c8f914-2370-45ee-8e60-a62bbf6680bd'];
    for (const [type, tool, id, status] of [
      ['item.started', 'spawn_agent', 'spawn-fixture', 'in_progress'],
      ['item.completed', 'spawn_agent', 'spawn-fixture', 'completed'],
      ['item.started', 'wait', 'unfinished-fixture', 'in_progress'],
    ]) event({ type, item: { type: 'collab_tool_call', id, tool, receiver_thread_ids, status } });
  }
  if (assignment.assignment.permissions.codexMcpServers?.includes('lesson-timing')) {
    assert.ok(!args.includes('--ignore-user-config'));
    assert.equal(config('mcp_servers.crew_workflow.enabled'), false);
    assert.equal(config('mcp_servers.unused-server.enabled'), false);
    event({ type: 'item.completed', item: { type: 'mcp_tool_call', server: 'lesson-timing', tool: 'inspect_tempo', status: 'completed' } });
  }
  if (assignment.assignment.permissions.codexPlugins?.includes('tempo@crew-fixture')) {
    const overrides = args.find(arg => arg.startsWith('plugins='));
    assert.match(overrides, /"tempo@crew-fixture"=\{"enabled"=true\}/);
    assert.match(overrides, /"extra@crew-fixture"=\{"enabled"=false\}/);
    assert.match(overrides, /"catalog-only@crew-fixture"=\{"enabled"=false\}/);
    if (!assignment.assignment.permissions.codexMcpServers?.includes('lesson-timing'))
      assert.equal(config('mcp_servers.lesson-timing.enabled'), false);
    event({ type: 'item.completed', item: { type: 'mcp_tool_call', server: 'tempo-fixture', tool: 'tempo_tool', status: 'completed' } });
  }
  if (permissions.codexApps?.some(app => app.id === 'connector_music_fixture')) {
    assert.ok(args.includes('--enable') && args[args.indexOf('apps') - 1] === '--enable');
    for (const setting of ['apps._default.enabled=false', 'apps.connector_music_fixture.enabled=true',
      'apps.connector_unselected_fixture.enabled=false', 'apps.connector_explicit_fixture.enabled=false']) assert.ok(args.includes(setting));
    event({ type: 'item.completed', item: { type: 'mcp_tool_call', server: 'codex_apps', tool: 'music_notes.read_excerpt', status: 'completed' } });
  }
  for (const attachment of assignment.assignment.permissions.projectMcp ?? []) {
    assert.equal(attachment.id, 'timing');
    assert.equal(attachment.version, 1);
    const setting = args.find(arg => /^mcp_servers\.crew_[a-f0-9]+_timing\.(?:command|url)=/.test(arg));
    assert.ok(setting);
    const serverName = setting.split('.')[1];
    if (setting.includes('.command=')) assert.equal(config('mcp_servers.' + serverName + '.command'), 'timing-fixture');
    else assert.equal(config('mcp_servers.' + serverName + '.url'), 'http://127.0.0.1:4197/mcp');
    event({ type: 'item.completed', item: { type: 'mcp_tool_call', server: serverName, tool: 'inspect_tempo', status: 'completed' } });
  }
  const result = { state: 'completed', summary: 'Used pinned timing evidence and ' + skill.name,
    outputs: assignment.assignment.outputs.map(slot => ({ slot: slot.id, content: observed.text })),
    decisions: [], questions: [], blockers: [], resourceRequests: [] };
  writeFileSync(option('--output-last-message'), JSON.stringify(result));
  event({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(result) } });
  event({ type: 'turn.completed', usage: { input_tokens: 19, output_tokens: 7 } });
} finally { server.stdin.end(); }
