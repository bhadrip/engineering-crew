import { escape } from './views.mjs';
import { planSynopsis, renderFeaturePlan } from './feature-plan.mjs';

const checks = ['qa', 'reviewer', 'security'];
const checkNames = { qa: 'QA', reviewer: 'code review', security: 'security' };
const list = new Intl.ListFormat('en', { type: 'conjunction' });
const ended = request => ['completed', 'blocked'].includes(request.status);

function brief(text, limit = 150) {
  if (typeof text !== 'string') return '';
  const line = text.trim().replace(/\s+/g, ' ');
  if (line.length <= limit) return line;
  return line.slice(0, limit - 1).replace(/\s+\S*$/, '').trimEnd() + '…';
}

function eventLink(event, label) {
  return Number.isSafeInteger(event?.seq) && event.seq > 0
    ? `<a href="#event-${event.seq}">${escape(label)}</a>` : '';
}

function links(items) {
  const present = items.filter(Boolean);
  return present.length ? `<div class="journey-links">${present.join(' ')}</div>` : '';
}

function reviewResult(events, role, revision, requireRevision) {
  const event = events.findLast(e => e.role === role && ['task.completed', 'task.failed', 'task.started', 'task.resumed'].includes(e.type));
  if (!event) return null;
  const evidence = event.evidence ?? {};
  const checkedRevision = evidence.revision ?? event.revision;
  if (revision && checkedRevision && checkedRevision !== revision) {
    return { event, verdict: 'Different build', tone: 'neutral', note: 'This check refers to another revision.' };
  }
  if (event.type === 'task.failed') return { event, verdict: 'Stopped', tone: 'warning', note: brief(evidence.message) };
  if (event.type !== 'task.completed') return { event, verdict: 'Started', tone: 'neutral' };
  if (requireRevision && !checkedRevision) return { event, verdict: 'Result unavailable', tone: 'neutral', note: 'This result has no recorded build revision.' };
  if (evidence.passed === true) return { event, verdict: 'Passed', tone: 'success' };
  if (evidence.passed !== false) return { event, verdict: 'Result unavailable', tone: 'neutral' };
  const issues = Array.isArray(evidence.checks) ? evidence.checks.filter(check => check?.passed === false && typeof check.check === 'string') : [];
  const finding = Array.isArray(evidence.findings) && evidence.findings[0];
  const note = issues.length ? issues.map(check => check.check).join(' · ')
    : (typeof finding === 'string' ? finding : finding?.message || finding?.title) || evidence.summary;
  return { event, verdict: 'Failed', tone: 'warning', note: brief(note) };
}

function checkOutcome(results, verified, repair, working, paused) {
  const findings = new Map();
  for (const { verdict, event } of results) {
    if (!findings.has(verdict)) findings.set(verdict, []);
    findings.get(verdict).push(checkNames[event.role]);
  }
  if (findings.has('Failed') || findings.has('Stopped')) {
    const sentences = [];
    for (const [verdict, verb] of [['Failed', 'failed'], ['Stopped', 'stopped before returning a verdict'], ['Passed', 'passed']]) {
      if (findings.has(verdict)) {
        const subject = list.format(findings.get(verdict));
        sentences.push(subject[0].toUpperCase() + subject.slice(1) + ' ' + verb + '.');
      }
    }
    return [findings.has('Failed') ? 'Checks failed' : 'Checks stopped', 'warning', sentences.join(' ')];
  }
  if (repair) return ['Changes needed', 'warning', 'Crew requested another revision before delivery.'];
  if (verified || (results.length === checks.length && results.every(result => result.verdict === 'Passed'))) {
    return ['Checks passed', 'success', 'The build passed independent verification.'];
  }
  if (!working || results.some(result => ['Different build', 'Result unavailable'].includes(result.verdict))) {
    return ['Checks incomplete', 'neutral', 'A revision was produced. Crew has no complete set of check results for it.'];
  }
  if (paused) return ['Checks paused', 'neutral', 'A revision was produced. The checks are waiting for the worker to resume.'];
  if (results.length) return ['Checks running', 'active', 'Independent checks are under way on this revision.'];
  return ['Awaiting checks', 'neutral', 'The engineer produced a revision for independent checks.'];
}

