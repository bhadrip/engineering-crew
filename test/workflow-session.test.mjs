import assert from 'node:assert/strict';
import test from 'node:test';
import { codexQuestionSet, finishWorkflowSession, queueWorkflowSessionAction, recoverWorkflowAttempt, workflowSessionControls } from '../lib/workflow-session.mjs';
import { artifact, observeRunWorkers, runStore } from '../lib/run-store.mjs';
import { allowAdditionalAttempt, dispatch } from '../lib/workflow.mjs';
import { recordCodexCheckpoint, recordWorkspaceCheckpoint } from '../lib/workflow-checkpoint.mjs';
import { memoryRunStore, postgres, testDatabase } from '../test-support/stores.mjs';

test('a recorded run-only approval permits exactly one additional rework attempt', async () => {
  const store = memoryRunStore();
  const packet = { id: 'coach', revision: 1, profileId: 'coach', acceptedBy: 'Project owner', prerequisites: [], inputArtifacts: [],
    budget: { timeoutSeconds: 10, maxAttempts: 1 } };
  await store.create({ id: 'lesson-budget', project: { id: 'music-transcribe', runtime: { kind: 'codex' } },
    profiles: [{ id: 'coach', revision: 1, instructionId: 'instructions', skillIds: [] }],
    artifacts: [artifact('instructions', 'Instructions', 'text', 'Prepare a rhythm exercise.', {})],
    tasks: [{ packet, attempts: [{ id: 'first', number: 1, packetRevision: 1, outcome: 'interrupted',
      decision: { disposition: 'rework', note: 'Check playback.' } }] }] });
  const retry = execute => dispatch(store, 'coach', undefined, undefined, execute);
  await assert.rejects(retry(() => assert.fail('Dispatch exceeded the attempt limit.')), /attempt limit/);
  await assert.rejects(allowAdditionalAttempt(store, 'coach', 'older', 'Stale request.'), /unavailable/);
  const approval = await allowAdditionalAttempt(store, 'coach', 'first', 'Verify the loop boundary.');
  assert.equal(approval.limit, 2);
  await assert.rejects(allowAdditionalAttempt(store, 'coach', 'first', 'Duplicate approval.'), /unavailable/);
  const next = await retry(job => {
    assert.equal(job.attempt.attemptBudgetId, approval.artifactId);
    assert.equal(job.task.budget.maxAttempts, 1);
    return { outcome: 'interrupted' };
  });
  assert.equal(next.number, 2);
  const run = await store.read();
  assert.equal(run.tasks[0].packet.budget.maxAttempts, 1);
  assert.equal(run.artifacts.find(record => record.id === approval.artifactId).digest, approval.digest);
});

