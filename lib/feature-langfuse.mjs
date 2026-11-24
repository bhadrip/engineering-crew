import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { CrewError, id, requireField } from './contracts.mjs';
import { featureExportLock, getFeature } from './feature-controller.mjs';
import { featureCalls } from './feature-usage.mjs';
import { langfuseConfig, publishObservedSpans, verifiedTraceLink } from './langfuse.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const threadIdPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const phases = { planner: 'plan', engineer: 'build', qa: 'verify', security: 'verify', reviewer: 'verify' };
const nano = milliseconds => String(BigInt(milliseconds) * 1_000_000n);
const attribute = (key, value) => ({ key, value: { stringValue: value } });
const validModel = value => typeof value === 'string' && /^[A-Za-z0-9._:/-]{1,120}$/.test(value);
const workspaceActions = new Set(['list', 'read', 'edit', 'test', 'finish']);
const qaChecks = new Set(['Author tests', 'Independent QA tests', 'HTTP /health', 'Operator acceptance test']);

// JSONB object key order is immaterial to a receipt's identity.
function digest(value) {
  return sha(JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item));
}

// Export only Crew's fixed check names and verdicts. Test output, source and model replies stay local.
function qaAttempts(request) {
  const attempts = new Map();
  for (const event of request.events) {
    if (event.featureId !== request.id || event.phase !== 'verify' || event.role !== 'qa' ||
      !Number.isSafeInteger(event.attempt) || event.attempt < 1) continue;
    const { attempt, seq, evidence } = event;
    if (['task.started', 'task.resumed', 'task.failed'].includes(event.type)) {
      attempts.set(attempt, { attempt, event: seq, result: event.type === 'task.failed' ? 'stopped' : 'started' });
    } else if (event.type === 'task.completed' && typeof evidence?.passed === 'boolean') {
      const checks = [];
      for (const check of Array.isArray(evidence.checks) ? evidence.checks : []) {
        if (!qaChecks.has(check?.check)) continue;
        if (typeof check.passed === 'boolean') checks.push({ check: check.check, result: check.passed ? 'passed' : 'failed' });
        else if (check.status === 'skipped') checks.push({ check: check.check, result: 'skipped' });
      }
      attempts.set(attempt, { attempt, event: seq, result: evidence.passed ? 'passed' : 'failed', checks });
    }
  }
  return [...attempts.values()];
}

function snapshot(request) {
  id(request.projectId, 'feature project ID');
  id(request.id, 'feature ID');
  requireField(['blocked', 'completed'].includes(request.status), 'Only a finished feature request can publish its receipts');
  const start = Date.parse(request.startedAt), end = Date.parse(request.endedAt);
  requireField(Number.isSafeInteger(start) && start > 0 && Number.isSafeInteger(end) && end >= start,
    'The request has no valid execution interval');
  requireField(Array.isArray(request.events), 'The feature journal is required to verify call receipts');
  const events = new Map(request.events.map(event => [event.seq, event]));
  const calls = featureCalls(request.events).map(call => {
    const event = events.get(call.seq);
    const receipt = event.type === 'agent.completed' ? event.evidence : event.evidence.receipt;
    requireField(event.featureId === request.id && (!receipt.role || receipt.role === call.role) &&
      Object.hasOwn(phases, call.role) && call.phase === phases[call.role] && Number.isSafeInteger(call.attempt) && call.attempt >= 0 &&
      Number.isSafeInteger(call.seq) && call.seq > 0 && threadIdPattern.test(call.threadId),
    'A completed Codex receipt has an invalid request, role, or thread identity');
    const from = Date.parse(call.startedAt), to = Date.parse(call.endedAt);
    requireField(Number.isSafeInteger(from) && Number.isSafeInteger(to) && from >= start && to <= end && to >= from,
      'A completed Codex receipt has no measured interval within this request');
    const model = call.model;
    requireField(model === null || model === 'codex default' || validModel(model),
      'The recorded Codex model identifier is invalid');
    // Only new receipts have selection provenance. Older verified traces keep their identity.
    const attribution = {};
    if (['configured', 'catalog-default', 'cli-default'].includes(receipt.modelSelection)) {
      attribution.selection = receipt.modelSelection;
      if (validModel(call.requestedModel)) attribution.requestedModel = call.requestedModel;
    }
    if (call.modelSource === 'reported' && ['codex-json', 'codex-response'].includes(receipt.reportedModelSource)) {
      attribution.reportedBy = receipt.reportedModelSource;
    }
    if (receipt.workspaceAction !== undefined) {
      requireField(call.role === 'engineer' && workspaceActions.has(receipt.workspaceAction), 'The receipt has an invalid workspace action');
    }
    return { seq: call.seq, role: call.role, phase: call.phase, attempt: call.attempt, threadId: call.threadId,
      startedAt: call.startedAt, endedAt: call.endedAt, durationMs: call.durationMs, model, modelSource: call.modelSource,
      ...(receipt.workspaceAction && { requestedWorkspaceAction: receipt.workspaceAction }),
      ...(Object.keys(attribution).length ? { attribution } : {}),
      usage: call.usage, receiptSha256: digest(receipt) };
  });
  requireField(calls.length, 'No completed Codex call receipts are available for this request');
  requireField(new Set(calls.map(call => call.seq)).size === calls.length, 'A call refers to a repeated feature event');
  const scope = { projectId: request.projectId, requestId: request.id };
  // Adding QA to older exports would invalidate their already-verified trace IDs.
  const hasActions = calls.some(call => call.requestedWorkspaceAction);
  const record = { ...scope, start, end, calls, status: request.status, ...(hasActions && { qaAttempts: qaAttempts(request) }) };
  const receiptDigest = digest({ schema: hasActions ? 'crew-feature-receipts-v2' : 'crew-feature-receipts-v1', ...record });
  return { ...record, receiptDigest };
}

