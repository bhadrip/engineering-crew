import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createFeature, runFeature } from '../lib/feature-controller.mjs';
import { callInput, callOutput } from '../lib/feature-call-artifacts.mjs';
import { git } from '../lib/feature-workspace.mjs';
import { runtimeForFeature } from '../lib/local-feature.mjs';
import { listProjectVersions, loadProject, registerProject } from '../lib/project-store.mjs';
import { listReusableAgents, saveReusableAgent } from '../lib/agent-library.mjs';
import { createAgentRun } from '../lib/agent-run.mjs';
import { readProjectProfile } from '../lib/local-profile-file.mjs';
import { artifactDigest, listRuns, runStore } from '../lib/run-store.mjs';
import { loadProjectMcp, pinnedProjectMcp } from '../lib/project-mcp.mjs';
import { decide, dispatch } from '../lib/workflow.mjs';
import { buildWorkflowSnapshot } from '../lib/workflow-editor.mjs';
import { postgres, testDatabase } from '../test-support/stores.mjs';

async function openDashboard(t, repo, url, env = {}, project = 'test') {
  const cli = fileURLToPath(new URL('../bin/crew.mjs', import.meta.url));
  const child = spawn(process.execPath, [cli, '--repo', repo, 'ui', '--project-id', project, '--port', '0'],
    { stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, ...env, CREW_DATABASE_URL: url } });
  const stopped = once(child, 'exit');
  t.after(async () => { child.kill(); await stopped; });
  const lines = createInterface({ input: child.stdout });
  const [line] = await Promise.race([once(lines, 'line'), stopped.then(() => { throw new Error('Test dashboard did not start'); })]);
  const origin = line.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
  assert.ok(origin);
  return origin;
}

test('Music Transcribe draft tests execute the unsaved definition and save its exact snapshot explicitly', { skip: !postgres, timeout: 30_000 }, async t => {
  const { db, url } = await testDatabase(t);
  const project = { id: 'music-transcribe', name: 'Music Transcribe' };
  const workflowId = 'draft-test-lesson';
  const agent = await saveReusableAgent(db, { projectId: project.id, name: 'Lesson reviewer', remit: 'Review evidence.', model: '',
    instructions: 'Use the current task instructions.', skills: [] });
  const agentRef = `library:${agent.id}:1`;
  await registerProject(db, await buildWorkflowSnapshot(db, { project, workflowId, sourceCommit: 'a'.repeat(40), draft: {
    title: 'Saved lesson review', goal: 'Review the saved lesson.', brief: 'Saved brief.', steps: [{ id: 'step-1', title: 'Review lesson',
      objective: 'Read the saved material.', owner: 'Project owner', agent: agentRef, inputs: ['brief'], prerequisites: [] }],
  } }));
  const origin = await openDashboard(t, fileURLToPath(new URL('..', import.meta.url)), url, {}, project.id);
  const workflows = '/projects/music-transcribe/workflows';
  const editor = workflows + '?workflow=' + workflowId;
  const post = (path, fields, json = false) => fetch(origin + path, { method: 'POST', redirect: 'manual',
    headers: { Origin: origin, ...(json && { Accept: 'application/json' }) }, body: new URLSearchParams(fields) });
  const firstId = 'workflow-test-' + 'a'.repeat(32);
  const secondId = 'workflow-test-' + 'b'.repeat(32);
  const form = { action: 'test', version: '1', 'test-run-id': firstId,
    title: 'Draft lesson review', goal: 'Run a lesson rehearsal.', brief: 'Draft evidence for this test.', step: 'step-1',
    'step-1.title': 'Review draft', 'step-1.objective': 'Check the unsaved lesson.', 'step-1.owner': 'Project owner',
    'step-1.agent': agentRef, 'step-1.input': 'brief', 'step-1.response-mode': 'free-form', 'step-1.output-follow-ups': '1' };
  assert.equal((await post(editor, { ...form, 'step-1.output-follow-ups': '4' }, true)).status, 400);
  const created = await post(editor, form, true);
  assert.equal(created.status, 201, await created.clone().text());
  const { location, nextTestRunId } = await created.json();
  assert.match(nextTestRunId, /^workflow-test-[a-f0-9]{32}$/);
  assert.equal((await post(editor, form)).headers.get('location'), location);
  assert.equal((await post(editor, { ...form, brief: 'Different test brief.' }, true)).status, 409);
  assert.equal((await post(editor, { ...form, 'test-run-id': secondId, title: 'Alternative draft' })).status, 303);
  assert.equal((await loadProject(db, project.id, workflowId)).project.epic.title, 'Saved lesson review');
  assert.deepEqual(await listRuns(db), []);
  const page = await fetch(origin + location).then(response => response.text());
  assert.match(page, /Draft test[\s\S]+Save tested revision/);
  assert.match(page, /Compare tested draft/);
  assert.match(page, /Review draft/);
  assert.doesNotMatch(page, /Publish local delivery/);
  assert.match(await fetch(origin + workflows).then(response => response.text()), /Recent draft tests[\s\S]+Draft lesson review/);
  const draftCompare = await fetch(origin + workflows + '/compare?test=' + firstId);
  assert.equal(draftCompare.status, 200);
  const comparison = await draftCompare.text();
  assert.match(comparison, /<h1>Compare tested draft<\/h1>/);
  assert.match(comparison, /<pre>Saved brief\.<\/pre>[\s\S]+<pre>Draft evidence for this test\.<\/pre>/);
  assert.match(comparison, /Codex response mode[\s\S]+Structured response[\s\S]+Free-form reply and output tools/);
  assert.match(comparison, /Missing output follow-up turns[\s\S]+<pre>0<\/pre>[\s\S]+<pre>1<\/pre>/);

  const store = runStore(db, firstId);
  const reply = 'I checked the lesson against the draft evidence.';
  const content = 'Draft evidence checked.';
  const attempt = await dispatch(store, 'step-1', undefined, undefined, job => {
    assert.equal(job.task.objective, 'Check the unsaved lesson.');
    assert.equal(job.task.responseMode, 'free-form');
    assert.equal(job.attempt.effectivePermissions.liveSession, true);
    assert.equal(job.inputs[0].content, form.brief);
    return { outcome: 'completed', response: reply, submitted: { outputs: [{ slot: 'result', content }] },
      activity: { responseFormat: 'free-form', response: reply },
      receipt: { usage: null, responseFormat: 'free-form', replyDigest: artifactDigest(reply), submittedOutputDigests: { result: artifactDigest(content) } } };
  });
  await decide(store, 'step-1', attempt.id, 'accepted', 'Verified the draft evidence.');
  assert.equal((await post(`/runs/${firstId}/publish-workspace`, { attempt: attempt.id })).status, 409);
  const run = await store.read();
  assert.equal(run.project.configurationVersion, undefined);
  assert.equal(run.workflowTest.baseVersion, 1);
  const tested = JSON.parse(run.artifacts.find(record => record.id === run.workflowTest.snapshotId).content);
  const save = `/runs/${firstId}/save-workflow-test`;
  assert.equal((await post(save, {})).status, 303);
  assert.equal((await post(save, {})).status, 303);
  assert.equal((await post(`/runs/${secondId}/save-workflow-test`, {})).status, 409);
  const saved = await loadProject(db, project.id, workflowId);
  assert.equal(saved.version, 2);
  assert.equal(saved.project.tasks[0].outputFollowUps, 1);
  assert.deepEqual(saved.project, tested.project);
  assert.deepEqual(saved.inputOverrides, tested.inputOverrides);
  assert.deepEqual([...saved.files], tested.files);
  assert.deepEqual((await listProjectVersions(db, project.id, workflowId)).map(row => row.version), [2, 1]);
  const savedEditor = await fetch(origin + editor).then(response => response.text());
  assert.match(savedEditor, /Compare revisions/);
  assert.match(savedEditor, /Codex response mode[\s\S]+value="free-form" selected/);
  const savedCompare = await fetch(origin + workflows + '/compare?workflow=' + workflowId + '&from=2&to=1');
  assert.equal(savedCompare.status, 200);
  const savedDiff = await savedCompare.text();
  assert.match(savedDiff, /<pre>Draft evidence for this test\.<\/pre>[\s\S]+<pre>Saved brief\.<\/pre>/);
  assert.match(savedDiff, /<pre>Check the unsaved lesson\.<\/pre>[\s\S]+<pre>Read the saved material\.<\/pre>/);
  assert.equal(await fetch(origin + workflows + '/compare?test=' + firstId).then(response => response.text()), comparison);

  const runs = '/projects/music-transcribe/runs';
  const draftHistory = await fetch(origin + runs + '?type=draft&q=' + firstId);
  assert.equal(draftHistory.status, 200);
  const draftRuns = await draftHistory.text();
  assert.match(draftRuns, /aria-current="page">Runs/);
  assert.ok(draftRuns.includes(location.replace('&', '&amp;')));
  assert.ok(draftRuns.includes('/runs/' + firstId + '/artifacts/workflow-test-snapshot'));
  assert.ok(!draftRuns.includes(secondId));
  assert.match(draftRuns, /Handoffs accepted/);
});