export function buildOutcome(request, number, events) {
  const build = events.find(e => e.role === 'engineer' && ['task.completed', 'task.failed'].includes(e.type));
  const failure = build?.type === 'task.failed';
  const built = build?.type === 'task.completed' && typeof build.evidence?.revision === 'string' && Boolean(build.evidence.revision.trim());
  const afterBuild = built ? events.filter(e => e.seq > build.seq) : events;
  const verified = afterBuild.find(e => e.type === 'candidate.verified' && (!built || (e.evidence?.revision ?? e.revision) === build.evidence.revision));
  const repair = afterBuild.find(e => e.type === 'repair.requested');
  const results = checks.map(role => reviewResult(afterBuild, role, build?.evidence?.revision, number > 1)).filter(Boolean);
  const working = request.status === 'running' && request.attempt === number;
  let tone = 'neutral', status = 'Started', description = 'The engineer began work on this build.';
  if (failure) {
    tone = 'warning';
    status = 'Stopped';
    description = /exhausted its workspace turn budget/.test(build.evidence?.message)
      ? 'The engineer ran out of steps before finishing a tested build.' : brief(build.evidence?.message) || 'The engineer stopped before producing a build.';
  } else if (built) {
    [status, tone, description] = checkOutcome(results, verified, repair, working, request.canResume);
    // The first build records implementation. A repair addresses outstanding
    // findings, so its outcome follows verification of the revised candidate.
    if (number === 1) {
      status = 'Succeeded';
      tone = 'success';
    }
  } else if (build || verified || results.length || repair) {
    status = 'Result unavailable';
    description = 'The engineer’s recorded work has no build revision.';
  } else if (request.canResume && working) {
    status = 'Paused';
    description = 'Work on this attempt is waiting for the worker to resume.';
  } else if (working) {
    tone = 'active';
    status = 'In progress';
    description = number === 1 ? 'The engineer is implementing the plan.' : 'The engineer is working through the earlier findings.';
  } else if (ended(request)) {
    status = 'Stopped';
    tone = 'warning';
    description = 'The request ended before a build was recorded for this attempt.';
  }
  return { status, tone, description, build, built, failure, results, verified, repair };
}

const paragraph = value => typeof value === 'string' && value.trim() ? '<p>' + escape(value.trim()) + '</p>' : '';
const recordedText = value => typeof value === 'string' ? value.trim() : '';
const array = value => Array.isArray(value) ? value : [];
const revisionOf = event => event?.evidence?.revision ?? event?.revision;
const reportText = finding => typeof finding === 'string' ? finding : finding?.message || finding?.title;
const failed = check => check?.passed === false && check.status !== 'skipped';

function healthDiagnostic(text) {
  if (typeof text !== 'string') return text;
  const health = /^(GET \/health returned HTTP [1-5]\d{2}) \((\{[\s\S]*\})\)$/.exec(text.trim());
  if (!health) return text;
  try {
    const body = JSON.parse(health[2]);
    const message = [body.error, body.error?.message, body.message].find(value => typeof value === 'string' && value.trim());
    if (message) return health[1] + '. ' + message.trim();
  } catch {
    // The runtime bounds response bodies, so the saved JSON may be incomplete.
  }
  return text;
}

