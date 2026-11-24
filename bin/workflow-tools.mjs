import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { musicBrowserTool, musicPracticeTool, workflowAgentTools } from '../lib/workflow-agent-tools.mjs';
import { musicBrowserActions, musicBrowserKeys, musicBrowserRoles } from '../lib/workflow-music-browser.mjs';
import { listGeneratedImagesDefinition, listGeneratedImagesTool, sendWorkflowSubmission, workflowSubmissionTools,
  workspaceCheckpointDefinition, workspaceCheckpointTool } from '../lib/workflow-submissions.mjs';

const { inputs, skills, enabled, practiceConnection, browserConnection, submissions } = JSON.parse(await readFile(process.argv[2], 'utf8'));
const string = { type: 'string' };
const offsetSchema = { type: 'integer', minimum: 0 };
const schema = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const validOffset = (offset, length) => Number.isSafeInteger(offset) && offset >= 0 && offset <= length;
const nextOffset = (end, length) => end < length ? end : null;
const tools = {
  ...(submissions?.slots && {
    submit_workflow_output: { inputSchema: schema({ slot: { type: 'string', enum: submissions.slots },
      content: { type: 'string', minLength: 1, maxLength: 20_000 } }), run: args => sendWorkflowSubmission(submissions, 'output', args) },
    report_workflow_blocker: { inputSchema: schema({ reason: { type: 'string', maxLength: 500 }, action: string, target: string }, ['reason']),
      run: args => sendWorkflowSubmission(submissions, 'blocker', args) },
  }),
  ...(submissions?.workspace && { [workspaceCheckpointTool]: {
    inputSchema: schema({ note: { type: 'string', minLength: 1, maxLength: 500 } }),
    run: args => sendWorkflowSubmission(submissions, 'workspace', args),
  } }),
  ...(submissions?.imageOutputs && { [listGeneratedImagesTool]: {
    inputSchema: schema({}), run: args => sendWorkflowSubmission(submissions, 'images', args),
  } }),
  [musicBrowserTool]: {
    inputSchema: schema({ action: { type: 'string', enum: musicBrowserActions }, path: { type: 'string', maxLength: 800 },
      role: { type: 'string', enum: musicBrowserRoles }, name: { type: 'string', maxLength: 250 },
      occurrence: { type: 'integer', minimum: 1, maximum: 100, description: 'One-based index when the same name occurs more than once.' },
      state: { type: 'string', enum: ['visible', 'hidden'], description: 'State to wait for.' },
      timeoutSeconds: { type: 'integer', minimum: 1, maximum: 45 },
      value: { type: 'string', maxLength: 1_000 }, key: { type: 'string', enum: musicBrowserKeys },
      width: { type: 'integer', minimum: 320, maximum: 1920 }, height: { type: 'integer', minimum: 300, maximum: 1200 },
      media: { type: 'string', enum: ['audio', 'video'], description: 'Media element for observe_media. Defaults to audio. Use name to match its label.' },
      durationMs: { type: 'integer', minimum: 300, maximum: 15_000, description: 'How long observe_media samples the media clock. Defaults to 4,000 ms.' },
      click: { ...schema({ role: { type: 'string', enum: musicBrowserRoles }, name: { type: 'string', maxLength: 250 },
        occurrence: { type: 'integer', minimum: 1, maximum: 100 } }, ['role', 'name']),
      description: 'Optional observe_media trigger. Record the media, click this accessible control, then sample immediately.' },
    }, ['action']),
    async run(args) {
      if (!browserConnection) throw new Error('The workspace browser is unavailable.');
      const response = await fetch(browserConnection.url, { method: 'POST', redirect: 'error',
        headers: { Authorization: 'Bearer ' + browserConnection.token, 'Content-Type': 'application/json' },
        body: JSON.stringify(args) });
      const report = await response.json();
      if (!response.ok) throw new Error(report.error || 'The browser action could not run.');
      return report;
    },
  },
  [musicPracticeTool]: { inputSchema: schema({}), async run(args) {
    if (Object.keys(args).length) throw new Error('Use the development check without arguments.');
    if (!practiceConnection) throw new Error('Development check is unavailable for this assignment.');
    const response = await fetch(practiceConnection.url, { method: 'POST', redirect: 'error',
      headers: { Authorization: 'Bearer ' + practiceConnection.token } });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || 'The development check could not run.');
    return value;
  } },
  list_inputs: { inputSchema: schema({}), run: () => inputs.map(({ id, title, kind, content }) =>
    ({ id, title, kind, characters: content.length })) },
  read_input: { inputSchema: schema({ id: string, offset: offsetSchema }, ['id']), run({ id, offset = 0 }) {
    const input = inputs.find(value => value.id === id);
    if (!input || !validOffset(offset, input.content.length)) throw new Error('Unknown input or invalid offset.');
    const end = Math.min(offset + 12_000, input.content.length);
    return { id, offset, nextOffset: nextOffset(end, input.content.length), text: input.content.slice(offset, end) };
  } },
  search_inputs: { inputSchema: schema({ query: string }), run({ query }) {
    if (typeof query !== 'string' || !query.trim() || query.length > 160) throw new Error('Enter a short search query.');
    const needle = query.toLowerCase();
    const matches = [];
    for (const input of inputs) {
      const lines = input.content.split(/\r?\n/);
      for (const [index, line] of lines.entries()) {
        const found = line.toLowerCase().indexOf(needle);
        if (found === -1) continue;
        matches.push({ id: input.id, line: index + 1, text: line.slice(Math.max(0, found - 100), found + 180) });
        if (matches.length >= 24) return matches;
      }
    }
    return matches;
  } },
  read_skill: { inputSchema: schema({ id: string }), run({ id }) {
    const skill = skills.find(value => value.id === id);
    if (!skill) throw new Error('This skill is unavailable.');
    return { name: skill.name, instructions: skill.content, ...(skill.bundle && { files: skill.bundle.files.map(file => file.path) }) };
  } },
  read_skill_file: { inputSchema: schema({ id: string, path: string, offset: offsetSchema }, ['id', 'path']), run({ id, path, offset = 0 }) {
    const file = skills.find(value => value.id === id)?.bundle?.files.find(value => value.path === path);
    if (!file) throw new Error('This skill file is unavailable.');
    const bytes = Buffer.from(file.data, 'base64');
    let text;
    try {
      const decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      if (!decoded.includes('\0')) text = decoded;
    } catch {}
    const length = text?.length ?? bytes.length;
    if (!validOffset(offset, length)) throw new Error('Invalid skill file offset.');
    const end = Math.min(offset + (text === undefined ? 9_000 : 12_000), length);
    return { id, path, offset, nextOffset: nextOffset(end, length),
      ...(text === undefined ? { encoding: 'base64', data: bytes.subarray(offset, end).toString('base64') } :
        { encoding: 'text', text: text.slice(offset, end) }) };
  } },
};
const available = enabled.map(name => {
  const submission = name === workspaceCheckpointTool ? workspaceCheckpointDefinition : workflowSubmissionTools[name];
  return { name, inputSchema: tools[name].inputSchema,
    annotations: submission || name === musicBrowserTool ? { readOnlyHint: false, destructiveHint: false,
      idempotentHint: name !== musicBrowserTool, openWorldHint: false } : { readOnlyHint: true },
    description: (name === listGeneratedImagesTool ? listGeneratedImagesDefinition.description : submission?.description) ??
      workflowAgentTools[name]?.description ?? (name === 'read_skill_file' ?
      'Read a supporting file from an attached skill by skill ID and path.' : 'Read one of the named skills attached to this agent.') };
});

