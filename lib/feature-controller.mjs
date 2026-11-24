import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { CrewError, id, requireField, text } from './contracts.mjs';
import { transaction } from './database.mjs';

export const featureLimits = Object.freeze({ maxAttempts: 3, maxMinutes: 45 });
const reviewers = ['qa', 'reviewer', 'security'];
const lockNamespace = 710923815;
export const featureExportLock = 710923817;
const terminal = status => status === 'completed' || status === 'blocked';
const now = () => new Date().toISOString();

function journalEvent(record, seq, type, { role = 'controller', parents = [], evidence = {}, operationId = null, predecessor } = {}) {
  return { featureId: record.id, seq, at: now(), type, status: record.status, phase: record.phase,
    attempt: record.attempt, revision: record.revision, role, parents, evidence, operationId, ...(predecessor ? { predecessor } : {}) };
}

export async function createFeature(db, { projectId, goal, repoPath, id: featureId = randomUUID() }) {
  id(projectId, 'project ID');
  id(featureId, 'feature ID');
  text(goal, 'feature goal', 12_000);
  let path = null;
  if (repoPath != null) {
    text(repoPath, 'repository path', 4096);
    try { path = await realpath(resolve(repoPath)); }
    catch { throw new CrewError('The supplied local repository path does not exist'); }
  }
  await transaction(db, async client => {
    await client.query('INSERT INTO engineering_crew.feature_projects (id, repo_path) VALUES ($1, $2) ON CONFLICT DO NOTHING', [projectId, path]);
    const { rows: [project] } = await client.query('SELECT repo_path FROM engineering_crew.feature_projects WHERE id = $1', [projectId]);
    requireField(project && (!path || project.repo_path === path), 'This project or repository already has a different local binding');
    const record = { id: featureId, projectId, repoPath: project.repo_path, goal: goal.trim(), status: 'queued', phase: 'plan',
      attempt: 0, revision: null, limits: featureLimits, createdAt: now(), startedAt: null, deadlineAt: null, endedAt: null, reason: null };
    const { rowCount } = await client.query(`INSERT INTO engineering_crew.features (id, project_id, record, last_seq)
      VALUES ($1, $2, $3, 1) ON CONFLICT (id) DO NOTHING`, [featureId, projectId, record]);
    if (!rowCount) throw new CrewError(`Feature ${featureId} already exists`, 3);
    await client.query('INSERT INTO engineering_crew.feature_events (feature_id, seq, event) VALUES ($1, 1, $2)',
      [featureId, journalEvent(record, 1, 'request.created', { evidence: { goal: record.goal } })]);
  });
  return getFeature(db, featureId);
}

// Match PostgreSQL's two-int advisory-lock representation. A disconnected worker releases its lock automatically.
const heldLockSQL = (namespace, key) => `EXISTS (
  SELECT 1 FROM pg_locks l WHERE l.locktype='advisory' AND l.granted AND l.objsubid=2
  AND l.database=(SELECT oid FROM pg_database WHERE datname=current_database())
  AND l.classid=${namespace}::oid AND l.objid=(hashtext(${key})::bigint & 4294967295)::oid)`;
const canResumeSQL = `f.record->>'status' IN ('queued', 'running') AND NOT ${heldLockSQL(lockNamespace, 'f.project_id')}`;
const exportingSQL = `CASE WHEN f.record#>>'{langfuseExport,status}' = 'pending'
  THEN ${heldLockSQL(featureExportLock, 'f.id')} ELSE false END`;

// Allow a just-completed worker to acquire the export lock. After the grace
// period, a missing session lock means there is no exporter to finish the pending job.
function observedExport(state, locked) {
  if (!state) return {};
  if (state.status === 'pending' && !locked && Date.now() - Date.parse(state.updatedAt) >= 30_000) {
    return { langfuseExport: { status: 'failed', updatedAt: state.updatedAt, message: 'The receipt exporter stopped before verification.' } };
  }
  return { langfuseExport: state };
}

