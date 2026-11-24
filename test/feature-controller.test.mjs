import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceFeature, createFeature, featureExportLock, featureLimits, getFeature, listFeatures, readFeatureEvents,
  recordFeaturePreview, recordFeaturePreviewFailure, runFeature } from '../lib/feature-controller.mjs';
import { postgres, testDatabase } from '../test-support/stores.mjs';
import { openDatabase } from '../lib/database.mjs';
import { readFeatureCall } from '../lib/feature-controller.mjs';
import { callInput, callOutput } from '../lib/feature-call-artifacts.mjs';

function queued() {
  return { id: 'lesson', projectId: 'music', goal: 'Save a selected lesson', repoPath: null, status: 'queued',
    phase: 'plan', attempt: 0, revision: null, limits: featureLimits, startedAt: null, deadlineAt: null,
    events: [{ seq: 1, type: 'request.created', parents: [] }] };
}
function runtime(overrides = {}) {
  return { plan: async () => ({ plan: 'Implement then verify' }),
    build: async ({ attempt }) => ({ revision: `candidate-${attempt}` }),
    verify: async ({ revision }) => ({ revision, passed: true }),
    promote: async ({ revision }) => ({ revision }), ...overrides };
}
const discard = async () => {};

test('separate role verdicts gate promotion, repair receives the reviewed candidate and findings', async () => {
  const builds = [];
  const delivered = [];
  const record = await advanceFeature(queued(), runtime({
    build: async ctx => {
      builds.push([ctx.revision, ctx.feedback]);
      await Promise.all([ctx.onEvent({ type: 'tool.called', evidence: { tool: 'ls' } }),
        ctx.onEvent({ type: 'tool.completed', evidence: { code: 0 } })]);
      return { revision: `v${ctx.attempt}` };
    },
    verify: async ({ attempt, role, revision }) => ({ passed: role !== 'qa' || attempt === 2, revision, reason: 'sample mismatch' }),
    promote: async ({ revision }) => { delivered.push(revision); return { revision }; },
  }), discard);
  assert.equal(record.status, 'completed');
  assert.deepEqual(delivered, ['v2']);
  assert.deepEqual(builds, [[null, []], ['v1', [{ role: 'qa', revision: 'v1', passed: false, reason: 'sample mismatch' }]]]);
  record.events.forEach((e, i) => {
    assert.equal(e.seq, i + 1);
    assert.ok(e.parents.every(p => Number.isInteger(p) && p > 0 && p < e.seq));
  });
  const gate = record.events.find(e => e.type === 'candidate.verified');
  assert.deepEqual(gate.parents.map(seq => record.events[seq - 1].role).sort(), ['qa', 'reviewer', 'security']);
  assert.deepEqual(record.events.filter(e => e.type === 'tool.completed').map(e => record.events[e.parents[0] - 1].type),
    ['tool.called', 'tool.called']);
});

test('three failed build or review cycles block the request without delivery', async () => {
  let attempts = 0;
  const record = await advanceFeature(queued(), runtime({
    build: async () => { attempts++; throw new Error('Could not build'); }, promote: async () => assert.fail('Premature delivery'),
  }), discard);
  assert.equal(record.status, 'blocked');
  assert.equal(attempts, 3);
  assert.equal(record.events.filter(e => e.type === 'repair.requested').length, 2);
});

test('terminal completion and blocking atomically queue receipt exports only for the opted-in project', async () => {
  const runtimes = [runtime(), runtime({ plan: async () => { throw new Error('Planning stopped'); } })];
  for (const [index, agent] of runtimes.entries()) {
    const status = index === 0 ? 'completed' : 'blocked';
    for (const autoTraceProject of ['music', 'other', undefined]) {
      const writes = [];
      const record = await advanceFeature(queued(), agent, (next, event) => writes.push({ next, event }), undefined,
        { autoTraceProject, autoPreview: true });
      assert.equal(record.status, status);
      assert.ok(writes.slice(0, -1).every(({ next, event }) => !next.langfuseExport && !event.evidence?.langfuseExport));
      const { event, next } = writes.at(-1);
      assert.equal(event.type, 'request.' + status);
      if (autoTraceProject === 'music') {
        const expected = { status: 'pending', updatedAt: record.endedAt };
        assert.deepEqual(next.langfuseExport, expected);
        assert.deepEqual(event.evidence.langfuseExport, expected);
      } else {
        assert.ok(!Object.hasOwn(next, 'langfuseExport'));
        assert.ok(!Object.hasOwn(event.evidence, 'langfuseExport'));
      }
      if (status === 'completed') assert.equal(record.previewStatus, 'pending');
    }
  }
});

