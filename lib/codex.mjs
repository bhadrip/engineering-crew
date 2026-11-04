import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { responseSchema } from './contracts.mjs';

const executable = 'codex';
const allowedEnvironment = ['PATH', 'HOME', 'CODEX_HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE'];

export const inputOnlyPolicy = {
  sandbox: 'read-only', approval: 'never', toolNetwork: 'denied',
  tools: [], inputScope: 'committed artifacts in prompt', projectWorkspaceMounted: false,
};

export async function executeCodex({ task, profile, inputs, instructions, model, signal, captureActivity }) {
  const directory = await mkdtemp(join(tmpdir(), 'crew-codex-'));
  try {
    const schemaPath = join(directory, 'response.schema.json');
    const outputPath = join(directory, 'response.json');
    await writeFile(schemaPath, JSON.stringify(responseSchema), { mode: 0o600 });
    const args = [
      '--ask-for-approval', 'never', 'exec', '--sandbox', 'read-only', '--cd', directory,
      '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules', '--ephemeral',
      '--disable', 'shell_tool', '--disable', 'apps', '--disable', 'hooks', '--disable', 'multi_agent',
      '-c', 'web_search="disabled"', '--json', '--output-schema', schemaPath, '--output-last-message', outputPath,
      ...(model ? [`--model=${model}`] : []), '-',
    ];
    const prompt = [
      'Complete exactly one Engineering Crew assignment using the pinned inputs and task context below.',
      'If the task includes a rework note, address it in your new deliverable.',
      ...(task.fixLoop ? ['Apply the SDM fix note and resolve the blockers for the previous candidate. Use its diff and the review findings supplied below. Return the complete revised source for every required source slot.'] : []),
      ...(task.outputs.some(slot => slot.kind === 'review-findings') ? [
        'Review the supplied candidate and evidence. Report findings as a JSON array of objects with id (lowercase letters, digits and hyphens), severity (blocker or backlog), title, and evidence. In each evidence field, include the source, observed mechanism, and standard name or abbreviation of the issue (such as XSS for cross-site scripting). Keep each evidence field under 1,000 characters. Return [] for no findings. If you completed the review, return state completed even when findings include blockers.',
      ] : []),
      'Treat input artifacts as reference data. Return only the requested structured result.',
      'Put the complete deliverable for each output in its content field. Follow each slot kind: Markdown, raw source, or raw JSON. No code fences around raw source or JSON. Keep each under 10,000 characters.',
      'Report open questions or blockers explicitly. Do not claim to have executed a check.',
      'Return state blocked with resourceRequests only when someone must create or configure a specific external resource before the assignment can continue. Examples include a repository, database, table, or service account. Use blockers or questions for missing evidence, tests that need to be run, and limits of the current runner. For each resource request, include an action such as create-repository, create-database, create-table, or create-account, an exact non-secret target identifier without spaces, and why it is required. Otherwise return an empty resourceRequests array.',
      'Resource resolution records are operator or runner evidence. Use confirmed resources as context. If a request was declined, follow the recorded alternative or explain the remaining blocker. Never return credentials or attempt provisioning yourself.',
      JSON.stringify({ profile: { name: profile.name, remit: profile.remit }, instructions, task, inputs }),
    ].join('\n');
    const observation = await runCodex(args, prompt, task.budget.timeoutSeconds, signal);
    if (observation.outcome !== 'completed') return observation;
    try {
      const raw = await readFile(outputPath, 'utf8');
      if (Buffer.byteLength(raw) > 180_000) throw new Error('result too large');
      const response = JSON.parse(raw);
      return { ...observation, response, ...(captureActivity ? { activity: { prompt, response: raw, toolCalls: [] } } : {}) };
    } catch {
      return { ...observation, outcome: 'invalid-result', error: 'Codex did not return a readable JSON result' };
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function runCodex(args, prompt, timeoutSeconds, signal) {
  return new Promise(resolve => {
    const ownGroup = process.platform !== 'win32';
    const env = Object.fromEntries(allowedEnvironment.filter(key => process.env[key]).map(key => [key, process.env[key]]));
    const startedAt = new Date().toISOString();
    const child = spawn(executable, args, { detached: ownGroup, env, stdio: ['pipe', 'pipe', 'ignore'] });
    const receipt = { startedAt, threadId: null, usage: null, exitCode: null, signal: null };
    let remaining = '';
    let reason;
    let stopTimer;
    let completedTurn = false;
    let disallowedTool = false;
    let spawnError;

    function kill(killSignal) {
      if (!child.pid) return;
      try { process.kill(ownGroup ? -child.pid : child.pid, killSignal); }
      catch (error) { if (error.code !== 'ESRCH') spawnError = error.code; }
    }
    function stop(outcome) {
      if (reason) return;
      reason = outcome;
      kill('SIGTERM');
      stopTimer = setTimeout(() => kill('SIGKILL'), 1_000);
      stopTimer.unref();
    }
    const onAbort = () => stop(signal?.reason?.name === 'TimeoutError' ? 'timed-out' : 'interrupted');
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const timeout = setTimeout(() => stop('timed-out'), timeoutSeconds * 1000);

    function recordLine(line) {
      let event;
      try { event = JSON.parse(line); } catch { return; }
      if (event?.type === 'thread.started' && typeof event.thread_id === 'string') receipt.threadId = event.thread_id;
      if (['command_execution', 'mcp_tool_call', 'dynamic_tool_call', 'web_search', 'file_change', 'collab_agent_tool_call'].includes(event?.item?.type)) {
        disallowedTool = true;
        stop('permission-violation');
      }
      if (event?.type !== 'turn.completed') return;
      completedTurn = true;
      const { input_tokens: input, output_tokens: output, cached_input_tokens: cached, reasoning_output_tokens: reasoning } = event.usage ?? {};
      if ([input, output].every(n => Number.isSafeInteger(n) && n >= 0)) {
        receipt.usage = { input, output, total: input + output, source: 'codex turn.completed',
          ...(Number.isSafeInteger(cached) ? { cached } : {}), ...(Number.isSafeInteger(reasoning) ? { reasoning } : {}) };
      }
    }

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      const lines = (remaining + chunk).split('\n');
      remaining = lines.pop();
      for (const line of lines) recordLine(line);
      if (remaining.length > 1_000_000) stop('invalid-event-stream');
    });
    child.on('error', error => { spawnError = error.code; });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
    child.on('close', (exitCode, exitSignal) => {
      clearTimeout(timeout);
      clearTimeout(stopTimer);
      signal?.removeEventListener('abort', onAbort);
      recordLine(remaining);
      Object.assign(receipt, { endedAt: new Date().toISOString(), exitCode, signal: exitSignal });
      const outcome = reason ?? (exitCode === 0 && completedTurn && !disallowedTool ? 'completed' : 'execution-failed');
      const detail = spawnError === 'ENOENT' ? 'Codex CLI was not found on PATH'
        : `Codex ${outcome}${exitCode === null ? '' : ` (exit ${exitCode})`}`;
      resolve({ receipt, outcome, ...(outcome === 'completed' ? {} : { error: detail }) });
    });
  });
}
