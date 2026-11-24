import { CrewError, id } from '../lib/contracts.mjs';
import { artifactOutputKinds, browserActivitySlot, isEvidenceOutput, isImageOutput } from '../lib/workflow-artifacts.mjs';
import { conditionOperators } from '../lib/workflow-routing.mjs';
import { musicWorkspaceCheck } from '../lib/workflow-music-checks.mjs';
import { agentNameLimit, reasoningEfforts } from '../lib/feature-profiles.mjs';
import { defaultWorkflowAgentTools, musicBrowserTool, workflowAgentTools } from '../lib/workflow-agent-tools.mjs';
import { approvalModes, codexServiceTierLabel, limitedExecution, webSearchModes, workspaceModes } from '../lib/workflow-native.mjs';
import { maxOutputFollowUps, workflowResponseModes } from '../lib/workflow-policy.mjs';
import { handoffChoices, newWorkflowStep, stepBudgetDefaults, stepOutputLimit, workflowDraft, workflowInputBytes, workflowInputChoices, workflowInputLimit } from '../lib/workflow-editor.mjs';
import { featureAgentCopyHref, featureAgentHref, skillEditor } from './feature-agents.mjs';
import { featureRole } from './feature-language.mjs';
import { nativeSkillChoices, readWorkflowSkillAttachments, skillBundleLimits } from '../lib/workflow-skills.mjs';
import { parseProjectMcpRefs } from '../lib/project-mcp.mjs';
import { agentImageField, escape, layout, projectAgentsHref as libraryHref, projectHeader, projectHref, projectSkillHref, revisionComparisonHref,
  skillInvocationChoices, taskHref, taskStatus, timestamp, workflowRunHref, workflowSetupHref } from './views.mjs';
import { projectMcpFields, projectMcpHref } from './project-mcp.mjs';
import { subagentRoleLimits } from '../lib/workflow-subagents.mjs';
import { hookEditorLimit, workflowHooksJson } from '../lib/workflow-hooks.mjs';
import { agentRunSkillChoices, savesAgentRunWorkspace } from '../lib/agent-run.mjs';
import { parseProjectSkillRefs, projectSkillsEnabled } from '../lib/project-skills.mjs';
import { projectSkillFields } from './project-skills.mjs';
import { agentImagesEnabled } from '../lib/agent-images.mjs';
import { workspaceRepositoryInstruction } from '../lib/workflow-workspace.mjs';

export function workflowHref(project, workflow, version) {
  const query = new URLSearchParams();
  if (workflow) query.set('workflow', workflow);
  if (version) query.set('version', version);
  return projectHref(project) + '/workflows' + (query.size ? '?' + query : '');
}

const link = (href, name, className = '') => `<a${className ? ' class="' + className + '"' : ''} href="${escape(href)}">${escape(name)}</a>`;
const notice = (message, error = false) => message ? `<p class="agent-feedback" role="${error ? 'alert' : 'status'}">${escape(message)}</p>` : '';
const select = (name, label, current, options) => `<label class="agent-field">${escape(label)}<select name="${name}">
  ${options.map(([value, title]) => '<option value="' + escape(value) + '"' + (value === current ? ' selected' : '') +
    '>' + escape(title) + '</option>').join('')}</select></label>`;
const field = (name, label, value, max, { rows, required = true, list, placeholder } = {}) => `<label class="agent-field">${escape(label)}
  ${rows ? `<textarea name="${name}" rows="${rows}" maxlength="${max}"${required ? ' required' : ''}>
${escape(value)}</textarea>` : `<input name="${name}" maxlength="${max}" value="${escape(value)}"${required ? ' required' : ''}${
    list ? ' list="' + escape(list) + '"' : ''}${placeholder ? ' placeholder="' + escape(placeholder) + '"' : ''}>`}</label>`;
const stepBudgets = [
  ['timeoutSeconds', 'Timeout in seconds', 600],
  ['maxAttempts', 'Attempts', 5],
  ['targetTotalTokens', 'Token target', 1_000_000],
];

function configurationPage(project, current, title, body, action = '') {
  return layout(title + ' · ' + project.name, projectHeader(project, current) + `<main class="feature-page configuration-page">
    <div class="agent-page-heading"><h1>${escape(title)}</h1>${action}</div>${body}</main>`);
}

function hostMcpFields(catalog, selected) {
  const available = catalog ? [...catalog.values()].sort((a, b) => a.name.localeCompare(b.name)) : [];
  const missing = selected.filter(name => !catalog?.has(name)).map(name => ({ name, enabled: false }));
  return `<fieldset class="configuration-checks"><legend>Codex MCP servers</legend>
    <p class="agent-field-hint">Attach servers from this Codex host. Codex manages their authentication and tool policies.</p>
    ${catalog === null ? '<p class="muted">The host catalog is unavailable.</p>' : !available.length ?
    '<p class="muted">Add a server in Codex Settings to attach it here.</p>' : ''}
    ${[...available, ...missing].map(({ name, enabled, transport, authStatus }) => {
      const attached = selected.includes(name);
      const subtitle = enabled ? [transport === 'stdio' ? 'Local process' : 'HTTP', authStatus === 'not_logged_in' && 'Sign-in required']
        .filter(Boolean).join(' · ') : attached ? 'Unavailable on this host' : 'Disabled in Codex';
      return `<label class="configuration-tool"><input type="checkbox" name="codex-mcp-server" value="${escape(name)}"
        ${attached ? ' checked' : ''}${!enabled && !attached ? ' disabled' : ''}>
        <span><strong>${escape(name)}</strong><small>${subtitle}</small></span></label>`;
    }).join('')}
  </fieldset>`;
}

function hostPluginFields(catalog, selected, environment) {
  const available = catalog ? [...catalog.values()].sort((a, b) => a.id.localeCompare(b.id)) : [];
  const missing = selected.filter(id => !catalog?.has(id)).map(id => ({ id, enabled: false }));
  return `<fieldset class="configuration-checks"><legend>Installed Codex plugins</legend>
    <p class="agent-field-hint">Attach plugins from this Codex host. Workspace modes let Codex read their packaged skills and files.</p>
    ${catalog === null ? '<p class="muted">The installed plugin catalog is unavailable.</p>' : !available.length ?
      '<p class="muted">Install a plugin in Codex to attach it here.</p>' : ''}
    ${[...available, ...missing].map(({ id, version, enabled, supported }) => {
      const attached = selected.includes(id);
      const ready = enabled && supported;
      const status = ready ? version ? 'Installed · ' + version : 'Installed' :
        attached ? 'Unavailable on this host' : enabled ? 'Requires a supported local package' : 'Disabled in Codex';
      return `<label class="configuration-tool"><input type="checkbox" name="codex-plugin" value="${escape(id)}"
        ${attached ? ' checked' : ''}${!ready && !attached ? ' disabled' : ''}>
        <span><strong>${escape(id)}</strong><small>${escape(status)}</small></span></label>`;
    }).join('')}
    ${available.length || selected.length ? `<div class="configuration-plugin-environment">
      ${field('codex-plugin-env', 'Plugin environment variables', environment.join('\n'), 4000, { rows: 2, required: false })}
      <p class="agent-field-hint">Enter worker environment variable names, one per line.</p></div>` : ''}
  </fieldset>`;
}

function subagentRoleFields(roles, effortOptions, expand) {
  const row = (role = {}, open = false) => `<details class="agent-skill" data-subagent-role${open ? ' open' : ''}>
    <summary data-subagent-summary>${escape(role.name || 'New specialist')}</summary>
    <div class="agent-skill-fields">
      ${field('specialist-name', 'Role name', role.name, subagentRoleLimits.name)}
      ${field('specialist-description', 'When to use this role', role.description, subagentRoleLimits.description, { rows: 2 })}
      ${field('specialist-instructions', 'Specialist instructions', role.instructions, subagentRoleLimits.instructions, { rows: 4 })}
      <div class="agent-model-fields">
        ${field('specialist-model', 'Specialist model', role.model, 120, { required: false })}
        ${select('specialist-reasoning', 'Specialist reasoning effort', role.reasoningEffort ?? '', effortOptions)}
      </div>
      <button class="secondary" type="button" data-remove-subagent hidden>Remove specialist</button>
    </div></details>`;
  return `<fieldset class="agent-fieldset" data-subagent-editor><legend>Specialist subagents</legend>
    <p class="agent-field-hint">Codex can choose these roles when delegation is enabled. Specialists inherit this agent’s tools and workspace permissions.</p>
    <div class="agent-skill-list" data-subagents>${roles.map(role => row(role, expand)).join('')}</div>
    <div><button class="secondary" type="button" data-add-subagent hidden>Add specialist</button></div>
    <template>${row()}</template></fieldset>`;
}