// Extract observations from failed checks. An author’s description of a test
// is not its result, and a passing test's TAP output cannot explain a failure.
function checkReasons(record) {
  if (!record || typeof record !== 'object') return [];
  const reasons = [];
  const broken = array(record.checks).filter(failed).sort((a, b) => Number(b.check === 'HTTP /health') - Number(a.check === 'HTTP /health'));
  for (const check of broken) {
    const detail = checkReasons(check);
    reasons.push(...(detail.length ? detail : [check.check || check.name || 'A recorded check failed']));
  }
  if (typeof record.evidence === 'object') reasons.push(...checkReasons(record.evidence));
  for (const lesson of array(record.lessons).filter(failed)) {
    const labels = { fullRenditionMatched: 'full song boundaries', correctionMatched: 'spoken correction',
      phrasePaired: 'linked practice phrase', sameAudio: 'original audio replay', saved: 'lesson persistence' };
    const missed = Object.entries(lesson).filter(([field, value]) => field !== 'passed' && value === false)
      .map(([field]) => labels[field] ?? field.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase());
    reasons.push((lesson.fixture || 'Fixture') + ' failed' + (missed.length ? ' checks for ' + list.format(missed) : ''));
  }
  reasons.push(...array(record.findings).map(reportText));
  const diagnostic = record.error || record.message || (typeof record.evidence === 'string' && record.evidence);
  if (diagnostic) reasons.push(healthDiagnostic(diagnostic));
  if (!reasons.some(Boolean) && typeof record.output === 'string') {
    const lines = record.output.split('\n').map(s => s.trim());
    const line = lines.find(s => /^(?:not ok\b|✖|Error:)/.test(s));
    if (line) reasons.push(line.replace(/^not ok\s+\d+\s*-\s*/, ''));
    const error = lines.find(s => /^error:\s+[^|>]/i.test(s));
    if (error) reasons.push(error.replace(/^error:\s+/i, ''));
  }
  if (!reasons.some(Boolean) && failed(record)) reasons.push(record.reason);
  return [...new Set(reasons.map(recordedText).filter(Boolean))];
}

export function checkFailures(record) {
  return [...new Set(checkReasons(record).map(reason => brief(reason, 220)))];
}

function checkReceiptName(e) {
  if (e.type === 'app.healthy' || e.type === 'app.unhealthy') return 'HTTP /health';
  if (e.type === 'app.probe.completed') return e.evidence?.check;
  if (e.type === 'app.test.completed' && Array.isArray(e.evidence?.command)) {
    const args = e.evidence.command;
    if (args[0] !== 'node' || !args.includes('--test')) return '';
    if (args.includes('/crew-tests/acceptance.test.mjs')) return 'Independent QA tests';
    if (args.slice(1).every(arg => typeof arg === 'string' && arg.startsWith('--'))) return 'Author tests';
  }
  return '';
}

function qaChecks(node, events) {
  const { event } = node;
  const revision = revisionOf(event);
  const recorded = new Map(array(event.evidence?.checks).filter(c => typeof c?.check === 'string').map(c => [c.check, c]));
  const checks = new Map([...recorded].map(([name, check]) => [name, { check }]));
  // Attach each receipt to the exact role, operation, revision, and test
  // command. The QA agent runs the author's suite and its own test concurrently.
  for (const e of events) {
    if (!revision || revisionOf(e) !== revision || e.role !== 'qa' || e.attempt !== event.attempt ||
        (e.operationId && event.operationId && e.operationId !== event.operationId) ||
        (e.seq > event.seq && !['task.started', 'task.resumed'].includes(event.type))) continue;
    const name = checkReceiptName(e);
    if (!name) continue;
    const result = recorded.get(name);
    const receipt = { ...e.evidence, check: name };
    if (e.type === 'app.healthy') receipt.passed = true;
    if (e.type === 'app.unhealthy') receipt.passed = false;
    if (result && (result.status === 'skipped' || (typeof result.passed === 'boolean' && result.passed !== receipt.passed) ||
        ['output', 'evidence'].some(field => typeof result[field] === 'string' && typeof receipt[field] === 'string' && result[field] !== receipt[field]))) continue;
    checks.set(name, { check: { ...receipt, ...result }, event: e });
  }
  return [...checks.values()];
}

function failedCheckLine(check) {
  const diagnostic = checkReasons(check)[0];
  if (!diagnostic) return check.check + ' failed.';
  return check.check === 'HTTP /health' && /\/health\b/i.test(diagnostic) ? diagnostic : check.check + ' · ' + diagnostic;
}

function revisionSummary(evidence) {
  if (typeof evidence.revision !== 'string' || !evidence.revision.trim()) return '';
  const count = Array.isArray(evidence.filesChanged) ? evidence.filesChanged.length : null;
  return 'Produced revision ' + evidence.revision.slice(0, 10) + (count === null ? '.' : ' with ' + count + (count === 1 ? ' changed file.' : ' changed files.'));
}

