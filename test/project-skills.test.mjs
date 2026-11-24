import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentRun, agentRunTask } from '../lib/agent-run.mjs';
import { saveReusableAgent } from '../lib/agent-library.mjs';
import { listProjectSkills, loadProjectSkill, saveProjectSkill } from '../lib/project-skills.mjs';
import { loadProject, registerProject } from '../lib/project-store.mjs';
import { runStore } from '../lib/run-store.mjs';
import { buildWorkflowSnapshot } from '../lib/workflow-editor.mjs';
import { decide, dispatch, findArtifact, prepareWorkflowRun, summarize } from '../lib/workflow.mjs';
import { postgres, testDatabase } from '../test-support/stores.mjs';

test('project skills pin manifests and resources independently of later skill and agent revisions', { skip: !postgres }, async t => {
  const { db } = await testDatabase(t);
  const project = { id: 'music-transcribe', name: 'Music Transcribe' };
  const content = '---\nname: lesson-evidence\ndescription: Review lesson evidence\n---\nRead the independent checks.';
  const data = Buffer.from('Compare observed song boundaries.').toString('base64');
  const definition = { name: 'Lesson evidence', content, bundle: { directory: 'lesson-evidence',
    files: [{ path: 'references/checks.md', data }] } };
  const first = await saveProjectSkill(db, project.id, { expectedVersion: 0, skill: definition });
  const refs = [{ id: first.id, version: 1 }];
  const role = { projectId: project.id, name: 'Lesson reviewer', remit: 'Review audio checks.', model: '',
    instructions: 'Use the assigned rubric.', skills: [], projectSkills: refs,
    runtime: { workspace: 'read-only', webSearch: 'disabled', reasoningEffort: '' } };
  const agent = await saveReusableAgent(db, role);
  await saveReusableAgent(db, { ...role, name: 'Second reviewer' });
  const workflowId = 'lesson-evidence-review';
  const build = skillSelection => buildWorkflowSnapshot(db, { project, workflowId, sourceCommit: 'a'.repeat(40), draft: {
    title: 'Lesson evidence review', goal: 'Review evidence from the lesson.', brief: 'Review the lesson.',
    steps: [{ id: 'review', title: 'Review the lesson', objective: 'Review the recorded result.', owner: 'Project owner',
      agent: 'library:' + agent.id + ':1', skillSelections: [skillSelection], prerequisites: [], inputs: ['brief'], acceptance: 'Report observed evidence.' }],
  } });
  await assert.rejects(build(agent.id + '-v2/1'), /assigned agent version/);
  const snapshot = await build(agent.id + '-v1/1');
  await registerProject(db, snapshot);
  const changed = { ...definition, content: content + '\nReport the tested revision.' };
  const second = await saveProjectSkill(db, project.id, { id: first.id, expectedVersion: 1, skill: changed });
  assert.equal(second.version, 2);
  assert.deepEqual((await listProjectSkills(db, project.id))[0].versions, [2, 1]);
  await assert.rejects(saveProjectSkill(db, project.id, { id: first.id, expectedVersion: 1, skill: definition }), /skill changed/);
  await assert.rejects(loadProjectSkill(db, 'other-project', first.id, 1), /unavailable in this project/);
  await assert.rejects(saveReusableAgent(db, { ...role, shared: true }), /owned by this project/);
  await assert.rejects(saveReusableAgent(db, { ...role, projectSkills: [{ id: first.id, version: 3 }] }), /unavailable/);
  await saveReusableAgent(db, { ...role, id: agent.id, expectedVersion: 1, projectSkills: [{ id: first.id, version: 2 }] });
  const workflow = await loadProject(db, project.id, workflowId, 1);
  const workflowRun = await prepareWorkflowRun(db, workflow, 'lesson-review-after-skill-edit');
  const [workflowSkill] = workflowRun.profiles[0].skillIds;
  assert.deepEqual(workflowRun.tasks[0].packet.invokeSkills, [1]);
  assert.equal(findArtifact(workflowRun, workflowSkill).content, content);
  assert.equal(findArtifact(workflowRun, workflowSkill).provenance.version, 1);
  const workflowStore = runStore(db, workflowRun.id);
  await workflowStore.create(workflowRun);
  const reply = { state: 'completed', summary: 'Reviewed.', outputs: [{ slot: 'result', content: 'Observed evidence.' }],
    decisions: [], questions: [], blockers: [] };
  const lackingReceipt = await dispatch(workflowStore, 'review', undefined, undefined, async job => {
    assert.deepEqual(job.invokeSkills, [1]);
    assert.deepEqual(job.attempt.skillInputs, [{ artifactId: workflowSkill, digest: findArtifact(workflowRun, workflowSkill).digest,
      projectSkill: { id: first.id, version: 1 } }]);
    return { outcome: 'completed', receipt: { usage: null }, response: reply };
  });
  assert.equal(summarize(await workflowStore.read()).tasks[0].attempts[0].evidenceStatus, 'missing');
  await assert.rejects(decide(workflowStore, 'review', lackingReceipt.id, 'accepted', 'Check skill evidence.'), /evidence/);

  const runId = 'agent-run-eeff00112233445566778899aabbccdd';
  const params = { project, agent, runId, sourceCommit: 'a'.repeat(40), prompt: 'Review this lesson.', reference: '' };
  await assert.rejects(createAgentRun(db, { ...params, invokeSkills: [2] }), /attached to this agent/);
  await createAgentRun(db, { ...params, invokeSkills: [1] });
  await assert.rejects(createAgentRun(db, params), /already submitted/);
  const store = runStore(db, runId);
  const run = await store.read();
  const profile = run.profiles[0];
  assert.equal(findArtifact(run, profile.skillIds[0]).content, content);
  assert.deepEqual(findArtifact(run, profile.skillIds[0]).provenance,
    { source: 'project-skill', skillId: first.id, version: 1, agentId: agent.id, agentVersion: 1 });
  assert.equal(findArtifact(run, profile.skillBundles[0].files[0].artifactId).content, data);
  const attempt = await dispatch(store, agentRunTask, undefined, undefined, async job => {
    assert.deepEqual(job.invokeSkills, [1]);
    assert.equal(job.instructions[1], content);
    return { outcome: 'completed', receipt: { usage: null, explicitSkills: job.attempt.skillInputs }, response: reply };
  });
  assert.equal(attempt.outcome, 'completed', attempt.error);
});