function connectedAppFields(project, attached, selected, editable) {
  const names = new Map(attached.map(app => [app.id, app.name]));
  return `<details class="agent-fieldset agent-connected-apps"${editable ? ` data-connected-apps="${escape(libraryHref(project) + '/apps')}"` : ''}${selected.length ? ' open' : ''}>
    <summary>Connected Codex apps${selected.length ? ' · ' + selected.length + ' attached' : ''}</summary>
    <p class="agent-field-hint">Use apps connected to the Codex worker’s account. Codex applies the worker’s tool policies, including actions that require approval.</p>
    <div class="configuration-checks" data-connected-app-list>${selected.map(id =>
      `<label class="configuration-tool"><input type="checkbox" name="codex-app" value="${escape(id)}" checked>
      <span><strong>${escape(names.get(id) ?? id)}</strong></span></label>`).join('')}</div>
    <p class="agent-field-hint" data-connected-app-status role="status" hidden></p>
    <div><button class="secondary" type="button" data-connected-app-retry hidden>Retry app discovery</button></div>
    ${editable ? '<noscript><p class="agent-field-hint">Enable JavaScript to load the worker’s available apps.</p></noscript>' : ''}
  </details>`;
}

function agentRevisionContext(project, agent, versions, assignments, pinned) {
  if (!agent || !versions.length) return '';
  const back = link(libraryHref(project, agent.id), 'Open current version');
  const history = versions.length > 1 ? `<details class="agent-details">
  <summary>Version history</summary><ul>${versions.map(version => `<li>${version === agent.version ? `<span aria-current="true">Version ${version}</span>`
    : link(libraryHref(project, agent.id, false, version), 'View version ' + version)}${version === versions[0] ? ' · Current version' : ''}</li>`).join('')}</ul></details>` : '';
  const compare = project.id === 'music-transcribe' && versions.length > 1 ?
    link(revisionComparisonHref(project, 'agent', { id: agent.id, to: agent.version }), 'Compare revisions') : '';
  const current = [], earlier = [];
  const latestByWorkflow = new Map();
  for (const assignment of assignments) {
    if (!latestByWorkflow.has(assignment.workflowId)) latestByWorkflow.set(assignment.workflowId, assignment.workflowVersion);
    const list = latestByWorkflow.get(assignment.workflowId) === assignment.workflowVersion ? current : earlier;
    list.push(assignment);
  }
  const assignmentList = items => `<ul>${items.map(({ workflowId, workflowVersion, agentVersion, title, steps }) =>
    `<li>${link(workflowHref(project, workflowId, workflowVersion), title + ' · v' + workflowVersion)}
      <span>Agent v${agentVersion} · ${escape(steps.join(', '))}</span></li>`).join('')}</ul>`;
  return `<section class="record-section agent-revisions" aria-label="Agent revisions">
    ${pinned ? `<p>Saved version ${agent.version} · ${back}</p>` : `<p>Current version ${agent.version}</p>`}
    ${compare ? '<p>' + compare + '</p>' : ''}
    ${history}
    <details class="agent-details" open><summary>Workflow assignments</summary>
      ${current.length ? assignmentList(current)
        : '<p>No saved workflow versions use this agent' + (pinned ? ' revision' : '') + '.</p>'}
      ${earlier.length ? `<details><summary>Earlier workflow versions</summary>${assignmentList(earlier)}</details>` : ''}
    </details>
  </section>`;
}

