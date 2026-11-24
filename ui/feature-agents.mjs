import { escape, layout, projectAgentsHref, projectHeader, projectHref } from './views.mjs';
import { buildName, featureRole, featureTaskAction } from './feature-language.mjs';
import { receiptMetrics } from './feature-receipt.mjs';
import { planSynopsis, renderFeaturePlan } from './feature-plan.mjs';
import { featureStageResults } from './feature-dag.mjs';
import { visibleModel } from './feature-usage.mjs';
import { featureCalls } from '../lib/feature-usage.mjs';
import { rolePromptTemplate } from '../lib/feature-prompts.mjs';
import { agentNameLimit, optionalRoleTools, reasoningEfforts, skillLimits } from '../lib/feature-profiles.mjs';
import { describeCodexLaunch, formatCodexLaunch } from '../lib/feature-codex-command.mjs';

const purposes = {
  planner: 'Defines the implementation steps and acceptance checks.',
  engineer: 'Edits the project and submits a tested revision.',
  qa: 'Writes independent tests for the candidate build.',
  reviewer: 'Checks the implementation against the request.',
  security: 'Checks the candidate for security issues.',
};
const requestPath = (project, id) => projectHref(project) + '/requests/' + encodeURIComponent(id);
const anchor = (href, label) => '<a href="' + escape(href) + '">' + escape(label) + '</a>';
const section = (title, body) => '<section class="agent-section"><h2>' + escape(title) + '</h2>' + body + '</section>';
const details = (title, html, id = '') => '<details class="agent-details"' + (id ? ' id="' + escape(id) + '"' : '') + '><summary>' + escape(title) + '</summary>' + html + '</details>';
const pre = value => '<pre class="agent-text" dir="auto">' + escape(value) + '</pre>';
const unavailable = label => '<p class="muted">' + escape(label) + '</p>';
const count = (n, singular, plural = singular + 's') => n + ' ' + (n === 1 ? singular : plural);
const attemptName = attempt => attempt === 0 ? 'Planning' : attempt === 1 ? 'First build' : buildName(attempt).replace(/^r/, 'R');
const checkRoles = ['qa', 'reviewer', 'security'];
const taskLabel = event => featureTaskAction(event) + (checkRoles.includes(event.role) && event.attempt > 0 ? ' for ' + buildName(event.attempt) : '');
const humanAccess = access => access === 'workspace-write' ? 'Read and edit' : access === 'read-only' ? 'Read only' : access;
const humanNetwork = network => network === 'none' ? 'Off' : network;
const toolLabels = { list: 'List files', read: 'Read files', edit: 'Edit files', test: 'Run tests', finish: 'Submit a tested revision',
  'author-tests': 'Run project tests', 'independent-tests': 'Run independent tests', 'preview-health': 'Check preview health',
  'operator-acceptance': 'Run operator acceptance checks' };
const toolsText = tools => Array.isArray(tools) ? tools.map(id => Object.hasOwn(toolLabels, id) ? toolLabels[id] :
  Object.hasOwn(optionalRoleTools, id) ? optionalRoleTools[id].label : id).join(' · ') || 'None' : null;
const effortLabel = effort => effort === 'xhigh' ? 'Extra high' : effort[0].toUpperCase() + effort.slice(1);
const skillNames = skills => Array.isArray(skills) ? skills.map(skill => skill.name).join(' · ') || 'None' : null;
const receipt = event => event?.type === 'task.completed' ? event.evidence?.receipt : event?.evidence;
const eventUrl = (project, id, seq) => requestPath(project, id) + '#event-' + seq;

export function featureAgentHref(project, role, { requestId, attempt, agent, add } = {}) {
  const base = requestId ? requestPath(project, requestId) + '/agents'
    : projectHref(project) + (project.featureOnly && project.id !== 'music-transcribe' ? '/agents' : '/feature-agents');
  const query = new URLSearchParams();
  if (role) query.set('role', role);
  if (requestId && Number.isSafeInteger(attempt) && attempt >= 0) query.set('attempt', String(attempt));
  if (!requestId && agent) query.set('agent', agent);
  if (!requestId && add) query.set('add', '1');
  return base + (query.size ? '?' + query : '');
}

export const featureInputHref = (project, id, seq) => requestPath(project, id) + '/events/' + encodeURIComponent(seq) + '/input';
export const featureAgentCopyHref = (project, role, agent = 'default') =>
  projectAgentsHref(project) + '?' + new URLSearchParams({ new: '1', 'from-role': role, 'from-agent': agent });

function facts(rows) {
  const items = rows.filter(([,value]) => value !== undefined && value !== null && value !== '')
    .map(([title, value]) => '<div><dt>' + escape(title) + '</dt><dd>' + escape(value) + '</dd></div>');
  return items.length ? '<dl class="agent-facts">' + items.join('') + '</dl>' : '';
}

