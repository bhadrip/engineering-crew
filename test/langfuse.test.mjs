import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { langfuseConfig, langfuseSpan, publishLangfuse, verifiedTraceLink } from '../lib/langfuse.mjs';
import { publishFeatureTrace, verifiedFeatureTraceLink } from '../lib/feature-langfuse.mjs';
import { attachQaTrace } from '../lib/feature-qa-trace.mjs';
import { artifact } from '../lib/run-store.mjs';
import { memoryRunStore, postgres, testDatabase } from '../test-support/stores.mjs';
import { createFeature, getFeature, runFeature } from '../lib/feature-controller.mjs';
import { publishAttemptTrace, summarize } from '../lib/workflow.mjs';
import { featureRequestPage } from '../ui/feature-views.mjs';

const attemptId = '8b0f38cd-24ca-4d34-bc2b-0dbdcf5f6154';
const threadId = 'ee19f80c-77f0-4646-9d84-692a8586eac2';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'crew-trace-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'checkout');
  const gitDir = join(root, '.git');
  await mkdir(gitDir, { recursive: true });
  const location = join(directory, 'credentials.json');
  await writeFile(location, JSON.stringify({ public_key: 'pk-lf-test', secret_key: 'sk-lf-test' }), { mode: 0o600 });
  const run = { id: 'run-1', project: { id: 'pet-store' }, epic: { id: 'epic-1' }, sourceCommit: 'a'.repeat(40),
    profiles: [{ id: 'product', name: 'Product Manager' }], tasks: [], artifacts: [] };
  const receipt = { runId: run.id, taskId: 'review', attemptId, threadId, sourceCommit: run.sourceCommit, outcome: 'completed',
    usage: { input: 42, output: 11, total: 53 }, unexpectedText: 'private transcript fixture' };
  const record = artifact('receipt-1', 'Codex execution receipt', 'json', JSON.stringify(receipt), { source: 'runtime', attemptId });
  const attempt = { id: attemptId, number: 1, outcome: 'completed', receiptId: record.id,
    startedAt: '2026-11-04T07:49:48.743Z', endedAt: '2026-11-04T07:50:05.629Z' };
  const task = { packet: { id: 'review', profileId: 'product', budget: { targetTotalTokens: 100 } }, attempts: [attempt] };
  run.tasks.push(task);
  run.artifacts.push(record);
  const store = memoryRunStore();
  await store.create(run);
  return { control: { root, gitDir }, store, run, task, attempt, record, receipt,
    env: { CREW_LANGFUSE_URL: 'http://127.0.0.1:3312', CREW_LANGFUSE_PROJECT_ID: 'test-project', CREW_LANGFUSE_CREDENTIALS_FILE: location } };
}

async function api(t, behavior) {
  const requests = [];
  const traces = new Map();
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    requests.push({ path: url.pathname, headers: request.headers });
    let data;
    if (url.pathname === '/api/public/projects') {
      data = { data: [{ id: behavior.wrongProject ? 'another-project' : 'test-project' }] };
    } else if (url.pathname === '/api/public/otel/v1/traces') {
      let body = '';
      for await (const chunk of request) body += chunk;
      requests.at(-1).body = body;
      const spans = JSON.parse(body).resourceSpans[0].scopeSpans[0].spans;
      traces.set(spans[0].traceId, spans);
      data = {};
    } else {
      const spans = traces.get(url.searchParams.get('traceId')) ?? [];
      const all = behavior.extraObservations?.get(url.searchParams.get('traceId')) ?? spans.filter(span => !behavior.omitChildren || !span.parentSpanId).map(span => {
        const attributes = Object.fromEntries(span.attributes.map(attribute => [attribute.key, attribute.value.stringValue]));
        const metadata = Object.fromEntries(Object.entries(attributes).filter(([key]) => key.startsWith('langfuse.observation.metadata.'))
          .map(([key, value]) => [key.split('.').at(-1), value]));
        if (behavior.wrongDigest) metadata.receiptSha256 = '0'.repeat(64);
        if (behavior.wrongThread && span.parentSpanId) metadata.codexThreadId = attemptId;
        return { id: span.spanId, traceId: span.traceId, projectId: 'test-project', name: span.name, parentObservationId: span.parentSpanId,
          model: behavior.wrongModel ? 'another-model' : attributes['langfuse.observation.model.name'] ?? attributes['gen_ai.request.model'],
          usageDetails: JSON.parse(attributes['langfuse.observation.usage_details'] ?? '{}'),
          startTime: new Date(Number(BigInt(span.startTimeUnixNano) / 1_000_000n)).toISOString(),
          endTime: new Date(Number(BigInt(span.endTimeUnixNano) / 1_000_000n)).toISOString(),
          input: attributes['langfuse.observation.input'], output: attributes['langfuse.observation.output'], metadata };
      });
      const offset = Number(url.searchParams.get('cursor') ?? 0);
      const end = offset + Number(url.searchParams.get('limit'));
      data = { data: all.slice(offset, end), meta: { cursor: end < all.length ? String(end) : null } };
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(data));
  }).listen(0, '127.0.0.1');
  t.after(() => server.close());
  await once(server, 'listening');
  return { origin: `http://127.0.0.1:${server.address().port}`, requests };
}

