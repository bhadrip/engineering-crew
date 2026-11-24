import { escape } from './views.mjs';
import { planSynopsis } from './feature-plan.mjs';
import { buildName, featureAction, featureRole } from './feature-language.mjs';
import { buildOutcome, workflowStepDetails, workflowStepFinding } from './feature-journey.mjs';

const reviews = new Set(['qa', 'reviewer', 'security']);
const taskTypes = new Set(['task.started', 'task.resumed', 'task.completed', 'task.failed']);
const endTypes = new Set(['task.completed', 'task.failed']);

function milestone(event) {
  const { type, role, attempt } = event;
  if (type === 'request.created') return ['intake', 'intake', 'intake'];
  if (type === 'request.blocked') return ['stop', 'promote', 'stop'];
  if (type === 'request.completed') return ['delivery', 'promote', 'delivery'];
  if (type === 'app.preview.ready' || type === 'app.preview.failed') return ['preview', 'preview', 'preview'];
  if (role === 'planner' && taskTypes.has(type)) return ['planning', 'plan', 'planning'];
  if (!Number.isSafeInteger(attempt) || attempt < 1) return null;
  if (type === 'repair.requested') return ['retry-' + attempt, 'repair', 'retry-' + attempt];
  if (type === 'candidate.verified') return ['verified-' + attempt, 'verify', 'verified-' + attempt];
  if (!taskTypes.has(type)) return null;
  if (role === 'engineer') return ['build-' + attempt, 'build', 'build-' + attempt];
  if (reviews.has(role)) return [role + '-' + attempt, role, 'checks-' + attempt];
  if (role === 'controller' && event.phase === 'promote') return ['delivery', 'promote', 'delivery'];
  return null;
}

function state(node, request, byKey, attempts) {
  const { key, event } = node;
  const { type, evidence, attempt } = event;
  if (key.startsWith('build-')) {
    const { status, tone } = buildOutcome(request, attempt, attempts.get(attempt));
    return [status, tone];
  }
  const revision = byKey.get('build-' + attempt)?.event.evidence?.revision;
  const checkedRevision = evidence?.revision ?? event.revision;
  if ((type === 'candidate.verified' || reviews.has(event.role)) && revision && checkedRevision && checkedRevision !== revision) {
    return ['Different build', 'neutral'];
  }
  if (attempt > 1 && !checkedRevision && (type === 'candidate.verified' || (type === 'task.completed' && reviews.has(event.role)))) {
    return ['Result unavailable', 'neutral'];
  }
  if (type === 'request.created') return ['Received', 'neutral'];
  if (type === 'request.blocked') return ['No release', 'warning'];
  if (type === 'request.completed') return ['Released', 'success'];
  if (type === 'repair.requested') return ['Changes requested', 'warning'];
  if (type === 'candidate.verified') return ['Checks passed', 'success'];
  if (type === 'app.preview.ready') return ['Ready', 'success'];
  if (type === 'app.preview.failed') return ['Failed to start', 'warning'];
  if (type === 'task.failed') return ['Stopped', 'warning'];
  if (type === 'task.completed') {
    if (key === 'planning') return planSynopsis(evidence?.plan ?? request.plan) ? ['Succeeded', 'success'] : ['Result unavailable', 'neutral'];
    if (key === 'delivery') return ['Delivered', 'success'];
    if (evidence?.passed === true) return ['Passed', 'success'];
    if (evidence?.passed === false) return ['Failed', 'warning'];
    return ['Result unavailable', 'neutral'];
  }
  if (request.status === 'running' && request.attempt === attempt) {
    return request.canResume ? ['Paused', 'neutral'] : ['In progress', 'active'];
  }
  return ['Started', 'neutral'];
}

// Select one representative per operation. A completed task replaces its start.
// Collapsing *after* selection keeps the projected edges acyclic, even if an
// operation's start and finish surrounded a second operation.
function graph(request, sorted) {
  const byKey = new Map();
  for (const event of sorted) {
    const step = milestone(event);
    if (!step) continue;
    let [key, action, group] = step;
    if (key === 'stop' && byKey.has('delivery')) key = group = 'delivery';
    const old = byKey.get(key);
    if (old && endTypes.has(old.event.type) && ['task.started', 'task.resumed'].includes(event.type)) continue;
    byKey.set(key, { key, label: featureAction(action, event.attempt), group, event, parents: [], missing: false });
  }
  const nodes = [...byKey.values()].sort((a, b) => a.event.seq - b.event.seq);
  const attempts = Map.groupBy(sorted, event => event.attempt);
  const bySeq = new Map(nodes.map(node => [node.event.seq, node]));
  const ancestry = new Map();
  for (const event of sorted) {
    const parents = new Set();
    let missing = false;
    for (const seq of Array.isArray(event.parents) ? event.parents : []) {
      const upstream = ancestry.get(seq);
      if (!upstream || upstream.missing) missing = true;
      for (const parent of upstream?.parents ?? []) parents.add(parent);
    }
    const node = bySeq.get(event.seq);
    if (node) {
      node.parents = [...parents];
      node.missing = missing;
      [node.status, node.tone] = state(node, request, byKey, attempts);
    }
    ancestry.set(event.seq, node ? { parents: [node], missing: false } : { parents, missing });
  }
  return nodes;
}