test('Music Transcribe requests pin the selected workflow version and give Codex the submitted brief', { skip: !postgres }, async t => {
  const { db, url } = await testDatabase(t);
  const repo = fileURLToPath(new URL('..', import.meta.url));
  const project = { id: 'music-transcribe', name: 'Music Transcribe' };
  const workflowId = 'lesson-workflow';
  const saved = await saveReusableAgent(db, { projectId: project.id, name: 'Lesson planner', model: '', remit: 'Plan a lesson tool.',
    instructions: 'Read the request brief.', skills: [] });
  const legacy = await createFeature(db, { projectId: project.id, id: 'prior-request', goal: 'An earlier feature request' });
  const base = { project, workflowId, sourceCommit: 'a'.repeat(40) };
  const draft = { title: 'Lesson workflow', goal: 'Plan a requested improvement.', brief: 'Default sample brief.', steps: [{ id: 'plan',
    title: 'Plan the lesson change', objective: 'Produce a lesson change plan.', owner: 'Project owner',
    agent: `library:${saved.id}:${saved.version}`, inputs: ['brief'], prerequisites: [] }] };
  await registerProject(db, await buildWorkflowSnapshot(db, { ...base, draft }));
  const latest = await loadProject(db, project.id, workflowId, 1);
  await registerProject(db, await buildWorkflowSnapshot(db, { ...base, baseline: latest, draft: { ...draft, brief: 'Another sample brief.' } }));
  const origin = await openDashboard(t, repo, url, {}, project.id);
  const index = origin + '/projects/music-transcribe/requests';
  const before = await (await fetch(index)).text();
  assert.match(before, /Lesson workflow · v1/);
  assert.match(before, /Lesson workflow · v2/);
  const runId = /name="request-id" value="([^"]+)"/.exec(before)[1];
  const body = new URLSearchParams({ 'request-id': runId, 'workflow-version': 'lesson-workflow/1',
    goal: 'Link a correction to its sung phrase.\r\nKeep timing visible.' });
  const submit = () => fetch(index, { method: 'POST', headers: { Origin: origin }, redirect: 'manual', body });
  const posted = await submit();
  assert.equal(posted.status, 303);
  assert.equal((await submit()).status, 303);
  const request = origin + posted.headers.get('location');
  const opened = await fetch(request);
  assert.match(opened.url, /epics\/lesson-workflow\?run=/);
  const page = await opened.text();
  assert.match(page, /Link a correction to its sung phrase\./);
  assert.match(page, /Lesson workflow · v1/);
  const store = runStore(db, runId);
  const run = await store.read();
  assert.equal(run.project.configurationVersion, 1);
  const brief = run.artifacts.find(artifact => artifact.id === run.workflowRequest.briefArtifactId);
  assert.equal(run.workflowRequest.briefDigest, brief.digest);
  assert.deepEqual(brief.provenance, { source: 'workflow-request', runId });
  assert.equal(brief.content, 'Link a correction to its sung phrase.\nKeep timing visible.');
  assert.equal(run.tasks[0].attempts.length, 0);
  const attempt = await dispatch(store, 'plan', undefined, undefined, job => {
    assert.deepEqual(job.inputs.map(input => input.content), [brief.content]);
    return { outcome: 'completed', receipt: { usage: null }, response: { state: 'completed', summary: 'Planned the change.',
      outputs: [{ slot: 'result', content: 'Align correction timestamps with the sung phrase.' }], decisions: [], questions: [], blockers: [] } };
  }, db);
  assert.equal(attempt.outcome, 'completed');
  const history = await (await fetch(index)).text();
  assert.ok(history.includes('/requests/workflow/' + runId));
  assert.ok(history.includes('/requests/' + legacy.id));
  body.set('goal', 'A different request');
  assert.equal((await submit()).status, 409);
  const legacyPage = await fetch(index + '/' + legacy.id);
  assert.equal(legacyPage.status, 200);
  assert.match(await legacyPage.text(), /An earlier feature request/);

  const runs = origin + '/projects/music-transcribe/runs';
  const agentRunId = 'agent-run-' + 'c'.repeat(32);
  await createAgentRun(db, { project, agent: saved, runId: agentRunId, sourceCommit: base.sourceCommit,
    prompt: 'Check 100% of the lesson evidence.', reference: '' });
  const getRuns = async params => {
    const response = await fetch(runs + (params ? '?' + new URLSearchParams(params) : ''));
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return response.text();
  };
  const all = await getRuns();
  assert.ok(all.includes('/runs/' + agentRunId + '/tasks/run-agent'));
  assert.ok(all.includes('/requests/' + legacy.id));
  assert.ok(all.includes('run=' + runId + '&amp;view=activity'));
  const workflowsOnly = await getRuns({ type: 'workflow', q: 'sung phrase' });
  assert.ok(workflowsOnly.includes('workflow=lesson-workflow&amp;version=1'));
  assert.match(workflowsOnly, /Handoff ready for review/);
  assert.ok(!workflowsOnly.includes(agentRunId));
  const agentsOnly = await getRuns({ type: 'agent', q: '100% LESSON PLANNER' });
  assert.ok(agentsOnly.includes('/agents?agent=' + saved.id + '&amp;version=1'));
  assert.match(agentsOnly, /Ready to run/);
  assert.ok(!agentsOnly.includes(runId));
  assert.match(await getRuns({ q: '101%' }), /No runs match/);
});

test('Music Transcribe run history paginates legacy records and opens exact call evidence', { skip: !postgres }, async t => {
  const { db, url } = await testDatabase(t);
  const repo = fileURLToPath(new URL('..', import.meta.url));
  const projectId = 'music-transcribe';
  const featureId = '8854e833-1a0c-42c5-81b9-ac6fa2df38bd';
  const input = callInput('Exact recorded legacy planner prompt', { profileId: 'fixture-planner' });
  const output = callOutput('{"summary":"Exact recorded legacy planner response"}');
  await createFeature(db, { projectId, id: featureId, goal: 'A prior lesson request.' });
  const request = await runFeature(db, featureId, { runtime: {
    plan: async ({ onEvent }) => {
      const receipt = { callId: 'fixture-call', inputDigest: input.digest };
      await onEvent({ type: 'agent.started', evidence: receipt }, { input });
      await onEvent({ type: 'agent.completed', evidence: { ...receipt, outputDigest: output.digest } }, { output });
      return { plan: { summary: 'Fixture plan.', steps: [], acceptance: [] } };
    },
    build: async () => { throw Error('Fixture stopped'); }, verify: async () => {}, promote: async () => {},
  } });
  const { seq } = request.events.find(event => event.type === 'agent.completed');
  for (let i = 0; i < 20; i++) await createFeature(db, { projectId, id: 'lesson-request-' + i, goal: 'Another lesson request' });
  await createFeature(db, { projectId: 'other', id: 'other-lesson-request', goal: 'Unrelated lesson request' });
  const origin = await openDashboard(t, repo, url, {}, projectId);
  const path = '/projects/music-transcribe/runs';
  const index = origin + path + '?q=lesson&type=legacy';
  const first = await fetch(index).then(response => response.text());
  assert.equal((first.match(/class="request-list-copy"/g) ?? []).length, 20);
  assert.ok(first.includes(path + '?q=lesson&amp;type=legacy&amp;page=2'));
  assert.ok(!first.includes(featureId));
  assert.match(first, /Queued/);
  const second = await fetch(index + '&page=2').then(response => response.text());
  const receipt = '/projects/music-transcribe/requests/' + featureId + '/events/' + seq + '/input';
  assert.ok(second.includes(receipt));
  assert.match(second, /Blocked/);
  assert.ok(second.includes(path + '?q=lesson&amp;type=legacy'));
  assert.ok(!second.includes('other-lesson-request'));
  assert.ok(!second.includes(input.prompt));
  const call = await fetch(origin + receipt);
  assert.equal(call.status, 200);
  assert.match(await call.text(), /Exact recorded legacy planner prompt/);
  assert.equal((await fetch(origin + '/projects/other/runs')).status, 404);
});

