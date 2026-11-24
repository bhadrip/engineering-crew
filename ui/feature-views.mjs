import { agentImageField, dispatchWorkerStatus, escape, layout, projectHeader, projectHref, runState, stateBadge, workflowSetupHref } from './views.mjs';
import { planSynopsis, renderFeaturePlan } from './feature-plan.mjs';
import { featureUsage, stageUsage } from './feature-usage.mjs';
import { featureCalls } from '../lib/feature-usage.mjs';
import { verifiedFeatureTraceLink } from '../lib/feature-langfuse.mjs';
import { verifiedTraceLink } from '../lib/langfuse.mjs';
import { receiptMetrics } from './feature-receipt.mjs';
import { featureDag, featureStageResults } from './feature-dag.mjs';
import { featureStory } from './feature-story.mjs';
import { checkFailures } from './feature-journey.mjs';
import { buildName, featureRole, featureTaskAction } from './feature-language.mjs';

const requestStates = {
  queued: ['Queued', 'neutral'], running: ['Running', 'active'],
  completed: ['Completed', 'success'], blocked: ['Blocked', 'warning'],
};
const phaseNames = {
  plan: 'Planning', build: 'Implementation', verify: 'Verification', promote: 'Delivery', preview: 'Local preview',
};
const eventNames = {
  'request.created': 'Request received', 'request.started': 'Request started', 'task.started': 'Task started', 'task.resumed': 'Task resumed',
  'task.completed': 'Task finished', 'task.failed': 'Task failed', 'repair.requested': 'Repair requested',
  'request.completed': 'Request completed', 'request.blocked': 'Request blocked',
  'tool.called': 'Tool called', 'tool.completed': 'Tool finished', 'tool.failed': 'Tool unavailable', 'agent.activity': 'Agent activity',
  'agent.started': 'Codex call started', 'agent.thread': 'Agent session recorded', 'agent.completed': 'Codex call finished',
  'app.test.started': 'App tests started', 'app.test.completed': 'App tests finished', 'app.healthy': 'App health check passed',
  'app.unhealthy': 'App health check failed', 'app.probe.started': 'Application acceptance check started',
  'app.probe.completed': 'Application acceptance check finished', 'app.preview.ready': 'Local app serving',
  'app.preview.failed': 'Local preview failed',
  'workspace.changed': 'File changed', 'candidate.verified': 'Candidate verified',
  'runtime.started': 'Agent workspace started', 'runtime.stopped': 'Agent workspace stopped', 'runtime.profile': 'Agent permissions recorded',
};
const previewLabels = { pending: 'Local preview pending', failed: 'Local preview failed', ready: 'Local preview ready' };
const requestsPath = project => `${projectHref(project)}/requests`;
const requestPath = (project, request) => `${requestsPath(project)}/${request.workflow ? 'workflow/' : ''}${encodeURIComponent(request.id)}`;
const sentence = goal => goal.trim().split(/\n|(?<=[.!?])\s/)[0];
export function requestTitle(request) {
  if (/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(request.id)) return sentence(request.goal);
  return request.id.replaceAll('-', ' ').replace(/^./, letter => letter.toUpperCase());
}
const badgeFor = status => stateBadge(...(requestStates[status] ?? [status, 'neutral']));
export { badgeFor as featureRequestBadge };
const phaseName = phase => phaseNames[phase] ?? phase;
const toolNames = { list: 'list files', read: 'read files', edit: 'edit files', test: 'run tests', finish: 'submit candidate' };
function eventName(event) {
  if (event.type === 'runtime.stopped' && event.evidence?.removed === false) return 'Agent workspace cleanup incomplete';
  const label = eventNames[event.type] ?? event.type.replace(/[._-]+/g, ' ').replace(/^./, c => c.toUpperCase());
  const action = toolNames[event.evidence?.action];
  return event.type.startsWith('tool.') && action ? `${label} · ${action}` : label;
}

function time(value) {
  return value ? `<time data-local data-precise datetime="${escape(value)}" title="${escape(value)}">${escape(value)}</time>` : '';
}

function monitorControls() {
  return `<div class="monitor-controls"><button hidden type="button" class="secondary" data-toggle-live>Pause live updates</button>
<span class="muted" data-live-message role="status"></span></div>`;
}

export function featurePreviewPage(previewUrl) {
  const url = new URL(previewUrl);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash) throw new Error('Invalid local preview address');
  return layout('Open current app', `<main><h1>Open current app</h1><a data-open-preview href="${escape(url.href)}">Open the local app</a></main>`);
}