export function agentLibraryPage(project, { agents, agent, draft, adding, error, saved, mcpCatalog = null, modelCatalog, projectConnections = [],
  pluginCatalog = null, featureSources = [], featureCopy, featureSettingsUnavailable = false, legacyRole, versions = [], assignments = [],
  pinned = false, skillCatalog = [], testRunId, draftDeliveryId, testFields } = {}) {
  const base = libraryHref(project);
  const projectAgents = project.id === 'music-transcribe';
  if (!agent && !adding) {
    const rows = items => items.map(({ id, version, definition }) => `<li>
      ${link(libraryHref(project, id), definition.name)}<p>${escape(definition.remit)}</p>
      <small>Version ${version} · ${escape(definition.model || 'Workflow default model')}${definition.shared ? ' · Shared' : ''}</small></li>`).join('');
    const own = rows(agents.filter(({ definition }) => definition.projectId === project.id));
    const shared = rows(agents.filter(({ definition }) => definition.projectId !== project.id));
    const featureRows = featureSources.map(({ role, key, label, name, profile, active }) => {
      const copy = agents.find(({ definition }) => definition.projectId === project.id &&
        definition.featureSource?.role === role && definition.featureSource.key === key && definition.featureSource.digest === profile.digest);
      const sourceHref = featureAgentHref(project, role, { agent: key });
      const tools = (profile.tools?.length ?? 0) + (profile.extraTools?.length ?? 0);
      const skills = profile.skills?.length ?? 0;
      return `<li>${link(sourceHref, name)}${name === label ? '' : `<span> · ${escape(label)}</span>`}
        <p>${escape(profile.model ?? 'Codex default')} · ${escape(profile.reasoningEffort ?? 'medium')} reasoning · ${active ? 'Active' : 'Available'}</p>
        <p>${escape(workspaceModes[profile.access])} · ${tools} ${tools === 1 ? 'tool' : 'tools'} · ${skills} ${skills === 1 ? 'skill' : 'skills'}</p>
        <small>${copy ? link(libraryHref(project, copy.id), 'Open reusable copy') :
          `<a href="${escape(featureAgentCopyHref(project, role, key))}" aria-label="${escape('Copy ' + name + ' as reusable agent')}">Copy as reusable agent</a>`}</small></li>`;
    }).join('');
    const featureSettings = featureSettingsUnavailable ? notice('The current Feature settings are unavailable.', true)
      : featureRows && '<ul class="index-list">' + featureRows + '</ul>';
    const legacy = projectAgents && featureSettings ? `<details id="legacy-feature-agents" class="record-section agent-details"${legacyRole ? ' open' : ''}>
      <summary>Legacy Feature agents</summary>
      ${legacyRole && !featureSettingsUnavailable ? `<p>${link(featureAgentHref(project, legacyRole), 'Open legacy ' + featureRole(legacyRole) + ' settings')}</p>` : ''}
      ${featureSettings}</details>` : '';
    return configurationPage(project, 'agent-library', 'Agents',
      `<p class="intro">Configure the Codex model, instructions, skills and tools for this project’s agents. Workflows assign agents to the work.</p>
      <section class="record-section"><h2>${projectAgents ? 'Project agents' : 'Reusable agents'}</h2>
      ${own ? '<ul class="index-list">' + own + '</ul>' : '<p class="empty-state">Add an agent to use in direct runs and workflows.</p>'}</section>
      ${shared ? '<section class="record-section"><h2>Shared agents</h2><ul class="index-list">' + shared + '</ul></section>' : ''}
      ${legacy || (featureSettings ? '<section class="record-section"><h2>Feature agents</h2>' + featureSettings + '</section>' : '')}`,
      link(base + '?new=1', 'Add agent', 'agent-add'));
  }
  const values = draft ?? featureCopy?.draft ?? agent?.definition ?? {};
  const version = draft?.expectedVersion ?? agent?.version ?? 0;
  const title = agent ? agent.definition.name : featureCopy ? `Copy ${featureCopy.source.name}` : projectAgents ? 'Add agent' : 'Add reusable agent';
  const action = agent ? libraryHref(project, agent.id) : featureCopy ?
    featureAgentCopyHref(project, featureCopy.origin.role, featureCopy.origin.key) : base + '?new=1';
  const origin = featureCopy?.origin ?? agent?.definition.featureSource;
  const originLink = origin && link(featureAgentHref(project, origin.role, { agent: origin.key }), 'Feature ' + featureRole(origin.role) + ' configuration');
  const foreign = agent?.definition.projectId && agent.definition.projectId !== project.id;
  const editable = !foreign && !pinned;
  const shared = values.shared ?? Boolean(agent && !agent.definition.projectId);
  const tools = values.tools ?? (agent || draft ? [] : defaultWorkflowAgentTools);
  const runtime = values.runtime ?? (agent || draft ? limitedExecution : { ...limitedExecution, workspace: 'workspace-write' });
  const attachedApps = agent?.definition.runtime?.apps ?? [];
  const selectedApps = draft?.appIds ?? attachedApps.map(app => app.id);
  const effortOptions = [['', 'Default'], ...reasoningEfforts.map(key => [key, key === 'xhigh' ? 'Extra high' : key[0].toUpperCase() + key.slice(1)])];
  const serviceTier = runtime.serviceTier ?? '';
  const defaultModel = modelCatalog?.defaultModel ?? '';
  const selectedModel = values.model?.trim() || defaultModel;
  const advertised = modelCatalog?.serviceTiers ?? {};
  const speeds = [['', 'Worker default'], ['default', 'Standard'],
    ...(Object.hasOwn(advertised, selectedModel) ? advertised[selectedModel].map(({ id, name }) => [id, name]) : [])];
  if (!speeds.some(([id]) => id === serviceTier)) speeds.push([serviceTier, codexServiceTierLabel(serviceTier) + ' (not listed for this model)']);
  const models = modelCatalog?.models ?? [];
  const form = `${notice(error, true)}${notice(saved ? 'Agent version saved.' : '')}
    ${agent && !versions.length ? '<p class="muted">Version ' + agent.version + '</p>' : ''}
    ${originLink ? `<p class="muted">${featureCopy ? 'Source' : 'Copied from'} ${originLink}</p>` : ''}
    ${featureCopy ? '<p class="agent-field-hint">Review the copied settings. Feature requests provide their own Docker image, Git context, and test tools. Reusable runs use the workspace and tools selected below.</p>' : ''}
    ${foreign ? '<p class="muted">Shared by ' + escape(agent.definition.projectId) + '. Its owning project controls updates.</p>' : ''}
    <form class="configuration-form" method="post" action="${escape(action)}">
      <input type="hidden" name="version" value="${escape(version)}">
      ${featureCopy ? `<input type="hidden" name="feature-source" value="${escape(featureCopy.origin.digest)}">` : ''}
      <fieldset class="configuration-card"${editable ? '' : ' disabled'}>
        ${field('name', 'Agent name', values.name, agentNameLimit)}
        ${field('remit', 'Responsibilities', values.remit, 1000, { rows: 2 })}
        <div class="agent-model-fields"${projectAgents ? ' data-codex-speed-options="' +
          escape(JSON.stringify({ defaultModel, advertised, savedName: codexServiceTierLabel(serviceTier) })) + '"' : ''}>
          ${field('model', 'Model override', values.model, 120, { required: false,
            ...(models.length && { list: 'worker-agent-models' }),
            ...(projectAgents && { placeholder: defaultModel ? 'Worker default · ' + defaultModel : 'Worker default' }) })}
          ${select('reasoning', 'Reasoning effort', runtime.reasoningEffort, effortOptions)}
          ${projectAgents ? select('service-tier', 'Codex speed', serviceTier, speeds) : ''}
        </div>
        ${models.length ? '<datalist id="worker-agent-models">' + models.map(id => '<option value="' + escape(id) + '"></option>').join('') + '</datalist>' : ''}
        ${projectAgents ? '<p class="agent-field-hint">Faster tiers can use more of your Codex allowance.</p>' : ''}
        ${field('instructions', 'Agent instructions', values.instructions, 16384, { rows: 6 })}
        ${skillEditor(values.skills ?? [], Boolean(error),
          'Upload a folder to include its SKILL.md, references, scripts, and other resources.', skillBundleLimits)}
        ${projectSkillsEnabled(project.id) ? projectSkillFields(project, skillCatalog, values.projectSkills ?? []) : ''}
        <fieldset class="configuration-checks"><legend>Codex tools</legend>
          <p class="agent-field-hint">Codex can call the selected tools as it works. Input tools use this assignment’s pinned artifacts.</p>
          ${Object.entries(workflowAgentTools).filter(([, tool]) => !tool.projectId || tool.projectId === project.id).map(([tool, { title, description }]) =>
            `<label class="configuration-tool"><input type="checkbox" name="codex-tool" value="${tool}"${tools.includes(tool) ? ' checked' : ''}>
              <span><strong>${escape(title)}</strong><small>${escape(description)}</small></span></label>`).join('')}
        </fieldset>
        ${hostMcpFields(mcpCatalog, runtime.mcpServers ?? [])}
        ${projectMcpFields(project, projectConnections, values.projectMcp ?? [])}
        ${connectedAppFields(project, attachedApps, selectedApps, editable)}
        ${hostPluginFields(pluginCatalog, runtime.plugins ?? [], runtime.pluginEnv ?? [])}
        <fieldset class="agent-fieldset"><legend>Native Codex capabilities</legend>
          <div class="agent-model-fields">
            ${select('workspace', 'Workspace', runtime.workspace, Object.entries(workspaceModes))}
            ${select('web-search', 'Web search', runtime.webSearch, Object.entries(webSearchModes))}
          </div>
          <p class="agent-field-hint">Workspace modes let Codex use its shell and file tools within a private copy of this assignment’s files.</p>
          ${projectAgents ? `<label class="configuration-sharing"><input type="checkbox" name="repository-instructions" value="1"${runtime.repositoryInstructions ? ' checked' : ''}>
            Use repository instructions</label>
          <p class="agent-field-hint">Codex reads <code>AGENTS.override.md</code> or <code>AGENTS.md</code> from the starting workspace root. Use a workspace without Codex project configuration files.</p>` : ''}
          <label class="configuration-sharing"><input type="checkbox" name="command-evidence" value="1"${runtime.commandEvidence ? ' checked' : ''}>
            Save shell command details</label>
          <p class="agent-field-hint">Keep commands, exit codes, and output excerpts in Crew’s activity record. Enable this for a read-only or editable workspace when the assignment’s output can be saved.</p>
          <label class="configuration-sharing"><input type="checkbox" name="live-session" value="1"${runtime.liveSession ? ' checked' : ''}>
            Live Codex session</label>
          <p class="agent-field-hint">Answer Codex’s questions, send guidance, or stop the active turn from the handoff.${projectAgents ? ' Direct agent runs always show these controls.' : ''}</p>
          ${select('approval-mode', 'Codex approvals', runtime.approvalMode ?? 'never', Object.entries(approvalModes))}
          <p class="agent-field-hint">Approval review uses a live session. Codex can ask you to approve commands, file changes, or additional permissions from the handoff.</p>
          <label class="configuration-sharing"><input type="checkbox" name="save-thread" value="1"${runtime.saveThread ? ' checked' : ''}>
            Save Codex thread history</label>
          <p class="agent-field-hint">Enables a live session and saves its conversation on the Codex worker for rework or a later workflow step.</p>
          <label class="configuration-sharing"><input type="checkbox" name="image-inspection" value="1"${runtime.imageInspection ? ' checked' : ''}>
            Inspect images in the workspace</label>
          ${projectAgents ? `<label class="configuration-sharing"><input type="checkbox" name="image-generation" value="1"${runtime.imageGeneration ? ' checked' : ''}>
            Generate images with Codex</label>
          <p class="agent-field-hint">Use a supported Codex model and account. Crew saves generated images with the attempt.</p>` : ''}
          <label class="configuration-sharing"><input type="checkbox" name="delegation" value="1"${runtime.delegation ? ' checked' : ''}>
            Let Codex delegate to subagents</label>
          <details class="agent-skill-files"${runtime.delegation ? ' open' : ''}><summary>Subagent defaults</summary>
            <div class="agent-skill-fields">
              <div class="agent-model-fields">
                ${field('subagent-model', 'Default subagent model', runtime.delegation?.model, 120, { required: false })}
                ${select('subagent-reasoning', 'Subagent reasoning effort', runtime.delegation?.reasoningEffort ?? '', effortOptions)}
              </div>
              ${field('subagent-concurrency', 'Maximum concurrent subagents', runtime.delegation?.maxConcurrent, 16, { required: false })}
              <p class="agent-field-hint">Leave fields blank for Codex defaults. Subagents inherit the assignment’s permissions.</p>
            </div>
          </details>
          ${subagentRoleFields(runtime.subagentRoles ?? [], effortOptions, Boolean(error))}
          <details class="agent-skill-files" data-hook-editor${runtime.hooks || runtime.hostHooks || draft?.hookConfig ? ' open' : ''}>
            <summary>Lifecycle hooks</summary>
            <div class="agent-skill-fields">
              <p class="agent-field-hint">Run a command or call an attached MCP tool when a Codex event occurs. Command hooks run with the worker account’s permissions.</p>
              ${field('hook-config', 'Codex hooks.json', draft?.hookConfig ?? (runtime.hooks ? workflowHooksJson(runtime.hooks) : ''), hookEditorLimit, { rows: 11, required: false })}
              <div class="agent-edit-actions">
                <button type="button" data-hook-example hidden>Insert an example</button>
                <a href="https://learn.chatgpt.com/docs/hooks" target="_blank" rel="noopener noreferrer">Codex hook events and configuration</a>
              </div>
              <label class="configuration-sharing"><input type="checkbox" name="approve-hooks" value="1"> I reviewed and trust these hook definitions</label>
              ${runtime.hooks ? '<p class="agent-field-hint">The saved definitions are trusted for this agent version. Review edits before saving.</p>' : ''}
              <label class="configuration-sharing"><input type="checkbox" name="host-hooks" value="1"${runtime.hostHooks ? ' checked' : ''}> Use trusted hooks from the Codex host and attached plugins</label>
            </div>
          </details>
        </fieldset>
        <label class="configuration-sharing"><input type="checkbox" name="shared" value="1"${shared ? ' checked' : ''}> Share this agent with other projects</label>
      </fieldset>
      <div class="agent-edit-actions">${editable ? '<button type="submit">' + (agent ? 'Save agent version' : 'Create agent') + '</button>' : ''}${link(base, 'Back to agents')}</div>
      ${editable && testRunId ? `<details class="configuration-card"${testFields ? ' open' : ''}><summary>Try this draft</summary>
        <p class="agent-field-hint">Run Codex with the settings in this editor before saving an agent version.</p>
        <input type="hidden" name="test-run-id" value="${escape(testRunId)}">
        ${field('test-prompt', 'Test prompt', testFields?.prompt, workflowInputBytes, { rows: 4, required: false })}
        ${field('test-reference', 'Reference material (optional)', testFields?.reference, workflowInputBytes, { rows: 2, required: false })}
        ${agentImageField()}
        ${draftDeliveryId ? select('test-delivery', 'Starting files', testFields?.deliveryRunId ?? '',
          [['', 'Assignment inputs'], [draftDeliveryId, 'Published Music Transcribe workspace']]) : ''}
        <div class="agent-edit-actions"><button class="secondary" type="submit" name="action" value="test" formenctype="multipart/form-data">Test agent draft</button></div>
        <p data-agent-test-result role="status" aria-live="polite"></p>
      </details>` : ''}
    </form>`;
  return configurationPage(project, 'agent-library', title, agentRevisionContext(project, agent, versions, assignments, pinned) + form,
    agent && !pinned ? link(libraryHref(project, agent.id, true), 'Run agent', 'agent-add') : '');
}