test('publishes only receipt metadata and exposes a link after a matching observation is read back', async t => {
  const source = await fixture(t);
  const behavior = {};
  const destination = await api(t, behavior);
  source.env.CREW_LANGFUSE_URL = destination.origin;
  assert.equal(summarize(await source.store.read()).tasks[0].attempts[0].trace, undefined);
  const trace = await publishAttemptTrace(source.store, source.control, 'review', attemptId, source.env);
  const [, , ingestion, verification] = destination.requests;
  assert.equal(ingestion.headers['x-langfuse-ingestion-version'], '4');
  assert.match(ingestion.body, /"tokens_total"|metadata\.tokens_total/);
  assert.doesNotMatch(ingestion.body, /private transcript fixture|pk-lf-test|sk-lf-test/);
  const { attributes } = JSON.parse(ingestion.body).resourceSpans[0].scopeSpans[0].spans[0];
  const preview = key => JSON.parse(attributes.find(attribute => attribute.key === `langfuse.observation.${key}`).value.stringValue);
  assert.equal(preview('input').task, 'review');
  assert.equal(preview('output').outcome, 'completed');
  assert.equal(preview('output').reportedTokens.total, 53);
  assert.equal(verification.path, '/api/public/v2/observations');
  assert.equal(trace.receiptDigest, source.record.digest);
  assert.equal(verifiedTraceLink(summarize(await source.store.read()).tasks[0].attempts[0].trace), trace.url);
  assert.equal(verifiedTraceLink({ ...trace, url: trace.url.replace(destination.origin, 'https://outside.invalid') }), null);

  const again = await publishAttemptTrace(source.store, source.control, 'review', attemptId, source.env);
  assert.equal(again.url, trace.url);
  assert.equal(destination.requests.filter(request => request.path === '/api/public/otel/v1/traces').length, 1);

  behavior.wrongProject = true;
  await assert.rejects(publishAttemptTrace(source.store, source.control, 'review', attemptId, source.env), /configured project/);
  assert.equal(verifiedTraceLink(summarize(await source.store.read()).tasks[0].attempts[0].trace), trace.url);

  await source.store.update(run => { run.artifacts[0].content = '{}'; });
  assert.equal(summarize(await source.store.read()).tasks[0].attempts[0].trace.status, 'unverified');
});

test('rejects a different project before upload and rejects a mismatched receipt after upload', async t => {
  const source = await fixture(t);
  const behavior = { wrongProject: true };
  const destination = await api(t, behavior);
  source.env.CREW_LANGFUSE_URL = destination.origin;
  const config = await langfuseConfig(source.control, source.env);
  const span = langfuseSpan(source, config.projectId);
  await assert.rejects(publishLangfuse(config, span), /configured project/);
  assert.deepEqual(destination.requests.map(request => request.path), ['/api/public/projects']);
  behavior.wrongProject = false;
  behavior.wrongDigest = true;
  await assert.rejects(publishLangfuse(config, span, { retries: 0 }), /could not be verified/);
});