function crumbs(links) {
  return '<nav class="breadcrumbs" aria-label="Location">' + links.map(([href, title]) => anchor(href, title)).join('') + '</nav>';
}

function roleTools(role, tools) {
  if (!Array.isArray(tools)) return '';
  return facts(role === 'engineer'
    ? [['Actions the engineer can request', toolsText(tools)], ['Prepared by Crew', 'File manifest at the start of each turn']]
    : [['Prepared or run by Crew', toolsText(tools)]]);
}

function profileFacts(profile, role, historical = false) {
  return facts([
    ['Agent', historical ? profile.name : null],
    ['Profile', profile.id], ['Configured model', historical ? profile.model || (profile.modelSource === 'codex-default' ? 'Codex default' : null) : null],
    ['Workspace access', humanAccess(profile.access)], ['Workspace network', humanNetwork(profile.network)],
    ['Worker image', profile.workerImage], ['Reasoning effort', profile.reasoningEffort ? effortLabel(profile.reasoningEffort) : historical ? null : 'Medium'],
    ['Attached skills', skillNames(profile.skills ?? (historical ? null : []))], ['Attached tools', toolsText(profile.extraTools ?? (historical ? null : []))],
  ]) + (historical ? facts([['Recorded role tools', toolsText(profile.tools)]]) : roleTools(role, profile.tools));
}

function skillRow(skill = {}, open = false, folders = null) {
  const bundle = typeof skill.bundle?.directory === 'string' && Array.isArray(skill.bundle.files) &&
    skill.bundle.files.every(file => typeof file?.path === 'string' && typeof file.data === 'string') ? skill.bundle : null;
  return `<details class="agent-skill"${open ? ' open' : ''}>
    <summary>${escape(skill.name || 'New skill')}</summary>
    <div class="agent-skill-fields">
      <label class="agent-field">Skill name <input name="skill-name" required maxlength="${skillLimits.name}" value="${escape(skill.name)}"></label>
      <label class="agent-field">Skill instructions <textarea name="skill-content" required rows="6" maxlength="${skillLimits.bytes}">\n${escape(skill.content)}</textarea></label>
      ${folders ? '<input type="hidden" name="skill-bundle" value="' + escape(bundle ? JSON.stringify(bundle) : '') + '">' +
        '<details class="agent-skill-files" data-skill-resources' + (bundle ? '' : ' hidden') +
        '><summary data-skill-resource-summary>' + escape(bundle ? bundle.directory + ' · ' + bundle.files.length + ' supporting files' : '') +
        '</summary><ul data-skill-resource-list>' + (bundle?.files ?? []).map(file => '<li><code>' + escape(file.path) + '</code></li>').join('') + '</ul></details>' : ''}
      <button type="button" class="secondary" data-remove-skill hidden>Remove skill</button>
    </div></details>`;
}

export function skillEditor(skills, open, behavior = 'Crew sends the saved text with the agent’s prompt.', folders = null, count = skillLimits.count) {
  return `<div class="agent-attachments" data-agent-skills data-skill-limit="${count}" data-skill-bytes="${skillLimits.bytes}"${folders ?
    ' data-folder-files="' + folders.files + '" data-folder-bytes="' + folders.bytes + '" data-agent-folder-bytes="' + folders.agentBytes + '"' : ''}>
    <h3>${count === 1 ? 'Skill contents' : 'Skills'}</h3>
    <p class="agent-field-hint">${count === 1 ? 'Use Markdown up to ' + skillLimits.bytes / 1024 + ' KiB.' :
      'Attach up to ' + count + ' Markdown skills (' + skillLimits.bytes / 1024 + ' KiB each).'} ${escape(behavior)}</p>
    <p class="agent-field-hint" data-no-skills${skills.length ? ' hidden' : ''}>${count === 1 ? 'Add or upload the skill contents.' : 'No skills attached.'}</p>
    <div class="agent-skill-list" data-skill-list>${skills.map(skill => skillRow(skill, open, folders)).join('')}</div>
    <div class="agent-attachment-actions" data-skill-actions hidden>
      <button type="button" class="secondary" data-upload-skill>Upload SKILL.md</button>
      <input type="file" accept=".md,.markdown,text/markdown" multiple data-skill-files hidden>
      ${folders ? '<button type="button" class="secondary" data-upload-skill-folder>Upload skill folder</button>' +
        '<input type="file" webkitdirectory data-skill-folder hidden>' : ''}
      <button type="button" class="secondary" data-add-skill>Add skill text</button>
    </div>
    <p class="agent-feedback" data-skill-alert role="alert" hidden></p>
    <template>${skillRow({}, false, folders)}</template>
  </div>`;
}

