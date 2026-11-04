import assert from 'node:assert/strict';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { langfuseConfig, langfuseSpan, publishLangfuse, verifiedTraceLink } from '../lib/langfuse.mjs';
import { artifact, runStore } from '../lib/run-store.mjs';
import { publishAttemptTrace, summarize } from '../lib/workflow.mjs';

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
  const run = { id: 'run-1', project: { id: 'pet-store' }, epic: { id: 'epic-1' }, sourceCommit: 'a'.repeat(40), tasks: [], artifacts: [] };
  const receipt = { runId: run.id, taskId: 'review', attemptId, threadId, sourceCommit: run.sourceCommit, outcome: 'completed',
    usage: { input: 42, output: 11, total: 53 }, unexpectedText: 'private transcript fixture' };
  const record = artifact('receipt-1', 'Codex execution receipt', 'json', JSON.stringify(receipt), { source: 'runtime', attemptId });
  const attempt = { id: attemptId, number: 1, outcome: 'completed', receiptId: record.id,
    startedAt: '2026-11-04T07:49:48.743Z', endedAt: '2026-11-04T07:50:05.629Z' };
  const task = { packet: { id: 'review', profileId: 'product', budget: { targetTotalTokens: 100 } }, attempts: [attempt] };
  run.tasks.push(task);
  run.artifacts.push(record);
  const store = runStore(gitDir, run.id);
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
      data = { data: spans.filter(span => !behavior.omitChildren || !span.parentSpanId).map(span => {
        const attributes = Object.fromEntries(span.attributes.map(attribute => [attribute.key, attribute.value.stringValue]));
        const metadata = Object.fromEntries(Object.entries(attributes).filter(([key]) => key.startsWith('langfuse.observation.metadata.'))
          .map(([key, value]) => [key.split('.').at(-1), value]));
        if (behavior.wrongDigest) metadata.receiptSha256 = '0'.repeat(64);
        return { id: span.spanId, traceId: span.traceId, projectId: 'test-project', name: span.name, parentObservationId: span.parentSpanId,
          input: attributes['langfuse.observation.input'], output: attributes['langfuse.observation.output'], metadata };
      }) };
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
