import { once } from 'node:events';
import { CrewError } from './contracts.mjs';
import { queuedWorkflowRuns, runStore } from './run-store.mjs';
import { dispatchNext } from './workflow.mjs';
import { runWorkflowSetupCheck } from './workflow-setup.mjs';

const dispatchLockNamespace = 710923823;

export async function workflowWorkerConnected(db, projectId) {
  const { rows: [row] } = await db.query(`SELECT EXISTS (
    SELECT 1 FROM pg_locks WHERE locktype='advisory' AND granted AND objsubid=2
      AND database=(SELECT oid FROM pg_database WHERE datname=current_database())
      AND classid::bigint=$1 AND objid::bigint=(hashtext($2)::bigint & 4294967295)
  ) AS connected`, [dispatchLockNamespace, projectId]);
  return row.connected;
}

export async function runWorkflowWorker(db, projectId, signal, { onReady, ...options } = {}) {
  const client = await db.connect();
  const connection = new AbortController();
  const lost = () => connection.abort();
  client.on('error', lost);
  client.on('end', lost);
  let locked = false;
  try {
    const { rows: [row] } = await client.query('SELECT pg_try_advisory_lock($1, hashtext($2)) AS locked', [dispatchLockNamespace, projectId]);
    locked = row.locked;
    if (!locked) throw new CrewError('A dispatch worker is already connected for this project.', 3);
    const stop = AbortSignal.any([signal, connection.signal]);
    if (stop.aborted) return;
    const stopScheduler = startWorkflowScheduler(db, projectId, options);
    try {
      onReady?.();
      if (!stop.aborted) await once(stop, 'abort');
    } finally {
      // In-flight attempts have their own connections and can finish under their existing ownership.
      await stopScheduler({ drain: true });
    }
    if (connection.signal.aborted) throw new CrewError('The dispatch worker lost its Postgres connection.', 3);
  } finally {
    if (locked && !connection.signal.aborted) {
      try { await client.query('SELECT pg_advisory_unlock($1, hashtext($2))', [dispatchLockNamespace, projectId]); }
      catch { lost(); }
    }
    client.off('error', lost);
    client.off('end', lost);
    client.release(connection.signal.aborted);
  }
}

export function reportWorkflowDispatchError(_error, runId) {
  process.stderr.write(runId ? `Could not advance workflow ${runId}.\n` : 'Could not poll for queued workflows.\n');
}

export function startWorkflowScheduler(db, projectId, { repo, onError = () => {}, concurrency = 3, intervalMs = 1000, execute } = {}) {
  const stop = new AbortController();
  const stopSetup = new AbortController();
  const starting = new Set();
  const active = new Set();
  let timer, polling, setup;
  let stopping = false;

  async function poll() {
    try {
      if (projectId === 'music-transcribe' && !setup && !stopping)
        setup = runWorkflowSetupCheck(db, projectId, repo, stopSetup.signal)
          .catch(error => { if (!stopSetup.signal.aborted) onError(error); })
          .finally(() => { setup = undefined; });
      const slots = concurrency - active.size;
      if (slots <= 0) return;
      const ids = await queuedWorkflowRuns(db, projectId, [...starting], slots);
      for (const id of ids) {
        if (stopping) break;
        starting.add(id);
        let claiming = true;
        const claimed = () => {
          if (claiming) starting.delete(id);
          claiming = false;
        };
        const job = dispatchNext(runStore(db, id), stop.signal, claimed, execute, db, { repo })
          .catch(error => { if (!stop.signal.aborted) onError(error, id); })
          .finally(() => { claimed(); active.delete(job); });
        active.add(job);
      }
    } catch (error) {
      if (!stop.signal.aborted) onError(error);
    } finally {
      if (!stopping) timer = setTimeout(() => { polling = poll(); }, intervalMs);
    }
  }

  polling = poll();
  return async ({ drain = false } = {}) => {
    stopping = true;
    stopSetup.abort();
    if (!drain) stop.abort();
    clearTimeout(timer);
    await polling;
    await Promise.allSettled([...active, setup]);
  };
}
