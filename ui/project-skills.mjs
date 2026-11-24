import { skillEditor } from './feature-agents.mjs';
import { escape, layout, projectHeader, projectSkillHref } from './views.mjs';
import { skillBundleLimits } from '../lib/workflow-skills.mjs';

export function projectSkillFields(project, catalog, refs) {
  const selected = new Map(refs.map(ref => [ref.id, ref.version]));
  const url = projectSkillHref(project);
  return `<fieldset class="agent-fieldset"><legend>Project skills</legend>
    <p class="agent-field-hint">Attach a saved version to this agent. <a href="${escape(url)}">Manage project skills</a></p>
    ${catalog.length ? catalog.map(skill => `<div class="configuration-tool">
      <label class="agent-field">${escape(skill.name)}<select name="project-skill"><option value="">Unattached</option>
        ${skill.versions.map(version => `<option value="${escape(skill.id)}:${version}"${selected.get(skill.id) === version ? ' selected' : ''}>
          v${version}${version === skill.version ? ' · Latest' : ''}</option>`).join('')}</select></label>
      <a href="${escape(projectSkillHref(project, skill.id, selected.get(skill.id)))}">View skill</a>
    </div>`).join('') : '<p class="muted">Add a project skill to attach it here.</p>'}</fieldset>`;
}

export function projectSkillsPage(project, { catalog, skill, adding, pinned, saved, draft, error }) {
  const base = projectSkillHref(project);
  const title = skill?.definition.name ?? (adding ? 'Add skill' : 'Skills');
  const heading = `<div class="agent-page-heading"><h1>${escape(title)}</h1>${!skill && !adding ?
    `<a class="agent-add" href="${escape(base)}?new=1">Add skill</a>` : ''}</div>`;
  const list = catalog.length ? '<ul class="index-list">' + catalog.map(row =>
    `<li><a href="${escape(projectSkillHref(project, row.id))}">${escape(row.name)}</a><p>Latest version ${row.version}</p></li>`).join('') + '</ul>'
    : '<p class="empty-state">Add a skill to share it across this project’s agents.</p>';
  let body = list;
  if (skill || adding) {
    const version = draft?.expectedVersion ?? skill?.version ?? 0;
    const versions = catalog.find(row => row.id === skill?.id)?.versions ?? [];
    const history = skill ? `<div class="configuration-versions"><p>Version ${skill.version}</p>
      ${pinned ? `<a href="${escape(projectSkillHref(project, skill.id))}">Edit latest version</a>` : ''}</div>
      ${versions.length > 1 ? `<nav class="agent-choices" aria-label="Skill versions">${versions.map(v =>
        `<a href="${escape(projectSkillHref(project, skill.id, v))}"${v === skill.version ? ' aria-current="page"' : ''}>v${v}</a>`).join('')}</nav>` : ''}` : '';
    const action = skill ? projectSkillHref(project, skill.id) : base + '?new=1';
    const values = draft?.skills ?? (skill ? [skill.definition] : []);
    body = `<nav class="breadcrumbs" aria-label="Location"><a href="${escape(base)}">All skills</a></nav>
      ${history}${error ? `<p class="agent-feedback" role="alert">${escape(error)}</p>` : ''}
      ${saved ? '<p class="agent-feedback" role="status">Skill version saved.</p>' : ''}
      <form class="configuration-form" action="${escape(action)}" method="post">
        <input type="hidden" name="version" value="${escape(version)}">
        <fieldset class="configuration-card"${pinned ? ' disabled' : ''}>
          ${skillEditor(values, true, 'Upload a SKILL.md or a folder with supporting files.', skillBundleLimits, 1)}
        </fieldset>
        ${pinned ? '' : `<div class="agent-edit-actions"><button type="submit">${skill ? 'Save new version' : 'Create skill'}</button></div>`}
      </form>`;
  }
  return layout(title + ' · ' + project.name, projectHeader(project, 'skills') +
    `<main class="feature-page configuration-page">${heading}${body}</main>`);
}
