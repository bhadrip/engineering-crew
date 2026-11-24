import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { codexModelLogFilter, codexModelTelemetry } from '../lib/feature-codex-telemetry.mjs';

const thread = '01934111-b1de-7332-af53-019ec9cf2e95';
const other = '01934222-b1de-7332-af53-019ec9cf2e95';
const time = '2026-11-24T03:54:05.121338Z';
const equal = time + '  INFO codex_core::session: server reported model model-2026-01 (matches requested model)';
const rerouted = time + '  WARN codex_core::session: server reported model model-2026-01 while requested model was default-alias';

test('native model diagnostics survive stderr chunking, duplicate reports, and an unterminated final line', () => {
  for (const line of [equal, rerouted]) {
    const probe = codexModelTelemetry();
    for (const char of line) probe.write(char);
    probe.write('\n' + line);
    probe.thread(thread);
    assert.equal(probe.finish(thread), 'model-2026-01');
  }
});

test('other targets, payloads, malformed model IDs and oversized lines provide no evidence', () => {
  const probe = codexModelTelemetry();
  probe.thread(thread);
  probe.write([
    equal.replace('::session:', '::session::turn:'),
    rerouted.replace('WARN', 'INFO'),
    equal.replace('model-2026-01', 'model with spaces'),
    JSON.stringify({ type: 'item.completed', text: equal }),
    equal + ' extra',
    'x'.repeat(2000),
  ].join('\n'));
  probe.write(equal + '\n');
  assert.equal(probe.finish(thread), null);
  probe.write(equal + '\n');
  assert.equal(probe.finish(thread), 'model-2026-01');
});

test('one valid native thread and one unambiguous server model are required for attribution', () => {
  for (const [observed, expected] of [[[], thread], [[thread], other], [['untrusted'], 'untrusted'], [[thread, other], other]]) {
    const probe = codexModelTelemetry();
    for (const id of observed) probe.thread(id);
    probe.write(rerouted + '\n');
    assert.equal(probe.finish(expected), null);
  }
  const conflict = codexModelTelemetry();
  conflict.thread(thread);
  conflict.write(equal + '\n' + rerouted.replace('model-2026-01', 'other-model'));
  assert.equal(conflict.finish(thread), null);
  const absent = codexModelTelemetry();
  absent.thread(thread);
  assert.equal(absent.finish(thread), null);
});

// Opt in with an absolute path to the real CLI to detect changes to its
// diagnostic format. All inference is synthetic and served on loopback.
const cli = process.env.CREW_TEST_NATIVE_CODEX;
test('installed Codex distinguishes matching, changed and missing provider model headers', { skip: !cli }, async t => {
  assert.ok(isAbsolute(cli));
  const dir = await mkdtemp(join(tmpdir(), 'crew-test-native-model-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const home = join(dir, 'codex');
  await mkdir(home, { mode: 0o700 });
  const requested = 'gpt-5.4';
  let served, calls = 0;
  const server = createServer((req, res) => {
    req.resume();
    if (req.method !== 'POST' || req.url !== '/v1/responses') return res.writeHead(404).end();
    calls++;
    res.writeHead(200, { 'content-type': 'text/event-stream', ...(served ? { 'openai-model': served } : {}) });
    const item = { id: 'msg_local', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ok' }] };
    const response = { id: 'resp_local', model: 'body-only-model' };
    for (const event of [
      { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
      { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: item.id, delta: 'ok' },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { ...response, status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ]) res.write('event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n');
    res.end();
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = 'http://127.0.0.1:' + server.address().port + '/v1';
  const config = ['analytics.enabled=false', 'web_search="disabled"', 'project_doc_max_bytes=0', 'model_provider="fixture"',
    'model_providers.fixture.name="Loopback fixture"', 'model_providers.fixture.base_url=' + JSON.stringify(base),
    'model_providers.fixture.wire_api="responses"', 'model_providers.fixture.supports_websockets=false',
    'model_providers.fixture.requires_openai_auth=false', 'model_providers.fixture.request_max_retries=0',
    'model_providers.fixture.stream_max_retries=0'];
  const args = ['--ask-for-approval', 'never', 'exec', '--sandbox', 'read-only', '--color', 'never', '--cd', dir,
    '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--json', '--model', requested,
    ...['hooks', 'plugins', 'shell_tool', 'multi_agent'].flatMap(feature => ['--disable', feature]),
    ...config.flatMap(setting => ['-c', setting]), '-'];
  const env = { PATH: process.env.PATH, HOME: dir, CODEX_HOME: home, RUST_LOG: codexModelLogFilter,
    HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', NO_PROXY: '127.0.0.1,localhost' };
  for (served of [requested, 'different-served-model', null]) {
    const run = promisify(execFile)(cli, args, { cwd: dir, env, timeout: 15_000, maxBuffer: 256_000 });
    run.child.stdin.end('Reply ok.');
    const { stdout, stderr } = await run;
    const events = stdout.trim().split('\n').map(JSON.parse);
    const started = events.filter(e => e.type === 'thread.started');
    assert.equal(started.length, 1);
    assert.ok(events.some(e => e.type === 'turn.completed'));
    const telemetry = codexModelTelemetry();
    telemetry.thread(started[0].thread_id);
    telemetry.write(stderr);
    assert.equal(telemetry.finish(started[0].thread_id), served);
  }
  assert.equal(calls, 3);
});