function traceIdentity(receiptDigest, destination) {
  const traceId = digest(['crew-feature-trace-v1', destination, receiptDigest]).slice(0, 32);
  return { traceId, spanId: sha(traceId + ':request').slice(0, 16) };
}

function buildTrace(record, destination) {
  const { traceId, spanId } = traceIdentity(record.receiptDigest, destination);
  const { start, end, projectId, requestId, receiptDigest } = record;
  const name = projectId + '/' + requestId;
  const expected = [];
  function observation({ id, parent, title, type, from, to, input, output, metadata, model, usage, extra = [] }) {
    expected.push({ id, parent, title, from, to, input, output, metadata, model, usage });
    return { traceId, spanId: id, ...(parent ? { parentSpanId: parent } : {}), name: title, kind: 1,
      startTimeUnixNano: nano(from), endTimeUnixNano: nano(to),
      attributes: [attribute('langfuse.trace.name', name), attribute('langfuse.environment', 'local-delivery'),
        attribute('langfuse.observation.type', type), attribute('langfuse.observation.input', JSON.stringify(input)),
        attribute('langfuse.observation.output', JSON.stringify(output)),
        ...Object.entries(metadata).map(([key, value]) => attribute('langfuse.observation.metadata.' + key, value)), ...extra] };
  }
  const spans = [observation({ id: spanId, title: name, type: 'span', from: start, to: end, input: { projectId, requestId },
    output: { status: record.status, completedCalls: record.calls.length, elapsedMs: end - start,
      ...(record.qaAttempts && { qaAttempts: record.qaAttempts }) },
    metadata: { projectId, requestId, receiptSha256: receiptDigest } })];
  for (const call of record.calls) {
    const { seq, phase, role, attempt, threadId, model, modelSource, usage, durationMs, receiptSha256, attribution, requestedWorkspaceAction } = call;
    const nativeUsage = Object.fromEntries(['input','output','total'].filter(key => usage[key] !== null).map(key => [key, usage[key]]));
    const extra = [];
    const observedModel = modelSource === 'reported' && validModel(model) ? model : null;
    const displayedModel = observedModel ?? attribution?.requestedModel ?? null;
    if (observedModel) extra.push(attribute('langfuse.observation.model.name', observedModel));
    else if (displayedModel) extra.push(attribute('gen_ai.request.model', displayedModel));
    if (Object.keys(nativeUsage).length) extra.push(attribute('langfuse.observation.usage_details', JSON.stringify(nativeUsage)));
    const title = [role, record.qaAttempts && attempt > 0 && 'attempt ' + attempt,
      requestedWorkspaceAction && 'request ' + requestedWorkspaceAction, 'call #' + seq].filter(Boolean).join(' · ');
    spans.push(observation({ id: sha(traceId + ':event:' + seq).slice(0, 16), parent: spanId,
      title, type: 'generation', from: Date.parse(call.startedAt), to: Date.parse(call.endedAt),
      input: { projectId, requestId, event: seq, role, phase, attempt },
      output: { threadId, model, modelSource, durationMs, usage, ...(attribution && { attribution }),
        ...(requestedWorkspaceAction && { requestedWorkspaceAction }) },
      metadata: { projectId, requestId, codexThreadId: threadId, receiptSha256, ...attribution,
        ...(attribution && displayedModel ? { modelSource: observedModel ? 'reported' : 'requested' } : {}) },
      model: displayedModel, usage: nativeUsage, extra }));
  }
  function matches(rows) {
    const byId = new Map(rows.map(row => [row.id, row]));
    return expected.every(item => {
      const row = byId.get(item.id);
      return row && row.name === item.title && (row.parentObservationId ?? null) === (item.parent ?? null) &&
        Date.parse(row.startTime) === item.from && Date.parse(row.endTime) === item.to &&
        Object.entries(item.metadata).every(([key, value]) => row.metadata?.[key] === value) &&
        (item.model === undefined || (row.model ?? null) === item.model) &&
        Object.entries(item.usage ?? {}).every(([key, value]) => row.usageDetails?.[key] === value) &&
        sameJson(row.input, item.input) && sameJson(row.output, item.output);
    });
  }
  const payload = { resourceSpans: [{ resource: { attributes: [attribute('service.name', 'engineering-crew')] },
    scopeSpans: [{ scope: { name: 'engineering-crew.feature-receipts' }, spans }] }] };
  return { traceId, spanId, start, end, payload, matches };
}