test('review for a different revision cannot unlock promotion', async () => {
  const record = await advanceFeature(queued(), runtime({ verify: async () => ({ passed: true, revision: 'elsewhere' }),
    promote: async () => assert.fail('Promoted an unreviewed revision'),
  }), discard);
  assert.equal(record.status, 'blocked');
  assert.ok(record.events.some(e => e.type === 'task.failed' && e.evidence.message.includes('different revision')));
});

test('resume consumes an interrupted build attempt and preserves the original deadline', async () => {
  let saved = queued();
  const store = (record, event) => { saved = { ...structuredClone(record), events: [...saved.events, event] }; };
  const stop = new AbortController();
  await assert.rejects(advanceFeature(saved, runtime({ build: async () => {
    stop.abort(new Error('Worker shutdown'));
    return { revision: 'unrecorded' };
  } }), store, stop.signal), /Worker shutdown/);
  assert.equal(saved.status, 'running');
  const originalDeadline = saved.deadlineAt;
  const record = await advanceFeature(saved, runtime({ plan: async () => assert.fail('Planning was already committed') }), store);
  assert.equal(record.status, 'completed');
  assert.equal(record.attempt, 2);
  assert.equal(record.deadlineAt, originalDeadline);
  assert.equal(record.events.filter(e => e.role === 'engineer' && e.type === 'task.started').length, 2);
});

test('an expired persisted deadline blocks a restarted worker before calling the runtime', async () => {
  const snapshot = queued();
  Object.assign(snapshot, { status: 'running', startedAt: '2020-01-01T00:00:00Z', deadlineAt: '2020-01-01T00:45:00Z' });
  snapshot.events.push({ seq: 2, type: 'request.started', parents: [1] });
  const record = await advanceFeature(snapshot, runtime({ plan: async () => assert.fail('Expired dispatch') }), discard);
  assert.equal(record.status, 'blocked');
  assert.match(record.reason, /deadline/);
});

test('a restarted repair preserves the previous source and its still-open findings', async () => {
  let saved = queued();
  const store = (record, event) => { saved = { ...structuredClone(record), events: [...saved.events, event] }; };
  const stop = new AbortController();
  await assert.rejects(advanceFeature(saved, runtime({
    build: async ctx => {
      if (ctx.attempt === 2) stop.abort(new Error('Lost repair worker'));
      return { revision: 'partial', source: 'const kept = 1;' };
    },
    verify: async ({ role }) => ({ passed: role !== 'security', message: 'Harden source checks' }),
  }), store, stop.signal), /Lost repair worker/);
  const record = await advanceFeature(saved, runtime({
    build: async ctx => {
      assert.equal(ctx.attempt, 3);
      assert.equal(ctx.revision, 'partial');
      assert.deepEqual(ctx.feedback.map(f => f.role), ['security', 'engineer']);
      return { revision: 'fixed', source: ctx.candidate.source + ' validate();' };
    },
  }), store);
  assert.equal(record.status, 'completed');
  assert.equal(record.candidate.source, 'const kept = 1; validate();');
});

test('resume repeats a promotion with the same operation ID without rebuilding a verified candidate', async () => {
  let saved = queued();
  const store = (record, event) => { saved = { ...structuredClone(record), events: [...saved.events, event] }; };
  const stop = new AbortController();
  let first;
  await assert.rejects(advanceFeature(saved, runtime({ promote: async ctx => {
    first = ctx.operationId;
    stop.abort(new Error('Worker shutdown'));
    return { revision: ctx.revision };
  } }), store, stop.signal), /Worker shutdown/);
  const record = await advanceFeature(saved, runtime({
    build: async () => assert.fail('Repeated a verified build'),
    promote: async ctx => { assert.equal(ctx.operationId, first); return { revision: ctx.revision }; },
  }), store);
  assert.equal(record.status, 'completed');
  assert.equal(record.events.filter(e => e.type === 'task.resumed' && e.phase === 'promote').length, 1);
});

test('concurrent schema opens migrate an existing v1 database without changing its runs', { skip: !postgres }, async t => {
  const { db, url } = await testDatabase(t);
  // Restore the original schema in this test's disposable database.
  await db.query(`DROP INDEX engineering_crew.pending_workflow_runs;
    DROP TABLE engineering_crew.workflow_setup_checks, engineering_crew.project_skill_versions, engineering_crew.mcp_connection_versions, engineering_crew.agent_versions, engineering_crew.feature_call_outputs, engineering_crew.feature_call_inputs, engineering_crew.feature_events, engineering_crew.features, engineering_crew.feature_projects;
    DELETE FROM engineering_crew.schema_version WHERE version>=2;
    INSERT INTO engineering_crew.runs (id, project_id, epic_id, record) VALUES ('old', 'music', 'pilot', '{"id":"old"}')`);
  const migrated = await Promise.all([openDatabase(url), openDatabase(url)]);
  try {
    const { rows } = await db.query('SELECT record FROM engineering_crew.runs WHERE id=\'old\'');
    assert.deepEqual(rows, [{ record: { id: 'old' } }]);
    assert.deepEqual(await listFeatures(migrated[0]), []);
  } finally { await Promise.all(migrated.map(pool => pool.end())); }
});