test('workflow request images are pinned and dispatched only to opted-in steps', { skip: !postgres }, async t => {
  const { db, url } = await testDatabase(t);
  const repo = fileURLToPath(new URL('..', import.meta.url));
  const project = { id: 'music-transcribe', name: 'Music Transcribe' };
  const agent = await saveReusableAgent(db, { projectId: project.id, name: 'Lesson reviewer', model: '', remit: 'Review a lesson.',
    instructions: 'Review the evidence supplied to this assignment.', skills: [],
    runtime: { workspace: 'read-only', webSearch: 'disabled', reasoningEffort: '', liveSession: true, saveThread: true } });
  const workflowId = 'screenshot-review';
  const base = { project, workflowId, sourceCommit: 'a'.repeat(40) };
  const step = { objective: 'Review the provided inputs.', owner: 'Project owner', agent: `library:${agent.id}:1`,
    inputs: ['brief'], prerequisites: [] };
  const draft = { title: 'Screenshot review', goal: 'Review a lesson screenshot.', brief: 'Default brief.', steps: [
    { ...step, id: 'inspect', title: 'Inspect the screenshot' }, { ...step, id: 'summarize', title: 'Summarize the brief' },
  ] };
  await registerProject(db, await buildWorkflowSnapshot(db, { ...base, draft }));
  const baseline = await loadProject(db, project.id, workflowId, 1);
  const receive = { ...draft.steps[0], receiveRequestImages: true };
  const withImages = { ...draft, steps: [receive, draft.steps[1]] };
  await assert.rejects(buildWorkflowSnapshot(db, { ...base, baseline, draft: { ...withImages,
    steps: [receive, { ...draft.steps[1], prerequisites: ['inspect'], historyFrom: 'inspect' }],
  } }), /Enable request images.*copy Codex history/);
  await registerProject(db, await buildWorkflowSnapshot(db, { ...base, baseline, draft: withImages }));
  const origin = await openDashboard(t, repo, url, {}, project.id);
  const index = origin + '/projects/music-transcribe/requests';
  const page = await (await fetch(index)).text();
  assert.match(page, /data-request-image-steps="\[&quot;Inspect the screenshot&quot;\]"[^>]*>Screenshot review · v2 · Accepts images/);
  const runId = /name="request-id" value="([^"]+)"/.exec(page)[1];
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aYyUAAAAASUVORK5CYII=', 'base64');
  const form = new FormData();
  form.set('request-id', runId);
  form.set('workflow-version', 'screenshot-review/1');
  form.set('goal', 'Check this screenshot.');
  form.set('turn-image', new File([png], 'lesson.png', { type: 'image/png' }));
  const submit = () => fetch(index, { method: 'POST', headers: { Origin: origin }, redirect: 'manual', body: form });
  const unsupported = await submit();
  assert.equal(unsupported.status, 400);
  assert.match(await unsupported.text(), /no steps configured to receive request images/);
  form.set('workflow-version', 'screenshot-review/2');
  assert.equal((await submit()).status, 303);
  assert.equal((await submit()).status, 303);
  form.set('turn-image', new File([png], 'different.png', { type: 'image/png' }));
  assert.equal((await submit()).status, 409);
  const store = runStore(db, runId);
  const run = await store.read();
  assert.equal(run.project.configurationVersion, 2);
  assert.deepEqual(run.tasks[0].packet.imageInputIds, ['request-image-1']);
  assert.equal(run.tasks[1].packet.imageInputIds, undefined);
  const original = await fetch(origin + '/runs/' + runId + '/artifacts/request-image-1?image=1');
  assert.equal(original.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await original.arrayBuffer()), png);
  const execute = async job => {
    if (job.task.id === 'inspect') {
      assert.deepEqual(job.turnImages[0].data, png);
      assert.equal(job.attempt.imageInputs[0].name, 'lesson.png');
    } else {
      assert.equal(job.turnImages, undefined);
      assert.equal(job.attempt.imageInputs, undefined);
    }
    return { outcome: 'completed', receipt: { usage: null, imageInputs: job.attempt.imageInputs },
      response: { state: 'completed', summary: 'Reviewed.', outputs: [{ slot: 'result', content: 'Review complete.' }],
        decisions: [], questions: [], blockers: [] } };
  };
  for (const step of ['inspect', 'summarize'])
    assert.equal((await dispatch(store, step, undefined, undefined, execute)).outcome, 'completed');
});

test('a recorded build or edit opens its HTML comparison and exact raw patch on the owning project', { skip: !postgres, timeout: 30_000 }, async t => {
  const { db, url } = await testDatabase(t);
  const repo = await mkdtemp(join(tmpdir(), 'crew-changes-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  await git(repo, ['init', '--initial-branch=main', '--template=']);
  await git(repo, ['commit', '--allow-empty', '-m', 'Start']);
  const base = await git(repo, ['rev-parse', 'HEAD']);
  await writeFile(join(repo, 'sample.txt'), '<script>fixture</script>  \n');
  await git(repo, ['add', '--', 'sample.txt']);
  await git(repo, ['commit', '-m', 'Add a file']);
  const revision = await git(repo, ['rev-parse', 'HEAD']);
  const patch = (await git(repo, ['diff', base, revision], { binary: true })).toString('utf8');

  const request = await createFeature(db, { id: 'edit', projectId: 'test', repoPath: repo, goal: 'Change a file' });
  await createFeature(db, { id: 'another', projectId: 'other', goal: 'Unrelated project' });
  const events = [
    { seq: 2, type: 'tool.completed', evidence: { action: 'edit', revision } },
    { seq: 3, type: 'task.completed', evidence: { repoPath: repo, base, revision } },
  ];
  for (const event of events) {
    await db.query('INSERT INTO engineering_crew.feature_events(feature_id, seq, event) VALUES($1,$2,$3)',
      [request.id, event.seq, { ...event, featureId: request.id, role: 'engineer', attempt: 1 }]);
  }
  await db.query('UPDATE engineering_crew.features SET last_seq=3 WHERE id=$1', [request.id]);

  const origin = await openDashboard(t, repo, url);
  const page = origin + '/projects/test/requests/edit';
  for (const [resource, back] of [['attempts/1', '#stage-attempt-1'], ['events/2', '#event-2']]) {
    const response = await fetch(page + '/' + resource + '/changes');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/html/);
    const html = await response.text();
    assert.ok(html.includes('sample.txt') && html.includes('/requests/edit' + back));
    assert.ok(html.includes('/requests/edit/' + resource + '.diff'));
    assert.doesNotMatch(html, /<script>fixture<\/script>/);
    const raw = await fetch(page + '/' + resource + '.diff');
    assert.match(raw.headers.get('content-type'), /text\/plain/);
    assert.equal(await raw.text(), patch);
  }
  for (const path of ['/projects/other/requests/another/attempts/1/changes', '/projects/test/requests/another/events/2.diff',
    '/projects/test/requests/edit/events/3/changes', '/projects/test/requests/edit/attempts/2/changes',
    '/projects/test/requests/edit/attempts/0/changes', '/projects/test/requests/edit/events/9007199254740992/changes']) {
    const response = await fetch(origin + path);
    assert.equal(response.status, 404, path);
    await response.body.cancel();
  }
});

test('the operator can distinguish current agents, historical settings, and exact local prompts and answers', { skip: !postgres, timeout: 30_000 }, async t => {
  const { db, url } = await testDatabase(t);
  const repo = await mkdtemp(join(tmpdir(), 'crew-agent-route-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const dir = join(repo, '.crew-local', 'profiles');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'test.json'), JSON.stringify({ roles: { planner: {
    id: 'current-profile', model: 'current-model', instructions: 'Current reviewer suggestion',
  } } }));
  await createFeature(db, { id: 'recorded', projectId: 'test', goal: 'Verify input routing' });
  await createFeature(db, { id: 'external', projectId: 'other', goal: 'Separate project' });
  const input = callInput('A private <prompt>\r\nwith project context', { profileId: 'past-profile', nativeTools: [] });
  const output = callOutput('{"summary":"The private <reply>","steps":["Test"],"acceptance":[]}\n');
  const request = await runFeature(db, 'recorded', { runtime: {
    plan: async ({ onEvent }) => {
      await onEvent({ type: 'runtime.profile', evidence: { role: 'planner', id: 'past-profile',
        digest: 'abc', instructions: 'Historical reviewer suggestion', access: 'read-only', tools: ['list','read'] } });
      await onEvent({ type: 'agent.completed', evidence: { profileId: 'legacy-profile', startedAt: '2026-01-01T00:00:00Z' } });
      const receipt = { callId: 'captured-call', inputDigest: input.digest, startedAt: '2026-01-01T00:01:00Z' };
      await onEvent({ type: 'agent.started', evidence: receipt }, { input });
      await onEvent({ type: 'agent.completed', evidence: { ...receipt, outputDigest: output.digest } }, { output });
      return { plan: { summary: 'Retained task result', steps: [], acceptance: [] } };
    },
    build: async () => { throw Error('Fixture stopped'); }, verify: async () => {}, promote: async () => {},
  } });
  const [legacy, exact] = request.events.filter(e => e.type === 'agent.completed').map(e => e.seq);
  const origin = await openDashboard(t, repo, url);
  const base = '/projects/test/requests/recorded';
  const get = async path => {
    const response = await fetch(origin + path);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return response.text();
  };
  assert.match(await get('/projects/test/agents'), /agents\?role=planner/);
  const current = await get('/projects/test/agents?role=planner');
  assert.match(current, /current-profile/);
  assert.match(current, /Current reviewer suggestion/);
  assert.doesNotMatch(current, /Historical reviewer suggestion/);
  const history = await get(base + '/agents?role=planner&attempt=0');
  assert.match(history, /Historical reviewer suggestion/);
  assert.doesNotMatch(history, /Current reviewer suggestion|A private &lt;prompt/);
  assert.ok(history.includes('/events/' + exact + '/input'));
  const call = await get(base + '/events/' + exact + '/input');
  assert.match(call, /A private &lt;prompt&gt;/);
  assert.match(call, /The private &lt;reply&gt;/);
  assert.doesNotMatch(call, /<prompt>|<reply>/);
  const prompt = await fetch(origin + base + '/events/' + exact + '/input/prompt.txt');
  assert.equal(prompt.status, 200);
  assert.match(prompt.headers.get('content-disposition'), /^attachment;/);
  assert.deepEqual(Buffer.from(await prompt.arrayBuffer()), Buffer.from(input.prompt));
  assert.ok((await get(base)).includes('/events/' + exact + '/input#call-input'));
  const older = await get(base + '/events/' + legacy + '/input');
  assert.match(older, /exact prompt[^<]*(not saved|unavailable)/i);
  assert.doesNotMatch(older, /Historical reviewer suggestion|The private &lt;reply/);
  assert.doesNotMatch(await get(base + '/trace.json'), /A private <prompt>|The private <reply>/);
  for (const path of ['/projects/other/agents', '/projects/test/requests/external/agents', base + '/events/1/input',
    base + '/events/' + legacy + '/input/prompt.txt',
    '/projects/test/requests/external/events/' + exact + '/input', base + '/agents?role=planner&attempt=99', base + '/agents?role=nobody']) {
    const response = await fetch(origin + path);
    assert.equal(response.status, 404, path);
    await response.body.cancel();
  }
});

