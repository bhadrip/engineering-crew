import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { CrewError, id, parseReviewFindings, requireField, resourceTarget, text } from './contracts.mjs';
import { validateWorkflowOutputFormat } from './workflow-artifacts.mjs';

export const workflowSubmissionTools = Object.freeze({
  submit_workflow_output: { title: 'Submit workflow output',
    description: 'Save content for a named workflow output in this attempt. Calling again for a slot replaces its previous submission.' },
  report_workflow_blocker: { title: 'Report workflow blocker',
    description: 'Record why this assignment cannot finish. Include an action and target together if an external resource is needed.' },
});
export const workspaceCheckpointTool = 'checkpoint_workspace';
export const workspaceCheckpointDefinition = Object.freeze({ title: 'Save workspace checkpoint',
  description: 'Save the current assignment files in Crew for recovery. Use after related file edits have finished.' });
export const listGeneratedImagesTool = 'list_generated_images';
export const listGeneratedImagesDefinition = Object.freeze({ title: 'List generated images',
  description: 'List images already saved for this attempt. Use an artifactId from this list as the content of an image output.' });

function workflowOutput(slots, { slot, content }) {
  const definition = slots.find(output => output.id === slot);
  requireField(definition, 'Choose a declared workflow output slot.');
  text(content, 'output content');
  if (definition.kind === 'review-findings') parseReviewFindings(content);
  validateWorkflowOutputFormat(definition, content);
  return { slot, content };
}

function workflowBlocker({ reason, action, target }) {
  text(reason, 'workflow blocker reason', 500);
  requireField((action === undefined) === (target === undefined), 'Provide both a resource action and a target, or omit both.');
  const resource = action === undefined ? undefined : {
    action: id(action, 'resource action'), target: resourceTarget(target), reason,
  };
  return { reason, ...(resource && { resource }) };
}

async function submissionBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    requireField(size <= 130_000, 'The workflow submission is too large.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new CrewError('Invalid workflow submission.'); }
}

// The MCP server has an attempt-specific capability. Only the Crew worker can
// commit a submission, and it does so before the tool acknowledges it.
export async function openWorkflowSubmissionBridge({ slots, persist, checkpoint, listImages, signal }) {
  const token = randomBytes(32).toString('hex');
  const outputs = new Map();
  let blocker, ended = false;
  let pending = Promise.resolve();
  const reply = (response, status, value) => {
    if (!response.destroyed) response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      .end(JSON.stringify(value));
  };
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/submission' || request.headers.authorization !== 'Bearer ' + token) {
      request.resume();
      return reply(response, 404, { error: 'Workflow submission is unavailable.' });
    }
    try {
      const body = await submissionBody(request);
      requireField(body?.args && typeof body.args === 'object', 'Invalid workflow submission.');
      requireField(!ended && !signal?.aborted, 'This assignment has ended.');
      if (body.kind === 'images' && listImages && !Object.keys(body.args).length)
        return reply(response, 200, await listImages());
      const entry = body.kind === 'output' && slots ? { output: workflowOutput(slots, body.args) }
        : body.kind === 'blocker' && slots ? { blocker: workflowBlocker(body.args) }
          : body.kind === 'workspace' && checkpoint && Object.keys(body.args).every(key => key === 'note')
            ? { note: text(body.args.note, 'checkpoint note', 500).trim() } : null;
      requireField(entry, 'Invalid workflow submission.');
      const saved = pending.then(async () => {
        signal?.throwIfAborted();
        if (entry.note) return checkpoint(entry.note);
        const output = await persist?.(entry);
        if (entry.output) {
          outputs.set(entry.output.slot, output ?? entry.output);
          return { slot: entry.output.slot, saved: true };
        }
        blocker = entry.blocker;
        return { recorded: true };
      });
      pending = saved.catch(() => {});
      return reply(response, 200, await saved);
    } catch (error) {
      return reply(response, 400, { error: error instanceof CrewError ? error.message : 'Crew could not save this workflow submission.' });
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  async function submissions() {
    await pending;
    return slots && { outputs: slots.flatMap(({ id }) => outputs.has(id) ? [outputs.get(id)] : []), ...(blocker && { blocker }) };
  }
  return {
    connection: { url: 'http://127.0.0.1:' + server.address().port + '/submission', token,
      ...(slots && { slots: slots.map(slot => slot.id) }), ...(checkpoint && { workspace: true }),
      ...(listImages && { imageOutputs: true }) },
    submissions,
    finish() {
      ended = true;
      return submissions();
    },
    async close() {
      ended = true;
      const stopped = new Promise(resolve => server.close(resolve));
      server.closeAllConnections();
      await Promise.all([stopped, pending]);
    },
  };
}

export async function sendWorkflowSubmission({ url, token }, kind, args) {
  const response = await fetch(url, { method: 'POST', redirect: 'error',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind, args }) });
  const value = await response.json();
  if (!response.ok) throw new CrewError(value.error);
  return value;
}