test('Postgres serializes project workers, exposes live events, and persists later requests on the same app', { skip: !postgres }, async t => {
  const { db } = await testDatabase(t);
  const first = await createFeature(db, { id: 'initial', projectId: 'music', goal: 'Add an import' });
  const second = await createFeature(db, { id: 'follow-up', projectId: 'music', goal: 'Improve the import' });
  assert.equal(first.canResume, true);
  assert.equal(second.repoPath, null);
  await assert.rejects(createFeature(db, { id: 'initial', projectId: 'music', goal: 'Duplicate' }), /already exists/);
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const worker = runFeature(db, first.id, { runtime: runtime({ plan: async ({ onEvent }) => {
    await onEvent({ type: 'agent.activity', evidence: { message: 'Examining project' } });
    entered.resolve();
    await release.promise;
    return { plan: 'Build v1' };
  } }) });
  try {
    await Promise.race([entered.promise, worker.then(() => assert.fail('Worker ended before check'))]);
    const current = (await getFeature(db, first.id)).events.at(-1);
    assert.equal(current.evidence.message, 'Examining project');
    assert.deepEqual((await readFeatureEvents(db, first.id, current.seq - 1)).events, [current]);
    assert.deepEqual((await readFeatureEvents(db, first.id, current.seq)).events, []);
    await assert.rejects(readFeatureEvents(db, first.id, current.seq + 1), /cursor is ahead/);
    assert.equal((await getFeature(db, second.id)).canResume, false);
    await assert.rejects(runFeature(db, second.id, { runtime: runtime() }), /active for project/);
  } finally { release.resolve(); }
  assert.equal((await worker).status, 'completed');
  assert.equal((await runFeature(db, first.id, {})).status, 'completed');
  assert.equal((await runFeature(db, second.id, { runtime: runtime() })).status, 'completed');
  assert.equal((await listFeatures(db, 'music')).length, 2);
});

test('an existing v2 feature journal migrates without inventing historical call inputs', { skip: !postgres }, async t => {
  const { db, url } = await testDatabase(t);
  const request = await createFeature(db, { id: 'older', projectId: 'demo', goal: 'Existing feature request' });
  await db.query('DROP INDEX engineering_crew.pending_workflow_runs');
  await db.query('DROP TABLE engineering_crew.workflow_setup_checks, engineering_crew.project_skill_versions, engineering_crew.mcp_connection_versions, engineering_crew.agent_versions, engineering_crew.feature_call_outputs, engineering_crew.feature_call_inputs');
  await db.query('DELETE FROM engineering_crew.schema_version WHERE version>=3');
  const migrated = await openDatabase(url);
  try {
    assert.deepEqual((await getFeature(migrated, request.id)).events, request.events);
    assert.deepEqual(await readFeatureCall(migrated, request.id, 1), { input: null, output: null });
  } finally { await migrated.end(); }
});