test('publishes opted-in prompt, final reply and Docker observations for the selected attempt', async t => {
  const source = await fixture(t);
  const behavior = {};
  const destination = await api(t, behavior);
  source.env.CREW_LANGFUSE_URL = destination.origin;
  const publish = options => publishAttemptTrace(source.store, source.control, 'review', attemptId, source.env, options);
  const options = { includeActivity: true };
  await assert.rejects(publish(options), /no captured prompt and response/);
  assert.equal(destination.requests.length, 0);

  const activity = { prompt: 'Exact assignment\nwith a trailing newline\n', response: '{ "state": "completed" }\n', toolCalls: [] };
  const checks = { testedCommit: 'b'.repeat(40), image: 'pinned-image', checks: [{
    id: 'usage-error', command: ['node', 'hello.mjs', 'one', 'two'], startedAt: source.attempt.startedAt, endedAt: source.attempt.endedAt,
    observed: { stdout: '', stderr: 'Usage\n', exitCode: 1 }, passed: true,
  }] };
  const provenance = { source: 'runtime', attemptId };
  const activityRecord = artifact('activity-1', 'Codex activity', 'json', JSON.stringify(activity), provenance);
  const checkRecord = artifact('check-1', 'Docker receipt', 'json', JSON.stringify(checks), provenance);
  await source.store.update(run => {
    run.tasks[0].packet.title = 'Independent QA';
    Object.assign(run.tasks[0].attempts[0], { activityId: activityRecord.id, runnerArtifacts: { 'check-receipt': checkRecord.id } });
    run.artifacts.push(activityRecord, checkRecord);
  });
  const receiptTrace = await publish();
  assert.doesNotMatch(destination.requests.find(request => request.body).body, /Exact assignment|usage-error/);
  const trace = await publish(options);
  assert.notEqual(trace.url, receiptTrace.url);
  const ingested = destination.requests.filter(request => request.body).at(-1).body;
  assert.doesNotMatch(ingested, /private transcript fixture|pk-lf-test|sk-lf-test/);
  const [root, docker] = JSON.parse(ingested).resourceSpans[0].scopeSpans[0].spans;
  const preview = (span, key) => JSON.parse(span.attributes.find(attribute => attribute.key === `langfuse.observation.${key}`).value.stringValue);
  assert.equal(preview(root, 'input'), activity.prompt);
  assert.equal(preview(root, 'output'), activity.response);
  assert.equal(docker.parentSpanId, root.spanId);
  assert.deepEqual(preview(docker, 'input').command, checks.checks[0].command);
  assert.deepEqual(preview(docker, 'output'), { ...checks.checks[0].observed, passed: true });
  assert.deepEqual(trace.activityDigests, { [activityRecord.id]: activityRecord.digest, [checkRecord.id]: checkRecord.digest });

  const config = await langfuseConfig(source.control, source.env);
  const run = await source.store.read();
  const span = langfuseSpan({ ...source, task: run.tasks[0], activity, checks, activityDigests: trace.activityDigests }, config.projectId);
  behavior.omitChildren = true;
  await assert.rejects(publishLangfuse(config, span, { retries: 0 }), /could not be verified/);
  await publish();
  assert.equal(verifiedTraceLink(summarize(await source.store.read()).tasks[0].attempts[0].trace), trace.url);
  await source.store.update(run => { run.artifacts.find(value => value.id === checkRecord.id).content = '{}'; });
  assert.equal(summarize(await source.store.read()).tasks[0].attempts[0].trace.status, 'unverified');
});

test('credentials are restricted to a private file outside the checkout and an explicit loopback URL', async t => {
  const source = await fixture(t);
  await assert.rejects(langfuseConfig(source.control, { ...source.env, CREW_LANGFUSE_URL: 'https://outside.invalid' }), /loopback/);
  await chmod(source.env.CREW_LANGFUSE_CREDENTIALS_FILE, 0o644);
  await assert.rejects(langfuseConfig(source.control, source.env), /private regular JSON file/);
  const inside = join(source.control.root, 'credentials.json');
  await writeFile(inside, JSON.stringify({ public_key: 'pk-lf-test', secret_key: 'sk-lf-test' }), { mode: 0o600 });
  await assert.rejects(langfuseConfig(source.control, { ...source.env, CREW_LANGFUSE_CREDENTIALS_FILE: inside }), /outside the checkout/);
});

