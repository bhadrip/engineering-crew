import assert from 'node:assert/strict';
import test from 'node:test';
import { saveReusableAgent } from '../lib/agent-library.mjs';
import { buildWorkflowSnapshot } from '../lib/workflow-editor.mjs';
import { evaluateWorkflowCondition } from '../lib/workflow-routing.mjs';
import { decide, dispatch, findArtifact, newRun, summarize } from '../lib/workflow.mjs';
import { artifactDigest, runStore } from '../lib/run-store.mjs';
import { openWorkflowSubmissionBridge, sendWorkflowSubmission } from '../lib/workflow-submissions.mjs';
import { musicBrowserTool } from '../lib/workflow-agent-tools.mjs';
import { browserActivitySlot } from '../lib/workflow-artifacts.mjs';
import { memoryRunStore, postgres, testDatabase } from '../test-support/stores.mjs';

test('JSON pointers support escaped keys, arrays, and distinguish missing values from null', () => {
  const content = '{"a/b":{"t~o":[null,3]}}';
  assert.deepEqual(evaluateWorkflowCondition({ pointer: '/a~1b/t~0o/0', operator: 'equals', expected: null }, content),
    { matched: true, found: true, actual: null });
  assert.deepEqual(evaluateWorkflowCondition({ pointer: '/a~1b/t~0o/length', operator: 'missing' }, content),
    { matched: true, found: false });
  assert.deepEqual(evaluateWorkflowCondition({ pointer: '/a~1b/missing', operator: 'different', expected: 'practice' }, content),
    { matched: true, found: false });
});

test('the accepted JSON route skips an unused branch and supplies only the selected result to a join', { skip: !postgres }, async t => {
  const { db } = await testDatabase(t);
  const project = { id: 'music-transcribe', name: 'Music Transcribe' };
  const saved = await saveReusableAgent(db, { projectId: project.id, name: 'Lesson coach', remit: 'Prepare a music lesson.',
    model: 'gpt-5.4', instructions: 'Use the lesson brief.', skills: [] });
  const agent = `library:${saved.id}:${saved.version}`;
  const step = (id, prerequisites, extra = {}) => ({ id, title: id, objective: 'Prepare rehearsal material.',
    owner: 'Project owner', agent, prerequisites, inputs: ['brief'], ...extra });
  const slot = (ref, kind) => ({ ref, id: ref, kind, title: ref, required: true, acceptance: 'Return the requested output.' });
  const condition = operator => ({ step: 'classify', output: 'route', pointer: '/route', operator, value: '"practice"' });
  const draft = { title: 'Rehearsal routing', goal: 'Choose a rehearsal plan.', brief: 'Plan the opening phrase.', steps: [
    step('join', ['practice', 'review'], { joinPrerequisites: ['practice', 'review'], inputs: [],
      routes: [{ step: 'practice', output: 'result' }, { step: 'review', output: 'result' }] }),
    step('review-extra', ['review']),
    step('review', ['classify'], { outputs: [slot('result', 'markdown')], runWhen: condition('different') }),
    step('practice', ['classify'], { outputs: [slot('result', 'markdown')], runWhen: condition('equals') }),
    step('classify', [], { outputs: [slot('route', 'json')] }),
  ] };
  const configured = () => buildWorkflowSnapshot(db, { project, workflowId: 'rehearsal-routing', sourceCommit: 'a'.repeat(40), draft });
  draft.steps[3].joinPrerequisites = ['classify'];
  await assert.rejects(configured(), /required JSON output/);
  delete draft.steps[3].joinPrerequisites;
  const store = memoryRunStore();
  await store.create(newRun(await configured(), 'rehearsal-routing-run'));
  const response = (slot, content) => ({ outcome: 'completed', receipt: { usage: null }, response: {
    state: 'completed', summary: 'Prepared practice material.', outputs: [{ slot, content }], decisions: [], questions: [], blockers: [],
  } });
  const classifier = await dispatch(store, 'classify', undefined, undefined, () => response('route', '{"route":"practice"}'));
  assert.equal((await store.read()).tasks.find(task => task.packet.id === 'practice').routing, undefined);
  await decide(store, 'classify', classifier.id, 'accepted', 'Route checked.');
  const byId = run => new Map(run.tasks.map(task => [task.packet.id, task]));
  const routed = await store.read();
  const states = byId(routed);
  assert.equal(states.get('practice').routing.status, 'matched');
  assert.equal(states.get('review').routing.status, 'skipped');
  assert.equal(states.get('review-extra').routing.reason, 'prerequisite-skipped');
  const reviewRoute = states.get('review').routing;
  const receipt = JSON.parse(findArtifact(routed, reviewRoute.artifactId).content);
  assert.equal(receipt.actual, 'practice');
  assert.equal(receipt.source.attemptId, classifier.id);
  const mustNotRun = () => assert.fail('No worker should start for an unavailable step');
  await assert.rejects(dispatch(store, 'review', undefined, undefined, mustNotRun), /skipped/);
  await assert.rejects(dispatch(store, 'join', undefined, undefined, mustNotRun), /Waiting for accepted handoff/);
  const practice = await dispatch(store, 'practice', undefined, undefined, job => {
    assert.equal(job.attempt.routingDecision.artifactId, states.get('practice').routing.artifactId);
    return response('result', 'Repeat the opening ālāpana.');
  });
  await decide(store, 'practice', practice.id, 'accepted', 'Practice steps checked.');
  const savedEvidence = findArtifact(await store.read(), reviewRoute.artifactId).content;
  await store.update(run => { findArtifact(run, reviewRoute.artifactId).content = 'tampered'; });
  assert.equal(byId(summarize(await store.read())).get('review').routingVerified, false);
  await assert.rejects(dispatch(store, 'join', undefined, undefined, mustNotRun), /digest/);
  await store.update(run => { run.artifacts.find(value => value.id === reviewRoute.artifactId).content = savedEvidence; });
  const joined = await dispatch(store, 'join', undefined, undefined, job => {
    assert.deepEqual(job.inputs.map(input => input.content), ['Repeat the opening ālāpana.']);
    assert.deepEqual(job.attempt.skippedPrerequisites, [{ taskId: 'review', artifactId: reviewRoute.artifactId, digest: reviewRoute.digest }]);
    return response('result', 'Practice plan ready.');
  });
  assert.equal(joined.outcome, 'completed');
  const summary = summarize(await store.read());
  assert.equal(summary.handoffs.skipped, 2);
  assert.equal(byId(summary).get('review').attempts.length, 0);
});

