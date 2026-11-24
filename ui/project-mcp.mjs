import { CrewError } from '../lib/contracts.mjs';
import { mcpApprovalModes, pinnedProjectMcp } from '../lib/project-mcp.mjs';
import { escape, layout, projectHeader, projectHref } from './views.mjs';

export function projectMcpHref(project, id, version) {
  const query = new URLSearchParams();
  if (id) query.set('connection', id);
  if (version) query.set('version', version);
  return projectHref(project) + '/tools' + (query.size ? '?' + query : '');
}

export function projectMcpOAuthHref(project, connection, attempt) {
  const query = new URLSearchParams({ connection: connection.id, version: connection.version });
  if (attempt) query.set('attempt', attempt);
  return projectHref(project) + '/tools/oauth?' + query;
}

function projectMcpCheckHref(project, connection) {
  const query = new URLSearchParams({ connection: connection.id, version: connection.version });
  return projectHref(project) + '/tools/check?' + query;
}

const link = (href, label, className = '') => `<a${className ? ' class="' + className + '"' : ''} href="${escape(href)}">${escape(label)}</a>`;
const transportLabel = transport => transport === 'stdio' ? 'Local process (stdio)' : 'Streamable HTTP';
const options = (selected, items) => items.map(([value, label]) =>
  '<option value="' + escape(value) + '"' + (value === selected ? ' selected' : '') + '>' + escape(label) + '</option>').join('');
const select = (name, label, value, items) =>
  `<label class="agent-field">${escape(label)}<select name="${name}">${options(value, items)}</select></label>`;
const field = (name, label, value, { rows, maxlength, required, readOnly, hint } = {}) => {
  const limit = maxlength ? ' maxlength="' + maxlength + '"' : '';
  return `<label class="agent-field">${escape(label)}
    ${rows ? `<textarea name="${name}" rows="${rows}"${limit}>
${escape(value)}</textarea>` :
    `<input name="${name}" value="${escape(value)}"${limit}${required ? ' required' : ''}${readOnly ? ' readonly' : ''}>`}
    ${hint ? '<small>' + escape(hint) + '</small>' : ''}</label>`;
};

export function projectMcpFields(project, connections, selected) {
  return `<fieldset class="agent-fieldset"><legend>Project MCP connections</legend>
    ${connections.length ? '<p class="agent-field-hint">Choose a connection version for this agent.</p>' : ''}
    ${connections.map(({ id, version, versions, definition }) => {
      const pinned = selected.find(ref => ref.id === id)?.version;
      const choices = [['', 'Detached'], ...versions.map(value => [id + ':' + value,
        'Version ' + value + (value === version ? ' · latest' : value === pinned ? ' · attached' : '')])];
      return select('project-mcp', definition.name, pinned ? id + ':' + pinned : '', choices);
    }).join('')}
    <p class="agent-field-hint">${link(projectMcpHref(project), 'Manage project connections')}</p></fieldset>`;
}

function connectionValues(connection) {
  const { name, transport, settings } = connection?.definition ?? { transport: 'stdio', settings: {} };
  return { id: connection?.id, name, transport, oauth: connection?.definition.oauth,
    command: settings.command, args: settings.args?.length ? JSON.stringify(settings.args) : '',
    cwd: settings.cwd, env: settings.env_vars?.join('\n'), url: settings.url, bearer: settings.bearer_token_env_var,
    headers: Object.entries(settings.env_http_headers ?? {}).map(([key, value]) => key + '=' + value).join('\n'),
    scopes: settings.scopes?.join('\n'), approval: settings.default_tools_approval_mode ?? 'auto', required: settings.required ?? true,
    allow: settings.enabled_tools?.join('\n'), deny: settings.disabled_tools?.join('\n'),
    toolPolicies: Object.entries(settings.tools ?? {}).map(([key, value]) => key + '=' + value.approval_mode).join('\n'),
    startup: settings.startup_timeout_sec, toolTimeout: settings.tool_timeout_sec };
}