function workflowRequestRow(run) {
  const { accepted, skipped = 0, total } = run.handoffs;
  const [status, label, tone] = runState(run);
  return { id: run.id, goal: run.workflowRequest.title, createdAt: run.startedAt, status,
    workflow: run.epic.title, version: run.project.configurationVersion,
    badge: accepted + skipped === total && status === 'accepted' && !run.workspaceDeliveryStatus?.published ? ['Handoffs complete', 'success'] : [label, tone] };
}

function newRequestForm(project, intake) {
  const { workflows, formId, draft, error, fromDelivery } = intake ?? {};
  const alert = error ? `<p class="agent-feedback" role="alert">${escape(error)}</p>` : '';
  const deliveryRunId = fromDelivery?.runId ?? draft?.deliveryRunId;
  const deliveryContext = fromDelivery ? `<p>Starting workspace from <a href="${projectHref(project)}/epics/${encodeURIComponent(fromDelivery.workflowId)}?run=${encodeURIComponent(fromDelivery.runId)}&amp;view=delivery">the delivery published ${time(fromDelivery.publishedAt)}</a>
    · <code title="${escape(fromDelivery.digest)}">${escape(fromDelivery.digest.slice(0, 12))}</code></p>` : '';
  if (workflows?.length === 0) return `${alert}${deliveryContext}<p>${deliveryRunId
    ? 'Save a workflow that uses the request brief and the published workspace to start a follow-up.'
    : 'Save a workflow that uses the request brief before starting a new request.'}
    <a href="${projectHref(project)}/workflows">Open Workflows</a></p>`;
  const selected = draft?.choice || (workflows?.length === 1 ? workflows[0].id + '/' + workflows[0].version : '');
  const selection = workflows?.find(workflow => workflow.id + '/' + workflow.version === selected);
  const imageSteps = selection?.requestImageSteps ?? [];
  return `<form class="request-form" method="post" action="${requestsPath(project)}"${intake ? ' enctype="multipart/form-data"' : ''}>${alert}${deliveryContext}
${intake ? `<input type="hidden" name="request-id" value="${escape(formId)}">
${deliveryRunId ? `<input type="hidden" name="delivery-run-id" value="${escape(deliveryRunId)}">` : ''}
<label for="request-workflow">Workflow version</label><select id="request-workflow" name="workflow-version" required>
  <option value="">Choose a saved workflow</option>${workflows.map(workflow => {
    const choice = workflow.id + '/' + workflow.version;
    const images = workflow.requestImageSteps ?? [];
    return `<option value="${escape(choice)}" data-run-setup="${escape(workflowSetupHref(project, workflow.id, workflow.version))}"${selected === choice ? ' selected' : ''}${images.length ?
      ` data-request-image-steps="${escape(JSON.stringify(images))}"` : ''}>${escape(workflow.title)} · v${workflow.version}${workflow.usesPublishedWorkspace && !deliveryRunId ? ' · Latest delivery' : ''}${images.length ? ' · Accepts images' : ''}</option>`;
  }).join('')}</select>
  <a data-request-run-setup target="_blank" rel="noopener"${selection ?
    ' href="' + escape(workflowSetupHref(project, selection.id, selection.version)) + '"' : ' hidden'}>Review run setup</a>` : ''}
<label for="request-goal">${intake ? 'Request brief' : 'What should Crew build or fix?'}</label><textarea id="request-goal" name="goal" rows="3" maxlength="12000" required>${escape(draft?.goal)}</textarea>
${intake ? `<fieldset class="request-image-inputs" data-request-image-inputs${imageSteps.length ? '' : ' hidden disabled'}>
  <legend>Request images</legend>${agentImageField()}
  <p class="agent-field-hint">These workflow steps receive the images</p>
  <ul data-request-image-steps>${imageSteps.map(title => `<li>${escape(title)}</li>`).join('')}</ul></fieldset>` : ''}
<button type="submit">${intake ? 'Submit request' : 'Start request'}</button></form>`;
}

