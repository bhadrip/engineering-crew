import pg from 'pg';
import { CrewError, requireField } from './contracts.mjs';

const schema = `
  CREATE SCHEMA IF NOT EXISTS engineering_crew;
  CREATE TABLE IF NOT EXISTS engineering_crew.schema_version (
    version integer PRIMARY KEY
  );
  CREATE TABLE engineering_crew.project_versions (
    project_id text NOT NULL,
    epic_id text NOT NULL,
    version integer NOT NULL CHECK (version > 0),
    source_commit text NOT NULL,
    snapshot json NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, epic_id, version)
  );
  CREATE TABLE engineering_crew.runs (
    id text PRIMARY KEY,
    project_id text NOT NULL,
    epic_id text NOT NULL,
    configuration_version integer,
    revision bigint NOT NULL DEFAULT 1,
    record json NOT NULL,
    import_digest text,
    FOREIGN KEY (project_id, epic_id, configuration_version)
      REFERENCES engineering_crew.project_versions (project_id, epic_id, version)
  );
  CREATE TABLE engineering_crew.provisioners (
    project_id text NOT NULL,
    action text NOT NULL,
    target text NOT NULL,
    command json NOT NULL,
    PRIMARY KEY (project_id, action, target)
  );
  INSERT INTO engineering_crew.schema_version VALUES (1);
`;

export async function transaction(pool, callback) {
  const client = await pool.connect();
  let discard = false;
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); }
    catch { discard = true; }
    throw error;
  } finally {
    client.release(discard);
  }
}

export async function openDatabase(connectionString = process.env.CREW_DATABASE_URL) {
  if (!connectionString) throw new CrewError('Set CREW_DATABASE_URL to the customer Postgres connection URL', 2);
  requireField(URL.canParse(connectionString) && ['postgres:', 'postgresql:'].includes(new URL(connectionString).protocol),
    'CREW_DATABASE_URL must be a Postgres connection URL');
  const pool = new pg.Pool({ connectionString, connectionTimeoutMillis: 5_000, allowExitOnIdle: true });
  // An idle connection can be lost independently of a command. The pool replaces it on demand.
  pool.on('error', () => {});
  const readVersion = async client => {
    const { rows: [table] } = await client.query("SELECT to_regclass('engineering_crew.schema_version') AS name");
    if (!table.name) return null;
    const { rows } = await client.query('SELECT max(version) AS version FROM engineering_crew.schema_version');
    return rows[0].version;
  };
  try {
    const version = await readVersion(pool) ?? await transaction(pool, async client => {
      await client.query('SELECT pg_advisory_xact_lock(710923814, 0)');
      const current = await readVersion(client);
      if (current !== null) return current;
      await client.query(schema);
      return 1;
    });
    if (version !== 1) throw new CrewError('This Crew version cannot open the Postgres schema');
    return pool;
  } catch (error) {
    await pool.end();
    if (error instanceof CrewError) throw error;
    throw new CrewError('Could not connect to Postgres or initialize the Crew schema. Check the connection and schema permissions.');
  }
}
