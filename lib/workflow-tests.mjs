import { CrewError, requireField } from './contracts.mjs';
import { artifact, artifactDigest, runStore } from './run-store.mjs';
import { registerProject } from './project-store.mjs';
import { findArtifact, prepareWorkflowRun } from './workflow.mjs';

export const workflowTestRunId = /^workflow-test-[a-f0-9]{32}$/;

export async function listWorkflowTests(db, projectId, workflowId = null) {
  const { rows } = await db.query(`SELECT id, epic_id AS "workflowId", record#>>'{epic,title}' AS title,
    record->>'startedAt' AS "startedAt", (record#>>'{workflowTest,baseVersion}')::integer AS "baseVersion"
    FROM engineering_crew.runs WHERE project_id=$1 AND ($2::text IS NULL OR epic_id=$2) AND record->'workflowTest' IS NOT NULL
    ORDER BY record->>'startedAt' DESC, id DESC LIMIT 20`, [projectId, workflowId]);
  return rows;
}

export async function createWorkflowTest(db, { runId, projectId, workflowId, baseVersion, draft, build }) {
  requireField(projectId === 'music-transcribe' && workflowTestRunId.test(runId), 'Open the Music Transcribe workflow editor to create a draft test.');
  const requestDigest = artifactDigest(JSON.stringify({ projectId, workflowId, baseVersion, draft }));
  const store = runStore(db, runId);
  const replay = run => {
    if (run.project.id !== projectId || run.epic.id !== workflowId || run.workflowTest?.requestDigest !== requestDigest)
      throw new CrewError('This test was already submitted with different settings. Open the workflow editor to start another test.', 3);
  };
  const existing = await store.read().catch(error => {
    if (!(error instanceof CrewError) || error.code !== 4) throw error;
  });
  if (existing) return replay(existing);
  const snapshot = await build();
  requireField(snapshot.project.id === projectId && snapshot.project.epic.id === workflowId,
    'The draft test does not match the workflow version in the editor.');
  const definition = artifact('workflow-test-snapshot', 'Tested workflow snapshot', 'json', JSON.stringify({ ...snapshot, files: [...snapshot.files] }),
    { source: 'workflow-test', sourceCommit: snapshot.sourceCommit, baseVersion, runId });
  const run = await prepareWorkflowRun(db, snapshot, runId, {
    workflowTest: { baseVersion, requestDigest, snapshotId: definition.id, snapshotDigest: definition.digest },
  });
  run.artifacts.push(definition);
  try { await store.create(run); }
  catch (error) {
    if (!(error instanceof CrewError) || error.code !== 3) throw error;
    replay(await store.read());
  }
}

export async function loadWorkflowTestSnapshot(db, runId, projectId) {
  const run = await runStore(db, runId).read();
  const test = run.workflowTest;
  requireField(projectId === 'music-transcribe' && run.project.id === projectId && test && workflowTestRunId.test(runId),
    'Choose a Music Transcribe draft test.');
  const record = findArtifact(run, test.snapshotId);
  requireField(record.digest === test.snapshotDigest && record.provenance.source === 'workflow-test' && record.provenance.runId === runId,
    'The tested snapshot does not match the saved run.');
  const snapshot = JSON.parse(record.content);
  requireField(snapshot.project.id === projectId && snapshot.project.epic.id === run.epic.id && snapshot.sourceCommit === run.sourceCommit,
    'The tested snapshot does not match this workflow.');
  return { snapshot: { ...snapshot, files: new Map(snapshot.files) }, workflowId: run.epic.id, baseVersion: test.baseVersion };
}

export async function saveWorkflowTest(db, runId, projectId) {
  const { snapshot, workflowId, baseVersion } = await loadWorkflowTestSnapshot(db, runId, projectId);
  const version = await registerProject(db, snapshot, { expectedVersion: baseVersion, retrySameSnapshot: true });
  return { workflowId, version };
}