test('an accepted generated image is routed as a native image with the producing attempt and exact bytes', { skip: !postgres }, async t => {
  const { db } = await testDatabase(t);
  const project = { id: 'music-transcribe', name: 'Music Transcribe' };
  const designer = await saveReusableAgent(db, { projectId: project.id, name: 'Artwork designer', remit: 'Create lesson artwork.',
    model: '', instructions: 'Create the requested illustration.', skills: [],
    runtime: { workspace: 'tools', webSearch: 'disabled', reasoningEffort: '', imageGeneration: true } });
  const reviewer = await saveReusableAgent(db, { projectId: project.id, name: 'Artwork reviewer', remit: 'Review lesson artwork.',
    model: '', instructions: 'Check the attached illustration.', skills: [] });
  const assign = agent => `library:${agent.id}:${agent.version}`;
  const draft = { title: 'Lesson artwork', goal: 'Review an original image.', brief: 'Illustrate a musical note.', steps: [
    { id: 'design', title: 'Design the image', owner: 'Project owner', agent: assign(designer), objective: 'Illustrate a note.',
      prerequisites: [], inputs: ['brief'], responseMode: 'free-form',
      outputs: [{ ref: 'artwork', id: 'artwork', kind: 'image', title: 'Lesson artwork', required: true, acceptance: 'Return one illustration.' }] },
    { id: 'review', title: 'Review the image', owner: 'Project owner', agent: assign(reviewer), objective: 'Inspect the attached image.',
      prerequisites: ['design'], inputs: [], routes: [{ step: 'design', output: 'artwork' }] },
  ] };
  const snapshot = () => buildWorkflowSnapshot(db, { project, workflowId: 'lesson-artwork', sourceCommit: 'a'.repeat(40), draft });
  draft.steps[0].responseMode = 'structured';
  await assert.rejects(snapshot(), /Choose free-form replies/);
  draft.steps[0].responseMode = 'free-form';
  const store = runStore(db, 'lesson-artwork-run');
  await store.create(newRun(await snapshot(), 'lesson-artwork-run'));
  const bytes = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aYyUAAAAASUVORK5CYII=';
  const produced = await dispatch(store, 'design', undefined, undefined, async job => {
    assert.ok(job.attempt.effectivePermissions.tools.includes('list_generated_images'));
    await job.onCodexCheckpoint({ kind: 'launch', prompt: 'Illustrate a note.' });
    const image = await job.onGeneratedImage({ itemId: 'image-native', encoded: bytes });
    const bridge = await openWorkflowSubmissionBridge({ slots: job.task.outputs, listImages: () => [image],
      persist: entry => job.onCodexCheckpoint({ kind: 'submission', ...entry }) });
    const send = (kind, args) => sendWorkflowSubmission(bridge.connection, kind, args);
    try {
      assert.deepEqual(await send('images', {}), [image]);
      await assert.rejects(send('output', { slot: 'artwork', content: 'foreign-image' }), /saved by this attempt/);
      await send('output', { slot: 'artwork', content: image.artifactId });
      return { outcome: 'completed', response: 'Artwork ready.', submitted: await bridge.finish(),
        receipt: { usage: null, responseFormat: 'free-form', replyDigest: artifactDigest('Artwork ready.'),
          submittedOutputDigests: { artwork: image.digest } },
        activity: { responseFormat: 'free-form', response: 'Artwork ready.' } };
    } finally { await bridge.close(); }
  }, db);
  const [image] = produced.generatedImages;
  assert.equal(produced.result.artifacts.artwork, image.artifactId);
  const check = () => assert.fail('The image should still be waiting for acceptance');
  await assert.rejects(dispatch(store, 'review', undefined, undefined, check, db), /Waiting for accepted handoff/);
  await decide(store, 'design', produced.id, 'accepted', 'Artwork checked.');
  const reviewed = await dispatch(store, 'review', undefined, undefined, job => {
    const [input] = job.turnImages;
    assert.deepEqual(job.inputs, []);
    assert.equal(input.name, 'Lesson artwork');
    assert.equal(input.data.toString('base64'), bytes);
    assert.deepEqual(input.handoff, { taskId: 'design', attemptId: produced.id, slot: 'artwork', artifactId: image.artifactId, digest: image.digest });
    return { outcome: 'completed', receipt: { usage: null, imageInputs: job.attempt.imageInputs }, response: {
      state: 'completed', summary: 'Artwork checked.', outputs: [{ slot: 'result', content: 'The image is visible.' }],
      decisions: [], questions: [], blockers: [],
    } };
  }, db);
  assert.equal(reviewed.outcome, 'completed');
  const run = await store.read();
  assert.deepEqual(JSON.parse(findArtifact(run, reviewed.receiptId).content).imageInputs, reviewed.imageInputs);
  assert.ok(summarize(run).tasks.every(task => task.attempts[0].evidenceStatus === 'recorded'));
});