// Display independent checks together only when the journal gives them a common
// predecessor. Other steps retain their natural topological order.
function levels(nodes) {
  const pending = new Set(nodes);
  const result = [];
  while (pending.size) {
    const ready = [...pending].filter(node => node.parents.every(parent => !pending.has(parent)));
    const first = ready[0];
    const commonParent = reviews.has(first.event.role) && first.parents.find(parent =>
      ready.some(node => node !== first && node.group === first.group && node.parents.includes(parent)));
    const group = commonParent ? ready.filter(node => node.group === first.group && node.parents.includes(commonParent)) : [first];
    if (group.length > 1) group.sort((a, b) => [...reviews].indexOf(a.event.role) - [...reviews].indexOf(b.event.role));
    result.push(group);
    for (const node of group) pending.delete(node);
  }
  return result;
}

function stageId(node) {
  if (node.key.startsWith('build-')) return 'stage-attempt-' + node.event.attempt;
  return 'stage-' + (node.key === 'stop' ? 'delivery' : node.key);
}

function stepName(node) {
  return reviews.has(node.event.role) || node.key.startsWith('retry-') || node.key.startsWith('verified-')
    ? node.label + ' for ' + buildName(node.event.attempt) : node.label;
}

function callEvidenceLink(event, events, path, settingsHref) {
  if (!settingsHref) return '';
  const matching = event.operationId ? events.filter(call => call.operationId === event.operationId && call.role === event.role &&
    call.attempt === event.attempt && ['agent.started', 'agent.completed'].includes(call.type) && call.evidence?.inputDigest) : [];
  const receipt = event.type === 'task.completed' ? event.evidence?.receipt : null;
  let seq;
  if (receipt?.inputDigest) {
    const recorded = receipt.callId && matching.findLast(call => call.evidence.callId === receipt.callId);
    seq = recorded?.seq ?? event.seq;
  } else {
    const calls = new Map(matching.map(call => [call.evidence.callId ?? call.seq, call.seq]));
    if (calls.size > 1) return '<p class="workflow-call-evidence"><a href="' + escape(settingsHref) + '">Codex prompts and launches</a></p>';
    [seq] = calls.values();
  }
  return seq ? '<p class="workflow-call-evidence"><a href="' + escape(path) + '/events/' + seq + '/input#call-input">Prompt and launch</a></p>' : '';
}

