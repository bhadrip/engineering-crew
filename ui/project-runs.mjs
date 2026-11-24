import { currentAttempt } from '../lib/attempts.mjs';
import { projectRunTypes } from '../lib/project-runs.mjs';
import { featureRequestBadge, requestTitle } from './feature-views.mjs';
import { artifactHref, escape, layout, projectAgentsHref, projectHeader, projectHref, runState,
  stateBadge, taskHref, taskStatus, timestamp, workflowRunHref } from './views.mjs';
import { workflowHref } from './workflow-configuration.mjs';

const link = (href, label) => `<a href="${escape(href)}">${escape(label)}</a>`;

function legacyRow(project, run, callSeq) {
  const href = `${projectHref(project)}/requests/${encodeURIComponent(run.id)}`;
  return { href, title: requestTitle(run), createdAt: run.createdAt,
    badge: run.status === 'running' && run.canResume ? stateBadge('Ready to resume', 'warning') : featureRequestBadge(run.status),
    links: [
      ...(callSeq ? [link(`${href}/events/${callSeq}/input`, 'Latest Codex call')] : []),
      link(`${href}#technical-trace`, 'Event log'),
    ] };
}

function agentRow(project, run) {
  const task = run.tasks[0];
  const profile = run.profiles.find(profile => profile.id === task.packet.profileId);
  const [label, , tone] = taskStatus(run, task);
  const { agentId, version, preview, draft } = run.agentRun;
  const activityId = currentAttempt(task)?.activityId;
  const configuration = draft ? link(artifactHref(run.id, draft.artifactId, task.packet.id), 'Tested agent definition') :
    link(projectAgentsHref(project, agentId, false, version), `${profile?.name ?? 'Agent'} · v${version}`);
  return { href: taskHref(run.id, task.packet.id), title: preview || task.packet.title, createdAt: run.startedAt,
    badge: stateBadge(label, tone), links: [
      configuration,
      ...(activityId && run.artifacts.some(artifact => artifact.id === activityId)
        ? [link(artifactHref(run.id, activityId, task.packet.id), 'Codex activity')] : []),
    ] };
}

function workflowRow(project, run) {
  const [, label, tone] = runState(run);
  const version = run.project.configurationVersion;
  const snapshotId = run.workflowTest?.snapshotId ?? 'project-config';
  const configuration = version ? link(workflowHref(project, run.epic.id, version), `${run.epic.title} · v${version}`)
    : run.artifacts.some(artifact => artifact.id === snapshotId)
      ? link(artifactHref(run.id, snapshotId), run.workflowTest ? 'Tested draft snapshot' : 'Pinned configuration') : '';
  return { href: workflowRunHref(project, run.epic.id, run.id, run.triagePending ? 'triage' : 'workflow'),
    title: run.workflowRequest?.title ?? run.epic.title, createdAt: run.startedAt,
    badge: stateBadge(label, tone), links: [
      configuration,
      link(workflowRunHref(project, run.epic.id, run.id, 'activity'), 'Activity'),
    ] };
}

function runRow(project, { kind, run, callSeq }) {
  const { href, title, createdAt, badge, links } = kind === 'legacy' ? legacyRow(project, run, callSeq)
    : kind === 'agent' || kind === 'agent-draft' ? agentRow(project, run) : workflowRow(project, run);
  return `<li><div class="request-list-copy">${link(href, title)}
    <div class="feature-meta"><span>${projectRunTypes[kind]}</span>${timestamp(createdAt)}<code>${escape(run.id)}</code></div>
    <div class="run-index-links">${links.filter(Boolean).join('')}</div>
  </div><div class="request-list-state">${badge}</div></li>`;
}

export function projectRunsPage(project, { type, query, page }, { entries, hasOlder }) {
  const path = projectHref(project) + '/runs';
  const filtered = query !== '' || type !== 'all';
  const pageLink = (number, label) => {
    const params = new URLSearchParams();
    if (query) params.set('q', query);
    if (type !== 'all') params.set('type', type);
    if (number > 1) params.set('page', number);
    return link(params.size ? `${path}?${params}` : path, label);
  };
  const live = entries.some(({ kind, run }) => kind === 'legacy' ? run.status === 'running' && !run.canResume
    : run.handoffs.running || run.automation?.pending);
  return layout(`Runs · ${project.name}`, `${projectHeader(project, 'runs')}
<main class="run-index">
  <div class="page-title"><h1>Runs</h1></div>
  <form class="query-bar" method="get" action="${path}" role="search" aria-label="Search runs">
    <label class="search-field"><span class="visually-hidden">Search runs</span>
      <input name="q" type="search" value="${escape(query)}" maxlength="160" placeholder="Run ID, title, or agent name"></label>
    <label><span class="visually-hidden">Run type</span><select name="type">${Object.entries(projectRunTypes).map(([key, label]) =>
      `<option value="${key}"${key === type ? ' selected' : ''}>${label}</option>`).join('')}</select></label>
    <button class="secondary" type="submit">Search</button>
    ${filtered ? `<a class="clear-filter" href="${path}">Clear filters</a>` : ''}
  </form>
  ${entries.length ? `<ol class="request-list" aria-label="Run history">${entries.map(entry => runRow(project, entry)).join('')}</ol>`
    : `<p class="empty-state">${filtered || page > 1 ? 'No runs match this search or page.' : 'Runs will appear here when you start an agent, workflow, or draft test.'}</p>`}
  ${page > 1 || hasOlder ? `<nav class="run-index-pages" aria-label="Run history pages">
    ${page > 1 ? pageLink(page - 1, 'Newer runs') : ''}${hasOlder ? pageLink(page + 1, 'Older runs') : ''}
  </nav>` : ''}
</main>`, live);
}
