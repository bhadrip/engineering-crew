import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { CrewError, requireField } from './contracts.mjs';
import { transaction } from './database.mjs';
import { skillLimits } from './feature-profiles.mjs';
import { validateWorkflowSkills } from './workflow-skills.mjs';

export const projectSkillsEnabled = projectId => projectId === 'music-transcribe';
export const validProjectSkillId = value => typeof value === 'string' && /^skill-[a-f0-9]{32}$/.test(value);
const versionLimit = 10_000;
const validVersion = value => Number.isInteger(value) && value >= 1 && value <= versionLimit;

export function parseProjectSkillRefs(values) {
  return values.filter(Boolean).map(value => {
    const match = /^(skill-[a-f0-9]{32}):([1-9]\d{0,4})$/.exec(value);
    if (!match || !validVersion(Number(match[2]))) throw new CrewError('Choose a saved project skill version.', 2);
    return { id: match[1], version: Number(match[2]) };
  });
}

export async function listProjectSkills(db, projectId) {
  const { rows } = await db.query(`SELECT DISTINCT ON (skill_id) skill_id AS id, version, definition->>'name' AS name,
    array_agg(version) OVER (PARTITION BY skill_id ORDER BY version DESC
      ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS versions
    FROM engineering_crew.project_skill_versions WHERE project_id=$1 ORDER BY skill_id, version DESC`, [projectId]);
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

export async function loadProjectSkill(db, projectId, id, version) {
  requireField(validProjectSkillId(id) && (version === undefined || validVersion(version)), 'Choose a saved project skill version.');
  const { rows: [skill] } = await db.query(`SELECT skill_id AS id, version, definition
    FROM engineering_crew.project_skill_versions WHERE project_id=$1 AND skill_id=$2 AND ($3::int IS NULL OR version=$3)
    ORDER BY version DESC LIMIT 1`, [projectId, id, version]);
  if (!skill) throw new CrewError('This skill version is unavailable in this project.', 4);
  return skill;
}

export async function saveProjectSkill(db, projectId, { id = 'skill-' + randomUUID().replaceAll('-', ''), expectedVersion, skill }) {
  requireField(validProjectSkillId(id) && (expectedVersion === 0 || validVersion(expectedVersion)), 'Choose a valid skill version.');
  const [definition] = validateWorkflowSkills([skill]);
  return transaction(db, async client => {
    await client.query("SELECT pg_advisory_xact_lock(710923824, hashtext($1 || ':' || $2))", [projectId, id]);
    const { rows: [latest] } = await client.query(`SELECT version, definition FROM engineering_crew.project_skill_versions
      WHERE project_id=$1 AND skill_id=$2 ORDER BY version DESC LIMIT 1`, [projectId, id]);
    const current = latest?.version ?? 0;
    if (current !== expectedVersion) throw new CrewError('The skill changed. Reload the editor before saving.', 3);
    if (isDeepStrictEqual(latest?.definition, definition)) return { id, version: current, definition };
    requireField(current < versionLimit, 'This skill reached its revision limit.');
    const version = current + 1;
    await client.query('INSERT INTO engineering_crew.project_skill_versions (project_id,skill_id,version,definition) VALUES ($1,$2,$3,$4)',
      [projectId, id, version, definition]);
    return { id, version, definition };
  });
}

export async function attachProjectSkills(db, projectId, refs) {
  requireField(Array.isArray(refs) && refs.length <= skillLimits.count &&
    refs.every(ref => validProjectSkillId(ref?.id) && validVersion(ref.version)) &&
    new Set(refs.map(ref => ref?.id)).size === refs.length, 'Choose one version per project skill.');
  return Promise.all(refs.map(async ({ id, version }) => {
    try { return await loadProjectSkill(db, projectId, id, version); }
    catch (error) {
      if (error instanceof CrewError && error.code === 4) throw new CrewError(error.message, 2);
      throw error;
    }
  }));
}
