import { workflowAgentTools } from '../lib/workflow-agent-tools.mjs';
import { approvalModes, codexServiceTierLabel, webSearchModes, workspaceModes } from '../lib/workflow-native.mjs';
import { workflowSetupProfiles } from '../lib/workflow-setup.mjs';
import { projectMcpHref } from './project-mcp.mjs';
import { escape, layout, projectAgentsHref, projectHeader, projectSkillHref, stateBadge, timestamp, workflowSetupHref } from './views.mjs';
import { workflowHref } from './workflow-configuration.mjs';

const link = (href, label) => `<a href="${escape(href)}">${escape(label)}</a>`;
const list = items => `<ul class="links">${items.map(item => '<li>' + item + '</li>').join('')}</ul>`;
const workspaceSources = { baseline: 'Pinned project files', delivery: 'Published workspace pinned at run creation' };

function checkRows(rows) {
  const labels = { ready: ['Available', 'success'], attention: ['Needs attention', 'warning'], unverified: ['Unverified', 'neutral'] };
  return list(rows.map(({ label, state, detail }) =>
    `<strong>${escape(label)}</strong> ${stateBadge(...labels[state])}<p class="muted">${escape(detail)}</p>`));
}

function profileSetup(project, profile, tasks, report) {
  const { origin, runtime } = profile;
  const agent = origin?.agentId ? link(projectAgentsHref(project, origin.agentId, false, origin.version), profile.name + ' · v' + origin.version)
    : escape(profile.name);
  const assigned = tasks.filter(task => task.profileId === profile.id || task.alternateProfiles?.includes(profile.id));
  const byId = new Map(tasks.map(task => [task.id, task]));
  const tools = [
    ...(runtime.workspace !== 'tools' ? ['Shell and file tools'] : []),
    ...(runtime.imageInspection ? ['Workspace image inspection'] : []),
    ...(runtime.imageGeneration ? ['Native image generation'] : []),
    ...(runtime.delegation ? ['Codex subagents'] : []),
    ...(runtime.hooks || runtime.hostHooks ? ['Codex lifecycle hooks'] : []),
    ...(origin?.codexTools ?? []).map(tool => workflowAgentTools[tool]?.title ?? tool),
    ...(runtime.mcpServers ?? []).map(name => name + ' · Worker MCP'),
    ...(runtime.apps ?? []).map(({ name }) => name + ' · Connected app'),
    ...(runtime.plugins ?? []).map(id => id + ' · Codex plugin'),
  ].map(escape);
  tools.push(...(origin?.projectMcp ?? []).map(({ id, version, name }) => link(projectMcpHref(project, id, version), name + ' · v' + version)));
  const skills = (origin?.skillNames ?? []).map((name, index) => {
    const saved = origin.projectSkillRefs?.find(skill => skill.index === index);
    return saved ? link(projectSkillHref(project, saved.id, saved.version), name + ' · v' + saved.version) : escape(name);
  });
  return `<section class="record-section workflow-setup-profile"><h2>${agent}</h2>
    <dl class="meta">
      <div><dt>Configured model</dt><dd>${escape(profile.model || 'Worker default')}</dd></div>
      <div><dt>Reasoning effort</dt><dd>${escape(runtime.reasoningEffort || 'Worker default')}</dd></div>
      <div><dt>Codex speed</dt><dd>${escape(codexServiceTierLabel(runtime.serviceTier))}</dd></div>
      <div><dt>Workspace permissions</dt><dd>${escape(workspaceModes[runtime.workspace])}</dd></div>
      <div><dt>Tool approvals</dt><dd>${escape(approvalModes[runtime.approvalMode ?? 'never'])}</dd></div>
      <div><dt>Web search</dt><dd>${escape(webSearchModes[runtime.webSearch])}</dd></div>
    </dl>
    <h3>Assignments</h3>${list(assigned.map(task => {
      const fromStep = task.workspaceSource?.startsWith('step:') && byId.get(task.workspaceSource.slice(5));
      const source = fromStep ? 'Workspace from ' + fromStep.title : workspaceSources[task.workspaceSource] ?? 'Assignment inputs';
      return `<strong>${escape(task.title)}</strong> · ${escape(source)}${task.profileId !== profile.id ? ' · Alternate agent' : ''}`;
    }))}
    ${tools.length ? '<h3>Tools and capabilities</h3>' + list(tools) : ''}
    ${skills.length ? '<h3>Attached skills</h3>' + list(skills) : ''}
    ${report?.checks.length ? '<h3>On the dispatch worker</h3>' + checkRows(report.checks) : ''}
  </section>`;
}

export function workflowSetupPage(project, snapshot, check, workerConnected) {
  const { epic, tasks } = snapshot.project;
  const action = workflowSetupHref(project, epic.id, snapshot.version);
  const pending = check && !check.completedAt && Date.now() - Number(check.requestedAt) < 300_000;
  const expired = check && !check.completedAt && !pending;
  const state = !check ? 'idle' : expired ? 'expired' : check.completedAt ? String(Number(check.completedAt))
    : check.startedAt ? 'checking' : 'queued';
  const message = !check ? 'Run a setup check to see what the worker can use for this revision.'
    : expired ? 'The worker setup check expired. Start a new check when the worker is connected.'
      : pending ? workerConnected === false ? 'Queued. The setup check will start when the worker reconnects.'
        : check.startedAt ? 'The dispatch worker is checking this revision.' : 'The setup check is queued.'
        : check.result?.error ?? 'The dispatch worker checked this revision.';
  const reports = new Map((check?.result?.profiles ?? []).map(report => [report.id, report]));
  return layout('Run setup · ' + epic.title, `${projectHeader(project, 'workflows')}<main class="feature-page configuration-page">
    <nav class="breadcrumbs" aria-label="Location">${link(workflowHref(project, epic.id, snapshot.version), epic.title + ' · v' + snapshot.version)}</nav>
    <h1>Run setup</h1>
    <div data-workflow-setup-results data-state="${escape(state + '/' + workerConnected)}"${pending ? ' data-setup-pending' : ''}>
      <section class="record-section">
        <h2>Dispatch worker</h2>
        <p role="status">${escape(message)}${check?.completedAt ? ' ' + timestamp(check.completedAt.toISOString()) : ''}</p>
        ${pending ? '<p>' + link(action, 'Refresh check status') + '</p>' : `<form method="post" action="${escape(action)}">
          <button type="submit">${check ? 'Check worker again' : 'Check worker setup'}</button></form>`}
        ${check?.result?.workflow?.length ? checkRows(check.result.workflow) : ''}
      </section>
      ${workflowSetupProfiles(snapshot).map(profile => profileSetup(project, profile, tasks, reports.get(profile.id))).join('')}
    </div>
  </main>`);
}