function toolDiscovery(project, connection, check) {
  const messages = {
    'worker-unavailable': 'Could not read the Codex worker’s MCP configuration.',
    'name-conflict': 'This connection’s OAuth name is already configured on the Codex worker.',
    'sign-in-required': 'Codex reports that this connection requires sign-in.',
    'discovery-failed': 'Codex could not list tools. Check the executable or endpoint, credentials, and startup settings.',
  };
  const tools = check?.tools ?? [];
  const message = check?.state === 'checked' ?
    `Codex found ${tools.length} ${tools.length === 1 ? 'tool' : 'tools'} available under the saved policy.` : messages[check?.state];
  return `<section class="record-section" data-mcp-discovery aria-labelledby="tool-discovery-heading">
    <h2 id="tool-discovery-heading">Tool discovery</h2>
    <p role="status">${escape(message)}</p>
    <div data-mcp-discovery-results>
      ${tools.length ? `<ul class="links">${tools.map(({ name, approval }) =>
        `<li><code>${escape(name)}</code> · ${escape(mcpApprovalModes[approval] ?? mcpApprovalModes.auto)}</li>`).join('')}</ul>` : ''}
      ${check?.missingEnv?.length ? `<p>Missing worker environment variables ${check.missingEnv.map(name => `<code>${escape(name)}</code>`).join(', ')}.</p>` : ''}
      ${check?.server ? `<p class="muted">Checked as <code>${escape(check.server)}</code></p>` : ''}
    </div>
    <p class="agent-field-hint">Codex starts connection v${escape(connection.version)} and lists its tools.</p>
    <form method="post" action="${escape(projectMcpCheckHref(project, connection))}">
      <button type="submit" class="secondary">Check tools on worker</button></form>
  </section>`;
}