function repositoryInstructionPreview(doc, title) {
  if (!doc) return '';
  return `<details class="agent-skill-files"><summary>${escape(title)} · ${escape(doc.path)}</summary><pre>${escape(doc.content)}</pre></details>`;
}

function agentRunSetup(project, agent, connections, { repositoryCommit, repositoryInstructions, publishedBase, repositoryInstructionError }) {
  const definition = agent.definition;
  const runtime = definition.runtime ?? limitedExecution;
  const tools = [
    ...(runtime.workspace !== 'tools' ? ['Shell and file tools'] : []),
    ...(runtime.imageInspection ? ['Workspace image inspection'] : []),
    ...(runtime.imageGeneration ? ['Native Codex image generation'] : []),
    ...(runtime.delegation ? ['Codex subagents'] : []),
    ...(definition.tools ?? []).map(tool => workflowAgentTools[tool]?.title ?? tool),
    ...(runtime.mcpServers ?? []).map(name => name + ' · Worker MCP'),
    ...(runtime.apps ?? []).map(({ name }) => name + ' · Connected app'),
    ...(runtime.plugins ?? []).map(id => id + ' · Codex plugin'),
  ];
  const toolItems = tools.map(name => '<li>' + escape(name) + '</li>').join('') + connections.map(({ id, version, definition }) =>
    '<li>' + link(projectMcpHref(project, id, version), definition.name + ' · v' + version) + '</li>').join('');
  const skillItems = (definition.skills ?? []).map(({ name }) => '<li>' + escape(name) + ' · Agent attachment</li>').join('') +
    (definition.projectSkills ?? []).map(({ id, version, definition }) =>
      '<li>' + link(projectSkillHref(project, id, version), definition.name + ' · v' + version) + '</li>').join('');
  return `<details class="record-section agent-details"><summary>Run setup</summary>
    <p>${link(libraryHref(project, agent.id, false, agent.version), 'Agent instructions and settings · v' + agent.version)}</p>
    <dl class="meta">
      <div><dt>Workspace</dt><dd>${escape(workspaceModes[runtime.workspace])}</dd></div>
      <div><dt>Web search</dt><dd>${escape(webSearchModes[runtime.webSearch])}</dd></div>
      <div><dt>Approval</dt><dd>${escape(approvalModes[runtime.approvalMode ?? 'never'])}</dd></div>
      <div><dt>Requested Codex speed</dt><dd>${escape(codexServiceTierLabel(runtime.serviceTier))}</dd></div>
    </dl>
    ${toolItems ? '<h3>Configured tools</h3><ul class="links">' + toolItems + '</ul>' : ''}
    ${skillItems ? '<h3>Attached skills</h3><ul class="links">' + skillItems + '</ul>' : ''}
    ${runtime.repositoryInstructions ? `<h3>Repository instructions</h3>
      ${repositoryInstructionError ? `<p class="agent-feedback">${escape(repositoryInstructionError)}</p>` :
        repositoryInstructionPreview(repositoryInstructions, 'Committed at ' + (repositoryCommit?.slice(0, 12) ?? '')) ||
        '<p class="muted">No committed repository instruction file was found for a run with assignment inputs.</p>'}
      ${publishedBase ? repositoryInstructionPreview(publishedBase.instructions, 'When using the published workspace') ||
        '<p class="muted">The available published workspace has no root repository instruction file.</p>' : ''}` : ''}
  </details>`;
}

export function agentRunPage(project, agent, { runs, runId, prompt, reference, error, publishedBase, deliveryRunId, invokeSkills = [],
  projectConnections = [], repositoryCommit, repositoryInstructions, repositoryInstructionError }) {
  const action = libraryHref(project, agent.id, true);
  const skills = agentRunSkillChoices(project, agent);
  const attachments = agentImagesEnabled(project.id);
  const history = runs.map(run => {
    const task = run.tasks[0];
    const [status] = taskStatus(run, task);
    return `<li>${link(taskHref(run.id, task.packet.id), run.agentRun.preview)}
      <p>${escape(status)} · Agent v${escape(run.agentRun.version)}</p><small>${timestamp(run.startedAt)}</small></li>`;
  }).join('');
  return configurationPage(project, 'agent-library', 'Run ' + agent.definition.name, `
    <p class="muted">Saved version ${escape(agent.version)} · ${escape(agent.definition.model || 'Codex default model')}</p>
    ${attachments ? '<p class="agent-field-hint">Follow the conversation as Codex works. You can send guidance or stop the active turn.</p>' : ''}
    ${project.id === 'music-transcribe' ? agentRunSetup(project, agent, projectConnections, {
      repositoryCommit, repositoryInstructions, publishedBase, repositoryInstructionError,
    }) : ''}
    ${notice(error, true)}
    <form class="configuration-form" action="${escape(action)}" method="post"${attachments ? ' enctype="multipart/form-data"' : ''}>
      <input type="hidden" name="version" value="${escape(agent.version)}">
      <input type="hidden" name="run-id" value="${escape(runId)}">
      ${repositoryCommit ? `<input type="hidden" name="repository-commit" value="${escape(repositoryCommit)}">` : ''}
      <div class="configuration-card">
        ${field('prompt', 'What should the agent do?', prompt, workflowInputBytes, { rows: 6 })}
        ${field('reference', 'Reference material (optional)', reference, workflowInputBytes, { rows: 3, required: false })}
        ${attachments ? agentImageField() : ''}
        ${skills.length ? `<fieldset class="configuration-checks"><legend>Invoke skills on the first turn</legend>
          ${skillInvocationChoices('invoke-skill', skills, invokeSkills)}</fieldset>` : ''}
        ${publishedBase ? `<label class="configuration-sharing"><input type="checkbox" name="delivery-run-id"
          value="${escape(publishedBase.runId)}"${deliveryRunId === publishedBase.runId ? ' checked' : ''}> Use published workspace</label>
          <p class="agent-field-hint">Stages the published files in this run. Workspace <code title="${escape(publishedBase.digest)}">${escape(publishedBase.digest.slice(0, 12))}</code>.</p>` : ''}
        ${savesAgentRunWorkspace(project, agent) ? '<p class="agent-field-hint">Crew saves workspace files after each completed turn so follow-ups can use them. Codex can save a recovery checkpoint during the turn.</p>' : ''}
      </div>
      <div class="agent-edit-actions"><button type="submit">Start run</button>${link(libraryHref(project, agent.id), 'Back to agent')}</div>
    </form>
    <section class="record-section"><h2>Recent agent runs</h2>${history ? '<ul class="index-list">' + history + '</ul>' :
      '<p class="empty-state">No runs for this agent yet.</p>'}</section>`);
}