test('a current agent edit applies to the next worker and protects historical records and concurrent changes', { skip: !postgres, timeout: 30_000 }, async t => {
  const { db, url } = await testDatabase(t);
  const repo = await mkdtemp(join(tmpdir(), 'crew-profile-edit-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const context = { projectId: 'test' };
  const workerBeforeEdit = await runtimeForFeature(repo, context);
  const firstProfile = workerBeforeEdit.profiles.planner;
  await createFeature(db, { ...context, id: 'original', goal: 'Record the original planner' });
  await runFeature(db, 'original', { runtime: {
    plan: async ({ onEvent }) => {
      await onEvent({ type: 'runtime.profile', evidence: firstProfile });
      throw new Error('Stopped after recording the planner');
    },
    build: assert.fail, verify: assert.fail, promote: assert.fail,
  } });
  const origin = await openDashboard(t, repo, url, { CREW_CODEX_MODEL: 'shared-crew-model' });
  const path = '/projects/test/agents?role=planner';
  const historyPath = '/projects/test/requests/original/agents?role=planner&attempt=0';
  async function page(path) {
    const res = await fetch(origin + path);
    assert.equal(res.status, 200, path);
    return res.text();
  }
  function revision(html) {
    const match = html.match(/name="version" value="([a-f0-9]{64})"/);
    assert.ok(match, 'editable definition version');
    return match[1];
  }
  function save(fields, target = path, caller = origin) {
    return fetch(origin + target, {
      method: 'POST', headers: { Origin: caller }, body: new URLSearchParams(fields), redirect: 'manual',
    });
  }
  const initial = await page(path);
  const recorded = await page(historyPath);
  assert.match(initial, /<strong>shared-crew-model<\/strong><span>Crew default/);
  assert.ok(recorded.includes(firstProfile.digest));
  assert.doesNotMatch(recorded, /Edit definition/);
  const draft = { version: revision(initial), model: 'planner-model', instructions: 'Check the meter.\r\nPreserve <phrases>.' };
  const success = await save(draft);
  assert.equal(success.status, 303);
  assert.equal(success.headers.get('location'), path + '&saved=1');
  const updated = await page(success.headers.get('location'));
  assert.match(updated, /<strong>planner-model<\/strong><span>Role override/);
  assert.match(updated, /role="status">Definition saved/);
  const version = revision(updated);
  assert.notEqual(version, draft.version);
  const nextProfile = (await runtimeForFeature(repo, context)).profiles.planner;
  assert.equal(nextProfile.model, 'planner-model');
  assert.equal(nextProfile.instructions, 'Check the meter.\nPreserve <phrases>.');
  assert.equal(workerBeforeEdit.profiles.planner.instructions, '');
  assert.equal(await page(historyPath), recorded);

  const stale = await save({ ...draft, model: 'stale-model' });
  assert.equal(stale.status, 409);
  const conflict = await stale.text();
  assert.match(conflict, /Reload saved definition/);
  assert.equal(revision(conflict), draft.version);
  assert.match(conflict, /value="stale-model"/);
  const invalid = await save({ version, model: 'invalid model', instructions: 'Keep this <draft>' });
  assert.equal(invalid.status, 400);
  const rejected = await invalid.text();
  assert.match(rejected, /role="alert"/);
  assert.match(rejected, /value="invalid model"/);
  assert.match(rejected, /Keep this &lt;draft&gt;/);
  for (const [target, caller, status] of [
    ['/projects/other/agents?role=planner', origin, 404], [historyPath, origin, 405], [path, 'https://foreign.example', 403],
  ]) {
    const denied = await save({ version, model: 'unauthorized', instructions: 'Blocked' }, target, caller);
    assert.equal(denied.status, status, target);
    await denied.body.cancel();
  }
  assert.deepEqual((await runtimeForFeature(repo, context)).profiles.planner, nextProfile);
  const cleared = await save({ version, model: '', instructions: '' });
  assert.equal(cleared.status, 303);
  const inherited = await page(cleared.headers.get('location'));
  assert.match(inherited, /<strong>shared-crew-model<\/strong><span>Crew default/);
  assert.match(inherited, /name="model"[^>]+value=""/);
  assert.deepEqual((await runtimeForFeature(repo, context)).profiles.planner, firstProfile);
  assert.equal(await page(historyPath), recorded);
});

test('named agents can be configured and activated without changing the default role', { skip: !postgres, timeout: 30_000 }, async t => {
  const { url } = await testDatabase(t);
  const repo = await mkdtemp(join(tmpdir(), 'crew-named-agent-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const origin = await openDashboard(t, repo, url, { CREW_CODEX_MODEL: 'shared-crew-model' });
  const roster = '/projects/test/agents';
  const planner = roster + '?role=planner';
  const post = (path, values) => fetch(origin + path, {
    method: 'POST', headers: { Origin: origin }, body: new URLSearchParams(values), redirect: 'manual',
  });
  const html = path => fetch(origin + path).then(res => res.text());
  assert.match(await html(planner), /Current configuration/);
  assert.match(await html(roster), />Add agent<\/a>/);
  const old = await runtimeForFeature(repo, { projectId: 'test' });
  const added = await post(roster + '?add=1', { name: 'Lesson <Planner>', role: 'planner' });
  assert.equal(added.status, 303);
  const location = added.headers.get('location');
  const agent = new URL(location, origin).searchParams.get('agent');
  const named = planner + '&agent=' + agent;
  const page = await html(location);
  const version = page.match(/name="version" value="([a-f0-9]{64})"/)[1];
  assert.match(page, /Lesson &lt;Planner&gt;/);
  assert.match(page, /Use for Planner/);
  assert.equal((await post(roster + '?add=1', { name: 'lesson <planner>', role: 'qa' })).status, 400);
  const draft = Object.entries({ version, model: 'planner-model', 'worker-image': 'node:22-alpine',
    'reasoning-effort': 'high', instructions: 'Plan in small steps.', attachments: '1', 'agent-name': 'Lesson Planner',
    'skill-name': 'Lesson checklist', 'skill-content': '# Checklist\r\nCheck examples.' });
  const invalid = await post(named, [...draft, ['extra-tool', 'custom-shell']]);
  assert.equal(invalid.status, 400);
  assert.match(await invalid.text(), /Choose available tools once per role/);
  const saved = await post(named, [...draft, ['extra-tool', 'git-history'], ['extra-tool', 'git-changes']]);
  assert.equal(saved.status, 303);
  assert.match(await html(saved.headers.get('location')), /Lesson checklist/);
  assert.equal((await post(named, draft)).status, 409);
  assert.deepEqual((await runtimeForFeature(repo, { projectId: 'test' })).profiles.planner, old.profiles.planner);

  const activated = await post(named, { activate: agent, expected: 'default' });
  assert.equal(activated.status, 303);
  assert.match(await html(planner), /<h1>Lesson Planner<\/h1>/);
  const active = (await runtimeForFeature(repo, { projectId: 'test' })).profiles.planner;
  assert.equal(active.id, agent);
  assert.equal(active.model, 'planner-model');
  assert.equal(active.reasoningEffort, 'high');
  assert.deepEqual(active.extraTools, ['git-history', 'git-changes']);
  assert.deepEqual(active.skills, [{ name: 'Lesson checklist', content: '# Checklist\nCheck examples.' }]);
  const wrongRole = await fetch(origin + roster + '?role=qa&agent=' + agent);
  assert.equal(wrongRole.status, 404);
  const base = planner + '&agent=default';
  assert.equal((await post(base, { activate: 'default', expected: 'default' })).status, 409);
  assert.equal((await post(base, { activate: 'default', expected: agent })).status, 303);
  assert.deepEqual((await runtimeForFeature(repo, { projectId: 'test' })).profiles.planner, old.profiles.planner);
});

test('Music Transcribe Agents shows project revisions, pinned assignments, and legacy Feature settings', { skip: !postgres, timeout: 30_000 }, async t => {
  const { db, url } = await testDatabase(t);
  const repo = await mkdtemp(join(tmpdir(), 'crew-feature-agent-copy-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const project = 'music-transcribe';
  const directory = join(repo, '.crew-local', 'profiles');
  await mkdir(directory, { recursive: true });
  const planner = { model: 'gpt-5.4', reasoningEffort: 'high', instructions: 'Use two repetitions.',
    skills: [{ name: 'Rhythm notes', content: 'Describe the tempo.' }], extraTools: ['git-history'] };
  const config = { roles: { planner }, agents: {}, activeAgents: {} };
  const saveFeature = () => writeFile(join(directory, project + '.json'), JSON.stringify(config));
  await saveFeature();
  const origin = await openDashboard(t, repo, url, {}, project);
  const base = origin + `/projects/${project}/agents`;
  const copy = base + '?new=1&from-role=planner&from-agent=default';
  const post = (target, values) => fetch(target, { method: 'POST', headers: { Origin: origin },
    body: new URLSearchParams(values), redirect: 'manual' });
  const html = await fetch(base).then(response => response.text());
  assert.match(html, /Project agents[\s\S]+Legacy Feature agents[\s\S]+gpt-5\.4 · high reasoning[\s\S]+Copy Planner as reusable agent/);
  const alias = await fetch(origin + `/projects/${project}/agent-library?new=1`, { redirect: 'manual' });
  assert.equal(alias.headers.get('location'), `/projects/${project}/agents?new=1`);
  const initialRole = await fetch(base + '?role=planner').then(response => response.text());
  assert.match(initialRole, /id="legacy-feature-agents"[^>]+ open/);
  assert.match(initialRole, /Open legacy Planner settings/);
  const draft = await fetch(copy).then(response => response.text());
  assert.match(draft, /Copy Planner/);
  assert.match(draft, /Use two repetitions\./);
  assert.match(draft, /Rhythm notes/);
  const digest = source => source.match(/name="feature-source" value="([a-f0-9]{64})"/)[1];
  const fields = { version: '0', name: 'Rhythm planner', remit: 'Plan practice.', model: planner.model,
    instructions: 'Derive the practice plan from the brief. Use two repetitions.', reasoning: 'high',
    workspace: 'read-only', 'skill-name': planner.skills[0].name, 'skill-content': planner.skills[0].content,
    'codex-tool': 'read_input', 'feature-source': digest(draft) };
  planner.instructions = 'Use three repetitions.';
  await saveFeature();
  const stale = await post(copy, fields);
  assert.equal(stale.status, 409);
  const refreshed = await stale.text();
  assert.match(refreshed, /Review the refreshed settings/);
  assert.match(refreshed, /Use three repetitions\./);
  assert.deepEqual(await listReusableAgents(db, project), []);
  const submit = { ...fields, instructions: planner.instructions, 'feature-source': digest(refreshed) };
  const saved = await post(copy, submit);
  assert.equal(saved.status, 303);
  const again = await post(copy, submit);
  assert.equal(again.status, 303);
  assert.equal(again.headers.get('location'), saved.headers.get('location'));
  assert.equal((await post(copy, { ...submit, name: 'Competing title' })).status, 409);
  const [agent] = await listReusableAgents(db, project);
  assert.equal(agent.version, 1);
  assert.deepEqual(agent.definition.featureSource, { role: 'planner', key: 'default', profileId: 'planner', digest: submit['feature-source'] });
  assert.equal(agent.definition.model, planner.model);
  assert.deepEqual(agent.definition.skills, planner.skills);
  const openCopy = await fetch(copy, { redirect: 'manual' });
  assert.equal(openCopy.headers.get('location'), `/projects/${project}/agents?agent=${agent.id}`);
  const editor = origin + openCopy.headers.get('location');
  const snapshot = await buildWorkflowSnapshot(db, { project: { id: project, name: 'Music Transcribe' }, workflowId: 'rhythm-practice',
    sourceCommit: 'a'.repeat(40), draft: { title: 'Rhythm practice', goal: 'Identify when to practice.', brief: 'Make a practice plan.',
      steps: [{ id: 'plan', title: 'Plan the rhythm practice', objective: 'Write the rhythm practice plan.', owner: 'Project owner',
        agent: `library:${agent.id}:1`, inputs: ['brief'], prerequisites: [] }] } });
  await registerProject(db, snapshot);
  assert.equal((await post(editor, { ...submit, version: '1', instructions: 'Use a four-beat warmup.' })).status, 303);
  const [edited] = await listReusableAgents(db, project);
  assert.deepEqual(edited.definition.featureSource, agent.definition.featureSource);
  assert.equal(edited.version, 2);
  const role = await fetch(base + '?role=planner', { redirect: 'manual' });
  assert.equal(role.headers.get('location'), `/projects/${project}/agents?agent=${agent.id}`);
  const current = await fetch(editor).then(response => response.text());
  assert.match(current, /Current version 2[\s\S]+Version history[\s\S]+View version 1/);
  assert.match(current, /Compare revisions/);
  assert.match(current, /Rhythm practice · v1[\s\S]+Agent v1 · Plan the rhythm practice/);
  assert.match(current, /Use a four-beat warmup\./);
  const pinned = await fetch(editor + '&version=1').then(response => response.text());
  assert.match(pinned, /Saved version 1[\s\S]+Open current version[\s\S]+Use three repetitions\./);
  assert.match(pinned, /<fieldset class="configuration-card" disabled>/);
  assert.doesNotMatch(pinned, /Save agent version|Use a four-beat warmup/);
  assert.equal((await post(editor + '&version=1', { ...submit, version: '2' })).status, 405);
  assert.equal((await fetch(editor + '&version=3')).status, 404);
  const compare = origin + `/projects/${project}/agents/compare?agent=${agent.id}`;
  const comparison = await fetch(compare).then(response => response.text());
  assert.match(comparison, /<h1>Compare agent revisions<\/h1>/);
  assert.match(comparison, /<pre>Use three repetitions\.<\/pre>[\s\S]+<pre>Use a four-beat warmup\.<\/pre>/);
  assert.match(await fetch(compare + '&from=2&to=2').then(response => response.text()), /The saved settings match/);
  assert.equal((await fetch(compare + '&to=3')).status, 404);
  const workflow = await fetch(origin + `/projects/${project}/workflows?workflow=rhythm-practice&version=1`).then(response => response.text());
  assert.ok(workflow.includes(`href="/projects/${project}/agents?agent=${agent.id}&amp;version=1">View saved agent v1`));
  assert.deepEqual(await readProjectProfile(repo, project), config);
  await writeFile(join(directory, project + '.json'), 'invalid fixture JSON');
  const unavailable = await fetch(base);
  assert.equal(unavailable.status, 200);
  assert.match(await unavailable.text(), /Rhythm planner[\s\S]+The current Feature settings are unavailable/);
});

test('browser workflow versions pin independent reusable agents and gate dependent steps', { skip: !postgres, timeout: 30_000 }, async t => {
  const { db, url } = await testDatabase(t);
  const repo = fileURLToPath(new URL('..', import.meta.url));
  const project = 'music-test';
  const bin = await mkdtemp(join(tmpdir(), 'crew-browser-mcp-'));
  t.after(() => rm(bin, { recursive: true, force: true }));
  await copyFile(new URL('../test-support/workflow-codex-fixture.mjs', import.meta.url), join(bin, 'codex'));
  await chmod(join(bin, 'codex'), 0o700);
  const origin = await openDashboard(t, repo, url, { PATH: bin + ':' + process.env.PATH }, project);
  const base = '/projects/' + project;
  const post = (path, values) => fetch(origin + path, {
    method: 'POST', headers: { Origin: origin }, body: new URLSearchParams(values), redirect: 'manual',
  });
  const file = { path: 'assets/sample.bin', data: Buffer.from([0, 255, 17]).toString('base64') };
  const bundle = { directory: 'lesson-checklist', files: [file] };
  const agent = { version: '0', name: 'Lesson planner', remit: 'Plan acceptance for recorded lessons.', model: 'planner-model',
    instructions: 'Use the lesson brief.', 'skill-name': 'Checklist', 'skill-content': '# Include failure paths.',
    'skill-bundle': JSON.stringify(bundle), 'codex-mcp-server': 'lesson-timing', 'codex-plugin': 'tempo@crew-fixture',
    'codex-app': 'connector_music_fixture',
    workspace: 'read-only', 'image-inspection': '1', delegation: '1', 'subagent-concurrency': '2', 'subagent-model': 'gpt-6-luna',
    'specialist-name': 'rhythm_reviewer', 'specialist-description': 'Review the timing independently.',
    'specialist-instructions': 'Use the first timing notes.\nGive independent feedback.',
    'specialist-model': 'gpt-6-luna', 'specialist-reasoning': 'low' };
  const editor = await fetch(origin + base + '/agent-library?new=1').then(response => response.text());
  assert.match(editor, /Codex MCP servers/);
  assert.match(editor, /Installed Codex plugins/);
  assert.match(editor, /Connected Codex apps/);
  const { apps } = await fetch(origin + base + '/agent-library/apps').then(response => response.json());
  assert.ok(apps.some(app => app.id === agent['codex-app'] && app.callable));
  assert.ok(apps.some(app => app.id === 'connector_blocked_fixture' && !app.callable));
  assert.match(editor, /Lifecycle hooks/);
  assert.match(editor, /value="unavailable@crew-fixture"\s+ disabled/);
  assert.match(editor, /value="unused-server"\s+ disabled/);
  const refused = await post(base + '/agent-library?new=1', { ...agent, 'codex-mcp-server': 'unused-server' });
  assert.equal(refused.status, 400);
  assert.match(await refused.text(), /unused-server is unavailable/);
  assert.equal((await post(base + '/agent-library?new=1', { ...agent, 'codex-plugin': 'unavailable@crew-fixture' })).status, 400);
  assert.equal((await post(base + '/agent-library?new=1', { ...agent, 'codex-app': 'connector_blocked_fixture' })).status, 400);
  const unreviewed = await post(base + '/agent-library?new=1', { ...agent, 'hook-config': JSON.stringify({ hooks: {
    SessionStart: [{ hooks: [{ type: 'command', command: 'printf timing' }] }],
  } }) });
  assert.equal(unreviewed.status, 400);
  assert.match(await unreviewed.text(), /Review and trust the new hook definitions/);
  const created = await post(base + '/agent-library?new=1', agent);
  assert.equal(created.status, 303);
  const agentUrl = new URL(created.headers.get('location'), origin);
  const agentId = agentUrl.searchParams.get('agent');
  const profileId = agentId + '-v1';
  const form = new URLSearchParams({ action: 'save', version: '0', title: 'Lesson acceptance', goal: 'Plan and review a lesson.',
    brief: 'Play the lesson and verify timing.', 'step-1.title': 'Plan', 'step-1.objective': 'Propose observable checks.',
    'step-2.title': 'Review', 'step-2.objective': 'Review the plan.', 'step-1.owner': 'Operator', 'step-2.owner': 'Operator',
    'step-1.agent': 'library:' + agentId + ':1', 'step-2.agent': 'library:' + agentId + ':1',
    'step-1.input': 'brief', 'step-2.dependency': 'step-1' });
  form.append('step', 'step-1');
  form.append('step', 'step-2');
  const cyclic = new URLSearchParams(form);
  cyclic.set('step-1.dependency', 'step-2');
  const rejected = await post(base + '/workflows?new=1', cyclic);
  assert.equal(rejected.status, 400);
  assert.match(await rejected.text(), /Prerequisites form a cycle involving/);
  const saved = await post(base + '/workflows?new=1', form);
  assert.equal(saved.status, 303);
  const workflowUrl = new URL(saved.headers.get('location'), origin);
  const workflowId = workflowUrl.searchParams.get('workflow');
  const v1 = await loadProject(db, project, workflowId, 1);
  assert.deepEqual(v1.project.tasks.map(task => task.profileId), [profileId, profileId]);
  assert.deepEqual(v1.agentOrigins[profileId].codexRuntime.mcpServers, ['lesson-timing']);
  assert.deepEqual(v1.agentOrigins[profileId].codexRuntime.plugins, ['tempo@crew-fixture']);
  assert.deepEqual(v1.agentOrigins[profileId].codexRuntime.apps, [{ id: agent['codex-app'], name: 'Music Notes' }]);
  assert.equal(v1.agentOrigins[profileId].codexRuntime.imageInspection, true);
  assert.deepEqual(v1.agentOrigins[profileId].codexRuntime.delegation, { maxConcurrent: 2, model: 'gpt-6-luna' });
  assert.equal(v1.agentOrigins[profileId].codexRuntime.subagentRoles[0].instructions, agent['specialist-instructions']);
  assert.deepEqual(v1.project.tasks[1].handoffInputs, [{ task: 'step-1', slot: 'result' }]);
  assert.equal(v1.files.get(v1.project.profiles[0].instructions), agent.instructions);

  const second = await openDashboard(t, repo, url, {}, 'second-music-project');
  const other = '/projects/second-music-project';
  const workflowForm = () => fetch(second + other + '/workflows?new=1').then(response => response.text());
  assert.doesNotMatch(await workflowForm(), /Lesson planner/);
  assert.equal((await fetch(second + other + '/agent-library?agent=' + agentId)).status, 404);
  const revisedBundle = { ...bundle, files: [{ ...file, data: Buffer.from('Updated asset').toString('base64') }] };
  const revisedAgent = { ...agent };
  delete revisedAgent['codex-mcp-server'];
  delete revisedAgent['codex-plugin'];
  delete revisedAgent['codex-app'];
  delete revisedAgent.delegation;
  delete revisedAgent['image-inspection'];
  revisedAgent['specialist-instructions'] = 'Use the updated timing notes.';
  const updated = await post(agentUrl.pathname + agentUrl.search, { ...revisedAgent, version: '1', shared: '1', instructions: 'Refine the lesson checklist.',
    'skill-bundle': JSON.stringify(revisedBundle) });
  assert.equal(updated.status, 303);
  assert.match(await workflowForm(), /Lesson planner · Shared v2/);
  const foreign = await fetch(second + other + '/agent-library?agent=' + agentId, {
    method: 'POST', headers: { Origin: second }, body: new URLSearchParams({ ...agent, version: '2' }),
  });
  assert.equal(foreign.status, 403);
  form.set('version', '1');
  form.set('step-1.agent', 'library:' + agentId + ':2');
  form.set('step-2.agent', 'workflow:' + profileId);
  const revised = await post(workflowUrl.pathname + workflowUrl.search, form);
  assert.equal(revised.status, 303);
  const v2 = await loadProject(db, project, workflowId, 2);
  assert.deepEqual(v2.project.tasks.map(task => task.profileId), [agentId + '-v2', profileId]);
  assert.equal(v2.agentOrigins[agentId + '-v2'].codexRuntime.mcpServers, undefined);
  assert.equal(v2.agentOrigins[agentId + '-v2'].codexRuntime.plugins, undefined);
  assert.equal(v2.agentOrigins[agentId + '-v2'].codexRuntime.apps, undefined);
  assert.equal(v2.agentOrigins[agentId + '-v2'].codexRuntime.delegation, undefined);
  assert.equal(v2.agentOrigins[agentId + '-v2'].codexRuntime.subagentRoles[0].instructions, revisedAgent['specialist-instructions']);
  assert.equal((await post(workflowUrl.pathname + workflowUrl.search, form)).status, 409);

  const started = await post(workflowUrl.pathname + '?workflow=' + workflowId + '&version=1', { version: '1', action: 'run' });
  assert.equal(started.status, 303);
  const runUrl = new URL(started.headers.get('location'), origin);
  assert.equal((await fetch(runUrl)).status, 200);
  const store = runStore(db, runUrl.searchParams.get('run'));
  const run = await store.read();
  assert.equal(run.project.configurationVersion, 1);
  assert.ok(run.tasks.every(task => task.attempts.length === 0));
  assert.deepEqual(run.profiles[0].codexRuntime.mcpServers, ['lesson-timing']);
  assert.deepEqual(run.profiles[0].codexRuntime.plugins, ['tempo@crew-fixture']);
  assert.deepEqual(run.profiles[0].codexRuntime.apps, [{ id: agent['codex-app'], name: 'Music Notes' }]);
  assert.deepEqual(run.profiles[0].codexRuntime.delegation, { maxConcurrent: 2, model: 'gpt-6-luna' });
  const [specialistId] = run.profiles[0].subagentRoleIds;
  const specialist = run.artifacts.find(artifact => artifact.id === specialistId);
  assert.equal(specialist.title, 'rhythm_reviewer.toml');
  assert.ok(specialist.content.includes('developer_instructions = ' + JSON.stringify(agent['specialist-instructions'])));
  assert.deepEqual(specialist.provenance, { source: 'agent-library', agentId, version: 1 });
  const handoff = await fetch(origin + '/runs/' + run.id + '/tasks/step-1').then(response => response.text());
  assert.match(handoff, /Pinned specialist definitions/);
  assert.match(handoff, /Connected Codex apps<\/summary><ul><li>Music Notes/);
  assert.ok(handoff.includes('/artifacts/' + specialistId));
  const instructions = run.artifacts.find(artifact => artifact.id === 'profile-' + profileId);
  assert.deepEqual(instructions.provenance, { source: 'agent-library', agentId, version: 1 });
  const pinned = run.artifacts.find(artifact => artifact.kind === 'skill-resource');
  assert.equal(pinned.content, file.data);
  assert.equal(pinned.provenance.version, 1);
  const download = await fetch(origin + '/runs/' + run.id + '/artifacts/' + pinned.id + '?download=1');
  assert.equal(download.status, 200);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), Buffer.from(file.data, 'base64'));
  await assert.rejects(dispatch(store, 'step-2', undefined, undefined, assert.fail), /accept/i);
  const attempt = await dispatch(store, 'step-1', undefined, undefined, async job => {
    assert.equal(job.model, 'planner-model');
    assert.deepEqual(job.instructions, [agent.instructions, agent['skill-content']]);
    assert.deepEqual(job.skillBundles, [bundle]);
    return { outcome: 'execution-failed', error: 'Stopped after verifying the pinned prompt.' };
  });
  assert.equal(attempt.outcome, 'execution-failed');
});

test('workflow revisions pin named inputs and route only selected typed outputs from accepted attempts', { skip: !postgres, timeout: 30_000 }, async t => {
  const { db, url } = await testDatabase(t);
  const repo = fileURLToPath(new URL('..', import.meta.url));
  const project = 'music-transcribe';
  const origin = await openDashboard(t, repo, url, {}, project);
  const base = '/projects/' + project;
  const post = (path, form) => fetch(origin + path, {
    method: 'POST', headers: { Origin: origin }, body: new URLSearchParams(form), redirect: 'manual',
  });
  const agent = await post(base + '/agent-library?new=1', { version: '0', name: 'Timing analyst',
    remit: 'Review lesson timings.', instructions: 'Return the evidence.', model: '', workspace: 'tools' });
  assert.equal(agent.status, 303);
  const agentId = new URL(agent.headers.get('location'), origin).searchParams.get('agent');
  const reference = 'library:' + agentId + ':1';
  const fields = new URLSearchParams({ 'artifact-contract': '1', action: 'save', version: '0', title: 'Review a lesson',
    goal: 'Find timing corrections.', brief: 'Retain the source evidence.', 'workflow-input': 'input-1',
    'workflow-input.input-1.id': 'lesson-excerpt', 'workflow-input.input-1.title': 'Lesson excerpt',
    'workflow-input.input-1.content': 'A correction at 13 seconds.',
    'step-1.title': 'Extract corrections', 'step-1.objective': 'Read the lesson excerpt.', 'step-1.agent': reference,
    'step-1.owner': 'Operator', 'step-1.input': 'input-1',
    'step-2.title': 'Prepare cues', 'step-2.objective': 'Use the correction data.', 'step-2.agent': reference,
    'step-2.owner': 'Operator', 'step-2.dependency': 'step-1', 'step-2.route': 'step-1/output-1',
  });
  fields.append('step', 'step-1');
  fields.append('step', 'step-2');
  for (const [step, ref, slot, title, kind] of [
    ['step-1', 'result', 'notes', 'Listening notes', 'markdown'],
    ['step-1', 'output-1', 'corrections', 'Correction data', 'json'],
    ['step-2', 'result', 'cues', 'Practice cues', 'text'],
  ]) {
    fields.append(step + '.output', ref);
    const prefix = step + '.output.' + ref + '.';
    for (const [key, value] of Object.entries({ id: slot, title, kind, required: '1', acceptance: 'Use the evidence.' }))
      fields.set(prefix + key, value);
  }
  const duplicate = new URLSearchParams(fields);
  duplicate.set('workflow-input.input-1.id', 'brief');
  const refused = await post(base + '/workflows?new=1', duplicate);
  assert.equal(refused.status, 400);
  assert.match(await refused.text(), /Duplicate workflow input ID/);
  const created = await post(base + '/workflows?new=1', fields);
  assert.equal(created.status, 303);
  const workflowUrl = new URL(created.headers.get('location'), origin);
  const workflowId = workflowUrl.searchParams.get('workflow');
  const v1 = await loadProject(db, project, workflowId, 1);
  assert.deepEqual(v1.project.tasks[0].inputs, ['lesson-excerpt']);
  assert.deepEqual(v1.project.tasks[1].handoffInputs, [{ task: 'step-1', slot: 'corrections' }]);
  const changed = new URLSearchParams(fields);
  changed.set('version', '1');
  assert.equal((await post(workflowUrl.pathname + '?workflow=' + workflowId, changed)).status, 303);
  assert.equal((await loadProject(db, project, workflowId)).version, 1);
  changed.set('workflow-input.input-1.content', 'The revised excerpt.');
  assert.equal((await post(workflowUrl.pathname + '?workflow=' + workflowId, changed)).status, 303);
  const started = await post(workflowUrl.pathname + '?workflow=' + workflowId + '&version=1', { action: 'run', version: '1' });
  assert.equal(started.status, 303);
  const runId = new URL(started.headers.get('location'), origin).searchParams.get('run');
  const store = runStore(db, runId);
  const path = '/runs/' + runId + '/tasks/step-2';
  const awaiting = await fetch(origin + path).then(response => response.text());
  assert.match(awaiting, /Artifacts from prerequisites/);
  assert.match(awaiting, /Correction data/);
  assert.doesNotMatch(awaiting, /Listening notes/);
  const send = outputs => ({ outcome: 'completed', receipt: { threadId: 'timing-fixture' },
    response: { state: 'completed', summary: 'Recorded timing.', outputs, decisions: [], questions: [], blockers: [] } });
  const malformed = await dispatch(store, 'step-1', undefined, undefined, async job => {
    assert.deepEqual(job.inputs.map(({ id, content }) => [id, content]), [['input-lesson-excerpt', 'A correction at 13 seconds.']]);
    return send([{ slot: 'notes', content: 'Timing notes' }, { slot: 'corrections', content: 'not JSON' }]);
  });
  assert.equal(malformed.outcome, 'invalid-result');
  assert.match(malformed.error, /corrections must contain valid JSON/);
  await decide(store, 'step-1', malformed.id, 'rework', 'Return the corrections as JSON.');
  const correction = '{"second":13}';
  const producer = await dispatch(store, 'step-1', undefined, undefined, async () =>
    send([{ slot: 'notes', content: 'Timing notes' }, { slot: 'corrections', content: correction }]));
  await assert.rejects(dispatch(store, 'step-2', undefined, undefined, assert.fail), /Waiting for accepted handoff/);
  await decide(store, 'step-1', producer.id, 'accepted', 'Verified the source timing.');
  const done = await dispatch(store, 'step-2', undefined, undefined, async job => {
    assert.deepEqual(job.inputs.map(({ id, kind, content }) => [id, kind, content]),
      [[producer.result.artifacts.corrections, 'json', correction]]);
    return send([{ slot: 'cues', content: 'Practice the phrase at 13 seconds.' }]);
  });
  assert.equal(done.outcome, 'completed');
  assert.equal(done.handoffs[0].attemptId, producer.id);
  assert.match(await fetch(origin + path).then(response => response.text()), /Ready for review/);
});

test('project MCP connections are private and runs use the attached revision after a connection edit', { skip: !postgres, timeout: 30_000 }, async t => {
  const { db, url } = await testDatabase(t);
  const repo = fileURLToPath(new URL('..', import.meta.url));
  const bin = await mkdtemp(join(tmpdir(), 'crew-project-mcp-'));
  t.after(() => rm(bin, { recursive: true, force: true }));
  await copyFile(new URL('../test-support/workflow-codex-fixture.mjs', import.meta.url), join(bin, 'codex'));
  await chmod(join(bin, 'codex'), 0o700);
  const project = 'music-transcribe';
  const origin = await openDashboard(t, repo, url, { PATH: bin + ':' + process.env.PATH }, project);
  const base = '/projects/' + project;
  const post = (path, values, host = origin) => fetch(host + path, {
    method: 'POST', headers: { Origin: host }, body: new URLSearchParams(values), redirect: 'manual',
  });
  const tool = {
    version: '0', id: 'timing', name: 'Lesson timing', transport: 'stdio',
    command: 'timing-fixture', args: '["--fixture"]', approval: 'writes', required: '1',
    allow: 'inspect_tempo', 'tool-policies': 'inspect_tempo=approve',
  };
  const created = await post(base + '/tools?new=1', tool);
  assert.equal(created.status, 303);
  const toolUrl = base + '/tools?connection=timing';
  assert.match(await fetch(origin + toolUrl).then(response => response.text()), /inspect_tempo=approve/);
  assert.equal((await post(base + '/tools?new=1', tool)).status, 409);
  const other = await openDashboard(t, repo, url, {}, 'other-music-project');
  const foreign = '/projects/other-music-project';
  assert.equal((await fetch(other + foreign + '/tools?connection=timing')).status, 404);

  const agentDraft = { version: '0', name: 'Timing checks', remit: 'Inspect the lesson timing.', model: 'fixture-codex',
    instructions: 'Use the timing evidence.', workspace: 'workspace-write', 'project-mcp': 'timing:1',
    'skill-name': 'Checklist', 'skill-content': 'Inspect evidence.' };
  const asForm = values => {
    const form = new URLSearchParams(values);
    for (const name of ['list_inputs', 'search_inputs', 'read_input']) form.append('codex-tool', name);
    return form;
  };
  assert.equal((await post(foreign + '/agent-library?new=1', asForm(agentDraft), other)).status, 400);
  assert.equal((await post(base + '/agent-library?new=1', asForm({ ...agentDraft, shared: '1' }))).status, 400);
  const savedAgent = await post(base + '/agent-library?new=1', asForm(agentDraft));
  assert.equal(savedAgent.status, 303);
  const agentUrl = new URL(savedAgent.headers.get('location'), origin);
  const agentId = agentUrl.searchParams.get('agent');

  const revisedTool = { ...tool, version: '1', transport: 'http', url: 'https://mcp.example.com/mcp',
    bearer: 'TIMING_TOKEN', headers: 'X-Lesson=TIMING_LESSON', 'tool-policies': 'inspect_tempo=prompt' };
  assert.equal((await post(toolUrl, revisedTool)).status, 303);
  assert.equal((await post(toolUrl, revisedTool)).status, 409);
  const oldTool = toolUrl + '&version=1';
  const history = await fetch(origin + oldTool).then(response => response.text());
  assert.match(history, /Version 1 · read-only/);
  assert.match(history, /Codex server name/);
  assert.match(history, /timing-fixture/);
  assert.match(history, /Connection versions/);
  assert.equal((await post(oldTool, revisedTool)).status, 405);
  const savedForm = await fetch(agentUrl).then(response => response.text());
  assert.match(savedForm, /value="timing:2">Version 2 · latest/);
  assert.match(savedForm, /value="timing:1" selected>Version 1 · attached/);
  const runSetup = await fetch(agentUrl.href + '&run=1').then(response => response.text());
  assert.match(runSetup, /<summary>Run setup<\/summary>/);
  assert.match(runSetup, /tools\?connection=timing&amp;version=1[^>]*>Lesson timing · v1/);
  assert.match(runSetup, /Checklist · Agent attachment/);
  const check = base + '/tools/check?connection=timing&version=';
  assert.equal((await fetch(origin + check + '1')).status, 405);
  assert.equal((await fetch(origin + check + '1', { method: 'POST', headers: { Origin: other } })).status, 403);
  const firstCheck = await post(check + '1', {});
  assert.equal(firstCheck.status, 200);
  const discovered = await firstCheck.text();
  assert.match(discovered, /Codex found 1 tool available under the saved policy/);
  assert.match(discovered, /<code>inspect_tempo<\/code> · Allow calls/);
  assert.doesNotMatch(discovered, /excluded_tool/);
  const failedCheck = await post(check + '2', {});
  assert.equal(failedCheck.status, 200);
  const failedDiscovery = await failedCheck.text();
  assert.match(failedDiscovery, /Codex could not list tools/);
  assert.match(failedDiscovery, /Missing worker environment variables/);
  assert.doesNotMatch(failedDiscovery, /Private fixture error/);
  const workflow = await post(base + '/workflows?new=1', { action: 'save', version: '0',
    title: 'Evidence workflow', goal: 'Review lesson timing.', brief: 'Read the timing evidence.', step: 'step-1',
    'step-1.title': 'Review', 'step-1.objective': 'Inspect lesson timing.', 'step-1.owner': 'Operator',
    'step-1.agent': 'library:' + agentId + ':1', 'step-1.input': 'brief' });
  assert.equal(workflow.status, 303);
  const workflowUrl = new URL(workflow.headers.get('location'), origin);
  const workflowId = workflowUrl.searchParams.get('workflow');
  const runResponse = await post(workflowUrl.pathname + '?workflow=' + workflowId + '&version=1', { action: 'run', version: '1' });
  assert.equal(runResponse.status, 303);
  const runId = new URL(runResponse.headers.get('location'), origin).searchParams.get('run');
  const stored = runStore(db, runId);
  const started = await post('/runs/' + runId + '/tasks/step-1', { action: 'dispatch' });
  assert.equal(started.status, 303);
  let run;
  for (let i = 0; i < 40; i++) {
    run = await stored.read();
    if (run.tasks[0].attempts[0] && run.tasks[0].attempts[0].outcome !== 'running') break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const [connection] = run.profiles[0].projectMcp;
  assert.equal(connection.version, 1);
  assert.deepEqual(connection.settings.tools, { inspect_tempo: { approval_mode: 'approve' } });
  assert.equal(connection.settings.command, 'timing-fixture');
  assert.equal(run.tasks[0].attempts[0]?.outcome, 'completed');
  const activity = run.artifacts.find(artifact => artifact.id.startsWith('activity-'));
  assert.ok(JSON.parse(activity.content).toolCalls.some(call => call.server === connection.server && call.tool === 'inspect_tempo'));
  const activityPage = await fetch(origin + '/runs/' + runId + '/artifacts/' + activity.id + '?task=step-1');
  assert.equal(activityPage.status, 200);
  const activityHtml = await activityPage.text();
  assert.match(activityHtml, /<h2>Tool calls<\/h2>/);
  assert.match(activityHtml, /<h2>Codex activity<\/h2>/);
  assert.match(activityHtml, /inspect the &lt;timing notes&gt; first/);
  assert.doesNotMatch(activityHtml, /Private fixture reasoning|<timing notes>/);
  assert.equal(run.tasks[0].attempts[0].agentActivity[0].text, 'I’ll inspect the <timing notes> first.');
  assert.match(await fetch(origin + '/runs/' + runId + '/tasks/step-1').then(response => response.text()),
    /tools\?connection=timing&amp;version=1/);
});

test('OAuth sign-in follows the saved project connection, matches the native attempt, and supports cancellation', { skip: !postgres, timeout: 30_000 }, async t => {
  const { db, url } = await testDatabase(t);
  const repo = fileURLToPath(new URL('..', import.meta.url));
  const bin = await mkdtemp(join(tmpdir(), 'crew-oauth-ui-'));
  t.after(() => rm(bin, { recursive: true, force: true }));
  const approved = join(bin, 'approved');
  await writeFile(join(bin, 'codex'), `#!/usr/bin/env node
    const {existsSync} = require('node:fs');
    const {createInterface} = require('node:readline');
    const args = process.argv.slice(2);
    const marker = ${JSON.stringify(approved)};
    const name = args.find(arg => arg.startsWith('mcp_servers.'))?.split('.')[1];
    if(args[0] === 'mcp') {
      console.log(JSON.stringify(name ? [{name,enabled:true,transport:{type:'streamable_http'},
        auth_status:existsSync(marker)?'o_auth':'not_logged_in'}] : []));
    } else {
      const write = message => console.log(JSON.stringify(message));
      createInterface({input:process.stdin}).on('line', line => {
        const request=JSON.parse(line);
        if(request.id===1)write({id:1,result:{ready:true}});
        if(request.id!==2)return;
        if(request.method!=='mcpServer/oauth/login'||request.params.name!==name)process.exit(4);
        write({id:2,result:{authorizationUrl:'https://provider.example.invalid/authorize?state=fixture',loginId:'expected'}});
        const notify=loginId=>write({method:'mcpServer/oauthLogin/completed',params:{name,loginId,threadId:null,success:true}});
        notify('unrelated');
        const timer=setInterval(()=>{if(existsSync(marker)){clearInterval(timer);notify('expected');}},50);
        timer.unref();
      });
    }
  `, { mode: 0o700 });
  const project = 'music-transcribe';
  const origin = await openDashboard(t, repo, url, { PATH: bin + ':' + process.env.PATH }, project);
  const base = '/projects/' + project + '/tools';
  const post = (path, fields = {}, site = origin) => fetch(new URL(path, origin), {
    method: 'POST', body: new URLSearchParams(fields), headers: { Origin: site }, redirect: 'manual',
  });
  const draft = { id: 'timing', name: 'Timing OAuth', transport: 'http', version: '0', url: 'https://mcp.example.invalid/mcp',
    scopes: 'timing:read', approval: 'approve', oauth: '1', required: '1' };
  assert.equal((await post(base + '?new=1', { ...draft, bearer: 'TIMING_TOKEN' })).status, 400);
  assert.equal((await post(base + '?new=1', draft)).status, 303);
  const start = base + '/oauth?connection=timing&version=1';
  assert.equal((await post(start, {}, 'https://example.invalid')).status, 403);
  const first = await post(start);
  assert.equal(first.status, 303);
  const firstUrl = first.headers.get('location');
  assert.equal((await post(start)).headers.get('location'), firstUrl);
  async function waitFor(path, phrase) {
    for (let attempt = 0; attempt < 60; attempt++) {
      const body = await fetch(new URL(path, origin)).then(response => response.text());
      if (body.includes(phrase)) return body;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.fail('OAuth page did not show ' + phrase);
  }
  const waiting = await waitFor(firstUrl, 'Complete sign-in in the provider tab');
  assert.doesNotMatch(waiting, /Codex saved the authorization/);
  const polling = await fetch(new URL(firstUrl + '&status=1', origin)).then(response => response.json());
  assert.equal(polling.state, 'waiting');
  assert.match(polling.authorizationUrl, /^https:\/\/provider\.example\.invalid\/authorize\?/);
  assert.equal((await post(firstUrl, { action: 'cancel' })).status, 303);
  await waitFor(firstUrl, 'Sign-in was cancelled.');
  const retry = (await post(start)).headers.get('location');
  assert.notEqual(retry, firstUrl);
  await waitFor(retry, 'Complete sign-in in the provider tab');
  await writeFile(approved, '');
  await waitFor(retry, 'Codex saved the authorization');
  await waitFor(base + '?connection=timing', 'Signed in on this Codex worker');
  const old = pinnedProjectMcp(project, await loadProjectMcp(db, project, 'timing', 1));
  const edit = base + '?connection=timing';
  assert.equal((await post(edit, { ...draft, name: 'Timing OAuth revised', version: '1' })).status, 303);
  const sameAuthorization = pinnedProjectMcp(project, await loadProjectMcp(db, project, 'timing', 2));
  assert.equal(sameAuthorization.server, old.server);
  assert.equal((await post(edit, { ...draft, scopes: 'timing:write', version: '2' })).status, 303);
  const differentAuthorization = pinnedProjectMcp(project, await loadProjectMcp(db, project, 'timing', 3));
  assert.notEqual(differentAuthorization.server, old.server);
});
