import { createHash } from 'node:crypto';
import { currentAttempt } from '../lib/attempts.mjs';
import { artifactOutputKinds, browserActivitySlot, isBrowserOutput, isImageOutput, isRuntimeEvidenceSlot } from '../lib/workflow-artifacts.mjs';
import { describeCodexLaunch, formatCodexLaunch } from '../lib/feature-codex-command.mjs';
import { agentConversationHistory, agentMessageLimit, canAllowAdditionalAttempt, canReuseCodexHistory, infrastructureRetry, packetAttemptsUsed,
  workflowAnswerLimit, workflowAttemptLimit } from '../lib/workflow-session.mjs';
import { approvalReviewLabel } from '../lib/workflow-approvals.mjs';
import { approvalModes, codexServiceTierLabel, webSearchModes, workspaceModes } from '../lib/workflow-native.mjs';
import { conditionOperators } from '../lib/workflow-routing.mjs';
import { readWorkspaceArtifact } from '../lib/workflow-workspace.mjs';
import { verifiedTraceLink } from '../lib/langfuse.mjs';
import { isProvisioning, resourceWait } from '../lib/resources.mjs';
import { nativeSkillChoices } from '../lib/workflow-skills.mjs';
import { listGeneratedImagesDefinition, listGeneratedImagesTool, workflowSubmissionTools,
  workspaceCheckpointDefinition, workspaceCheckpointTool } from '../lib/workflow-submissions.mjs';

export const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function skillInvocationChoices(field, choices, selected = []) {
  return choices.map(({ number, name, value = number }) => `<label class="configuration-tool">
    <input type="checkbox" name="${escape(field)}" value="${escape(value)}"${selected.includes(value) ? ' checked' : ''}>
    <span>${escape(name)}</span></label>`).join('');
}

export function agentImageField() {
  return `<div class="agent-image-field"><label class="agent-field">Attach images
    <input type="file" name="turn-image" accept="image/png,image/jpeg" multiple></label>
    <p class="agent-field-hint">Add up to four PNG or JPEG images, 4 MiB each and 6 MiB total.</p></div>`;
}

export function layout(title, body, running = false) {
  const live = running ? ' data-live-run="' + createHash('sha256').update(body).digest('hex') + '"' : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
${running ? '<noscript><meta http-equiv="refresh" content="3"></noscript>' : ''}<title>${escape(title)}</title>
<link rel="stylesheet" href="/crew.css"><script src="/crew.js" defer></script></head><body${live}>${body}</body></html>`;
}

function status(attempt, agentRun = false) {
  if (!attempt) return agentRun ? ['Ready to run', agentRun.draft ? 'The prompt and tested definition are recorded.' :
    'The prompt and agent version are saved.', 'neutral'] :
    ['Ready to dispatch', 'The assignment has inputs and is ready to start.', 'neutral'];
  if (attempt.outcome === 'check-failed' && !attempt.decision) {
    return [attempt.workspaceChecksStartedAt ? 'Local acceptance checks failed' : 'Docker checks failed',
      attempt.error ?? 'Open the check receipt for the observed results.', 'warning'];
  }
  if ((attempt.result?.state === 'completed' || attempt.resourceIds?.length) && attempt.evidenceStatus === 'missing') {
    return ['Evidence incomplete', 'A required output or execution receipt is missing or no longer matches the record.', 'warning'];
  }
  if (!attempt.decision && attempt.reviewFindings?.some(finding => finding.severity === 'blocker')) {
    return ['Implementation blocked', 'Review the findings and decide whether to request a fix loop.', 'warning'];
  }
  if (attempt.decision?.disposition === 'accepted') return [attempt.decision.source === 'workflow' ? 'Automatically accepted' :
    agentRun ? 'Result accepted' : 'Handoff accepted', attempt.decision.note, 'success'];
  if (attempt.decision?.disposition === 'rework') return ['Rework requested', attempt.decision.note, 'warning'];
  if (attempt.outcome === 'running') {
    if (attempt.workerStatus === 'disconnected')
      return ['Workflow worker disconnected', 'Recover the handoff to close this attempt and choose how to continue.', 'warning'];
    if (attempt.workspaceChecksStartedAt) return ['Running local acceptance checks', 'Crew is testing the captured workspace in the pinned audio runtime.', 'neutral'];
    if (attempt.codexSession?.actions.some(item => item.kind === 'approval' && item.status === 'waiting'))
      return ['Codex needs approval', 'Review the requested action to continue this turn.', 'warning'];
    const elicitation = attempt.codexSession?.actions.find(item => item.kind === 'elicitation' && item.status === 'waiting')?.elicitation;
    if (elicitation) return elicitation.mode === 'url'
      ? ['MCP tool requested a link', 'Review the destination and choose whether to open it.', 'warning']
      : ['MCP tool needs input', 'Complete or decline the tool’s form to continue this turn.', 'warning'];
    if (attempt.codexSession?.actions.some(item => item.kind === 'answer' && item.status === 'waiting' && item.blocking))
      return ['Codex needs input', 'Answer the questions to continue this turn.', 'warning'];
    return ['Codex is working', 'Activity updates while the attempt runs.', 'neutral'];
  }
  if (attempt.outcome === 'interrupted') return ['Codex turn stopped', attempt.error ?? 'The turn ended before a result was returned.', 'warning'];
  if (attempt.outcome === 'worker-disconnected') return ['Attempt recovered', attempt.error, 'warning'];
  if (attempt.outcome === 'history-unavailable') return ['Codex history unavailable', attempt.error, 'warning'];
  if (attempt.result?.state === 'completed') return agentRun ? ['Result ready', 'Open the result and the Codex activity.', 'neutral'] :
    ['Ready for review', 'Open the returned artifacts and record a decision.', 'neutral'];
  if (attempt.resourceIds?.length) return ['Paused for resources', attempt.result.summary, 'warning'];
  if (attempt.result?.state === 'blocked') return ['Agent reported a blocker', attempt.result.summary, 'warning'];
  return ['Attempt needs attention', attempt.error ?? attempt.result?.summary ?? 'Review the attempt before retrying.', 'warning'];
}

export const projectHref = project => `/projects/${encodeURIComponent(project.id)}`;
export function projectSkillHref(project, skill, version) {
  const query = new URLSearchParams();
  if (skill) query.set('skill', skill);
  if (version) query.set('version', version);
  return projectHref(project) + '/skills' + (query.size ? '?' + query : '');
}
export function projectAgentsHref(project, agent, run = false, version) {
  const query = new URLSearchParams();
  if (agent) query.set('agent', agent);
  if (run) query.set('run', '1');
  if (version !== undefined) query.set('version', version);
  return projectHref(project) + (project.id === 'music-transcribe' ? '/agents' : '/agent-library') + (query.size ? '?' + query : '');
}
const epicHref = (project, epic) => `${projectHref(project)}/epics/${encodeURIComponent(epic.id)}`;
export const workflowRunHref = (project, workflowId, runId, view = 'workflow') =>
  `${epicHref(project, { id: workflowId })}?run=${encodeURIComponent(runId)}&view=${encodeURIComponent(view)}`;
export const workflowSetupHref = (project, workflowId, version) =>
  projectHref(project) + '/workflows?' + new URLSearchParams({ workflow: workflowId, version, setup: '1' });
export function revisionComparisonHref(project, kind, { id, from, to, test } = {}) {
  const query = new URLSearchParams();
  if (id) query.set(kind, id);
  if (from) query.set('from', from);
  if (to) query.set('to', to);
  if (test) query.set('test', test);
  return `${projectHref(project)}/${kind === 'agent' ? 'agents' : 'workflows'}/compare${query.size ? '?' + query : ''}`;
}
const runHref = run => `/runs/${encodeURIComponent(run)}`;
export const taskHref = (run, task) => `${runHref(run)}/tasks/${encodeURIComponent(task)}`;
export const artifactHref = (run, id, task) => `${runHref(run)}/artifacts/${encodeURIComponent(id)}${task ? `?task=${encodeURIComponent(task)}` : ''}`;
const epicViewHref = (run, view, hash = '') => `${epicHref(run.project, run.epic)}?run=${encodeURIComponent(run.id)}&amp;view=${encodeURIComponent(view)}${hash}`;
const pipelineHref = (run, step) => `${epicViewHref(run, 'workflow')}${step ? `&amp;step=${encodeURIComponent(step)}#handoff-details` : '#pipeline'}`;
const searchIcon = '<svg class="icon" viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.25"/><path d="m12.5 12.5 4 4"/></svg>';
const arrow = '<span class="row-arrow" aria-hidden="true">→</span>';

function matches(query, values) {
  const haystack = values.filter(value => typeof value === 'string').join(' ').toLocaleLowerCase();
  return query.toLocaleLowerCase().split(/\s+/).every(word => haystack.includes(word));
}

export function timestamp(value) {
  if (!value) return '—';
  return `<time data-local datetime="${escape(value)}">${escape(value.slice(0, 16).replace('T', ' '))} UTC</time>`;
}

export function stateBadge(label, tone) {
  return `<span class="state-badge ${tone}"><i aria-hidden="true"></i>${escape(label)}</span>`;
}

const stateLabels = { all: 'All statuses', triage: 'Awaiting triage', review: 'Ready for review', attention: 'Needs attention',
  running: 'In progress', accepted: 'Handoffs accepted', queued: 'Ready to start' };
const searchTypes = { all: 'All results', handoffs: 'Handoffs', artifacts: 'Artifacts', checks: 'Checks' };
const selectOptions = (options, selected) => Object.entries(options).map(([value, label]) =>
  `<option value="${value}"${value === selected ? ' selected' : ''}>${escape(label)}</option>`).join('');

export function runState(run) {
  const { accepted, running, review, attention } = run.handoffs;
  if (run.triagePending) return ['triage', 'Awaiting triage', 'warning'];
  if (run.workspaceDeliveryStatus?.published) return ['accepted', 'Published locally', 'success'];
  if (run.readyForProjectReview) return ['review', 'Ready for project review', 'success'];
  if (attention) return ['attention', 'Needs attention', 'warning'];
  if (running) return ['running', 'In progress', 'active'];
  if (review) return ['review', 'Handoff ready for review', 'active'];
  if (run.automation?.pending && accepted + (run.handoffs.skipped ?? 0) < run.handoffs.total) return ['running', 'Dispatch queued', 'active'];
  if (run.fix && accepted && accepted + (run.handoffs.skipped ?? 0) < run.handoffs.total) return ['running', 'In progress', 'active'];
  if (accepted) return ['accepted', 'Handoffs accepted', 'success'];
  return ['queued', 'Ready to start', 'neutral'];
}

function epicName(epic) {
  return epic.title.replace(/^epic\s+\d+\s*·\s*/i, '');
}

function epicCode(epic) {
  return epic.id.replaceAll('-', ' ').toUpperCase();
}

function waitingOn(run, task) {
  return task.packet.prerequisites.map(id => run.tasks.find(item => item.packet.id === id))
    .filter(item => status(currentAttempt(item))[2] !== 'success' &&
      !(item.routing?.status === 'skipped' && item.routingVerified !== false && task.packet.joinPrerequisites?.includes(item.packet.id)));
}

export function taskStatus(run, task) {
  if (run.triagePending) return ['Awaiting triage', 'Confirm the team before dispatching work.', 'neutral'];
  if (task.routingVerified === false) return ['Routing evidence incomplete', 'The recorded decision is missing or no longer matches its evidence.', 'warning'];
  if (task.routing?.status === 'skipped') return ['Skipped by routing', task.routing.reason === 'condition' ?
    'The run condition did not match the accepted output.' : 'A prerequisite for this step was skipped.', 'neutral'];
  const latest = currentAttempt(task);
  if (!latest && task.dispatchIssue) return ['Automatic dispatch needs attention', task.dispatchIssue.message, 'warning'];
  if (latest?.resourceIds?.length && latest.evidenceStatus === 'missing') return status(latest);
  const resources = resourceWait(run, task);
  if (resources.length) return resources.some(resource => !resource.resolution)
    ? ['Waiting for resources', 'Open Needs attention to resolve the resource requests for this handoff.', 'warning']
    : ['Resource decisions recorded', 'Continue this handoff using the recorded resource decisions.', 'warning'];
  const waiting = waitingOn(run, task);
  if (!latest && waiting.length) return ['Waiting on handoffs', `Waiting for ${waiting.map(item => item.packet.title).join(', ')}.`, 'neutral'];
  if (!latest && task.packet.runWhen && !task.routing)
    return ['Waiting for routing evidence', 'Open the prerequisite and check its accepted JSON output.', 'warning'];
  if (!latest && task.workspaceRepairId) return [run.automation?.enabled ? 'Repair queued' : 'Ready to repair',
    'The failed checks and the tested files are attached to this repair round.', 'neutral'];
  if (!latest && task.packet.agentFollowUp && run.automation?.pending)
    return ['Follow-up queued', 'The worker will open the saved Codex conversation.', 'neutral'];
  if (!latest && run.automation?.enabled) return ['Queued for dispatch', 'The workflow will start this step automatically.', 'neutral'];
  return status(latest, run.agentRun);
}

function handoffProgress({ accepted, total, skipped = 0 }) {
  return `${accepted}/${total - skipped} accepted${skipped ? ` · ${skipped} skipped` : ''}`;
}

export function projectHeader(project, current) {
  const path = projectHref(project);
  const runs = project.id === 'music-transcribe' ? `<a href="${path}/runs"${current === 'runs' ? ' aria-current="page"' : ''}>Runs</a>` : '';
  if (project.featureOnly) {
    const name = project.name === project.id ? project.name.replaceAll('-', ' ').replace(/^./, c => c.toUpperCase()) : project.name;
    return `<header class="mast feature-mast"><div class="mast-inner"><a class="crew-home" href="${path}/requests"><span class="crew-mark" aria-hidden="true"><i></i><i></i><i></i></span>Engineering Crew</a>
<span class="feature-project">${escape(name)}</span>
<nav aria-label="Project navigation"><a href="${path}/requests"${current === 'requests' ? ' aria-current="page"' : ''}>Requests</a>
${runs}
${project.id === 'music-transcribe' ? '' : `<a href="${path}/agents"${current === 'feature-agents' ? ' aria-current="page"' : ''}>Feature roles</a>`}
<a href="${path}/workflows"${current === 'workflows' ? ' aria-current="page"' : ''}>Workflows</a>
<a href="${projectAgentsHref(project)}"${current === 'agent-library' ? ' aria-current="page"' : ''}>Agents</a>
${project.id === 'music-transcribe' ? `<a href="${projectSkillHref(project)}"${current === 'skills' ? ' aria-current="page"' : ''}>Skills</a>` : ''}
<a href="${path}/tools"${current === 'tools' ? ' aria-current="page"' : ''}>Tools</a></nav></div></header>`;
  }
  const initials = project.name.split(/\s+/).slice(0, 2).map(word => word[0]).join('').toUpperCase();
  const home = project.featureOnly ? `${path}/requests` : path;
  return `<header class="mast"><div class="mast-inner"><a class="project-home" href="${home}"><span class="project-monogram" aria-hidden="true">${escape(initials)}</span>${escape(project.name)}</a>
<nav aria-label="Project navigation"><a href="${path}/requests"${current === 'requests' ? ' aria-current="page"' : ''}>Feature requests</a>
${runs}
${project.id === 'music-transcribe' ? '' : `<a href="${path}/feature-agents"${current === 'feature-agents' ? ' aria-current="page"' : ''}>Feature agents</a>`}
<a href="${path}/workflows"${current === 'workflows' ? ' aria-current="page"' : ''}>Workflows</a>
<a href="${projectAgentsHref(project)}"${current === 'agent-library' ? ' aria-current="page"' : ''}>Agents</a>
${project.id === 'music-transcribe' ? `<a href="${projectSkillHref(project)}"${current === 'skills' ? ' aria-current="page"' : ''}>Skills</a>` : ''}
<a href="${path}/tools"${current === 'tools' ? ' aria-current="page"' : ''}>Tools</a>
${project.featureOnly ? '' : `<a href="${path}"${current === 'epics' ? ' aria-current="page"' : ''}>Epics</a>
<a href="${path}/attention"${current === 'attention' ? ' aria-current="page"' : ''}>Needs attention</a>
${project.id === 'music-transcribe' ? '' : `<a href="${path}/agents"${current === 'agents' ? ' aria-current="page"' : ''}>${escape(project.crewName)}</a>`}`}</nav></div></header>`;
}

function projectAttention(project) {
  const entries = project.epics.flatMap(epic => epic.runs.flatMap(run => {
    if (!run.handoffs.attention && !run.triagePending) return [];
    const active = { ...run, project, epic };
    const rows = [
      ...(run.triagePending ? [`<li><a href="${epicViewHref(active, 'triage')}">Confirm team assignments ${arrow}</a></li>`] : []),
      ...run.pendingResources.map(resource => `<li><a href="${epicViewHref(active, 'attention', `#resource-${resource.id}`)}">${resourceLabel(resource)} ${arrow}</a></li>`),
      ...run.attentionTasks.map(task => `<li><a href="${taskHref(run.id, task.id)}">${escape(task.title)} ${arrow}</a></li>`),
    ];
    return [`<section class="record-section"><h2><a href="${epicViewHref(active, run.triagePending ? 'triage' : 'attention')}">${escape(epicName(epic))}</a></h2>
<p class="muted">Run <code>${escape(run.id)}</code></p><ul class="index-list">${rows.join('')}</ul></section>`];
  }));
  return layout(`Needs attention · ${project.name}`, `${projectHeader(project, 'attention')}<main><h1>Needs attention</h1>
${entries.length ? entries.join('') : '<p>No work in this project is waiting for attention.</p>'}</main>`);
}

export function projectPage(project, view, { query = '', status: filter, configurations = [] } = {}) {
  const path = projectHref(project);
  if (view === 'attention') return projectAttention(project);
  const agents = `<ul class="index-list">${project.profiles.map(profile => `<li>
<a href="${artifactHref(profile.configurationRun ?? project.configurationRun, profile.instructionId)}?view=agents">${escape(profile.name)}</a>
<p>${escape(profile.remit)}</p></li>`).join('')}</ul>`;
  if (view === 'agents') {
    return layout(`${project.name} · Agents`, `${projectHeader(project, 'agents')}<main>
<h1>${escape(project.crewName)}</h1>
<section class="record-section"><h2>Orchestration settings</h2>
<p class="muted">Register a new configuration version in Postgres and start a run to apply it.</p>
<ul class="index-list">${configurations.map(config => {
    const { epic, project: settings } = config;
    const policy = settings?.orchestration;
    const latest = epic.runs[0];
    const title = taskId => settings.tasks.find(task => task.id === taskId)?.title ?? taskId;
    return `<li><a href="${epicHref(project, epic)}">${escape(epicName(epic))}</a>
${config.error ? `<p>${escape(config.error)}</p>` : `<p>Version ${escape(config.version)} · Git baseline <code>${escape(config.sourceCommit.slice(0, 12))}</code></p>
${config.error ? '' : policy ? `<p>${escape(title(policy.buildTask))} → ${policy.reviewTasks.map(id => escape(title(id))).join(' + ')}</p>
<p>${policy.maxFixLoops} maximum fix ${policy.maxFixLoops === 1 ? 'loop' : 'loops'} · Decision owner ${escape(policy.decisionOwner)}</p>`
    : '<p>No implementation reviews configured.</p>'}`}
${config.error ? '' : settings?.resourcePolicy?.rules.length ? `<p><strong>Resource rules</strong></p><ul>${settings.resourcePolicy.rules.map(rule =>
      `<li>${escape(rule.action)} · ${escape(rule.target ?? 'Any target')} · ${escape(resourceModes[rule.mode])}</li>`).join('')}</ul>`
      : '<p>Resource setup defaults to manual confirmation.</p>'}
<p><a href="${artifactHref(latest.id, 'project-config')}?view=agents">View the latest run’s pinned configuration</a></p></li>`;
  }).join('')}</ul></section>
<section class="record-section"><h2>Agents in latest runs</h2>${agents}</section></main>`);
  }
  const selected = Object.hasOwn(stateLabels, filter) ? filter : 'all';
  const entries = project.epics.filter(epic => {
    const [key, label] = runState(epic.runs[0]);
    return (selected === 'all' || selected === key) && matches(query, [epic.id, epic.title, epic.goal, label]);
  });
  const decisions = !query && selected === 'all' ? project.epics.flatMap(epic => {
    const run = epic.runs[0];
    return run.recentDecisions.map(event => ({ ...event, title: activityLabel(event.title, event.action),
      href: `${taskHref(run.id, event.taskId)}#attempt-${event.attempt}`, tone: event.action === 'accepted' ? 'success' : 'warning' }));
  }).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 3) : [];
  return layout(project.name, `${projectHeader(project, 'epics')}<main class="project-index">
<div class="page-title index-title"><h1>Epics</h1><p class="muted">${entries.length} ${entries.length === 1 ? 'epic' : 'epics'}</p></div>
<form class="query-bar" action="${path}" role="search" aria-label="Filter epics">
<label class="search-field">${searchIcon}<span class="visually-hidden">Find epics</span><input type="search" data-search name="q" value="${escape(query)}" placeholder="Find epics…" maxlength="160"/><kbd>/</kbd></label>
<label class="visually-hidden" for="epic-status-filter">Status</label><select name="status" id="epic-status-filter">${selectOptions(stateLabels, selected)}</select>
<button class="secondary" type="submit">Filter</button>${query || selected !== 'all' ? `<a class="clear-filter" href="${path}">Clear</a>` : ''}</form>
${entries.length ? `<div class="epic-table" role="table" aria-label="Epics"><div class="epic-row column-headings" role="row"><span role="columnheader">Epic</span><span role="columnheader">Status</span><span role="columnheader">Handoffs</span><span role="columnheader">Updated</span></div>
${entries.map(epic => {
    const run = epic.runs[0];
    const [state, label, tone] = runState(run);
    return `<div class="epic-row" role="row"><div role="cell"><a class="epic-row-title" href="${epicHref(project, epic)}"><span class="item-code">${escape(epicCode(epic))}</span>${escape(epicName(epic))}${arrow}</a><p>${escape(epic.goal)}</p></div>
<div role="cell">${state === 'attention' ? `<a href="${epicViewHref({ ...run, project, epic }, 'attention')}">${stateBadge(label, tone)}</a>` : stateBadge(label, tone)}</div><div role="cell" class="handoff-count"><strong>${run.handoffs.accepted}/${run.handoffs.total - (run.handoffs.skipped ?? 0)}</strong><span>accepted${run.handoffs.skipped ? ` · ${run.handoffs.skipped} skipped` : ''}</span></div>
<div role="cell" class="last-activity">${run.latestActivity ? `<a href="${epicViewHref({ id: run.id, project, epic }, 'activity')}" aria-label="${escape(activityLabel(run.latestActivity.title, run.latestActivity.action))}">${timestamp(run.latestActivity.at)}</a>` : '<span>No activity yet</span>'}</div></div>`;
  }).join('')}</div>` : `<div class="empty-state"><h2>No matching epics</h2><p>Try a different search or status.</p><a href="${path}">Clear filters</a></div>`}
${decisions.length ? `<section class="project-activity"><div class="section-title"><h2>Recent decisions</h2></div>${eventList(decisions)}</section>` : ''}</main>`);
}