test('allows captured delegation and attached server calls when the receipt records their configuration', async t => {
  const source = await fixture(t);
  source.run.project.id = 'music-transcribe';
  const policy = {
    delegation: { maxConcurrent: 2 }, workspace: 'read-only', mcp: ['read_input'],
    codexMcpServers: ['host-timing'], projectMcp: [{ server: 'project-timing' }], pluginMcpServers: ['plugin-timing'],
  };
  const call = (server, tool, more = {}) => ({ server, tool, status: 'completed', ...more });
  const activity = { prompt: 'Inspect the lesson.', response: 'Done.', toolCalls: [
    call('crew_workflow_inputs', 'read_input'), call('host-timing', 'lookup'), call('project-timing', 'lookup'),
    call('plugin-timing', 'lookup', { source: 'plugin' }),
    call('codex', 'spawn_agent', { source: 'subagent', subagentIds: [attemptId] }),
    call('codex', 'wait', { source: 'subagent', status: 'incomplete' }),
  ] };
  const receipt = { ...source.receipt, toolProtocol: 'crew_workflow_inputs', toolPolicy: policy };
  const args = { ...source, receipt, activity, activityDigests: { activity: 'fixture' } };
  assert.ok(langfuseSpan(args, 'test-project').activityDigest);
  assert.throws(() => langfuseSpan({ ...args, receipt: { ...receipt, toolPolicy: { ...policy, delegation: undefined } } }, 'test-project'),
    /Captured activity does not match/);
  activity.toolCalls.push(call('unattached', 'lookup'));
  assert.throws(() => langfuseSpan(args, 'test-project'), /Captured activity does not match/);
});

function featureFixture(count) {
  const record = { id: 'lesson-replay', projectId: 'music', status: 'blocked', goal: 'private request contents',
    startedAt: '2026-11-04T07:49:00.000Z', endedAt: '2026-11-04T07:55:00.000Z' };
  const events = Array.from({ length: count }, (_, i) => {
    const start = Date.parse(record.startedAt) + i * 1000;
    const receipt = { threadId: 'ee19f80c-77f0-4646-9d84-' + String(i + 1).padStart(12, '0'), role: 'engineer', model: 'codex default',
      startedAt: new Date(start).toISOString(), endedAt: new Date(start + 750).toISOString(), usage: { input_tokens: 42, output_tokens: 5 },
      prompt: 'private model prompt', answer: 'private model reply', source: 'private file contents' };
    if (i === 1 || i === 2) receipt.model = 'gpt-requested';
    if (i === 2) Object.assign(receipt, { reportedModel: 'gpt-reported', reportedModelSource: 'codex-json', modelSelection: 'catalog-default' });
    if (i === 3) Object.assign(receipt, { model: 'gpt-selected', modelSelection: 'configured' });
    return { featureId: record.id, seq: i + 2, operationId: 'lesson-replay:engineer:1', phase: 'build', role: 'engineer',
      type: 'agent.completed', attempt: 1, evidence: receipt };
  });
  events.push({ ...events.at(-1), seq: count + 2, type: 'task.completed', evidence: { receipt: events.at(-1).evidence } });
  return { record, events };
}

function featureDatabase(record, events) {
  const client = new EventEmitter();
  client.release = () => {};
  client.query = async (sql, params) => {
    if (sql.startsWith('SELECT pg_advisory_')) return { rows: [] };
    if (sql.startsWith('SELECT')) return { rows: [{ record, events }] };
    assert.match(sql, /SET record=record \|\| \$3::jsonb/);
    Object.assign(record, params[2]);
    return { rowCount: 1 };
  };
  return { connect: async () => client };
}

