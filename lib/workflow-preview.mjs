import { execFile } from 'node:child_process';
import { realpath, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import { CrewError, requireField } from './contracts.mjs';
import { startFeaturePreview, stopFeaturePreview } from './feature-app.mjs';
import { findPublishedWorkspaceRun, runStore } from './run-store.mjs';
import { publishedWorkspace } from './workflow.mjs';
import { materializeWorkspaceFiles } from './workflow-workspace.mjs';

const exec = promisify(execFile);
const namespace = 710923822;

async function stopRecordedPreview(preview) {
  if (!preview?.container) return;
  try { await stopFeaturePreview(preview); }
  catch { throw new CrewError('Could not stop the recorded local app. Check that Docker is running and try again.', 3); }
}

async function withPreviewLock(db, runId, signal, work) {
  const store = runStore(db, runId);
  const client = await db.connect();
  const connection = new AbortController();
  const lost = () => connection.abort(new CrewError('The preview worker lost its database connection.', 3));
  client.on('error', lost);
  client.on('end', lost);
  let locked = false;
  try {
    const { rows: [lock] } = await client.query('SELECT pg_try_advisory_lock($1, hashtext($2)) AS locked', [namespace, runId]);
    locked = lock.locked;
    if (!locked) throw new CrewError('A local preview action is already in progress for this run.', 3);
    return await work(store.forClient(client, lost), signal ? AbortSignal.any([signal, connection.signal]) : connection.signal, connection.signal, client);
  } finally {
    if (locked && !connection.signal.aborted) {
      try { await client.query('SELECT pg_advisory_unlock($1, hashtext($2))', [namespace, runId]); }
      catch { lost(); }
    }
    client.off('error', lost);
    client.off('end', lost);
    client.release(connection.signal.aborted);
  }
}

async function healthyPreview(preview, delivery, signal) {
  const { candidate, projectId, deliveryDigest } = delivery;
  if (preview?.status !== 'running' || preview.deliveryDigest !== deliveryDigest ||
      !/^http:\/\/127\.0\.0\.1:\d+$/.test(preview.url) || !/^crew-app-[a-f0-9]{32}$/.test(preview.container)) return false;
  try {
    const options = { timeout: 4000, signal };
    const { stdout } = await exec('docker', ['inspect', '--format', '{{.State.Running}} {{.Image}} {{index .Config.Labels "crew.project"}} {{index .Config.Labels "crew.revision"}}', preview.container], options);
    if (stdout.trim() !== `true ${candidate.image} ${projectId} ${candidate.workspace.digest}`) return false;
    const port = await exec('docker', ['port', preview.container + '-http', '3000/tcp'], options);
    if ('http://' + port.stdout.trim() !== preview.url) return false;
    const response = await fetch(preview.url + '/health', { redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]) });
    await response.body?.cancel();
    return response.ok;
  } catch { return false; }
}

export function openWorkspacePreview(db, repo, runId, signal) {
  return withPreviewLock(db, runId, signal, async (store, active, connection, client) => {
    active.throwIfAborted();
    const run = await store.read();
    const delivery = publishedWorkspace(run);
    const { candidate, projectId, files, deliveryDigest } = delivery;
    const prior = run.workspacePreview;
    if (await healthyPreview(prior, delivery, active)) return prior;
    active.throwIfAborted();
    await stopRecordedPreview(prior);
    const localRepo = await realpath(repo);
    const scope = id => 'workflow-delivery\n' + localRepo + '\n' + id;
    const base = projectId === 'music-transcribe' && run.workspaceDeliveryBase;
    let inheritLessons;
    if (base) {
      const source = await findPublishedWorkspaceRun(client, projectId, base.sourceRunId);
      requireField(source && source.id !== runId && publishedWorkspace(source).deliveryDigest === base.deliveryDigest,
        'The previous delivery could not be verified for lesson carryover.');
      inheritLessons = { runId: source.id, scope: scope(source.id) };
    }
    const directory = await materializeWorkspaceFiles(files, active);
    let starting, live;
    try {
      live = await startFeaturePreview({ projectId, image: candidate.image, revision: candidate.workspace.digest,
        dataScope: scope(runId), inheritLessons,
        snapshotDirectory: directory, signal: active, onStarting: state => {
          starting = { ...state, deliveryDigest, status: 'starting', startedAt: new Date().toISOString() };
          return store.update(current => { active.throwIfAborted(); current.workspacePreview = starting; });
        } });
      const ready = { ...starting, url: live.url, status: 'running', readyAt: new Date().toISOString(),
        ...(live.lessonLibrary && { lessonLibrary: live.lessonLibrary }) };
      await store.update(current => {
        active.throwIfAborted();
        requireField(current.workspaceDelivery?.digest === deliveryDigest, 'The published delivery changed before its preview was ready.');
        current.workspacePreview = ready;
      });
      return ready;
    } catch (error) {
      if (live) await live.stop().catch(() => {});
      else await rm(directory, { recursive: true, force: true }).catch(() => {});
      const message = String(error?.message ?? 'Could not open the delivered workspace.').slice(0, 800);
      if (!connection.aborted) await store.update(current => {
        current.workspacePreview = { ...starting, deliveryDigest, status: 'failed', error: message };
      }).catch(() => {});
      throw new CrewError(message, 3);
    }
  });
}

export function stopWorkspacePreview(db, runId, signal) {
  return withPreviewLock(db, runId, signal, async (store, active) => {
    active.throwIfAborted();
    const run = await store.read();
    requireField(run.workspaceDelivery, 'This workflow run has no local delivery.');
    await stopRecordedPreview(run.workspacePreview);
    const lessonLibrary = run.workspacePreview?.lessonLibrary;
    const preview = { status: 'stopped', deliveryDigest: run.workspaceDelivery.digest, stoppedAt: new Date().toISOString(),
      ...(lessonLibrary && { lessonLibrary }) };
    await store.update(current => { active.throwIfAborted(); current.workspacePreview = preview; });
    return preview;
  });
}