export function readLibraryDraft(form) {
  const skills = readWorkflowSkillAttachments(form);
  const concurrency = clean(form.get('subagent-concurrency')).trim();
  const saveThread = form.get('save-thread') === '1';
  const approvalMode = form.get('approval-mode') ?? 'never';
  return {
    expectedVersion: versionNumber(form.get('version')),
    name: clean(form.get('name')).trim(), remit: clean(form.get('remit')), model: clean(form.get('model')).trim(),
    shared: form.get('shared') === '1',
    instructions: clean(form.get('instructions')),
    tools: form.getAll('codex-tool'),
    appIds: form.getAll('codex-app'),
    projectMcp: parseProjectMcpRefs(form.getAll('project-mcp')),
    projectSkills: parseProjectSkillRefs(form.getAll('project-skill')),
    hookConfig: clean(form.get('hook-config')),
    approveHooks: form.get('approve-hooks') === '1',
    runtime: { workspace: form.get('workspace') ?? limitedExecution.workspace,
      webSearch: form.get('web-search') ?? limitedExecution.webSearch, reasoningEffort: form.get('reasoning') ?? '',
      serviceTier: form.get('service-tier') ?? '',
      mcpServers: form.getAll('codex-mcp-server'), plugins: form.getAll('codex-plugin'),
      pluginEnv: clean(form.get('codex-plugin-env')).split('\n').map(name => name.trim()).filter(Boolean),
      imageInspection: form.get('image-inspection') === '1',
      imageGeneration: form.get('image-generation') === '1',
      commandEvidence: form.get('command-evidence') === '1',
      repositoryInstructions: form.get('repository-instructions') === '1',
      liveSession: saveThread || approvalMode !== 'never' || form.get('live-session') === '1', saveThread, approvalMode,
      hostHooks: form.get('host-hooks') === '1',
      subagentRoles: readSubagentRoles(form),
      ...(form.get('delegation') === '1' && { delegation: {
        maxConcurrent: concurrency ? Number(concurrency) : null, model: clean(form.get('subagent-model')).trim(),
        reasoningEffort: form.get('subagent-reasoning') ?? '',
      } }) },
    skills,
  };
}

const clean = value => (value ?? '').replace(/\r\n?/g, '\n');
function readSubagentRoles(form) {
  const fields = ['name', 'description', 'instructions', 'model', 'reasoning'].map(key => form.getAll('specialist-' + key));
  const [names, descriptions, instructions, models, efforts] = fields;
  if (fields.some(values => values.length !== names.length)) throw new CrewError('Complete the fields for each Codex specialist.', 2);
  return names.map((name, index) => ({ name: name.trim(), description: clean(descriptions[index]), instructions: clean(instructions[index]),
    model: models[index].trim(), reasoningEffort: efforts[index] }));
}
export function versionNumber(value) {
  return /^(?:0|[1-9]\d{0,9})$/.test(value ?? '') ? Number(value) : NaN;
}

function rowRefs(form, name, limit, label) {
  const rows = form.getAll(name);
  if (rows.length > limit || new Set(rows).size !== rows.length) throw new CrewError('Invalid ' + label + '.', 2);
  return rows.map(row => id(row, label));
}

export function readWorkflowDraft(form, snapshot) {
  const steps = rowRefs(form, 'step', 20, 'workflow step');
  if (!steps.length) throw new CrewError('Add a workflow step.', 2);
  const editingContract = form.get('artifact-contract') === '1';
  const baseline = new Map(workflowDraft(snapshot).steps.map(step => [step.id, step]));
  return {
    title: clean(form.get('title')).trim(), goal: clean(form.get('goal')).trim(),
    ...(form.has('dispatch-mode') && { dispatchMode: form.get('dispatch-mode') }),
    ...(form.has('workspace-paths') && { workspacePaths: clean(form.get('workspace-paths')) }),
    ...((!snapshot || snapshot.inlineBrief) && { brief: clean(form.get('brief')) }),
    ...(editingContract && { inputRows: rowRefs(form, 'workflow-input', workflowInputLimit, 'workflow input').map(ref => ({
      ref, id: clean(form.get('workflow-input.' + ref + '.id')).trim(), title: clean(form.get('workflow-input.' + ref + '.title')).trim(),
      content: clean(form.get('workflow-input.' + ref + '.content')),
    })) }),
    steps: steps.map(step => {
      const get = field => clean(form.get(step + '.' + field));
      const budget = Object.fromEntries(stepBudgets.filter(([key]) => form.has(step + '.' + key)).map(([key]) => [key, Number(get(key))]));
      const original = baseline.get(step);
      const outputs = editingContract && rowRefs(form, step + '.output', stepOutputLimit, 'output row').map(ref => {
        const locked = original?.outputs.find(slot => slot.ref === ref && slot.locked);
        const key = 'output.' + ref + '.';
        return locked ?? { ref, id: get(key + 'id').trim(), title: get(key + 'title').trim(), kind: get(key + 'kind'),
          acceptance: get(key + 'acceptance'), required: get(key + 'required') === '1' };
      });
      const routes = editingContract && form.getAll(step + '.route').map(value => {
        const [producer, output, extra] = value.split('/');
        if (extra !== undefined) throw new CrewError('Invalid artifact connection.', 2);
        return { step: id(producer, 'artifact producer'), output: id(output, 'artifact output') };
      });
      const [conditionStep, conditionOutput, extra] = get('condition-source').split('/');
      if (conditionStep && (!conditionOutput || extra !== undefined)) throw new CrewError('Choose an output for the run condition.', 2);
      const repairMode = get('repair-mode');
      return { id: step, title: get('title').trim(), objective: get('objective'), owner: get('owner').trim(), agent: get('agent'),
        prerequisites: form.getAll(step + '.dependency'), inputs: form.getAll(step + '.input'),
        ...(form.has('skill-invocation') && { skillSelections: form.getAll(step + '.invoke-skill') }),
        ...(form.has('request-image-routing') && { receiveRequestImages: get('request-images') === '1' }),
        ...(form.has(step + '.review-mode') && { reviewMode: get('review-mode') }),
        ...(form.has(step + '.response-mode') && { responseMode: get('response-mode') }),
        ...(form.has(step + '.output-follow-ups') && {
          outputFollowUps: get('response-mode') === 'free-form' ? Number(get('output-follow-ups')) : 0,
        }),
        ...(form.has('workspace-handoffs') && { workspaceSource: get('workspace-source'), captureWorkspace: get('capture-workspace') === '1' }),
        ...(form.has('workspace-handoffs') && { workspaceCheck: get('workspace-check') }),
        ...(form.has('workspace-handoffs') && { workspaceRepair: repairMode ? { mode: repairMode, limit: Number(get('repair-limit')) } : null }),
        ...(form.has('workspace-handoffs') && { publishWorkspace: get('publish-workspace') === '1' }),
        ...(form.has('codex-history-routing') && { historyFrom: get('history-source') }),
        ...(form.has('conditional-routing') && { joinPrerequisites: form.getAll(step + '.join'), runWhen: conditionStep ? {
          step: id(conditionStep, 'condition step'), output: id(conditionOutput, 'condition output'), pointer: get('condition-pointer'),
          operator: get('condition-operator'), value: get('condition-value'),
        } : null }),
        ...(editingContract && { outputs, routes }),
        ...(original?.execution && { execution: original.execution }),
        ...(form.has(step + '.acceptance') && { acceptance: get('acceptance') }),
        ...(Object.keys(budget).length && { budget }),
      };
    }),
  };
}

function workflowInputFields(rows, action, count) {
  return `<section class="configuration-card" id="workflow-inputs">
    <h2>Workflow inputs</h2>
    <p class="agent-field-hint">Save named reference material with this workflow. Choose which steps receive it.</p>
    ${rows.map(row => {
      const key = 'workflow-input.' + row.ref + '.';
      return `<fieldset class="configuration-artifact" data-workflow-input="${escape(row.ref)}">
        <legend>${escape(row.title || 'New input')}</legend>
        <input type="hidden" name="workflow-input" value="${escape(row.ref)}">
        <div class="agent-model-fields">${field(key + 'title', 'Input name', row.title, 120)}
          ${field(key + 'id', 'Input ID', row.id, 64)}</div>
        ${field(key + 'content', 'Input content', row.content, workflowInputBytes, { rows: 4 })}
        <button type="submit" class="secondary" name="remove-input" value="${escape(row.ref)}" formnovalidate
          formaction="${escape(action)}#workflow-inputs">Remove input</button>
      </fieldset>`;
    }).join('')}
    ${count < workflowInputLimit ? `<div class="agent-edit-actions"><button type="submit" class="secondary" name="action"
      value="add-input" formnovalidate formaction="${escape(action)}#workflow-inputs">Add workflow input</button></div>` : ''}
  </section>`;
}