function toolEditor(tools, coreTools) {
  return `<fieldset class="agent-fieldset"><legend>Tools</legend>
    <p class="agent-field-hint">Crew prepares the selected Git context from the role’s starting revision.</p>
    <div class="agent-tool-options">${Object.entries(optionalRoleTools).map(([id, { label, description }]) =>
      `<label class="agent-tool-option"><input type="checkbox" name="extra-tool" value="${id}"${tools.includes(id) ? ' checked' : ''}>
      <span><strong>${label}</strong><small>${description}</small></span></label>`).join('')}</div>
    <p class="agent-field-hint">Built-in tools <span class="agent-core-tools">${escape(toolsText(coreTools))}</span></p>
  </fieldset>`;
}

function agentDefinition(project, role, profile, { definition, defaultModel, catalog, saved, created, assigned, editorError, draft, agent, active }) {
  const effectiveModel = profile.model || catalog?.defaultModel;
  const source = definition?.model ? 'Role override' : defaultModel ? 'Crew default' : profile.model ? 'Configured model' : 'Codex default';
  const selection = effectiveModel ? escape(effectiveModel) : 'Selected at launch';
  const model = '<div class="agent-model"><strong>' + selection + '</strong><span>' + source + '</span></div>';
  const automatic = source === 'Codex default' ? '<p class="agent-model-note">Crew asks Codex for its default model when the worker runs.</p>' : '';
  let editor = '';
  if (definition) {
    const href = featureAgentHref(project, role, { agent });
    const version = draft?.version ?? definition.revision;
    const options = catalog?.models ?? [];
    const suggestions = options.length ? '<datalist id="available-models">' + options.map(id => '<option value="' + escape(id) + '"></option>').join('') + '</datalist>' : '';
    const inherit = defaultModel ? 'the Crew default, ' + escape(defaultModel) : 'the Codex default' + (catalog?.defaultModel ? ', currently ' + escape(catalog.defaultModel) : '');
    const feedback = editorError ? '<p class="agent-feedback" role="alert">' + escape(editorError) +
      (version !== definition.revision ? ' ' + anchor(href, 'Reload saved definition') : '') + '</p>' : '';
    const effort = draft?.reasoningEffort ?? definition.reasoningEffort ?? '';
    const efforts = [['', 'Crew default (Medium)'], ...reasoningEfforts.map(value => [value, effortLabel(value)])];
    editor = '<details class="agent-editor"' + (editorError || created ? ' open' : '') + '><summary>Edit definition</summary>' +
      '<form class="agent-edit-form" method="post" action="' + escape(href) + '">' + feedback +
      '<input type="hidden" name="version" value="' + escape(version) + '"><input type="hidden" name="attachments" value="1">' +
      (profile.name ? '<div class="agent-field"><label for="agent-name">Agent name</label><input id="agent-name" name="agent-name" required maxlength="' +
        agentNameLimit + '" value="' + escape(draft?.name ?? profile.name) + '"></div>' : '') +
      '<fieldset class="agent-fieldset"><legend>Model and workspace</legend><div class="agent-model-fields">' +
      '<div class="agent-field"><label for="role-model">Model override</label>' +
      '<input id="role-model" type="text" name="model" maxlength="120" autocapitalize="none" spellcheck="false" autocomplete="off"' +
      (suggestions ? ' list="available-models"' : '') + ' aria-describedby="model-hint" value="' + escape(draft?.model ?? definition.model) + '">' + suggestions +
      '<small id="model-hint">Leave empty to use ' + inherit + '.</small></div>' +
      '<div class="agent-field"><label for="role-effort">Reasoning effort</label><select id="role-effort" name="reasoning-effort">' +
      efforts.map(([value, label]) => '<option value="' + value + '"' + (effort === value ? ' selected' : '') + '>' + label + '</option>').join('') +
      '</select></div></div>' +
      '<div class="agent-field"><label for="role-image">Worker image override</label>' +
      '<input id="role-image" type="text" name="worker-image" maxlength="251" autocomplete="off" spellcheck="false" aria-describedby="image-hint" value="' +
      escape(draft?.workerImage ?? definition.workerImage) + '">' +
      '<small id="image-hint">Use a locally installed Docker image with Node 22 or leave empty for the Crew default.</small></div></fieldset>' +
      '<fieldset class="agent-fieldset"><legend>Instructions and skills</legend>' +
      '<div class="agent-field"><label for="role-instructions">Project instructions</label>' +
      '<textarea id="role-instructions" name="instructions" rows="4" maxlength="8000" aria-describedby="instructions-hint">\n' +
      escape(draft?.instructions ?? definition.instructions) + '</textarea>' +
      '<small id="instructions-hint">Crew adds these instructions to the role prompt for this project.</small></div>' +
      skillEditor(draft?.skills ?? definition.skills ?? [], Boolean(editorError)) + '</fieldset>' +
      toolEditor(draft?.extraTools ?? definition.extraTools ?? [], profile.tools) +
      '<div class="agent-edit-actions"><button type="submit">Save changes</button>' +
      '<small>' + (active ? 'Applies when a worker starts or resumes a request.' : 'Select this agent for the role to use its settings.') + '</small></div></form></details>';
  }
  const status = saved ? 'Definition saved.' : created ? 'Agent added. Configure it below, then select it for this role.' :
    assigned ? 'Active agent updated. Crew will use this selection when a worker starts or resumes a request.' : '';
  return '<section class="agent-definition" aria-labelledby="agent-config-heading"><h2 id="agent-config-heading">Current configuration</h2>' +
    '<h3 class="agent-model-heading">Model</h3>' + model + automatic + profileFacts(profile, role) +
    '<h3 class="agent-config-instructions">Project instructions</h3>' +
    (profile.instructions ? pre(profile.instructions) : unavailable('No additional project instructions.')) +
    (definition ? '<p>' + anchor(featureAgentCopyHref(project, role, agent ?? 'default'), 'Copy as reusable agent') + '</p>' : '') +
    (status ? '<p class="agent-feedback" role="status">' + status + '</p>' : '') + editor + '</section>';
}