test('browser outputs refer to successful observations in the accepted attempt and hand off exact evidence', { skip: !postgres }, async t => {
  const { db } = await testDatabase(t);
  const project = { id: 'music-transcribe', name: 'Music Transcribe' };
  const image = 'sha256:' + 'a'.repeat(64);
  const sourceCommit = 'a'.repeat(40);
  const workspaceBaseline = { commit: sourceCommit, files: [
    { path: 'server.mjs', mode: '100644', data: Buffer.from('export {};').toString('base64') },
  ] };
  const agent = await saveReusableAgent(db, { projectId: project.id, name: 'Browser verifier', remit: 'Check the lesson controls.',
    model: '', instructions: 'Inspect playback.', skills: [], tools: [musicBrowserTool], musicBrowserProfile: { image },
    runtime: { workspace: 'read-only', webSearch: 'disabled', reasoningEffort: '' } });
  const slot = (id, kind) => ({ ref: id, id, kind, title: id, required: true, acceptance: 'Return the captured evidence.' });
  const step = { owner: 'Reviewer', agent: `library:${agent.id}:${agent.version}`, inputs: ['brief'] };
  const draft = { title: 'Review playback', goal: 'Review the observed behavior.', brief: 'Check the lesson.', steps: [
    { ...step, id: 'browse', title: 'Check playback', objective: 'Capture browser evidence.', prerequisites: [],
      workspaceSource: 'baseline', responseMode: 'free-form', outputs: [slot('screen', 'browser-screenshot'), slot('media', 'browser-report')] },
    { ...step, id: 'review', title: 'Review evidence', objective: 'Review the artifacts.', prerequisites: ['browse'], inputs: [],
      routes: [{ step: 'browse', output: 'screen' }, { step: 'browse', output: 'media' }] },
  ] };
  const configure = () => buildWorkflowSnapshot(db, { project, workflowId: 'browser-review', sourceCommit, draft, workspaceBaseline });
  draft.steps[0].responseMode = 'structured';
  await assert.rejects(configure(), /Choose free-form replies/);
  draft.steps[0].responseMode = 'free-form';
  const store = memoryRunStore();
  await store.create(newRun(await configure(), 'browser-review-run'));
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aYyUAAAAASUVORK5CYII=', 'base64');
  const produced = await dispatch(store, 'browse', undefined, undefined, async job => {
    await job.onCodexCheckpoint({ kind: 'launch', prompt: 'Watch playback.' });
    const report = { kind: 'workspace-browser', image, workspaceDigest: job.attempt.workspaceInput.digest };
    const wrong = await job.onBrowserAction({ ...report, action: 'observe_media', workspaceDigest: 'b'.repeat(64) });
    const failed = await job.onBrowserAction({ ...report, action: 'observe_media', error: 'No audio element.' });
    const screenshot = await job.onBrowserAction({ ...report, action: 'screenshot' }, bytes);
    const media = await job.onBrowserAction({ ...report, action: 'observe_media', result: { advancingIntervals: 4 } });
    const bridge = await openWorkflowSubmissionBridge({ slots: job.task.outputs,
      persist: entry => job.onCodexCheckpoint({ kind: 'submission', ...entry }) });
    const submit = (slot, content) => sendWorkflowSubmission(bridge.connection, 'output', { slot, content });
    try {
      await assert.rejects(submit('screen', 'browser-screenshot-other-attempt-1'), /recorded by this attempt/);
      await assert.rejects(submit('screen', media.evidenceId), /image artifact from a browser screenshot/);
      await assert.rejects(submit('media', wrong.evidenceId), /different workspace/);
      await assert.rejects(submit('media', failed.evidenceId), /successful browser action/);
      await submit('screen', screenshot.imageEvidence.artifactId);
      await submit('media', media.evidenceId);
      const submitted = await bridge.finish();
      return { outcome: 'completed', response: 'Evidence recorded.', submitted,
        receipt: { usage: null, responseFormat: 'free-form', replyDigest: artifactDigest('Evidence recorded.'),
          submittedOutputDigests: Object.fromEntries(submitted.outputs.map(output => [output.slot, output.evidence.digest])) },
        activity: { responseFormat: 'free-form', response: 'Evidence recorded.' } };
    } finally { await bridge.close(); }
  });
  assert.equal(produced.outcome, 'completed', produced.error);
  await assert.rejects(dispatch(store, 'review', undefined, undefined, () => assert.fail('Wait for acceptance')), /Waiting for accepted handoff/);
  await decide(store, 'browse', produced.id, 'accepted', 'Evidence checked.');
  const reviewed = await dispatch(store, 'review', undefined, undefined, job => {
    const [observation] = job.inputs;
    assert.equal(observation.id, produced.result.artifacts.media);
    assert.equal(JSON.parse(observation.content).workspaceArtifactId, produced.workspaceInput.artifactId);
    assert.deepEqual(job.turnImages[0].data, bytes);
    assert.deepEqual(job.attempt.handoffs.map(handoff => [handoff.attemptId, handoff.artifactId]), [
      [produced.id, produced.result.artifacts.screen], [produced.id, produced.result.artifacts.media],
    ]);
    return { outcome: 'completed', receipt: { usage: null, imageInputs: job.attempt.imageInputs },
      response: { state: 'completed', summary: 'Evidence reviewed.', outputs: [{ slot: 'result', content: 'Review complete.' }],
        decisions: [], questions: [], blockers: [] } };
  });
  assert.equal(reviewed.outcome, 'completed');
  assert.ok(summarize(await store.read()).tasks.every(task => task.attempts[0].evidenceStatus === 'recorded'));
});