const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
const error = (id, code, message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
const content = value => [{ type: 'text', text: JSON.stringify(value) }];

for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  let request;
  try { request = JSON.parse(line); } catch { error(null, -32700, 'Invalid JSON'); continue; }
  if (!request || !Object.hasOwn(request, 'id')) continue;
  const { id, method, params } = request;
  if (method === 'initialize') {
    const supported = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'];
    reply(id, { protocolVersion: supported.includes(params?.protocolVersion) ? params.protocolVersion : supported.at(-1),
      capabilities: { tools: {} }, serverInfo: { name: 'Engineering Crew workflow tools', version: '1.0.0' } });
  } else if (method === 'ping') reply(id, {});
  else if (method === 'tools/list') reply(id, { tools: available });
  else if (method === 'tools/call') {
    if (!enabled.includes(params?.name)) { error(id, -32602, 'Tool is unavailable for this agent'); continue; }
    try {
      const result = await tools[params.name].run(params.arguments ?? {});
      if (params.name === musicBrowserTool) {
        const { screenshot, ...report } = result;
        reply(id, { content: [...content(report), ...(screenshot ? [{ type: 'image', ...screenshot }] : [])],
          ...(report.error && { isError: true }) });
      } else reply(id, { content: content(result) });
    }
    catch (failure) { reply(id, { content: content({ error: failure.message }), isError: true }); }
  } else error(id, -32601, 'Unknown method');
}