test('feature export verifies every measured call across pages and reuses its receipt-only trace', async t => {
  const source = await fixture(t);
  const behavior = {};
  const destination = await api(t, behavior);
  source.env.CREW_LANGFUSE_URL = destination.origin;
  const { record, events } = featureFixture(55);
  const db = featureDatabase(record, events);
  const publish = () => publishFeatureTrace(db, source.control, record.id, source.env, { retries: 0 });
  assert.equal(verifiedFeatureTraceLink({ ...record, events }), null);
  behavior.wrongProject = true;
  await assert.rejects(publish(), /configured project/);
  assert.equal(destination.requests.length, 1);
  behavior.wrongProject = false;

  const trace = await publish();
  assert.equal(trace.callCount, 55);
  assert.equal(trace.receiptDigest, '0fa2936afcfd3f937dec7b2c0c72a9c4c683488fdaa51b33bdd30be0c3327653');
  assert.equal(verifiedFeatureTraceLink({ ...record, events }), trace.url);
  const body = destination.requests.find(request => request.body).body;
  assert.doesNotMatch(body, /private (?:model|file|request)|pk-lf-|sk-lf-/);
  const spans = JSON.parse(body).resourceSpans[0].scopeSpans[0].spans;
  assert.equal(spans.length, 56);
  assert.equal(spans.filter(span => span.parentSpanId === trace.observationId && span.traceId === trace.traceId).length, 55);
  const usage = spans[1].attributes.find(a => a.key === 'langfuse.observation.usage_details');
  assert.deepEqual(JSON.parse(usage.value.stringValue), { input: 42, output: 5, total: 47 });
  assert.equal(spans[1].attributes.some(a => a.key === 'langfuse.observation.model.name'), false);
  assert.equal(spans[2].attributes.some(a => a.key === 'langfuse.observation.model.name'), false);
  assert.equal(spans[3].attributes.find(a => a.key === 'langfuse.observation.model.name').value.stringValue, 'gpt-reported');
  assert.equal(spans[3].attributes.find(a => a.key === 'langfuse.observation.metadata.requestedModel').value.stringValue, 'gpt-requested');
  assert.equal(spans[3].attributes.find(a => a.key === 'langfuse.observation.metadata.reportedBy').value.stringValue, 'codex-json');
  assert.equal(spans[4].attributes.find(a => a.key === 'gen_ai.request.model').value.stringValue, 'gpt-selected');
  assert.equal(spans[4].attributes.find(a => a.key === 'langfuse.observation.metadata.modelSource').value.stringValue, 'requested');
  assert.equal((await publish()).url, trace.url);
  assert.equal(destination.requests.filter(request => request.body).length, 1);

  behavior.wrongModel = true;
  await assert.rejects(publish(), /could not be verified/);
  behavior.wrongModel = false;
  behavior.wrongThread = true;
  await assert.rejects(publish(), /could not be verified/);
  assert.equal(verifiedFeatureTraceLink({ ...record, events, langfuseTrace: { ...trace, observationId: '1'.repeat(16) } }), null);
  events[0].evidence.usage.input_tokens++;
  assert.equal(verifiedFeatureTraceLink({ ...record, events }), null);
  events[0].featureId = 'different-feature';
  await assert.rejects(publish(), /invalid request/);
  record.status = 'running';
  await assert.rejects(publish(), /finished feature request/);
});

test('new feature traces show requested workspace actions and only recorded QA verdicts', async t => {
  const source = await fixture(t), destination = await api(t, {});
  source.env.CREW_LANGFUSE_URL = destination.origin;
  const { record, events } = featureFixture(2);
  events[0].evidence.workspaceAction = 'edit';
  events[1].evidence.workspaceAction = 'finish';
  const qa = { featureId: record.id, phase: 'verify', role: 'qa', attempt: 1 };
  events.push({ ...qa, seq: 5, type: 'task.started' },
    { ...qa, seq: 6, type: 'task.completed', evidence: { passed: false, checks: [
      { check: 'Author tests', passed: true }, { check: 'Independent QA tests', passed: false, evidence: 'private QA stdout' },
      { check: 'HTTP /health', passed: false }, { check: 'Operator acceptance test', status: 'skipped', reason: 'private QA detail' },
      { check: 'private QA check', passed: true },
    ] } }, { ...qa, attempt: 2, seq: 7, type: 'task.failed', evidence: { message: 'private QA error' } });
  const db = featureDatabase(record, events);
  const publish = () => publishFeatureTrace(db, source.control, record.id, source.env, { retries: 0 });
  const trace = await publish();
  const body = destination.requests.find(request => request.body).body;
  const [root, edit, finish] = JSON.parse(body).resourceSpans[0].scopeSpans[0].spans;
  const output = span => JSON.parse(span.attributes.find(a => a.key === 'langfuse.observation.output').value.stringValue);
  assert.equal(edit.name, 'engineer · attempt 1 · request edit · call #2');
  assert.equal(output(finish).requestedWorkspaceAction, 'finish');
  assert.deepEqual(output(root).qaAttempts, [{ attempt: 1, event: 6, result: 'failed', checks: [
    { check: 'Author tests', result: 'passed' }, { check: 'Independent QA tests', result: 'failed' },
    { check: 'HTTP /health', result: 'failed' }, { check: 'Operator acceptance test', result: 'skipped' },
  ] }, { attempt: 2, event: 7, result: 'stopped' }]);
  assert.doesNotMatch(body, /private (QA|model|file|request)/);
  assert.equal(verifiedFeatureTraceLink({ ...record, events }), trace.url);
  events.find(event => event.seq === 6).evidence.checks[0].passed = false;
  assert.equal(verifiedFeatureTraceLink({ ...record, events }), null);
  events[0].evidence.workspaceAction = 'untrusted action /private/path';
  await assert.rejects(publish(), /invalid workspace action/);
});

