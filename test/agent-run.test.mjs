import assert from 'node:assert/strict';
import test from 'node:test';
import { agentRunTask, createAgentDraftRun, createAgentRun, listAgentRuns } from '../lib/agent-run.mjs';
import { listReusableAgentVersions, prepareReusableAgent, saveReusableAgent } from '../lib/agent-library.mjs';
import { listRegisteredWorkflows } from '../lib/project-store.mjs';
import { projectRuns } from '../lib/project-runs.mjs';
import { artifactDigest, listRuns, runStore } from '../lib/run-store.mjs';
import { dispatch, dispatchNext, findArtifact, queueAgentFollowUp, summarize } from '../lib/workflow.mjs';
import { agentImageArtifacts, normalizeAgentImages, readAgentImage } from '../lib/agent-images.mjs';
import { postgres, testDatabase } from '../test-support/stores.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aYyUAAAAASUVORK5CYII=', 'base64');

test('turn images preserve exact bytes and reject invalid types, dimensions, and changed digests', () => {
  const [record] = agentImageArtifacts(normalizeAgentImages([{ name: 'mock/ui.png', data: png }]), 1);
  assert.equal(record.title, 'ui.png');
  assert.deepEqual(readAgentImage(record).data, png);
  assert.equal(record.provenance.sha256, artifactDigest(png));
  assert.throws(() => normalizeAgentImages([{ name: 'unsafe.png', data: Buffer.from('<svg/>') }]), /Choose a PNG or JPEG/);
  const tooWide = Buffer.from(png);
  tooWide.writeUInt32BE(8193, 16);
  assert.throws(() => normalizeAgentImages([{ name: 'wide.png', data: tooWide }]), /8192 pixels/);
  assert.throws(() => readAgentImage({ ...record, provenance: { ...record.provenance, sha256: 'f'.repeat(64) } }), /recorded digest/);
});

test('direct agent runs pin the requested revision and execute once across duplicate submissions', { skip: !postgres }, async t => {
  const { db } = await testDatabase(t);
  const project = { id: 'music-transcribe', name: 'Music Transcribe' };
  const definition = { projectId: project.id, name: 'Rhythm coach', remit: 'Design practice drills.', model: 'gpt-5.4',
    instructions: 'Use the slow practice cue.', skills: [{ name: 'Rhythm notes', content: 'Keep the first pass at 60 BPM.' }],
    tools: ['read_input'] };
  const first = await saveReusableAgent(db, definition);
  await saveReusableAgent(db, { ...definition, id: first.id, expectedVersion: first.version, instructions: 'Use the updated cue.' });
  const runId = 'agent-run-aabb00112233445566778899aabbccdd';
  const request = { project, agent: first, runId, sourceCommit: 'a'.repeat(40),
    prompt: 'Arrange two practice repetitions.', reference: 'Begin with the opening tāḷa.',
    images: [{ name: 'rehearsal.png', data: png }] };
  await Promise.all([createAgentRun(db, request), createAgentRun(db, request)]);
  await assert.rejects(createAgentRun(db, { ...request, prompt: 'Run a different prompt.' }), /already submitted/);
  await assert.rejects(createAgentRun(db, { ...request, images: [] }), /already submitted/);
  assert.deepEqual(await listRegisteredWorkflows(db, project.id), []);
  assert.deepEqual(await listRuns(db), []);

  const store = runStore(db, runId);
  const reply = '# Practice plan\n\n' + 'Repeat the opening phrase twice.\n'.repeat(650);
  let executed = 0;
  const execute = async job => {
    executed++;
    assert.equal(job.standaloneAgent, true);
    assert.deepEqual(job.instructions, [definition.instructions, definition.skills[0].content]);
    assert.deepEqual(job.profile.codexTools, definition.tools);
    assert.deepEqual(job.inputs.map(input => input.content), [request.prompt, request.reference]);
    assert.deepEqual(job.turnImages[0].data, png);
    assert.deepEqual(job.attempt.imageInputs, [{ artifactId: 'agent-image-1-1', name: 'rehearsal.png',
      mimeType: 'image/png', bytes: png.length, sha256: artifactDigest(png) }]);
    return { outcome: 'completed', receipt: { usage: null, imageInputs: job.attempt.imageInputs }, response: reply };
  };
  const results = await Promise.allSettled([dispatch(store, agentRunTask, undefined, undefined, execute),
    dispatch(store, agentRunTask, undefined, undefined, execute)]);
  assert.equal(executed, 1);
  assert.equal(results.find(result => result.status === 'fulfilled').value.outcome, 'completed');
  assert.deepEqual(await createAgentRun(db, request), { needsDispatch: false });
  const [run] = await listAgentRuns(db, project.id, first.id);
  assert.equal(run.agentRun.version, 1);
  const saved = await store.read();
  assert.equal(findArtifact(saved, 'input-brief').provenance.source, 'agent-run');
  assert.equal(findArtifact(saved, 'input-reference').content, request.reference);
  assert.equal(saved.tasks[0].attempts.length, 1);
  assert.equal(findArtifact(saved, saved.tasks[0].attempts[0].result.artifacts.result).content, reply);
  await assert.rejects(queueAgentFollowUp(store, agentRunTask, {
    attemptId: saved.tasks[0].attempts[0].id, kind: 'resume', message: 'Continue the drill.',
  }), /no matching saved Codex conversation/);
});

