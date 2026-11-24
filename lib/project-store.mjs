import { CrewError, id, requireField } from './contracts.mjs';
import { transaction } from './database.mjs';
import { workflowBriefInput, workflowRequestImageSteps } from './workflow-intake.mjs';
import { usesPublishedWorkspace } from './workflow-workspace.mjs';

export async function registerProject(db, snapshot, { expectedVersion, retrySameSnapshot = false } = {}) {
  const { project, sourceCommit } = snapshot;
  const key = [project.id, project.epic.id];
  const data = JSON.stringify({ ...snapshot, files: [...snapshot.files] });
  return transaction(db, async client => {
    await client.query('SELECT pg_advisory_xact_lock(710923814, hashtext($1))', [key.join('/')]);
    const { rows: [latest] } = await client.query(`
      SELECT version, snapshot::jsonb = $3::jsonb AS unchanged FROM engineering_crew.project_versions
      WHERE project_id = $1 AND epic_id = $2 ORDER BY version DESC LIMIT 1`, [...key, data]);
    const current = latest?.version ?? 0;
    if (expectedVersion !== undefined && expectedVersion !== current &&
        !(retrySameSnapshot && current === expectedVersion + 1 && latest?.unchanged))
      throw new CrewError('The workflow version changed. Reload the editor before saving.', 3);
    if (latest?.unchanged) return latest.version;
    const version = current + 1;
    await client.query(`
      INSERT INTO engineering_crew.project_versions (project_id, epic_id, version, source_commit, snapshot)
      VALUES ($1, $2, $3, $4, $5)`, [...key, version, sourceCommit, data]);
    return version;
  });
}

export async function listRegisteredWorkflows(db, projectId = null, { allVersions = false } = {}) {
  if (projectId !== null) id(projectId, 'project ID');
  const { rows } = await db.query(`
    SELECT ${allVersions ? '' : 'DISTINCT ON (project_id, epic_id)'} project_id AS "projectId", epic_id AS id, version,
      snapshot#>>'{project,name}' AS "projectName", snapshot#>>'{project,crewName}' AS "crewName",
      snapshot#>>'{project,epic,title}' AS title, snapshot#>>'{project,epic,goal}' AS goal,
      snapshot->'project' AS definition
    FROM engineering_crew.project_versions WHERE ($1::text IS NULL OR project_id = $1)
    ORDER BY project_id, epic_id, version DESC`, [projectId]);
  return rows.map(({ definition, ...workflow }) => ({ ...workflow, acceptsRequests: Boolean(workflowBriefInput(definition)),
    usesPublishedWorkspace: usesPublishedWorkspace(definition),
    requestImageSteps: workflowRequestImageSteps(definition).map(({ title }) => title) }));
}

export async function listWorkflowAgentAssignments(db, projectId, agentId) {
  const { rows } = await db.query(`
    SELECT p.epic_id AS "workflowId", p.version AS "workflowVersion", p.snapshot#>>'{project,epic,title}' AS title,
      (origin->>'version')::integer AS "agentVersion", array_agg(step->>'title' ORDER BY position) AS steps
    FROM engineering_crew.project_versions p
    CROSS JOIN LATERAL json_array_elements(p.snapshot#>'{project,tasks}') WITH ORDINALITY AS tasks(step, position)
    CROSS JOIN LATERAL (SELECT p.snapshot->'agentOrigins'->(step->>'profileId') AS origin) AS pinned
    WHERE p.project_id=$1 AND origin->>'agentId'=$2
    GROUP BY p.epic_id, p.version, title, "agentVersion"
    ORDER BY p.epic_id, p.version DESC, "agentVersion" DESC`, [projectId, agentId]);
  return rows;
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
