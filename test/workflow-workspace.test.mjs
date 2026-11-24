import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { saveReusableAgent } from '../lib/agent-library.mjs';
import { createAgentRun } from '../lib/agent-run.mjs';
import { git } from '../lib/feature-workspace.mjs';
import { captureGitWorkspace, gitControl, resolveCommit } from '../lib/git-control.mjs';
import { decide, dispatch, dispatchNext, findArtifact, newRun, prepareWorkflowRun, publishWorkspaceDelivery, requestWorkspaceRepair, summarize } from '../lib/workflow.mjs';
import { buildWorkflowSnapshot } from '../lib/workflow-editor.mjs';
import { captureWorkflowWorkspace, materializeWorkspaceFiles, readWorkspaceArtifact } from '../lib/workflow-workspace.mjs';
import { memoryRunStore, postgres, testDatabase } from '../test-support/stores.mjs';
import { artifactDigest, runStore } from '../lib/run-store.mjs';
import { musicWorkspaceCheck, pinMusicPracticeChecks, pinMusicWorkspaceChecks } from '../lib/workflow-music-checks.mjs';
import { musicPracticeTool } from '../lib/workflow-agent-tools.mjs';
import { openMusicPracticeBridge } from '../lib/workflow-music-practice.mjs';
import { openWorkspacePreview, stopWorkspacePreview } from '../lib/workflow-preview.mjs';
import { execFileSync } from 'node:child_process';

const file = (path, text, mode = '100644') => ({ path, mode, data: Buffer.from(text).toString('base64') });

