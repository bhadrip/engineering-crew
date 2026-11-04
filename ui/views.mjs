import { verifiedTraceLink } from '../lib/langfuse.mjs';

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function layout(title, body, running = false) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
${running ? '<meta http-equiv="refresh" content="3">' : ''}<title>${escape(title)}</title>
<link rel="stylesheet" href="/crew.css"><script src="/crew.js" defer></script></head><body>${body}</body></html>`;
}

function status(attempt) {
  if (!attempt) return ['Ready to dispatch', 'The assignment has inputs and is ready to start.', 'neutral'];
  if (attempt.outcome === 'check-failed' && !attempt.decision) {
    return ['Docker checks failed', attempt.error ?? 'Open the check receipt for the observed results.', 'warning'];
  }
  if (attempt.result?.state === 'completed' && attempt.evidenceStatus === 'missing') {
    return ['Evidence incomplete', 'A required output or execution receipt is missing or no longer matches the record.', 'warning'];
  }
  if (attempt.decision?.disposition === 'accepted') return ['Handoff accepted', attempt.decision.note, 'success'];
  if (attempt.decision?.disposition === 'rework') return ['Rework requested', attempt.decision.note, 'warning'];
  if (attempt.outcome === 'running') return ['Codex is working', 'This page refreshes while the attempt runs.', 'neutral'];
  if (attempt.result?.state === 'completed') return ['Ready for review', 'Open the returned artifacts and record a decision.', 'neutral'];
  if (attempt.result?.state === 'blocked') return ['Agent reported a blocker', attempt.result.summary, 'warning'];
  return ['Attempt needs attention', attempt.error ?? attempt.result?.summary ?? 'Review the attempt before retrying.', 'warning'];
}

const projectHref = project => `/projects/${encodeURIComponent(project.id)}`;
const epicHref = (project, epic) => `${projectHref(project)}/epics/${encodeURIComponent(epic.id)}`;
const runHref = run => `/runs/${encodeURIComponent(run)}`;
const taskHref = (run, task) => `${runHref(run)}/tasks/${encodeURIComponent(task)}`;
const artifactHref = (run, id, task) => `${runHref(run)}/artifacts/${encodeURIComponent(id)}${task ? `?task=${encodeURIComponent(task)}` : ''}`;
const epicViewHref = (run, view, hash = '') => `${epicHref(run.project, run.epic)}?run=${encodeURIComponent(run.id)}&amp;view=${encodeURIComponent(view)}${hash}`;
const pipelineHref = (run, step) => `${epicViewHref(run, 'workflow')}${step ? `&amp;step=${encodeURIComponent(step)}#handoff-details` : '#pipeline'}`;
const searchIcon = '<svg class="icon" viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.25"/><path d="m12.5 12.5 4 4"/></svg>';
const arrow = '<span class="row-arrow" aria-hidden="true">→</span>';

function matches(query, values) {
  const haystack = values.filter(value => typeof value === 'string').join(' ').toLocaleLowerCase();
  return query.toLocaleLowerCase().split(/\s+/).every(word => haystack.includes(word));
}

function timestamp(value) {
  if (!value) return '—';
  return `<time data-local datetime="${escape(value)}">${escape(value.slice(0, 16).replace('T', ' '))} UTC</time>`;
}

function stateBadge(label, tone) {
  return `<span class="state-badge ${tone}"><i aria-hidden="true"></i>${escape(label)}</span>`;
}

const stateLabels = { all: 'All statuses', review: 'Ready for review', attention: 'Needs attention',
  running: 'In progress', accepted: 'Handoffs accepted', queued: 'Ready to start' };
const searchTypes = { all: 'All results', handoffs: 'Handoffs', artifacts: 'Artifacts', checks: 'Checks' };
const selectOptions = (options, selected) => Object.entries(options).map(([value, label]) =>
  `<option value="${value}"${value === selected ? ' selected' : ''}>${escape(label)}</option>`).join('');

function runState(run) {
  const { accepted, running, review, attention } = run.handoffs;
  if (run.readyForProjectReview) return ['review', 'Ready for project review', 'success'];
  if (attention) return ['attention', 'Needs attention', 'warning'];
  if (running) return ['running', 'In progress', 'active'];
  if (review) return ['review', 'Handoff ready for review', 'active'];
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
    .filter(item => status(item.attempts.at(-1))[2] !== 'success');
}

function taskStatus(run, task) {
  const latest = task.attempts.at(-1);
  const waiting = waitingOn(run, task);
  return !latest && waiting.length
    ? ['Waiting on handoffs', `Waiting for ${waiting.map(item => item.packet.title).join(', ')}.`, 'neutral']
    : status(latest);
}

function projectHeader(project, current) {
  const path = projectHref(project);
  const initials = project.name.split(/\s+/).slice(0, 2).map(word => word[0]).join('').toUpperCase();
  return `<header class="mast"><div class="mast-inner"><a class="project-home" href="${path}"><span class="project-monogram" aria-hidden="true">${escape(initials)}</span>${escape(project.name)}</a>