test('a post-run QA attachment binds its local trace to a tested revision and preserves the original run', { skip: !postgres }, async t => {
  const { db } = await testDatabase(t);
  const extraObservations = new Map(), destination = await api(t, { extraObservations });
  const source = await fixture(t);
  source.env.CREW_LANGFUSE_URL = destination.origin;
  const { record, events } = featureFixture(1);
  const revision = 'b'.repeat(40), receiptSha256 = '8'.repeat(64);
  const engineerTestEvent = events.at(-1).seq + 1, sourceAttempt = 1;
  events.push({ featureId: record.id, seq: engineerTestEvent, role: 'engineer', phase: 'build', attempt: sourceAttempt,
    type: 'tool.completed', evidence: { action: 'test', revision, passed: false } });
  await createFeature(db, { projectId: record.projectId, id: record.id, goal: record.goal });
  await db.query('UPDATE engineering_crew.features SET record=$2,last_seq=$3 WHERE id=$1', [record.id, record, engineerTestEvent]);
  for (const event of events) await db.query('INSERT INTO engineering_crew.feature_events (feature_id,seq,event) VALUES($1,$2,$3)', [record.id,event.seq,event]);
  const parent = await publishFeatureTrace(db, source.control, record.id, source.env);
  const before = await getFeature(db, record.id);
  const traceId = 'c'.repeat(32);
  const hash = suffix => createHash('sha256').update(traceId + suffix).digest('hex').slice(0,16);
  const scope = { projectId: record.projectId, featureId: record.id, revision, engineerTestEvent, sourceAttempt, parentTraceId: parent.traceId };
  const common = { traceId, projectId: 'test-project', startTime: record.endedAt, endTime: record.endedAt };
  const metadata = { ...scope, scope: 'post-run-independent-qa', receiptSha256 };
  const checks = [
    { check: 'Author tests', result: 'passed' }, { check: 'Independent QA tests', result: 'passed' },
    { check: 'HTTP /health', result: 'passed' }, { check: 'Operator acceptance test', result: 'failed',
      fixtures: [{ fixture: 'lesson', result: 'failed', fullRenditionMatched: false, sameAudio: true }] },
  ];
  const root = { ...common, id: hash(':diagnostic'), name: record.projectId + '/' + record.id + ' · post-run independent QA diagnostic',
    type: 'SPAN', metadata, input: { ...scope, parentTraceUrl: parent.url, requestStatus: 'blocked' }, output: { result: 'failed', checks } };
  const usage = { input: 30, output: 11, total: 41 };
  const call = { ...common, id: hash(':qa'), parentObservationId: root.id, name: 'QA agent · independent test generation', type: 'GENERATION',
    metadata: { ...metadata, modelSource: 'requested', codexThreadId: threadId }, model: 'gpt-6-luna', usageDetails: usage,
    input: { ...scope, role: 'qa', journalEvent: 3 }, output: { requestedModel: 'gpt-6-luna', modelSource: 'requested', threadId, durationMs: 0, usage } };
  extraObservations.set(traceId, [root,call]);
  const attach = () => attachQaTrace(db, source.control, record.id, traceId, source.env);
  root.input.featureId = 'another-feature';
  await assert.rejects(attach(), /different request/);
  root.input.featureId = record.id;
  root.input.revision = call.input.revision = 'c'.repeat(40);
  await assert.rejects(attach(), /no matching engineer test/);
  root.input.revision = call.input.revision = revision;
  call.parentObservationId = '0'.repeat(16);
  await assert.rejects(attach(), /root or QA generation/);
  call.parentObservationId = root.id;
  root.output.result = 'passed';
  await assert.rejects(attach(), /disagrees with its checks/);
  root.output.result = 'failed';
  root.output.checks.at(-1).fixtures[0].transcript = 'private fixture detail';
  assert.equal((await getFeature(db,record.id)).qaDiagnostic, undefined);
  const [saved, repeat] = await Promise.all([attach(),attach()]);
  assert.deepEqual(repeat, saved);
  assert.equal(saved.revision, revision);
  assert.equal(saved.result, 'failed');
  assert.equal(saved.model, 'gpt-6-luna');
  assert.equal(saved.modelSource, 'requested');
  assert.doesNotMatch(JSON.stringify(saved), /private fixture/);
  const after = await getFeature(db,record.id);
  assert.deepEqual(after.events, before.events);
  assert.equal(after.status, 'blocked');
  assert.equal(verifiedFeatureTraceLink(after), parent.url);
  assert.deepEqual(after.qaDiagnostic,saved);
});