test('browser activity routes the accepted attempt’s exact action records and rejects missing or changed evidence', { skip: !postgres }, async t => {
  const { db } = await testDatabase(t);
  const project = { id: 'music-transcribe', name: 'Music Transcribe' };
  const image = 'sha256:' + 'a'.repeat(64);
  const sourceCommit = 'a'.repeat(40);
  const workspaceBaseline = { commit: sourceCommit, files: [
    { path: 'server.mjs', mode: '100644', data: Buffer.from('export {};').toString('base64') },
  ] };
  const save = (name, tools) => saveReusableAgent(db, { projectId: project.id, name, remit: 'Check the lesson controls.',
    model: '', instructions: 'Inspect playback.', skills: [], tools,
    ...(tools.includes(musicBrowserTool) && { musicBrowserProfile: { image } }),
    runtime: { workspace: 'read-only', webSearch: 'disabled', reasoningEffort: '' } });
  const browser = await save('Browser verifier', [musicBrowserTool]);
  const review = await save('Independent reviewer', []);
  const agent = value => `library:${value.id}:${value.version}`;
  const step = { owner: 'Reviewer', inputs: ['brief'], objective: 'Inspect the evidence.' };
  const draft = { title: 'Review playback activity', goal: 'Review the observed behavior.', brief: 'Check the lesson.', steps: [
    { ...step, id: 'browse', title: 'Check playback', agent: agent(review), prerequisites: [], workspaceSource: 'baseline' },
    { ...step, id: 'review', title: 'Review evidence', agent: agent(review), prerequisites: ['browse'], inputs: [],
      routes: [{ step: 'browse', output: browserActivitySlot }] },
  ] };
  const configure = () => buildWorkflowSnapshot(db, { project, workflowId: 'browser-activity', sourceCommit, draft, workspaceBaseline });
  await assert.rejects(configure(), /Attach the workspace browser/);
  draft.steps[0].agent = agent(browser);
  const store = memoryRunStore();
  await store.create(newRun(await configure(), 'browser-activity-run'));
  const response = { outcome: 'completed', receipt: { usage: null }, response: { state: 'completed', summary: 'Checked playback.',
    outputs: [{ slot: 'result', content: 'Review the observed playback.' }], decisions: [], questions: [], blockers: [] } };
  const missing = await dispatch(store, 'browse', undefined, undefined, () => response);
  await assert.rejects(decide(store, 'browse', missing.id, 'accepted', 'Looked good.'), /Required outputs and evidence/);
  await decide(store, 'browse', missing.id, 'rework', 'Capture the browser activity.');
  const produced = await dispatch(store, 'browse', undefined, undefined, async job => {
    const report = { kind: 'workspace-browser', image, workspaceDigest: job.attempt.workspaceInput.digest };
    await job.onBrowserAction({ ...report, action: 'open' });
    await job.onBrowserAction({ ...report, action: 'observe_media', error: 'No audio element.' });
    await job.onBrowserAction({ ...report, action: 'observe_media', result: { advancingIntervals: 4 } });
    return response;
  });
  await decide(store, 'browse', produced.id, 'accepted', 'Browser activity is recorded.');
  const first = findArtifact(await store.read(), produced.browserActionIds[0]);
  await store.update(run => {
    const current = findArtifact(run, first.id);
    current.content = JSON.stringify({ ...JSON.parse(first.content), title: 'Replaced' });
    current.digest = artifactDigest(current.content);
  });
  await assert.rejects(dispatch(store, 'review', undefined, undefined, () => assert.fail('Verify evidence before dispatch')),
    /Waiting for accepted handoff|not been accepted/);
  await store.update(run => { Object.assign(run.artifacts.find(record => record.id === first.id), first); });
  const reviewed = await dispatch(store, 'review', undefined, undefined, job => {
    assert.deepEqual(job.inputs.map(input => input.id), produced.browserActionIds);
    assert.deepEqual(job.inputs.map(input => JSON.parse(input.content).error), [undefined, 'No audio element.', undefined]);
    assert.ok(job.attempt.handoffs.every(handoff => handoff.attemptId === produced.id && handoff.slot === browserActivitySlot));
    return response;
  });
  const run = await store.read();
  const receipt = JSON.parse(findArtifact(run, reviewed.receiptId).content);
  assert.deepEqual(receipt.runtimeHandoffs.map(({ artifactId, digest }) => [artifactId, digest]),
    produced.browserActionIds.map(id => [id, findArtifact(run, id).digest]));
  assert.equal(summarize(run).tasks[1].attempts[0].evidenceStatus, 'recorded');
});