<nav aria-label="Project navigation"><a href="${path}"${current === 'epics' ? ' aria-current="page"' : ''}>Epics</a>
<a href="${path}/agents"${current === 'agents' ? ' aria-current="page"' : ''}>${escape(project.crewName)}</a></nav></div></header>`;
}

export function projectPage(project, showAgents = false, { query = '', status: filter } = {}) {
  const path = projectHref(project);
  const agents = `<ul class="index-list">${project.profiles.map(profile => `<li>
<a href="${artifactHref(profile.configurationRun ?? project.configurationRun, profile.instructionId)}?view=agents">${escape(profile.name)}</a>
<p>${escape(profile.remit)}</p></li>`).join('')}</ul>`;
  if (showAgents) {
    return layout(`${project.name} · Agents`, `${projectHeader(project, 'agents')}<main>
<h1>${escape(project.crewName)}</h1><section class="record-section"><h2>Configured agents</h2>${agents}</section></main>`);
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
    const [, label, tone] = runState(run);
    return `<div class="epic-row" role="row"><div role="cell"><a class="epic-row-title" href="${epicHref(project, epic)}"><span class="item-code">${escape(epicCode(epic))}</span>${escape(epicName(epic))}${arrow}</a><p>${escape(epic.goal)}</p></div>
<div role="cell">${stateBadge(label, tone)}</div><div role="cell" class="handoff-count"><strong>${run.handoffs.accepted}/${run.handoffs.total}</strong><span>accepted</span></div>
<div role="cell" class="last-activity">${run.latestActivity ? `<a href="${epicViewHref({ id: run.id, project, epic }, 'activity')}" aria-label="${escape(activityLabel(run.latestActivity.title, run.latestActivity.action))}">${timestamp(run.latestActivity.at)}</a>` : '<span>No activity yet</span>'}</div></div>`;
  }).join('')}</div>` : `<div class="empty-state"><h2>No matching epics</h2><p>Try a different search or status.</p><a href="${path}">Clear filters</a></div>`}
${decisions.length ? `<section class="project-activity"><div class="section-title"><h2>Recent decisions</h2></div>${eventList(decisions)}</section>` : ''}</main>`);
}

function activityLabel(title, action) {
  if (action === 'accepted') return `${title} accepted`;
  if (action === 'rework') return `${title} returned for rework`;
  if (action === 'running' || action === 'started') return `${title} started`;
  if (action === 'completed') return `${title} returned`;
  return `${title} needs attention`;
}

export function epicPage(project, epic, run, { step, view, query = '', type } = {}) {
  const tabs = { overview: 'Overview', workflow: 'Workflow',
    ...(run.tasks.some(task => task.packet.execution) ? { checks: 'Checks' } : {}), usage: 'Usage', activity: 'Activity' };
  const selected = Object.hasOwn(tabs, view) || view === 'search' ? view : step ? 'workflow' : 'overview';
  const [, label, tone] = runState(run);
  const content = selected === 'workflow' ? pipelinePanel(run, step) : selected === 'checks' ? checksPanel(run)
    : selected === 'usage' ? usagePanel(run) : selected === 'activity' ? activityPanel(run)
      : selected === 'search' ? searchPanel(run, query, type) : overviewPanel(run, epic);
  return layout(`${epicName(epic)} · ${project.name}`, `${projectHeader(project)}<main data-epic-view>