export async function listFeatures(db, projectId, ids = null) {
  if (projectId != null) id(projectId, 'project ID');
  const { rows } = await db.query(`SELECT f.record, (${canResumeSQL}) AS available, (${exportingSQL}) AS exporting FROM engineering_crew.features f
    WHERE ($1::text IS NULL OR f.project_id=$1) AND ($2::text[] IS NULL OR f.id=ANY($2))
    ORDER BY f.created_at DESC, f.id`, [projectId ?? null, ids]);
  return rows.map(({ record, available, exporting }) => ({ ...record, ...observedExport(record.langfuseExport, exporting), canResume: available }));
}

export async function readFeatureEvents(db, featureId, after = 0) {
  id(featureId, 'feature ID');
  requireField(Number.isSafeInteger(after) && after >= 0, 'Event cursor must be a nonnegative integer');
  const { rows: [row] } = await db.query(`SELECT f.record->>'status' AS status, f.record->>'previewStatus' AS preview_status, f.last_seq,
      f.record->'langfuseExport' AS export_state, (${exportingSQL}) AS exporting,
      (SELECT jsonb_agg(p.event ORDER BY p.seq) FROM (SELECT e.seq, e.event FROM engineering_crew.feature_events e
        WHERE e.feature_id=f.id AND e.seq>$2 ORDER BY e.seq LIMIT 200) p) AS events
    FROM engineering_crew.features f WHERE f.id=$1`, [featureId, after]);
  if (!row) throw new CrewError(`Feature ${featureId} does not exist`, 4);
  requireField(after <= row.last_seq, 'Event cursor is ahead of this request');
  return { status: row.status, ...(row.preview_status ? { previewStatus: row.preview_status } : {}),
    ...observedExport(row.export_state, row.exporting), lastSeq: row.last_seq, events: row.events ?? [] };
}

export async function getFeature(db, featureId) {
  id(featureId, 'feature ID');
  const { rows: [row] } = await db.query(`SELECT f.record, (${canResumeSQL}) AS available, (${exportingSQL}) AS exporting,
    (SELECT jsonb_agg(e.event ORDER BY e.seq) FROM engineering_crew.feature_events e WHERE e.feature_id=f.id) AS events
    FROM engineering_crew.features f WHERE f.id=$1`, [featureId]);
  if (!row) throw new CrewError(`Feature ${featureId} does not exist`, 4);
  return { ...row.record, ...observedExport(row.record.langfuseExport, row.exporting), events: row.events, canResume: row.available };
}

// Large call payloads stay out of the live journal, polling responses and trace exporter.
export async function readFeatureCall(db, featureId, seq) {
  id(featureId, 'feature ID');
  requireField(Number.isSafeInteger(seq) && seq > 0 && seq <= 2147483647, 'Expected a positive call event number');
  const { rows: [row] } = await db.query(`WITH selected AS (
    SELECT feature_id, CASE event->>'type'
      WHEN 'agent.started' THEN event->'evidence' WHEN 'agent.completed' THEN event->'evidence'
      WHEN 'task.completed' THEN event#>'{evidence,receipt}' END AS receipt
    FROM engineering_crew.feature_events WHERE feature_id=$1 AND seq=$2
  ) SELECT i.digest, i.prompt_sha256, i.prompt, i.config, o.digest AS output_digest, o.raw
    FROM selected s LEFT JOIN engineering_crew.feature_call_inputs i
      ON i.feature_id=s.feature_id AND i.digest=s.receipt->>'inputDigest'
    LEFT JOIN engineering_crew.feature_call_outputs o ON o.feature_id=i.feature_id
      AND o.input_digest=i.digest AND o.call_id=s.receipt->>'callId'`, [featureId, seq]);
  if (!row) throw new CrewError('Request or call event does not exist', 4);
  return {
    input: row.digest ? { digest: row.digest, promptSha256: row.prompt_sha256, prompt: row.prompt.toString('utf8'), config: row.config } : null,
    output: row.output_digest ? { digest: row.output_digest, raw: row.raw.toString('utf8') } : null,
  };
}

