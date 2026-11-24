import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { CrewError, requireField } from './contracts.mjs';
import { transaction } from './database.mjs';

const connectionId = /^[a-z][a-z0-9-]{0,39}$/;
const envName = /^[A-Za-z_][A-Za-z0-9_]*$/;
const headerName = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const versionLimit = 10_000;
export const mcpApprovalModes = Object.freeze({
  auto: 'Codex default', prompt: 'Ask for every call', writes: 'Ask for writes', approve: 'Allow calls',
});

export const validConnectionId = id => typeof id === 'string' && connectionId.test(id);
const validVersion = version => Number.isSafeInteger(version) && version >= 1 && version <= versionLimit;
const bad = message => { throw new CrewError(message, 2); };
const singleLine = (value, max) => typeof value === 'string' && value.isWellFormed() && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);

function checkedList(input, label, validate = value => singleLine(value, 128) && value.length > 0) {
  if (!Array.isArray(input) || !input.every(validate) || new Set(input).size !== input.length)
    bad('Enter distinct ' + label + '.');
  return input;
}

export function parseProjectMcpRefs(values) {
  const refs = values.filter(Boolean).map(value => {
    const [id, version, ...extra] = value.split(':');
    if (extra.length || !validConnectionId(id) || !/^[1-9]\d*$/.test(version ?? '') || !validVersion(Number(version)))
      bad('Choose a saved project MCP connection version.');
    return { id, version: Number(version) };
  });
  if (new Set(refs.map(ref => ref.id)).size !== refs.length) bad('Choose one version per project MCP connection.');
  return refs.sort((a, b) => a.id.localeCompare(b.id));
}