function outputFields(step, action, evidenceOutputs) {
  const anchor = 'outputs-' + step.id;
  const route = escape(action) + '#' + anchor;
  return `<details class="configuration-budget" id="${anchor}" open><summary>Outputs</summary>
    ${evidenceOutputs ? '<p class="agent-field-hint">Evidence outputs use free-form replies. Attach image generation for generated images or the workspace browser for screenshots and observations.</p>' : ''}
    ${step.outputs.map(slot => {
      const key = step.id + '.output.' + slot.ref + '.';
      const reference = `<input type="hidden" name="${step.id}.output" value="${escape(slot.ref)}">`;
      if (slot.locked) return `<div class="configuration-artifact">${reference}<p><strong>${escape(slot.title || slot.id)}</strong>
        <span class="muted"> · Required by the workflow runner or review</span></p><p>${escape(slot.acceptance)}</p></div>`;
      return `<fieldset class="configuration-artifact" data-output-slot="${escape(slot.ref)}">
        <legend>${escape(slot.title || 'New output')}</legend>${reference}
        <div class="agent-model-fields">${field(key + 'title', 'Output name', slot.title, 120, { required: false })}
          ${field(key + 'id', 'Output ID', slot.id, 64)}</div>
        ${select(key + 'kind', 'Output type', slot.kind, Object.entries(artifactOutputKinds).filter(([kind]) => evidenceOutputs || !isEvidenceOutput(kind)))}
        ${field(key + 'acceptance', 'Result acceptance criteria', slot.acceptance, 1000, { rows: 2 })}
        <label class="configuration-sharing"><input type="checkbox" name="${key}required" value="1"${slot.required ? ' checked' : ''}> Required output</label>
        ${step.outputs.length > 1 ? `<button type="submit" class="secondary" name="remove-output"
          value="${step.id}/${escape(slot.ref)}" formaction="${route}" formnovalidate>Remove output</button>` : ''}
      </fieldset>`;
    }).join('')}
    ${step.outputs.length < stepOutputLimit ? `<div class="agent-edit-actions"><button type="submit" class="secondary"
      name="add-output" value="${step.id}" formaction="${route}" formnovalidate>Add output</button></div>` : ''}
  </details>`;
}

function routeFields(step, steps, audioChecks, options) {
  const choices = steps.filter(other => other.id !== step.id).map(other => {
    const outputs = handoffChoices(other, { includeOptional: true });
    if (audioChecks && !other.execution) {
      if (!other.workspaceCheck) outputs.push({ ref: 'check-receipt', title: 'Music Transcribe acceptance receipt' });
      if (!other.outputs?.some(output => output.id === browserActivitySlot))
        outputs.push({ ref: browserActivitySlot, title: 'Browser action log', browser: true });
    }
    return outputs.length ? `<fieldset class="configuration-checks configuration-route" data-route-from="${other.id}">
      <legend data-route-title>${escape(other.title || other.id)}</legend>
      ${outputs.map(slot => {
        const checked = step.routes.some(route => route.step === other.id && route.output === slot.ref);
        const capability = slot.browser ? 'browser'
          : slot.ref === 'check-receipt' && !other.execution ? 'workspace-check' : '';
        const available = capability === 'browser' ? options.some(option => option[0] === other.agent && option[5])
          : capability === 'workspace-check' ? Boolean(other.workspaceCheck) : slot.required !== false;
        return `<label data-route-output="${escape(slot.ref)}"${capability ? ' data-route-capability="' + capability + '"' : ''}${available ? '' : ' hidden'}>
          <input type="checkbox" name="${step.id}.route" value="${other.id}/${escape(slot.ref)}"
            ${available ? '' : ' disabled'}${checked ? ' checked' : ''}>
          <span>${escape(slot.title || slot.id || slot.ref)}${isImageOutput(slot.kind) ? ' · Image' : ''}</span></label>`;
      }).join('')}</fieldset>` : '';
  }).join('');
  return choices ? `<div class="configuration-routes">${choices}</div>` : '';
}

function conditionalFields(step, steps) {
  const parents = steps.filter(parent => parent.id !== step.id);
  const condition = step.runWhen;
  if (!parents.length && !condition) return '';
  const key = step.id + '.';
  const hasSource = parents.some(parent => parent.id === condition?.step &&
    parent.outputs?.some(slot => slot.ref === condition.output && !slot.locked));
  const removedSource = condition && !hasSource ? `<option value="${escape(condition.step + '/' + condition.output)}" selected>Removed output (unavailable)</option>` : '';
  const outputChoices = parents.flatMap(parent => (parent.outputs ?? []).filter(slot => !slot.locked).map(slot => {
    const eligible = step.prerequisites.includes(parent.id) && slot.required && slot.kind === 'json';
    const selected = condition?.step === parent.id && condition.output === slot.ref;
    return `<option value="${escape(parent.id + '/' + slot.ref)}" data-condition-step="${escape(parent.id)}"
      data-condition-output="${escape(slot.ref)}"${eligible || selected ? '' : ' disabled'}${selected ? ' selected' : ''}>${
      escape((parent.title || parent.id) + ' · ' + (slot.title || slot.id || slot.ref))}${selected && !eligible ? ' (unavailable)' : ''}</option>`;
  })).join('');
  return `<details class="configuration-budget"${condition || step.joinPrerequisites?.length ? ' open' : ''}><summary>Run condition and branch joins</summary>
    <label class="agent-field">Condition source<select name="${key}condition-source" data-condition-source>
      <option value="">Always run when prerequisites are ready</option>${removedSource}${outputChoices}</select></label>
    <p class="agent-field-hint">Conditions read a required JSON output from an accepted prerequisite.</p>
    <div class="agent-model-fields">
      ${field(key + 'condition-pointer', 'JSON pointer', condition?.pointer, 512, { required: false })}
      ${select(key + 'condition-operator', 'Comparison', condition?.operator ?? 'equals', Object.entries(conditionOperators))}
      ${field(key + 'condition-value', 'JSON comparison value', condition?.value, 10000, { required: false })}
    </div>
    <p class="agent-field-hint">Use a pointer such as <code>/route</code> and a JSON value such as <code>"review"</code>. An empty pointer compares the whole output.</p>
    <fieldset class="configuration-checks"><legend>Branch joins</legend>
      <p class="agent-field-hint">Allow this step to continue after a selected prerequisite is accepted or skipped.</p>
      ${parents.map(parent => `<label data-join-from="${escape(parent.id)}"${step.prerequisites.includes(parent.id) ? '' : ' hidden'}>
        <input type="checkbox" name="${key}join" value="${escape(parent.id)}"${step.joinPrerequisites?.includes(parent.id) ? ' checked' : ''}>
        <span>${escape(parent.title || parent.id)}</span></label>`).join('')}
    </fieldset></details>`;
}

