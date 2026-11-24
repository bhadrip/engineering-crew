import { createHash, randomUUID } from 'node:crypto';
import { CrewError, id } from './contracts.mjs';
import { currentAttempt } from './attempts.mjs';
import { clientTransaction, transaction } from './database.mjs';

const workerLockNamespace = 710923820;

export async function observeRunWorkers(db, runs) {
  const running = run => run.tasks.map(currentAttempt).filter(attempt => attempt?.outcome === 'running' && attempt.workerId);
  const workerIds = new Set(runs.flatMap(run => running(run).map(attempt => attempt.workerId)));
  if (!workerIds.size) return runs;
  const { rows } = await db.query(`
    SELECT DISTINCT worker.id FROM unnest($2::text[]) AS worker(id)
    JOIN pg_locks AS held ON held.locktype = 'advisory' AND held.granted AND held.objsubid = 2
      AND held.database = (SELECT oid FROM pg_database WHERE datname = current_database())
      AND held.classid::bigint = $1 AND held.objid::bigint = (hashtext(worker.id)::bigint & 4294967295)`,
    [workerLockNamespace, [...workerIds]]);
  const active = new Set(rows.map(({ id }) => id));
  const staleCandidates = runs.filter(run => running(run).some(attempt => !active.has(attempt.workerId)));
  const refreshed = new Map();
  if (staleCandidates.length) {
    // A worker commits its result before releasing its lock. Read after the lock check
    // to distinguish that transition from a worker that left an attempt running.
    const { rows } = await db.query('SELECT id, record FROM engineering_crew.runs WHERE id = ANY($1::text[])',
      [staleCandidates.map(run => run.id)]);
    for (const { id, record } of rows) refreshed.set(id, record);
  }
  return runs.map(run => {
    const current = refreshed.get(run.id) ?? run;
    for (const attempt of running(current)) {
      if (workerIds.has(attempt.workerId)) attempt.workerStatus = active.has(attempt.workerId) ? 'connected' : 'disconnected';
    }
    return current;
  });
}

export const artifactDigest = content => createHash('sha256').update(content).digest('hex');

export function artifact(id, title, kind, content, provenance) {
  return { id, title, kind, digest: artifactDigest(content), provenance, content };
}

export async function listRuns(db) {
  const { rows } = await db.query("SELECT record FROM engineering_crew.runs WHERE record->'agentRun' IS NULL AND record->'workflowTest' IS NULL");
  return rows.map(row => row.record);
}

export async function queuedWorkflowRuns(db, projectId, exclude, limit) {
  const { rows } = await db.query(`SELECT id FROM engineering_crew.runs
    WHERE project_id = $1 AND record #>> '{automation,pending}' = 'true' AND id <> ALL($2::text[])
    ORDER BY id LIMIT $3`, [projectId, exclude, limit]);
  return rows.map(row => row.id);
}

export async function listWorkflowRequests(db, projectId) {
  const { rows } = await db.query(`SELECT record FROM engineering_crew.runs
    WHERE project_id=$1 AND record->'workflowRequest' IS NOT NULL`, [projectId]);
  return observeRunWorkers(db, rows.map(row => row.record));
}

export async function findWorkflowRequest(db, projectId, runId) {
  const { rows: [request] } = await db.query(`SELECT id, epic_id AS "workflowId", record#>>'{triage,status}' AS triage
    FROM engineering_crew.runs WHERE project_id=$1 AND id=$2 AND record->'workflowRequest' IS NOT NULL`, [projectId, runId]);
  return request;
}

export async function findPublishedWorkspaceRun(db, projectId, runId = null) {
  const { rows: [row] } = await db.query(`SELECT record FROM engineering_crew.runs
    WHERE project_id=$1 AND ($2::text IS NULL OR id=$2) AND record->'workspaceDelivery' IS NOT NULL AND record->'workflowTest' IS NULL
    ORDER BY record#>>'{workspaceDelivery,publishedAt}' DESC, id DESC LIMIT 1`, [projectId, runId]);
  return row?.record;
}

export async function insertRun(db, record, importDigest = null) {
  const values = [id(record.id, 'run ID'), record.project.id, record.epic?.id ?? record.id,
    record.project.configurationVersion ?? null, JSON.stringify(record), importDigest];
  const { rowCount } = await db.query(`
    INSERT INTO engineering_crew.runs (id, project_id, epic_id, configuration_version, record, import_digest)
    VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING`, values);
  if (!rowCount) throw new CrewError(`Run ${record.id} already exists`, 3);
}

export function runStore(db, runId) {
  id(runId, 'run ID');

  async function read(client = db, lock = false) {
    const { rows: [row] } = await client.query(
      `SELECT record FROM engineering_crew.runs WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [runId]);
    if (!row) throw new CrewError(`Run ${runId} does not exist`, 4);
    return row.record;
  }

  async function update(client, callback) {
    const record = await read(client, true);
    const workerStopped = async workerId => {
      const { rows: [row] } = await client.query('SELECT pg_try_advisory_xact_lock($1, hashtext($2)) AS stopped',
        [workerLockNamespace, workerId]);
      return row.stopped;
    };
    const result = await callback(record, workerStopped);
    await client.query('UPDATE engineering_crew.runs SET record = $2, revision = revision + 1 WHERE id = $1',
      [runId, JSON.stringify(record)]);
    return result;
  }

  return {
    read: () => read(),
    forClient: (client, onBroken) => ({ read: () => read(client),
      update: callback => clientTransaction(client, () => update(client, callback), onBroken) }),
    create: record => {
      if (record.id !== runId) throw new CrewError('Run record does not match its ID');
      return insertRun(db, record);
    },
    update: callback => transaction(db, client => update(client, callback)),
    async withWorker(callback) {
      // The same connection holds the worker lock and writes its attempts.
      const client = await db.connect();
      const workerId = randomUUID();
      const connection = new AbortController();
      const lost = () => connection.abort(new CrewError('The workflow worker lost its Postgres connection.', 3));
      client.on('error', lost);
      client.on('end', lost);
      let locked = false;
      let closed = false;
      let pending = Promise.resolve();
      function enqueue(call) {
        if (closed) return Promise.reject(new CrewError('This workflow worker has finished.', 3));
        const work = pending.then(() => {
          connection.signal.throwIfAborted();
          return call();
        });
        pending = work.catch(() => {});
        return work;
      }
      try {
        const { rows: [row] } = await client.query('SELECT pg_try_advisory_lock($1, hashtext($2)) AS locked', [workerLockNamespace, workerId]);
        locked = row.locked;
        if (!locked) throw new CrewError('Could not reserve a workflow worker. Try dispatching again.', 3);
        const workerStore = { workerId, read: () => enqueue(() => read(client)),
          update: callback => enqueue(() => clientTransaction(client, () => update(client, callback), lost)) };
        return await callback(workerStore, connection.signal);
      } finally {
        closed = true;
        await pending;
        if (locked && !connection.signal.aborted) {
          try { await client.query('SELECT pg_advisory_unlock($1, hashtext($2))', [workerLockNamespace, workerId]); }
          catch { lost(); }
        }
        client.off('error', lost);
        client.off('end', lost);
        client.release(connection.signal.aborted);
      }
    },
  };
}