function sameJson(actual, expected) {
  if (typeof actual === 'string') {
    try { actual = JSON.parse(actual); } catch { return false; }
  }
  return isDeepStrictEqual(actual, expected);
}

export function verifiedFeatureTraceLink(request) {
  const trace = request.langfuseTrace;
  const url = verifiedTraceLink(trace);
  if (!url || new URL(url).origin !== trace.origin) return null;
  try {
    const record = snapshot(request);
    const { traceId, spanId } = traceIdentity(record.receiptDigest, trace.projectId);
    if (trace.receiptDigest === record.receiptDigest && trace.traceId === traceId && trace.observationId === spanId &&
        trace.callCount === record.calls.length) return url;
  } catch (error) { if (!(error instanceof CrewError)) throw error; }
  return null;
}

async function saveExport(client, request, status, { message, trace } = {}) {
  const langfuseExport = { status, updatedAt: new Date().toISOString(), ...(message ? { message } : {}) };
  const patch = trace ? { langfuseExport, langfuseTrace: trace } : { langfuseExport };
  const result = await client.query(`UPDATE engineering_crew.features SET record=record || $3::jsonb
    WHERE id=$1 AND project_id=$2 AND record->>'status'=$4 AND record->>'endedAt'=$5`,
    [request.id, request.projectId, patch, request.status, request.endedAt]);
  requireField(result.rowCount === 1, 'The local feature request changed before the trace was saved');
}

export async function publishFeatureTrace(db, control, requestId, env = process.env, { automatic = false, ...options } = {}) {
  id(requestId, 'feature ID');
  const client = await db.connect();
  let locked = false, broken = false;
  const lost = () => { broken = true; };
  client.on('error', lost);
  try {
    // Serialize retries and automatic publication without holding the build or preview locks.
    await client.query('SELECT pg_advisory_lock($1, hashtext($2))', [featureExportLock, requestId]);
    locked = true;
    const request = await getFeature(client, requestId);
    requireField(['blocked', 'completed'].includes(request.status), 'Only a finished feature request can publish its receipts');
    if (automatic && (request.projectId !== env.CREW_LANGFUSE_AUTO_PROJECT || request.langfuseExport?.status !== 'pending')) return;
    await saveExport(client, request, 'pending');
    try {
      const record = snapshot(request);
      const config = await langfuseConfig(control, env);
      const span = buildTrace(record, config.projectId);
      const verified = await publishObservedSpans(config, span, span.matches, options);
      const trace = { ...verified, origin: config.origin, receiptDigest: record.receiptDigest, callCount: record.calls.length };
      await saveExport(client, request, 'verified', { trace });
      return trace;
    } catch (error) {
      const message = error instanceof CrewError ? error.message : 'The local receipt export could not finish.';
      if (!broken) await saveExport(client, request, 'failed', { message });
      throw error;
    }
  } finally {
    try {
      if (locked && !broken) await client.query('SELECT pg_advisory_unlock($1, hashtext($2))', [featureExportLock, requestId]);
    } catch { broken = true; }
    client.removeListener('error', lost);
    client.release(broken);
  }
}