export function featureRequestsPage(project, requests, intake) {
  const active = r => ['running', 'queued', 'triage', 'review'].includes(r.status) || r.previewStatus === 'pending' || r.langfuseExport?.status === 'pending';
  const rows = [...requests, ...(intake?.runs ?? []).map(workflowRequestRow)]
    .sort((a, b) => Number(active(b)) - Number(active(a)) || b.createdAt.localeCompare(a.createdAt));
  return layout(`Feature requests · ${project.name}`, `${projectHeader(project, 'requests')}<main class="feature-page request-history" data-feature-monitor>
<div class="request-list-heading"><h1>Feature requests</h1>${monitorControls()}</div>
${dispatchWorkerStatus(intake?.workerConnected)}
<details id="new-request" class="new-request"${rows.length && !intake?.error && !intake?.fromDelivery ? '' : ' open'}><summary>New request</summary>
${newRequestForm(project, intake)}</details>
<div id="request-list" data-live-section data-live-version="${escape(JSON.stringify(rows.map(r => [r.id, r.status, r.phase, r.attempt, r.endedAt, r.canResume, r.previewStatus, r.langfuseExport?.status])))}" data-announcement="${rows.length} requests">
${rows.length ? `<ol class="request-list" aria-label="Request history">${rows.map(r => {
    const title = r.workflow ? r.goal : requestTitle(r);
    const brief = sentence(r.goal);
    return `<li><div class="request-list-copy"><a href="${requestPath(project, r)}">${escape(title)}</a>
${brief !== title && brief.length <= 160 ? `<p class="feature-subtitle">${escape(brief)}</p>` : ''}
<div class="feature-meta">${time(r.createdAt)}${r.workflow ? `<span>${escape(r.workflow)} · v${escape(r.version)}</span>` : ''}${r.attempt ? `<span>Attempt ${escape(r.attempt)}</span>` : ''}</div></div>
<div class="request-list-state">${r.badge ? stateBadge(...r.badge) : badgeFor(r.status)}${previewLabels[r.previewStatus] ? `<span>${escape(previewLabels[r.previewStatus])}</span>` : ''}</div></li>`;
  }).join('')}</ol>` : '<p class="empty-state">Your first request will appear here.</p>'}</div></main>`);
}

function eventResult(event) {
  if (!['task.completed', 'app.test.completed', 'app.probe.completed', 'tool.completed'].includes(event.type) || typeof event.evidence?.passed !== 'boolean') return '';
  return event.evidence.passed ? stateBadge('Passed', 'success') : stateBadge('Failed', 'warning');
}

const milestoneTypes = new Set(['request.created', 'request.started', 'task.completed', 'task.failed', 'repair.requested',
  'candidate.verified', 'request.completed', 'request.blocked', 'app.preview.ready', 'app.preview.failed',
  'app.probe.completed', 'app.unhealthy']);

function concise(value, limit = 220) {
  if (typeof value !== 'string') return '';
  const text = value.trim().replace(/\s+/g, ' ');
  if (text.length <= limit) return text;
  return text.slice(0, limit).replace(/\s+\S*$/, '') + '…';
}

function agentEvent(event) {
  const action = featureTaskAction(event) || 'Task';
  if (event.type === 'task.completed') {
    if (event.role === 'planner') return action + (planSynopsis(event.evidence?.plan) ? ' · Succeeded' : ' · Result unavailable');
    if (event.role === 'engineer') {
      if (typeof event.evidence?.revision !== 'string' || !event.evidence.revision.trim()) return action + ' · Result unavailable';
      return action + (event.attempt === 1 ? ' · Succeeded' : ' · Revision produced');
    }
    if (typeof event.evidence?.passed === 'boolean') return action + (event.evidence.passed ? ' · Passed' : ' · Failed');
    return action + ' · Finished';
  }
  if (event.type === 'task.started' || event.type === 'task.resumed') return action + (event.type === 'task.resumed' ? ' · Resumed' : ' · Started');
  if (event.type === 'task.failed') return action + ' · Stopped';
  if (event.type === 'repair.requested') return `Changes requested after attempt ${event.attempt}`;
  return eventName(event);
}

function repairReasons(event, bySeq) {
  const causes = (event.parents ?? []).map(seq => bySeq.get(seq)).filter(e =>
    e && (e.type === 'task.failed' || e.evidence?.passed === false));
  const feedback = Array.isArray(event.evidence?.feedback) ? event.evidence.feedback : [];
  const reasons = causes.map(cause => ({ role: cause.role, seq: cause.seq, evidence: cause.evidence ?? {} }));
  for (const item of feedback) {
    if (item && !causes.some(c => c.role === item.role && c.evidence?.revision === item.revision)) {
      reasons.push({ role: item.role, seq: event.seq, evidence: item });
    }
  }
  return reasons.map(({ role, seq, evidence }) => {
    const recorded = checkFailures(evidence);
    return { role: featureRole(role), seq, reason: recorded.slice(0, 2).join(' · ') || concise(evidence.summary) || 'The recorded check failed.' };
  });
}