function transportSettings(draft) {
  if (draft.transport === 'stdio') {
    if (!singleLine(draft.command, 600) || !draft.command.trim()) bad('Enter the executable for the local MCP server.');
    if (!singleLine(draft.cwd, 1500)) bad('Enter a working directory on one line.');
    if (!Array.isArray(draft.args) || draft.args.some(value => typeof value !== 'string' || !value.isWellFormed() ||
        value.length > 4000 || value.includes('\0'))) bad('Enter arguments as a JSON array of strings.');
    return { command: draft.command.trim(), args: draft.args, ...(draft.cwd.trim() && { cwd: draft.cwd.trim() }),
      env_vars: checkedList(draft.env, 'environment variable names', value => typeof value === 'string' && envName.test(value)) };
  }
  if (draft.transport !== 'http') bad('Choose a transport for the MCP connection.');
  const endpoint = singleLine(draft.url, 2000) && URL.canParse(draft.url) ? new URL(draft.url) : null;
  if (!endpoint || !['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash)
    bad('Enter an HTTP or HTTPS MCP endpoint URL. Use environment variables for credentials.');
  if (draft.bearer && !envName.test(draft.bearer)) bad('Enter a bearer token environment variable name.');
  const headerKeys = new Set();
  for (const [name, variable] of draft.headers) {
    if (!headerName.test(name) || !envName.test(variable) || headerKeys.has(name.toLowerCase()))
      bad('Enter distinct HTTP headers in the form Header=ENVIRONMENT_VARIABLE.');
    headerKeys.add(name.toLowerCase());
  }
  if (draft.bearer && headerKeys.has('authorization')) bad('Choose one source for the Authorization header.');
  if (draft.oauth && (draft.bearer || headerKeys.has('authorization')))
    bad('Choose either OAuth or a worker environment variable for authorization.');
  return { url: endpoint.href, ...(draft.bearer && { bearer_token_env_var: draft.bearer }),
    ...(draft.headers.length && { env_http_headers: Object.fromEntries(draft.headers) }),
    ...(draft.scopes.length && { scopes: checkedList(draft.scopes, 'OAuth scopes') }) };
}

function timeout(seconds, key, label) {
  if (seconds === '') return {};
  if (!/^\d+(?:\.\d+)?$/.test(seconds) || Number(seconds) <= 0 || Number(seconds) > 86_400)
    bad('Enter ' + label + ' in seconds, from greater than zero to 86,400.');
  return { [key]: Number(seconds) };
}

function connectionDefinition(draft) {
  if (!singleLine(draft.name, 100) || !draft.name.trim()) bad('Enter a connection name of up to 100 characters.');
  if (!Object.hasOwn(mcpApprovalModes, draft.approval)) bad('Choose a Codex tool approval mode.');
  const allow = checkedList(draft.allow, 'allowed tool names');
  const deny = checkedList(draft.deny, 'disabled tool names');
  const toolPolicies = draft.toolPolicies.map(([name, approval]) => {
    if (!singleLine(name, 128) || !name || !Object.hasOwn(mcpApprovalModes, approval))
      bad('Enter per-tool approvals in the form tool=auto, tool=prompt, tool=writes, or tool=approve.');
    return [name, { approval_mode: approval }];
  });
  if (new Set(toolPolicies.map(([name]) => name)).size !== toolPolicies.length) bad('Enter each per-tool approval once.');
  return { name: draft.name.trim(), transport: draft.transport, ...(draft.transport === 'http' && draft.oauth && { oauth: true }), settings: {
    ...transportSettings(draft), ...(allow.length && { enabled_tools: allow }), ...(deny.length && { disabled_tools: deny }),
    default_tools_approval_mode: draft.approval, required: draft.required,
    ...timeout(draft.startup, 'startup_timeout_sec', 'a startup timeout'), ...timeout(draft.toolTimeout, 'tool_timeout_sec', 'a tool timeout'),
    ...(toolPolicies.length && { tools: Object.fromEntries(toolPolicies) }),
  } };
}

const columns = 'connection_id AS id, version, definition';

export async function listProjectMcp(db, projectId) {
  const { rows } = await db.query('SELECT DISTINCT ON (connection_id) ' + columns + ', array_agg(version) OVER (PARTITION BY connection_id) AS versions' +
    ' FROM engineering_crew.mcp_connection_versions WHERE project_id=$1 ORDER BY connection_id, version DESC', [projectId]);
  return rows.map(row => ({ ...row, versions: row.versions.sort((a, b) => b - a) }))
    .sort((a, b) => a.definition.name.localeCompare(b.definition.name));
}

export async function listProjectMcpVersions(db, projectId, id) {
  const { rows } = await db.query('SELECT version FROM engineering_crew.mcp_connection_versions' +
    ' WHERE project_id=$1 AND connection_id=$2 ORDER BY version DESC', [projectId, id]);
  return rows.map(row => row.version);
}

export async function loadProjectMcp(db, projectId, id, version) {
  requireField(validConnectionId(id) && (version === undefined || validVersion(version)), 'Invalid project MCP connection version.');
  const { rows: [connection] } = await db.query('SELECT ' + columns +
    ' FROM engineering_crew.mcp_connection_versions WHERE project_id=$1 AND connection_id=$2 AND ($3::int IS NULL OR version=$3)' +
    ' ORDER BY version DESC LIMIT 1', [projectId, id, version]);
  if (!connection) throw new CrewError('The MCP connection is unavailable in this project.', 4);
  return connection;
}

export async function saveProjectMcp(db, projectId, id, expectedVersion, draft) {
  if (!validConnectionId(id)) bad('Enter a connection ID using a lowercase letter followed by lowercase letters, numbers, or hyphens.');
  if (expectedVersion !== 0 && !validVersion(expectedVersion)) bad('Invalid connection version.');
  const definition = connectionDefinition(draft);
  return transaction(db, async client => {
    await client.query("SELECT pg_advisory_xact_lock(710923819, hashtext($1 || ':' || $2))", [projectId, id]);
    const { rows: [latest] } = await client.query('SELECT version, definition FROM engineering_crew.mcp_connection_versions' +
      ' WHERE project_id=$1 AND connection_id=$2 ORDER BY version DESC LIMIT 1', [projectId, id]);
    const current = latest?.version ?? 0;
    if (current !== expectedVersion) throw new CrewError(expectedVersion === 0 ? 'This connection ID already exists.' :
      'The connection changed. Reload the editor before saving.', 3);
    if (isDeepStrictEqual(latest?.definition, definition)) return { id, version: current, definition };
    if (current >= versionLimit) bad('This connection has reached its revision limit.');
    const version = current + 1;
    await client.query('INSERT INTO engineering_crew.mcp_connection_versions (project_id,connection_id,version,definition) VALUES ($1,$2,$3,$4)',
      [projectId, id, version, definition]);
    return { id, version, definition };
  });
}

export function pinnedProjectMcp(projectId, { id, version, definition }) {
  const scope = createHash('sha256').update(projectId).digest('hex').slice(0, 8);
  const alias = id.replaceAll('-', '_');
  const server = definition.oauth ? 'crew_oauth_' + createHash('sha256').update(JSON.stringify([
    projectId, id, definition.settings.url, [...(definition.settings.scopes ?? [])].sort(),
  ])).digest('hex').slice(0, 16) + '_' + alias.slice(0, 24) : 'crew_' + scope + '_' + alias;
  return { id, version, name: definition.name, server, settings: definition.settings, ...(definition.oauth && { oauth: true }) };
}

export const projectMcpIdentity = ({ id, version, name, server }) => ({ id, version, name, server });

export function resolveProjectMcpServers(connections, occupied, hookServers = new Set()) {
  return connections.map(connection => {
    let server = connection.server;
    if ((connection.oauth || hookServers.has(server)) && occupied.has(server))
      throw new Error((connection.oauth ? 'Project OAuth connection ' : 'MCP hook connection ') + connection.name +
        ' conflicts with an MCP server configured on this host.');
    while (occupied.has(server)) server += '_p';
    occupied.add(server);
    return { ...connection, server };
  });
}
