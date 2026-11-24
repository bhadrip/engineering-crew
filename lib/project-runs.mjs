import { id } from './contracts.mjs';
import { listFeatures } from './feature-controller.mjs';
import { observeRunWorkers } from './run-store.mjs';
import { summarize } from './workflow.mjs';

export const projectRunTypes = Object.freeze({ all: 'All runs', agent: 'Direct agent', 'agent-draft': 'Agent draft test',
  workflow: 'Workflow', draft: 'Draft test', legacy: 'Legacy request' });
const pageSize = 20;

export function projectRunFilters(params) {
  const requested = params.get('type');
  const type = Object.hasOwn(projectRunTypes, requested) ? requested : 'all';
  const query = (params.get('q') ?? '').replaceAll('\0', '').trim().slice(0, 160).toWellFormed();
  const requestedPage = params.get('page');
  const offset = /^[1-9]\d*$/.test(requestedPage) ? (Number(requestedPage) - 1) * pageSize : 0;
  const page = Number.isSafeInteger(offset) && offset >= 0 && offset % pageSize === 0 ? offset / pageSize + 1 : 1;
  return { type, query, page };
}

async function readRuns(db, projectId, ids) {
  if (!ids.length) return [];
  const { rows } = await db.query('SELECT record FROM engineering_crew.runs WHERE project_id=$1 AND id=ANY($2::text[])', [projectId, ids]);
  return (await observeRunWorkers(db, rows.map(row => row.record))).map(run => summarize(run));
}

export async function projectRuns(db, projectId, { type, query, page }) {
  id(projectId, 'project ID');
  const words = query ? query.split(/\s+/) : [];
  const { rows } = await db.query(`WITH entries AS (
      SELECT r.id, CASE WHEN r.record#>'{agentRun,draft}' IS NOT NULL THEN 'agent-draft'
          WHEN r.record->'agentRun' IS NOT NULL THEN 'agent'
          WHEN r.record->'workflowTest' IS NOT NULL THEN 'draft' ELSE 'workflow' END AS kind,
        r.record->>'startedAt' AS created,
        concat_ws(' ', r.id, r.epic_id, r.record#>>'{epic,title}', r.record#>>'{agentRun,preview}', r.record#>>'{agentRun,agentId}',
          r.record#>>'{agentRun,draft,baseAgentId}',
          r.record#>>'{workflowRequest,title}', r.record->>'sourceCommit',
          (SELECT string_agg(profile->>'name', ' ') FROM json_array_elements(r.record->'profiles') AS pinned(profile))) AS searchable
      FROM engineering_crew.runs r WHERE r.project_id=$1
      UNION ALL
      SELECT f.id, 'legacy', f.record->>'createdAt', concat_ws(' ', f.id, replace(f.id, '-', ' '), f.record->>'goal', f.record->>'revision')
      FROM engineering_crew.features f WHERE f.project_id=$1
    ), selected AS (
      SELECT id, kind, created FROM entries WHERE ($2='all' OR kind=$2)
        AND NOT EXISTS (SELECT 1 FROM unnest($3::text[]) AS words(word) WHERE strpos(lower(searchable), lower(word))=0)
      ORDER BY created DESC NULLS LAST, id DESC, kind DESC OFFSET $4 LIMIT $5
    ) SELECT selected.id, selected.kind, call.seq AS "callSeq" FROM selected
    LEFT JOIN LATERAL (
      SELECT e.seq FROM engineering_crew.feature_events e
      JOIN engineering_crew.feature_call_inputs i ON i.feature_id=e.feature_id AND i.digest=CASE e.event->>'type'
        WHEN 'agent.started' THEN e.event#>>'{evidence,inputDigest}'
        WHEN 'agent.completed' THEN e.event#>>'{evidence,inputDigest}'
        WHEN 'task.completed' THEN e.event#>>'{evidence,receipt,inputDigest}' END
      WHERE selected.kind='legacy' AND e.feature_id=selected.id
      ORDER BY e.seq DESC LIMIT 1
    ) call ON true
    ORDER BY selected.created DESC NULLS LAST, selected.id DESC, selected.kind DESC`,
  [projectId, type, words, (page - 1) * pageSize, pageSize + 1]);
  const choices = rows.slice(0, pageSize);
  const legacyIds = choices.filter(row => row.kind === 'legacy').map(row => row.id);
  const [runs, legacy] = await Promise.all([readRuns(db, projectId, choices.filter(row => row.kind !== 'legacy').map(row => row.id)),
    legacyIds.length ? listFeatures(db, projectId, legacyIds) : []]);
  const nativeById = new Map(runs.map(run => [run.id, run]));
  const legacyById = new Map(legacy.map(run => [run.id, run]));
  return { entries: choices.flatMap(({ id, kind, callSeq }) => {
    const run = (kind === 'legacy' ? legacyById : nativeById).get(id);
    return run ? [{ kind, run, callSeq }] : [];
  }), hasOlder: rows.length > pageSize };
}
