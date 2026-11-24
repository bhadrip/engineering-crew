import { escape, layout, projectAgentsHref, projectHeader, revisionComparisonHref } from './views.mjs';

const savedAgent = value => /^agent-[a-f0-9]{32}$/.test(value?.id) && Number.isInteger(value.version);

function valueView(project, value, label) {
  if (value === undefined) return '<p class="muted">Absent</p>';
  if (typeof value === 'boolean') return `<p>${value ? 'On' : 'Off'}</p>`;
  if (value === '') return `<p class="muted">${['Model', 'Reasoning effort'].includes(label) ? 'Codex default' : 'Empty'}</p>`;
  if (label === 'Assigned agent' && savedAgent(value))
    return `<p><a href="${escape(projectAgentsHref(project, value.id, false, value.version))}">${escape(value.name)} · Version ${value.version}</a></p>`;
  if (Array.isArray(value) && !value.length) return '<p class="muted">Empty list</p>';
  if (Array.isArray(value) && value.every(item => typeof item === 'string'))
    return '<ul>' + value.map(item => `<li>${escape(item)}</li>`).join('') + '</ul>';
  const text = typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
  return `<pre>${escape(text)}</pre>`;
}

function versionPicker(project, kind, id, versions, from, to) {
  const select = (key, label, value) => `<label class="agent-field">${label}<select name="${key}" required>${versions.map(version =>
    `<option value="${version}"${value === version ? ' selected' : ''}>Version ${version}</option>`).join('')}</select></label>`;
  return `<form class="configuration-card revision-version-picker" method="get" action="${revisionComparisonHref(project, kind)}">
    <input type="hidden" name="${kind}" value="${escape(id)}">
    <div class="agent-model-fields">${select('from', 'Base version', from)}${select('to', 'Compare with', to)}</div>
    <button class="secondary" type="submit">Compare</button></form>`;
}

export function revisionComparisonPage(project, { kind, id, name, back, before, after, groups, versions = [], from, to, test }) {
  const title = test ? 'Compare tested draft' : kind === 'agent' ? 'Compare agent revisions' : 'Compare workflow revisions';
  const version = ({ label, href }) => href ? `<a href="${escape(href)}">${escape(label)}</a>` : escape(label);
  const row = ({ label, before: previous, after: current }) => `<li class="revision-change">
    <div class="section-title"><h3>${escape(label)}</h3><p>${previous === undefined ? 'Added' : current === undefined ? 'Removed' : 'Changed'}</p></div>
    <div class="revision-values"><div><h4>${escape(before.label)}</h4>${valueView(project, previous, label)}</div>
      <div><h4>${escape(after.label)}</h4>${valueView(project, current, label)}</div></div>
    ${label === 'Assigned agent' && savedAgent(previous) && savedAgent(current) && previous.id === current.id && previous.version !== current.version ?
      `<p class="revision-agent-link"><a href="${escape(revisionComparisonHref(project, 'agent', { id: current.id, from: previous.version, to: current.version }))}">Compare assigned agent revisions</a></p>` : ''}</li>`;
  const sections = groups.map((group, index) => `<details class="record-section agent-details revision-group"${index === 0 ? ' open' : ''}>
    <summary>${escape(group.title)} <small>· ${group.rows.length} ${group.rows.length === 1 ? 'change' : 'changes'}</small></summary>
    <ul class="revision-changes">${group.rows.map(row).join('')}</ul></details>`).join('');
  return layout(title + ' · ' + name, `${projectHeader(project, kind === 'agent' ? 'agent-library' : 'workflows')}
    <main class="feature-page configuration-page revision-comparison">
      <nav class="breadcrumbs" aria-label="Location"><a href="${escape(back)}">${test ? 'Draft test' : escape(name)}</a></nav>
      <h1>${title}</h1><p class="intro">${escape(name)}</p>
      ${test ? '' : versionPicker(project, kind, id, versions, from, to)}
      <p class="revision-pair">${version(before)} <span aria-hidden="true">→</span><span class="visually-hidden"> to </span> ${version(after)}</p>
      ${sections || '<p class="empty-state">The saved settings match.</p>'}
    </main>`);
}
