import { createHash } from 'node:crypto';
import { CrewError, id } from './contracts.mjs';
import { transaction } from './database.mjs';

export const artifactDigest = content => createHash('sha256').update(content).digest('hex');

export function artifact(id, title, kind, content, provenance) {
  return { id, title, kind, digest: artifactDigest(content), provenance, content };
}

export async function listRuns(db) {
  const { rows } = await db.query('SELECT record FROM engineering_crew.runs');
  return rows.map(row => row.record);
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

  return {
    read: () => read(),
    create: record => {
      if (record.id !== runId) throw new CrewError('Run record does not match its ID');
      return insertRun(db, record);
    },
    update: callback => transaction(db, async client => {
      const record = await read(client, true);
      const result = await callback(record);
      await client.query('UPDATE engineering_crew.runs SET record = $2, revision = revision + 1 WHERE id = $1',
        [runId, JSON.stringify(record)]);
      return result;
    }),
  };
}
