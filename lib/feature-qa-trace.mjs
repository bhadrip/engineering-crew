import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { id, requireField } from './contracts.mjs';
import { getFeature } from './feature-controller.mjs';
import { verifiedFeatureTraceLink } from './feature-langfuse.mjs';
import { langfuseConfig, readQaTraceRows } from './langfuse.mjs';

const sha = text => createHash('sha256').update(text).digest('hex');
const matches = (left, right) => isDeepStrictEqual(left, right);
const checkNames = ['Author tests', 'Independent QA tests', 'HTTP /health', 'Operator acceptance test'];
const fixtureKeys = ['fullRenditionMatched', 'correctionMatched', 'phrasePaired', 'saved', 'sameAudio'];
const validModel = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,119}$/.test(value);
const validCount = value => Number.isSafeInteger(value) && value >= 0;

function data(value) {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { value = null; }
  }
  requireField(value && typeof value === 'object' && !Array.isArray(value), 'Langfuse observation is missing structured evidence');
  return value;
}

function diagnosticChecks(raw) {
  requireField(Array.isArray(raw) && raw.length === checkNames.length, 'QA diagnostic has an incomplete check list');
  const checks = raw.map(item => {
    requireField(checkNames.includes(item?.check) && ['passed', 'failed', 'skipped'].includes(item.result), 'Unexpected QA check or verdict');
    const check = { check: item.check, result: item.result };
    if (item.fixtures !== undefined) {
      requireField(item.check === 'Operator acceptance test' && Array.isArray(item.fixtures) && item.fixtures.length <= 2, 'Unexpected QA fixture results');
      check.fixtures = item.fixtures.map(f => {
        requireField(['lesson','held-out'].includes(f?.fixture) && ['passed','failed'].includes(f.result), 'Unexpected QA fixture');
        const fixture = { fixture: f.fixture, result: f.result };
        for (const key of fixtureKeys) if (f[key] !== undefined) {
          requireField(typeof f[key] === 'boolean', 'Invalid QA fixture verdict');
          fixture[key] = f[key];
        }
        return fixture;
      });
      requireField(new Set(check.fixtures.map(f => f.fixture)).size === check.fixtures.length &&
        !(check.result === 'passed' && check.fixtures.some(f => f.result === 'failed')), 'Inconsistent QA fixture results');
    }
    return check;
  });
  requireField(new Set(checks.map(c => c.check)).size === checkNames.length, 'Repeated QA check');
  return checks;
}