function diagnostics(event, bySeq) {
  const causes = repairReasons(event, bySeq);
  if (!causes.length) return '';
  return `<div class="feature-diagnostics">${causes.map(cause =>
    `<p class="trace-cause"><a href="#event-${escape(cause.seq)}">${escape(cause.role)} finding</a> · ${escape(cause.reason)}</p>`).join('')}</div>`;
}

const seconds = new Intl.NumberFormat('en', { maximumFractionDigits: 3, useGrouping: false });
function timeRange(clip) {
  if (!clip || !Number.isFinite(clip.start) || !Number.isFinite(clip.end) || clip.start < 0 || clip.end <= clip.start) {
    return 'Invalid time range';
  }
  return `${seconds.format(clip.start)}–${seconds.format(clip.end)} s`;
}

function timedText(clip) {
  const words = typeof clip?.text === 'string' && clip.text.trim();
  return escape(timeRange(clip)) + (words ? ` · “${escape(words)}”` : '');
}

function probeObservations(evidence) {
  if (evidence.passed !== false) return '';
  const checks = Array.isArray(evidence.checks) ? evidence.checks.filter(check => check?.passed === false) : [];
  const lessons = [evidence, ...checks].flatMap(check => Array.isArray(check.lessons) ? check.lessons : []);
  return lessons.map(lesson => {
    if (!lesson || typeof lesson !== 'object') return '';
    const observedCorrections = Array.isArray(lesson.corrections) ? lesson.corrections.map(c => {
      const linked = c && typeof c === 'object' && ('phraseStart' in c || 'phraseEnd' in c)
        ? ' · Linked phrase ' + timeRange({ start: c.phraseStart, end: c.phraseEnd }) : '';
      return timedText(c) + escape(linked);
    }) : null;
    const fields = [
      recordField('Expected full rendition', lesson.expectedTeacherRendition && escape(timeRange(lesson.expectedTeacherRendition))),
      recordField('Observed full rendition', Object.hasOwn(lesson, 'observedSong')
        ? (lesson.observedSong === null ? 'None returned' : escape(timeRange(lesson.observedSong))) : ''),
      recordField('Expected correction', lesson.expectedCorrection && timedText(lesson.expectedCorrection)),
      recordField('Observed corrections', observedCorrections ? observedCorrections.join('<br>') || 'None returned' : ''),
      recordField('Expected practice phrases', Array.isArray(lesson.expectedPhraseOptions)
        ? lesson.expectedPhraseOptions.map(clip => escape(timeRange(clip))).join(' · ') || 'None listed' : ''),
    ].join('');
    if (!fields) return '';
    return `<section class="probe-observations"><h3>${escape(lesson.fixture ?? 'Lesson')} timing comparison</h3>
<dl class="probe-ranges">${fields}</dl></section>`;
  }).join('');
}