// Accept either a pool or the preview manager's checked-out client. The revision and parent are read in
// one snapshot; compare-and-swap on last_seq prevents concurrent health observations appending duplicates.
export async function recordFeaturePreview(db, featureId, { url, revision, image, container }) {
  id(featureId, 'feature ID');
  requireField(typeof url === 'string' && /^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(url) && URL.canParse(url)
    && Number(new URL(url).port || 80) > 0, 'Preview needs a loopback HTTP endpoint');
  requireField(typeof image === 'string' && /^sha256:[a-f0-9]{64}$/.test(image), 'Preview needs a pinned image ID');
  requireField(typeof container === 'string' && /^[a-zA-Z0-9][\w.:-]{0,127}$/.test(container), 'Invalid preview container identity');
  text(revision, 'preview revision', 256);
  return savePreviewOutcome(db, featureId, 'ready', { url, revision, image, container });
}

export async function recordFeaturePreviewFailure(db, featureId, detail) {
  id(featureId, 'feature ID');
  const message = text(typeof detail === 'string' ? detail : detail?.message, 'preview failure detail', 4000);
  return savePreviewOutcome(db, featureId, 'failed', { message });
}

async function savePreviewOutcome(db, featureId, status, details) {
  const type = 'app.preview.' + status;
  while (true) {
    const { rows: [row] } = await db.query(`SELECT f.record, f.last_seq,
      (SELECT e.seq FROM engineering_crew.feature_events e WHERE e.feature_id=f.id
       AND e.event->>'type'='request.completed' AND e.event->'evidence'->>'revision'=f.record->'delivery'->>'revision') AS parent,
      (SELECT e.event FROM engineering_crew.feature_events e WHERE e.feature_id=f.id
       AND e.event->>'type' IN ('app.preview.ready','app.preview.failed') ORDER BY e.seq DESC LIMIT 1) AS latest
      FROM engineering_crew.features f WHERE f.id=$1`, [featureId]);
    if (!row) throw new CrewError(`Feature ${featureId} does not exist`, 4);
    const revision = row.record.delivery?.revision;
    requireField(row.record.status === 'completed' && revision && (!details.revision || details.revision === revision) && row.parent,
      'Preview must match a completed feature delivery');
    requireField(!details.image || !row.record.candidate?.image || row.record.candidate.image === details.image, 'Preview image differs from the verified candidate');
    const evidence = { ...details, revision };
    if (row.latest?.type === type && isDeepStrictEqual(row.latest.evidence, evidence)) return row.latest;
    const event = journalEvent({ ...row.record, phase: 'preview' }, row.last_seq + 1, type, { parents: [row.parent], evidence });
    const { rowCount } = await db.query(`WITH changed AS (
      UPDATE engineering_crew.features SET last_seq=last_seq+1, record=jsonb_set(record,'{previewStatus}',to_jsonb($4::text))
        WHERE id=$1 AND last_seq=$2 RETURNING id, last_seq
    ) INSERT INTO engineering_crew.feature_events (feature_id, seq, event) SELECT id, last_seq, $3 FROM changed`,
    [featureId, row.last_seq, event, status]);
    if (rowCount) return event;
  }
}