<nav class="breadcrumbs" aria-label="Location"><a href="${projectHref(project)}">Epics</a><span aria-hidden="true">/</span><span>${escape(epicCode(epic))}</span></nav>
<div class="page-title epic-title"><h1>${escape(epicName(epic))}</h1>${stateBadge(label, tone)}</div>
<p class="intro">${escape(epic.goal)}</p>
<div class="epic-toolbar"><nav class="view-tabs" aria-label="Epic views">${Object.entries(tabs).map(([value, title]) =>
    `<a href="${epicViewHref(run, value)}"${value === selected ? ' aria-current="page"' : ''}>${title}</a>`).join('')}</nav>
<form class="epic-search" role="search" aria-label="Search this run" action="${epicHref(project, epic)}"><input type="hidden" name="run" value="${escape(run.id)}"><input type="hidden" name="view" value="search">
<label class="search-field"><span class="visually-hidden">Search this run</span><input type="search" data-search name="q" value="${escape(query)}" placeholder="Search this run…" maxlength="160"><kbd>/</kbd></label><button type="submit" class="search-submit" aria-label="Search">${searchIcon}</button></form></div>
<div class="epic-content">${content}</div></main>`, run.handoffs.running && selected !== 'search');
}

function activityEvents(run) {
  const events = [];
  for (const task of run.tasks) {
    const { packet } = task;
    const profile = run.profiles.find(value => value.id === packet.profileId);
    for (const attempt of task.attempts) {
      const href = `${taskHref(run.id, packet.id)}#attempt-${attempt.number}`;
      const latest = attempt === task.attempts.at(-1);
      if (attempt.startedAt) events.push({ title: activityLabel(packet.title, 'started'), at: attempt.startedAt,
        detail: profile.name, href, tone: 'neutral', key: latest && attempt.outcome === 'running' });
      if (attempt.verification) {
        const report = attempt.verification;
        const count = report.checks.filter(check => check.passed).length;
        const independent = report.kind === 'independent-qa';
        events.push({ title: `${independent ? 'Independent QA' : 'Author tests'} ${report.passed ? 'passed' : 'failed'}`,
          at: report.checks.at(-1)?.endedAt ?? attempt.endedAt, tone: report.passed ? 'success' : 'warning', key: true,
          detail: independent ? `${count}/${report.checks.length} Docker checks on ${report.testedCommit.slice(0, 7)}` : `Docker suite on ${report.testedCommit.slice(0, 7)}`,
          href: independent ? epicViewHref(run, 'checks') : artifactHref(run.id, attempt.runnerArtifacts['check-receipt'], packet.id) });
      }
      if (attempt.decision) {
        const decision = attempt.decision;
        events.push({ title: activityLabel(packet.title, decision.disposition), at: decision.recordedAt,
          detail: decision.note, href, tone: decision.disposition === 'accepted' ? 'success' : 'warning',
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

function overviewPanel(run, epic) {
  const build = run.tasks.find(task => task.packet.execution?.kind === 'build')?.attempts.at(-1);
  const qaTask = run.tasks.find(task => task.packet.execution?.kind === 'verify');
  const qa = qaTask?.attempts.at(-1)?.verification;
  const brief = run.artifacts.find(artifact => artifact.id === 'input-brief');
  const candidate = build?.candidate;
  const diff = build?.runnerArtifacts?.['candidate-diff'];
  const history = epic.runs.length > 1 ? `<h3>Run history</h3><ul class="index-list">${epic.runs.map(entry => `<li>
<a href="${epicHref(run.project, epic)}?run=${encodeURIComponent(entry.id)}"${entry.id === run.id ? ' aria-current="page"' : ''}>${escape(entry.id)}</a></li>`).join('')}</ul>` : '';
  return `<div class="overview-layout"><section class="record-section"><div class="section-title"><h2>What happened</h2>
<a href="${epicViewHref(run, 'activity')}">All activity ${arrow}</a></div>${eventList(activityEvents(run).filter(event => event.key).slice(0, 5), true)}</section>
<aside class="run-summary" aria-label="Run details"><h2>Run details</h2><dl>
<div><dt>Handoffs</dt><dd><a href="${epicViewHref(run, 'workflow')}">${run.handoffs.accepted}/${run.handoffs.total} accepted</a></dd></div>
${qaTask ? `<div><dt>Independent QA</dt><dd>${qa ? `<a href="${epicViewHref(run, 'checks')}">${qa.checks.filter(check => check.passed).length}/${qa.checks.length} passed</a>` : 'No receipt yet'}</dd></div>` : ''}
${candidate ? `<div><dt>Candidate</dt><dd>${diff ? `<a href="${artifactHref(run.id, diff)}?view=epic"><code>${escape(candidate.commit.slice(0, 7))}</code></a>` : `<code>${escape(candidate.commit.slice(0, 7))}</code>`}</dd></div>` : ''}
<div><dt>Run</dt><dd><code>${escape(run.id)}</code></dd></div></dl>
${brief ? `<a class="brief-link" href="${artifactHref(run.id, brief.id)}?view=epic">Original brief ${arrow}</a>` : ''}${history}</aside></div>`;
}

const number = value => value.toLocaleString('en-US');
const dollars = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 6 });

function costSummary(usage) {
  const tokens = usage.totalTokens === null ? 'No token usage reported' : `${number(usage.totalTokens)} tokens reported`;
  const cost = usage.estimatedUsd === null ? 'No cost estimate'
    : `${dollars.format(usage.estimatedUsd)} estimated${usage.unpricedAttempts ? ' so far' : ''}`;
  return [tokens, cost, usage.costTargetUsd === null ? '' : `${dollars.format(usage.costTargetUsd)} target`,
    usage.overCostTarget ? 'Above cost target' : ''].filter(Boolean).join(' · ');
}

function usagePanel(run) {
  return `<section class="record-section"><div class="section-title"><h2>Task usage</h2></div>
<p class="muted">Usage includes every attempt. Cost estimates require configured token rates.</p>
<ul class="index-list">${run.tasks.map(({ packet, usage }) => `<li>
<a href="${taskHref(run.id, packet.id)}">${escape(packet.title)}</a>
<p>Cost owner · ${escape(usage.costOwner ?? 'Unrecorded')}</p>
<p>${costSummary(usage)}</p>
${usage.attemptsMissingUsage ? `<p>Missing token usage from ${usage.attemptsMissingUsage} ${usage.attemptsMissingUsage === 1 ? 'attempt' : 'attempts'}.</p>` : ''}</li>`).join('')}</ul></section>`;
}

function checksPanel(run) {
  const build = run.tasks.find(task => task.packet.execution?.kind === 'build');
  const receipt = build?.attempts.at(-1)?.runnerArtifacts?.['check-receipt'];
  const result = build?.attempts.at(-1)?.verification;
  return `<div class="epic-sections">${qaPanel(run) || '<p class="empty-state">No independent checks are configured for this run.</p>'}
${receipt && result ? `<section class="record-section author-check"><h2>Author tests</h2><p>${stateBadge(result.passed ? 'Suite passed' : 'Suite failed', result.passed ? 'success' : 'warning')}</p>
<p>Docker receipt for <code>${escape(result.testedCommit.slice(0, 7))}</code>.</p><a href="${artifactHref(run.id, receipt)}?view=checks">Open author test receipt ${arrow}</a></section>` : ''}</div>`;
}

function searchPanel(run, query, type) {
  const selected = Object.hasOwn(searchTypes, type) ? type : 'all';
  const handoffs = run.tasks.map(task => {
    const profile = run.profiles.find(value => value.id === task.packet.profileId);
    const attempt = task.attempts.at(-1);
    return { title: task.packet.title, detail: profile.name, href: pipelineHref(run, task.packet.id),
      terms: [task.packet.id, task.packet.objective, attempt?.result?.summary] };
  });
  const artifacts = run.artifacts.map(artifact => {
    const task = run.tasks.find(task => task.attempts.some(attempt => attempt.id === artifact.provenance.attemptId));
    const detail = task?.packet.title ?? artifact.provenance.path ?? artifact.kind;
    return { title: artifact.title, detail, href: task ? `${artifactHref(run.id, artifact.id, task.packet.id)}&amp;view=pipeline` : `${artifactHref(run.id, artifact.id)}?view=epic`,
      terms: [artifact.id, artifact.kind, artifact.provenance.sourceCommit, artifact.provenance.path] };
  });
  const verification = run.tasks.find(task => task.packet.execution?.kind === 'verify')?.attempts.at(-1)?.verification;
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

function pipelinePanel(run, step) {
  const stages = pipelineStages(run.tasks);
  const selected = run.tasks.find(task => task.packet.id === step) ??
    stages.flat().find(({ parents }) => parents.length > 1)?.task ?? run.tasks[0];
  const taskById = new Map(run.tasks.map(task => [task.packet.id, task]));
  return `<section class="record-section" id="pipeline" aria-labelledby="pipeline-heading"><div class="section-title"><h2 id="pipeline-heading">Handoff pipeline</h2><p>${run.tasks.length} handoffs</p></div>
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
<span class="pipeline-status"><i aria-hidden="true"></i>${escape(tone === 'success' ? 'Accepted' : verdict)}</span></a>
${skipLinks.length ? `<p class="pipeline-earlier">Also follows ${skipLinks.map(upstream => `<a href="${pipelineHref(run, upstream.packet.id)}">${escape(upstream.packet.title)}</a>`).join(', ')}</p>` : ''}</li>`;
    }).join('')}</ol>`;
  }).join('')}</div></div>${pipelineDetails(run, selected, taskById)}</section>`;
}