function step(node, children, request, events, path, metrics) {
  const { role = 'controller' } = node.event;
  const roleName = featureRole(role);
  const runBy = 'Run by: ' + roleName;
  const attempt = node.event.attempt;
  const context = Number.isSafeInteger(attempt) && attempt > 0 ? (attempt === 1 ? 'First build' : 'Repair ' + (attempt - 1)) : '';
  const result = node.status === 'Result unavailable' ? 'Unavailable' : node.status;
  const finding = node.tone === 'warning' && reviews.has(role) ? workflowStepFinding(node, request, events) : '';
  const settingsHref = role !== 'controller' && path ? path + '/agents?role=' +
    encodeURIComponent(role) + (Number.isSafeInteger(attempt) ? '&attempt=' + attempt : '') : '';
  const settings = settingsHref ? '<a class="workflow-agent-link" href="' + escape(settingsHref) + '">' + escape(roleName) + ' configuration and calls</a>' : '';
  const accessible = stepName(node) + '. ' + runBy + '. Result: ' + result + '.';
  const parents = node.parents.map(parent => '<a class="workflow-dependency" data-from="' + parent.key +
    '" data-to="' + node.key + '" href="#' + stageId(parent) + '">' + escape(stepName(parent)) + '</a>');
  const dependencies = parents.length ? '<p class="workflow-dependencies">Follows ' + parents.join(', ') + '.</p>' : '';
  const forward = children.map(child => {
    const label = child.event.type === 'request.blocked' ? 'Stop without release' : stepName(child);
    return '<a href="#' + stageId(child) + '">' + escape(label) + '</a>';
  });
  const next = forward.length ? '<p class="step-next"><strong>Next</strong> ' + forward.join(' · ') + '.</p>' : '';
  const missing = node.missing ? '<p class="workflow-missing">Some earlier events are unavailable.</p>' : '';
  const { conclusion, content = '', technical } = workflowStepDetails(node, request, events, path, metrics);
  const label = result === 'Failed' ? 'Why it failed' : 'Outcome';
  const lead = conclusion ? '<p class="step-outcome"><strong>' + label + '</strong> ' + escape(conclusion) + '</p>' : '';
  const evidence = technical + settings + dependencies + missing;
  const more = evidence ? '<details class="step-technical" id="technical-' + node.key + '"><summary>Technical details</summary>' + evidence + '</details>' : '';
  const calls = callEvidenceLink(node.event, events, path, settingsHref);
  return `<details class="workflow-step" id="${stageId(node)}" data-key="${node.key}" data-tone="${node.tone}" data-step-title="${escape(node.label)}" data-step-context="${escape(context)}" data-step-role="${escape(roleName)}" data-step-result="${escape(result)}">
<summary aria-label="${escape(accessible)}"><span class="workflow-action">${escape(node.label)}</span> <span class="workflow-owner">${escape(runBy)}</span> <span class="workflow-result">Result: ${escape(result)}</span>${finding ? `<span class="workflow-finding">${escape(finding)}</span>` : ''}</summary>
<div class="workflow-body">${lead}${next}${calls}${content}${more}<a class="stage-back" href="#workflow">Back to workflow</a></div></details>`;
}

const orderedEvents = events => events.filter(event => Number.isSafeInteger(event?.seq) && event.seq > 0).toSorted((a, b) => a.seq - b.seq);

export function featureStageResults(request, events = []) {
  const sorted = orderedEvents(events);
  return new Map(graph(request, sorted).map(node => [node.event.seq, {
    label: stepName(node), status: node.status, href: '#' + stageId(node),
    summary: workflowStepFinding(node, request, sorted),
  }]));
}

export function featureDag(request, events = [], path = '', { stageMetrics = () => '', story = '' } = {}) {
  const sorted = orderedEvents(events);
  const groups = levels(graph(request, sorted));
  const ordered = groups.flat();
  const body = groups.map((nodes, index) => {
    const first = nodes[0];
    const branch = nodes.length > 1;
    const join = nodes.some(node => node.parents.length > 1);
    const previous = groups[index - 1] ?? [];
    const connected = nodes.some(node => node.parents.some(parent => previous.includes(parent)));
    const classes = ['workflow-level', branch && 'workflow-branches', join && 'workflow-join', connected && 'workflow-connected'].filter(Boolean);
    const label = branch ? '<h3 class="workflow-branch-label">Independent checks <span>for ' + escape(buildName(first.event.attempt)) + '</span></h3>' : '';
    return '<li class="' + classes.join(' ') + '" data-level="' + index + '" data-count="' + nodes.length + '">' + label +
      nodes.map(node => step(node, ordered.filter(child => child.parents.includes(node)), request, sorted, path, stageMetrics)).join('') + '</li>';
  });
  const empty = request.status === 'queued' ? 'The workflow appears when Crew records its first stage.' : 'Step records are unavailable for this request.';
  const switcher = body.length ? `<div class="workflow-switch" role="group" aria-label="Workflow layout" hidden>
<button type="button" data-workflow-layout="graph" aria-pressed="false" aria-controls="workflow-canvas">DAG</button>
<button type="button" data-workflow-layout="list" aria-pressed="true" aria-controls="workflow-canvas">List</button></div>` : '';
  const hint = story ? '<details id="workflow-summary" class="workflow-recap"><summary>What happened in this run</summary>' + story + '</details>' : '<p class="workflow-hint">Open a step to see its evidence.</p>';
  const content = body.length ? `${hint}
<div class="workflow-canvas" id="workflow-canvas"><svg class="workflow-wires" aria-hidden="true" focusable="false">
<defs><marker id="workflow-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto"><path d="M1 1L7 4L1 7" fill="none" stroke="currentColor" stroke-linejoin="round"/></marker></defs><g></g></svg>
<ol class="workflow-levels">${body.join('')}</ol></div>`
    : '<p class="workflow-hint">' + empty + '</p>';
  return '<section class="feature-workflow" id="workflow" tabindex="-1" aria-labelledby="workflow-heading"><header class="workflow-header"><h2 id="workflow-heading">Workflow</h2>' + switcher + '</header>' + content + '</section>';
}