function activityLabel(title, action) {
  if (action === 'assigned') return `${title} assigned`;
  if (action === 'accepted') return `${title} accepted`;
  if (action === 'rework') return `${title} returned for rework`;
  if (action === 'running' || action === 'started') return `${title} started`;
  if (action === 'completed') return `${title} returned`;
  return `${title} needs attention`;
}

export function epicPage(project, epic, run, { step, view, query = '', type, workerConnected } = {}) {
  const tabs = { ...(run.triage ? { triage: 'Triage' } : {}), overview: 'Overview', workflow: 'Workflow',
    ...(run.handoffs.attention || run.resources?.length || view === 'attention' ? { attention: 'Needs attention' } : {}),
    ...(run.fix ? { reviews: 'Reviews' } : {}),
    ...(run.tasks.some(task => task.packet.execution || task.packet.workspaceCheck) ? { checks: 'Checks' } : {}),
    ...(run.workspaceDeliveryStatus ? { delivery: 'Delivery' } : {}), usage: 'Usage', activity: 'Activity' };
  const selected = Object.hasOwn(tabs, view) || view === 'search' ? view
    : step ? 'workflow' : run.triagePending ? 'triage' : run.pendingResources.length ? 'attention' : 'overview';
  const [, label, tone] = runState(run);
  const request = run.workflowRequest;
  const tested = run.workflowTest;
  const title = request?.title ?? epicName(epic);
  const workflowLink = request && `${projectHref(project)}/workflows?workflow=${encodeURIComponent(epic.id)}&amp;version=${run.project.configurationVersion}`;
  const content = selected === 'triage' ? triagePanel(run) : selected === 'workflow' ? pipelinePanel(run, step, workerConnected) : selected === 'checks' ? checksPanel(run)
    : selected === 'delivery' ? workspaceDeliveryPanel(run)
    : selected === 'attention' ? attentionPanel(run) : selected === 'reviews' ? reviewsPanel(run) : selected === 'usage' ? usagePanel(run) : selected === 'activity' ? activityPanel(run)
      : selected === 'search' ? searchPanel(run, query, type) : overviewPanel(run, epic);
  return layout(`${title} · ${project.name}`, `${projectHeader(project, tested ? 'workflows' : request ? 'requests' : undefined)}<main data-epic-view>
<nav class="breadcrumbs" aria-label="Location"><a href="${projectHref(project)}${tested ? '/workflows' : request ? '/requests' : ''}">${tested ? 'Workflows' : request ? 'Requests' : 'Epics'}</a><span aria-hidden="true">/</span><span>${tested ? 'Draft test' : escape(epicCode(epic))}</span></nav>
<div class="page-title epic-title"><h1>${escape(title)}</h1>${stateBadge(label, tone)}</div>
${request ? `<p class="intro"><a href="${workflowLink}">${escape(epic.title)} · v${escape(run.project.configurationVersion)}</a>
  · <a href="${artifactHref(run.id, request.briefArtifactId)}">Request brief</a></p>` : `<p class="intro">${escape(epic.goal)}</p>`}
${tested ? `<section class="record-section workflow-test-panel" aria-labelledby="workflow-test-heading"><div class="section-title">
  <h2 id="workflow-test-heading">Draft test</h2>
  <form method="post" action="${runHref(run.id)}/save-workflow-test"><button type="submit" class="secondary">Save tested revision</button></form></div>
  <p>${tested.baseVersion ? `<a href="${projectHref(project)}/workflows?workflow=${encodeURIComponent(epic.id)}&amp;version=${escape(tested.baseVersion)}">Based on v${escape(tested.baseVersion)}</a> · ` : 'New workflow · '}
    <a href="${artifactHref(run.id, 'project-config')}?view=epic">Tested workflow configuration</a> ·
    <a href="${escape(revisionComparisonHref(project, 'workflow', { test: run.id }))}">Compare tested draft</a></p></section>` : ''}
${request?.imageInputs?.length ? `<details class="agent-skill-files"><summary>Request images</summary><ul class="links">${request.imageInputs.map(({ artifactId, name }) =>
  `<li><a href="${artifactHref(run.id, artifactId)}?view=epic">${escape(name)}</a></li>`).join('')}</ul></details>` : ''}
<div class="epic-toolbar"><nav class="view-tabs" aria-label="Epic views">${Object.entries(tabs).map(([value, title]) =>
    `<a href="${epicViewHref(run, value)}"${value === selected ? ' aria-current="page"' : ''}>${title}</a>`).join('')}</nav>
<form class="epic-search" role="search" aria-label="Search this run" action="${epicHref(project, epic)}"><input type="hidden" name="run" value="${escape(run.id)}"><input type="hidden" name="view" value="search">
<label class="search-field"><span class="visually-hidden">Search this run</span><input type="search" data-search name="q" value="${escape(query)}" placeholder="Search this run…" maxlength="160"><kbd>/</kbd></label><button type="submit" class="search-submit" aria-label="Search">${searchIcon}</button></form></div>
<div class="epic-content">${content}</div></main>`, selected === 'attention'
    ? !run.pendingResources.length && (run.handoffs.running || run.automation?.pending)
    : (run.handoffs.running || run.automation?.pending) && selected !== 'search');
}

const resourceModes = { manual: 'Manual setup', deny: 'Denied by policy', auto: 'Automatic setup allowed' };
const resourceLabel = resource => `${escape(resource.action.replaceAll('-', ' ').replace(/^./, letter => letter.toUpperCase()))} · ${escape(resource.target)}`;

function attentionPanel(run) {
  const open = new Set(run.pendingResources.map(resource => resource.id));
  const resourceCard = resource => {
    const task = run.tasks.find(task => task.packet.id === resource.taskId);
    const attempt = task.attempts.find(attempt => attempt.id === resource.attemptId);
    const { resolution, mode, automatic, id } = resource;
    const provisioning = isProvisioning(resource);
    const resolutionLabel = resolution?.disposition === 'declined' ? 'Alternative recorded'
      : resolution?.source === 'provisioner' ? 'Provisioner reported success' : 'Operator confirmed setup';
    const missing = attempt.evidenceStatus !== 'recorded';
    const message = missing ? 'The request is missing its execution receipt.'
      : provisioning ? 'The configured provisioner is running. Refresh to check its status.'
      : automatic?.status === 'running' ? 'Automatic setup timed out. Verify the resource before confirming it.'
        : automatic?.detail;
    return `<article class="resource-card" id="resource-${id}">
<div class="section-title"><h3>${resourceLabel(resource)}</h3>${stateBadge(resolution ? resolutionLabel : resourceModes[mode], resolution ? 'success' : 'warning')}</div>
<p>${escape(resource.reason)}</p>
<p class="muted"><a href="${taskHref(run.id, task.packet.id)}#attempt-${attempt.number}">${escape(task.packet.title)} · Attempt ${attempt.number}</a>
${attempt.receiptId ? ` · <a href="${artifactHref(run.id, attempt.receiptId, task.packet.id)}&amp;view=attention">Execution receipt</a>` : ''}</p>
${resolution ? `<p>${escape(resolution.note)}</p><p><a href="${artifactHref(run.id, resolution.artifactId, task.packet.id)}&amp;view=attention">View resource resolution ${arrow}</a></p>`
      : open.has(id) ? `${message ? `<p>${escape(message)}</p>` : ''}
${provisioning || missing ? '' : `<form class="decision" method="post" action="${runHref(run.id)}/resolve-resource">
<input type="hidden" name="resource" value="${id}">
<label for="note-${id}">${mode === 'deny' ? 'Alternative approach' : 'Setup confirmation'}</label>
<textarea id="note-${id}" name="note" rows="2" required maxlength="1000" placeholder="${mode === 'deny' ? 'Describe how work can proceed without this resource.' : 'Record what is ready. Use identifiers only.'}"></textarea>
<div class="buttons"><button type="submit">${mode === 'deny' ? 'Continue with alternative' : 'Confirm resource ready'}</button></div></form>`}`
        : '<p class="muted">This request is no longer active.</p>'}</article>`;
  };
  const resources = run.resources ?? [];
  return `<section class="record-section attention-panel"><div class="section-title"><h2>Needs attention</h2>
<a href="${artifactHref(run.id, 'project-config')}?view=attention">Pinned resource policy ${arrow}</a></div>
${!open.size && !run.attentionTasks.length ? '<p>No handoffs are waiting for attention.</p>' : ''}
${resources.filter(resource => open.has(resource.id)).map(resourceCard).join('')}
${run.attentionTasks.length ? `<h3>Handoffs to review</h3><ul class="index-list">${run.attentionTasks.map(task =>
    `<li><a href="${taskHref(run.id, task.id)}">${escape(task.title)} ${arrow}</a></li>`).join('')}</ul>` : ''}
${resources.some(resource => !open.has(resource.id)) ? `<h3>Resource history</h3>${resources.filter(resource => !open.has(resource.id)).map(resourceCard).join('')}` : ''}</section>`;
}

function activityEvents(run) {
  const events = (run.fixLoops ?? []).map(loop => ({
    title: `Fix loop ${loop.number} requested`, at: loop.recordedAt, detail: loop.note, tone: 'warning', key: true,
    href: epicViewHref(run, 'reviews'),
  }));
  for (const repair of run.workspaceRepairs ?? []) events.push({ title: `Workspace repair round ${repair.round} opened`, at: repair.recordedAt,
    detail: `${repair.actor} · ${repair.note}`, tone: 'warning', key: true, href: artifactHref(run.id, repair.id, repair.targetTaskId) });
  if (run.workspaceDelivery) events.push({ title: 'Local delivery published', at: run.workspaceDelivery.publishedAt,
    tone: 'success', key: true, href: artifactHref(run.id, run.workspaceDelivery.artifactId) });
  if (run.triage?.recordedAt) events.push({ title: 'Team assigned', at: run.triage.recordedAt,
    detail: run.triage.mode === 'static' ? 'Used the team configured in Git.' : `${run.triage.owner} · ${run.triage.note}`,
    tone: 'success', key: true, href: epicViewHref(run, 'triage') });
  if (run.automation?.changedAt) events.push({ title: run.automation.enabled ? 'Automatic dispatch resumed' : 'Automatic dispatch paused',
    at: run.automation.changedAt, tone: 'neutral', key: true, href: pipelineHref(run) });
  for (const record of run.artifacts.filter(item => item.provenance.source === 'routing')) {
    const { taskId, status, recordedAt } = record.provenance;
    const name = run.tasks.find(task => task.packet.id === taskId)?.packet.title ?? taskId;
    events.push({ title: name + (status === 'skipped' ? ' skipped by routing' : ' condition matched'),
      at: recordedAt, tone: 'neutral', key: true, href: artifactHref(run.id, record.id, taskId) });
  }
  for (const task of run.tasks) {
    const { packet } = task;
    const profile = run.profiles.find(value => value.id === packet.profileId);
    for (const attempt of task.attempts) {
      const href = `${taskHref(run.id, packet.id)}#attempt-${attempt.number}`;
      const latest = attempt === currentAttempt(task);
      if (attempt.startedAt) events.push({ title: activityLabel(packet.title, 'started'), at: attempt.startedAt,
        detail: profile.name + (attempt.dispatchSource === 'workflow' ? ' · Automatic dispatch' : ''), href, tone: 'neutral', key: latest && attempt.outcome === 'running' });
      if (attempt.verification) {
        const report = attempt.verification;
        const count = report.checks.filter(check => check.passed).length;
        const independent = report.kind === 'independent-qa';
        const workspace = report.kind === 'workspace-acceptance';
        events.push({ title: `${workspace ? 'Music Transcribe acceptance' : independent ? 'Independent QA' : 'Author tests'} ${report.passed ? 'passed' : 'failed'}`,
          at: report.endedAt ?? report.checks.at(-1)?.endedAt ?? attempt.endedAt, tone: report.passed ? 'success' : 'warning', key: true,
          detail: workspace ? `${count}/${report.checks.length} local checks on workspace ${report.workspaceDigest.slice(0, 7)}` :
            independent ? `${count}/${report.checks.length} Docker checks on ${report.testedCommit.slice(0, 7)}` : `Docker suite on ${report.testedCommit.slice(0, 7)}`,
          href: independent ? epicViewHref(run, 'checks') : artifactHref(run.id, attempt.runnerArtifacts['check-receipt'], packet.id) });
      }
      if (attempt.decision) {
        const decision = attempt.decision;
        events.push({ title: activityLabel(packet.title, decision.disposition), at: decision.recordedAt,
          detail: (decision.source === 'workflow' ? 'Automatically accepted · ' : '') + decision.note,
          href, tone: decision.disposition === 'accepted' ? 'success' : 'warning',
          key: !attempt.verification || decision.disposition === 'rework' });
      } else if (attempt.endedAt) {
        const [label, detail, tone] = status(attempt);
        events.push({ title: `${packet.title} · ${label}`, at: attempt.endedAt, detail, href, tone, key: latest });
      }
    }
  }
  return events.sort((a, b) => b.at.localeCompare(a.at));
}

function eventList(events, compact = false) {
  if (!events.length) return '<p class="empty-state">No activity recorded for this run.</p>';
  return `<ol class="event-list${compact ? ' compact' : ''}">${events.map(event => `<li>
<span class="event-mark ${event.tone}" aria-hidden="true"></span><div><a href="${event.href}">${escape(event.title)}</a>
<p>${escape(event.detail)}</p></div>${timestamp(event.at)}</li>`).join('')}</ol>`;
}

function activityPanel(run) {
  return `<section class="record-section"><div class="section-title"><h2>Activity</h2><p>Newest first</p></div>${eventList(activityEvents(run))}</section>`;
}

