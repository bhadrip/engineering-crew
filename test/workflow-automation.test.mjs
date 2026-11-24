import assert from 'node:assert/strict';
import test from 'node:test';
import { saveReusableAgent } from '../lib/agent-library.mjs';
import { artifactDigest, queuedWorkflowRuns, runStore } from '../lib/run-store.mjs';
import { decide, dispatchNext, newRun, setWorkflowAutomation, summarize } from '../lib/workflow.mjs';
import { buildWorkflowSnapshot } from '../lib/workflow-editor.mjs';
import { runWorkflowWorker, workflowWorkerConnected } from '../lib/workflow-scheduler.mjs';
import { postgres, testDatabase } from '../test-support/stores.mjs';

test('Postgres claims a queued assignment once and advances past the configured acceptance gates', { skip: !postgres }, async t => {
  const { db } = await testDatabase(t);
  const project = { id: 'music-transcribe', name: 'Music Transcribe' };
  const saved = await saveReusableAgent(db, { projectId: project.id, name: 'Coach', model: '', remit: 'Prepare a practice guide.',
    instructions: 'Use the given references.', skills: [] });
  const agent = `library:${saved.id}:${saved.version}`;
  const step = (id, prerequisites, reviewMode, extra = {}) => ({ id, title: id, objective: 'Prepare a practice guide.',
    owner: 'Project owner', agent, prerequisites, reviewMode, inputs: ['brief'], ...extra });
  const resultSlot = { ref: 'result', id: 'result', kind: 'json', title: 'Result', required: true, acceptance: 'Return the next route.' };
  const condition = operator => ({ step: 'classify', output: 'result', pointer: '/route', operator, value: '"practice"' });
  const draft = { title: 'Practice workflow', goal: 'Prepare a guide.', brief: 'Use the opening phrase.', dispatchMode: 'automatic', steps: [
    step('classify', [], 'automatic', { outputs: [resultSlot], responseMode: 'free-form' }),
    step('practice', ['classify'], 'human', { runWhen: condition('equals') }),
    step('extra-review', ['classify'], 'human', { runWhen: condition('different') }),
    step('publish', ['practice', 'extra-review'], 'automatic', { joinPrerequisites: ['extra-review'] }),
  ] };
  const snapshot = await buildWorkflowSnapshot(db, { project, workflowId: 'practice-workflow', sourceCommit: 'a'.repeat(40), draft });
  const store = runStore(db, 'practice-run');
  await store.create(newRun(snapshot, 'practice-run', undefined, { pauseDispatch: true }));
  const queued = () => queuedWorkflowRuns(db, project.id, [], 2);
  assert.deepEqual(await queued(), []);
  await setWorkflowAutomation(store, true);
  assert.deepEqual(await queued(), ['practice-run']);
  assert.deepEqual(await queuedWorkflowRuns(db, 'other-project', [], 2), []);

  const calls = [];
  const reply = 'The opening phrase should go to practice.';
  const content = '{"route":"practice"}';
  const classify = {
    outcome: 'completed', response: reply, submitted: { outputs: [{ slot: 'result', content }] },
    receipt: { usage: null, responseFormat: 'free-form', replyDigest: artifactDigest(reply), submittedOutputDigests: { result: artifactDigest(content) } },
    activity: { responseFormat: 'free-form', response: reply },
  };
  const execute = async job => {
    calls.push(job.task.id);
    if (job.task.id === 'classify') {
      await new Promise(resolve => setTimeout(resolve, 75));
      return { ...classify };
    }
    if (job.task.id === 'publish' && job.attempt.skippedPrerequisites?.[0]?.taskId !== 'extra-review')
      throw new Error('Expected the skipped review as an input to the join.');
    return { outcome: 'completed', receipt: { usage: null }, response: { state: 'completed', summary: 'Guide updated.',
      outputs: [{ slot: 'result', content: 'Practice the opening phrase.' }],
      decisions: [], questions: [], blockers: [] } };
  };
  const next = () => dispatchNext(runStore(db, 'practice-run'), undefined, undefined, execute, db);
  const claimed = (await Promise.all([next(), next()])).filter(Boolean);
  assert.equal(claimed.length, 1);
  assert.deepEqual(calls, ['classify']);
  assert.equal(claimed[0].decision.source, 'workflow');
  assert.equal(claimed[0].dispatchSource, 'workflow');
  assert.deepEqual(await queued(), ['practice-run']);
  const practice = await next();
  assert.equal(practice.decision, undefined);
  assert.equal(await next(), null);
  assert.deepEqual(await queued(), []);
  await setWorkflowAutomation(store, false);
  await decide(store, 'practice', practice.id, 'accepted', 'Verified the timing guide.');
  assert.equal(await next(), null);
  assert.deepEqual(await queued(), []);

  await setWorkflowAutomation(store, true);
  assert.deepEqual(await queued(), ['practice-run']);
  const publish = await next();
  assert.equal(publish.decision.source, 'workflow');
  assert.equal(await next(), null);
  assert.deepEqual(calls, ['classify', 'practice', 'publish']);
  assert.deepEqual(summarize(await store.read()).handoffs, { total: 4, accepted: 3, running: 0, review: 0, attention: 0, skipped: 1 });

  const invalidStore = runStore(db, 'missing-evidence');
  await invalidStore.create(newRun(snapshot, 'missing-evidence'));
  const invalid = await dispatchNext(invalidStore, undefined, undefined, async job => {
    const observation = await execute(job);
    delete observation.receipt;
    return observation;
  }, db);
  assert.equal(invalid.decision, undefined);
  assert.equal(await dispatchNext(invalidStore, undefined, undefined, execute, db), null);
  assert.equal(summarize(await invalidStore.read()).handoffs.attention, 1);

  const omittedStore = runStore(db, 'omitted-submission');
  await omittedStore.create(newRun(snapshot, 'omitted-submission'));
  const omitted = await dispatchNext(omittedStore, undefined, undefined, async () =>
    ({ ...classify, submitted: { outputs: [] }, receipt: { ...classify.receipt, submittedOutputDigests: {} } }), db);
  assert.equal(omitted.outcome, 'invalid-result');
  assert.equal(omitted.error, 'Missing required output: result');
  assert.ok(omitted.activityId);
  assert.equal(omitted.decision, undefined);
  assert.equal(await dispatchNext(omittedStore, undefined, undefined, execute, db), null);
  assert.deepEqual(summarize(await omittedStore.read()).handoffs, { total: 4, accepted: 0, running: 0, review: 0, attention: 1 });
});