export function projectMcpPage(project, { connections = [], connection, versions = [], adding, draft, error, saved, oauthStatus, check } = {}) {
  const route = projectMcpHref(project);
  const editing = connection || adding;
  const title = connection ? connection.definition.name : adding ? 'Add MCP connection' : 'Project tools';
  const page = (body, action = '') => layout(title + ' · ' + project.name, projectHeader(project, 'tools') +
    `<main class="feature-page configuration-page"><div class="agent-page-heading"><h1>${escape(title)}</h1>${action}</div>${body}</main>`);
  if (!editing) {
    const rows = connections.map(({ id, version, definition: { name, transport } }) =>
      `<li>${link(projectMcpHref(project, id), name)}<small>${escape(transportLabel(transport))} · Version ${version}</small></li>`).join('');
    return page(`<p class="intro">Manage MCP connections owned by this project. Attach a saved connection to an agent in Agents.</p>
      ${rows ? '<ul class="index-list">' + rows + '</ul>' : '<p class="empty-state">This project has no MCP connections yet.</p>'}`,
    link(route + '?new=1', 'Add MCP connection', 'agent-add'));
  }
  const values = draft ?? connectionValues(connection);
  const href = connection ? projectMcpHref(project, connection.id) : route + '?new=1';
  const historical = connection && versions[0] > connection.version;
  const history = versions.length > 1 ? `<details class="agent-skill-files"><summary>Connection versions</summary><ul>
    ${versions.map(version => '<li>' + (version === connection.version ? '<strong>Version ' + version + '</strong>' :
      link(projectMcpHref(project, connection.id, version === versions[0] ? undefined : version), 'Version ' + version)) +
      (version === versions[0] ? ' · latest' : '') + '</li>').join('')}</ul></details>` : '';
  const multi = { rows: 2, maxlength: 4000, hint: 'One per line.' };
  const oauth = connection?.definition.oauth ? `<section class="record-section configuration-oauth" aria-labelledby="oauth-heading">
    <h2 id="oauth-heading">OAuth sign-in</h2>
    <p>${oauthStatus === 'o_auth' ? 'Signed in on this Codex worker.' : oauthStatus === 'not_logged_in' ?
      'Sign in on this Codex worker before the agent uses this connection.' : 'Codex will check authorization with the configured provider.'}</p>
    <form method="post" action="${escape(projectMcpOAuthHref(project, connection))}">
      <button type="submit">${oauthStatus === 'o_auth' ? 'Reconnect OAuth' : 'Connect with OAuth'}</button>
    </form></section>` : '';
  return page(`${error ? '<p class="agent-feedback" role="alert">' + escape(error) + '</p>' : ''}
    ${saved ? '<p class="agent-feedback" role="status">MCP connection saved.</p>' : ''}
    ${connection ? '<p class="muted">Version ' + connection.version + (historical ? ' · read-only' : '') + '</p>' +
      '<p class="agent-field-hint">Codex server name <code>' + escape(pinnedProjectMcp(project.id, connection).server) + '</code></p>' : ''}
    ${history}
    ${oauth}
    ${connection && project.id === 'music-transcribe' ? toolDiscovery(project, connection, check) : ''}
    <form class="configuration-form" method="post" action="${escape(href)}" data-project-mcp-editor>
      <input type="hidden" name="version" value="${escape(draft?.expectedVersion ?? connection?.version ?? 0)}">
      <fieldset class="configuration-card"${historical ? ' disabled' : ''}>
        <div class="agent-model-fields">
          ${field('name', 'Display name', values.name, { required: true, maxlength: 100 })}
          ${field('id', 'Connection ID', values.id, { required: true, readOnly: Boolean(connection), maxlength: 40,
            hint: 'Lowercase letters, numbers, and hyphens. Start with a letter.' })}
        </div>
        ${select('transport', 'Transport', values.transport, Object.entries({ stdio: transportLabel('stdio'), http: transportLabel('http') }))}
        <fieldset class="agent-fieldset" data-mcp-transport="stdio"><legend>Local process</legend>
          ${field('command', 'Executable', values.command, { maxlength: 600, hint: 'Runs on the Codex worker when this connection is used.' })}
          ${field('args', 'Arguments', values.args, { rows: 2, maxlength: 12000, hint: 'JSON array of strings, for example ["--mode", "read"].' })}
          ${field('cwd', 'Working directory', values.cwd, { maxlength: 1500 })}
          ${field('env', 'Worker environment variables', values.env, multi)}
        </fieldset>
        <fieldset class="agent-fieldset" data-mcp-transport="http"><legend>Streamable HTTP</legend>
          ${field('url', 'Endpoint URL', values.url, { maxlength: 2000 })}
          <label class="configuration-sharing"><input type="checkbox" name="oauth" value="1"${values.oauth ? ' checked' : ''}> Sign in with OAuth</label>
          ${field('bearer', 'Bearer token variable', values.bearer, { maxlength: 128, hint: 'Enter the name of a worker environment variable.' })}
          ${field('headers', 'Headers from environment variables', values.headers, { ...multi, hint: 'One Header=ENVIRONMENT_VARIABLE pair per line.' })}
          ${field('scopes', 'OAuth scopes', values.scopes, multi)}
        </fieldset>
        ${select('approval', 'Default tool approval', values.approval, Object.entries(mcpApprovalModes))}
        <details class="agent-skill-files"><summary>Tool policy and timeouts</summary>
          <div class="agent-model-fields">
            ${field('allow', 'Allowed tools', values.allow, { ...multi, hint: 'One per line. Empty allows tools according to Codex policy.' })}
            ${field('deny', 'Disabled tools', values.deny, multi)}
          </div>
          ${field('tool-policies', 'Per-tool approvals', values.toolPolicies, { ...multi, hint: 'One tool=auto, tool=prompt, tool=writes, or tool=approve pair per line.' })}
          <div class="agent-model-fields">
            ${field('startup', 'Startup timeout (seconds)', values.startup, { maxlength: 20 })}
            ${field('tool-timeout', 'Tool timeout (seconds)', values.toolTimeout, { maxlength: 20 })}
          </div>
          <label class="configuration-sharing"><input name="required" type="checkbox" value="1"${values.required ? ' checked' : ''}> Require this connection at startup</label>
        </details>
      </fieldset>
      <div class="agent-edit-actions">${historical ? link(href, 'Edit latest version') :
      '<button type="submit">' + (connection ? 'Save connection version' : 'Create connection') + '</button>'}
        ${link(route, 'Back to project tools')}</div></form>`);
}

