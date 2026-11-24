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

const featureSchema = `
  CREATE TABLE engineering_crew.feature_projects (
    id text PRIMARY KEY,
    repo_path text UNIQUE
  );
  CREATE TABLE engineering_crew.features (
    id text PRIMARY KEY,
    project_id text NOT NULL REFERENCES engineering_crew.feature_projects (id),
    record jsonb NOT NULL,
    last_seq integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX features_project_created ON engineering_crew.features (project_id, created_at);
  CREATE TABLE engineering_crew.feature_events (
    feature_id text NOT NULL REFERENCES engineering_crew.features (id),
    seq integer NOT NULL CHECK (seq > 0),
    event jsonb NOT NULL,
    PRIMARY KEY (feature_id, seq)
  );
  INSERT INTO engineering_crew.schema_version VALUES (2);
`;

const callSchema = `
  CREATE TABLE engineering_crew.feature_call_inputs (
    feature_id text NOT NULL REFERENCES engineering_crew.features (id) ON DELETE CASCADE,
    digest text NOT NULL, prompt_sha256 text NOT NULL, prompt bytea NOT NULL, config json NOT NULL,
    PRIMARY KEY (feature_id, digest)
  );
  CREATE TABLE engineering_crew.feature_call_outputs (
    feature_id text NOT NULL, call_id text NOT NULL, input_digest text NOT NULL, digest text NOT NULL, raw bytea NOT NULL,
    PRIMARY KEY (feature_id, call_id),
    FOREIGN KEY (feature_id, input_digest) REFERENCES engineering_crew.feature_call_inputs (feature_id, digest) ON DELETE CASCADE
  );
  INSERT INTO engineering_crew.schema_version VALUES (3);
`;

const agentLibrarySchema = `
  CREATE TABLE engineering_crew.agent_versions (
    agent_id text NOT NULL,
    version integer NOT NULL CHECK (version > 0),
    definition jsonb NOT NULL,
    PRIMARY KEY (agent_id, version)
  );
  INSERT INTO engineering_crew.schema_version VALUES (4);
`;

const mcpConnectionsSchema = `
  CREATE TABLE engineering_crew.mcp_connection_versions (
    project_id text NOT NULL,
    connection_id text NOT NULL,
    version integer NOT NULL CHECK (version > 0),
    definition jsonb NOT NULL,
    PRIMARY KEY (project_id, connection_id, version)
  );
  INSERT INTO engineering_crew.schema_version VALUES (5);
`;

const workflowDispatchSchema = `
  CREATE INDEX pending_workflow_runs ON engineering_crew.runs (project_id, id)
    WHERE record #>> '{automation,pending}' = 'true';
  INSERT INTO engineering_crew.schema_version VALUES (6);
`;

const projectSkillsSchema = `
  CREATE TABLE engineering_crew.project_skill_versions (
    project_id text NOT NULL,
    skill_id text NOT NULL,
    version integer NOT NULL CHECK (version > 0),
    definition jsonb NOT NULL,
    PRIMARY KEY (project_id, skill_id, version)
  );
  INSERT INTO engineering_crew.schema_version VALUES (7);
`;

const workflowSetupSchema = `
  CREATE TABLE engineering_crew.workflow_setup_checks (
    project_id text NOT NULL,
    epic_id text NOT NULL,
    version integer NOT NULL,
    requested_at timestamptz NOT NULL DEFAULT now(),
    lease_id uuid,
    started_at timestamptz,
    completed_at timestamptz,
    result jsonb,
    PRIMARY KEY (project_id, epic_id, version),
    FOREIGN KEY (project_id, epic_id, version) REFERENCES engineering_crew.project_versions (project_id, epic_id, version)
  );
  INSERT INTO engineering_crew.schema_version VALUES (8);
`;

export async function clientTransaction(client, callback, onBroken) {
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); }
    catch { onBroken(); }
    throw error;
  }
}

export async function transaction(pool, callback) {
  const client = await pool.connect();
  let discard = false;
  try {
    return await clientTransaction(client, callback, () => { discard = true; });
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
    const version = await readVersion(pool);
    if (version !== 8) await transaction(pool, async client => {
      await client.query('SELECT pg_advisory_xact_lock(710923814, 0)');
      const current = await readVersion(client);
      if (current === 8) return;
      if (![null, 1, 2, 3, 4, 5, 6, 7].includes(current)) throw new CrewError('This Crew version cannot open the Postgres schema');
      if (current === null) await client.query(schema);
      if ((current ?? 0) < 2) await client.query(featureSchema);
      if ((current ?? 0) < 3) await client.query(callSchema);
      if ((current ?? 0) < 4) await client.query(agentLibrarySchema);
      if ((current ?? 0) < 5) await client.query(mcpConnectionsSchema);
      if ((current ?? 0) < 6) await client.query(workflowDispatchSchema);
      if ((current ?? 0) < 7) await client.query(projectSkillsSchema);
      await client.query(workflowSetupSchema);
    });
    return pool;
  } catch (error) {
    await pool.end();
    if (error instanceof CrewError) throw error;
    throw new CrewError('Could not connect to Postgres or initialize the Crew schema. Check the connection and schema permissions.');
  }
}