test('a Music Transcribe draft test pins the editor definition without publishing an agent version', { skip: !postgres }, async t => {
  const { db } = await testDatabase(t);
  const project = { id: 'music-transcribe', name: 'Music Transcribe' };
  const fields = { projectId: project.id, name: 'Rhythm coach', remit: 'Review local practice cues.', model: '',
    instructions: 'Use the saved cue.', skills: [], tools: [] };
  const baseAgent = await saveReusableAgent(db, fields);
  const definition = await prepareReusableAgent(db, { ...fields, instructions: 'Use the draft cue.',
    skills: [{ name: 'Draft rubric', content: 'Mention the draft marker.' }], tools: ['read_input'],
    runtime: { workspace: 'read-only', webSearch: 'disabled', reasoningEffort: 'medium', serviceTier: 'default' } });
  const runId = 'agent-run-44cc00112233445566778899aabbccdd';
  const request = { project, baseAgent, definition, runId, sourceCommit: 'a'.repeat(40),
    prompt: 'Try the draft cue.', reference: 'Draft reference.', images: [{ name: 'rehearsal.png', data: png }] };
  await Promise.all([createAgentDraftRun(db, request), createAgentDraftRun(db, request)]);
  await assert.rejects(createAgentDraftRun(db, { ...request, definition: { ...definition, instructions: 'Different instructions.' } }), /already submitted/);
  assert.deepEqual(await listReusableAgentVersions(db, baseAgent.id, project.id), [1]);
  assert.deepEqual(await listAgentRuns(db, project.id, baseAgent.id), []);

  const store = runStore(db, runId);
  const attempt = await dispatch(store, agentRunTask, undefined, undefined, async job => {
    assert.deepEqual(job.instructions, [definition.instructions, definition.skills[0].content]);
    assert.deepEqual(job.profile.codexTools, definition.tools);
    assert.deepEqual(job.profile.codexRuntime, definition.runtime);
    assert.equal(job.attempt.agentDraft.baseAgentId, baseAgent.id);
    assert.equal(job.standaloneAgent, true);
    assert.deepEqual(job.turnImages[0].data, png);
    assert.equal(job.attempt.requestedServiceTier, 'default');
    const codexSpeed = { requested: 'default', applied: 'default' };
    await job.onAgentActivity({ kind: 'speed', speed: codexSpeed });
    return { outcome: 'completed', response: 'Draft marker.', receipt: { usage: null, imageInputs: job.attempt.imageInputs, codexSpeed } };
  });
  const saved = await store.read();
  const evidence = findArtifact(saved, saved.agentRun.draft.artifactId);
  assert.deepEqual(JSON.parse(evidence.content), definition);
  assert.equal(evidence.digest, saved.agentRun.draft.digest);
  assert.equal(findArtifact(saved, saved.profiles[0].instructionId).provenance.source, 'agent-draft');
  assert.deepEqual(JSON.parse(findArtifact(saved, attempt.receiptId).content).agentDraft, saved.agentRun.draft);
  assert.deepEqual(attempt.codexSpeed, { requested: 'default', applied: 'default' });
  assert.equal(summarize(saved).tasks[0].attempts[0].evidenceStatus, 'recorded');
  assert.deepEqual((await projectRuns(db, project.id, { type: 'agent-draft', query: baseAgent.id, page: 1 }))
    .entries.map(({ kind, run }) => [kind, run.id]), [['agent-draft', runId]]);
  evidence.content = '{}';
  assert.equal(summarize(saved).tasks[0].attempts[0].evidenceStatus, 'missing');
});