function handoffArtifacts(task) {
  const { packet, packetId, attempts } = task;
  const latest = attempts.at(-1);
  return {
    inputs: [latest?.packetId ?? packetId, ...(latest?.inputArtifacts ?? packet.inputArtifacts)],
    outputs: [...Object.values(latest?.result?.artifacts ?? {}), latest?.runnerArtifacts?.candidate,
      latest?.runnerArtifacts?.['candidate-diff']].filter(Boolean),
    evidence: [latest?.receiptId, latest?.runnerArtifacts?.['check-receipt']].filter(Boolean),
  };
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
  if (attempt?.activityId) return `${records}<p class="muted trace-state">Captured activity is awaiting Langfuse publication.</p>`;
  return records;
}

function pipelineDetails(run, task, taskById) {
  const { packet, attempts } = task;
  const latest = attempts.at(-1);
  const [verdict, description, tone] = taskStatus(run, task);
  const { inputs, outputs, evidence } = handoffArtifacts(task);
  const profile = run.profiles.find(value => value.id === packet.profileId);
  return `<section id="handoff-details" class="pipeline-details" aria-labelledby="handoff-details-title" tabindex="-1">
<div class="section-title"><h3 id="handoff-details-title">${escape(packet.title)}</h3>${stateBadge(verdict, tone)}</div>
<p class="muted">${escape(profile.name)} · Decision owner ${escape(packet.acceptedBy)}</p>
<p class="muted">Cost owner · ${escape(task.usage.costOwner ?? 'Unrecorded')} · <a href="${epicViewHref(run, 'usage')}">Task usage</a></p>
<p>${escape(latest?.result?.summary ?? description)}</p>
${packet.prerequisites.length ? `<p class="pipeline-deps"><strong>Depends on</strong> ${packet.prerequisites.map(id =>
    `<a href="${pipelineHref(run, id)}">${escape(taskById.get(id).packet.title)}</a>`).join(' · ')}</p>` : ''}
<div class="pipeline-artifacts"><section><h4>Inputs</h4>${links(run, packet.id, inputs, 'pipeline')}</section>
<section><h4>Outputs</h4>${outputs.length ? links(run, packet.id, outputs, 'pipeline') : `<p class="muted">Expected ${escape(packet.outputs.map(slot => slot.title ?? slot.id).join(', '))}.</p>`}</section>
<section><h4>Evidence</h4>${evidenceLinks(run, packet.id, evidence, latest, 'pipeline')}</section></div>
<p class="pipeline-detail-links"><a href="${taskHref(run.id, packet.id)}">Open full handoff${attempts.length > 1 ? ` · ${attempts.length} attempts` : ''} ${arrow}</a></p></section>`;
}