// A card can use a short excerpt. The inspector gets the full recorded conclusion.
function stepConclusion(node, request, events) {
  const { key, event, status } = node;
  const e = event.evidence ?? {};
  if (key.startsWith('build-')) {
    if (event.type === 'task.completed' && revisionSummary(e)) {
      if (event.attempt > 1 && ['Checks failed', 'Checks stopped'].includes(status)) {
        return buildOutcome(request, event.attempt, events.filter(item => item.attempt === event.attempt)).description;
      }
      return recordedText(e.summary) || revisionSummary(e);
    }
    if (event.type === 'task.failed' && /exhausted its workspace turn budget/.test(e.message)) return 'The engineer ran out of steps before finishing a tested build.';
    return recordedText(e.message);
  }
  if (checks.includes(event.role)) {
    if (status === 'Different build') return 'This result refers to a different build revision.';
    if (status === 'Result unavailable' && event.type === 'task.completed') return 'Crew could not confirm a verdict for this build.';
    if (event.type === 'task.failed') return recordedText(e.message) || 'The agent stopped before returning a verdict.';
    if (event.role === 'qa') {
      const rows = qaChecks(node, events);
      const broken = rows.filter(r => failed(r.check));
      const primary = broken.find(r => r.check.check === 'HTTP /health') ?? broken[0];
      if (primary) return failedCheckLine(primary.check);
      const skipped = rows.find(r => r.check.status === 'skipped');
      if (skipped) return skipped.check.check + ' skipped' + (skipped.check.reason ? ' · ' + skipped.check.reason : '.');
      if (e.passed === true && rows.length && rows.every(r => r.check.passed === true)) return rows.length + (rows.length === 1 ? ' recorded check passed.' : ' recorded checks passed.');
      if (e.passed === false) return checkReasons(e)[0] || 'QA recorded a failed verdict. No failing check was identified.';
      if (e.passed === true) return 'QA recorded a passing verdict.';
      return '';
    }
    const finding = array(e.findings).map(reportText).map(recordedText).find(Boolean);
    return recordedText(e.summary) || finding ||
      (e.passed === true && Array.isArray(e.findings) && !e.findings.length ? 'The reviewer reported no findings.' : '');
  }
  if (key === 'planning') {
    if (event.type === 'task.failed') return recordedText(e.message);
    const plan = e.plan ?? request.plan;
    const counts = [['steps', 'implementation step'], ['acceptance', 'acceptance check']].flatMap(([key, name]) => {
      const size = array(plan?.[key]).filter(s => typeof s === 'string' && s.trim()).length;
      return size ? [size + ' ' + name + (size === 1 ? '' : 's')] : [];
    });
    return counts.length ? 'The plan contains ' + list.format(counts) + '.' : planSynopsis(plan);
  }
  if (key.startsWith('retry-')) {
    const recorded = array(e.feedback).flatMap(item => checkReasons(item));
    return recorded[0] || 'The controller requested another revision.';
  }
  if (event.type === 'request.blocked') return recordedText(e.message || request.reason) || 'Crew stopped before releasing this change.';
  if (key === 'intake') return recordedText(e.goal || request.goal);
  if (key.startsWith('verified-')) return node.tone === 'success' ? 'The controller accepted the verification results for this build.' : 'The verification record could not be matched to this build.';
  return recordedText(e.message || e.summary);
}

export function workflowStepFinding(node, request, events) {
  return brief(stepConclusion(node, request, events));
}

function agentOutput(id, content, findingCount = 0) {
  const count = findingCount ? ' · ' + findingCount + (findingCount === 1 ? ' finding' : ' findings') : '';
  return content ? '<details class="step-agent-output" id="' + id + '"><summary>Agent output' + count + '</summary>' + content + '</details>' : '';
}

