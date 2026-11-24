import assert from 'node:assert/strict';
import test from 'node:test';
import { approvalReview, approvalReviewLabel, codexApproval } from '../lib/workflow-approvals.mjs';
import { finishWorkflowSession, queueWorkflowSessionAction, workflowSessionControls } from '../lib/workflow-session.mjs';
import { memoryRunStore } from '../test-support/stores.mjs';

test('command and file approval options retain the native decisions and reviewed details', () => {
  const rule = { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['printf', 'lesson'] } };
  const command = codexApproval('item/commandExecution/requestApproval', {
    command: "printf 'lesson'", cwd: '/tmp/rehearsal', availableDecisions: ['accept', rule, 'decline'],
  });
  assert.equal(command.approval.command, "printf 'lesson'");
  assert.deepEqual(command.approval.choices, ['Allow once', 'Allow and save command rule ["printf","lesson"]', 'Decline']);
  assert.deepEqual(command.respond(approvalReview(command.approval, new URLSearchParams({ choice: '1' }))), { decision: rule });
  assert.throws(() => approvalReview(command.approval, new URLSearchParams({ choice: 'acceptForSession' })), /Choose a decision/);
  const patch = { path: '/tmp/rehearsal/notes.md', diff: '+Practice the opening phrase', kind: { type: 'add' } };
  const change = codexApproval('item/fileChange/requestApproval', { reason: 'Review a rehearsal note' }, { changes: [patch] });
  assert.deepEqual(change.approval.changes, [patch]);
  assert.deepEqual(change.respond({ choice: 2 }), { decision: 'decline' });
  const missing = codexApproval('item/fileChange/requestApproval', {});
  assert.deepEqual(missing.approval.choices, ['Decline', 'Cancel turn']);
});

test('permission review can grant exactly the requested subset for a turn or session', () => {
  const read = { path: { type: 'path', path: '/tmp/rehearsal/notes.md' }, access: 'read' };
  const write = { path: { type: 'path', path: '/tmp/rehearsal/output.md' }, access: 'write' };
  const request = codexApproval('item/permissions/requestApproval', {
    cwd: '/tmp/rehearsal', permissions: { network: { enabled: true }, fileSystem: { entries: [read, write], read: null, write: null } },
  });
  const form = (...entries) => new URLSearchParams(entries);
  const review = approvalReview(request.approval, form(['choice', 'turn'], ['grant', '1'], ['grant', '1']));
  assert.deepEqual(request.respond(review), { scope: 'turn', permissions: { fileSystem: { read: null, write: null, entries: [read] } } });
  assert.equal(approvalReviewLabel(request.approval, review), 'Allow for this turn · Read /tmp/rehearsal/notes.md');
  assert.deepEqual(request.respond(approvalReview(request.approval, form(['choice', 'session'], ['grant', '0']))),
    { scope: 'session', permissions: { network: { enabled: true } } });
  assert.deepEqual(request.respond(approvalReview(request.approval, form(['choice', 'decline'], ['grant', '0']))),
    { scope: 'turn', permissions: {} });
  assert.throws(() => approvalReview(request.approval, form(['choice', 'turn'])), /Select at least one/);
  assert.throws(() => approvalReview(request.approval, form(['choice', 'turn'], ['grant', '3'])), /Choose a decision/);
});

test('a decision is bound to one request in the current turn and closes when the worker finishes', async () => {
  const store = memoryRunStore();
  await store.create({ tasks: [{ packet: { id: 'plan' }, attempts: [{ id: 'attempt', outcome: 'running' }] }] });
  const worker = workflowSessionControls(store, 'plan', 'attempt');
  await worker.ready({ threadId: 'thread', turnId: 'turn' });
  const { approval } = codexApproval('item/commandExecution/requestApproval', {
    command: 'printf tempo', availableDecisions: ['accept', 'decline'],
  });
  await worker.ask({ id: 'first', kind: 'approval', approval });
  await worker.ask({ id: 'second', kind: 'approval', approval });
  const review = (requestId, turnId = 'turn', choice = '1') => queueWorkflowSessionAction(store, 'plan', 'attempt', {
    kind: 'approval', requestId, turnId, form: new URLSearchParams({ choice }),
  });
  await assert.rejects(review('first', 'old-turn'), /turn has ended/);
  await assert.rejects(review('first', 'turn', '2'), /Choose a decision/);
  await review('first');
  await assert.rejects(review('first'), /already has a decision/);
  const selected = await worker.next();
  assert.equal(selected.id, 'first');
  assert.deepEqual(selected.review, { choice: 1 });
  await worker.settle(selected.id, 'acknowledged');
  await store.update(run => finishWorkflowSession(run.tasks[0].attempts[0]));
  const { actions } = (await store.read()).tasks[0].attempts[0].codexSession;
  assert.deepEqual(actions.map(action => action.status), ['acknowledged', 'closed']);
});