function eventRow(event, bySeq, project, request, call) {
  const evidence = event.evidence ?? {};
  const parents = (event.parents ?? []).map(seq => {
    const parent = bySeq.get(seq);
    return parent ? `<a href="#event-${escape(seq)}">${escape(agentEvent(parent))} #${escape(seq)}</a>` : `#${escape(seq)} (unavailable)`;
  });
  const message = [evidence.message, evidence.summary, evidence.reason].find(value => typeof value === 'string' && value.trim());
  const plannedBase = event.type === 'task.completed' && event.role === 'planner' && evidence.plan?.base;
  const predecessor = plannedBase && event.predecessor?.revision === plannedBase ? event.predecessor : null;
  const revision = evidence.revision ?? event.revision;
  const diff = event.type === 'task.completed' && event.role === 'engineer' && evidence.base && evidence.revision && event.attempt;
  const milestone = milestoneTypes.has(event.type);
  const failedChecks = evidence.passed === false ? checkFailures(evidence) : [];
  const failed = (event.type === 'repair.requested' || event.type === 'request.blocked') ? diagnostics(event, bySeq) : '';
  const verdict = eventResult(event);
  const observations = probeObservations(evidence);
  const plan = event.role === 'planner' && event.type === 'task.completed' && evidence.plan;
  const raw = Object.keys(evidence).length ? `<pre>${escape(JSON.stringify(evidence, null, 2))}</pre>` : '';
  return `<li id="event-${escape(event.seq)}" class="trace-event ${milestone ? 'trace-milestone' : 'trace-detail'}" tabindex="-1"${milestone ? ' data-milestone' : ''}>
<a class="trace-return" href="#request-overview">Back to overview</a>
<div class="trace-heading"><a class="event-number" href="#event-${escape(event.seq)}" aria-label="Event ${escape(event.seq)}">#${escape(event.seq)}</a>
<strong>${escape(verdict && event.type === 'task.completed' ? featureTaskAction(event) : agentEvent(event))}</strong>${verdict}
${event.role ? `<span class="trace-owner">Run by: ${escape(featureRole(event.role))}</span>` : ''} ${time(event.at)}</div>
${message ? `<p class="trace-message">${escape(concise(message))}</p>` : ''}
${plan ? renderFeaturePlan(plan, { id: 'event-plan-' + event.seq, goal: request.goal }) + stageUsage('planning', [event]) : ''}
${call ? receiptMetrics(call) : ''}
${(evidence.inputDigest || evidence.receipt?.inputDigest) ? `<p><a href="${requestPath(project, request)}/events/${event.seq}/input">Call input and output</a></p>` : ''}
${failedChecks.length ? `<div class="feature-diagnostics">${failedChecks.slice(0, 4).map(reason => `<p>${escape(reason)}</p>`).join('')}</div>` : ''}${failed}
${typeof evidence.path === 'string' ? `<div class="trace-revision">File <code>${escape(evidence.path)}</code></div>` : ''}
${predecessor ? `<div class="trace-parents">Delivered by ${predecessorLink(project, predecessor)}</div>` : ''}
${diff ? `<a href="${requestPath(project, request)}/attempts/${encodeURIComponent(event.attempt)}/changes">Candidate diff</a>` : ''}
<details id="evidence-${escape(event.seq)}"${observations ? ' data-probe-evidence' : ''}><summary>Recorded evidence</summary>${observations}
<div class="feature-meta">${[event.phase && 'Phase · ' + phaseName(event.phase), event.attempt ? `Attempt ${event.attempt}` : '', event.status && 'Request · ' + event.status].filter(Boolean).map(label => `<span>${escape(label)}</span>`).join('')}</div>
${parents.length ? `<div class="trace-parents">Follows ${parents.join(', ')}</div>` : ''}
${plannedBase ? `<div class="trace-revision">Starting revision <code>${escape(plannedBase)}</code></div>` : ''}
${revision ? `<div class="trace-revision">Revision <code>${escape(revision)}</code></div>` : ''}
${event.type === 'tool.completed' && event.role === 'engineer' && evidence.action === 'edit' && evidence.revision ? `<a href="${requestPath(project, request)}/events/${encodeURIComponent(event.seq)}/changes">View edit</a>` : ''}
${raw ? `<details><summary>Raw JSON</summary>${raw}</details>` : ''}</details></li>`;
}

function recordField(label, value) {
  return value ? `<div><dt>${escape(label)}</dt><dd>${value}</dd></div>` : '';
}

function predecessorLink(project, predecessor) {
  const event = Number.isSafeInteger(predecessor.eventSeq) && predecessor.eventSeq > 0 ? `#event-${predecessor.eventSeq}` : '';
  return `<a href="${requestsPath(project)}/${encodeURIComponent(predecessor.featureId)}${event}">${escape(predecessor.featureId)}${event ? ` · event #${predecessor.eventSeq}` : ''}</a>`;
}

function currentAgents(events, request) {
  if (request.status !== 'running' || request.canResume) return [];
  const working = new Map();
  for (const event of events) {
    if (event.attempt !== request.attempt) continue;
    const key = event.operationId ?? event.role;
    if (event.type === 'task.started' || event.type === 'task.resumed') working.set(key, featureRole(event.role));
    if (event.type === 'task.completed' || event.type === 'task.failed') working.delete(key);
  }
  return [...new Set(working.values())];
}

function recentAction(events) {
  return events.findLast(event => milestoneTypes.has(event.type) || event.type.startsWith('tool.') ||
    event.type.startsWith('app.') || ['task.started', 'task.resumed', 'workspace.changed'].includes(event.type));
}