function qaPanel(run) {
  const task = run.tasks.find(task => task.packet.execution?.kind === 'verify');
  if (!task) return '';
  const attempt = task.attempts.at(-1);
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

function links(run, taskId, ids, view) {
  if (!ids.length) return '<p class="muted">No artifacts recorded.</p>';
  return `<ul class="links">${ids.map(id => {
    const artifact = run.artifacts.find(value => value.id === id);
    return `<li><a href="${artifactHref(run.id, id, taskId)}${view === 'pipeline' ? '&amp;view=pipeline' : ''}">${escape(artifact?.title ?? id)}<span aria-hidden="true">↗</span></a></li>`;
  }).join('')}</ul>`;
}

function controls(run, packet, attempts, waiting) {
  if (waiting.length) return '';
  const attempt = attempts.at(-1);
  const attemptsAtRevision = attempts.filter(item => item.packetRevision === packet.revision).length;
  const rework = attempt?.decision?.disposition === 'rework';
  const dispatch = !attempt || (rework && attemptsAtRevision < packet.budget.maxAttempts);
  const action = taskHref(run.id, packet.id);
  const build = rework && attempt.packetRevision === packet.revision && run.tasks.find(task =>
    task.packet.execution?.kind === 'build' && packet.prerequisites.includes(task.packet.id) &&
    !(packet.handoffInputs ?? []).some(input => input.task === task.packet.id && input.slot === 'candidate-diff'));
  if (dispatch || build) return `<div class="buttons">
${dispatch ? `<form method="post" action="${action}"><button name="action" value="dispatch">${attempt ? 'Dispatch rework' : 'Dispatch assignment'}</button></form>` : ''}
${build ? `<form method="post" action="${action}"><input type="hidden" name="build" value="${escape(build.packet.id)}"><button class="secondary" name="action" value="attach-diff">Attach candidate diff</button></form>` : ''}</div>`;
  if (!attempt.decision && attempt.outcome !== 'running') return `<form method="post" action="${action}" class="decision">
    <input type="hidden" name="action" value="decide"><input type="hidden" name="attempt" value="${escape(attempt.id)}">
    <label for="note">Decision reason</label><textarea name="note" id="note" rows="2" required maxlength="2000"></textarea>
    <div class="buttons">${attempt.outcome === 'completed' && attempt.result?.state === 'completed' && attempt.evidenceStatus === 'recorded' ? '<button name="disposition" value="accepted">Accept handoff</button>' : ''}
    <button class="secondary" name="disposition" value="rework">Request rework</button></div></form>`;
  return '';
}

export function runPage(run, task) {
  const { packet, attempts } = task;
  const profile = run.profiles.find(value => value.id === packet.profileId);
  const latest = attempts.at(-1);
  const [verdict, description, tone] = taskStatus(run, task);
  const { inputs, outputs, evidence } = handoffArtifacts(task);
  const expected = packet.outputs.map(slot => slot.id).join(', ');
  return layout(packet.title, `<a class="skip" href="#main">Skip to handoff</a>
${projectHeader(run.project)}
<main id="main"><nav class="breadcrumbs" aria-label="Location"><a href="${pipelineHref(run, packet.id)}">${escape(run.epic.title)}</a></nav><h1>${escape(packet.title)}</h1>
<p class="intro">${escape(packet.objective)}</p>
<section class="status ${tone}" aria-labelledby="run-status"><div><p class="eyebrow">Current status</p>
<h2 id="run-status">${verdict}</h2><p>${escape(description)}</p></div><div class="action">${controls(run, packet, attempts, waitingOn(run, task))}</div></section>
<div class="columns"><aside><h2>Workflow</h2><ul class="links workflow">${run.tasks.map(item => `<li>
<a href="${taskHref(run.id, item.packet.id)}"${item === task ? ' aria-current="page"' : ''}>${escape(item.packet.title)}<span>${escape(taskStatus(run, item)[0])}</span></a></li>`).join('')}</ul>
<dl class="meta"><div><dt>Assigned to</dt><dd><a href="${artifactHref(run.id, profile.instructionId, packet.id)}">${escape(profile.name)}</a></dd></div>
<div><dt>Decision owner</dt><dd>${escape(packet.acceptedBy)}</dd></div><div><dt>Cost owner</dt><dd>${escape(task.usage.costOwner ?? 'Unrecorded')}</dd></div>
<div><dt>Git commit</dt><dd><code title="${escape(run.sourceCommit)}">${escape(run.sourceCommit.slice(0, 12))}</code></dd></div>
<div><dt>Run</dt><dd><code>${escape(run.id)}</code></dd></div></dl></aside>
<div class="records"><div class="grid"><section><h2>Inputs</h2>${links(run, packet.id, inputs)}</section>
<section><h2>Outputs</h2>${outputs.length ? links(run, packet.id, outputs) : `<p class="muted">Expected output: ${escape(expected)}.</p>`}</section></div>
<section><h2>Evidence</h2>${evidenceLinks(run, packet.id, evidence, latest)}
${latest?.result ? `<p>${escape(latest.result.summary)}</p>${[['Questions', latest.result.questions], ['Agent decisions', latest.result.decisions], ['Blockers', latest.result.blockers]].filter(([, values]) => values.length).map(([label, values]) => `<h3>${label}</h3><ul>${values.map(value => `<li>${escape(value)}</li>`).join('')}</ul>`).join('')}` : ''}</section>
<section><h2>Usage</h2><p>${costSummary(task.usage)}</p><p class="muted">${number(packet.budget.targetTotalTokens)} token target per attempt</p></section>
${attempts.length ? `<section><h2>Attempt history</h2><ol class="history">${attempts.map(attempt => `<li id="attempt-${attempt.number}">
<strong>Attempt ${attempt.number}</strong> · ${escape(status(attempt)[0])}${attempt.packetId ? ` · <a href="${artifactHref(run.id, attempt.packetId, packet.id)}">Packet revision ${attempt.packetRevision}</a>` : ''}${attempt.receiptId ? ` · <a href="${artifactHref(run.id, attempt.receiptId, packet.id)}">Receipt</a>` : ''}
${Object.values(attempt.result?.artifacts ?? {}).map(id => ` · <a href="${artifactHref(run.id, id, packet.id)}">Output</a>`).join('')}
${traceLink(attempt) ? ` · ${traceLink(attempt)}` : ''}
${attempt.usage ? `<p class="muted">${number(attempt.usage.total)} tokens reported${attempt.overTokenTarget ? ' · above token target' : ''}${attempt.estimatedUsd === null ? '' : ` · ${dollars.format(attempt.estimatedUsd)} estimated`}</p>` : ''}
${attempt.decision ? `<p class="muted">${escape(attempt.decision.owner)} recorded ${escape(attempt.decision.disposition)}. ${escape(attempt.decision.note)}</p>` : ''}</li>`).join('')}</ol></section>` : ''}
</div></div></main>`, latest?.outcome === 'running');
}

export function artifactPage(artifact, run, fromTask, view) {
  const provenance = artifact.provenance.source === 'git' ? `Git · ${artifact.provenance.path} · ${artifact.provenance.sourceCommit}`
    : `${artifact.provenance.source} · ${artifact.provenance.attemptId}`;
  let back = [projectHref(run.project), 'Back to project'];
  if (fromTask && view === 'pipeline') back = [pipelineHref(run, fromTask), 'Back to the pipeline step'];
  else if (fromTask) back = [taskHref(run.id, fromTask), 'Back to the handoff'];
  else if (view === 'agents') back = [`${projectHref(run.project)}/agents`, 'Back to agents'];
  else if (view === 'checks') back = [epicViewHref(run, 'checks'), 'Back to checks'];
  else if (view === 'epic') back = [`${epicHref(run.project, run.epic)}?run=${encodeURIComponent(run.id)}`, 'Back to the epic'];
  return layout(artifact.title, `${projectHeader(run.project)}<main><nav class="breadcrumbs" aria-label="Location"><a href="${back[0]}">← ${back[1]}</a></nav>
<p class="eyebrow">Linked artifact</p><h1>${escape(artifact.title)}</h1><p class="muted provenance">${escape(provenance)}</p>
<pre>${escape(artifact.content)}</pre><details><summary>SHA-256 digest</summary><code class="provenance">${escape(artifact.digest)}</code></details></main>`);
}

export function errorPage(message) {
  return layout('Unable to open', `<main><h1>Unable to open</h1><p>${escape(message)}</p><a href="/">Back to project</a></main>`);
}