test('a dedicated worker drains its active attempt and leaves newly ready work for its replacement', { skip: !postgres, timeout: 15_000 }, async t => {
  const { db } = await testDatabase(t);
  const project = { id: 'music-transcribe', name: 'Music Transcribe' };
  const { id: agentId, version } = await saveReusableAgent(db, { projectId: project.id, name: 'Coach', model: '', remit: 'Prepare a guide.',
    instructions: 'Use the references.', skills: [] });
  const step = (id, prerequisites) => ({ id, title: id, objective: 'Prepare the next part of the guide.', owner: 'Project owner',
    agent: `library:${agentId}:${version}`, prerequisites, reviewMode: 'automatic', inputs: ['brief'] });
  const snapshot = await buildWorkflowSnapshot(db, { project, workflowId: 'worker-practice', sourceCommit: 'a'.repeat(40),
    draft: { title: 'Practice workflow', goal: 'Prepare a guide.', brief: 'Use the opening phrase.', dispatchMode: 'automatic',
      steps: [step('plan', []), step('practice', ['plan'])] } });
  const store = runStore(db, 'worker-practice-run');
  await store.create(newRun(snapshot, 'worker-practice-run'));
  const connected = () => workflowWorkerConnected(db, project.id);
  assert.equal(await connected(), false);
  const started = Promise.withResolvers(), release = Promise.withResolvers();
  const finish = { outcome: 'completed', receipt: { usage: null }, response: { state: 'completed', summary: 'Guide updated.',
    outputs: [{ slot: 'result', content: 'Practice the opening phrase.' }], decisions: [], questions: [], blockers: [] } };
  const stop = new AbortController();
  const calls = [];
  const run = runWorkflowWorker(db, project.id, AbortSignal.any([stop.signal, t.signal]), { intervalMs: 10, concurrency: 1, execute: async job => {
    calls.push(job.task.id);
    started.resolve();
    await release.promise;
    return finish;
  } });
  try {
    await Promise.race([started.promise, run]);
    assert.equal(await connected(), true);
    assert.equal(await workflowWorkerConnected(db, 'another-project'), false);
    await assert.rejects(runWorkflowWorker(db, project.id, new AbortController().signal), /already connected/);
    stop.abort();
    assert.equal(await connected(), true);
  } finally {
    stop.abort();
    release.resolve();
    await run;
  }
  assert.equal(await connected(), false);
  assert.deepEqual(calls, ['plan']);
  const afterDrain = await store.read();
  assert.equal(afterDrain.tasks[0].attempts[0].decision.disposition, 'accepted');
  assert.equal(afterDrain.tasks[1].attempts.length, 0);
  assert.equal(afterDrain.automation.pending, true);

  const replacement = new AbortController();
  await runWorkflowWorker(db, project.id, AbortSignal.any([replacement.signal, t.signal]), { intervalMs: 10, concurrency: 1, execute: job => {
    calls.push(job.task.id);
    replacement.abort();
    return finish;
  } });
  const completed = summarize(await store.read());
  assert.deepEqual(calls, ['plan', 'practice']);
  assert.equal(completed.handoffs.accepted, 2);
  assert.equal(completed.automation.pending, false);
  assert.equal(await connected(), false);
});