function stepForm(step, steps, inputs, options, action, audioChecks, pinnedAgent) {
  const item = name => step.id + '.' + name;
  const skillEnabled = audioChecks && !step.execution;
  const skillOptions = (profileId, choices) => choices.map(({ number, name }) => ({ name, value: profileId + '/' + number }));
  const selected = options.find(([value]) => value === step.agent);
  const selectedSkills = selected ? skillOptions(selected[2], selected[4]) : [];
  const checkbox = (name, value, selected, label, dependency = false) =>
    `<label><input type="checkbox" name="${name}" value="${escape(value)}"${selected ? ' checked' : ''}>
      <span ${dependency ? 'data-dependency-label' : 'data-config-input-label'}>${escape(label)}</span></label>`;
  const dependencyChoices = steps.filter(other => other.id !== step.id).map(other =>
    checkbox(item('dependency'), other.id, step.prerequisites.includes(other.id), other.title || other.id, true)).join('');
  const historyChoices = steps.filter(other => other.id !== step.id).map(other =>
    `<option value="${other.id}"${other.id === step.historyFrom ? ' selected' : ''}>${escape(other.title || other.id)}</option>`).join('');
  const workspaceSources = steps.filter(other => other.id !== step.id).map(other => ['step:' + other.id, other.title || other.id]);
  if (step.workspaceSource?.startsWith('step:') && !workspaceSources.some(([id]) => id === step.workspaceSource))
    workspaceSources.push([step.workspaceSource, 'Removed step']);
  return `<section class="configuration-card" id="config-${step.id}" data-config-step="${step.id}">
    <input type="hidden" name="step" value="${step.id}">
    <div class="configuration-step-header"><h3 data-config-step-title>${escape(step.title || 'New step')}</h3>
      ${steps.length > 1 ? `<button type="submit" class="secondary" name="remove" value="${step.id}" formnovalidate>Remove step</button>` : ''}
    </div>
    ${field(item('title'), 'Step title', step.title, 120)}
    ${field(item('objective'), 'Objective', step.objective, 2000, { rows: 3 })}
    <div class="agent-model-fields">
      <div><label class="agent-field">Agent<select name="${item('agent')}" required>
        <option value="">Choose an agent</option>${options.map(([value, label, profileId, saveThread, skills, browser]) =>
          `<option value="${escape(value)}"${value === step.agent ? ' selected' : ''}${saveThread ?
            ` data-saved-thread-profile="${escape(profileId)}"` : ''}${browser ? ' data-browser-capability' : ''}${skillEnabled && skills.length ?
            ` data-skill-profile="${escape(profileId)}" data-skill-choices="${escape(JSON.stringify(skillOptions(profileId, skills)))}"` : ''}>${escape(label)}</option>`).join('')}</select></label>
        ${pinnedAgent ? `<p class="agent-field-hint">${pinnedAgent}</p>` : ''}</div>
      ${field(item('owner'), 'Decision owner', step.owner, 120)}
    </div>
    ${skillEnabled ? `<fieldset class="configuration-checks" data-step-skill-inputs data-field-name="${item('invoke-skill')}"
      data-skill-profile="${selectedSkills.length ? escape(selected[2]) : ''}"${selectedSkills.length ? '' : ' hidden'}>
      <legend>Skills to invoke</legend><div class="configuration-checks" data-step-skill-options>
      ${skillInvocationChoices(item('invoke-skill'), selectedSkills, step.skillSelections)}</div></fieldset>` : ''}
    ${select(item('review-mode'), 'Handoff review', step.reviewMode ?? 'human', [
      ['human', 'Require human acceptance'], ['automatic', 'Accept after evidence validation']])}
    <p class="agent-field-hint">Codex approvals use the policy set on the agent.</p>
    <fieldset class="configuration-checks"><legend>Workflow inputs for this step</legend>${inputs.map(input =>
      checkbox(item('input'), input.ref, step.inputs.includes(input.ref), input.title || input.id)).join('')}</fieldset>
    ${audioChecks ? `<label class="agent-check">
      <input type="checkbox" name="${item('request-images')}" value="1"${step.receiveRequestImages ? ' checked' : ''}> Receive request images</label>
      <p class="agent-field-hint">Send images uploaded with a request to Codex on this step.</p>` : ''}
    ${dependencyChoices ? `<fieldset class="configuration-checks"><legend>Prerequisites</legend>
      <p class="agent-field-hint">This step waits for the selected steps to be accepted. Choose which outputs and evidence to pass to it.</p>${dependencyChoices}</fieldset>` : ''}
    ${routeFields(step, steps, audioChecks, options)}
    ${conditionalFields(step, steps)}
    ${historyChoices ? `<label class="agent-field">Codex thread history<select name="${item('history-source')}" data-history-source>
      <option value="">Start a new conversation</option>${historyChoices}</select></label>
      <p class="agent-field-hint">Copy the conversation through an accepted prerequisite’s last turn. Both steps must use the same agent version with history enabled.</p>` : ''}
    ${step.execution ? '' : `<details class="configuration-budget"${step.workspaceSource || step.captureWorkspace ? ' open' : ''}><summary>Workspace files</summary>
      ${select(item('workspace-source'), 'Stage files from', step.workspaceSource ?? '', [['', 'Assignment inputs'], ['baseline', 'Pinned project files'],
        ...(audioChecks ? [['delivery', 'Latest published workspace']] : []), ...workspaceSources])}
      <p class="agent-field-hint">${audioChecks
        ? 'Crew pins the published workspace when a run starts. Before the first delivery, the step starts with any pinned project files and its assignment inputs.'
        : 'Choose pinned project files or an accepted prerequisite that saves its workspace.'}</p>
      <label class="agent-check"><input type="checkbox" name="${item('capture-workspace')}" value="1"${step.captureWorkspace ? ' checked' : ''}> Save workspace files when Codex completes the step</label>
      <p class="agent-field-hint">Saving files requires an editable Codex workspace. Crew captures up to 300 files and 2 MiB.</p>
      ${audioChecks ? '<p class="agent-field-hint">When enabled, Codex can save a recovery checkpoint while working. Music Transcribe development checks also save the files they test.</p>' : ''}
      ${audioChecks ? `<label class="agent-check"><input type="checkbox" name="${item('workspace-check')}" value="${musicWorkspaceCheck}"${step.workspaceCheck ? ' checked' : ''}> Run Music Transcribe audio acceptance</label>
      <p class="agent-field-hint">Run Node tests, check <code>/health</code>, and verify both recordings against the staged workspace in the local audio image.</p>
      <div class="agent-model-fields">${select(item('repair-mode'), 'Repair after a failed check', step.workspaceRepair?.mode ?? '', [
        ['', 'Off'], ['manual', 'Ask the operator to send it back'], ['automatic', 'Open a repair round automatically']])}
      <label class="agent-field">Repair rounds<input type="number" name="${item('repair-limit')}" min="1" max="5" value="${escape(step.workspaceRepair?.limit ?? 2)}"></label></div>
      <p class="agent-field-hint">A repair returns the files and failed check receipt to the prerequisite that supplied the workspace.</p>
      <label class="agent-check"><input type="checkbox" name="${item('publish-workspace')}" value="1"${step.publishWorkspace ? ' checked' : ''}> Enable local delivery from this verification step</label>
      <p class="agent-field-hint">After passing checks and acceptance, publish this workspace and open it as a local app.</p>` : ''}
    </details>`}
    ${audioChecks ? `${select(item('response-mode'), 'Codex response mode', step.responseMode ?? 'structured', Object.entries(workflowResponseModes))}
      <p class="agent-field-hint">Free-form mode uses a saved Codex agent. Codex submits named outputs with tools and writes a separate reply.</p>
      <div data-output-follow-up-setting${step.responseMode === 'free-form' ? '' : ' hidden'}>
      ${select(item('output-follow-ups'), 'Missing output follow-up turns', String(step.outputFollowUps ?? 0),
        [['0', 'Off'], ...Array.from({ length: maxOutputFollowUps }, (_, index) => [String(index + 1), String(index + 1)])])}
      <p class="agent-field-hint">Crew tells Codex which required outputs are missing so it can continue in the same session within the step timeout.</p></div>` : ''}
    ${outputFields(step, action, audioChecks)}
    <details class="configuration-budget"><summary>Execution budget</summary><div class="configuration-budget-fields">
      ${stepBudgets.map(([key, label, max]) => `<label class="agent-field">${label}<input type="number" min="1" max="${max}"
        name="${item(key)}" value="${escape(step.budget?.[key] ?? stepBudgetDefaults[key])}" required></label>`).join('')}
    </div></details>
  </section>`;
}

function workflowDependencyGraph(editable) {
  return `<section class="configuration-preview configuration-graph" data-config-preview data-dependency-graph
    ${editable ? 'data-editable-graph' : ''} hidden aria-labelledby="workflow-dependency-graph">
    <h2 id="workflow-dependency-graph">Dependency graph</h2>
    <p class="agent-field-hint" data-config-status role="status"></p>
    <div class="configuration-graph-layout">
      <div class="configuration-graph-viewport" tabindex="0" role="region" aria-label="Workflow steps and connections">
        <div class="configuration-graph-canvas" data-dependency-canvas>
          <svg class="workflow-wires" aria-hidden="true" focusable="false"><defs>
            <marker id="workflow-editor-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto">
              <path d="M1 1L7 4L1 7" fill="none" stroke="currentColor" stroke-linejoin="round"/>
            </marker></defs><g></g></svg>
          <div class="configuration-graph-levels" data-dependency-levels></div>
        </div>
      </div>
      <section class="configuration-graph-selection" aria-label="Selected step">
        <h3 data-selected-dependency-step></h3>
        <h4>Waits for</h4><ul data-selected-prerequisites></ul>
        ${editable ? `<div class="configuration-graph-actions">
          <button type="button" class="secondary" data-connect-dependency aria-pressed="false">Add prerequisite</button>
          <button type="button" class="secondary" data-undo-dependency hidden>Undo</button>
        </div>` : ''}
        <a data-edit-dependency-step>${editable ? 'Open step settings' : 'View step settings'}</a>
        <p class="agent-field-hint" data-dependency-feedback role="status"></p>
      </section>
    </div>
  </section>`;
}

