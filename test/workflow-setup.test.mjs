import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { saveReusableAgent } from '../lib/agent-library.mjs';
import { registerProject } from '../lib/project-store.mjs';
import { buildWorkflowSnapshot } from '../lib/workflow-editor.mjs';
import { runWorkflowWorker } from '../lib/workflow-scheduler.mjs';
import { readWorkflowSetup, requestWorkflowSetup } from '../lib/workflow-setup.mjs';
import { postgres, testDatabase } from '../test-support/stores.mjs';

test('the dispatch worker checks the pinned workflow revision and reports unavailable settings without dispatching', {
  skip: !postgres, timeout: 15_000,
}, async t => {
  const { db } = await testDatabase(t);
  const directory = await mkdtemp(join(tmpdir(), 'crew-worker-setup-test-'));
  const path = process.env.PATH;
  t.after(async () => { process.env.PATH = path; await rm(directory, { recursive: true, force: true }); });
  await writeFile(join(directory, 'codex'), `#!/usr/bin/env node
const {createInterface}=require('node:readline');
if(process.argv[2]==='plugin'){
  process.stdout.write(JSON.stringify({installed:[]}));
}else{
  const send=(id,result)=>process.stdout.write(JSON.stringify({id,result})+'\\n');
  createInterface({input:process.stdin}).on('line', line=>{
    const {id,method}=JSON.parse(line);
    if(method==='initialize')send(id,{userAgent:'codex-fixture'});
    if(method==='model/list')send(id,{data:[{model:'fixture-model',isDefault:true,additionalSpeedTiers:['priority']}],nextCursor:null});
    if(method==='turn/start')process.exit(5);
  });
}`, { mode: 0o700 });
  process.env.PATH = directory + delimiter + path;
  const project = { id: 'music-transcribe', name: 'Music Transcribe' };
  const workflowId = 'worker-setup';
  const shared = { projectId: project.id, name: 'Music coach', remit: 'Review the lesson.', instructions: 'Read the brief.', skills: [] };
  const runtime = { workspace: 'read-only', webSearch: 'disabled', reasoningEffort: 'medium' };
  const first = await saveReusableAgent(db, { ...shared, model: 'fixture-model',
    runtime: { ...runtime, serviceTier: 'ultrafast', plugins: ['missing@crew-fixture'] } });
  const second = await saveReusableAgent(db, { ...shared, id: first.id, expectedVersion: first.version, model: 'fixture-model',
    runtime: { ...runtime, serviceTier: 'priority' } });
  const save = async agent => registerProject(db, await buildWorkflowSnapshot(db, { project, workflowId, sourceCommit: 'a'.repeat(40),
    draft: { title: 'Worker setup', goal: 'Review a lesson.', brief: 'Review the full phrase.', steps: [
      { id: 'review', title: 'Review the lesson', owner: 'Owner', objective: 'Review the full phrase.', inputs: ['brief'], prerequisites: [],
        agent: `library:${agent.id}:${agent.version}` },
    ] } }));
  assert.equal(await save(first), 1);
  assert.equal(await save(second), 2);
  await requestWorkflowSetup(db, project.id, workflowId, 1);
  const queued = await readWorkflowSetup(db, project.id, workflowId, 1);
  assert.equal(queued.startedAt, null);
  await requestWorkflowSetup(db, project.id, workflowId, 1);
  assert.deepEqual(await readWorkflowSetup(db, project.id, workflowId, 1), queued);
  const stop = new AbortController();
  const errors = [];
  const worker = runWorkflowWorker(db, project.id, AbortSignal.any([stop.signal, t.signal]), {
    intervalMs: 20, repo: directory, execute: () => assert.fail('Setup must not dispatch a turn'), onError: error => errors.push(error),
  });
  const completed = async version => {
    for (let i = 0; i < 150; i++) {
      const check = await readWorkflowSetup(db, project.id, workflowId, version);
      if (check?.completedAt) return check.result;
      await delay(20, undefined, { signal: t.signal });
    }
    assert.fail(errors[0]?.message ?? 'Worker did not record the setup check');
  };
  try {
    const checked = await completed(1);
    assert.deepEqual(checked.profiles[0].checks.map(({ label, state }) => [label, state]), [
      ['fixture-model', 'ready'], ['Ultrafast', 'attention'], ['missing@crew-fixture', 'attention'],
    ]);
    assert.equal(await readWorkflowSetup(db, project.id, workflowId, 2), undefined);
    await requestWorkflowSetup(db, project.id, workflowId, 2);
    assert.deepEqual((await completed(2)).profiles[0].checks.map(({ label, state }) => [label, state]), [
      ['fixture-model', 'ready'], ['Fast', 'ready'],
    ]);
    assert.deepEqual(await completed(1), checked);
    assert.equal((await db.query('SELECT count(*) FROM engineering_crew.runs')).rows[0].count, '0');
    assert.deepEqual(errors, []);
  } finally {
    stop.abort();
    await worker;
  }
});
