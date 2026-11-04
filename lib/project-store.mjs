import { CrewError, id, requireField } from './contracts.mjs';
import { transaction } from './database.mjs';

export async function registerProject(db, snapshot) {
  const { project, sourceCommit } = snapshot;
  const key = [project.id, project.epic.id];
  const data = JSON.stringify({ ...snapshot, files: [...snapshot.files] });
  return transaction(db, async client => {
    await client.query('SELECT pg_advisory_xact_lock(710923814, hashtext($1))', [key.join('/')]);
    const { rows: [latest] } = await client.query(`
      SELECT version, snapshot::text AS snapshot FROM engineering_crew.project_versions
      WHERE project_id = $1 AND epic_id = $2 ORDER BY version DESC LIMIT 1`, key);
    if (latest?.snapshot === data) return latest.version;
    const version = (latest?.version ?? 0) + 1;
    await client.query(`
      INSERT INTO engineering_crew.project_versions (project_id, epic_id, version, source_commit, snapshot)
      VALUES ($1, $2, $3, $4, $5)`, [...key, version, sourceCommit, data]);
    return version;
  });
}

export async function loadProject(db, projectId, epicId, version) {
  id(projectId, 'project ID');
  id(epicId, 'epic ID');
  requireField(version === undefined || (Number.isInteger(version) && version > 0 && version <= 2147483647),
    'Specify a positive configuration version');
  const { rows: [row] } = await db.query(`
    SELECT version, snapshot FROM engineering_crew.project_versions
    WHERE project_id = $1 AND epic_id = $2 AND ($3::integer IS NULL OR version = $3)
    ORDER BY version DESC LIMIT 1`, [projectId, epicId, version]);
  if (!row) throw new CrewError(`No configuration found for ${projectId}/${epicId}${version ? ` version ${version}` : ''}`, 4);
  return { ...row.snapshot, files: new Map(row.snapshot.files), version: row.version };
}

export async function listProjectVersions(db, projectId, epicId) {
  id(projectId, 'project ID');
  id(epicId, 'epic ID');
  const { rows } = await db.query(`
    SELECT version, source_commit AS "sourceCommit", created_at AS "createdAt"
    FROM engineering_crew.project_versions WHERE project_id = $1 AND epic_id = $2 ORDER BY version DESC`,
  [projectId, epicId]);
  return rows;
}