function triagePanel(run) {
  const { triage, triagePending } = run;
  const profiles = new Map(run.profiles.map(profile => [profile.id, profile]));
  const roster = `<ul class="index-list triage-roster">${run.tasks.map(({ packet, alternateProfiles }) => {
    const profile = profiles.get(packet.profileId);
    return `<li><div><strong${triagePending && alternateProfiles?.length ? ` id="label-${escape(packet.id)}"` : ''}>${escape(packet.title)}</strong>
<p>${escape(packet.objective)}</p></div>
${triagePending && alternateProfiles?.length ? `<select aria-labelledby="label-${escape(packet.id)}" name="assignment-${escape(packet.id)}">
${[profile.id, ...alternateProfiles].map(id => `<option value="${escape(id)}">${escape(profiles.get(id).name)}</option>`).join('')}</select>`
      : `<span>${escape(profile.name)}</span>`}</li>`;
  }).join('')}</ul>`;
  return `<section class="record-section triage-panel"><div class="section-title"><h2>${triagePending ? 'Review brief and assign team' : 'Team assignments'}</h2>
${triage.brief ? `<a href="${artifactHref(run.id, triage.brief.artifactId)}?view=triage">Open pinned brief ${arrow}</a>` : ''}</div>
${triagePending ? `<p class="muted">Review the brief and confirm the team. The first assignments start immediately.</p>
<form class="triage-form" method="post" action="${runHref(run.id)}/triage">
${roster}
<div class="decision"><label for="triage-owner">Triage owner</label>
<select name="owner" id="triage-owner" required><option value="">Select the triage owner</option>
${triage.owners.map(owner => `<option value="${escape(owner)}">${escape(owner)}</option>`).join('')}</select>
<label for="triage-note">Assignment reason</label><textarea name="note" id="triage-note" rows="2" required maxlength="2000"></textarea>
<div class="buttons"><button type="submit">Confirm and start</button></div></div></form>`
    : `<p>${triage.mode === 'static' ? 'Assigned from the pinned configuration' : `Confirmed by <strong>${escape(triage.owner)}</strong>`}
· ${timestamp(triage.recordedAt)}</p>${triage.note ? `<p>${escape(triage.note)}</p>` : ''}
${roster}<p class="triage-links"><a href="${epicViewHref(run, 'workflow')}">Open workflow ${arrow}</a>
<a href="${artifactHref(run.id, triage.artifactId)}?view=triage">View assignment record ${arrow}</a></p>`}</section>`;
}

function overviewPanel(run, epic) {
  const build = currentAttempt(run.tasks.find(task => task.packet.execution?.kind === 'build'));
  const qaTask = run.tasks.find(task => task.packet.execution?.kind === 'verify' || task.packet.workspaceCheck);
  const qa = currentAttempt(qaTask)?.verification;
  const brief = run.artifacts.find(artifact => artifact.id === (run.triage?.brief?.artifactId ?? 'input-brief'));
  const candidate = build?.candidate;
  const diff = build?.runnerArtifacts?.['candidate-diff'];
  const history = epic.runs.length > 1 ? `<h3>Run history</h3><ul class="index-list">${epic.runs.map(entry => `<li>
<a href="${epicHref(run.project, epic)}?run=${encodeURIComponent(entry.id)}"${entry.id === run.id ? ' aria-current="page"' : ''}>${escape(entry.id)}</a></li>`).join('')}</ul>` : '';
  return `<div class="overview-layout"><section class="record-section"><div class="section-title"><h2>What happened</h2>
<a href="${epicViewHref(run, 'activity')}">All activity ${arrow}</a></div>${eventList(activityEvents(run).filter(event => event.key).slice(0, 5), true)}</section>
<aside class="run-summary" aria-label="Run details"><h2>Run details</h2><dl>
<div><dt>Handoffs</dt><dd><a href="${epicViewHref(run, 'workflow')}">${handoffProgress(run.handoffs)}</a></dd></div>
<div><dt>Workflow usage</dt><dd><a href="${epicViewHref(run, 'usage')}">${run.usage.totalTokens === null ? 'View usage' : `${tokenTotal(run.usage)} tokens`}</a></dd></div>
${qaTask ? `<div><dt>${qaTask.packet.workspaceCheck ? 'Local acceptance' : 'Independent QA'}</dt><dd>${qa ? `<a href="${epicViewHref(run, 'checks')}">${qa.checks.filter(check => check.passed).length}/${qa.checks.length} passed</a>` : 'No receipt yet'}</dd></div>` : ''}
${run.workspaceDeliveryStatus ? `<div><dt>Local delivery</dt><dd><a href="${epicViewHref(run, 'delivery')}">${run.workspaceDeliveryStatus.published ? 'View delivery' : run.workspaceDeliveryStatus.canPublish ? 'Ready to publish' : 'View delivery requirements'}</a></dd></div>` : ''}
${run.workspaceDeliveryBase ? `<div><dt>Starting workspace</dt><dd><a href="${artifactHref(run.id, run.workspaceDeliveryBase.artifactId)}?view=epic">Published workspace base</a></dd></div>` : ''}
${candidate ? `<div><dt>Candidate</dt><dd>${diff ? `<a href="${artifactHref(run.id, diff)}?view=epic"><code>${escape(candidate.commit.slice(0, 7))}</code></a>` : `<code>${escape(candidate.commit.slice(0, 7))}</code>`}</dd></div>` : ''}
<div><dt>Run</dt><dd><code>${escape(run.id)}</code></dd></div></dl>
${brief ? `<a class="brief-link" href="${artifactHref(run.id, brief.id)}?view=epic">Original brief ${arrow}</a>` : ''}${history}</aside></div>`;
}

function workspaceDeliveryPanel(run) {
  const status = run.workspaceDeliveryStatus;
  const { published, canPublish, candidate } = status;
  const preview = run.workspacePreview;
  const path = runHref(run.id);
  return `<section class="record-section"><div class="section-title"><h2>Local delivery</h2>
${published ? '' : stateBadge(canPublish ? 'Ready to publish' : 'Awaiting verification', 'neutral')}</div>
${status.reason ? `<p>${escape(status.reason)}</p>` : ''}
${candidate ? `<p><a href="${artifactHref(run.id, candidate.workspace.artifactId, candidate.taskId)}">Verified workspace</a>
<code title="${escape(candidate.workspace.digest)}">${escape(candidate.workspace.digest.slice(0, 12))}</code>
 · <a href="${artifactHref(run.id, candidate.checks.artifactId)}?view=checks">Acceptance receipt</a></p>` : ''}
${canPublish ? `<form method="post" action="${path}/publish-workspace"><input type="hidden" name="attempt" value="${escape(status.attemptId)}">
<button type="submit">Publish local delivery</button></form>` : ''}
${run.workspaceDelivery ? `<p><a href="${artifactHref(run.id, run.workspaceDelivery.artifactId)}?view=delivery">Delivery record</a> · ${timestamp(run.workspaceDelivery.publishedAt)}</p>` : ''}
${published && run.project.id === 'music-transcribe' && run.workspaceDeliveryBase ? preview?.lessonLibrary
  ? `<p>${count(preview.lessonLibrary.copiedLessons, 'saved lesson')} carried over from the previous delivery.</p>`
  : '<p>The first open carries over saved lessons from the previous delivery.</p>' : ''}
${preview?.status === 'failed' ? `<p>${escape(preview.error)}</p>` : ''}
${published || preview?.container ? `<div class="buttons">${published ? `<form method="post" action="${path}/preview-workspace"><button>Open delivered app</button></form>` : ''}
${preview?.container ? `<form method="post" action="${path}/stop-workspace"><button class="secondary">Stop local app</button></form>` : ''}
${published && run.project.id === 'music-transcribe' ? `<a class="secondary" href="${projectHref(run.project)}/requests?from-delivery=${encodeURIComponent(run.id)}#new-request">New follow-up request</a>` : ''}</div>` : ''}
</section>`;
}

const number = value => value.toLocaleString('en-US');
const dollars = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 6 });
const count = (value, noun) => `${number(value)} ${noun}${value === 1 ? '' : 's'}`;