export function projectMcpOAuthView(attempt) {
  const message = {
    starting: 'Codex is contacting the authorization provider.',
    waiting: 'Complete sign-in in the provider tab. Crew will show the result here.',
    connected: 'Codex saved the authorization on this worker.',
    expired: 'The sign-in expired. Start a new sign-in from the connection page.',
    cancelled: 'Sign-in was cancelled.',
    failed: attempt.message,
  }[attempt.state];
  return { state: attempt.state, message, authorizationUrl: attempt.authorizationUrl };
}

export function projectMcpOAuthPage(project, connection, attempt) {
  const target = projectMcpHref(project, connection.id, connection.version);
  const pending = ['starting', 'waiting'].includes(attempt.state);
  const action = projectMcpOAuthHref(project, connection, attempt.id);
  const view = projectMcpOAuthView(attempt);
  return layout('Connect ' + connection.definition.name + ' · ' + project.name, projectHeader(project, 'tools') +
    `<main class="feature-page configuration-page"><div class="agent-page-heading"><h1>Connect ${escape(connection.definition.name)}</h1></div>
      <p class="muted">Connection version ${escape(connection.version)}</p>
      <section class="record-section configuration-oauth"${pending ? ' data-oauth-status="' + escape(action + '&status=1') + '"' : ''}>
        <p role="status">${escape(view.message)}</p>
        ${pending ? `<p data-oauth-provider${attempt.state === 'waiting' ? '' : ' hidden'}>
          <a${attempt.authorizationUrl ? ' href="' + escape(attempt.authorizationUrl) + '"' : ''} target="_blank" rel="noopener noreferrer">Open authorization provider</a></p>` : ''}
        <div class="agent-edit-actions">${pending ? `<form method="post" action="${escape(action)}" data-oauth-cancel>
          <button type="submit" class="secondary" name="action" value="cancel">Cancel sign-in</button></form>` : ''}
          ${link(target, 'Back to connection')}</div>
        ${pending ? '<noscript><p>' + link(action, 'Check sign-in status') + '</p></noscript>' : ''}</section></main>`);
}

const lineList = value => value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
const assignments = value => lineList(value).map(line => {
  const equals = line.indexOf('=');
  return equals < 0 ? [line, ''] : [line.slice(0, equals).trim(), line.slice(equals + 1).trim()];
});

export function readProjectMcpDraft(form) {
  const field = name => form.get(name) ?? '';
  return { id: field('id').trim(), name: field('name'), transport: field('transport'), command: field('command'),
    args: field('args'), cwd: field('cwd'), env: field('env'), url: field('url').trim(), bearer: field('bearer').trim(),
    headers: field('headers'), scopes: field('scopes'), oauth: field('oauth') === '1', approval: field('approval'), required: field('required') === '1',
    allow: field('allow'), deny: field('deny'), toolPolicies: field('tool-policies'),
    startup: field('startup').trim(), toolTimeout: field('tool-timeout').trim() };
}

export function projectMcpInput(draft) {
  let args = [];
  if (draft.transport === 'stdio' && draft.args.trim()) {
    try { args = JSON.parse(draft.args); }
    catch { throw new CrewError('Enter arguments as a JSON array of strings.', 2); }
  }
  return { ...draft, args, env: lineList(draft.env), scopes: lineList(draft.scopes), headers: assignments(draft.headers),
    allow: lineList(draft.allow), deny: lineList(draft.deny), toolPolicies: assignments(draft.toolPolicies) };
}