function blockedSummary(request, events, bySeq) {
  const blocked = events.findLast(e => e.type === 'request.blocked');
  const cause = blocked && repairReasons(blocked, bySeq)[0];
  const probe = events.findLast(e => e.type === 'app.probe.completed');
  const failures = probe?.evidence?.passed === false ? checkFailures(probe.evidence) : [];
  const lessons = Array.isArray(probe?.evidence?.lessons) ? probe.evidence.lessons : [];
  const failedMusic = lessons.some(l => l?.passed === false && 'fullRenditionMatched' in l);
  const preserved = lessons.length > 0 && lessons.every(l => l.saved === true && l.sameAudio === true);
  const missedSongAndCorrection = failedMusic && lessons.length === 1 && lessons[0].fullRenditionMatched === false && lessons[0].correctionMatched === false;
  const outcome = failures.length ? (missedSongAndCorrection ? 'Song and correction detection failed' : failedMusic ? 'Lesson analysis failed' : 'Application check failed') : 'Delivery stopped';
  const checkedAttempt = failures.length && probe.attempt > 0 && probe.attempt !== request.attempt ? ` on attempt ${escape(probe.attempt)}` : '';
  const target = failures.length ? probe : blocked;
  let productReason = concise(failures.join(' · '), 230);
  if (failedMusic && lessons.length === 1) {
    const lesson = lessons[0];
    const missed = [[lesson.fullRenditionMatched, 'the teacher’s full rendition'], [lesson.correctionMatched, 'the spoken correction'],
      [lesson.phrasePaired, 'the linked practice phrase']].filter(([matched]) => matched === false).map(([, label]) => label);
    if (missed.length) productReason = 'The last check missed ' + new Intl.ListFormat('en').format(missed) + '.';
  }
  const lastQa = events.findLast(e => e.type === 'task.completed' && e.role === 'qa');
  const qaRepair = lastQa?.evidence?.passed === false && events.some(e => e.type === 'repair.requested' &&
    e.parents?.includes(lastQa.seq) && e.attempt === lastQa.attempt);
  const qaStep = qaRepair && featureStageResults(request, events).get(lastQa.seq);
  let stepReason = cause?.reason ?? request.reason;
  if (cause && /turn budget|(?:step|turn) limit/i.test(stepReason)) {
    const step = bySeq.get(cause.seq);
    const tool = events.findLast(e => e.type === 'tool.called' && e.role === step.role && e.attempt === step.attempt && e.seq < step.seq);
    if (Number.isSafeInteger(tool?.evidence?.turn)) stepReason = `${cause.role} reached its ${tool.evidence.turn}-step limit`;
  }
  return `<div class="feature-current"><h2>${target ? `<a href="#event-${escape(target.seq)}">${outcome}${checkedAttempt}</a>` : outcome}</h2>
${failures.length ? `<p>${preserved ? 'Lesson storage and original audio replay passed. ' : ''}${escape(productReason)}</p>` : ''}</div>
${stepReason ? `<p class="trace-cause">${cause ? `<a href="#event-${escape(cause.seq)}">${escape(concise(stepReason, 180))}</a>` : escape(concise(stepReason, 180))}</p>` : ''}
${qaStep?.status === 'Failed' && qaStep.summary ? `<p class="last-qa"><a href="${qaStep.href}">QA on ${escape(buildName(lastQa.attempt))}</a><span> · ${escape(concise(qaStep.summary, 145))}</span></p>` : ''}`;
}

const qaResults = { passed: ['Passed', 'success'], failed: ['Failed', 'warning'], skipped: ['Skipped', 'neutral'] };
const fixtureChecks = [
  ['fullRenditionMatched', 'full rendition'], ['correctionMatched', 'spoken correction'],
  ['phrasePaired', 'practice phrase'], ['saved', 'lesson storage'], ['sameAudio', 'original audio'],
];