test('workspace capture preserves bytes and modes and excludes runtime inputs', async t => {
  const root = await mkdtemp(join(tmpdir(), 'crew-workspace-capture-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'crew-inputs'));
  await writeFile(join(root, 'crew-inputs', 'input-1.txt'), 'Operator context');
  await writeFile(join(root, 'sample.bin'), Buffer.from([0, 255]));
  await writeFile(join(root, 'play.sh'), '#!/bin/sh\necho test\n');
  await chmod(join(root, 'play.sh'), 0o700);
  assert.deepEqual(await captureWorkflowWorkspace(root, 'crew-inputs'), [file('play.sh', '#!/bin/sh\necho test\n', '100755'), file('sample.bin', [0, 255])]);
  await symlink(join(root, '..'), join(root, 'outside'));
  await assert.rejects(captureWorkflowWorkspace(root, 'crew-inputs'), /inside the assignment/);
});

test('native workspace handoffs pin committed files and stage the accepted output bytes', { skip: !postgres }, async t => {
  const { db } = await testDatabase(t);
  const root = await mkdtemp(join(tmpdir(), 'crew-workspace-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, ['init', '--initial-branch=main', '--template=']);
  await writeFile(join(root, 'lesson.txt'), 'Original lesson.');
  await git(root, ['add', '--', 'lesson.txt']);
  await git(root, ['commit', '-m', 'Initial lesson']);
  await writeFile(join(root, 'lesson.txt'), 'Uncommitted draft.');
  const checkout = gitControl(root);
  const sourceCommit = resolveCommit(checkout);
  const workspaceBaseline = captureGitWorkspace(checkout, sourceCommit, ['lesson.txt']);
  assert.deepEqual(workspaceBaseline.files, [file('lesson.txt', 'Original lesson.')]);
  const project = { id: 'music-transcribe', name: 'Music Transcribe' };
  const save = (name, workspace) => saveReusableAgent(db, { name, projectId: project.id, remit: 'Prepare a lesson.', model: '',
    instructions: 'Use the native workspace.', skills: [], runtime: { workspace, reasoningEffort: '', webSearch: 'disabled' } });
  const engineer = await save('Lesson engineer', 'workspace-write');
  const reviewer = await save('Lesson reviewer', 'read-only');
  const step = (id, agent, extra) => ({ id, title: id, objective: 'Use the saved workspace.', owner: 'Project owner',
    agent: `library:${agent.id}:${agent.version}`, inputs: ['brief'], prerequisites: [], ...extra });
  const draft = { title: 'Lesson files', goal: 'Review a lesson change.', brief: 'Add a correction.', steps: [
    step('build', engineer, { workspaceSource: 'baseline', captureWorkspace: true }),
    step('review', reviewer, { workspaceSource: 'step:build', prerequisites: ['build'] }),
  ] };
  const build = () => buildWorkflowSnapshot(db, { project, workflowId: 'lesson-files', sourceCommit, workspaceBaseline, draft });
  draft.steps[1].joinPrerequisites = ['build'];
  await assert.rejects(build(), /accepted prerequisite/);
  delete draft.steps[1].joinPrerequisites;
  const store = memoryRunStore();
  await store.create(newRun(await build(), 'lesson-run'));
  const result = { outcome: 'completed', receipt: { usage: null }, response: { state: 'completed', summary: 'Lesson updated.',
    outputs: [{ slot: 'result', content: 'The lesson now includes a correction.' }], decisions: [], questions: [], blockers: [] } };
  const updated = [file('lesson.txt', 'Original lesson with a correction.')];
  const first = await dispatch(store, 'build', undefined, undefined, job => {
    assert.deepEqual(job.workspaceFiles, workspaceBaseline.files);
    return { ...result, workspaceFiles: updated };
  });
  await decide(store, 'build', first.id, 'rework', 'Keep the change and clarify the correction.');
  const final = await dispatch(store, 'build', undefined, undefined, job => {
    assert.deepEqual(job.workspaceFiles, updated);
    return { ...result, workspaceFiles: [file('lesson.txt', 'Correct articulation here.')] };
  });
  await assert.rejects(dispatch(store, 'review', undefined, undefined, () => result), /Waiting for accepted handoff/);
  await decide(store, 'build', final.id, 'accepted', 'Checked the updated workspace.');
  const reviewed = await dispatch(store, 'review', undefined, undefined, job => {
    assert.deepEqual(job.workspaceFiles, [file('lesson.txt', 'Correct articulation here.')]);
    assert.equal(job.attempt.workspaceInput.artifactId, final.workspaceOutput.artifactId);
    return result;
  });
  assert.equal(reviewed.outcome, 'completed');
  assert.deepEqual(readWorkspaceArtifact(findArtifact(await store.read(), final.workspaceOutput.artifactId).content).files,
    [file('lesson.txt', 'Correct articulation here.')]);
});

test('opted-in repository instructions take their precedence and evidence from the pinned workspace', { skip: !postgres }, async t => {
  const { db } = await testDatabase(t);
  const project = { id: 'music-transcribe', name: 'Music Transcribe' };
  const agent = await saveReusableAgent(db, { name: 'Lesson instructions reviewer', projectId: project.id, remit: 'Review the lesson.', model: '',
    instructions: 'Use the project guidance.', skills: [], runtime: { workspace: 'read-only', reasoningEffort: '', webSearch: 'disabled',
      repositoryInstructions: true } });
  const sourceCommit = 'a'.repeat(40);
  const override = '# Lesson guidance\nUse the slower sample.\n';
  const repositoryBaseline = { commit: sourceCommit, files: [file('AGENTS.md', 'Use the original sample.'), file('AGENTS.override.md', override)] };
  const runId = 'agent-run-cc112233445566778899aabbccddeeff';
  await createAgentRun(db, { project, agent, runId, sourceCommit, repositoryBaseline, prompt: 'Review the sample.', reference: '' });
  const store = runStore(db, runId);
  const attempt = await dispatch(store, 'run-agent', undefined, undefined, job => {
    assert.deepEqual(job.workspaceFiles, repositoryBaseline.files);
    assert.equal(job.attempt.repositoryInstruction.path, 'AGENTS.override.md');
    assert.equal(job.attempt.repositoryInstruction.digest, artifactDigest(override));
    return { outcome: 'completed', receipt: { repositoryInstruction: job.attempt.repositoryInstruction }, response: 'I used the slower sample.' };
  });
  const run = await store.read();
  assert.equal(findArtifact(run, attempt.repositoryInstruction.artifactId).content, override);
  assert.equal(summarize(run).tasks[0].attempts[0].evidenceStatus, 'recorded');
  run.tasks[0].attempts[0].repositoryInstruction.digest = artifactDigest('Changed instructions.');
  assert.equal(summarize(run).tasks[0].attempts[0].evidenceStatus, 'missing');
  const workspaceBaseline = { ...repositoryBaseline, files: [...repositoryBaseline.files, file('.codex/config.toml', 'model = "fixture"')] };
  await assert.rejects(buildWorkflowSnapshot(db, { project, workflowId: 'lesson-instructions', sourceCommit, workspaceBaseline,
    draft: { title: 'Lesson review', goal: 'Review the sample.', brief: 'Use the supplied instructions.', steps: [{ id: 'review',
      title: 'Review', objective: 'Review the sample.', owner: 'Project owner', agent: `library:${agent.id}:${agent.version}`,
      inputs: ['brief'], prerequisites: [], workspaceSource: 'baseline' }] } }), /without Codex project configuration/);
});

test('failed audio acceptance blocks approval even when the captured app passes its Node tests and health check', {
  skip: !postgres || process.env.CREW_RUNTIME_DOCKER_TEST !== '1', timeout: 60_000,
}, async t => {
  const { db } = await testDatabase(t);
  const repo = await mkdtemp(join(tmpdir(), 'crew-audio-check-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const profiles = join(repo, '.crew-local', 'profiles');
  const assets = join(repo, '.crew-local', 'assets');
  await Promise.all([mkdir(profiles, { recursive: true }), mkdir(assets, { recursive: true })]);
  await writeFile(join(profiles, 'music-transcribe.json'), JSON.stringify({ acceptance: 'carnatic-lesson', image: 'node:22-alpine' }));
  for (const name of ['lesson', 'held-out']) {
    await writeFile(join(assets, name + '.wav'), Buffer.from([12, 1]));
    await writeFile(join(assets, name + '.expected.json'), '{}');
  }
  const project = { id: 'music-transcribe', name: 'Music Transcribe' };
  const saved = await saveReusableAgent(db, { name: 'Audio reviewer', projectId: project.id, remit: 'Verify the app.', model: '',
    instructions: 'Read the captured app.', skills: [], runtime: { workspace: 'read-only', reasoningEffort: '', webSearch: 'disabled' } });
  const sourceCommit = 'a'.repeat(40);
  const baseline = { commit: sourceCommit, files: [
    file('server.mjs', `import {createServer} from 'node:http';
      createServer((req,res)=>{req.resume();res.writeHead(req.url==='/health'?200:422).end('Audio rejected');}).listen(3000,'0.0.0.0');`),
    file('server.test.mjs', "import {test} from 'node:test'; test('fixture starts',()=>{});"),
  ] };
  const workspaceCheckProfile = await pinMusicWorkspaceChecks(repo);
  const draft = { title: 'Verify the workspace', goal: 'Exercise local acceptance.', brief: 'Check a recording.', steps: [{ id: 'verify',
    title: 'Check the app', objective: 'Review the lesson runner.', owner: 'Project owner', agent: `library:${saved.id}:${saved.version}`,
    prerequisites: [], inputs: ['brief'], workspaceSource: 'baseline', workspaceCheck: musicWorkspaceCheck, reviewMode: 'automatic' },
  { id: 'review', title: 'Inspect the test receipt', objective: 'Review the runner evidence.', owner: 'Project owner',
    agent: `library:${saved.id}:${saved.version}`, prerequisites: ['verify'], inputs: [], routes: [{ step: 'verify', output: 'check-receipt' }] }] };
  const snapshot = await buildWorkflowSnapshot(db, { project, workflowId: 'audio-fixture', sourceCommit, draft, workspaceBaseline: baseline, workspaceCheckProfile });
  const store = memoryRunStore();
  await store.create(newRun(snapshot, 'audio-run'));
  const execute = () => ({ outcome: 'completed', receipt: { usage: null }, response: { state: 'completed', summary: 'Workspace inspected.',
    outputs: [{ slot: 'result', content: 'The workspace contains a server and test.' }], decisions: [], questions: [], blockers: [] } });
  const attempt = await dispatch(store, 'verify', undefined, undefined, execute, db, { repo });
  assert.equal(attempt.outcome, 'check-failed');
  const summary = summarize(await store.read());
  const { verification, evidenceStatus, decision } = summary.tasks[0].attempts[0];
  assert.equal(evidenceStatus, 'recorded');
  assert.deepEqual(verification.checks.map(check => check.state), ['passed', 'passed', 'failed']);
  assert.match(verification.checks[2].error, /upload returned HTTP 422/);
  assert.equal(verification.workspaceDigest, attempt.workspaceInput.digest);
  assert.equal(decision, undefined);
  await assert.rejects(decide(store, 'verify', attempt.id, 'accepted', 'Approve it.'), /Only a completed handoff/);
  await assert.rejects(dispatch(store, 'review', undefined, undefined, () => assert.fail('Wait for a passing receipt'), db, { repo }),
    /Waiting for accepted handoff/);
  await writeFile(join(assets, 'lesson.expected.json'), '{"changed":true}');
  await decide(store, 'verify', attempt.id, 'rework', 'Repeat the checks.');
  const retry = await dispatch(store, 'verify', undefined, undefined, execute, db, { repo });
  const evidence = JSON.parse(findArtifact(await store.read(), retry.runnerArtifacts['check-receipt']).content);
  assert.match(evidence.error, /fixtures or verifier changed/);
  assert.ok(evidence.checks.every(check => check.state === 'not-run'));

  await rm(join(assets, 'held-out.expected.json'));
  const profile = await pinMusicPracticeChecks(repo);
  const directory = await materializeWorkspaceFiles(baseline.files);
  let observed, checkedFiles;
  const bridge = await openMusicPracticeBridge({ profile, workspace: directory, repo, signal: AbortSignal.timeout(25_000),
    capture: async signal => {
      checkedFiles = await captureWorkflowWorkspace(directory, undefined, signal);
      await writeFile(join(directory, 'server.mjs'), 'throw new Error("Edit made after capture");');
      return checkedFiles;
    },
    onResult: async receipt => { observed = receipt; return 'development-evidence'; } });
  try {
    const { url, token } = bridge.connection;
    assert.equal((await fetch(url, { method: 'POST' })).status, 404);
    assert.equal(observed, undefined);
    assert.equal(checkedFiles, undefined);
    const result = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + token } });
    assert.equal(result.status, 200);
    const development = await result.json();
    assert.equal(development.evidenceId, 'development-evidence');
    assert.equal(development.kind, 'workspace-development');
    assert.deepEqual(development.fixtures.map(fixture => fixture.name), ['lesson']);
    assert.deepEqual(development.checks.map(check => check.state), ['passed', 'passed', 'failed']);
    assert.match(development.checks[2].error, /upload returned HTTP 422/);
    assert.equal(development.workspaceDigest, observed.workspaceDigest);
    assert.equal(development.workspaceDigest, artifactDigest(JSON.stringify({ schemaVersion: 1, files: checkedFiles })));
    assert.deepEqual(observed.workspaceFiles.map(file => file.path), ['server.mjs', 'server.test.mjs']);
  } finally {
    await bridge.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('repair reopens the captured workspace and its dependents while keeping the failed attempt auditable', {
  skip: !postgres || process.env.CREW_RUNTIME_DOCKER_TEST !== '1', timeout: 60_000,
}, async t => {
  const { db } = await testDatabase(t);
  const repo = await mkdtemp(join(tmpdir(), 'crew-audio-repair-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const profiles = join(repo, '.crew-local', 'profiles');
  const assets = join(repo, '.crew-local', 'assets');
  await Promise.all([mkdir(profiles, { recursive: true }), mkdir(assets, { recursive: true })]);
  await writeFile(join(profiles, 'music-transcribe.json'), JSON.stringify({ acceptance: 'carnatic-lesson', image: 'node:22-alpine' }));
  for (const [name, offset] of [['lesson', 1], ['held-out', 3]]) {
    await writeFile(join(assets, name + '.wav'), Buffer.from([offset, offset + 8, offset + 1, offset + 2, offset + 3, offset + 4]));
    await writeFile(join(assets, name + '.expected.json'), JSON.stringify({ song: { start: offset, end: offset + 8 },
      correction: { start: offset + 1, end: offset + 2, text: 'hold' }, phrases: [{ start: offset + 3, end: offset + 4 }] }));
  }
  const project = { id: 'music-transcribe', name: 'Music Transcribe' };
  const saved = await saveReusableAgent(db, { name: 'Audio engineer', projectId: project.id, remit: 'Repair the captured app.', model: '',
    instructions: 'Use the workspace.', skills: [], runtime: { workspace: 'workspace-write', reasoningEffort: '', webSearch: 'disabled', liveSession: true, saveThread: true } });
  const step = (id, prerequisites, extra = {}) => ({ id, title: id, objective: 'Exercise local acceptance.', owner: 'Project owner',
    agent: `library:${saved.id}:${saved.version}`, inputs: ['brief'], prerequisites, ...extra });
  const draft = { title: 'Repair the workspace', goal: 'Repair the captured app.', brief: 'Make the checks pass.', dispatchMode: 'automatic', steps: [
    step('notes', []), step('build', [], { captureWorkspace: true }),
    step('verify', ['build'], { workspaceSource: 'step:build', workspaceCheck: musicWorkspaceCheck, publishWorkspace: true,
      workspaceRepair: { mode: 'manual', limit: 1 } }),
    step('release', ['verify']),
  ] };
  const snapshot = await buildWorkflowSnapshot(db, { project, workflowId: 'audio-repair', sourceCommit: 'a'.repeat(40), draft,
    workspaceCheckProfile: await pinMusicWorkspaceChecks(repo) });
  const followUp = await buildWorkflowSnapshot(db, { project, workflowId: 'follow-up', sourceCommit: snapshot.sourceCommit,
    draft: { ...draft, title: 'Follow-up workflow', dispatchMode: 'manual', steps: [
      step('build', [], { workspaceSource: 'delivery', captureWorkspace: true }),
    ] } });
  const firstRequest = await prepareWorkflowRun(db, followUp, 'first-request');
  assert.equal(firstRequest.workspaceDeliveryBase, undefined);
  await assert.rejects(prepareWorkflowRun(db, followUp, 'missing-delivery', { deliveryRunId: 'repair-run' }), /unavailable in this project/);
  const app = acceptAudio => `import {createServer} from 'node:http';
    import {randomUUID} from 'node:crypto';
    import {mkdir,readFile,writeFile} from 'node:fs/promises';
    import {join} from 'node:path';
    const lessonPath=id=>join(process.env.DATA_DIR,'lessons',id+'.json');
    const audioPath=id=>join(process.env.DATA_DIR,'audio',id+'.wav');
    function json(res, value){res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(value));}
    createServer(async(req,res)=>{
      if(req.url==='/health')return json(res,{ready:true});
      if(req.method==='POST'){
        ${acceptAudio ? '' : "req.resume();return res.writeHead(422).end('Unsupported fixture');"}
        const chunks=[]; for await(const chunk of req) chunks.push(chunk);
        const audio=Buffer.concat(chunks);
        const [s,e,c,d,p,q]=audio;
        const record={id:randomUUID(),song:{start:s,end:e},corrections:[{start:c,end:d,text:'hold',phraseStart:p,phraseEnd:q}],transcript:[{start:c,end:d,text:'hold'}]};
        await Promise.all(['lessons','audio'].map(folder=>mkdir(join(process.env.DATA_DIR,folder),{recursive:true})));
        await writeFile(audioPath(record.id),audio);
        await writeFile(lessonPath(record.id),JSON.stringify(record));
        return json(res,record);
      }
      const [id,suffix]=req.url.split('/').slice(3);
      if(!/^[a-f0-9-]{36}$/.test(id??''))return res.writeHead(404).end();
      const lesson=await readFile(lessonPath(id),'utf8').then(JSON.parse).catch(()=>null);
      if(!lesson)return res.writeHead(404).end();
      if(suffix==='audio')return res.end(await readFile(audioPath(id)));
      return json(res,lesson);
    }).listen(3000,'0.0.0.0');`;
  const bad = [file('server.mjs', app(false)),
    file('server.test.mjs', "import {test} from 'node:test';test('app source fixture',()=>{});")];
  const good = [file('server.mjs', app(true)), bad[1]];
  const store = runStore(db, 'repair-run');
  await store.create(newRun(snapshot, 'repair-run'));
  const execute = job => ({ outcome: 'completed', receipt: { usage: null }, response: { state: 'completed', summary: 'Result captured.',
    outputs: [{ slot: 'result', content: 'Reviewed the staged workspace.' }], decisions: [], questions: [], blockers: [] },
    ...(job.task.captureWorkspace && { workspaceFiles: bad }) });
  const dispatchTask = (id, agent = execute) => dispatch(store, id, undefined, undefined, agent, db, { repo });
  const notes = await dispatchTask('notes');
  await decide(store, 'notes', notes.id, 'accepted', 'Record separate notes.');
  const first = await dispatchTask('build');
  await store.update(run => { run.tasks[1].attempts[0].codexSession = { persisted: true, threadId: 'first-thread', turnId: 'first-turn', actions: [] }; });
  await decide(store, 'build', first.id, 'accepted', 'Verify the captures.');
  const failed = await dispatchTask('verify');
  await assert.rejects(publishWorkspaceDelivery(store, failed.id), /passing checks/);
  await assert.rejects(openWorkspacePreview(db, repo, 'repair-run'), /published delivery/);
  const reject = await Promise.allSettled(Array.from({ length: 2 }, () => requestWorkspaceRepair(store, 'verify', failed.id, 'Support the fixture input.')));
  assert.equal(reject.filter(result => result.status === 'fulfilled').length, 1);
  assert.match(reject.find(result => result.status === 'rejected').reason.message, /verification changed/);
  const reopened = await store.read();
  assert.deepEqual(reopened.tasks.map(task => task.activeFrom ?? 0), [0, 1, 1, 0]);
  assert.equal(reopened.tasks[0].attempts[0].id, notes.id);
  const repaired = await dispatchNext(store, undefined, undefined, job => {
    assert.deepEqual(job.workspaceFiles, bad);
    assert.equal(job.attempt.codexHistory.kind, 'fork');
    assert.ok(job.inputs.some(item => item.id === failed.runnerArtifacts['check-receipt']));
    return { ...execute(job), workspaceFiles: good };
  }, db, { repo });
  assert.equal(repaired.outcome, 'completed');
  await decide(store, 'build', repaired.id, 'accepted', 'Check the repaired workspace.');
  const checked = await dispatchNext(store, undefined, undefined, execute, db, { repo });
  assert.equal(checked.outcome, 'completed', checked.error);
  const run = summarize(await store.read());
  assert.equal(run.tasks[2].attempts[0].verification.passed, false);
  assert.equal(run.tasks[2].attempts[1].verification.passed, true);
  assert.equal(run.tasks[2].attempts[1].workspaceInput.digest, repaired.workspaceOutput.digest);
  assert.notEqual(run.tasks[2].attempts[1].workspaceInput.digest, failed.workspaceInput.digest);
  await decide(store, 'verify', checked.id, 'accepted', 'Accept the repaired workspace.');
  const release = await dispatchNext(store, undefined, undefined, execute, db, { repo });
  assert.deepEqual(release.prerequisites, [{ taskId: 'verify', attemptId: checked.id }]);
  await assert.rejects(publishWorkspaceDelivery(store, checked.id), /remaining workflow handoffs/);
  await decide(store, 'release', release.id, 'accepted', 'Approve release notes.');
  await assert.rejects(publishWorkspaceDelivery(store, failed.id), /verification changed/);
  const publications = await Promise.all(Array.from({ length: 2 }, () => publishWorkspaceDelivery(store, checked.id)));
  assert.deepEqual(publications[0], publications[1]);
  assert.equal(publications[0].candidate.workspace.digest, repaired.workspaceOutput.digest);
  const original = publications[0];
  const pending = await prepareWorkflowRun(db, followUp, 'follow-up-pending');
  assert.equal(pending.workspaceDeliveryBase.sourceRunId, 'repair-run');

  const laterStore = runStore(db, 'later-publication');
  const laterSnapshot = await buildWorkflowSnapshot(db, { project, workflowId: 'audio-repair', sourceCommit: snapshot.sourceCommit,
    draft: { ...draft, steps: draft.steps.map(step => step.id === 'build' ? { ...step, workspaceSource: 'delivery' } : step) },
    workspaceCheckProfile: snapshot.project.workspaceCheckProfile });
  await laterStore.create(await prepareWorkflowRun(db, laterSnapshot, 'later-publication', { deliveryRunId: 'repair-run' }));
  const laterFiles = [...good, file('changes.txt', 'A later delivery.')];
  for (const taskId of ['notes', 'build', 'verify', 'release']) {
    const attempt = await dispatch(laterStore, taskId, undefined, undefined, job => ({ ...execute(job),
      ...(job.task.captureWorkspace && { workspaceFiles: laterFiles }) }), db, { repo });
    assert.equal(attempt.outcome, 'completed', attempt.error);
    await decide(laterStore, taskId, attempt.id, 'accepted', 'Approve later delivery.');
    if (taskId === 'verify') assert.equal(attempt.workspaceInput.digest, (await laterStore.read()).tasks[1].attempts[0].workspaceOutput.digest);
  }
  const laterVerification = (await laterStore.read()).tasks[2].attempts[0];
  const later = await publishWorkspaceDelivery(laterStore, laterVerification.id);
  assert.notEqual(later.candidate.workspace.digest, original.candidate.workspace.digest);
  const latest = await prepareWorkflowRun(db, followUp, 'follow-up-latest');
  assert.equal(latest.workspaceDeliveryBase.sourceRunId, 'later-publication');
  assert.equal(latest.workspaceDeliveryBase.digest, later.candidate.workspace.digest);
  const exact = await prepareWorkflowRun(db, followUp, 'follow-up-exact', { deliveryRunId: 'repair-run' });
  assert.equal(exact.requestedDeliveryRunId, 'repair-run');
  assert.deepEqual(exact.workspaceDeliveryBase, pending.workspaceDeliveryBase);
  assert.equal(exact.workspaceDeliveryBase.sourceReceiptId, original.candidate.checks.artifactId);
  assert.deepEqual(findArtifact(exact, 'workspace-delivery-base').provenance, {
    source: 'published-workspace-base', runId: 'repair-run', artifactId: original.candidate.workspace.artifactId, deliveryDigest: original.digest,
  });
  assert.equal(findArtifact(exact, 'workspace-delivery-base').content, findArtifact(await store.read(), original.candidate.workspace.artifactId).content);
  await assert.rejects(prepareWorkflowRun(db, snapshot, 'unsupported-delivery', { deliveryRunId: 'repair-run' }), /version that uses a published workspace/);
  const foreign = { ...followUp, project: { ...followUp.project, id: 'other-music-project' } };
  await assert.rejects(prepareWorkflowRun(db, foreign, 'foreign-delivery', { deliveryRunId: 'repair-run' }), /unavailable in this project/);
  const pendingStore = runStore(db, pending.id);
  await pendingStore.create(pending);
  const staged = await dispatch(pendingStore, 'build', undefined, undefined, job => {
    assert.deepEqual(readWorkspaceArtifact(findArtifact(pending, 'workspace-delivery-base').content).files, job.workspaceFiles);
    return { ...execute(job), workspaceFiles: job.workspaceFiles };
  }, db, { repo });
  assert.equal(staged.outcome, 'completed', staged.error);
  assert.equal(staged.workspaceInput.digest, original.candidate.workspace.digest);
  const practiceSettings = { name: 'Lesson developer', projectId: project.id, remit: 'Check the local app.', model: '',
    instructions: 'Inspect the development recording.', skills: [], tools: [musicPracticeTool], runtime: saved.definition.runtime,
    musicPracticeProfile: await pinMusicPracticeChecks(repo) };
  await assert.rejects(saveReusableAgent(db, { ...practiceSettings, shared: true }), /requires a project-owned agent/);
  await assert.rejects(saveReusableAgent(db, { ...practiceSettings, projectId: 'other-project' }), /requires a project-owned agent/);
  const practiceAgent = await saveReusableAgent(db, practiceSettings);
  const request = { project, agent: practiceAgent, runId: 'agent-run-' + '7'.repeat(32), sourceCommit: snapshot.sourceCommit,
    prompt: 'Verify the development recording.', reference: '', deliveryRunId: 'repair-run' };
  assert.deepEqual(await createAgentRun(db, request), { needsDispatch: true });
  const agentRun = await runStore(db, request.runId).read();
  assert.equal(agentRun.workspaceDeliveryBase.digest, original.candidate.workspace.digest);
  assert.deepEqual(agentRun.profiles[0].musicPracticeProfile, practiceSettings.musicPracticeProfile);
  assert.deepEqual(await createAgentRun(db, request), { needsDispatch: true });
  await assert.rejects(createAgentRun(db, { ...request, deliveryRunId: 'later-publication' }), /already submitted/);

  let volume, inheritedVolume;
  try {
    const preview = await openWorkspacePreview(db, repo, 'repair-run');
    volume = preview.volume;
    assert.equal(preview.revision, publications[0].candidate.workspace.digest);
    assert.equal((await openWorkspacePreview(db, repo, 'repair-run')).container, preview.container);
    const wav = Buffer.from([4, 12, 5, 6, 7, 8]);
    const posted = await fetch(preview.url + '/api/lessons', { method: 'POST', body: wav });
    const { id } = await posted.json();
    await stopWorkspacePreview(db, 'repair-run');
    const restarted = await openWorkspacePreview(db, repo, 'repair-run');
    assert.notEqual(restarted.container, preview.container);
    assert.equal(restarted.volume, volume);
    const replay = await fetch(restarted.url + '/api/lessons/' + id + '/audio');
    assert.deepEqual(Buffer.from(await replay.arrayBuffer()), wav);
    const inherited = await openWorkspacePreview(db, repo, 'later-publication');
    inheritedVolume = inherited.volume;
    assert.notEqual(inheritedVolume, volume);
    assert.deepEqual(inherited.lessonLibrary, { sourceRunId: 'repair-run', copiedLessons: 1 });
    const inheritedReplay = await fetch(inherited.url + '/api/lessons/' + id + '/audio');
    assert.deepEqual(Buffer.from(await inheritedReplay.arrayBuffer()), wav);
    const childLesson = await fetch(inherited.url + '/api/lessons', { method: 'POST', body: wav }).then(response => response.json());
    assert.equal((await fetch(restarted.url + '/api/lessons/' + childLesson.id)).status, 404);
    await stopWorkspacePreview(db, 'later-publication');
    const inheritedRestart = await openWorkspacePreview(db, repo, 'later-publication');
    assert.deepEqual(inheritedRestart.lessonLibrary, inherited.lessonLibrary);
    assert.deepEqual(await fetch(inheritedRestart.url + '/api/lessons/' + childLesson.id).then(response => response.json()), childLesson);
  } finally {
    volume ??= (await store.read()).workspacePreview?.volume;
    inheritedVolume ??= (await laterStore.read()).workspacePreview?.volume;
    for (const [runId, dataVolume] of [['repair-run', volume], ['later-publication', inheritedVolume]]) {
      await stopWorkspacePreview(db, runId);
      if (dataVolume) execFileSync('docker', ['volume', 'rm', dataVolume], { stdio: 'ignore' });
    }
  }
  await store.update(current => { findArtifact(current, publications[0].artifactId).content = 'changed'; });
  await assert.rejects(openWorkspacePreview(db, repo, 'repair-run'), /verified workspace evidence/);
  await assert.rejects(prepareWorkflowRun(db, followUp, 'bad-delivery', { deliveryRunId: 'repair-run' }), /verified workspace evidence/);
  assert.equal(findArtifact(await pendingStore.read(), 'workspace-delivery-base').digest, original.candidate.workspace.digest);

  draft.steps[2].workspaceRepair = { mode: 'automatic', limit: 1 };
  const automaticSnapshot = await buildWorkflowSnapshot(db, { project, workflowId: 'audio-repair', sourceCommit: 'a'.repeat(40), draft,
    workspaceCheckProfile: snapshot.project.workspaceCheckProfile });
  const automatic = runStore(db, 'automatic-repair');
  await automatic.create(newRun(automaticSnapshot, 'automatic-repair'));
  const failedTwice = async () => {
    const build = await dispatch(automatic, 'build', undefined, undefined, execute, db, { repo });
    await decide(automatic, 'build', build.id, 'accepted', 'Verify the current capture.');
    return dispatch(automatic, 'verify', undefined, undefined, execute, db, { repo });
  };
  await failedTwice();
  await failedTwice();
  const stalled = summarize(await automatic.read());
  assert.equal(stalled.workspaceRepairs.length, 1);
  assert.equal(stalled.workspaceRepairs[0].actor, 'Workflow');
  assert.equal(stalled.tasks[2].workspaceRepairStatus.canRequest, false);
  assert.match(stalled.tasks[2].workspaceRepairStatus.reason, /repair limit/);

  const reviewed = runStore(db, 'review-repair');
  await reviewed.create(newRun(automaticSnapshot, 'review-repair'));
  const reviewedBuild = await dispatch(reviewed, 'build', undefined, undefined,
    job => ({ ...execute(job), workspaceFiles: good }), db, { repo });
  await decide(reviewed, 'build', reviewedBuild.id, 'accepted', 'Send to independent verification.');
  const passing = await dispatch(reviewed, 'verify', undefined, undefined, execute, db, { repo });
  assert.equal(passing.outcome, 'completed');
  assert.equal((await reviewed.read()).workspaceRepairs?.length ?? 0, 0);
  const feedback = await requestWorkspaceRepair(reviewed, 'verify', passing.id, 'Fix the independent browser timing finding.');
  assert.equal(feedback.trigger, 'review-finding');
  assert.equal(feedback.sourceAttemptId, reviewedBuild.id);
  assert.equal(feedback.workspace.digest, reviewedBuild.workspaceOutput.digest);
  assert.ok(feedback.evidence.some(item => item.id === passing.runnerArtifacts['check-receipt']));
  await assert.rejects(requestWorkspaceRepair(reviewed, 'verify', passing.id, 'Stale request.'), /verification changed/);
});