function currentRole(project, profile, role, developmentProbe, settings) {
  if (!profile) return unavailable('Current settings are unavailable for this role.');
  const prompt = rolePromptTemplate(role, { developmentProbe });
  return agentDefinition(project, role, profile, settings) + section('Execution details',
    details('Codex and the workspace', '<p>Crew runs Codex on the host in a read-only sandbox with native tools disabled. The controller handles project files and tests through the isolated workspace. Codex uses the model service through the host.</p>')) +
    section('Instructions', details('Role assignment', pre(prompt.role)) +
      (profile.skills?.length ? details('Attached skill instructions', profile.skills.map(skill => '<h3>' + escape(skill.name) + '</h3>' + pre(skill.content)).join('')) : '') +
      details('Shared instructions and application contract', '<h3>Shared instructions</h3>' + pre(prompt.shared.trimEnd()) +
        '<h3>Application contract</h3>' + pre(prompt.contract) +
        '<p>Crew appends the request and the working context for each call.</p>')) +
    details('Profile identifier', facts([['Profile', profile.id], ['SHA-256', profile.digest]]));
}

function roster(project, profiles, request, attempt, catalog) {
  const events = (request?.events ?? []).filter(event => attempt == null || event.attempt === attempt);
  const calls = featureCalls(events);
  return '<ul class="agent-roster">' + Object.entries(purposes).map(([role, purpose]) => {
    const n = calls.filter(call => call.role === role).length;
    const label = request ? n ? count(n, 'completed call') : events.some(event => event.role === role) ? 'Activity recorded' : 'No activity recorded'
      : profiles?.[role] ? profiles[role].model || catalog?.defaultModel || 'Codex default' : 'Settings unavailable';
    return '<li><a href="' + escape(featureAgentHref(project, role, { requestId: request?.id, attempt })) + '"><strong>' +
      escape(featureRole(role)) + '</strong><span>' + escape(purpose) +
      (!request && profiles?.[role]?.name ? '<span class="agent-roster-assignment">' + escape(profiles[role].name) + '</span>' : '') +
      '</span><small>' + escape(label) + '</small></a></li>';
  }).join('') + '</ul>';
}

function agentPicker(project, role, agents, active, selected, error) {
  const entries = [['default', 'Default ' + featureRole(role)], ...Object.entries(agents)
    .filter(([, { profile }]) => profile.role === role).map(([id, { profile }]) => [id, profile.name])];
  if (entries.length < 2) return '';
  const href = id => featureAgentHref(project, role, { agent: id });
  return `<section class="agent-assignment" aria-label="Agents for ${escape(featureRole(role))}">
    <nav class="agent-choices" aria-label="Agent definitions">${entries.map(([id, label]) =>
      `<a href="${escape(href(id))}"${selected === id ? ' aria-current="page"' : ''}>${escape(label)}${active === id ? ' <span>Active</span>' : ''}</a>`).join('')}</nav>
    ${error ? `<p class="agent-feedback" role="alert">${escape(error)}</p>` : ''}
    ${selected === active ? '' : `<form method="post" action="${escape(href(selected))}">
      <input type="hidden" name="expected" value="${escape(active)}">
      <button class="secondary" name="activate" value="${escape(selected)}">Use for ${escape(featureRole(role))}</button></form>`}
  </section>`;
}