test('publishing a feature preserves preview metadata and a later preview preserves its verified link', { skip: !postgres }, async t => {
  const { db } = await testDatabase(t);
  const source = await fixture(t), destination = await api(t, {});
  source.env.CREW_LANGFUSE_URL = destination.origin;
  const { record, events } = featureFixture(2);
  const request = await createFeature(db, { id: record.id, projectId: record.projectId, goal: record.goal });
  record.status = 'completed';
  record.previewStatus = 'pending';
  record.delivery = { revision: 'c'.repeat(40) };
  await db.query('UPDATE engineering_crew.features SET record=$2, last_seq=$3 WHERE id=$1', [request.id, record, events.at(-1).seq + 1]);
  const terminal = { featureId: request.id, type: 'request.completed', seq: events.at(-1).seq + 1, evidence: record.delivery };
  for (const event of [...events, terminal]) {
    await db.query('INSERT INTO engineering_crew.feature_events (feature_id,seq,event) VALUES($1,$2,$3)', [request.id, event.seq, event]);
  }
  const { recordFeaturePreviewFailure } = await import('../lib/feature-controller.mjs');
  const [trace] = await Promise.all([publishFeatureTrace(db, source.control, request.id, source.env),
    recordFeaturePreviewFailure(db, request.id, 'First preview did not start')]);
  await recordFeaturePreviewFailure(db, request.id, 'Second preview did not start');
  const saved = await getFeature(db, request.id);
  assert.equal(saved.previewStatus, 'failed');
  assert.equal(verifiedFeatureTraceLink(saved), trace.url);
});

test('the scoped feature worker publishes once, preserves a blocked outcome on export failure, and allows manual retry', { skip: !postgres }, async t => {
  const source = await fixture(t), behavior = { wrongProject: true };
  const destination = await api(t, behavior);
  source.env.CREW_LANGFUSE_URL = destination.origin;
  const { db, url } = await testDatabase(t);
  const runtime = {
    plan: async ({ onEvent }) => {
      const moment = new Date().toISOString();
      await onEvent({ type: 'agent.completed', evidence: { threadId, role: 'planner', startedAt: moment, endedAt: moment } });
      throw new Error('Seeded planning failure');
    }, build: assert.fail, verify: assert.fail, promote: assert.fail,
  };
  async function finish(requestId) {
    await createFeature(db, { projectId: 'music', id: requestId, goal: 'Exercise the receipt exporter' });
    const run = await runFeature(db, requestId, { runtime, autoTraceProject: 'music' });
    assert.equal(run.status, 'blocked');
    assert.equal(run.langfuseExport.status, 'pending');
    return run;
  }
  const command = fileURLToPath(new URL('../bin/crew.mjs', import.meta.url));
  const exec = promisify(execFile);
  async function worker(requestId, project = 'music') {
    try {
      await exec(process.execPath, [command, '--repo', source.control.root, 'feature', 'run', requestId],
        { env: { ...process.env, ...source.env, CREW_DATABASE_URL: url, CREW_LANGFUSE_AUTO_PROJECT: project } });
      assert.fail('Expected the original blocked exit code');
    } catch (error) {
      assert.equal(error.code, 5);
      return JSON.parse(error.stdout).request;
    }
  }
  const first = await finish('first');
  const untouched = await worker(first.id, 'other-project');
  assert.equal(destination.requests.length, 0);
  assert.equal(untouched.langfuseExport.status, 'pending');
  const failed = await Promise.all([worker(first.id), worker(first.id)]);
  for (const run of failed) {
    assert.equal(run.status, first.status);
    assert.deepEqual(run.events, first.events);
    assert.equal(run.langfuseExport.status, 'failed');
    assert.match(run.langfuseExport.message, /configured project/);
  }
  assert.equal(destination.requests.length, 1);
  behavior.wrongProject = false;
  const retry = await publishFeatureTrace(db, source.control, first.id, source.env);
  const recovered = await getFeature(db, first.id);
  assert.equal(recovered.langfuseExport.status, 'verified');
  assert.equal(recovered.status, 'blocked');
  assert.equal(verifiedFeatureTraceLink(recovered), retry.url);

  const next = await finish('next');
  const exported = await Promise.all([worker(next.id), worker(next.id)]);
  assert.ok(exported.every(run => run.langfuseExport.status === 'verified' && verifiedFeatureTraceLink(run)));
  const reads = destination.requests.length;
  await worker(next.id);
  assert.equal(destination.requests.length, reads);
  assert.equal(destination.requests.filter(request => request.body).length, 2);
});