test('Postgres proves a workflow worker has disconnected before closing its attempt', { skip: !postgres }, async t => {
  const { db } = await testDatabase(t);
  const store = runStore(db, 'rhythm-recovery');
  await store.create({ id: 'rhythm-recovery', project: { id: 'music-transcribe', runtime: { kind: 'codex' } }, sourceCommit: 'fixture',
    artifacts: [artifact('instructions', 'Coach instructions', 'text', 'Prepare a short rhythm exercise.', {})],
    profiles: [{ id: 'coach', revision: 1, instructionId: 'instructions', skillIds: [], codexTools: [],
      codexRuntime: { liveSession: true, saveThread: true, workspace: 'workspace-write' } }],
    tasks: [{ packet: { id: 'coach', revision: 1, profileId: 'coach', prerequisites: [], inputArtifacts: [], captureWorkspace: true,
      budget: { timeoutSeconds: 10, maxAttempts: 2 } }, attempts: [] }] });
  const files = [{ path: 'cue.txt', mode: '100644', data: Buffer.from('Slow the opening phrase.\n').toString('base64') }];
  const connected = Promise.withResolvers();
  const release = Promise.withResolvers();
  const running = store.withWorker(async worker => {
    await worker.update(run => {
      const attempt = { id: 'first', number: 1, packetRevision: 1, sourceCommit: 'fixture', outcome: 'running', workerId: worker.workerId,
        pendingToolCalls: [{ id: 'tool-check', server: 'codex', tool: 'command_execution', status: 'running' }],
        agentReply: { text: 'I found a timing cue.' },
        codexSession: { threadId: 'native-thread', turnId: 'native-turn', persisted: true,
          actions: [{ id: 'pending-question', kind: 'answer', status: 'waiting' }] } };
      run.tasks[0].attempts.push(attempt);
      recordCodexCheckpoint(run, 'coach', attempt, { kind: 'launch', prompt: 'Check the timing cue.', responseFormat: 'free-form' });
      recordCodexCheckpoint(run, 'coach', attempt, { kind: 'submission', output: { slot: 'result', content: 'Slow the opening phrase.' } });
      recordWorkspaceCheckpoint(run, 'coach', attempt, { files: [], note: 'Before editing.' });
      recordWorkspaceCheckpoint(run, 'coach', attempt, { files, note: 'Saved the timing cue.' });
    });
    connected.resolve();
    await release.promise;
  });
  const attemptState = async () => (await observeRunWorkers(db, [await store.read()]))[0].tasks[0].attempts[0];
  const recover = () => recoverWorkflowAttempt(store, 'coach', 'first');
  const steer = () => queueWorkflowSessionAction(store, 'coach', 'first', { kind: 'steer', turnId: 'native-turn', message: 'Slow down.' });
  try {
    await Promise.race([connected.promise, running]);
    assert.equal((await attemptState()).workerStatus, 'connected');
    await assert.rejects(recover(), /still owns this attempt/);
    await steer();
  } finally { release.resolve(); await running; }
  assert.equal((await attemptState()).workerStatus, 'disconnected');
  await assert.rejects(steer(), /worker disconnected/);
  const results = await Promise.allSettled([recover(), recover()]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.match(results.find(result => result.status === 'rejected').reason.message, /already ended/);
  const { tasks, artifacts } = await store.read();
  const attempt = tasks[0].attempts[0];
  assert.equal(attempt.outcome, 'worker-disconnected');
  assert.deepEqual(attempt.codexSession.actions.map(action => action.status), ['closed', 'not-delivered']);
  assert.equal(attempt.receiptId, undefined);
  const record = artifacts.find(record => record.id === attempt.recoveryId);
  const recovery = JSON.parse(record.content);
  assert.deepEqual(recovery.codexSession, attempt.codexSession);
  assert.deepEqual(recovery.checkpoint, attempt.codexCheckpoint);
  assert.deepEqual(recovery.workspaceCheckpoint, { ...attempt.workspaceCheckpoint, attemptId: attempt.id });
  assert.equal(attempt.workspaceOutput, undefined);
  assert.equal(recovery.savedOutputs[0].content, 'Slow the opening phrase.');
  assert.equal(recovery.reply.kind, 'partial');
  assert.equal(recovery.uncertainTools[0].id, 'tool-check');
  const retry = resumeAttemptId => dispatch(store, 'coach', undefined, undefined, job => {
    assert.equal(job.attempt.restartedFrom, 'first');
    assert.equal(job.inputs[0].digest, record.digest);
    assert.equal(job.attempt.codexHistory?.threadId, resumeAttemptId ? 'native-thread' : undefined);
    assert.deepEqual(job.workspaceFiles, files);
    assert.deepEqual(job.attempt.workspaceInput, attempt.workspaceCheckpoint);
    assert.deepEqual(job.attempt.workspaceCheckpointFrom, { attemptId: attempt.id,
      artifactId: attempt.workspaceCheckpoint.artifactId, digest: attempt.workspaceCheckpoint.digest });
    assert.ok(job.attempt.effectivePermissions.tools.includes('checkpoint_workspace'));
    return { outcome: 'history-unavailable' };
  }, db, { resumeAttemptId });
  await retry(attempt.id);
  await retry();
  await store.update(run => {
    run.artifacts.find(record => record.id === attempt.workspaceCheckpoint.artifactId).content = '{}';
  });
  await assert.rejects(retry(), /saved workspace checkpoint cannot be verified/);
});

test('worker observation refreshes a running snapshot after its worker commits a result and releases its lock', { skip: !postgres }, async t => {
  const { db } = await testDatabase(t);
  const store = runStore(db, 'rhythm-completed');
  await store.create({ id: 'rhythm-completed', project: { id: 'music-transcribe' }, artifacts: [],
    tasks: [{ packet: { id: 'coach' }, attempts: [] }] });
  const running = await store.withWorker(async worker => {
    await worker.update(run => run.tasks[0].attempts.push({ id: 'first', outcome: 'running', workerId: worker.workerId }));
    const snapshot = await store.read();
    await worker.update(run => {
      run.tasks[0].attempts[0].outcome = 'completed';
      run.artifacts.push(artifact('answer', 'Answer', 'text', 'Repeat slowly.', {}));
    });
    return snapshot;
  });
  const [observed] = await observeRunWorkers(db, [running]);
  assert.equal(observed.tasks[0].attempts[0].outcome, 'completed');
  assert.equal(observed.tasks[0].attempts[0].workerStatus, undefined);
  assert.equal(observed.artifacts[0].content, 'Repeat slowly.');
});

test('guidance and stops target a specific active turn and record confirmed delivery', async () => {
  const store = memoryRunStore();
  await store.create({ tasks: [{ packet: { id: 'review' }, attempts: [{ id: 'first', outcome: 'running' }] }] });
  const worker = workflowSessionControls(store, 'review', 'first');
  await worker.ready({ threadId: 'codex-thread', turnId: 'codex-turn' });
  const submit = (kind, message, turnId = 'codex-turn') =>
    queueWorkflowSessionAction(store, 'review', 'first', { kind, message, turnId });

  await assert.rejects(submit('steer', 'Another task', 'stale-turn'), /turn has ended/);
  await submit('steer', 'Focus on the first phrase.');
  const guidance = await worker.next();
  assert.equal(guidance.status, 'sending');
  assert.equal(guidance.text, 'Focus on the first phrase.');
  assert.equal(await worker.next(), null);
  await worker.settle(guidance.id, 'acknowledged');
  await submit('interrupt');
  await submit('interrupt');
  await assert.rejects(submit('steer', 'One more instruction'), /stopping/);
  const interrupt = await worker.next();
  assert.equal(interrupt.kind, 'interrupt');
  await store.update(run => {
    const attempt = run.tasks[0].attempts[0];
    attempt.outcome = 'interrupted';
    finishWorkflowSession(attempt);
  });
  const { actions } = (await store.read()).tasks[0].attempts[0].codexSession;
  assert.deepEqual(actions.map(action => action.status), ['acknowledged', 'unknown']);
  await assert.rejects(submit('steer', 'Too late'), /turn has ended/);
});

test('a same-session follow-up preserves old actions and only accepts controls for its active turn', async () => {
  const store = memoryRunStore();
  await store.create({ tasks: [{ packet: { id: 'review' }, attempts: [{ id: 'first', outcome: 'running' }] }] });
  const worker = workflowSessionControls(store, 'review', 'first');
  const submit = (turnId, kind, message) => queueWorkflowSessionAction(store, 'review', 'first', { turnId, kind, message });
  await worker.ready({ threadId: 'native-thread', turnId: 'first-turn', persisted: true });
  await worker.ask({ id: 'question', questions: [] });
  await submit('first-turn', 'steer', 'Check the first phrase.');
  const guidance = await worker.next();
  await worker.settle(guidance.id, 'acknowledged');
  assert.equal(await worker.endTurn('first-turn'), false);
  await assert.rejects(submit('first-turn', 'interrupt'), /turn has ended/);

  await worker.ready({ threadId: 'native-thread', turnId: 'follow-up-turn', persisted: true });
  await assert.rejects(submit('first-turn', 'steer', 'A stale form.'), /turn has ended/);
  await submit('follow-up-turn', 'interrupt');
  assert.equal(await worker.endTurn('follow-up-turn'), true);
  assert.equal(await worker.next(), null);
  const { actions, threadId, turnId } = (await store.read()).tasks[0].attempts[0].codexSession;
  assert.equal(threadId, 'native-thread');
  assert.equal(turnId, 'follow-up-turn');
  assert.deepEqual(actions.map(action => [action.turnId, action.status]), [
    ['first-turn', 'closed'], ['first-turn', 'acknowledged'], ['follow-up-turn', 'not-delivered'],
  ]);
});

test('the failed history lookup leaves the approved rework available without spending a turn', async () => {
  const store = memoryRunStore();
  await store.create({ id: 'lesson-rehearsal', project: { id: 'music-transcribe', runtime: { kind: 'codex' } },
    sourceCommit: 'fixture', tasks: [{ packet: { id: 'plan', revision: 1, profileId: 'coach', prerequisites: [],
      inputArtifacts: [], budget: { timeoutSeconds: 10, maxAttempts: 2 } }, attempts: [{ id: 'first', number: 1,
      packetRevision: 1, outcome: 'interrupted', decision: { disposition: 'rework', note: 'Use shorter intervals.' },
      codexSession: { persisted: true, threadId: 'native-thread', turnId: 'native-turn' } }] }],
    profiles: [{ id: 'coach', revision: 1, instructionId: 'instructions', skillIds: [],
      codexTools: [], codexRuntime: { liveSession: true, saveThread: true } }], artifacts: [
      artifact('instructions', 'Coach instructions', 'text', 'Prepare a short rhythm exercise.', {}),
    ] });
  const retry = (execute, resumeAttemptId) => dispatch(store, 'plan', undefined, undefined, execute, undefined, { resumeAttemptId });
  await assert.rejects(retry(() => assert.fail('A stale rework form must not start a worker.'), 'different-attempt'), /unavailable/);
  const failed = await retry(job => {
    assert.deepEqual(job.attempt.codexHistory, { kind: 'resume', taskId: 'plan', attemptId: 'first',
      threadId: 'native-thread', turnId: 'native-turn' });
    return { outcome: 'history-unavailable' };
  }, 'first');
  assert.equal(failed.outcome, 'history-unavailable');
  const fallback = await retry(job => {
    assert.equal(job.attempt.codexHistory, undefined);
    assert.deepEqual(job.task.rework, { attemptId: 'first', note: 'Use shorter intervals.' });
    return { outcome: 'interrupted' };
  });
  assert.equal(fallback.number, 3);
  assert.equal(fallback.outcome, 'interrupted');
});

test('answers belong to one active native request and use the options saved with it', async () => {
  const store = memoryRunStore();
  await store.create({ tasks: [{ packet: { id: 'review' }, attempts: [{ id: 'first', outcome: 'running' }] }] });
  const worker = workflowSessionControls(store, 'review', 'first');
  await worker.ready({ threadId: 'codex-thread', turnId: 'codex-turn' });
  const native = [
    { id: 'tempo', header: 'Tempo', question: 'Which speed?', options: [{ label: 'Slow', description: 'First pass' }] },
    { id: 'phrase', header: 'Phrase', question: 'Which phrase?', options: null },
  ];
  const questions = codexQuestionSet(native);
  assert.equal(codexQuestionSet([{ ...native[0], isSecret: true }]), null);
  const submit = (id, values, turnId = 'codex-turn') => queueWorkflowSessionAction(store, 'review', 'first', {
    kind: 'answer', turnId, requestId: id, form: new URLSearchParams(values),
  });
  await worker.ask({ id: 'selection', questions, blocking: true });
  await worker.ask({ id: 'expired', questions, blocking: false, expiresAt: '2020-01-01T00:00:00.000Z' });
  await assert.rejects(submit('expired', {}), /closed/);
  await assert.rejects(submit('selection', {}, 'different-turn'), /turn has ended/);
  await assert.rejects(submit('selection', { 'choice-0': 'Slow' }), /Choose an option/);
  await assert.rejects(submit('selection', { 'choice-0': '0' }), /Enter an answer/);
  assert.equal(await worker.next(), null);

  await submit('selection', { 'choice-0': '0', 'answer-0': 'Fast', 'answer-1': '  Opening <phrase>  ' });
  await assert.rejects(submit('selection', {}), /already has an answer/);
  const answer = await worker.next();
  assert.deepEqual(answer.answers, [{ text: 'Slow', freeform: false }, { text: 'Opening <phrase>', freeform: true }]);
  await worker.settle(answer.id, 'answered');
  await worker.settle('expired', 'closed');
  await worker.ask({ id: 'abandoned', questions, blocking: true });
  await store.update(run => finishWorkflowSession(run.tasks[0].attempts[0]));
  const { actions } = (await store.read()).tasks[0].attempts[0].codexSession;
  assert.deepEqual(actions.map(action => action.status), ['answered', 'closed', 'closed']);
});