test('a direct agent conversation queues each message once and carries its pinned history and workspace into a fork', { skip: !postgres }, async t => {
  const { db } = await testDatabase(t);
  const project = { id: 'music-transcribe', name: 'Music Transcribe' };
  const definition = { projectId: project.id, name: 'Practice agent', remit: 'Record rehearsal notes.', model: 'gpt-5.4',
    instructions: 'Use the original practice notes.', skills: [{ name: 'Practice rubric', content: 'Keep the opening rhythm.' }], tools: ['read_input'],
    runtime: { workspace: 'workspace-write', webSearch: 'disabled', reasoningEffort: '', liveSession: true, saveThread: true } };
  const agent = await saveReusableAgent(db, definition);
  const runId = 'agent-run-ddcc00112233445566778899aabbccdd';
  const store = runStore(db, runId);
  const prompt = 'Save the opening phrase.';
  const reference = 'Use the first tāḷa.';
  await createAgentRun(db, { project, agent, runId, sourceCommit: 'a'.repeat(40), prompt, reference });
  await saveReusableAgent(db, { ...definition, id: agent.id, expectedVersion: agent.version, instructions: 'Changed instructions.' });
  const originalThread = '26761c9d-2d57-40d7-9fcc-2bd0764527ce';
  const forkedThread = '03657092-7c42-48a6-ba91-5f5f2e7c2bd6';
  const session = (n, threadId = originalThread) => ({
    threadId, turnId: '9bb6426b-01c7-41e2-94a7-00000000000' + n,
  });
  const finish = async (job, n, threadId) => {
    assert.equal(job.profile.revision, 1);
    assert.deepEqual(job.instructions, [definition.instructions, definition.skills[0].content]);
    assert.equal(job.task.captureWorkspace, true);
    assert.equal(job.inputs[1].content, reference);
    const native = session(n, threadId);
    await job.sessionControls.ready({ ...native, persisted: true });
    return { outcome: 'completed', receipt: { usage: null, ...native, explicitSkills: job.attempt.skillInputs, imageInputs: job.attempt.imageInputs },
      response: { state: 'completed', summary: 'Saved turn ' + n, outputs: [{ slot: 'result', content: 'Reply ' + n }],
        decisions: [], questions: [], blockers: [] },
      workspaceFiles: [{ path: 'rehearsal.txt', mode: '100644', data: Buffer.from('Notes from turn ' + n).toString('base64') }] };
  };
  const first = await dispatch(store, agentRunTask, undefined, undefined, job => finish(job, 1));
  const send = { attemptId: first.id, kind: 'resume', message: 'Add a second phrase.', invokeSkills: [1],
    images: [{ name: 'second-phrase.png', data: png }] };
  await assert.rejects(queueAgentFollowUp(store, agentRunTask, { ...send, invokeSkills: [2] }), /attached to this agent/);
  await Promise.all([queueAgentFollowUp(store, agentRunTask, send), queueAgentFollowUp(store, agentRunTask, send)]);
  await assert.rejects(queueAgentFollowUp(store, agentRunTask, { ...send, images: [] }), /Review the latest reply/);
  await assert.rejects(queueAgentFollowUp(store, agentRunTask, { ...send, invokeSkills: [] }), /Review the latest reply/);
  await assert.rejects(queueAgentFollowUp(store, agentRunTask, { ...send, message: 'A conflicting submission.' }), /Review the latest reply/);
  const queued = await store.read();
  assert.equal(queued.automation.pending, true);
  assert.equal(queued.tasks[0].packet.revision, 2);
  assert.equal(queued.tasks[0].attempts.length, 1);
  assert.equal(findArtifact(queued, 'input-brief').content, prompt);
  assert.equal(findArtifact(queued, 'agent-message-2').content, send.message);
  let executions = 0;
  const execute = async job => {
    executions++;
    assert.deepEqual(job.attempt.codexHistory, { kind: 'resume', taskId: agentRunTask, attemptId: first.id, ...session(1) });
    assert.equal(job.agentMessage.content, send.message);
    assert.deepEqual(job.invokeSkills, [1]);
    assert.deepEqual(job.turnImages[0].data, png);
    assert.equal(job.attempt.imageInputs[0].artifactId, 'agent-image-2-1');
    assert.equal(job.attempt.skillInputs[0].digest, findArtifact(queued, job.profile.skillIds[0]).digest);
    assert.deepEqual(job.attempt.workspaceInput, first.workspaceOutput);
    assert.equal(Buffer.from(job.workspaceFiles[0].data, 'base64').toString(), 'Notes from turn 1');
    return finish(job, 2);
  };
  const results = await Promise.all([dispatchNext(store, undefined, undefined, execute), dispatchNext(store, undefined, undefined, execute)]);
  assert.equal(executions, 1);
  const second = results.find(Boolean);
  await queueAgentFollowUp(store, agentRunTask, { attemptId: second.id, kind: 'fork', message: 'Try another opening.' });
  const queuedFork = summarize(await store.read(), { includeAgentConversation: true }).tasks[0];
  assert.equal(queuedFork.conversation.at(-1).mode, 'fork');
  assert.equal(queuedFork.conversation.at(-1).attemptId, undefined);
  const third = await dispatchNext(store, undefined, undefined, job => {
    assert.deepEqual(job.attempt.codexHistory, { kind: 'fork', taskId: agentRunTask, attemptId: second.id, ...session(2) });
    assert.deepEqual(job.attempt.workspaceInput, second.workspaceOutput);
    assert.equal(job.invokeSkills, undefined);
    assert.equal(job.turnImages, undefined);
    assert.equal(Buffer.from(job.workspaceFiles[0].data, 'base64').toString(), 'Notes from turn 2');
    return finish(job, 3, forkedThread);
  });
  assert.equal(third.codexSession.threadId, forkedThread);
  const { tasks: [task], automation } = summarize(await store.read(), { includeAgentConversation: true });
  assert.equal(automation.pending, false);
  assert.deepEqual(task.conversation.map(turn => [turn.message, turn.response, turn.mode]), [
    [prompt, 'Reply 1', undefined], [send.message, 'Reply 2', 'resume'], ['Try another opening.', 'Reply 3', 'fork'],
  ]);
  assert.deepEqual(task.conversation.map(turn => turn.imageIds), [[], ['agent-image-2-1'], []]);
  assert.ok(task.attempts.every(attempt => attempt.evidenceStatus === 'recorded'));
});