// Keep state changes and the exact journal entry that explains them in the same SQL statement.
async function persist(client, record, event, artifact) {
  const args = [record.id, record, event.seq, event];
  let capture = '';
  if (artifact?.input && event.type === 'agent.started') {
    const { digest, promptSha256, prompt, config } = artifact.input;
    requireField(digest === event.evidence.inputDigest, 'The recorded call input does not match the receipt');
    args.push(digest, promptSha256, Buffer.from(prompt), config);
    capture = `, captured AS (INSERT INTO engineering_crew.feature_call_inputs (feature_id,digest,prompt_sha256,prompt,config)
      SELECT id,$5,$6,$7,$8 FROM changed ON CONFLICT (feature_id,digest) DO NOTHING)`;
  } else if (artifact?.output && event.type === 'agent.completed') {
    const { digest, raw } = artifact.output;
    requireField(digest === event.evidence.outputDigest, 'The recorded call output does not match the receipt');
    args.push(event.evidence.callId, event.evidence.inputDigest, digest, Buffer.from(raw));
    capture = `, captured AS (INSERT INTO engineering_crew.feature_call_outputs (feature_id,call_id,input_digest,digest,raw)
      SELECT id,$5,$6,$7,$8 FROM changed)`;
  }
  const { rowCount } = await client.query(`WITH changed AS (
    UPDATE engineering_crew.features SET record=$2, last_seq=$3 WHERE id=$1 AND last_seq=$3::int-1 RETURNING id, last_seq
  )${capture} INSERT INTO engineering_crew.feature_events (feature_id, seq, event) SELECT id, last_seq, $4 FROM changed`, args);
  if (!rowCount) throw new CrewError('The feature journal changed while the worker was running');
}

async function findDeliveredBase(client, projectId, featureId, base) {
  if (typeof base !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(base)) return;
  const { rows } = await client.query(`SELECT f.id, e.seq FROM engineering_crew.features f
    JOIN engineering_crew.feature_events e ON e.feature_id=f.id
    WHERE f.project_id=$1 AND f.id<>$2 AND f.record->>'status'='completed'
      AND f.record->'delivery'->>'revision'=$3 AND e.event->>'type'='request.completed'
      AND e.event->'evidence'->>'revision'=$3 LIMIT 2`, [projectId, featureId, base]);
  if (rows.length === 1) return { featureId: rows[0].id, revision: base, eventSeq: rows[0].seq };
}

export async function runFeature(db, featureId, { runtime, signal, autoPreview = false, autoTraceProject } = {}) {
  const before = await getFeature(db, featureId);
  if (terminal(before.status)) return before;
  requireField(runtime && ['plan', 'build', 'verify', 'promote'].every(k => typeof runtime[k] === 'function'), 'A feature runtime is required');
  const client = await db.connect();
  const connection = new AbortController();
  const lost = () => connection.abort(new CrewError('Lost the local feature database connection'));
  client.on('error', lost);
  let locked = false;
  let discard = false;
  try {
    const { rows: [row] } = await client.query('SELECT pg_try_advisory_lock($1, hashtext($2)) AS acquired', [lockNamespace, before.projectId]);
    locked = row.acquired;
    if (!locked) throw new CrewError(`A worker is active for project ${before.projectId}`, 3);
    const record = await getFeature(client, featureId);
    const activeSignal = signal ? AbortSignal.any([signal, connection.signal]) : connection.signal;
    await advanceFeature(record, runtime, (next, event, artifact) => persist(client, next, event, artifact), activeSignal,
      { autoPreview, autoTraceProject, findPredecessor: base => findDeliveredBase(client, record.projectId, featureId, base) });
  } finally {
    if (locked) {
      try { await client.query('SELECT pg_advisory_unlock($1, hashtext($2))', [lockNamespace, before.projectId]); }
      catch { discard = true; }
    }
    client.off('error', lost);
    client.release(discard || connection.signal.aborted);
  }
  return getFeature(db, featureId);
}