test('call inputs and answers are scoped by request and invocation, deduplicated, and absent from the normal journal', { skip: !postgres }, async t => {
  const { db } = await testDatabase(t);
  const local = callInput('private operator text\nताला', { role: 'planner', nativeTools: [] });
  const answers = [callOutput('{ "marker": "private first answer" }\n'), callOutput('{"marker":"private second answer"}')];
  const run = async (id, projectId, skipCapture) => {
    await createFeature(db, { id, projectId, goal: 'Fixture' });
    return runFeature(db, id, { runtime: runtime({ plan: async ({ onEvent }) => {
      let receipt;
      for (let i = 0; i < 3; i++) {
        receipt = { callId: 'fixture-' + i, ...(skipCapture ? {} : { inputDigest: local.digest }) };
        await onEvent({ type: 'agent.started', evidence: receipt }, skipCapture ? undefined : { input: local });
        if (i < 2) {
          receipt = { ...receipt, ...(skipCapture ? {} : { outputDigest: answers[i].digest }) };
          await onEvent({ type: 'agent.completed', evidence: receipt }, skipCapture ? undefined : { output: answers[i] });
        }
      }
      return { plan: 'Synthetic plan', receipt: { ...receipt, callId: 'fixture-1' } };
    } }) });
  };
  const request = await run('with-capture', 'demo', false);
  const legacy = await run('without-capture', 'other', true);
  const starts = request.events.filter(e => e.type === 'agent.started');
  const completed = request.events.filter(e => e.type === 'agent.completed');
  for (let i = 0; i < 3; i++) {
    const expected = { input: local, output: answers[i] ?? null };
    assert.deepEqual(await readFeatureCall(db, request.id, starts[i].seq), expected);
    if (completed[i]) assert.deepEqual(await readFeatureCall(db, request.id, completed[i].seq), expected);
    assert.deepEqual(await readFeatureCall(db, legacy.id, starts[i].seq), { input: null, output: null });
  }
  assert.deepEqual((await readFeatureCall(db, request.id, request.events.find(e => e.type === 'task.completed').seq)).output, answers[1]);
  const { rows: [counts] } = await db.query('SELECT count(*)::int AS inputs FROM engineering_crew.feature_call_inputs');
  assert.equal(counts.inputs, 1);
  assert.doesNotMatch(JSON.stringify(await getFeature(db, request.id)), /private operator text|private (first|second) answer/);
  assert.doesNotMatch(JSON.stringify(await readFeatureEvents(db, request.id)), /private operator text|private (first|second) answer/);
  await assert.rejects(readFeatureCall(db, request.id, 999), /does not exist/);
  await assert.rejects(readFeatureCall(db, request.id, -1), /positive call event/);
});

test('a plan links the exact delivery of its Git base and never infers a predecessor from chronology', { skip: !postgres }, async t => {
  const { db } = await testDatabase(t);
  const hash = c => c.repeat(40);
  async function deliver(projectId, featureId, base, revision) {
    await createFeature(db, { projectId, id: featureId, goal: 'Implement the supplied feature' });
    return runFeature(db, featureId, { runtime: runtime({ plan: async () => ({ plan: { base } }), build: async () => ({ revision }) }) });
  }
  const first = await deliver('music', 'first', hash('a'), hash('b'));
  assert.equal(Object.hasOwn(first, 'predecessor'), false);
  await deliver('other-project', 'foreign', hash('f'), hash('b'));
  const second = await deliver('music', 'second', hash('b'), hash('c'));
  const expected = { featureId: 'first', revision: hash('b'), eventSeq: first.events.at(-1).seq };
  assert.deepEqual(second.predecessor, expected);
  assert.deepEqual(second.events.filter(e => e.predecessor).map(e => [e.type, e.role, e.predecessor]),
    [['task.completed', 'planner', expected]]);
  const third = await deliver('music', 'third', hash('d'), hash('e'));
  assert.equal(Object.hasOwn(third, 'predecessor'), false);
  const foreign = await deliver('other-project', 'no-cross-project-link', hash('c'), hash('1'));
  assert.equal(Object.hasOwn(foreign, 'predecessor'), false);
  assert.deepEqual((await getFeature(db, 'first')).events, first.events);
});

test('post-delivery preview receipts deduplicate concurrent observations and preserve the causal delivery link', { skip: !postgres }, async t => {
  const { db } = await testDatabase(t);
  const revision = 'b'.repeat(40);
  const image = 'sha256:' + 'c'.repeat(64);
  const manifest = { url: 'http://127.0.0.1:9876', revision, image, container: 'crew-app-1', directory: '/private/source' };
  const first = await createFeature(db, { projectId: 'music', id: 'preview-first', goal: 'Start the music app' });
  await assert.rejects(recordFeaturePreview(db, first.id, manifest), /completed feature delivery/);
  const completed = await runFeature(db, first.id, { runtime: runtime({ build: async () => ({ revision, image }) }) });
  assert.equal(Object.hasOwn(completed, 'previewStatus'), false);
  const parent = completed.events.at(-1).seq;
  await assert.rejects(recordFeaturePreview(db, first.id, { ...manifest, revision: 'other' }), /completed feature delivery/);
  await assert.rejects(recordFeaturePreview(db, first.id, { ...manifest, image: 'sha256:' + 'e'.repeat(64) }), /image differs/);
  const observed = await Promise.all([1, 2, 3].map(() => recordFeaturePreview(db, first.id, manifest)));
  assert.ok(observed.every(e => e.seq === parent + 1));
  assert.deepEqual(observed[0].parents, [parent]);
  assert.deepEqual(Object.keys(observed[0].evidence).sort(), ['container', 'image', 'revision', 'url']);
  const replacement = await recordFeaturePreview(db, first.id, { ...manifest, container: 'crew-app-2' });
  assert.equal(replacement.seq, parent + 2);
  assert.deepEqual(replacement.parents, [parent]);
  assert.deepEqual((await getFeature(db, first.id)).events.slice(0, parent), completed.events);
  await createFeature(db, { projectId: 'music', id: 'next', goal: 'Update music' });
  const next = await runFeature(db, 'next', { runtime: runtime({ plan: async () => ({ plan: { base: revision } }) }) });
  assert.deepEqual(next.predecessor, { featureId: first.id, revision, eventSeq: parent });
});