function verifyDiagnostic(request, traceId, config, parentUrl, rows) {
  const [parent, child] = [rows.find(row => !row.parentObservationId), rows.find(row => row.parentObservationId)];
  const rootId = sha(traceId + ':diagnostic').slice(0, 16);
  requireField(parent?.id === rootId && parent.type === 'SPAN' && child?.id === sha(traceId + ':qa').slice(0,16) &&
    child.type === 'GENERATION' && child.parentObservationId === rootId &&
    parent.name === request.projectId + '/' + request.id + ' · post-run independent QA diagnostic' &&
    child.name === 'QA agent · independent test generation', 'Wrong diagnostic root or QA generation');
  const recorded = data(parent.input), generated = data(child.input);
  const { engineerTestEvent, revision, sourceAttempt } = recorded;
  const parentTraceId = request.langfuseTrace.traceId;
  const scope = { projectId: request.projectId, featureId: request.id, revision, engineerTestEvent, sourceAttempt, parentTraceId };
  requireField(matches(recorded, { ...scope, parentTraceUrl: parentUrl, requestStatus: 'blocked' }) &&
    Number.isSafeInteger(generated.journalEvent) && generated.journalEvent > 0 &&
    matches(generated, { ...scope, role: 'qa', journalEvent: generated.journalEvent }), 'QA diagnostic belongs to a different request or parent trace');
  const source = request.events.find(event => event.seq === engineerTestEvent);
  requireField(Number.isSafeInteger(engineerTestEvent) && Number.isSafeInteger(sourceAttempt) && sourceAttempt > 0 &&
    /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(revision) && source?.featureId === request.id && source.role === 'engineer' &&
    source.phase === 'build' && source.attempt === sourceAttempt && source.type === 'tool.completed' && source.evidence?.action === 'test' &&
    source.evidence.revision === revision && typeof source.evidence.passed === 'boolean', 'QA diagnostic has no matching engineer test on this revision');
  const receipt = parent.metadata?.receiptSha256;
  requireField(typeof receipt === 'string' && /^[a-f0-9]{64}$/.test(receipt) && [parent,child].every(row =>
    row.metadata?.scope === 'post-run-independent-qa' && row.metadata?.receiptSha256 === receipt &&
    row.metadata?.projectId === request.projectId && row.metadata?.featureId === request.id &&
    row.metadata?.revision === revision && row.metadata?.parentTraceId === parentTraceId), 'QA diagnostic receipt identity mismatch');
  const start = Date.parse(parent.startTime), end = Date.parse(parent.endTime);
  const callStart = Date.parse(child.startTime), callEnd = Date.parse(child.endTime);
  const answer = data(child.output);
  const modelSource = answer.modelSource;
  const model = modelSource === 'reported' ? answer.reportedModel : answer.requestedModel;
  requireField(Date.parse(request.endedAt) <= start && start <= callStart && callStart <= callEnd && callEnd <= end && end <= Date.now() &&
    answer.durationMs === callEnd - callStart && typeof answer.threadId === 'string' &&
    /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(answer.threadId) && child.metadata.codexThreadId === answer.threadId &&
    ['reported','requested'].includes(modelSource) && validModel(answer.requestedModel) && validModel(model) && model === child.model &&
    child.metadata.modelSource === modelSource, 'QA generation has no matching model, thread or execution interval');
  const usage = data(answer.usage);
  requireField(Object.keys(usage).every(key => ['input','output','total'].includes(key) && validCount(usage[key]) &&
    usage[key] === child.usageDetails?.[key]), 'QA generation usage disagrees with its observation');
  const outcome = data(parent.output), checks = diagnosticChecks(outcome.checks);
  requireField(outcome.result === (checks.every(c => c.result === 'passed') ? 'passed' : 'failed'), 'QA diagnostic verdict disagrees with its checks');
  const url = config.origin + '/project/' + encodeURIComponent(config.projectId) + '/traces/' + traceId +
    '?observation=' + rootId + '&mobileTab=info';
  return { revision, sourceAttempt, engineerTestEvent, result: outcome.result, checks,
    startedAt: new Date(start).toISOString(), endedAt: new Date(end).toISOString(), model, modelSource, parentTraceId,
    trace: { status: 'verified', traceId, observationId: rootId, projectId: config.projectId, url, verifiedAt: new Date().toISOString() } };
}

export async function attachQaTrace(db, control, featureId, traceId, env = process.env) {
  id(featureId, 'feature ID');
  requireField(typeof traceId === 'string' && /^[a-f0-9]{32}$/.test(traceId), 'Expected a Langfuse trace ID');
  const request = await getFeature(db, featureId);
  const parentUrl = verifiedFeatureTraceLink(request);
  requireField(request.status === 'blocked' && parentUrl, 'Only a blocked request with a verified parent trace can attach diagnostic QA');
  const config = await langfuseConfig(control, env);
  requireField(config.origin === request.langfuseTrace.origin && config.projectId === request.langfuseTrace.projectId, 'The parent trace is in another Langfuse project');
  const rows = await readQaTraceRows(config, traceId, request.endedAt);
  const attachment = verifyDiagnostic(request, traceId, config, parentUrl, rows);
  // A conditional merge preserves any concurrently refreshed preview or export details.
  const { rowCount } = await db.query(`UPDATE engineering_crew.features SET record=jsonb_set(record,'{qaDiagnostic}',$3::jsonb)
    WHERE id=$1 AND project_id=$2 AND record->>'status'='blocked' AND record->>'endedAt'=$4
    AND record#>>'{langfuseTrace,traceId}'=$5 AND record#>>'{langfuseTrace,receiptDigest}'=$6
    AND record#>>'{langfuseTrace,url}'=$7 AND NOT (record ? 'qaDiagnostic')`,
    [featureId, request.projectId, attachment, request.endedAt, request.langfuseTrace.traceId, request.langfuseTrace.receiptDigest, parentUrl]);
  if (rowCount) return attachment;
  const current = await getFeature(db, featureId);
  const saved = current.qaDiagnostic;
  requireField(current.status === 'blocked' && current.endedAt === request.endedAt && verifiedFeatureTraceLink(current) === parentUrl &&
    saved?.trace?.traceId === traceId && matches(saved, { ...attachment, trace: { ...attachment.trace, verifiedAt: saved.trace.verifiedAt } }),
    'The request changed or already has a different QA diagnostic');
  return saved;
}