function namedAgentRoster(project, agents, activeAgents, catalog) {
  const entries = Object.values(agents);
  if (!entries.length) return '';
  return section('Named agents', '<ul class="agent-roster">' + entries.map(({ profile }) => {
    const { id, role, name, model } = profile;
    const activity = activeAgents[role] === id ? ' · Active' : '';
    return `<li><a href="${escape(featureAgentHref(project, role, { agent: id }))}"><strong>${escape(name)}</strong>
      <span>${escape(featureRole(role) + activity)}</span><small>${escape(model || catalog?.defaultModel || 'Codex default')}</small></a></li>`;
  }).join('') + '</ul>');
}

function addAgentForm(project, role, draft, error) {
  const selected = draft?.role ?? role;
  return `<p class="agent-intro">Give the agent a name and choose the workflow role it can fill.</p>
    <form class="agent-definition agent-create-form" method="post" action="${escape(featureAgentHref(project, role, { add: true }))}">
      ${error ? `<p class="agent-feedback" role="alert">${escape(error)}</p>` : ''}
      <div class="agent-field"><label for="new-agent-name">Agent name</label>
      <input id="new-agent-name" name="name" required maxlength="${agentNameLimit}" value="${escape(draft?.name)}"></div>
      <div class="agent-field"><label for="new-agent-role">Workflow role</label><select id="new-agent-role" name="role" required>
      <option value="">Choose a role</option>${Object.keys(purposes).map(value =>
        `<option value="${value}"${value === selected ? ' selected' : ''}>${escape(featureRole(value))}</option>`).join('')}</select></div>
      <div class="agent-edit-actions"><button type="submit">Add agent</button>${anchor(featureAgentHref(project, role), 'Cancel')}</div>
    </form>`;
}

function historicalProfile(project, request, events, role) {
  const launches = events.filter(e => e.type === 'agent.started');
  const observed = (s, key) => [...new Set(s.map(e => e.evidence?.[key]).filter(v => typeof v === 'string' && v))].join(' · ');
  const recorded = events.filter(event => event.type === 'runtime.profile');
  if (recorded.length) {
    return recorded.map((event, index) => {
      const p = event.evidence ?? {};
      const sameLifetime = next => next.seq > event.seq && next.seq < (recorded[index + 1]?.seq ?? Infinity);
      const ran = events.find(next => sameLifetime(next) && next.type === 'runtime.started' &&
        next.operationId === event.operationId && next.attempt === event.attempt && next.evidence?.profileDigest === p.digest);
      const starts = launches.filter(e => sameLifetime(e) && e.attempt === event.attempt && e.operationId === event.operationId);
      return details('Recorded profile · ' + attemptName(event.attempt) + (p.id ? ' · ' + p.id : ''), profileFacts(p, role, true) +
        (typeof p.instructions === 'string' ? (p.instructions ? '<h3>Project instructions</h3>' + pre(p.instructions) : unavailable('No additional project instructions.')) : unavailable('Project instructions were not recorded.')) +
        facts([['Harness', observed(starts, 'harness')], ['Codex sandbox', observed(starts, 'sandbox')], ['Profile SHA-256', p.digest], ['Workspace revision', p.revision], ['Started image', ran?.evidence?.image]]) +
        anchor(eventUrl(project, request.id, event.seq), 'Profile record #' + event.seq));
    }).join('');
  }
  const fallback = events.filter(e => e.type === 'runtime.started' || (e.type === 'agent.started' || e.type === 'agent.completed') && (receipt(e)?.profileDigest || receipt(e)?.harness || receipt(e)?.sandbox) ||
    e.type === 'task.completed' && e.evidence?.receipt?.profileDigest);
  const seen = new Set();
  const rows = fallback.flatMap(event => {
    const e = receipt(event) ?? {}, key = [event.attempt, e.profileDigest, e.harness, e.sandbox, e.image].join('|');
    if (seen.has(key)) return [];
    seen.add(key);
    return [details('Recorded settings · ' + attemptName(event.attempt), facts([['Harness', e.harness], ['Codex sandbox', e.sandbox], ['Profile', e.profileId], ['Profile SHA-256', e.profileDigest],
      ['Worker image', e.workerImage], ['Started image', e.image], ['Workspace access', humanAccess(e.access)], ['Workspace network', humanNetwork(e.network)]]) +
      anchor(eventUrl(project, request.id, event.seq), 'Source record #' + event.seq))];
  }).join('');
  return unavailable('Crew did not save a full role profile in these records.') + rows;
}