function duration(ms) {
  if (ms == null) return '—';
  if (ms < 1_000) return `${ms} ms`;
  const seconds = Math.floor(ms / 1_000);
  if (seconds < 60) return `${(ms / 1_000).toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ${minutes % 60}m` : `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

const partial = missing => missing ? ' (partial)' : '';
const tokenTotal = usage => usage.totalTokens === null ? '—' : `${number(usage.totalTokens)}${partial(usage.attemptsMissingUsage)}`;
const costTotal = usage => usage.estimatedUsd === null ? '—' : `${dollars.format(usage.estimatedUsd)}${partial(usage.unpricedAttempts)}`;
const timeTotal = usage => usage.durationMs === null ? '—' : `${duration(usage.durationMs)}${partial(usage.attemptsMissingDuration)}`;
const taskUsageHref = (run, taskId) => epicViewHref(run, 'usage', `#usage-${encodeURIComponent(taskId)}`);

function usageSummary(usage) {
  const tokens = usage.totalTokens === null ? 'No token usage reported' : `${tokenTotal(usage)} tokens`;
  const cost = usage.estimatedUsd === null ? 'No cost estimate' : `${costTotal(usage)} estimated`;
  return [tokens, cost, usage.costTargetUsd === null ? '' : `${dollars.format(usage.costTargetUsd)} target`,
    usage.overCostTarget ? 'Above cost target' : '', usage.durationMs === null ? '' : `${timeTotal(usage)} in attempts`].filter(Boolean).join(' · ');
}

function usageGaps(usage) {
  const gaps = [[usage.attemptsMissingUsage, 'without token usage'], [usage.unpricedAttempts, 'without a cost estimate'],
    [usage.attemptsMissingDuration, 'without timing'], [usage.runningAttempts, 'still running']];
  return gaps.filter(([total]) => total).map(([total, label]) => `${count(total, 'attempt')} ${label}`).join(' · ');
}

function attemptMetrics(attempt) {
  const { usage, estimatedUsd, durationMs, codexDurationMs } = attempt;
  const tokenParts = [['input', 'input'], ['output', 'output'], ['cached', 'cached input'], ['reasoning', 'reasoning output']]
    .filter(([key]) => Number.isSafeInteger(usage?.[key]) && usage[key] >= 0)
    .map(([key, label]) => `${number(usage[key])} ${label}`).join(' / ');
  const tokens = Number.isSafeInteger(usage?.total) && usage.total >= 0
    ? `${number(usage.total)} tokens${tokenParts ? ` (${tokenParts})` : ''}` : 'Token usage unreported';
  return `<p class="muted">${attempt.outcome === 'running' ? 'Usage and timing pending' : [
    tokens, attempt.overTokenTarget ? 'Above token target' : '',
    estimatedUsd === null ? 'No cost estimate' : `${dollars.format(estimatedUsd)} estimated`,
    durationMs === null ? 'Duration unrecorded' : `${duration(durationMs)} total`,
    codexDurationMs === null ? '' : `${duration(codexDurationMs)} in Codex`,
  ].filter(Boolean).join(' · ')}</p><p class="muted">${attempt.runtime?.model
    ? `Model · ${escape(attempt.runtime.model)}` : 'Model unrecorded'}</p>`;
}

function attemptQuality(run, packet, attempt) {
  const verification = attempt.verification;
  const checks = verification ? `<a href="${artifactHref(run.id, attempt.runnerArtifacts['check-receipt'], packet.id)}">${verification.checks.filter(check => check.passed).length}/${verification.checks.length} Docker checks passed</a>`
    : (packet.execution || packet.workspaceCheck) && (attempt.result?.state === 'completed' || attempt.outcome === 'check-failed') ? 'No check receipt' : '';
  const findings = attempt.reviewFindings;
  return [checks, findings ? `${count(findings.filter(finding => finding.severity === 'blocker').length, 'blocker')} · ${findings.filter(finding => finding.severity === 'backlog').length} deferred` : ''].filter(Boolean).join(' · ');
}

function usagePanel(run) {
  const { usage, quality, handoffs } = run;
  const checks = quality.checks.total ? `${quality.checks.passed}/${quality.checks.total} recorded Docker checks passed` : 'No Docker checks recorded for current attempts';
  const profiles = [...usage.byProfile].sort((a, b) => (b.totalTokens ?? -1) - (a.totalTokens ?? -1));
  return `<div class="epic-sections"><section aria-labelledby="usage-heading">
<div class="section-title"><h2 id="usage-heading">Workflow usage</h2><p>Run · <code>${escape(run.id)}</code> · ${count(usage.attempts, 'attempt')}</p></div>
<dl class="usage-metrics">
<div><dt>Reported tokens</dt><dd>${tokenTotal(usage)}</dd></div>
<div><dt>Estimated cost</dt><dd>${costTotal(usage)}</dd></div>
<div><dt>Total attempt time</dt><dd>${timeTotal(usage)}</dd></div>
<div><dt>Attempt window</dt><dd>${duration(usage.attemptWindowMs)}${usage.attemptWindowMs === null ? '' : partial(usage.attemptsMissingDuration)}</dd></div>
</dl>
<p class="muted">Totals include finished retries and previous candidates. Total attempt time adds durations even when attempts overlap. The attempt window spans the first recorded start to the last recorded finish of timed attempts. Cost estimates use configured token rates.</p>
${usageGaps(usage) ? `<p class="muted">${usageGaps(usage)}</p>` : ''}
${usage.attempts ? '' : '<p class="empty-state">No attempts recorded for this run yet.</p>'}</section>
<section aria-labelledby="quality-heading"><h2 id="quality-heading">Quality signals</h2>
<p><a href="${epicViewHref(run, 'workflow')}">${handoffs.skipped ? handoffProgress(handoffs) : `${handoffs.accepted}/${handoffs.total} handoffs accepted`}</a> · ${count(quality.reworkDecisions, 'rework decision')}${run.fix ? ` · <a href="${epicViewHref(run, 'reviews')}">${count(run.fix.used, 'fix loop')}</a>` : ''}</p>
${run.tasks.some(task => task.packet.execution) ? `<p><a href="${epicViewHref(run, 'checks')}">${checks}</a>${quality.checks.missingReceipts
    ? ` · ${count(quality.checks.missingReceipts, 'current attempt')} without a check receipt` : ''}</p>` : ''}</section>
<section aria-labelledby="agent-usage-heading"><h2 id="agent-usage-heading">Usage by agent</h2>
<table class="usage-table" aria-labelledby="agent-usage-heading"><thead><tr><th scope="col">Agent</th><th scope="col">Tokens</th><th scope="col">Est. cost</th><th scope="col">Attempt time</th></tr></thead>
<tbody>${profiles.map(profile => `<tr><th scope="row">${escape(profile.name)}<small>${count(profile.attempts, 'attempt')}${profile.runningAttempts ? ` · ${profile.runningAttempts} running` : ''}</small></th>
<td>${tokenTotal(profile)}</td><td>${costTotal(profile)}</td><td>${timeTotal(profile)}</td></tr>`).join('')}</tbody></table></section>
<section aria-labelledby="task-usage-heading"><h2 id="task-usage-heading">Usage by task</h2>
<ul class="index-list">${run.tasks.map(task => {
    const { packet, usage, attempts } = task;
    const profile = run.profiles.find(value => value.id === packet.profileId);
    const [label, , tone] = taskStatus(run, task);
    return `<li id="usage-${escape(packet.id)}"><div class="section-title">
<h3><a href="${taskHref(run.id, packet.id)}">${escape(packet.title)}</a></h3>${stateBadge(label, tone)}</div>
<p>${escape(profile.name)} · Cost owner ${escape(usage.costOwner ?? 'Unrecorded')}</p>
<p>${usageSummary(usage)}</p>${usageGaps(usage) ? `<p>${usageGaps(usage)}</p>` : ''}
${attempts.length ? `<details class="usage-attempts"><summary>${count(attempts.length, 'attempt')}</summary>
<ol class="history">${attempts.map((attempt, index) => {
      const quality = attemptQuality(run, packet, attempt);
      return `<li><strong><a href="${taskHref(run.id, packet.id)}#attempt-${attempt.number}">Attempt ${attempt.number}</a></strong>
· ${escape(status(attempt)[0])}${index < (task.activeFrom ?? 0) ? ' · Superseded' : ''}
${attemptMetrics(attempt)}${quality ? `<p>${quality}</p>` : ''}</li>`;
    }).join('')}</ol></details>` : ''}</li>`;
  }).join('')}</ul></section></div>`;
}

function findingsList(findings) {
  return `<ul class="index-list">${findings.map(finding => `<li>
<strong>${escape(finding.title)}</strong><p>${escape(finding.evidence)}</p></li>`).join('')}</ul>`;
}

function reviewsPanel(run) {
  const { fix, orchestration } = run;
  const build = currentAttempt(run.tasks.find(task => task.packet.id === orchestration.buildTask));
  return `<section class="record-section"><div class="section-title"><h2>Implementation reviews</h2>
<p>${fix.used} of ${fix.limit} fix loops used</p></div>
<p class="muted">Decision owner ${escape(orchestration.decisionOwner)}${build?.candidate ? ` · Candidate <code>${escape(build.candidate.commit.slice(0, 12))}</code>` : ''}</p>
<ul class="index-list">${orchestration.reviewTasks.map(id => {
    const task = run.tasks.find(task => task.packet.id === id);
    const [verdict] = taskStatus(run, task);
    const blockers = currentAttempt(task)?.reviewFindings?.filter(finding => finding.severity === 'blocker') ?? [];
    return `<li><a href="${taskHref(run.id, id)}">${escape(task.packet.title)}</a><p>${escape(verdict)}</p>
${blockers.length ? findingsList(blockers) : ''}</li>`;
  }).join('')}</ul>
${fix.canRequest ? `<form class="decision" method="post" action="${runHref(run.id)}/fix">
<input type="hidden" name="attempt" value="${escape(fix.buildAttemptId)}">
<label for="fix-note">Fix loop reason</label><textarea id="fix-note" name="note" rows="2" required maxlength="2000"></textarea>
<p class="muted">This reopens the build and its downstream reviews for a replacement candidate. Earlier attempts stay in history.</p>
<button>Request fix loop</button></form>` : `<p class="muted">${escape(fix.reason)}</p>`}
<h3>Backlog</h3>${run.backlog.length ? `<ul class="index-list">${run.backlog.map(finding => `<li>
<a href="${taskHref(run.id, finding.taskId)}#attempt-${finding.attempt}">${escape(finding.title)}</a>
<p>${escape(finding.evidence)}</p></li>`).join('')}</ul>` : '<p class="muted">No deferred findings recorded.</p>'}
${run.fixLoops.length ? `<h3>Fix loop history</h3><ol class="index-list">${run.fixLoops.map(loop => `<li>
<strong>Loop ${loop.number} · ${escape(loop.owner)}</strong><p>${escape(loop.note)}</p>
<p>Previous candidate <code>${escape(loop.candidate.slice(0, 12))}</code></p></li>`).join('')}</ol>` : ''}</section>`;
}

function checksPanel(run) {
  const build = run.tasks.find(task => task.packet.execution?.kind === 'build');
  const receipt = currentAttempt(build)?.runnerArtifacts?.['check-receipt'];
  const result = currentAttempt(build)?.verification;
  return `<div class="epic-sections">${workspaceChecksPanel(run) + qaPanel(run) || '<p class="empty-state">No independent checks are configured for this run.</p>'}
${receipt && result ? `<section class="record-section author-check"><h2>Author tests</h2><p>${stateBadge(result.passed ? 'Suite passed' : 'Suite failed', result.passed ? 'success' : 'warning')}</p>
<p>Docker receipt for <code>${escape(result.testedCommit.slice(0, 7))}</code>.</p><a href="${artifactHref(run.id, receipt)}?view=checks">Open author test receipt ${arrow}</a></section>` : ''}</div>`;
}

function workspaceChecksPanel(run) {
  return run.tasks.filter(task => task.packet.workspaceCheck).map(task => {
    const attempt = currentAttempt(task);
    const report = attempt?.verification;
    const repairs = (run.workspaceRepairs ?? []).filter(repair => repair.verificationTaskId === task.packet.id);
    const history = repairs.length ? `<p>Previous repair rounds ${repairs.map(repair => `<a href="${artifactHref(run.id, repair.id, task.packet.id)}">${repair.round}</a>`).join(' · ')}</p>` : '';
    const head = `<section class="record-section"><h2>Music Transcribe acceptance</h2><p><a href="${taskHref(run.id, task.packet.id)}">${escape(task.packet.title)}</a></p>${history}`;
    if (!report) return head + `<p>${escape(taskStatus(run, task)[1])}</p></section>`;
    const count = report.checks.filter(check => check.passed).length;
    return `${head}<p>${stateBadge(`${count} of ${report.checks.length} checks passed`, report.passed ? 'success' : 'warning')}</p>
<p><a href="${artifactHref(run.id, report.workspaceArtifactId, task.packet.id)}">Tested workspace</a>
<code title="${escape(report.workspaceDigest)}">${escape(report.workspaceDigest.slice(0, 12))}</code></p>
${report.error ? `<p>${escape(report.error)}</p>` : ''}
<ul class="qa-cases">${report.checks.map(check => `<li><details><summary><strong>${escape(check.label)}</strong>
<span class="check-verdict ${check.passed ? 'passed' : 'failed'}">${check.passed ? 'Passed' : check.state === 'not-run' ? 'Not run' : 'Failed'}</span></summary>
${check.reason || check.error ? `<p>${escape(check.reason ?? check.error)}</p>` : ''}
${check.output ? `<pre>${escape(check.output)}</pre>` : ''}
${check.lessons?.length ? `<ul>${check.lessons.map(lesson => `<li>${escape(lesson.fixture)} · ${lesson.passed ? 'Passed' : 'Failed'}
<ul>${[['fullRenditionMatched', 'Full rendition'], ['correctionMatched', 'Spoken correction'], ['phrasePaired', 'Sung phrase'],
  ['saved', 'Saved lesson'], ['sameAudio', 'Original audio']].map(([key, label]) => `<li>${label} · ${lesson[key] ? 'Passed' : 'Failed'}</li>`).join('')}</ul></li>`).join('')}</ul>` : ''}
</details></li>`).join('')}</ul>
<p><a href="${artifactHref(run.id, attempt.runnerArtifacts['check-receipt'])}?view=checks">Open acceptance receipt ${arrow}</a></p>${workspaceRepairControl(run, task)}</section>`;
  }).join('');
}

function searchPanel(run, query, type) {
  const selected = Object.hasOwn(searchTypes, type) ? type : 'all';
  const handoffs = run.tasks.map(task => {
    const profile = run.profiles.find(value => value.id === task.packet.profileId);
    const attempt = currentAttempt(task);
    return { title: task.packet.title, detail: profile.name, href: pipelineHref(run, task.packet.id),
      terms: [task.packet.id, task.packet.objective, attempt?.result?.summary] };
  });
  const artifacts = run.artifacts.map(artifact => {
    const task = run.tasks.find(task => task.attempts.some(attempt => attempt.id === artifact.provenance.attemptId));
    const detail = task?.packet.title ?? artifact.provenance.path ?? artifact.kind;
    return { title: artifact.title, detail, href: task ? `${artifactHref(run.id, artifact.id, task.packet.id)}&amp;view=pipeline` : `${artifactHref(run.id, artifact.id)}?view=epic`,
      terms: [artifact.id, artifact.kind, artifact.provenance.sourceCommit, artifact.provenance.path] };
  });
  const verification = currentAttempt(run.tasks.find(task => task.packet.execution?.kind === 'verify'))?.verification;
  const checks = (verification?.checks ?? []).map(check => ({ title: `${check.criterion} · ${check.command.join(' ')}`,
    detail: `${check.passed ? 'Passed' : 'Failed'} · ${verification.testedCommit.slice(0, 7)}`,
    href: epicViewHref(run, 'checks', `#check-${encodeURIComponent(check.id)}`), terms: [check.id, check.criterion, verification.testedCommit, 'Docker'] }));
  const groups = { handoffs, artifacts, checks };
  const visible = Object.entries(groups).filter(([key]) => selected === 'all' || key === selected).map(([key, rows]) =>
    [key, query ? rows.filter(row => matches(query, [row.title, row.detail, ...row.terms])) : []]);
  const total = visible.reduce((count, [, rows]) => count + rows.length, 0);
  return `<section class="record-section"><div class="section-title"><h2>Search this run</h2></div>
<form class="query-bar" role="search" aria-label="Filter search results" action="${epicHref(run.project, run.epic)}"><input type="hidden" name="run" value="${escape(run.id)}"><input type="hidden" name="view" value="search">
<label class="search-field">${searchIcon}<span class="visually-hidden">Search terms</span><input name="q" type="search" value="${escape(query)}" placeholder="Task, artifact, criterion, or commit" maxlength="160"></label>
<label class="visually-hidden" for="search-type">Result type</label><select name="type" id="search-type">${selectOptions(searchTypes, selected)}</select><button class="secondary" type="submit">Search</button></form>
${!query ? '<p class="empty-state">Search by a handoff name, artifact, criterion ID, or commit.</p>' : `<p class="results-count">${total} ${total === 1 ? 'result' : 'results'} for <strong>${escape(query)}</strong></p>
${total ? visible.filter(([, rows]) => rows.length).map(([key, rows]) => `<h3 class="results-heading">${searchTypes[key]}</h3><ul class="search-results">${rows.map(row => `<li>
<a href="${row.href}"><span><strong>${escape(row.title)}</strong><small>${escape(row.detail)}</small></span>${arrow}</a></li>`).join('')}</ul>`).join('') : '<p class="empty-state">Try a different term or result type.</p>'}`}</section>`;
}

function pipelineStages(tasks) {
  const ancestors = new Map();
  const stages = [];
  let remaining = tasks;
  while (remaining.length) {
    const ready = remaining.filter(({ packet }) => packet.prerequisites.every(id => ancestors.has(id)));
    if (!ready.length) break;
    stages.push(ready.map(task => {
      const prerequisites = task.packet.prerequisites;
      const parents = prerequisites.filter(id => !prerequisites.some(other => other !== id && ancestors.get(other).has(id)));
      ancestors.set(task.packet.id, new Set(prerequisites.flatMap(id => [id, ...ancestors.get(id)])));
      return { task, parents };
    }));
    const assigned = new Set(ready);
    remaining = remaining.filter(task => !assigned.has(task));
  }
  return stages;
}

function stageConnections(previous, current) {
  const center = (index, count) => 100 * (index + 0.5) / count;
  const joins = current.flatMap(({ parents }, target) => {
    const x = center(target, current.length);
    const sources = previous.flatMap(({ task }, index) => parents.includes(task.packet.id) ? [center(index, previous.length)] : []);
    return sources.length ? [{ x, sources }] : [];
  });
  if (!joins.length) return '';
  return `<svg class="pipeline-connections vertical" viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden="true" focusable="false">
${joins.map(({ x, sources }) => `${sources.map(source => `<path d="M${source} 0 V12 H${x} V23"/>`).join('')}
<path class="pipeline-arrow" d="M${x - .8} 22 L${x} 28 L${x + .8} 22 Z"/>`).join('')}</svg>
<svg class="pipeline-connections horizontal" viewBox="0 0 28 100" preserveAspectRatio="none" aria-hidden="true" focusable="false">
${joins.map(({ x, sources }) => `${sources.map(source => `<path d="M0 ${source} H12 V${x} H23"/>`).join('')}
<path class="pipeline-arrow" d="M22 ${x - 1.2} L28 ${x} L22 ${x + 1.2} Z"/>`).join('')}</svg>`;
}

export function dispatchWorkerStatus(connected) {
  if (connected === undefined) return '';
  const status = connected ? 'Automatic dispatch worker connected.' : 'Automatic dispatch worker offline. Queued assignments will wait.';
  return `<p id="dispatch-worker-status" class="muted" role="status" data-live-section data-live-version="${connected}" data-announcement="${status}">${status}</p>`;
}

function pipelinePanel(run, step, workerConnected) {
  const stages = pipelineStages(run.tasks);
  const selected = run.tasks.find(task => task.packet.id === step) ??
    stages.flat().find(({ parents }) => parents.length > 1)?.task ?? run.tasks[0];
  const taskById = new Map(run.tasks.map(task => [task.packet.id, task]));
  return `<section class="record-section" id="pipeline" aria-labelledby="pipeline-heading"><div class="section-title"><h2 id="pipeline-heading">Handoff pipeline</h2><p>${run.tasks.length} handoffs</p></div>
${run.automation ? `<form class="section-title" method="post" action="${runHref(run.id)}/automation">
  <p>${run.automation.enabled ? 'Automatic dispatch is on.' : 'Automatic dispatch is paused.'}</p>
  <button class="secondary" name="automation" value="${run.automation.enabled ? 'pause' : 'resume'}">${run.automation.enabled ? 'Pause dispatch' : 'Resume dispatch'}</button></form>` : ''}
${dispatchWorkerStatus(workerConnected)}
${run.triagePending ? `<p><a href="${epicViewHref(run, 'triage')}">Review brief and assign team ${arrow}</a></p>` : ''}
<div class="pipeline-map"><div class="pipeline-track${stages.some(stage => stage.length > 2) ? ' wide' : ''}">
${stages.map((stage, index) => {
    const previous = stages[index - 1] ?? [];
    const previousIds = new Set(previous.map(({ task }) => task.packet.id));
    return `${stageConnections(previous, stage)}<ol class="pipeline-row" aria-label="Stage ${index + 1}">${stage.map(({ task, parents }) => {
      const { packet } = task;
      const [verdict, , tone] = taskStatus(run, task);
      const skipLinks = parents.filter(id => !previousIds.has(id)).map(id => taskById.get(id));
      const profile = run.profiles.find(value => value.id === packet.profileId);
      return `<li class="pipeline-node">
<a class="pipeline-card ${tone}" href="${pipelineHref(run, packet.id)}"${task === selected ? ' aria-current="step"' : ''}>
<strong>${escape(packet.title)}</strong><span class="pipeline-role">${escape(profile.name)}</span>
<span class="pipeline-status"><i aria-hidden="true"></i>${escape(verdict === 'Handoff accepted' ? 'Accepted' : verdict)}</span></a>
${skipLinks.length ? `<p class="pipeline-earlier">Also follows ${skipLinks.map(upstream => `<a href="${pipelineHref(run, upstream.packet.id)}">${escape(upstream.packet.title)}</a>`).join(', ')}</p>` : ''}</li>`;
    }).join('')}</ol>`;
  }).join('')}</div></div>${pipelineDetails(run, selected, taskById)}</section>`;
}

function handoffArtifacts(run, task) {
  const { packet, packetId } = task;
  const latest = currentAttempt(task);
  const repair = run.workspaceRepairs?.find(record => record.id === task.workspaceRepairId);
  const startingWorkspace = packet.workspaceSource === 'delivery' ? run.workspaceDeliveryBase ?? run.workspaceBaseline
    : packet.workspaceSource === 'baseline' ? run.workspaceBaseline : undefined;
  const followUpWorkspace = packet.agentFollowUp && task.attempts.find(attempt =>
    attempt.id === packet.agentFollowUp.history.attemptId)?.workspaceOutput;
  const workspace = latest?.workspaceInput ?? repair?.workspace ?? (latest ? undefined : followUpWorkspace ?? startingWorkspace);
  const inputs = latest?.inputArtifacts ?? [...packet.inputArtifacts, ...(repair ? [repair.id, ...repair.evidence.map(value => value.id)] : [])];
  const inputTitles = new Map((latest?.handoffs ?? []).flatMap(({ taskId, slot, artifactId }) => {
    const source = run.tasks.find(value => value.packet.id === taskId)?.packet.outputs.find(output => output.id === slot);
    return isBrowserOutput(source?.kind) ? [[artifactId, source.title ?? slot]] : [];
  }));
  const outputTitles = new Map(packet.outputs.flatMap(slot => {
    const artifactId = latest?.result?.artifacts[slot.id];
    return artifactId && isBrowserOutput(slot.kind) ? [[artifactId, slot.title ?? slot.id]] : [];
  }));
  const browserActivity = new Set(run.project.id === 'music-transcribe' ? (latest?.handoffs ?? []).filter(({ taskId, slot }) =>
    slot === browserActivitySlot && isRuntimeEvidenceSlot(run.tasks.find(value => value.packet.id === taskId)?.packet, slot))
    .map(({ artifactId }) => artifactId) : []);
  return {
    inputTitles, outputTitles, browserActivity: [...browserActivity],
    inputs: [latest?.packetId ?? packetId, ...inputs.filter(id => !browserActivity.has(id) || inputTitles.has(id)), ...(latest
      ? (latest.imageInputs ?? []).map(image => image.artifactId) : packet.imageInputIds ?? []), ...(workspace ? [workspace.artifactId] : []),
      ...(latest?.repositoryInstruction ? [latest.repositoryInstruction.artifactId] : [])],
    outputs: [...new Set([...Object.values(latest?.result?.artifacts ?? {}), latest?.runnerArtifacts?.candidate,
      latest?.runnerArtifacts?.['candidate-diff'], latest?.workspaceOutput?.artifactId, ...(latest?.generatedImages ?? []).map(image => image.artifactId)].filter(Boolean))],
    evidence: [latest?.activityId, latest?.receiptId, latest?.recoveryId, latest?.runnerArtifacts?.['check-receipt'],
      ...(latest?.developmentCheckIds ?? []), ...(latest?.browserActionIds ?? []),
      task.routing?.artifactId].filter(Boolean),
  };
}

function workspaceRepairControl(run, task) {
  const repair = task.workspaceRepairStatus;
  const attempt = currentAttempt(task);
  if (!repair || (attempt?.outcome !== 'check-failed' && repair.trigger !== 'review-finding')) return '';
  if (!repair.canRequest) return `<p class="muted">${escape(repair.reason)}</p>`;
  const target = run.tasks.find(step => step.packet.id === repair.targetTaskId);
  return `<details class="configuration-budget"><summary>Send back for repair</summary>
<p>Reopen ${escape(target.packet.title)} and its downstream steps. The repair receives the tested files, verification evidence, and your findings.</p>
<form method="post" action="${taskHref(run.id, task.packet.id)}" class="decision">
<input type="hidden" name="action" value="workspace-repair"><input type="hidden" name="attempt" value="${escape(attempt.id)}">
<label for="repair-${escape(task.packet.id)}">Repair reason</label><textarea name="note" id="repair-${escape(task.packet.id)}" rows="2" required maxlength="2000"></textarea>
<button type="submit">Open repair round ${repair.used + 1} of ${repair.limit}</button></form></details>`;
}

function plannedWorkspace(run, task, view) {
  const source = task.packet.workspaceSource;
  if (currentAttempt(task)) return '';
  if (source === 'delivery' && !run.workspaceDeliveryBase && !run.workspaceBaseline)
    return '<p class="muted">This run starts with the assignment inputs. Published files will be available to future runs.</p>';
  if (!source?.startsWith('step:')) return '';
  const parent = run.tasks.find(value => value.packet.id === source.slice(5));
  if (!parent) return '';
  const href = view === 'pipeline' ? pipelineHref(run, parent.packet.id) : taskHref(run.id, parent.packet.id);
  return `<p class="muted">Stages accepted workspace files from <a href="${href}">${escape(parent.packet.title)}</a>.</p>`;
}

function routingContext(run, task) {
  const { runWhen, joinPrerequisites } = task.packet;
  const title = id => run.tasks.find(step => step.packet.id === id)?.packet.title ?? id;
  const condition = runWhen ? `<p class="muted">Run when <a href="${taskHref(run.id, runWhen.task)}">${escape(title(runWhen.task))}</a>
    <code>${escape(runWhen.slot + (runWhen.pointer || ''))}</code> ${escape(conditionOperators[runWhen.operator].toLowerCase())}${
    runWhen.expected === undefined ? '' : ` <code>${escape(JSON.stringify(runWhen.expected))}</code>`}.${
    task.routing?.status === 'matched' && task.routingVerified ? ' Condition matched.' : ''}</p>` : '';
  const joins = joinPrerequisites?.length ? `<p class="muted">Wait for an accepted result or skip from ${joinPrerequisites.map(id =>
    `<a href="${taskHref(run.id, id)}">${escape(title(id))}</a>`).join(', ')}.</p>` : '';
  return condition + joins;
}

function plannedHandoffs(run, task, view) {
  if (currentAttempt(task) || !task.packet.handoffInputs?.length) return '';
  const heading = view === 'pipeline' ? 'h5' : 'h3';
  const evidence = { candidate: 'Candidate revision', 'candidate-diff': 'Candidate Git diff', 'check-receipt': 'Docker check receipt',
    [browserActivitySlot]: 'Browser action log' };
  return '<' + heading + '>Artifacts from prerequisites</' + heading + '><ul class="links">' +
    task.packet.handoffInputs.map(({ task: producerId, slot }) => {
    const producer = run.tasks.find(item => item.packet.id === producerId)?.packet;
    const output = producer?.outputs.find(output => output.id === slot);
    const name = output?.title || (slot === 'check-receipt' && producer?.workspaceCheck ? 'Music Transcribe acceptance receipt' : evidence[slot]) || slot;
    const href = view === 'pipeline' ? pipelineHref(run, producerId) : taskHref(run.id, producerId);
    return '<li>' + escape(name) + (isImageOutput(output?.kind) ? ' · Native image' : '') + ' · <a href="' + href + '">' + escape(producer?.title ?? producerId) + '</a></li>';
  }).join('') + '</ul>';
}

function expectedOutputs(packet) {
  return '<ul class="configuration-output-list">' + packet.outputs.map(slot => '<li>' +
    escape(slot.title || slot.id) + ' · ' + escape(artifactOutputKinds[slot.kind] ?? slot.kind) + (slot.required ? '' : ' · Optional') + '</li>').join('') +
    (packet.captureWorkspace ? '<li>Captured workspace files</li>' : '') + '</ul>';
}

function traceLink(attempt) {
  const url = verifiedTraceLink(attempt?.trace);
  if (!url) return '';
  const label = attempt.trace.activityDigests ? 'View activity in Langfuse' : 'View Codex receipt in Langfuse';
  return `<a href="${escape(url)}" target="_blank" rel="noopener noreferrer">${label}<span aria-hidden="true">↗</span></a>`;
}

function evidenceLinks(run, taskId, ids, attempt, view) {
  const trace = traceLink(attempt);
  const records = links(run, taskId, ids, view);
  if (trace) return `${records}<ul class="links trace-link"><li>${trace}</li></ul>`;
  if (attempt?.trace?.status === 'unverified') return `${records}<p class="muted trace-state">${escape(attempt.trace.error)}</p>`;
  return records;
}

const codexToolLabels = { command_execution: 'Shell command', file_change: 'File change', web_search: 'Web search',
  image_generation: 'Generate image',
  list_inputs: 'List inputs', read_input: 'Read input', search_inputs: 'Search inputs', read_skill: 'Load skill',
  check_music_sample: 'Check Music Transcribe sample',
  browse_music_workspace: 'Browse Music Transcribe workspace',
  [workspaceCheckpointTool]: workspaceCheckpointDefinition.title,
  [listGeneratedImagesTool]: listGeneratedImagesDefinition.title,
  ...Object.fromEntries(Object.entries(workflowSubmissionTools).map(([name, tool]) => [name, tool.title])),
  spawn_agent: 'Start subagent', wait: 'Wait for subagents', wait_agent: 'Wait for subagents' };

function shellCommandDetails(shell, detailId) {
  if (!shell) return '';
  const result = [
    Number.isSafeInteger(shell.exitCode) ? 'Exit code ' + shell.exitCode : '',
    Number.isSafeInteger(shell.durationMs) ? shell.durationMs + ' ms' : '',
  ].filter(Boolean).join(' · ');
  return '<details class="codex-shell-details"' + (detailId ? ' id="' + escape(detailId) + '"' : '') +
    '><summary>' + escape(result || 'Command details') + '</summary>' +
    (shell.command ? '<p>' + (shell.commandTruncated ? 'Command excerpt' : 'Command') + '</p><pre>' + escape(shell.command) + '</pre>' : '') +
    (shell.output ? '<p>' + (shell.outputTruncated ? 'End of command output' : 'Command output') + '</p><pre>' + escape(shell.output) + '</pre>' : '') +
    '</details>';
}

function codexTimeline(entries, apps = [], attemptId) {
  const appNames = new Map(apps.map(app => [app.id, app.name]));
  return '<ol class="codex-timeline">' + entries.map(entry => {
    const time = entry.at ? timestamp(entry.at) : '';
    if (entry.kind === 'message') return '<li><div class="codex-timeline-heading"><strong>Codex</strong>' + time +
      '</div><p>' + escape(entry.text) + '</p></li>';
    if (entry.kind === 'follow-up') return '<li><div class="codex-timeline-heading"><strong>Crew requested missing outputs</strong>' + time +
      '</div><p>' + escape(entry.missingOutputs.join(', ')) + '</p></li>';
    const { call } = entry;
    if (!call) return '';
    const name = appNames.has(call.appId) ? appNames.get(call.appId) + ' · ' + call.tool :
      Object.hasOwn(codexToolLabels, call.tool) ? codexToolLabels[call.tool] : call.server + '/' + call.tool;
    const state = call.status === 'running' ? 'started' : call.status;
    const detailId = attemptId && call.id ? 'shell-' + attemptId + '-' + call.id + '-' + state : undefined;
    return '<li><div class="codex-timeline-heading"><span>' + escape(name) + ' · ' + escape(state) + '</span>' + time + '</div>' +
      shellCommandDetails(call.shell, detailId) + (call.imageSaveError ? '<p>' + escape(call.imageSaveError) + '</p>' : '') + '</li>';
  }).join('') + '</ol>';
}

function liveCodexActivity(attempt) {
  if (attempt?.outcome !== 'running') return '';
  const entries = attempt.agentActivity ?? attempt.toolActivity?.map(call => ({ kind: 'tool', call })) ?? [];
  return entries.length ? '<section class="live-codex-activity" aria-label="Recent Codex activity"><h4>Recent Codex activity</h4>' +
    codexTimeline(entries, attempt.effectivePermissions?.codexApps, attempt.id) + '</section>' : '';
}

function workflowReply(run, task, attempt) {
  if (task.packet.responseMode !== 'free-form' || !attempt) return '';
  if (attempt.activityId) {
    const href = artifactHref(run.id, attempt.activityId, task.packet.id);
    return `<p><a href="${href}#final-response">Codex reply and submissions</a></p>
    ${attempt.outputFollowUpCount ? `<p><a href="${href}#output-follow-ups">${count(attempt.outputFollowUpCount, 'missing output follow-up turn')}</a></p>` : ''}`;
  }
  const preview = attempt.agentReply;
  return preview?.text ? `<div class="agent-message" data-agent-reply-preview><strong>Codex · ${attempt.outcome === 'running' && attempt.workerStatus !== 'disconnected' ? 'Reply in progress' : 'Partial reply'}</strong>
    <p>${escape(preview.text)}${preview.truncated ? '…' : ''}</p></div>` : '';
}

function codexSpeedDetails(record) {
  const report = record?.codexSpeed;
  const requested = report?.requested ?? record?.requestedServiceTier;
  if (!requested && !report?.applied) return '';
  return '<p class="muted">Codex speed · Requested ' + escape(codexServiceTierLabel(requested)) +
    (report ? ' · ' + (report.applied ? 'App Server reported ' + escape(codexServiceTierLabel(report.applied)) : 'App Server reported no tier') : '') + '</p>';
}

function codexRuntimeDetails(run, task, profile, attempt, view) {
  const observation = attempt?.codexObservation;
  if (!observation) return '';
  const { runtime, reportedModel, explicitSkills, toolCalls, recent } = observation;
  const { request, thread, flags, mcp = [], skills: discoveredSkills } = runtime ?? {};
  const detailId = 'codex-runtime-' + attempt.id;
  const policy = attempt.effectivePermissions ?? {};
  const speed = attempt.codexSpeed;
  const workspace = workspaceModes[request?.workspace ?? profile.codexRuntime?.workspace ?? 'tools'];
  const history = value => value === undefined ? undefined : value ? 'Saved thread' : 'Ephemeral thread';
  const rows = [
    ['Model', request?.model ?? attempt.runtime?.model ?? 'Worker default', thread?.model],
    ['Reasoning effort', request?.reasoningEffort ?? (profile.codexRuntime?.reasoningEffort || 'Worker default'), thread?.reasoningEffort],
    ['Speed', codexServiceTierLabel(request?.serviceTier ?? attempt.requestedServiceTier),
      speed?.applied ? codexServiceTierLabel(speed.applied) : undefined],
    ['Workspace', workspace, thread?.verified ? workspace : thread?.sandbox],
    ['Approval policy', approvalModes[request?.approval ?? policy.approval], approvalModes[thread?.approval] ?? thread?.approval],
    ['Conversation history', history(request?.persistentHistory ?? Boolean(policy.saveThread)), history(thread?.persistentHistory)],
    ['Web search', webSearchModes[request?.webSearch ?? policy.webSearch], undefined],
  ];
  const table = (columns, body) => `<table class="usage-table"><thead><tr>${columns.map(column =>
    `<th scope="col">${column}</th>`).join('')}</tr></thead><tbody>${body.map(([label, ...values]) =>
    `<tr><th scope="row">${escape(label)}</th>${values.map(value => `<td>${escape(value ?? 'Unreported')}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  const switchLabel = value => value === undefined ? undefined : value ? 'On' : 'Off';
  const configuredServers = request?.servers ?? [
    ...(policy.tools?.length ? [{ id: 'crew', name: 'Crew tools' }] : []),
    ...(policy.codexMcpServers ?? []).map(id => ({ id, name: id })),
    ...(policy.projectMcp ?? []).map(({ id, name, version }) => ({ id, name, version })),
  ];
  const mcpStates = { connected: 'Connected', starting: 'Starting', notStarted: 'Startup pending',
    authenticationRequired: 'Sign-in required', failed: 'Connection failed', cancelled: 'Startup cancelled',
    disabled: 'Disabled by Codex', unlisted: 'Missing from the thread inventory', unreported: 'Connection status unavailable' };
  const serverList = configuredServers.map(({ id, name, version }) => {
    const server = mcp.find(row => row.id === id);
    const state = server ? mcpStates[server.state] : 'Inventory unavailable';
    const catalog = server?.discoveryFailed ? 'Tool discovery failed' : Number.isInteger(server?.toolCount) ?
      count(server.toolCount, 'advertised tool') : '';
    return `<li><strong>${escape(name)}${version ? ' · v' + escape(version) : ''}</strong> · ${escape(state)}
      ${catalog ? ' · ' + escape(catalog) : ''}
      ${server?.tools?.length ? `<details id="${escape(detailId + '-' + id)}"><summary>Advertised tools</summary><ul>${server.tools.map(tool =>
        `<li><code>${escape(tool)}</code></li>`).join('')}</ul></details>` : ''}</li>`;
  }).join('');
  const taskId = task.packet.id;
  const skills = (profile.skillIds ?? []).map((id, index) => {
    const explicit = explicitSkills.some(skill => skill.artifactId === id);
    const discovery = discoveredSkills?.find(skill => skill.number === index + 1);
    const discoveryState = { available: 'Discovered by Codex', disabled: 'Disabled by Codex', unlisted: 'Missing from the Codex skill catalog' }[discovery?.state];
    return `<li><a href="${artifactHref(run.id, id, taskId, view)}">${escape(profile.skillNames?.[index] ?? id)}</a>
      · ${explicit ? 'Passed to Codex for this turn' : 'Attached to the agent'}
      ${discoveryState ? ' · ' + escape(discoveryState) : ''}${discovery?.name ? ' <code>$' + escape(discovery.name) + '</code>' : ''}</li>`;
  }).join('');
  const observed = toolCalls.map(({ tool, server, statuses }) => `<li>${escape(Object.hasOwn(codexToolLabels, tool) ? codexToolLabels[tool] : tool)}
    <small> ${escape(server)} · ${escape(Object.entries(statuses).map(([state, count]) => count + ' ' + state).join(', '))}</small></li>`).join('');
  return `<details class="agent-details" id="${escape(detailId)}" data-codex-runtime><summary>Codex runtime configuration</summary>
  ${thread ? `<p>${thread.verified ? 'Codex confirmed the workspace and approval policy.' : 'Crew stopped before starting the turn because the launch policy did not match.'}
    ${thread.permissionProfile ? ` Permission profile <code>${escape(thread.permissionProfile)}</code>.` : ''}</p>` :
    '<p class="muted">App Server launch confirmation is unavailable for this attempt.</p>'}
  ${table(['Setting', 'Requested', 'App Server'], rows)}
  ${thread?.modelProvider ? `<p>Model provider <code>${escape(thread.modelProvider)}</code></p>` : ''}
  ${reportedModel && reportedModel !== thread?.model ? `<p>Execution receipt model <code>${escape(reportedModel)}</code></p>` : ''}
  ${skills ? `<h4>Skills</h4><ul>${skills}</ul>` : ''}
  ${serverList ? `<h4>MCP servers</h4><ul>${serverList}</ul>` : ''}
  ${request?.flags && Object.keys(request.flags).length ? `<details id="${escape(detailId + '-flags')}"><summary>Native feature flags</summary>
    ${table(['Feature', 'Requested', 'App Server'], Object.entries(request.flags).sort(([a], [b]) => a.localeCompare(b))
      .map(([name, enabled]) => [name, switchLabel(enabled), switchLabel(flags?.[name])]))}</details>` : ''}
  <h4>${recent ? 'Recent tool calls' : 'Observed tool calls'}</h4>
  ${observed ? `<ul>${observed}</ul>` : '<p class="muted">No tool calls were recorded.</p>'}
  ${attempt.receiptId ? `<p><a href="${artifactHref(run.id, attempt.receiptId, taskId, view)}">View execution receipt</a></p>` : ''}
  </details>`;
}

function workspaceCheckpointDetails(run, taskId, checkpoint) {
  return `<p><a href="${artifactHref(run.id, checkpoint.artifactId, taskId)}">Workspace checkpoint</a>
    · ${number(checkpoint.fileCount)} ${checkpoint.fileCount === 1 ? 'file' : 'files'} · ${timestamp(checkpoint.capturedAt)}</p>
    <p>${escape(checkpoint.note)}</p>`;
}

function recoveryProgress(run, task, attempt) {
  if (run.project.id !== 'music-transcribe' || !attempt) return '';
  const lost = attempt.workerStatus === 'disconnected' || attempt.outcome === 'worker-disconnected';
  const checkpoint = attempt.codexCheckpoint;
  const savedWorkspace = attempt.workspaceCheckpointUnavailable ? undefined :
    attempt.workspaceCheckpoint ?? (attempt.workspaceCheckpointFrom && attempt.workspaceInput);
  if (!lost && !savedWorkspace && (attempt.outcome === 'running' || !checkpoint)) return '';
  const taskId = task.packet.id;
  const uncertain = attempt.pendingToolCalls ?? attempt.toolActivity?.filter(call => call.status === 'running') ?? [];
  const count = checkpoint?.outputCount ?? 0;
  return `<section class="live-codex-activity"><h4>${lost ? 'Worker recovery' : 'Saved progress'}</h4>
    ${checkpoint?.hasFinalReply ? '<p>Codex returned a final reply before the attempt ended.</p>' : ''}
    ${count ? `<p>${count} ${count === 1 ? 'output submission was' : 'output submissions were'} saved.</p>` : ''}
    ${attempt.workspaceCheckpointFrom && !attempt.workspaceCheckpointUnavailable ? `<p>Started from <a href="${artifactHref(run.id, attempt.workspaceCheckpointFrom.artifactId, taskId)}">a saved workspace checkpoint</a>.</p>` : ''}
    ${lost && task.packet.captureWorkspace ? savedWorkspace
      ? '<p>The next attempt starts from the saved checkpoint. Edits made later may need to be recreated.</p>'
      : '<p>The next attempt uses the configured starting workspace. Edits from this turn may need to be recreated.</p>' : ''}
    ${attempt.workspaceCheckpointUnavailable ? '<p>The workspace checkpoint could not be verified.</p>' : ''}
    ${savedWorkspace && (lost || attempt.workspaceCheckpoint) ? workspaceCheckpointDetails(run, taskId, savedWorkspace) : ''}
    ${lost && uncertain.length ? `<p>Check these tool actions before retrying.</p>${codexTimeline(uncertain.map(call =>
      ({ kind: 'tool', call: { ...call, status: 'completion unknown' } })), attempt.effectivePermissions?.codexApps)}` : ''}
    ${checkpoint ? `<p><a href="${artifactHref(run.id, checkpoint.artifactId, taskId)}">Saved Codex progress</a></p>` : ''}
  </section>`;
}

function codexQuestionForm(request, action, fields) {
  return `<form method="post" action="${action}" class="live-codex-activity codex-question-form">${fields}
    <input type="hidden" name="request" value="${escape(request.id)}">
    <h4>${request.blocking ? 'Codex needs an answer' : 'Codex requested input'}</h4>
    ${request.questions.map((question, index) => {
      const inputId = `codex-answer-${request.id}-${index}`;
      const options = question.options.map(({ label, description }, option) =>
        `<label class="codex-choice"><input type="radio" name="choice-${index}" value="${option}" required>
          <span>${escape(label)}${description ? `<small>${escape(description)}</small>` : ''}</span></label>`).join('');
      const answer = `<textarea id="${inputId}" name="answer-${index}" rows="2" maxlength="${workflowAnswerLimit}"${options ? '' : ' required'}></textarea>`;
      return `<fieldset class="codex-question">
        <legend>${question.header ? `<strong>${escape(question.header)}</strong>` : ''}${escape(question.text)}</legend>
        ${options}${!options ? `<label for="${inputId}">Your answer</label>${answer}` : question.other ?
          `<label class="codex-choice"><input type="radio" class="codex-other" name="choice-${index}" value="other" required> Other</label>
          <div class="codex-other-answer"><label for="${inputId}">Your answer</label>${answer}</div>` : ''}
      </fieldset>`;
    }).join('')}
    <button name="action" value="answer">Send answers to Codex</button>
  </form>`;
}

const approvalTitles = {
  command: 'Command approval', stdin: 'Terminal input approval', file: 'File change approval',
  network: 'Network access approval', permissions: 'Additional permissions',
};

function approvalDetails(approval) {
  const { reason, cwd, command, changes, grantRoot, network, additionalPermissions, visible } = approval;
  return `${reason ? `<p>${escape(reason)}</p>` : ''}
    ${network?.host ? `<p>Destination <code>${escape(network.host)}</code> · ${escape(network.protocol)}</p>` : ''}
    ${cwd ? `<p>Working directory <code>${escape(cwd)}</code></p>` : ''}
    ${command && !network?.host ? `<pre>${escape(command)}</pre>` : ''}
    ${grantRoot ? `<p>Requested write root <code>${escape(grantRoot)}</code></p>` : ''}
    ${changes?.length ? changes.map(change => `<details><summary>${escape(change.kind?.type)} <code>${escape(change.path)}</code>${
      change.kind?.move_path ? ` → <code>${escape(change.kind.move_path)}</code>` : ''}</summary><pre>${escape(change.diff)}</pre></details>`).join('') : ''}
    ${additionalPermissions?.length ? `<p>Permissions requested for this action</p><ul>${additionalPermissions.map(grant =>
      `<li>${escape(grant)}</li>`).join('')}</ul>` : ''}
    ${visible === false ? '<p>Codex did not provide action details for review.</p>' : ''}`;
}

function codexApprovalForm(request, action, fields) {
  const { approval } = request;
  const button = (value, label, secondary = false) => `<button${secondary ? ' class="secondary"' : ''} name="choice" value="${value}">${escape(label)}</button>`;
  const permissions = approval.type === 'permissions';
  const grants = permissions && approval.grants.length ? `<fieldset class="codex-question"><legend>Select permissions to grant</legend>
    ${approval.grants.map((grant, index) => `<label class="codex-choice"><input type="checkbox" name="grant" value="${index}">
      <span>${escape(grant)}</span></label>`).join('')}</fieldset>` : '';
  const choices = permissions ? (grants ? button('turn', 'Allow selected for this turn') + button('session', 'Allow selected for this session', true) : '') +
    button('decline', 'Decline', true) : approval.choices.map((label, index) => button(index, label, label !== 'Allow once')).join('');
  return `<form method="post" action="${action}" class="live-codex-activity codex-question-form codex-approval">${fields}
    <input type="hidden" name="request" value="${escape(request.id)}"><input type="hidden" name="action" value="approval">
    <h4>${escape(approvalTitles[approval.type])}</h4>
    ${approvalDetails(approval)}
    ${approval.type === 'command' || approval.type === 'stdin' ? '<p class="muted">An approved action may use access beyond the assignment’s base sandbox.</p>' : ''}
    ${grants}<div class="buttons">${choices}</div></form>`;
}

function elicitationField(field, index) {
  const { label, required, description, type, minimum, maximum, options, default: initial, format } = field;
  const name = 'mcp-field-' + index;
  const caption = escape(label) + (required ? '' : ' <small>Optional</small>');
  const hint = description ? `<small class="muted">${escape(description)}</small>` : '';
  if (type === 'array') return `<fieldset class="codex-question"><legend>${caption}</legend>${hint}
    ${options.map((option, choice) => `<label class="codex-choice">
      <input type="checkbox" name="${name}" value="${choice + 1}"${initial?.includes(option.value) ? ' checked' : ''}>
      <span>${escape(option.label)}</span></label>`).join('')}</fieldset>`;
  let input;
  if (options || type === 'boolean') {
    const choices = options?.map((option, choice) => ({ ...option, id: choice + 1 })) ??
      [{ value: true, label: 'Yes', id: 'true' }, { value: false, label: 'No', id: 'false' }];
    input = `<select name="${name}"${required ? ' required' : ''}><option value="">Choose an option</option>${choices.map(choice =>
      `<option value="${choice.id}"${choice.value === initial ? ' selected' : ''}>${escape(choice.label)}</option>`).join('')}</select>`;
  } else if (type === 'number' || type === 'integer') {
    input = `<input type="number" name="${name}" value="${escape(initial)}" step="${type === 'integer' ? '1' : 'any'}"
      ${minimum === undefined ? '' : `min="${minimum}"`}${maximum === undefined ? '' : ` max="${maximum}"`}${required ? ' required' : ''}>`;
  } else {
    const inputType = { email: 'email', uri: 'url', date: 'date' }[format] ?? 'text';
    input = `<input type="${inputType}" name="${name}" value="${escape(initial)}" minlength="${minimum}" maxlength="${maximum}"
      ${format === 'date-time' ? ' placeholder="2026-01-01T12:00:00Z"' : ''}${required && (minimum || format) ? ' required' : ''}>`;
  }
  return `<label class="agent-field">${caption}${hint}${input}</label>`;
}

function codexElicitationForm(request, action, fields) {
  const { elicitation } = request;
  const { server } = elicitation;
  const link = elicitation.mode === 'url';
  return `<form id="mcp-elicitation-${escape(request.id)}" method="post" action="${action}" class="live-codex-activity codex-question-form"${
    link ? ' rel="noopener"' : ''}>
    ${fields}<input type="hidden" name="request" value="${escape(request.id)}"><input type="hidden" name="action" value="elicitation">
    <h4>${escape(server.name)} ${link ? 'requested a link' : 'needs input'}${server.version ? ' · v' + escape(server.version) : ''}</h4>
    <p>${escape(elicitation.message)}</p>
    ${link ? `<p>Destination <code>${escape(elicitation.destination)}</code></p>` : elicitation.fields.map(elicitationField).join('')}
    <div class="buttons">
      ${link ? '<button name="mcp-action" value="accept" formtarget="_blank">Open site in new tab</button>' :
        '<button name="mcp-action" value="accept">Send to tool</button>'}
      <button name="mcp-action" value="decline" class="secondary" formnovalidate>Decline</button>
      <button name="mcp-action" value="cancel" class="secondary" formnovalidate>Cancel request</button>
    </div></form>`;
}

function liveTurnControls(run, task, attempt) {
  if (!attempt?.effectivePermissions?.liveSession || attempt.outcome !== 'running') return '';
  const session = attempt.codexSession;
  if (!session) return '<p class="muted">Opening the live Codex session…</p>';
  if (session.endedAt) return '<p role="status">Codex finished this turn. Crew is checking the handoff.</p>';
  const stopping = session.actions.some(item => item.kind === 'interrupt' && ['queued', 'sending', 'acknowledged'].includes(item.status));
  if (stopping) return '<p role="status">Stopping the Codex turn…</p>';
  const action = taskHref(run.id, task.packet.id);
  const fields = `<input type="hidden" name="attempt" value="${escape(attempt.id)}">
    <input type="hidden" name="turn" value="${escape(session.turnId)}">`;
  return `<div class="codex-session-controls">
    ${session.actions.filter(item => item.kind === 'approval' && item.status === 'waiting')
      .map(item => codexApprovalForm(item, action, fields)).join('')}
    ${session.actions.filter(item => item.kind === 'elicitation' && item.status === 'waiting')
      .map(item => codexElicitationForm(item, action, fields)).join('')}
    ${session.actions.filter(item => item.kind === 'answer' && item.status === 'waiting')
      .map(item => codexQuestionForm(item, action, fields)).join('')}
    <form method="post" action="${action}" class="decision">${fields}
      <label for="codex-guidance">Guidance for Codex</label>
      <textarea name="guidance" id="codex-guidance" rows="2" required maxlength="2000"></textarea>
      <button name="action" value="steer">Send guidance</button>
    </form>
    <form method="post" action="${action}">${fields}<button class="secondary" name="action" value="interrupt">Stop Codex turn</button></form>
  </div>`;
}

function sessionActions(attempt) {
  const actions = attempt?.codexSession?.actions.filter(item => item.status !== 'waiting');
  if (!actions?.length) return '';
  const labels = { queued: 'Queued', sending: 'Sending to Codex', acknowledged: 'Accepted by Codex', answered: 'Answered',
    closed: 'Closed without an answer', 'not-delivered': 'Could not deliver', unknown: 'Delivery unconfirmed' };
  const kinds = { steer: 'Guidance', interrupt: 'Stop requested', answer: 'Codex questions', elicitation: 'MCP tool input' };
  const statusText = item => item.kind === 'approval' ?
    ({ closed: 'Closed without a decision', acknowledged: 'Decision received by Codex' })[item.status] ?? labels[item.status] ?? item.status :
    labels[item.status] ?? item.status;
  return '<section class="live-codex-activity" aria-label="Operator activity"><h4>Operator activity</h4><ol class="codex-timeline">' +
    actions.map(item => '<li><div class="codex-timeline-heading"><strong>' + escape(kinds[item.kind] ?? approvalTitles[item.approval?.type]) +
      ' · ' + escape(statusText(item)) + '</strong>' + timestamp(item.createdAt) + '</div>' +
      (item.kind === 'answer' ? item.questions.map((question, index) =>
        `<p>${escape(question.text)}${item.answers ? `<br><strong>${escape(item.answers[index].text)}</strong>` : ''}</p>`).join('') :
        item.kind === 'approval' ? `<p>${escape(approvalReviewLabel(item.approval, item.review))}</p>
          <details><summary>Requested action</summary>${approvalDetails(item.approval)}</details>` :
        item.kind === 'elicitation' ? '<p>' + escape(item.elicitation.server.name) +
          (item.elicitation.destination ? ' · ' + escape(item.elicitation.destination) : '') +
          (item.responseAction ? ' · ' + escape({ accept: item.elicitation.mode === 'url' ? 'Opening approved' : 'Form submitted',
            decline: 'Declined', cancel: 'Cancelled' }[item.responseAction]) : '') + '</p>' :
        item.kind === 'steer' ? '<p>' + escape(item.text) + '</p>' : '') + '</li>').join('') + '</ol></section>';
}

function codexHistoryLink(run, attempt) {
  const history = attempt?.codexHistory;
  if (!history) return '';
  const task = run.tasks.find(task => task.packet.id === history.taskId);
  const source = task?.attempts.find(item => item.id === history.attemptId);
  if (!source) return '';
  const label = !attempt.codexSession ? 'Requested Codex history from' :
    history.kind === 'resume' ? 'Continued Codex thread from' : run.agentRun ? 'Forked Codex thread from' : 'Copied Codex history from';
  return `<p class="muted">${label} <a href="${taskHref(run.id, task.packet.id)}#attempt-${source.number}">${escape(task.packet.title)} · attempt ${source.number}</a>.</p>`;
}

function plannedCodexHistory(run, task) {
  if (!task.packet.codexHistoryFrom) return '';
  const source = run.tasks.find(item => item.packet.id === task.packet.codexHistoryFrom);
  return source ? `<p class="muted">Starts with Codex history from <a href="${taskHref(run.id, source.packet.id)}">${escape(source.packet.title)}</a>.</p>` : '';
}

function savedAgentVersion(run, profile) {
  if (run.project.id !== 'music-transcribe') return '';
  const { source, agentId, version } = run.artifacts.find(artifact => artifact.id === profile.instructionId)?.provenance ?? {};
  return source === 'agent-library' ? `<a href="${escape(projectAgentsHref(run.project, agentId, false, version))}">Agent v${escape(version)}</a>` : '';
}

function pipelineDetails(run, task, taskById) {
  const { packet, attempts } = task;
  const latest = currentAttempt(task);
  const [verdict, description, tone] = taskStatus(run, task);
  const { inputs, outputs, evidence, inputTitles, outputTitles, browserActivity } = handoffArtifacts(run, task);
  const profile = run.profiles.find(value => value.id === packet.profileId);
  const agentVersion = savedAgentVersion(run, profile);
  return `<section id="handoff-details" class="pipeline-details" aria-labelledby="handoff-details-title" tabindex="-1">
<div class="section-title"><h3 id="handoff-details-title">${escape(packet.title)}</h3>${stateBadge(verdict, tone)}</div>
<p class="muted">${escape(profile.name)}${agentVersion ? ' · ' + agentVersion : ''} · Decision owner ${escape(packet.acceptedBy)}</p>
<p class="muted">Cost owner · ${escape(task.usage.costOwner ?? 'Unrecorded')} · <a href="${taskUsageHref(run, packet.id)}">Task usage</a></p>
${attempts.length ? `<p class="muted">${usageSummary(task.usage)}</p>` : ''}
<p>${escape(latest?.result?.summary ?? description)}</p>
${routingContext(run, task)}
${codexHistoryLink(run, latest) || plannedCodexHistory(run, task)}
${liveCodexActivity(latest)}
${workflowReply(run, task, latest)}
${codexRuntimeDetails(run, task, profile, latest, 'pipeline')}
${codexSpeedDetails(latest)}
${recoveryProgress(run, task, latest)}
${sessionActions(latest)}
${Array.isArray(profile.codexTools) ? controls(run, task, waitingOn(run, task)) : ''}
${latest?.resourceIds?.length ? `<p><a href="${epicViewHref(run, 'attention')}">View resource requests ${arrow}</a></p>` : ''}
${packet.prerequisites.length ? `<p class="pipeline-deps"><strong>Depends on</strong> ${packet.prerequisites.map(id =>
    `<a href="${pipelineHref(run, id)}">${escape(taskById.get(id).packet.title)}</a>`).join(' · ')}</p>` : ''}
<div class="pipeline-artifacts"><section><h4>Inputs</h4>${links(run, packet.id, inputs, 'pipeline', inputTitles)}${browserActivityLinks(run, packet.id, browserActivity, 'pipeline')}${plannedHandoffs(run, task, 'pipeline')}${plannedWorkspace(run, task, 'pipeline')}${pinnedSkills(run, profile, packet.id, 'pipeline')}${attachedMcpServers(run.project, profile)}${attachedPlugins(profile)}${attachedApps(profile)}${pinnedNativeCapabilities(run, profile, packet.id, 'pipeline')}${pinnedSpecialists(run, profile, packet.id, 'pipeline')}</section>
<section><h4>Outputs</h4>${outputs.length ? links(run, packet.id, outputs, 'pipeline', outputTitles) : expectedOutputs(packet)}</section>
<section><h4>Evidence</h4>${evidenceLinks(run, packet.id, evidence, latest, 'pipeline')}</section></div>
<p class="pipeline-detail-links"><a href="${taskHref(run.id, packet.id)}">Open full handoff${attempts.length > 1 ? ` · ${attempts.length} attempts` : ''} ${arrow}</a>
${run.orchestration?.reviewTasks.includes(packet.id) ? ` · <a href="${epicViewHref(run, 'reviews')}">Implementation reviews</a>` : ''}</p></section>`;
}

function qaPanel(run) {
  const task = run.tasks.find(task => task.packet.execution?.kind === 'verify');
  if (!task) return '';
  const attempt = currentAttempt(task);
  const qa = attempt?.verification;
  if (!qa) return `<section class="record-section"><h2 id="qa-heading">Independent QA</h2><p>${escape(taskStatus(run, task)[1])}</p></section>`;
  const passed = qa.checks.filter(check => check.passed).length;
  return `<section class="record-section" aria-labelledby="qa-heading"><div class="section-title"><h2 id="qa-heading">Independent QA</h2>
${stateBadge(`${passed} of ${qa.checks.length} Docker checks passed`, qa.passed ? 'success' : 'warning')}</div>
<p class="muted"><code title="${escape(qa.testedCommit)}">${escape(qa.testedCommit.slice(0, 12))}</code> · ${escape(qa.platform)} · Read-only snapshot</p>
<ul class="qa-cases">${qa.checks.map(check => {
    const command = check.command.map(arg => /^[\w./-]+$/.test(arg) ? arg : JSON.stringify(arg)).join(' ');
    const expected = check.expected.stdout.text ?? `${JSON.stringify(check.expected.stdout.json)}\n`;
    return `<li><details id="check-${escape(check.id)}"><summary><strong>${escape(check.criterion)}</strong> · <code>${escape(command)}</code>
<span class="check-verdict ${check.passed ? 'passed' : 'failed'}">${check.passed ? 'Passed' : 'Failed'}</span></summary>
<dl class="check-details"><div><dt>Exit code</dt><dd>Expected ${check.expected.exitCode}, observed ${escape(check.observed.exitCode ?? 'unavailable')}</dd></div>
<div><dt>Expected stdout</dt><dd><code>${escape(JSON.stringify(expected))}</code></dd></div>
<div><dt>Observed stdout</dt><dd><code>${escape(JSON.stringify(check.observed.stdout))}</code></dd></div>
<div><dt>Expected stderr</dt><dd><code>${escape(JSON.stringify(check.expected.stderr))}</code></dd></div>
<div><dt>Observed stderr</dt><dd><code>${escape(JSON.stringify(check.observed.stderr))}</code></dd></div></dl></details></li>`;
  }).join('')}</ul><p><a href="${artifactHref(run.id, attempt.runnerArtifacts['check-receipt'])}?view=checks">Open the full independent QA receipt ${arrow}</a></p></section>`;
}

function links(run, taskId, ids, view, titles) {
  if (!ids.length) return '<p class="muted">No artifacts recorded.</p>';
  return `<ul class="links">${ids.map(id => {
    const artifact = run.artifacts.find(value => value.id === id);
    return `<li><a href="${artifactHref(run.id, id, taskId)}${view === 'pipeline' ? '&amp;view=pipeline' : ''}">${escape(titles?.get(id) ?? artifact?.title ?? id)}<span aria-hidden="true">↗</span></a></li>`;
  }).join('')}</ul>`;
}

function browserActivityLinks(run, taskId, ids, view) {
  return ids.length ? `<details class="agent-skill-files"><summary>Browser action log · ${ids.length} recorded</summary>
    ${links(run, taskId, ids, view)}</details>` : '';
}

function pinnedSkills(run, profile, taskId, view) {
  if (!profile.skillIds?.length) return '';
  return '<details class="agent-skill-files"><summary>Pinned skills</summary>' + profile.skillIds.map((id, index) => {
    const skill = run.artifacts.find(artifact => artifact.id === id)?.provenance;
    const saved = skill?.source === 'project-skill' ? '<p><a href="' + escape(projectSkillHref(run.project, skill.skillId, skill.version)) +
      '">Project skill v' + escape(skill.version) + '</a></p>' : '';
    return saved + links(run, taskId, [id, ...(profile.skillBundles?.[index]?.files ?? []).map(file => file.artifactId)], view);
  }).join('') + '</details>';
}

function attachedMcpServers(project, profile) {
  const host = (profile.codexRuntime?.mcpServers ?? []).map(name => '<li><code>' + escape(name) + '</code> · Codex host</li>');
  const connections = (profile.projectMcp ?? []).map(connection =>
    '<li><a href="' + projectHref(project) + '/tools?connection=' + encodeURIComponent(connection.id) + '&amp;version=' +
      encodeURIComponent(connection.version) + '">' + escape(connection.name) + ' · Project version ' + escape(connection.version) + '</a></li>');
  return host.length || connections.length ? '<details class="agent-skill-files"><summary>Attached MCP servers</summary><ul>' +
    [...connections, ...host].join('') + '</ul></details>' : '';
}

function attachedPlugins(profile) {
  const plugins = profile.codexRuntime?.plugins;
  return plugins?.length ? '<details class="agent-skill-files"><summary>Attached Codex plugins</summary><ul>' +
    plugins.map(id => '<li><code>' + escape(id) + '</code></li>').join('') + '</ul></details>' : '';
}

function attachedApps(profile) {
  const apps = profile.codexRuntime?.apps;
  return apps?.length ? '<details class="agent-skill-files"><summary>Connected Codex apps</summary><ul>' +
    apps.map(app => '<li>' + escape(app.name) + '</li>').join('') + '</ul></details>' : '';
}

function nativeCapabilityDetails(settings, hookLinks = '') {
  const { imageInspection, imageGeneration, commandEvidence, delegation, hostHooks, liveSession, saveThread, approvalMode, repositoryInstructions, skillSearch,
    serviceTier } = settings ?? {};
  if (!imageInspection && !imageGeneration && !commandEvidence && !delegation && !hostHooks && !liveSession && !hookLinks &&
    !repositoryInstructions && !serviceTier && !skillSearch) return '';
  const defaults = delegation ? [
    delegation.model && 'Model ' + delegation.model,
    delegation.reasoningEffort && 'Reasoning ' + delegation.reasoningEffort,
    delegation.maxConcurrent && 'Up to ' + delegation.maxConcurrent + ' concurrent subagents',
  ].filter(Boolean) : [];
  return '<details class="agent-skill-files"><summary>Native Codex capabilities</summary><ul>' +
    (serviceTier ? '<li>Requested Codex speed · ' + escape(codexServiceTierLabel(serviceTier)) + '</li>' : '') +
    (imageInspection ? '<li>Workspace image inspection</li>' : '') +
    (imageGeneration ? '<li>Native Codex image generation</li>' : '') +
    (repositoryInstructions ? '<li>Native repository instruction discovery</li>' : '') +
    (skillSearch ? '<li>Native skill search</li>' : '') +
    (commandEvidence ? '<li>Saved shell command details</li>' : '') +
    (liveSession ? '<li>Live Codex session</li>' : '') +
    (approvalMode ? '<li>Codex approvals · ' + escape(approvalModes[approvalMode]) + '</li>' : '') +
    (saveThread ? '<li>Saved Codex thread history</li>' : '') +
    (delegation ? '<li>Subagent delegation' + (defaults.length ? ' · ' + escape(defaults.join(' · ')) : ' · Codex defaults') + '</li>' : '') +
    (hostHooks ? '<li>Trusted host and attached plugin hooks</li>' : '') +
    (hookLinks ? '<li>Pinned lifecycle hook definitions' + hookLinks + '</li>' : '') +
    '</ul></details>';
}

function pinnedNativeCapabilities(run, profile, taskId, view) {
  return nativeCapabilityDetails(profile.codexRuntime, profile.hookConfigId ? links(run, taskId, [profile.hookConfigId], view) : '');
}

function pinnedSpecialists(run, profile, taskId, view) {
  const roles = profile.subagentRoleIds;
  return roles?.length ? '<details class="agent-skill-files"><summary>Pinned specialist definitions</summary>' +
    links(run, taskId, roles, view) + '</details>' : '';
}
function controls(run, task, waiting) {
  if (run.triagePending) return `<a href="${epicViewHref(run, 'triage')}">Review brief and assign team ${arrow}</a>`;
  if (waiting.length || task.routingVerified === false || task.routing?.status === 'skipped' || (task.packet.runWhen && !task.routing)) return '';
  const { packet } = task;
  const attempt = currentAttempt(task);
  const action = taskHref(run.id, packet.id);
  if (!attempt && run.automation?.enabled && !task.dispatchIssue) return '';
  if (attempt?.workerStatus === 'disconnected') return `<form method="post" action="${action}">
    <input type="hidden" name="attempt" value="${escape(attempt.id)}"><button name="action" value="recover">Recover handoff</button></form>`;
  if (attempt?.outcome === 'running') return attempt.workspaceChecksStartedAt ? '' : liveTurnControls(run, task, attempt);
  const resources = resourceWait(run, task);
  if (resources.some(resource => !resource.resolution)) {
    return `<a href="${epicViewHref(run, 'attention')}">View resource requests ${arrow}</a>`;
  }
  if (resources.length) return `<form method="post" action="${taskHref(run.id, packet.id)}">
<button name="action" value="dispatch">Resume handoff</button></form>`;
  const rework = attempt?.decision?.disposition === 'rework';
  const limit = workflowAttemptLimit(task);
  const dispatch = !attempt || ((rework || infrastructureRetry(attempt)) && packetAttemptsUsed(task) < limit);
  const continueCodex = dispatch && canReuseCodexHistory(task, attempt);
  const build = rework && attempt.packetRevision === packet.revision && run.tasks.find(task =>
    task.packet.execution?.kind === 'build' && packet.prerequisites.includes(task.packet.id) &&
    !(packet.handoffInputs ?? []).some(input => input.task === task.packet.id && input.slot === 'candidate-diff'));
  if (dispatch || build) return `<div class="buttons">
${continueCodex ? `<form method="post" action="${action}"><input type="hidden" name="attempt" value="${escape(attempt.id)}">
  <button name="action" value="continue-codex">Continue saved Codex thread</button></form>` : ''}
${dispatch ? `<form method="post" action="${action}"><button${continueCodex ? ' class="secondary"' : ''} name="action" value="dispatch">${
    attempt?.outcome === 'history-unavailable' ? packet.agentFollowUp ? 'Retry saved conversation' :
      packet.codexHistoryFrom ? 'Try history again' : 'Dispatch with a new thread' :
      attempt?.outcome === 'worker-disconnected' ? packet.agentFollowUp ? 'Retry from the previous conversation turn' :
        packet.codexHistoryFrom ? 'Dispatch from prerequisite' : 'Dispatch with a new thread' :
      continueCodex ? packet.codexHistoryFrom ? 'Start rework from prerequisite' : 'Start rework in a new thread' :
      attempt ? 'Dispatch rework' : packet.agentFollowUp ? 'Start follow-up' :
        task.workspaceRepairId ? 'Dispatch repair' : run.agentRun ? 'Start agent run' : 'Dispatch assignment'}</button></form>` : ''}
${build ? `<form method="post" action="${action}"><input type="hidden" name="build" value="${escape(build.packet.id)}"><button class="secondary" name="action" value="attach-diff">Attach candidate diff</button></form>` : ''}</div>`;
  if (run.project.id === 'music-transcribe' && canAllowAdditionalAttempt(task, attempt)) return `<form method="post" action="${action}" class="decision">
    <input type="hidden" name="attempt" value="${escape(attempt.id)}">
    <p>${escape(limit)} of ${escape(limit)} attempts used. This approval applies to this run.</p>
    <label for="attempt-reason">Reason for another attempt</label><textarea name="note" id="attempt-reason" rows="2" required maxlength="2000"></textarea>
    <button name="action" value="allow-attempt">Allow one more attempt</button></form>`;
  if (!attempt.decision && attempt.outcome !== 'running') return `${workspaceRepairControl(run, task)}<form method="post" action="${action}" class="decision">
    <input type="hidden" name="action" value="decide"><input type="hidden" name="attempt" value="${escape(attempt.id)}">
    <label for="note">Decision reason</label><textarea name="note" id="note" rows="2" required maxlength="2000"></textarea>
    <div class="buttons">${attempt.outcome === 'completed' && attempt.result?.state === 'completed' && attempt.evidenceStatus === 'recorded' &&
      !attempt.reviewFindings?.some(finding => finding.severity === 'blocker') ? '<button name="disposition" value="accepted">' +
        (run.agentRun ? 'Accept result' : 'Accept handoff') + '</button>' : ''}
    <button class="secondary" name="disposition" value="rework">Request rework</button></div></form>`;
  return '';
}

function conversationImages(run, taskId, ids = []) {
  if (!ids.length) return '';
  return '<div class="agent-turn-images">' + ids.map(id => {
    const image = run.artifacts.find(record => record.id === id && record.kind === 'agent-image');
    if (!image) return '';
    return `<figure><a href="${artifactHref(run.id, id, taskId)}"><img loading="lazy" alt="${escape(image.title)}"
      src="${artifactHref(run.id, id)}?image=1"></a><figcaption>${escape(image.title)}</figcaption></figure>`;
  }).join('') + '</div>';
}

function agentConversation(run, task, profile, latest, { followUpError, message, invokeSkills } = {}) {
  if (!task.conversation) return '';
  const taskId = task.packet.id;
  const available = latest?.evidenceStatus === 'recorded' && agentConversationHistory(run, task, latest);
  const skills = nativeSkillChoices(profile.codexRuntime?.workspace, profile.skillNames);
  const followUp = available ? `<form method="post" enctype="multipart/form-data" action="${taskHref(run.id, taskId)}" class="agent-follow-up" data-live-draft>
    <input type="hidden" name="attempt" value="${escape(latest.id)}">
    <label for="agent-message">Message Codex</label>
    <textarea id="agent-message" name="message" rows="3" required maxlength="${agentMessageLimit}">${escape(message)}</textarea>
    ${agentImageField()}
    ${skills.length ? `<details${invokeSkills?.length ? ' open' : ''}><summary>Skills for this turn</summary>
      <div class="configuration-checks">${skillInvocationChoices('invoke-skill', skills, invokeSkills)}</div></details>` : ''}
    ${profile.codexRuntime.workspace === 'workspace-write' && !latest.workspaceOutput
      ? '<p class="muted">This turn has no saved file changes. The follow-up starts from its original workspace.</p>' : ''}
    <div class="buttons"><button name="action" value="agent-continue">Send follow-up</button>
      <button class="secondary" name="action" value="agent-fork">Fork and send</button></div>
  </form>` : '';
  const turns = task.conversation.map(turn => {
    const attempt = task.attempts.find(item => item.id === turn.attemptId);
    const preview = attempt?.agentReply;
    const mode = turn.number > 1 && (turn.mode === 'fork' ? ' · Fork' : ' · Follow-up');
    const output = turn.outputId ? `<a href="${artifactHref(run.id, turn.outputId, taskId)}">Response</a>` : '';
    const evidence = attempt ? ` · <a href="#attempt-${attempt.number}">Turn evidence</a>` : '';
    return `<li><div class="section-title"><h3>Turn ${escape(turn.number)}${mode || ''}</h3>
      <small><a href="${artifactHref(run.id, turn.inputId, taskId)}">Message</a>${output ? ' · ' + output : ''}${evidence}</small></div>
      <div class="agent-message"><strong>You</strong><p>${escape(turn.message ?? 'Message unavailable.')}</p></div>
      ${conversationImages(run, taskId, turn.imageIds)}
      ${turn.response ? `<div class="agent-message"><strong>Codex</strong><p>${escape(turn.response)}</p></div>` : preview?.text ?
        `<div class="agent-message" data-agent-reply-preview><strong>Codex · ${attempt.outcome === 'running' && attempt.workerStatus !== 'disconnected' ? 'Reply in progress' : 'Partial reply'}</strong>
          <p>${escape(preview.text)}${preview.truncated ? '…' : ''}</p></div>` :
        `<p class="muted">${escape(attempt ? status(attempt, true)[0] : 'Waiting for the worker')}</p>`}
      ${conversationImages(run, taskId, turn.generatedImageIds)}</li>`;
  }).join('');
  return `<section class="agent-conversation" aria-labelledby="agent-conversation-heading">
    <h2 id="agent-conversation-heading">Conversation</h2>
    ${task.conversation[0]?.number > 1 ? '<p class="muted"><a href="#attempt-history">Earlier turns</a></p>' : ''}
    <ol class="agent-turns">${turns}</ol>
    ${followUpError ? '<p role="alert" class="agent-feedback">' + escape(followUpError) + '</p>' : ''}
    ${followUp}</section>`;
}

export function runPage(run, task, { dispatchRetry, workerConnected, followUpError, message, invokeSkills } = {}) {
  const { packet, attempts } = task;
  const profile = run.profiles.find(value => value.id === packet.profileId);
  const latest = currentAttempt(task);
  const [verdict, description, tone] = taskStatus(run, task);
  const { inputs, outputs, evidence, inputTitles, outputTitles, browserActivity } = handoffArtifacts(run, task);
  const draft = run.agentRun?.draft;
  const agentRuns = run.agentRun && (draft ? projectHref(run.project) + '/runs?type=agent-draft' :
    escape(projectAgentsHref(run.project, run.agentRun.agentId, true)));
  const agentVersion = savedAgentVersion(run, profile);
  return layout(packet.title, `<a class="skip" href="#main">Skip to ${agentRuns ? 'agent run' : 'handoff'}</a>
${projectHeader(run.project, agentRuns ? 'agent-library' : undefined)}
<main id="main"><nav class="breadcrumbs" aria-label="Location"><a href="${agentRuns || pipelineHref(run, packet.id)}">${draft ? 'Agent draft tests' : agentRuns ? 'Agent runs' : run.workflowTest ? 'Draft test · ' + escape(run.epic.title) : escape(run.epic.title)}</a></nav><h1>${escape(packet.title)}</h1>
<p class="intro">${escape(packet.objective)}</p>
${routingContext(run, task)}
${agentRuns && dispatchRetry && !latest ? '<p class="agent-feedback" role="status">The run was saved. Select Start agent run to try dispatch again.</p>' : ''}
${run.orchestration?.reviewTasks.includes(packet.id) ? `<p><a href="${epicViewHref(run, 'reviews')}">Implementation reviews and backlog</a></p>` : ''}
<section class="status ${tone}" aria-labelledby="run-status"><div><p class="eyebrow">Current status</p>
<h2 id="run-status">${verdict}</h2><p>${escape(workerConnected === false ? 'The message is saved. It will run when the project worker reconnects.' : description)}</p></div><div class="action">${controls(run, task, waitingOn(run, task))}</div></section>
${agentConversation(run, task, profile, latest, { followUpError, message, invokeSkills })}
<div class="columns"><aside>${agentRuns ? '<h2>Agent run</h2>' : `<h2>Workflow</h2><ul class="links workflow">${run.tasks.map(item => `<li>
<a href="${taskHref(run.id, item.packet.id)}"${item === task ? ' aria-current="page"' : ''}>${escape(item.packet.title)}<span>${escape(taskStatus(run, item)[0])}</span></a></li>`).join('')}</ul>`}
<dl class="meta"><div><dt>${run.triagePending ? 'Proposed assignee' : 'Assigned to'}</dt><dd><a href="${artifactHref(run.id, profile.instructionId, packet.id)}">${escape(profile.name)}</a></dd></div>
${(!agentRuns && run.automation) || packet.reviewMode === 'automatic' ? `<div><dt>Handoff review</dt><dd>${packet.reviewMode === 'automatic' ? 'Evidence validation' : 'Human acceptance'}</dd></div>` : ''}
<div><dt>Decision owner</dt><dd>${escape(packet.acceptedBy)}</dd></div><div><dt>Cost owner</dt><dd>${escape(task.usage.costOwner ?? 'Unrecorded')}</dd></div>
${run.project.id === 'music-transcribe' ? `<div><dt>Attempts</dt><dd>${packetAttemptsUsed(task)} of ${workflowAttemptLimit(task)}${
  task.attemptBudgetChange ? ' · <a href="' + artifactHref(run.id, task.attemptBudgetChange.artifactId, packet.id) + '">Approval record</a>' : ''}</dd></div>` : ''}
${run.project.configurationVersion ? `<div><dt>Configuration version</dt><dd>${escape(run.project.configurationVersion)}</dd></div>` : ''}
${draft ? `<div><dt>Draft test</dt><dd><a href="${artifactHref(run.id, draft.artifactId, packet.id)}">Tested agent definition</a>${
  draft.baseAgentId ? ' · <a href="' + escape(projectAgentsHref(run.project, draft.baseAgentId, false, draft.baseVersion)) +
    '">Based on v' + number(draft.baseVersion) + '</a>' : ' · New agent'}</dd></div>`
    : agentVersion ? `<div><dt>Saved agent</dt><dd>${agentVersion}</dd></div>`
    : agentRuns ? `<div><dt>Agent version</dt><dd>${escape(run.agentRun.version)}</dd></div>` : ''}
<div><dt>Git baseline</dt><dd><code title="${escape(run.sourceCommit)}">${escape(run.sourceCommit.slice(0, 12))}</code></dd></div>
<div><dt>Run</dt><dd><code>${escape(run.id)}</code></dd></div></dl></aside>
<div class="records"><div class="grid"><section><h2>Inputs</h2>${links(run, packet.id, inputs, undefined, inputTitles)}${browserActivityLinks(run, packet.id, browserActivity)}${plannedHandoffs(run, task)}${plannedWorkspace(run, task)}${pinnedSkills(run, profile, packet.id)}${attachedMcpServers(run.project, profile)}${attachedPlugins(profile)}${attachedApps(profile)}${pinnedNativeCapabilities(run, profile, packet.id)}${pinnedSpecialists(run, profile, packet.id)}</section>
<section><h2>Outputs</h2>${outputs.length ? links(run, packet.id, outputs, undefined, outputTitles) : expectedOutputs(packet)}</section></div>
<section><h2>Evidence</h2>${evidenceLinks(run, packet.id, evidence, latest)}
${liveCodexActivity(latest)}
${workflowReply(run, task, latest)}
${codexRuntimeDetails(run, task, profile, latest)}
${codexSpeedDetails(latest)}
${recoveryProgress(run, task, latest)}
${sessionActions(latest)}
${codexHistoryLink(run, latest) || plannedCodexHistory(run, task)}
${latest?.result ? `<p>${escape(latest.result.summary)}</p>${[['Questions', latest.result.questions], ['Agent decisions', latest.result.decisions], ['Blockers', latest.result.blockers]].filter(([, values]) => values.length).map(([label, values]) => `<h3>${label}</h3><ul>${values.map(value => `<li>${escape(value)}</li>`).join('')}</ul>`).join('')}` : ''}</section>
<section><div class="section-title"><h2>Usage</h2>${agentRuns ? '' : `<a href="${taskUsageHref(run, packet.id)}">Workflow usage ${arrow}</a>`}</div>
<p>${usageSummary(task.usage)}</p><p class="muted">${number(packet.budget.targetTotalTokens)} token target per attempt</p></section>
${attempts.length ? `<section id="attempt-history"><h2>${task.conversation ? 'Turn evidence' : 'Attempt history'}</h2><ol class="history">${attempts.map(attempt => `<li id="attempt-${attempt.number}">
<strong>${task.conversation ? 'Turn ' + attempt.packetRevision + ' · ' : ''}Attempt ${attempt.number}</strong> · ${escape(status(attempt, run.agentRun)[0])}${!task.conversation && attempt.number <= (task.activeFrom ?? 0) ? ' · Superseded' : ''}${!task.conversation && attempt.dispatchSource === 'workflow' ? ' · Automatic dispatch' : ''}${attempt.packetId ? ` · <a href="${artifactHref(run.id, attempt.packetId, packet.id)}">Packet revision ${attempt.packetRevision}</a>` : ''}${attempt.receiptId ? ` · <a href="${artifactHref(run.id, attempt.receiptId, packet.id)}">Receipt</a>` : ''}
${task.conversation && attempt.inputArtifacts?.[0] ? ` · <a href="${artifactHref(run.id, attempt.inputArtifacts[0], packet.id)}">Message</a>` : ''}
${(attempt.imageInputs ?? []).map(image => ` · <a href="${artifactHref(run.id, image.artifactId, packet.id)}">${escape(image.name)}</a>`).join('')}
${attempt.activityId ? ` · <a href="${artifactHref(run.id, attempt.activityId, packet.id)}">Codex activity</a>` : ''}
${attempt.recoveryId ? ` · <a href="${artifactHref(run.id, attempt.recoveryId, packet.id)}">Worker recovery record</a>` : ''}
${attempt.workspaceCheckpoint && !attempt.workspaceCheckpointUnavailable ? ` · <a href="${artifactHref(run.id, attempt.workspaceCheckpoint.artifactId, packet.id)}">Workspace checkpoint</a>` : ''}
${attempt.workspaceCheckpointFrom && !attempt.workspaceCheckpointUnavailable ? ` · <a href="${artifactHref(run.id, attempt.workspaceCheckpointFrom.artifactId, packet.id)}">Starting checkpoint</a>` : ''}
${attempt.workspaceOutput ? ` · <a href="${artifactHref(run.id, attempt.workspaceOutput.artifactId, packet.id)}">Captured workspace</a>` : ''}
${(attempt.generatedImages ?? []).map(image => ` · <a href="${artifactHref(run.id, image.artifactId, packet.id)}">${escape(image.name)}</a>`).join('')}
${attempt.workspaceRepair ? ` · <a href="${artifactHref(run.id, attempt.workspaceRepair.id, packet.id)}">Repair round ${attempt.workspaceRepair.round}</a>` : ''}
${attempt !== latest ? codexHistoryLink(run, attempt) : ''}
${attempt.resumedFrom ? ` · Resumed after <a href="${epicViewHref(run, 'attention')}">resource setup</a>` : ''}
${Object.values(attempt.result?.artifacts ?? {}).map(id => ` · <a href="${artifactHref(run.id, id, packet.id)}">Output</a>`).join('')}
${traceLink(attempt) ? ` · ${traceLink(attempt)}` : ''}
${attemptMetrics(attempt)}
${attemptQuality(run, packet, attempt) ? `<p>${attemptQuality(run, packet, attempt)}</p>` : ''}
${attempt.decision ? `<p class="muted">${escape(attempt.decision.owner)} recorded ${escape(attempt.decision.disposition)}. ${escape(attempt.decision.note)}</p>` : ''}</li>`).join('')}</ol></section>` : ''}
</div></div></main>`, latest?.outcome === 'running' || run.automation?.pending || Boolean(run.automation?.enabled && run.handoffs.running));
}

function workspaceArtifactContent(artifact) {
  const { files, bytes } = readWorkspaceArtifact(artifact.content);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  return `<p>${number(files.length)} ${files.length === 1 ? 'file' : 'files'} · ${number(bytes)} bytes</p>` + files.map(file => {
    const data = Buffer.from(file.data, 'base64');
    let text;
    try { if (!data.includes(0)) text = decoder.decode(data); } catch {}
    return `<details class="configuration-artifact"><summary><code>${escape(file.path)}</code> · ${number(data.length)} bytes</summary>
<p><a href="?file=${encodeURIComponent(file.path)}">Download file</a></p>${text !== undefined ? `<pre>${escape(text)}</pre>` : ''}</details>`;
  }).join('');
}

function artifactContent(artifact, run, fromTask) {
  const raw = () => '<pre>' + escape(artifact.content) + '</pre>';
  if (artifact.kind === 'workspace') return workspaceArtifactContent(artifact);
  if (run.project.id === 'music-transcribe' && ['recovery', 'codex-checkpoint'].includes(artifact.provenance.source)) {
    try { return recoveryArtifactContent(JSON.parse(artifact.content), run, fromTask); }
    catch { return raw(); }
  }
  if (artifact.kind === 'agent-image') {
    const url = artifactHref(run.id, artifact.id) + '?image=1';
    return `<figure class="agent-image-preview"><img src="${url}" alt="${escape(artifact.title)}">
      <figcaption><a href="${url}">Open original image</a> · ${number(artifact.provenance.bytes)} bytes</figcaption></figure>`;
  }
  if (artifact.provenance.source === 'runtime' && artifact.id.startsWith('browser-action-')) {
    try {
      const record = JSON.parse(artifact.content);
      const playback = record.action === 'observe_media' && record.result?.samples;
      const rates = playback && [...new Set(playback.filter(sample => !sample.paused).map(sample => sample.rate))];
      return (playback ? `<section class="record-section"><h2>Media observation</h2><p>${escape(record.result.name ?? record.result.media)}</p>
        <dl class="meta">${record.result.trigger ? `<div><dt>Clicked control</dt><dd>${escape(record.result.trigger.name)}</dd></div>` : ''}
        <div><dt>Playback rates while playing</dt><dd>${rates.length ? escape(rates.join('×, ') + '×') : 'No active playback observed'}</dd></div>
        <div><dt>Media clock advances</dt><dd>${number(record.result.advancingIntervals)}</dd></div>
        <div><dt>Media clock rewinds</dt><dd>${number(record.result.rewinds.length)}</dd></div></dl></section>` : '') +
        (record.imageEvidence ? conversationImages(run, fromTask, [record.imageEvidence.artifactId]) : '') +
        (record.workspaceArtifactId ? links(run, fromTask, [record.workspaceArtifactId]) : '') + raw();
    } catch { return raw(); }
  }
  if (artifact.provenance.source !== 'runtime' || !artifact.id.startsWith('activity-')) return raw();
  let activity;
  try { activity = JSON.parse(artifact.content); } catch { return raw(); }
  const launch = describeCodexLaunch({ harness: 'codex', launch: activity.launch });
  if (!launch) return raw();
  const tools = Array.isArray(activity.toolCalls) ? activity.toolCalls : [];
  const plugins = Array.isArray(activity.codexPlugins) ? activity.codexPlugins : [];
  const apps = Array.isArray(activity.codexApps) ? activity.codexApps : [];
  const appNames = new Map(apps.map(app => [app.id, app.name]));
  const timeline = Array.isArray(activity.timeline) ? activity.timeline : [];
  const toolList = '<section class="record-section"><h2>Tool calls</h2>' + (tools.length ? '<ol>' + tools.map(call =>
    '<li><code>' + escape(call.server + '/' + call.tool) + '</code> · ' + escape(call.status) +
    (call.source === 'plugin' ? ' · Codex plugin' : '') +
    (call.source === 'app' ? ' · ' + escape(appNames.get(call.appId) ?? call.appId) : '') +
    (call.source === 'subagent' ? ' · Delegation' + (call.subagentIds?.length ? ' · ' + escape(call.subagentIds.join(', ')) : '') : '') +
    (call.generatedImage ? ' · <a href="' + artifactHref(run.id, call.generatedImage.artifactId, fromTask) + '">' + escape(call.generatedImage.name) + '</a>' : '') +
    (call.imageSaveError ? '<p>' + escape(call.imageSaveError) + '</p>' : '') +
    shellCommandDetails(call.shell) +
    '</li>').join('') + '</ol>' : '<p>No tool calls were recorded.</p>') + '</section>';
  return `<section class="record-section"><h2>Codex command</h2><p class="muted">Temporary paths use <code>$RUN_DIR</code>.</p>
<pre>${escape(formatCodexLaunch(launch))}</pre></section>
${launch.thread ? '<details class="agent-skill-files"><summary>Codex thread settings</summary><pre>' +
    escape(JSON.stringify(launch.thread, null, 2)) + '</pre></details>' : ''}
${codexSpeedDetails({ ...activity, requestedServiceTier: launch.thread?.serviceTier })}
${plugins.length ? '<section class="record-section"><h2>Codex plugins</h2><ul>' + plugins.map(({ id, version }) =>
    '<li><code>' + escape(id) + '</code>' + (version ? ' · ' + escape(version) : '') + '</li>').join('') + '</ul></section>' : ''}
${apps.length ? '<section class="record-section"><h2>Connected Codex apps</h2><ul>' +
    apps.map(app => '<li>' + escape(app.name) + '</li>').join('') + '</ul></section>' : ''}
${activity.explicitSkills?.length ? '<section class="record-section"><h2>Explicit skill inputs</h2><ul>' +
    activity.explicitSkills.map(skill => '<li>' + (skill.artifactId
      ? '<a href="' + artifactHref(run.id, skill.artifactId, fromTask) + '">' + escape(skill.title) + '</a>'
      : escape(skill.title)) + ' · <code>$' + escape(skill.name) + '</code>' +
      (skill.projectSkill ? ' · Project skill v' + escape(skill.projectSkill.version) : '') + '</li>').join('') +
    '</ul></section>' : ''}
${activity.imageInputs?.length ? '<section class="record-section"><h2>Native image inputs</h2><ul>' +
    activity.imageInputs.map(image => '<li><a href="' + artifactHref(run.id, image.artifactId, fromTask) + '">' + escape(image.name) +
      '</a> · ' + number(image.bytes) + ' bytes' + (image.handoff ?
        ' · <a href="' + taskHref(run.id, image.handoff.taskId) + '">Producing handoff</a>' : '') + '</li>').join('') + '</ul></section>' : ''}
${nativeCapabilityDetails(activity)}
${activity.subagentRoles?.length ? '<section class="record-section"><h2>Available specialist roles</h2><ul>' +
    activity.subagentRoles.map(name => '<li><code>' + escape(name) + '</code></li>').join('') + '</ul></section>' : ''}
${activity.lifecycleHooks?.length ? '<section class="record-section"><h2>Configured lifecycle hooks</h2><ul>' +
    (activity.lifecycleHooks ?? []).map(event => '<li><code>' + escape(event) + '</code></li>').join('') +
    '</ul></section>' : ''}
${activity.repositoryInstruction ? `<section class="record-section"><h2>Starting repository instructions</h2>
  <p><a href="${artifactHref(run.id, activity.repositoryInstruction.artifactId, fromTask)}">${escape(activity.repositoryInstruction.path)}</a>
   · ${number(activity.repositoryInstruction.bytes)} bytes</p></section>` : ''}
${timeline.length ? '<section class="record-section"><h2>Codex activity</h2>' +
    (activity.omittedEvents ? '<p class="muted">Showing the latest ' + escape(timeline.length) + ' events.</p>' : '') +
    codexTimeline(timeline, apps) + '</section>' : ''}
${timeline.length && tools.length ? '<details class="agent-skill-files"><summary>Tool-call record</summary>' + toolList + '</details>' : toolList}
${sessionActions(activity)}
<section class="record-section"><h2>${activity.responseFormat === 'free-form' ? 'Exact turn input' : 'Exact prompt'}</h2><pre>${escape(activity.prompt)}</pre></section>
<section class="record-section" id="final-response"><h2>Final response</h2>${activity.response ? '<pre>' + escape(activity.response) + '</pre>' : '<p>No final response was recorded.</p>'}</section>
${outputFollowUpDetails(activity.outputFollowUps)}
${activity.workflowSubmissions ? `<section class="record-section"><h2>Submitted workflow outputs</h2>
  ${activity.workflowSubmissions.outputs.length ? activity.workflowSubmissions.outputs.map(({ slot, content, image, evidence }) =>
    `<details class="agent-skill-files"><summary>${escape(slot)}</summary>${image || evidence ? links(run, fromTask, [(evidence ?? image).artifactId]) :
      '<pre>' + escape(content) + '</pre>'}</details>`).join('') : '<p>No outputs submitted.</p>'}
  ${activity.workflowSubmissions.blocker ? `<h3>Reported blocker</h3><p>${escape(activity.workflowSubmissions.blocker.reason)}</p>` : ''}
</section>` : ''}`;
}

function outputFollowUpDetails(followUps) {
  if (!followUps?.length) return '';
  return `<section class="record-section" id="output-follow-ups"><h2>Missing output follow-up turns</h2>
  ${followUps.map(({ previousTurnId, turnId, missingOutputs, at, prompt, previousReply }) => `
  <details class="agent-skill-files"><summary>${escape(missingOutputs.join(', '))} · ${timestamp(at)}</summary>
    <dl class="meta"><div><dt>Previous turn</dt><dd><code>${escape(previousTurnId)}</code></dd></div>
      <div><dt>Follow-up turn</dt><dd><code>${escape(turnId)}</code></dd></div></dl>
    ${previousReply?.text ? `<h3>Previous Codex reply${previousReply.truncated ? ' excerpt' : ''}</h3><pre>${escape(previousReply.text)}</pre>` : ''}
    <h3>Exact follow-up input</h3><pre>${escape(prompt)}</pre></details>`).join('')}</section>`;
}

function recoveryArtifactContent(record, run, taskId) {
  const launch = record.launch && describeCodexLaunch({ harness: 'codex', launch: record.launch });
  const outputs = record.savedOutputs ?? record.outputs ?? [];
  const reply = record.finalReply ?? record.reply;
  const blocker = record.reportedBlocker ?? record.blocker;
  const apps = run.tasks.find(task => task.packet.id === record.taskId)?.attempts
    .find(attempt => attempt.id === record.attemptId)?.effectivePermissions?.codexApps;
  return `${record.checkpoint ? `<p><a href="${artifactHref(run.id, record.checkpoint.artifactId, taskId)}">Open exact Codex launch and saved progress</a></p>` : ''}
${record.checkpointUnavailable ? '<p>The saved Codex progress could not be verified.</p>' : ''}
${record.workspaceCheckpoint ? workspaceCheckpointDetails(run, taskId || record.taskId, record.workspaceCheckpoint) : ''}
${record.workspaceCheckpointUnavailable ? '<p>The workspace checkpoint could not be verified.</p>' : ''}
${codexSpeedDetails(record)}
${outputFollowUpDetails(record.outputFollowUps)}
${record.generatedImages?.length ? `<section class="record-section"><h2>Generated images</h2>${links(run, taskId, record.generatedImages.map(image => image.artifactId))}</section>` : ''}
${record.uncertainTools?.length ? `<section class="record-section"><h2>Tool actions to check before retrying</h2>
  ${codexTimeline(record.uncertainTools.map(call => ({ kind: 'tool', call: { ...call, status: 'completion unknown' } })), apps)}</section>` : ''}
${outputs.length ? `<section class="record-section"><h2>Saved output submissions</h2>
  ${outputs.map(({ slot, content, at, image, evidence }) => `<details class="agent-skill-files"><summary>${escape(slot)} · ${timestamp(at)}</summary>
    ${image || evidence ? links(run, taskId, [(evidence ?? image).artifactId]) : '<pre>' + escape(content) + '</pre>'}</details>`).join('')}</section>` : ''}
${blocker ? `<section class="record-section"><h2>Reported blocker</h2><p>${escape(blocker.reason)}</p></section>` : ''}
${reply ? `<section class="record-section"><h2>${reply.kind === 'partial' ? 'Partial Codex reply' : 'Recorded final Codex reply'}</h2>
  <pre>${escape(reply.text)}${reply.truncated ? '…' : ''}</pre></section>` : ''}
${record.recentActivity?.length ? `<section class="record-section"><h2>Last recorded activity</h2>${codexTimeline(record.recentActivity, apps)}</section>` : ''}
${sessionActions(record)}
${launch ? `<details class="record-section"><summary>Codex command and exact turn input</summary>
  <pre>${escape(formatCodexLaunch(launch))}</pre><pre>${escape(record.prompt)}</pre></details>` : ''}
<details class="record-section"><summary>Record details</summary><pre>${escape(JSON.stringify(record, null, 2))}</pre></details>`;
}

export function artifactPage(artifact, run, fromTask, view) {
  const featureSource = artifact.provenance.featureSource;
  const provenance = artifact.provenance.source === 'postgres'
    ? `Postgres · Configuration version ${artifact.provenance.version} · Git baseline ${artifact.provenance.sourceCommit}`
    : artifact.provenance.source === 'workflow-test' ? `Postgres · Draft test · Git baseline ${artifact.provenance.sourceCommit}`
    : artifact.provenance.source === 'agent-run' ? `Postgres · Saved agent v${artifact.provenance.version}`
    : artifact.provenance.source === 'agent-draft' ? `Postgres · Agent draft · Git baseline ${artifact.provenance.sourceCommit}`
    : artifact.provenance.source === 'agent-follow-up' ? `Postgres · Conversation turn ${artifact.provenance.turn}`
    : artifact.provenance.source === 'agent-image' ? `Postgres · Image attachment · Conversation turn ${artifact.provenance.turn}`
    : artifact.provenance.source === 'workflow-request-image' ? 'Postgres · Workflow request image'
    : artifact.provenance.source === 'codex-generated-image' ? `Postgres · Codex image generation · Attempt ${artifact.provenance.attemptId}`
    : artifact.provenance.source === 'codex-browser-screenshot' ? `Postgres · Workspace browser · Attempt ${artifact.provenance.attemptId}`
    : artifact.provenance.source === 'project-skill' ? `Postgres · Project skill v${artifact.provenance.version} · ${artifact.provenance.agentDraft ? 'Agent draft' : 'Agent v' + artifact.provenance.agentVersion}`
    : artifact.provenance.source === 'routing' ? `Workflow routing · ${artifact.provenance.taskId}`
    : artifact.provenance.source === 'git-workspace' ? `Git workspace · ${artifact.provenance.sourceCommit}`
    : artifact.provenance.source === 'workspace-capture' ? `Captured workspace · Attempt ${artifact.provenance.attemptId}`
    : artifact.provenance.source === 'workspace-checkpoint' ? `Postgres · Workspace checkpoint · Attempt ${artifact.provenance.attemptId}`
    : artifact.provenance.source === 'workspace-repair' ? `Repair decision · Verification attempt ${artifact.provenance.attemptId}`
    : ['recovery', 'codex-checkpoint'].includes(artifact.provenance.source) ? `Postgres · Attempt ${artifact.provenance.attemptId}`
    : artifact.provenance.source === 'workspace-delivery' ? `Published workspace · Verification attempt ${artifact.provenance.attemptId}`
    : artifact.provenance.source === 'published-workspace-base' ? `Published workspace base · Run ${artifact.provenance.runId}`
    : artifact.provenance.source === 'repository-instructions' ? `Starting workspace · ${artifact.provenance.path} · Attempt ${artifact.provenance.attemptId}`
    : artifact.provenance.source === 'workflow-request' ? `Request brief · ${artifact.provenance.runId}`
    : artifact.provenance.source === 'agent-library' ? `Agent library · Version ${artifact.provenance.version}`
    : artifact.provenance.source === 'git' ? `Git · ${artifact.provenance.path} · ${artifact.provenance.sourceCommit}`
    : artifact.provenance.source === 'triage' ? `Triage · Git baseline ${artifact.provenance.sourceCommit}`
      : artifact.provenance.source === 'resource-resolution'
        ? `Resource resolution · Git baseline ${artifact.provenance.sourceCommit} · Attempt ${artifact.provenance.attemptId}`
        : `${artifact.provenance.source} · ${artifact.provenance.attemptId}`;
  let back = [projectHref(run.project), 'Back to project'];
  if (fromTask && view === 'pipeline') back = [pipelineHref(run, fromTask), 'Back to the pipeline step'];
  else if (fromTask) back = [taskHref(run.id, fromTask), run.agentRun ? 'Back to the agent run' : 'Back to the handoff'];
  else if (view === 'agents') back = [run.project.id === 'music-transcribe' ? projectAgentsHref(run.project) : `${projectHref(run.project)}/agents`, 'Back to agents'];
  else if (view === 'checks') back = [epicViewHref(run, 'checks'), 'Back to checks'];
  else if (view === 'delivery') back = [epicViewHref(run, 'delivery'), 'Back to delivery'];
  else if (view === 'triage') back = [epicViewHref(run, 'triage'), 'Back to triage'];
  else if (view === 'attention') back = [epicViewHref(run, 'attention'), 'Back to Needs attention'];
  else if (view === 'epic') back = [`${epicHref(run.project, run.epic)}?run=${encodeURIComponent(run.id)}`, 'Back to the epic'];
  const skillFile = artifact.kind === 'skill-resource';
  const content = skillFile ? '<p>' + escape(number(artifact.provenance.bytes)) + ' bytes</p><p><a href="' +
    artifactHref(run.id, artifact.id) + '?download=1">Download pinned file</a></p>' : artifactContent(artifact, run, fromTask);
  return layout(artifact.title, `${projectHeader(run.project)}<main><nav class="breadcrumbs" aria-label="Location"><a href="${back[0]}">← ${back[1]}</a></nav>
<p class="eyebrow">Linked artifact</p><h1>${escape(artifact.title)}</h1><p class="muted provenance">${escape(provenance)}</p>
${artifact.provenance.source === 'workspace-checkpoint' ? `<p>${escape(artifact.provenance.note)} · ${timestamp(artifact.provenance.capturedAt)}</p>` : ''}
${artifact.provenance.source === 'repository-instructions' ? `<p><a href="${artifactHref(run.id, artifact.provenance.workspaceArtifactId, fromTask)}">Starting workspace snapshot</a></p>` : ''}
${featureSource ? `<details><summary>Copied Feature profile</summary><p class="provenance">${escape(featureSource.profileId)} · <code>${escape(featureSource.digest)}</code></p></details>` : ''}
${artifact.provenance.source === 'published-workspace-base' ? `<p><a href="${artifactHref(artifact.provenance.runId, artifact.provenance.artifactId)}">Source workspace</a>
 · <a href="${artifactHref(artifact.provenance.runId, 'workspace-delivery')}?view=delivery">Source delivery record</a></p>` : ''}
${content}<details><summary>SHA-256 digest</summary><code class="provenance">${escape(skillFile || artifact.kind === 'agent-image' ?
    artifact.provenance.sha256 : artifact.digest)}</code></details></main>`);
}

export function errorPage(message, handoff) {
  const link = handoff ? `<a href="${escape(handoff)}">Back to handoff</a>` : '<a href="/">Back to project</a>';
  return layout('Unable to open', `<main><h1>Unable to open</h1><p>${escape(message)}</p>${link}</main>`);
}