export function workflowConfigurationPage(project, { workflows, snapshot, versions = [], agents = [], draft, expectedVersion, adding, error, saved,
  workflowTests = [], draftWorkflowId, testRunId } = {}) {
  const base = workflowHref(project);
  const recentTests = workflowTests.length ? `<section class="record-section"><h2>Recent draft tests</h2><ul class="index-list">
    ${workflowTests.map(test => `<li>${link(workflowRunHref(project, test.workflowId, test.id), test.title)}
      <small>${test.baseVersion ? 'Based on v' + escape(test.baseVersion) : 'New workflow'} · ${timestamp(test.startedAt)}</small></li>`).join('')}</ul></section>` : '';
  if (!snapshot && !adding) {
    const rows = workflows.map(workflow => `<li>${link(workflowHref(project, workflow.id), workflow.title)}
      <p>${escape(workflow.goal)}</p><small>Version ${workflow.version}</small></li>`).join('');
    return configurationPage(project, 'workflows', 'Workflows',
      `<p class="intro">A workflow defines the assignments and their dependencies. Each assignment uses a saved Codex agent.</p>
      ${rows ? '<ul class="index-list">' + rows + '</ul>' : '<p class="empty-state">This project has no registered workflows.</p>'}${recentTests}`,
      link(base + '?new=1', 'New workflow', 'agent-add'));
  }
  const workflowId = snapshot?.project.epic.id;
  const pinnedAgents = new Map((snapshot?.project.tasks ?? []).map(({ id, profileId }) => [id, snapshot.agentOrigins?.[profileId]]));
  const latest = !snapshot || versions.length === 0 || versions[0].version === snapshot.version;
  const defaults = workflowDraft(snapshot);
  const rows = draft.inputRows ?? defaults.inputRows;
  const inputs = workflowInputChoices(snapshot, rows);
  const existing = new Map(defaults.steps.map(step => [step.id, step]));
  const steps = draft.steps.map(step => {
    if (step.outputs) return step;
    const prior = existing.get(step.id);
    const outputs = prior?.outputs ?? newWorkflowStep([], []).outputs;
    return { ...step, outputs: step.acceptance === undefined ? outputs :
      outputs.map(slot => outputs.length === 1 && slot.kind === 'markdown' ? { ...slot, acceptance: step.acceptance } : slot),
    routes: prior?.routes.filter(route => step.prerequisites.includes(route.step)) ?? [] };
  });
  const options = [
    ...(snapshot?.project.profiles ?? []).map(profile => ['workflow:' + profile.id,
      profile.name + (snapshot.agentOrigins?.[profile.id] ? ' · Pinned v' + profile.revision : ' · Workflow profile'),
      profile.id, snapshot.agentOrigins?.[profile.id]?.codexRuntime?.saveThread,
      nativeSkillChoices(snapshot.agentOrigins?.[profile.id]?.codexRuntime?.workspace, snapshot.agentOrigins?.[profile.id]?.skillNames),
      snapshot.agentOrigins?.[profile.id]?.codexTools?.includes(musicBrowserTool)]),
    ...agents.map(agent => ['library:' + agent.id + ':' + agent.version,
      agent.definition.name + (agent.definition.projectId === project.id ? ' · Project v' : ' · Shared v') + agent.version,
      agent.id + '-v' + agent.version, agent.definition.runtime?.saveThread, agentRunSkillChoices(project, agent),
      agent.definition.tools?.includes(musicBrowserTool)]),
  ];
  const href = snapshot ? workflowHref(project, workflowId) : base + '?new=1';
  const title = snapshot?.project.epic.title ?? 'New workflow';
  const versionLinks = versions.length > 1 ? `<nav class="agent-choices" aria-label="Workflow versions">${versions.map(({ version }) =>
    link(workflowHref(project, workflowId, version), 'v' + version)).join('')}${project.id === 'music-transcribe' ?
    link(revisionComparisonHref(project, 'workflow', { id: workflowId, to: snapshot.version }), 'Compare revisions') : ''}</nav>` : '';
  const run = snapshot ? `<form method="post" action="${escape(workflowHref(project, workflowId, snapshot.version))}">
    <input type="hidden" name="version" value="${snapshot.version}">
    <button class="secondary" type="submit" name="action" value="run">${snapshot.project.dispatchMode === 'automatic' ? 'Start' : 'Create'} run from v${snapshot.version}</button></form>` : '';
  const body = `${notice(error, true)}${notice(saved ? 'Workflow version saved.' : '')}
    ${snapshot ? `<div class="configuration-versions"><p class="muted">Version ${snapshot.version}${project.id === 'music-transcribe' ?
      ' · ' + link(workflowSetupHref(project, workflowId, snapshot.version), 'Run setup') : ''}</p>${run}</div>` : ''}
    ${versionLinks}
    ${latest ? '' : `<p>${link(href, 'Edit latest version')}</p>`}
    ${options.length ? '' : `<p class="empty-state">${link(libraryHref(project) + '?new=1', 'Create an agent')} before saving a workflow.</p>`}
    <form class="configuration-form" method="post" action="${escape(href)}" data-config-workflow>
      <input type="hidden" name="version" value="${escape(expectedVersion ?? snapshot?.version ?? 0)}">
      ${testRunId ? `<input type="hidden" name="test-run-id" value="${escape(testRunId)}">
        ${draftWorkflowId ? `<input type="hidden" name="draft-workflow-id" value="${escape(draftWorkflowId)}">` : ''}` : ''}
      <input type="hidden" name="artifact-contract" value="1">
      <input type="hidden" name="codex-history-routing" value="1">
      <input type="hidden" name="conditional-routing" value="1">
      <input type="hidden" name="workspace-handoffs" value="1">
      ${projectSkillsEnabled(project.id) ? '<input type="hidden" name="skill-invocation" value="1">' : ''}
      ${agentImagesEnabled(project.id) ? '<input type="hidden" name="request-image-routing" value="1">' : ''}
      ${project.id === 'music-transcribe' ? workflowDependencyGraph(latest) : ''}
      <fieldset class="configuration-form-fields"${latest ? '' : ' disabled'}>
        <button type="submit" name="action" value="save" hidden>Save</button>
        <section class="configuration-card">
          ${field('title', 'Workflow title', draft.title, 120)}
          ${field('goal', 'Goal', draft.goal, 1000, { rows: 2 })}
          ${draft.brief === undefined ? '' : field('brief', 'Default brief', draft.brief, 12000, { rows: 5 })}
          ${select('dispatch-mode', 'Dispatch', draft.dispatchMode ?? 'manual', [
            ['manual', 'Start each step manually'], ['automatic', 'Start ready steps automatically']])}
        </section>
        <details class="configuration-card"${draft.workspacePaths ? ' open' : ''}><summary>Pinned project files</summary>
          ${field('workspace-paths', 'Committed file paths', draft.workspacePaths, 150000, { rows: 4, required: false })}
          <p class="agent-field-hint">Enter one Git path per line. Saving a version captures these files from the project checkout’s current commit.</p>
          ${project.id === 'music-transcribe' ? '<p class="agent-field-hint">Include <code>AGENTS.md</code> or <code>AGENTS.override.md</code> to provide native repository guidance to agents configured to use it.</p>' : ''}
          ${snapshot?.workspaceBaseline ? `<p class="agent-field-hint">Saved baseline <code>${escape(snapshot.workspaceBaseline.commit)}</code></p>` : ''}
          ${project.id === 'music-transcribe' && snapshot?.workspaceBaseline ? repositoryInstructionPreview(
            workspaceRepositoryInstruction(snapshot.workspaceBaseline.files), 'Saved repository instructions') : ''}
        </details>
        ${workflowInputFields(rows, href, inputs.length)}
        ${project.id !== 'music-transcribe' ? `<section class="configuration-preview" data-config-preview hidden aria-label="Dependency preview">
          <h2>Dependency preview</h2><p class="agent-field-hint" data-config-status role="status"></p><ol data-config-order></ol>
        </section>` : ''}
        <h2>Steps</h2>
        ${steps.map(step => {
          const pinned = project.id === 'music-transcribe' && pinnedAgents.get(step.id);
          const agentLink = pinned && link(libraryHref(project, pinned.agentId, false, pinned.version), 'View saved agent v' + pinned.version);
          return stepForm(step, steps, inputs, options, href, project.id === 'music-transcribe', agentLink || '');
        }).join('')}
        <div class="agent-edit-actions">
          ${draft.steps.length < 20 ? '<button class="secondary" type="submit" name="action" value="add" formnovalidate>Add step</button>' : ''}
          ${testRunId ? '<button class="secondary" type="submit" name="action" value="test">Test draft</button>' : ''}
          <button type="submit" name="action" value="save">${snapshot ? 'Save new version' : 'Create workflow'}</button>
        </div>
        ${testRunId ? '<p class="agent-feedback" role="status" data-workflow-test-result></p>' : ''}
      </fieldset>
    </form>${recentTests}`;
  return configurationPage(project, 'workflows', title, body);
}