function historicalCalls(project, request, events) {
  const completed = featureCalls(events);
  const bySeq = new Map(events.map(e => [e.seq, e]));
  const rows = completed.map(call => ({ call, event: bySeq.get(call.seq) }));
  function linked(start, end) {
    const a = receipt(start) ?? {}, b = receipt(end) ?? {};
    if (end.seq <= start.seq || end.operationId !== start.operationId || end.attempt !== start.attempt) return false;
    if (a.callId && b.callId) return a.callId === b.callId;
    if (a.threadId && b.threadId) return a.threadId === b.threadId;
    if (b.startedAt && (a.startedAt || start.at) === b.startedAt) return true;
    // Legacy receipts can omit clocks and IDs. Only follow an unbroken,
    // single-parent chain within the same operation to the matching start.
    let cursor = end;
    while (cursor.parents?.length === 1 && cursor.parents[0] < cursor.seq) {
      cursor = bySeq.get(cursor.parents[0]);
      if (!cursor || cursor.operationId !== start.operationId || cursor.attempt !== start.attempt) break;
      if (cursor.type === 'agent.started') return cursor.seq === start.seq;
      if (['agent.completed', 'task.resumed', 'task.started', 'runtime.profile'].includes(cursor.type)) break;
    }
    return false;
  }
  const starts = events.filter(e => e.type === 'agent.started');
  const matches = rows.map(row => starts.filter(start => linked(start, row.event)));
  for (const event of starts) {
    const candidates = matches.filter(group => group.includes(event));
    if (candidates.length !== 1 || candidates[0].length !== 1) rows.push({ event });
  }
  if (!rows.length) return unavailable('No Codex calls were recorded for this selection.');
  return '<ol class="agent-calls">' + rows.sort((a,b) => a.event.seq - b.event.seq).map(({event,call}) => {
    const r = receipt(event) ?? {}, url = featureInputHref(project, request.id, event.seq);
    const model = call ? visibleModel(call) : null;
    const status = call ? model.source ? model.name + ' · ' + model.source : 'Model unreported' : 'Start record · No linked completion';
    const links = [anchor(eventUrl(project, request.id, event.seq), 'Receipt #' + event.seq)];
    if (r.inputDigest) {
      links.push(anchor(url + '#call-input', 'Prompt and launch'));
      links.push(anchor(url + '#exact-input', 'Exact prompt'));
    }
    if (r.outputDigest) links.push(anchor(url + '#agent-output', 'Exact output'));
    if (!r.inputDigest && !r.outputDigest) links.push('<small>Exact call content unavailable</small>');
    return '<li><strong>' + escape(attemptName(event.attempt) + ' · Call #' + event.seq) + '</strong><span>' + escape(status) +
      '</span><div class="agent-links">' + links.join(' ') + '</div></li>';
  }).join('') + '</ol>';
}

function roleHistory(project, request, role, attempt) {
  const events = (request.events ?? []).filter(event => event.role === role);
  const attempts = [...new Set(events.map(event => event.attempt).filter(Number.isSafeInteger))].sort((a,b) => a-b);
  const links = attempts.length > 1 ? '<nav class="agent-attempts" aria-label="Filter attempts">' +
    [[null,'All attempts'], ...attempts.map(a => [a,attemptName(a)])].map(([a,title]) =>
      '<a href="' + escape(featureAgentHref(project, role, { requestId: request.id, attempt: a })) + '"' +
      (attempt === a ? ' aria-current="page"' : '') + '>' + escape(title) + '</a>').join(' ') + '</nav>' : '';
  const selected = events.filter(event => attempt == null || event.attempt === attempt);
  if (!selected.length) return links + unavailable('No activity was recorded for this role in this selection.');
  const outcomes = selected.filter(e => ['task.completed','task.failed'].includes(e.type));
  const stages = featureStageResults(request, request.events);
  return links + (outcomes.length ? section('Stage results', '<ul class="agent-calls">' + outcomes.map(e => {
    const stage = stages.get(e.seq);
    return '<li><strong>' + escape(stage ? stage.label + ' · ' + stage.status : taskLabel(e) + ' · Earlier record') + '</strong>' +
      (stage?.summary ? '<p>' + escape(stage.summary) + '</p>' : '') +
      (stage ? anchor(requestPath(project, request.id) + stage.href, 'View workflow step') + ' ' : '') +
      anchor(eventUrl(project, request.id, e.seq), 'Source #' + e.seq) + '</li>';
  }).join('') + '</ul>') : '') +
    section('Codex calls', historicalCalls(project, request, selected)) +
    section('Execution settings', historicalProfile(project, request, selected, role));
}