test('requested auto preview reports its outcome to watchers and supports retry after a failed start', { skip: !postgres }, async t => {
  const { db } = await testDatabase(t);
  const revision = 'a'.repeat(40);
  const image = 'sha256:' + 'a'.repeat(64);
  const { id } = await createFeature(db, { projectId: 'music', id: 'auto', goal: 'Deliver and serve' });
  const completed = await runFeature(db, id, { autoPreview: true, runtime: runtime({ build: async () => ({ revision, image }) }) });
  const parent = completed.events.at(-1).seq;
  assert.equal(completed.status, 'completed');
  assert.equal(completed.previewStatus, 'pending');
  assert.equal((await readFeatureEvents(db, id, parent)).previewStatus, 'pending');
  const message = 'Health endpoint did not start';
  const first = await recordFeaturePreviewFailure(db, id, message);
  assert.deepEqual(first.evidence, { message, revision });
  assert.deepEqual(first.parents, [parent]);
  assert.equal((await recordFeaturePreviewFailure(db, id, message)).seq, first.seq);
  const failure = await readFeatureEvents(db, id, parent);
  assert.equal(failure.previewStatus, 'failed');
  assert.deepEqual(failure.events.map(e => e.type), ['app.preview.failed']);
  const manifest = { url: 'http://127.0.0.1:9876', revision, image, container: 'crew-app-3' };
  const ready = await recordFeaturePreview(db, id, manifest);
  assert.equal((await getFeature(db, id)).previewStatus, 'ready');
  const failedAgain = await recordFeaturePreviewFailure(db, id, message);
  assert.ok(failedAgain.seq > ready.seq);
  const recovered = await recordFeaturePreview(db, id, manifest);
  assert.equal(recovered.seq, failedAgain.seq + 1);
  const page = await readFeatureEvents(db, id, failedAgain.seq);
  assert.equal(page.previewStatus, 'ready');
  assert.deepEqual(page.events, [recovered]);
});

test('request, history and watcher distinguish an orphaned receipt export from a live exporter for that request', { skip: !postgres }, async t => {
  const { db } = await testDatabase(t);
  const { id } = await createFeature(db, { projectId: 'music', id: 'export-observation', goal: 'Return seeded receipts' });
  const completed = await runFeature(db, id, { autoTraceProject: 'music', runtime: runtime() });
  const lastSeq = completed.events.at(-1).seq;
  const expected = { status: 'pending', updatedAt: completed.endedAt };
  async function checkViews(outcome) {
    const [request, [history], watcher] = await Promise.all([
      getFeature(db, id), listFeatures(db, 'music'), readFeatureEvents(db, id, lastSeq),
    ]);
    for (const view of [request, history, watcher]) {
      assert.deepEqual(view.langfuseExport, outcome);
      assert.equal(Object.hasOwn(view, 'exporting'), false);
    }
    assert.equal(watcher.lastSeq, lastSeq);
    assert.deepEqual(watcher.events, []);
  }
  await checkViews(expected);
  const old = { status: 'pending', updatedAt: '2000-01-01T00:00:00.000Z' };
  const lease = await db.connect();
  try {
    await lease.query('SELECT pg_advisory_lock($1, hashtext($2))', [featureExportLock, id]);
    await db.query(`UPDATE engineering_crew.features SET record=jsonb_set(record, '{langfuseExport}', $2::jsonb) WHERE id=$1`, [id, old]);
    await checkViews(old);
    await lease.query('SELECT pg_advisory_unlock($1, hashtext($2))', [featureExportLock, id]);
    await lease.query('SELECT pg_advisory_lock($1, hashtext($2))', [featureExportLock, 'another-request']);
    await checkViews({ status: 'failed', updatedAt: old.updatedAt, message: 'The receipt exporter stopped before verification.' });
    const { rows: [stored] } = await db.query("SELECT record->'langfuseExport' AS state FROM engineering_crew.features WHERE id=$1", [id]);
    assert.deepEqual(stored.state, old);
  } finally {
    await lease.query('SELECT pg_advisory_unlock_all()').finally(() => lease.release());
  }
});