// One owner holds the project lock. Verification roles may finish concurrently, so serialize journal commits.
// persistEntry must atomically save both arguments before resolving. Nonterminal records can be replayed after a crash.
export async function advanceFeature(snapshot, runtime, persistEntry, externalSignal, { autoPreview, autoTraceProject, findPredecessor } = {}) {
  const { events: history, canResume: _available, ...initial } = snapshot;
  const events = [...history];
  let record = initial;
  let pending = Promise.resolve();
  const append = (type, metadata, changes = {}, artifact) => {
    const write = pending.then(async () => {
      const next = { ...record, ...changes };
      const event = journalEvent(next, events.length + 1, type, metadata);
      await persistEntry(next, event, artifact);
      record = next;
      events.push(event);
      return event;
    });
    pending = write;
    return write;
  };
  if (terminal(record.status)) return snapshot;
  externalSignal?.throwIfAborted();
  if (!record.startedAt) {
    const startedAt = now();
    await append('request.started', { parents: [1] }, { status: 'running', startedAt, ...(autoPreview ? { previewRequested: true } : {}),
      deadlineAt: new Date(Date.parse(startedAt) + record.limits.maxMinutes * 60_000).toISOString() });
  }
  const timeLeft = Date.parse(record.deadlineAt) - Date.now();
  const deadline = new AbortController();
  const expired = () => deadline.abort(new CrewError('The 45-minute request deadline expired'));
  if (timeLeft <= 0) expired();
  const timer = setTimeout(expired, Math.max(0, timeLeft));
  timer.unref();
  const signal = externalSignal ? AbortSignal.any([externalSignal, deadline.signal]) : deadline.signal;
  const assertTime = () => {
    if (Date.now() >= Date.parse(record.deadlineAt)) expired();
    signal.throwIfAborted();
  };
  const finish = (status, parents, evidence, changes) => {
    const endedAt = now();
    const trace = typeof autoTraceProject === 'string' && autoTraceProject === record.projectId
      ? { langfuseExport: { status: 'pending', updatedAt: endedAt } } : {};
    return append('request.' + status, { parents, evidence: { ...evidence, ...trace } }, { status, endedAt, ...changes, ...trace });
  };
  const block = (reason, parents) => finish('blocked', parents, { message: reason }, { reason });

  async function step(phase, role, attempt, parent, context) {
    const operationId = `${record.id}:${role}:${attempt}`;
    const operationEvents = events.filter(e => e.operationId === operationId);
    const prior = operationEvents.find(e => ['task.completed', 'task.failed'].includes(e.type));
    if (prior) return prior;
    assertTime();
    let last = operationEvents.at(-1);
    const original = last;
    const base = { role, operationId };
    // A lost build worker already consumed its attempt; repeating it would bypass the request budget.
    if (original && phase === 'build') return append('task.failed', { ...base, parents: [original.seq],
      evidence: { message: 'The build worker stopped before recording a candidate' } });
    last = await append(original ? 'task.resumed' : 'task.started', { ...base, parents: [last?.seq ?? parent] },
      { phase, attempt, ...(phase === 'build' ? { revision: null } : {}) });
    let activity = Promise.resolve();
    let accepting = true;
    const onEvent = (item, artifact) => {
      if (!accepting || signal.aborted) return Promise.resolve();
      activity = activity.then(async () => {
        const valid = typeof item?.type === 'string' && /^(agent|tool|app|check|runtime|workspace)\.[\w.-]{1,80}$/.test(item.type);
        last = await append(valid ? item.type : 'agent.activity', { ...base, parents: [last.seq], evidence: item?.evidence ?? {} }, {}, artifact);
      });
      return activity;
    };
    let result;
    let failure;
    try {
      result = await runtime[phase]({ featureId: record.id, projectId: record.projectId, repoPath: record.repoPath,
        goal: record.goal, plan: record.plan, candidate: context.candidate ?? null, revision: context.candidate?.revision ?? null,
        feedback: context.feedback ?? [], role, attempt, operationId, signal, onEvent });
      requireField(result && typeof result === 'object' && !Array.isArray(result), `The ${role} returned no evidence`);
      if (phase === 'plan') requireField(result.plan && (typeof result.plan !== 'string' || result.plan.trim()), 'Planner returned no plan');
      if (phase === 'build') text(result.revision, 'candidate revision', 256);
      if (phase === 'verify') {
        requireField(typeof result.passed === 'boolean', `${role} returned no verdict`);
        requireField(result.revision === undefined || result.revision === context.candidate.revision, `${role} reviewed a different revision`);
      }
      if (phase === 'promote') requireField(result.revision === context.candidate.revision, 'Delivery receipt refers to a different revision');
    } catch (error) {
      failure = String(error?.message || 'Runtime execution failed').slice(0, 4000);
    } finally {
      accepting = false;
      await activity;
    }
    // A shutdown is resumable, with no invented terminal verdict. Connection loss also prevents a stale worker committing.
    externalSignal?.throwIfAborted();
    // Delivery may have committed immediately before the deadline; its durable receipt is the authoritative outcome.
    if (phase !== 'promote' || failure) assertTime();
    if (failure) return append('task.failed', { ...base, parents: [last.seq], evidence: { message: failure } });
    const changes = {};
    let predecessor;
    if (phase === 'plan') {
      changes.plan = result.plan;
      predecessor = await findPredecessor?.(result.plan.base);
      if (predecessor) changes.predecessor = predecessor;
    }
    if (phase === 'build') Object.assign(changes, { candidate: result, revision: result.revision });
    if (phase === 'promote') changes.delivery = result;
    return append('task.completed', { ...base, parents: [last.seq], evidence: result, predecessor }, changes);
  }

  try {
    const started = events.find(e => e.type === 'request.started');
    const plan = await step('plan', 'planner', 0, started.seq, {});
    if (plan.type === 'task.failed') {
      await block(plan.evidence.message, [plan.seq]);
    } else {
      let parent = plan.seq;
      let feedback = [];
      let previousCandidate = null;
      for (let attempt = 1; attempt <= record.limits.maxAttempts; attempt++) {
        const build = await step('build', 'engineer', attempt, parent, { feedback, candidate: previousCandidate });
        let failures;
        let checks;
        if (build.type === 'task.failed') {
          failures = checks = [build];
        } else {
          const candidate = build.evidence;
          previousCandidate = candidate;
          // Settle all roles before releasing the project lock, including on shutdown or deadline expiry.
          const outcomes = await Promise.allSettled(reviewers.map(role => step('verify', role, attempt, build.seq, { candidate })));
          const interrupted = outcomes.find(outcome => outcome.status === 'rejected');
          if (interrupted) throw interrupted.reason;
          checks = outcomes.map(outcome => outcome.value);
          failures = checks.filter(e => e.type === 'task.failed' || !e.evidence.passed);
          if (!failures.length) {
            let verified = events.find(e => e.type === 'candidate.verified' && e.attempt === attempt);
            if (!verified) verified = await append('candidate.verified', { parents: checks.map(e => e.seq), evidence: { revision: candidate.revision } });
            const delivery = await step('promote', 'controller', attempt, verified.seq, { candidate });
            if (delivery.type === 'task.failed') await block(delivery.evidence.message, [delivery.seq]);
            else {
              const preview = autoPreview || record.previewRequested ? { previewStatus: 'pending' } : {};
              await finish('completed', [delivery.seq], { revision: candidate.revision, ...preview }, preview);
            }
            break;
          }
        }
        const findings = failures.map(e => ({ role: e.role, ...e.evidence }));
        // When a repair produces no new candidate, the prior revision's findings still apply.
        feedback = build.type === 'task.failed' ? [...feedback, ...findings] : findings;
        if (attempt === record.limits.maxAttempts) {
          await block('The initial implementation and two repair attempts did not pass all required checks', checks.map(e => e.seq));
          break;
        }
        let repair = events.find(e => e.type === 'repair.requested' && e.attempt === attempt);
        if (!repair) repair = await append('repair.requested', { parents: checks.map(e => e.seq), evidence: { feedback } });
        parent = repair.seq;
      }
    }
  } catch (error) {
    if (externalSignal?.aborted || !deadline.signal.aborted) throw error;
    await block(deadline.signal.reason.message, [events.at(-1).seq]);
  } finally {
    clearTimeout(timer);
  }
  return { ...record, events, canResume: !terminal(record.status) };
}