function followUpQa(project, request, bySeq) {
  const qa = request.qaDiagnostic;
  if (!qa || request.status !== 'blocked' || project.id !== request.projectId) return '';
  if (!(Date.parse(qa.startedAt) >= Date.parse(request.endedAt) && Date.parse(qa.endedAt) >= Date.parse(qa.startedAt))) return '';
  const test = bySeq.get(qa.engineerTestEvent);
  if (!Number.isSafeInteger(qa.engineerTestEvent) || !Number.isSafeInteger(qa.sourceAttempt) || qa.sourceAttempt < 1 ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(qa.revision) || test?.featureId !== request.id ||
    test.type !== 'tool.completed' || test.role !== 'engineer' || test.phase !== 'build' ||
    test.attempt !== qa.sourceAttempt || test.evidence?.action !== 'test' ||
    typeof test.evidence.passed !== 'boolean' || test.evidence.revision !== qa.revision) return '';
  const original = verifiedFeatureTraceLink(request), url = verifiedTraceLink(qa.trace);
  if (!original || !url || new URL(original).origin !== new URL(url).origin ||
    qa.trace.projectId !== request.langfuseTrace.projectId || qa.parentTraceId !== request.langfuseTrace.traceId ||
    qa.trace.traceId === qa.parentTraceId) return '';
  const validCheck = item => item && typeof item.check === 'string' && Object.hasOwn(qaResults, item.result) &&
    (item.fixtures === undefined || Array.isArray(item.fixtures) && item.fixtures.every(f =>
      f && typeof f.fixture === 'string' && ['passed','failed'].includes(f.result)));
  if (!['passed','failed'].includes(qa.result) || !Array.isArray(qa.checks) || !qa.checks.length ||
    !qa.checks.every(validCheck) || (qa.result === 'passed') !== qa.checks.every(c => c.result === 'passed')) return '';
  const checks = qa.checks.map(check => {
    const fixtures = check.fixtures?.map(f => {
      const failed = fixtureChecks.filter(([key]) => f[key] === false).map(([,label]) => label);
      return `<li><span>${escape(f.fixture)} · ${qaResults[f.result][0]}</span>${failed.length ? `<small>Failed checks · ${failed.join(', ')}</small>` : ''}</li>`;
    }).join('');
    return `<li><div class="qa-check-row"><span>${escape(check.check)}</span>${stateBadge(...qaResults[check.result])}</div>${fixtures ? `<ul class="qa-fixtures">${fixtures}</ul>` : ''}</li>`;
  }).join('');
  const model = ['reported', 'requested'].includes(qa.modelSource) && typeof qa.model === 'string' && qa.model
    ? `<span>Model ${qa.modelSource} · <code>${escape(qa.model)}</code></span>` : '';
  return `<section class="follow-up-qa" id="follow-up-qa" aria-labelledby="follow-up-qa-title">
<div class="qa-check-row"><h2 id="follow-up-qa-title">Follow-up QA</h2>${stateBadge(...qaResults[qa.result])}</div>
<p>QA checked <a href="#event-${test.seq}">revision <code>${qa.revision.slice(0,10)}</code> from engineer test #${test.seq}</a> after this run ended. Delivery is blocked.</p>
<ul class="qa-checks">${checks}</ul><div class="feature-meta">${model}<a href="${escape(url)}">Open follow-up QA in Langfuse ↗</a></div></section>`;
}