export function featureAgentsPage(project, { profiles = {}, role = null, request = null, attempt = null, developmentProbe = false,
  definitions = {}, baseProfiles = profiles, agents = {}, activeAgents = {}, agent = null, adding = false,
  defaultModel = null, catalog = null, saved = false, created = false, assigned = false, editorError = '', assignmentError = '', draft = null } = {}) {
  const index = featureAgentHref(project, null, { requestId: request?.id });
  const links = request ? [[requestPath(project, request.id), 'Feature request']] : [[projectHref(project) + '/requests', 'Feature requests']];
  const scope = request ? 'Agents on this request' : project.id === 'music-transcribe' ? 'Legacy Feature agents' : 'Project agents';
  if (role && !Object.hasOwn(purposes, role)) throw new Error('Unknown feature role');
  if (role || adding) links.push([index, scope]);
  const active = activeAgents[role] ?? 'default';
  const selected = agent ?? active;
  const named = agents[selected];
  const title = adding ? 'Add agent' : named?.profile.name ?? (role ? featureRole(role) : scope);
  const addLink = request || adding ? '' : `<a class="agent-add" href="${escape(featureAgentHref(project, role, { add: true }))}">Add agent</a>`;
  let content = role ? '<p class="agent-intro">' + escape(purposes[role]) + '</p>' : '';
  if (named && !adding) content = '<p class="agent-intro">' + escape(featureRole(role) + ' · ' + purposes[role]) + '</p>';
  if (role && request) content += '<p>' + (project.id === 'music-transcribe'
    ? anchor(projectAgentsHref(project) + '?' + new URLSearchParams({ role }), 'View project agent settings')
    : anchor(featureAgentHref(project, role), 'View current project settings')) + '</p>';
  if (request && !role) content += '<p class="agent-intro">' + escape(planSynopsis(request.goal) || 'Recorded activity for this feature request.') + '</p>';
  if (!role && !request) content += '<p class="agent-intro">Choose a role to configure its model, instructions, skills, and tools.</p>';
  if (adding) content = addAgentForm(project, role, draft, editorError);
  else if (!role) content += roster(project, profiles, request, attempt, catalog) + (request ? '' : namedAgentRoster(project, agents, activeAgents, catalog));
  else if (request) content += roleHistory(project, request, role, attempt);
  else content += agentPicker(project, role, agents, active, selected, assignmentError) +
    currentRole(project, named?.profile ?? baseProfiles[role], role, developmentProbe, {
      definition: named?.definition ?? definitions[role], defaultModel, catalog, saved, created, assigned, editorError, draft,
      agent: selected === 'default' && active === 'default' ? null : selected, active: selected === active,
    });
  return layout(title + ' · ' + project.name, projectHeader(project, 'feature-agents') + '<main class="feature-page agents-page">' +
    crumbs(links) + '<div class="agent-page-heading"><h1>' + escape(title) + '</h1>' + addLink + '</div>' + content + '</main>');
}

function capturedConfig(config) {
  if (!config) return unavailable('Launch settings were not captured.');
  return facts([['Harness', config.harness], ['Agent', config.profileName], ['Profile', config.profileId], ['Profile SHA-256', config.profileDigest],
    ['Requested model', config.requestedModel], ['Selection', config.modelSelection], ['Reasoning effort', config.reasoningEffort],
    ['Codex sandbox', config.sandbox], ['Approvals', config.approval], ['Web search', config.webSearch], ['Native Codex tools', toolsText(config.nativeTools)],
    ['Workspace image', config.workerImage], ['Workspace access', humanAccess(config.workspaceAccess)], ['Workspace network', humanNetwork(config.workspaceNetwork)],
    ['Agent actions', toolsText(config.agentActions)], ['Controller actions', toolsText(config.controllerActions)],
    ['Attached skills', skillNames(config.skills)]]) +
    details('Execution options', facts([['Ephemeral session', booleanLabel(config.ephemeral)], ['Ignore user configuration', booleanLabel(config.ignoreUserConfig)],
      ['Ignore user rules', booleanLabel(config.ignoreRules)], ['Project instruction byte limit', config.projectDocMaxBytes],
      ['Development probe enabled', booleanLabel(config.developmentProbe)]])) +
    (typeof config.profileInstructions === 'string' ? details('Project instructions', config.profileInstructions ? pre(config.profileInstructions) : unavailable('No additional project instructions.')) : '') +
    (Array.isArray(config.disabledFeatures) ? details('Disabled Codex features', pre(config.disabledFeatures.join(', '))) : '') +
    (config.outputSchema ? details('Required response format', pre(JSON.stringify(config.outputSchema, null, 2))) : '');
}

const booleanLabel = value => typeof value === 'boolean' ? value ? 'Yes' : 'No' : null;

function launchCommand(config) {
  const launch = describeCodexLaunch(config);
  if (!launch) return '';
  const source = launch.recorded ? 'Recorded at launch.' : 'Reconstructed from saved launch settings and Crew’s launcher.';
  return details('Codex command', '<p class="muted">' + source +
    ' <code>$RUN_DIR</code> represents the temporary directory. Crew sends the exact prompt over stdin.</p>' +
    pre(formatCodexLaunch(launch)), 'codex-command');
}