function modelResponses(path, task, history) {
  if (!path) return '';
  const calls = history.filter(e => e.type === 'agent.completed' && e.evidence?.outputDigest &&
    (!task.operationId || !e.operationId || e.operationId === task.operationId) &&
    (['task.started', 'task.resumed'].includes(task.type) || e.seq <= task.seq));
  if (!calls.length && task.evidence?.receipt?.outputDigest) calls.push(task);
  const responses = calls.map(e => '<a href="' + escape(path) + '/events/' + e.seq + '/input#agent-output">Model response #' + e.seq + '</a>');
  return responses.length > 1 ? '<details id="responses-' + task.seq + '"><summary>Model responses (' + responses.length + ')</summary>' + links(responses) + '</details>' : links(responses);
}

function buildDetails(node, request, events, path, metrics) {
  const { event } = node;
  const { attempt } = event;
  const history = events.filter(e => e.attempt === attempt);
  const author = history.filter(e => e.role === 'engineer');
  const { description, build, built, failure } = buildOutcome(request, attempt, history);
  const tests = built && author.findLast(e => e.type === 'app.test.completed' && e.seq < build.seq &&
    revisionOf(e) === build.evidence.revision && typeof e.evidence?.passed === 'boolean');
  const probe = author.findLast(e => e.type === 'app.probe.completed' && typeof e.evidence?.passed === 'boolean');
  const probeLabel = built && revisionOf(probe) !== build.evidence.revision ? 'Earlier app check' : 'App check';
  const previous = node.parents?.find(parent => parent.key.startsWith('retry-'));
  const diff = built && build.evidence.base && path ? '<a href="' + escape(path) + '/attempts/' + attempt + '/changes">View code changes</a>' : '';
  const lastAction = !built && author.findLast(e => e.type === 'tool.completed' && typeof e.evidence?.summary === 'string' && e.evidence.summary.trim());
  const note = built ? build.evidence.summary : lastAction?.evidence?.summary;
  const changed = built && array(build.evidence.filesChanged).filter(file => typeof file === 'string');
  const files = changed?.length ? '<h4>Changed files</h4><ul>' + changed.map(f => '<li><code>' + escape(f) + '</code></li>').join('') + '</ul>' : '';
  const source = built ? '' : eventLink(lastAction, 'Last recorded action');
  const conclusion = stepConclusion(node, request, events) || description;
  const scope = built ? revisionSummary(build.evidence) : '';
  return {
    conclusion,
    content: (description !== conclusion ? paragraph(description) : '') + links([diff]) +
      agentOutput('engineer-note-' + attempt, paragraph(note) + files + source + modelResponses(path, event, author)),
    technical: (scope !== conclusion ? paragraph(scope) : '') +
      links([tests && eventLink(tests, 'Build tests ' + (tests.evidence.passed ? 'passed' : 'failed')),
      probe && eventLink(probe, probeLabel + (probe.evidence.passed ? ' passed' : ' failed')),
      eventLink(previous?.event, 'Why this repair started'), eventLink(event, failure ? 'Why the build stopped' : 'Build record')]) +
      metrics('attempt-' + attempt, author),
  };
}

function checkBreakdown(node, rows) {
  if (!rows.length) return '';
  const statuses = rows.map(({ check, event }, index) => {
    const skipped = check.status === 'skipped';
    const result = skipped ? 'skipped' : check.passed === true ? 'passed' : check.passed === false ? 'failed' : 'unknown';
    const verdict = { passed: 'Passed', failed: 'Failed', skipped: 'Skipped', unknown: 'No verdict' }[result];
    const reasons = failed(check) ? checkReasons(check) : [];
    const command = failed(check) && Array.isArray(check.command) && check.command.every(arg => typeof arg === 'string')
      ? '<p><code>' + escape(check.command.join(' ')) + '</code>' + (Number.isInteger(check.exitCode) ? ' · Exit ' + check.exitCode : '') + '</p>' : '';
    const info = reasons.map(paragraph).join('') + command;
    const source = eventLink(event, 'Check receipt');
    const name = escape(check.check) + ' · ' + verdict;
    return '<li data-result="' + result + '">' + (info || source ? '<details class="step-check-detail" id="check-' + node.key + '-' + (index + 1) + '"><summary>' +
      name + '</summary>' + info + source + '</details>' : name) + (skipped ? paragraph(check.reason) : '') + '</li>';
  });
  return '<h4>QA checks</h4><ul class="step-checks">' + statuses.join('') + '</ul>';
}