test('the blocked run renders follow-up QA only for its verified trace and exact engineer test', async t => {
  const { record, events } = featureFixture(1);
  const project = { id: record.projectId, name: 'Music', featureOnly: true };
  const source = await fixture(t);
  const destination = await api(t, {});
  source.env.CREW_LANGFUSE_URL = destination.origin;
  const revision = 'b'.repeat(40);
  events.push({ ...events[0], seq: 4, type: 'tool.completed', evidence: { action: 'test', revision, passed: false } });
  const db = featureDatabase(record, events);
  const parent = await publishFeatureTrace(db, source.control, record.id, source.env, { retries: 0 });
  const traceId = 'c'.repeat(32), observationId = 'd'.repeat(16);
  const trace = { status: 'verified', projectId: parent.projectId, traceId, observationId,
    url: `${destination.origin}/project/${parent.projectId}/traces/${traceId}?observation=${observationId}`,
    verifiedAt: '2026-11-04T08:01:00Z' };
  const qa = { revision, sourceAttempt: 1, engineerTestEvent: 4, result: 'failed', parentTraceId: parent.traceId,
    startedAt: '2026-11-04T07:58:00Z', endedAt: '2026-11-04T08:00:00Z', trace, model: 'luna', modelSource: 'requested',
    checks: [{check:'Author tests',result:'passed'}, {check:'Independent QA tests',result:'skipped'},
      {check:'Operator acceptance test',result:'failed',fixtures:[{fixture:'lesson',result:'passed'},
        {fixture:'held-out',result:'failed',fullRenditionMatched:false}]}] };
  const page = (qaDiagnostic, extra = {}) => featureRequestPage(project, { ...record, events, qaDiagnostic, ...extra });
  const verified = page(qa);
  const section = verified.match(/<section class="follow-up-qa"[^]*?<\/section>/)[0];
  assert.match(section, /href="#event-4">revision <code>bbbbbbbbbb<\/code> from engineer test #4/);
  assert.match(section, /after this run ended\. Delivery is blocked/);
  assert.match(section.replace(/<[^>]*>/g, ' '), /Independent QA tests\s+Skipped/);
  assert.match(section, /lesson · Passed/);
  assert.match(section, /held-out · Failed/);
  assert.match(section, /Failed checks · full rendition/);
  assert.match(section, /Model requested · <code>luna</);
  assert.ok(section.includes(`href="${trace.url}"`));
  for (const [attachment, overrides] of [
    [undefined], [{...qa, trace: {...trace,status:'unverified'}}], [{...qa, trace:parent}],
    [{...qa, trace:{...trace,url:trace.url.replace(destination.origin,'https://outside.invalid')}}],
    [{...qa, trace:{...trace,url:trace.url.replace(destination.origin,'http://127.0.0.1:1')}}],
    [{...qa, trace:{...trace,projectId:'other',url:trace.url.replace('/project/test-project/', '/project/other/')}}],
    [{...qa, revision:'a'.repeat(40)}], [{...qa, engineerTestEvent:2}], [{...qa, sourceAttempt:2}],
    [{...qa,parentTraceId:'e'.repeat(32)}], [qa,{projectId:'other'}], [qa,{status:'completed'}],
  ]) assert.doesNotMatch(page(attachment, overrides), /id="follow-up-qa"/);
  const original = page(undefined);
  const usage = html => html.match(/<details class="usage-disclosure"[^]*?<\/div><\/details>/)[0];
  const workflow = html => html.slice(html.indexOf('id="workflow"'),html.indexOf('id="request-details"'));
  assert.equal(usage(original), usage(verified));
  assert.equal(workflow(original), workflow(verified));
});