export function featureRequestPage(project, request, { langfuseConfigured = false } = {}) {
  const path = requestPath(project, request);
  const events = [...(request.events ?? [])].sort((a, b) => a.seq - b.seq);
  const bySeq = new Map(events.map(event => [event.seq, event]));
  const calls = new Map(featureCalls(events).map(call => [call.seq, call]));
  const { candidate, delivery } = request;
  const terminal = ['completed', 'blocked'].includes(request.status) && request.previewStatus !== 'pending' && request.langfuseExport?.status !== 'pending';
  const previewLabel = previewLabels[request.previewStatus];
  const announcement = [request.status, previewLabel, `${events.length} recorded events`].filter(Boolean).join(', ');
  const summaryVersion = JSON.stringify([request.status, request.phase, request.attempt, request.canResume, request.reason,
    request.startedAt, request.deadlineAt, request.endedAt, request.revision, candidate?.revision, delivery?.revision,
    request.previewStatus, request.langfuseExport?.status, request.langfuseExport?.updatedAt, request.langfuseTrace?.verifiedAt,
    request.qaDiagnostic?.trace?.verifiedAt, events.at(-1)?.seq]);
  const title = requestTitle(request);
  const action = recentAction(events);
  const active = currentAgents(events, request);
  const actionDetail = action?.evidence?.passed === false ? checkFailures(action.evidence)[0]
    : concise(action?.evidence?.error || action?.evidence?.message || action?.evidence?.summary || action?.evidence?.path);
  const blocked = request.status === 'blocked';
  const repair = request.status === 'running' && events.findLast(e => e.type === 'repair.requested');
  const priorIssue = repair && repairReasons(repair, bySeq)[0];
  return layout(`${title} · ${project.name}`, `${projectHeader(project, 'requests')}
<main class="feature-page" data-feature-monitor><nav class="breadcrumbs" aria-label="Location"><a href="${requestsPath(project)}">Feature requests</a></nav>
<header class="feature-heading" id="request-overview" tabindex="-1"><div class="request-title"><h1>${escape(title)}</h1>${monitorControls()}</div><details class="original-request" id="original-request"><summary>Original request</summary><p class="request-goal">${escape(request.goal)}</p></details></header>
<div data-live-section data-live-version="${escape(summaryVersion)}" data-announcement="${escape(announcement)}" id="request-summary">
<section class="feature-summary" aria-label="Request status"><div class="feature-metrics">${badgeFor(request.status)}
${request.attempt ? `<span>Attempt ${escape(request.attempt)}${request.limits?.maxAttempts ? ' of ' + escape(request.limits.maxAttempts) : ''}</span>` : ''}
${active.length ? `<span>Active · ${escape(active.join(', '))}</span>` : ''}${previewLabel ? `<span>${escape(previewLabel)}</span>` : ''}</div>
${blocked ? blockedSummary(request, events, bySeq) : action ? `<div class="feature-current"><h2><a href="#event-${escape(action.seq)}">${escape(agentEvent(action))}</a></h2>${actionDetail ? `<p>${escape(concise(actionDetail, 160))}</p>` : ''}</div>` : ''}
${priorIssue ? `<p class="feature-repair"><a href="#event-${escape(priorIssue.seq)}">Last issue · ${escape(priorIssue.role)}</a> · ${escape(concise(priorIssue.reason, 135))}</p>` : ''}
${request.canResume ? `<form method="post" action="${path}/run"><button type="submit">${request.status === 'queued' ? 'Start queued request' : 'Resume request'}</button></form>` : ''}
${blocked ? `<a href="${requestsPath(project)}#new-request">Create a follow-up request</a>` : ''}
${request.status === 'completed' && delivery?.revision ? `<form method="post" action="${path}/preview"><button type="submit">${request.previewStatus === 'failed' ? 'Retry local preview' : 'Open current app'}</button></form>` : ''}</section>
${featureUsage(request, path, langfuseConfigured)}
${followUpQa(project, request, bySeq)}
${featureDag(request, events, path, { stageMetrics: stageUsage, story: featureStory(request, events) })}
<details class="feature-details" id="request-details"><summary>Run details</summary><dl class="request-facts">
${recordField('Request ID', escape(request.id))}${recordField('Stop reason', escape(request.reason))}${recordField('Submitted', time(request.createdAt))}${recordField('Started', time(request.startedAt))}
${recordField('Deadline', time(request.deadlineAt))}${recordField('Ended', time(request.endedAt))}${recordField('Phase', escape(phaseName(request.phase)))}
${request.plan?.base && request.predecessor?.revision === request.plan.base ? recordField('Built on delivery',
    `${predecessorLink(project, request.predecessor)}<br><code>${escape(request.predecessor.revision)}</code>`) : ''}
${recordField('Project directory', escape(delivery?.repoPath ?? candidate?.repoPath ?? request.repoPath))}
${candidate?.revision || request.revision ? recordField('Last built revision', `<code>${escape(candidate?.revision ?? request.revision)}</code>`) : ''}
${delivery?.branch ? recordField('Delivered branch', `<code>${escape(delivery.branch)}</code>`) : ''}
${delivery?.revision ? recordField('Delivered revision', `<code>${escape(delivery.revision)}</code>`) : ''}
</dl><a href="${path}/trace.json">Trace JSON</a></details></div>
<details class="technical-trace" id="technical-trace"><summary><span class="disclosure-title">Event log</span><span class="detail-hint">Tools, diffs and raw records</span></summary>
<section aria-labelledby="request-trace"><div class="trace-toolbar"><h2 id="request-trace">Execution trace</h2>
<fieldset class="trace-filter" data-trace-filter hidden><legend class="visually-hidden">Events shown</legend>
<label><input type="radio" name="trace-view" value="milestones" checked>Milestones</label><label><input type="radio" name="trace-view" value="all">All events</label></fieldset>
</div>
<ol class="request-trace trace-list" id="trace-events" data-live-append data-terminal="${terminal}">${events.map(event => eventRow(event, bySeq, project, request, calls.get(event.seq))).join('')}</ol>
${!events.length ? '<p class="muted" data-no-events>No events recorded yet.</p>' : ''}</section></details>
<dialog class="workflow-inspector" id="workflow-inspector" aria-labelledby="inspector-title">
  <header class="inspector-header">
    <div class="inspector-topline"><div class="inspector-location"><span class="inspector-request" title="${escape(title)}">${escape(title)}</span><span class="inspector-context" data-inspector-context></span></div>
      <button type="button" data-inspector-close aria-label="Close step details"><span aria-hidden="true">×</span> Close</button></div>
    <div class="inspector-heading"><h2 id="inspector-title" tabindex="-1"></h2><span class="inspector-status" data-inspector-status></span></div>
    <p class="inspector-performer">Run by <strong data-inspector-performer></strong></p>
  </header>
  <div class="inspector-scroll" data-inspector-scroll data-inspector-body></div>
</dialog></main>`);
}