function checkDetails(node, request, events, path, metrics) {
  const { event } = node;
  const history = events.filter(e => e.attempt === event.attempt && e.role === event.role);
  const evidence = event.evidence ?? {};
  const qa = event.role === 'qa', rows = qa ? qaChecks(node, events) : [];
  const revision = revisionOf(event);
  const scope = typeof revision === 'string' && revision.trim() ? '<p class="step-revision">Build revision <code>' + escape(revision.slice(0, 10)) + '</code></p>' : '';
  const findings = array(evidence.findings).map(reportText).filter(s => typeof s === 'string' && s.trim());
  const authored = qa && typeof evidence.independentTest === 'string' && evidence.independentTest.trim() ?
    '<details id="qa-source-' + event.seq + '"><summary>QA-authored test source</summary><pre><code>' + escape(evidence.independentTest) + '</code></pre></details>' : '';
  const conclusion = stepConclusion(node, request, events);
  const summary = findings.length && recordedText(evidence.summary) === conclusion ? '' : paragraph(evidence.summary);
  const report = summary + (findings.length ? '<h4>Findings</h4><ul class="workflow-findings">' +
    findings.map(text => '<li>' + escape(text) + '</li>').join('') + '</ul>' :
    Array.isArray(evidence.findings) ? paragraph('No findings reported.') : '') + authored + modelResponses(path, event, history);
  return {
    conclusion,
    content: checkBreakdown(node, rows) + agentOutput('output-' + node.key, report, findings.length),
    technical: scope + links([eventLink(event, 'Check record')]) + metrics(node.key, history),
  };
}

export function workflowStepDetails(node, request, events, path, metrics) {
  const { key, event } = node;
  const evidence = event.evidence ?? {};
  if (key.startsWith('build-')) return buildDetails(node, request, events, path, metrics);
  if (checks.includes(event.role)) return checkDetails(node, request, events, path, metrics);
  const conclusion = stepConclusion(node, request, events);
  if (key === 'planning') {
    const history = events.filter(e => e.role === 'planner' || (e.phase === 'plan' && !e.type.startsWith('request.')));
    const stopped = events.find(e => e.type === 'request.blocked' && e.parents?.includes(event.seq));
    const plan = evidence.plan ?? request.plan;
    const detail = event.type === 'task.failed' ? '' : plan || event.type === 'task.completed'
      ? renderFeaturePlan(plan, { id: 'journey-plan', goal: request.goal })
      : paragraph(request.canResume ? 'Planning is waiting for the worker to resume.' : 'The planner is preparing the implementation steps and acceptance checks.');
    return { conclusion, content: detail, technical: modelResponses(path, event, history) +
      links([eventLink(event, 'Planning record'), eventLink(stopped, 'Stop decision')]) + metrics('planning', history) };
  }
  if (key === 'intake') return { conclusion, technical: links([eventLink(event, 'Request record')]) };
  if (key.startsWith('retry-')) {
    const feedback = array(evidence.feedback);
    const notes = feedback.map(f => f?.summary || f?.message).filter(s => typeof s === 'string' && s.trim());
    return { conclusion, content: notes.length ? '<details class="step-check-detail" id="feedback-' + key + '"><summary>Feedback to the engineer</summary>' +
      notes.map(paragraph).join('') + '</details>' : '', technical: links([eventLink(event, 'Repair decision')]) };
  }
  if (key.startsWith('verified-')) return { conclusion, technical: links([eventLink(event, 'Verification record')]) };
  if (key === 'preview') return { conclusion, technical: links([eventLink(event, 'Preview record')]) };
  const history = events.filter(e => e.phase === 'promote' || e.type === 'request.completed' || e.type === 'request.blocked');
  if (event.type === 'request.blocked') {
    const failure = history.findLast(e => e.type === 'task.failed' && event.parents?.includes(e.seq));
    return { conclusion, technical: links([eventLink(failure, 'Why delivery stopped'), eventLink(event, 'Stop decision')]) + metrics('delivery', history) };
  }
  return { conclusion, technical: links([eventLink(event, 'Delivery record')]) + metrics('delivery', history) };
}