function exactOutput(output, role) {
  let value;
  try { value = JSON.parse(output.raw); } catch {}
  const raw = details('Exact response text', pre(output.raw));
  if (!value || typeof value !== 'object' || Array.isArray(value)) return raw;
  if (role === 'planner') return renderFeaturePlan(value, { id: 'call-plan' }) + raw;
  const summary = typeof value.summary === 'string' ? '<p>' + escape(planSynopsis(value.summary)) + '</p>' : '';
  const findings = Array.isArray(value.findings) ? value.findings.filter(f => typeof f === 'string') : [];
  const changes = Array.isArray(value.changes) ? value.changes.filter(f => f && typeof f.path === 'string') : [];
  return facts([['Requested action', typeof value.action === 'string' ? value.action : null],
    ['Agent verdict', typeof value.passed === 'boolean' ? value.passed ? 'Passed' : 'Failed' : null]]) + summary +
    (findings.length ? '<ul>' + findings.map(f => '<li>' + escape(f) + '</li>').join('') + '</ul>' : '') +
    (changes.length ? details(count(changes.length, 'proposed file change'), '<ul>' + changes.map(change =>
      '<li>' + escape(change.action) + ' <code>' + escape(change.path) + '</code></li>').join('') + '</ul>') : '') +
    (typeof value.testSource === 'string' ? details('Independent test code', pre(value.testSource)) : '') + raw;
}

export function featureInputPage(project, request, event, input, output = null) {
  const role = event.role, record = receipt(event) ?? {}, title = featureRole(role) + ' call';
  const history = featureAgentHref(project, role, { requestId: request.id, attempt: event.attempt });
  const calls = featureCalls(request.events ?? []);
  const events = request.events ?? [];
  const call = calls.find(c => c.seq === event.seq) ?? (record.callId ? calls.find(c =>
    receipt(events.find(e => e.seq === c.seq))?.callId === record.callId) : null);
  const outcome = checkRoles.includes(role) && events.find(e => e.type === 'task.completed' && e.role === role &&
    e.attempt === event.attempt && e.operationId === event.operationId && (e.seq === event.seq ||
      (record.callId && e.evidence?.receipt?.callId === record.callId)));
  const stage = outcome && featureStageResults(request, events).get(outcome.seq);
  const outputHtml = output && typeof output.raw === 'string' ? exactOutput(output, role)
    : unavailable('No exact response was saved for this call.') + anchor(history, 'View recorded stage results');
  const capturedPrompt = typeof input?.prompt === 'string';
  const inputLinks = capturedPrompt ? '<div class="agent-links">' + anchor('#call-input', 'Prompt and launch') +
    anchor('#agent-output', 'Agent output') + '</div>' : '';
  const exactInput = capturedPrompt ? facts([['Prompt size', Buffer.byteLength(input.prompt).toLocaleString('en-US') + ' bytes'],
    ['Prompt SHA-256', input.promptSha256]]) +
    '<p>' + anchor(featureInputHref(project, request.id, event.seq) + '/prompt.txt', 'Download exact prompt') + '</p>' +
    launchCommand(input.config) + details('Read Crew prompt sent to Codex', pre(input.prompt), 'exact-input') +
    details('Recorded launch settings', capturedConfig(input.config))
    : '<div id="exact-input">' + unavailable('The exact prompt and launch settings were not saved for this call.') + '</div>';
  const body = '<main class="feature-page agents-page">' + crumbs([[requestPath(project, request.id), 'Feature request'], [history, featureRole(role)]]) +
    '<h1>' + escape(title) + '</h1><p class="agent-intro">' + escape(attemptName(event.attempt)) + ' · ' +
    anchor(eventUrl(project, request.id, event.seq), 'Record #' + event.seq) + '</p>' + inputLinks +
    '<section class="agent-section" id="agent-output"><h2>Agent output</h2>' + outputHtml + '</section>' +
    (stage ? section('Stage result', '<p><strong>' + escape(stage.label + ' · ' + stage.status) + '</strong></p>' +
      (stage.summary ? '<p>' + escape(stage.summary) + '</p>' : '') +
      anchor(requestPath(project, request.id) + stage.href, 'View workflow step')) : '') +
    '<section class="agent-section" id="call-input"><h2>Prompt and launch</h2>' + exactInput +
    '</section>' + (call ? details('Call receipt', receiptMetrics(call)) : '') +
    (input?.digest || output?.digest ? details('Content digests', facts([
      ['Input SHA-256', input?.digest], ['Output SHA-256', output?.digest]])) : '') + '</main>';
  return layout(title + ' · ' + project.name, projectHeader(project, 'feature-agents') + body);
}
