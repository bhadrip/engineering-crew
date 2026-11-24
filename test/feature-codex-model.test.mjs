import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { callFeatureCodex, codexModelCatalog, defaultCodexModel } from '../lib/feature-codex.mjs';

async function fakeCli(t) {
  const dir = await mkdtemp(join(tmpdir(), 'crew-codex-catalog-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fixture = join(dir, 'codex');
  const file = JSON.stringify(join(dir, 'calls.jsonl'));
  await writeFile(fixture, `#!${process.execPath}
const fs = require('node:fs');
const readline = require('node:readline');
const args = process.argv.slice(2);
const send = message => console.log(JSON.stringify(message));
fs.appendFileSync(${file}, JSON.stringify(args) + '\\n');
if (args[0] === 'app-server') {
  readline.createInterface({input: process.stdin}).on('line',line => {
    const m = JSON.parse(line);
    if (m.method === 'initialize') return send({id:m.id, result:{}});
    const mode = process.env.CREW_FIXTURE;
    if (m.method !== 'model/list' || mode === 'timeout') return;
    if (m.params.modelProvider !== 'openai' || m.params.includeHidden !== false) return send({id:m.id,error:{}});
    if (mode === 'empty') return send({id:m.id,result:{data:[],nextCursor:null}});
    if (!m.params.cursor) return send({id:m.id,result:{data:[{model:'alternate-model',
      ...(mode === 'speed' ? {additionalSpeedTiers:['priority']} : {})}],nextCursor:'next'}});
    if (mode === 'malformed') return send({id:m.id,result:{data:{}}});
    if (mode === 'invalid-default') return send({id:m.id,result:{data:[{model:'--flag',isDefault:true}]}});
    if (mode === 'error') return send({id:m.id,error:{message:'Catalog unavailable'}});
    const defaults = mode === 'ambiguous' ? ['named-a','named-b'] : ['catalog-model'];
    const data = [...defaults.map(model => ({model,isDefault:true})), {model:'alternate-model'},
      {model:'reasoning:latest'}, {model:'hidden-model',hidden:true}, {model:'--flag'}, null];
    if (mode === 'speed') {
      data[0].serviceTiers = [{id:'priority', name:'Fast'}, {id:'ultrafast', name:'Ultrafast'}, {id:'default'}, {id:'--invalid'}];
      data.find(item => item?.hidden).serviceTiers = [{id:'priority'}];
    }
    send({id:m.id,result:{data,nextCursor:null}});
  });
} else {
  const schema = fs.readFileSync(args[args.indexOf('--output-schema')+1], 'utf8');
  fs.appendFileSync(${JSON.stringify(join(dir, 'schemas.jsonl'))}, schema + '\\n');
  const response = JSON.parse(schema).properties.action ? {
    action: 'edit', summary: 'Added the entry point', paths: [],
    changes: [{ action: 'write', path: 'server.mjs', content: 'export default 1' }],
  } : {};
  fs.writeFileSync(args[args.indexOf('--output-last-message')+1], JSON.stringify(response));
  send({type:'thread.started',thread_id:'00000000-0000-4000-8000-000000000099'});
  if (args.includes('role-model') && args.includes('--color') && process.env.RUST_LOG?.includes('codex_core::session')) {
    process.stderr.write('2026-11-24T03:54:04.584924Z  WARN codex_core::session: server reported model served-model while requested model was role-model\\n');
  }
  send({type:'turn.completed',model:'observed-model',usage:{input_tokens:3,output_tokens:1}});
}
`);
  await chmod(fixture, 0o700);
  return { dir, file: join(dir, 'calls.jsonl'), path: dir + delimiter + process.env.PATH };
}

test('catalog discovery follows pages and stops cleanly on ambiguous defaults, timeout or a missing CLI', async t => {
  const cli = await fakeCli(t);
  const resolve = (mode, timeoutMs = 2000) => defaultCodexModel({ cwd: cli.dir, env: { PATH: cli.path, CREW_FIXTURE: mode }, timeoutMs });
  assert.equal(await resolve('ok'), 'catalog-model');
  assert.equal(await resolve('ambiguous'), null);
  assert.equal(await resolve('timeout', 150), null);
  assert.equal(await defaultCodexModel({ cwd: cli.dir, env: { PATH: '/nonexistent' } }), null);
});

test('Codex receives the same edit-only bootstrap contract that Crew records for the engineer', async t => {
  const cli = await fakeCli(t);
  const previous = process.env.PATH;
  process.env.PATH = cli.path;
  t.after(() => { process.env.PATH = previous; });
  let config;
  const { receipt } = await callFeatureCodex({ role: 'engineer', model: 'role-model', prompt: 'Create the first file.',
    profile: { id: 'engineer', digest: 'test', tools: ['read', 'edit', 'test', 'finish'] },
    allowedActions: ['edit'],
    onEvent: async (_event, artifact) => {
      if (artifact?.input) config = artifact.input.config;
    },
  });
  const schema = JSON.parse(await readFile(join(cli.dir, 'schemas.jsonl'), 'utf8'));
  assert.deepEqual(config.outputSchema, schema);
  assert.deepEqual(config.agentActions, ['edit']);
  assert.deepEqual(schema.properties.action.enum, ['edit']);
  assert.ok(schema.properties.changes.minItems >= 1);
  assert.deepEqual(schema.properties.changes.items.properties.action.enum, ['write']);
  assert.equal(receipt.workspaceAction, 'edit');
});

test('the project catalog lists visible valid IDs, preserves a missing default and discards partial results on error', async t => {
  const cli = await fakeCli(t);
  const catalog = mode => codexModelCatalog({ cwd: cli.dir, env: { PATH: cli.path, CREW_FIXTURE: mode } });
  assert.deepEqual(await catalog('ok'), { defaultModel: 'catalog-model', models: ['alternate-model','catalog-model','reasoning:latest'] });
  assert.deepEqual(await catalog('ambiguous'), { defaultModel: null, models: ['alternate-model','named-a','named-b','reasoning:latest'] });
  assert.deepEqual(await catalog('empty'), { defaultModel: null, models: [] });
  assert.deepEqual((await catalog('speed')).serviceTiers, {
    'alternate-model': [{ id: 'priority', name: 'Fast' }],
    'catalog-model': [{ id: 'priority', name: 'Fast' }, { id: 'ultrafast', name: 'Ultrafast' }],
  });
  for (const mode of ['malformed','invalid-default','error']) assert.equal(await catalog(mode), null);
  assert.equal(await codexModelCatalog({ signal: AbortSignal.abort() }), null);
  assert.ok((await readFile(cli.file, 'utf8')).trim().split('\n').map(JSON.parse).every(argv => argv[0] === 'app-server'));
});

test('exec explicitly requests a role model or the cached catalog default and retains a different reported model', async t => {
  const cli = await fakeCli(t);
  const previous = process.env.PATH;
  process.env.PATH = cli.path;
  t.after(() => { process.env.PATH = previous; });
  const events = [], artifacts = [];
  const input = { role: 'qa', prompt: 'Inspect the lesson.\n{"source":"ठीक"}', profile: {
    id: 'qa-music', digest: 'test', instructions: 'Check playback', tools: ['read', 'independent-tests'],
    access: 'read-only', network: 'none', workerImage: 'node:22-alpine',
  }, onEvent: async (event, artifact) => { events.push(event); if (artifact) artifacts.push(artifact); } };
  const configured = await callFeatureCodex({ ...input, model: 'role-model' });
  const discovered = await callFeatureCodex(input);
  await callFeatureCodex(input);
  assert.equal(configured.receipt.model, 'role-model');
  assert.equal(configured.receipt.modelSelection, 'configured');
  assert.equal(configured.receipt.reportedModel, 'served-model');
  assert.equal(configured.receipt.reportedModelSource, 'codex-response');
  const [{ input: saved }, { output: answer }] = artifacts;
  assert.equal(saved.digest, configured.receipt.inputDigest);
  assert.equal(saved.prompt, input.prompt);
  assert.equal(saved.promptSha256, createHash('sha256').update(input.prompt).digest('hex'));
  assert.equal(saved.config.profileInstructions, 'Check playback');
  assert.equal(saved.config.requestedModel, 'role-model');
  assert.deepEqual(saved.config.controllerActions, input.profile.tools);
  assert.deepEqual(saved.config.agentActions, []);
  assert.deepEqual(saved.config.nativeTools, []);
  assert.equal(saved.config.outputSchema.properties.testSource.type, 'string');
  assert.equal(configured.receipt.outputDigest, answer.digest);
  assert.equal(answer.raw, '{}');
  assert.equal(events[0].evidence.callId, configured.receipt.callId);
  assert.ok(!JSON.stringify(events).includes('Inspect the lesson'));
  assert.equal(discovered.receipt.model, 'catalog-model');
  assert.equal(discovered.receipt.modelSelection, 'catalog-default');
  assert.equal(discovered.receipt.reportedModel, 'observed-model');
  assert.equal(discovered.receipt.reportedModelSource, 'codex-json');
  const calls = (await readFile(cli.file, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.filter(argv => argv[0] === 'app-server').length, 1);
  const actual = calls.find(args => args.includes('exec'));
  const temporary = actual[actual.indexOf('--cd') + 1];
  assert.deepEqual(saved.config.launch.args, actual.map(arg => arg.startsWith(temporary) ? '$RUN_DIR' + arg.slice(temporary.length) : arg));
  assert.deepEqual(calls.filter(argv => argv.includes('exec')).map(argv => argv[argv.indexOf('--model') + 1]),
    ['role-model', 'catalog-model', 'catalog-model']);
});
