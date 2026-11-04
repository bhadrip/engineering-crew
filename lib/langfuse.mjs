import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { request } from 'node:http';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CrewError, id, requireField } from './contracts.mjs';

const projectPattern = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const threadPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const originPattern = /^http:\/\/(?:127\.0\.0\.1|\[::1\])(?::[1-9][0-9]{0,4})?\/?$/;

function loopback(value) {
  const url = typeof value === 'string' && originPattern.test(value) && URL.canParse(value) ? new URL(value) : null;
  requireField(url, 'CREW_LANGFUSE_URL must be an explicit HTTP loopback origin');
  return url.origin;
}

function within(root, location) {
  const path = relative(root, location);
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

export async function langfuseConfig(control, env = process.env) {
  const origin = loopback(env.CREW_LANGFUSE_URL);
  const projectId = env.CREW_LANGFUSE_PROJECT_ID;
  requireField(typeof projectId === 'string' && projectPattern.test(projectId), 'Set CREW_LANGFUSE_PROJECT_ID to the expected local project');
  const location = env.CREW_LANGFUSE_CREDENTIALS_FILE;
  requireField(typeof location === 'string' && isAbsolute(location), 'Set CREW_LANGFUSE_CREDENTIALS_FILE to an absolute private file path');
  try {
    const actual = await realpath(location);
    for (const path of [control.root, control.gitDir]) {
      const root = await realpath(path);
      if (within(root, resolve(location)) || within(root, actual)) throw new Error('inside checkout');
    }
    const handle = await open(actual, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      if (!info.isFile() || (info.mode & 0o077) || info.size > 8_192) throw new Error('invalid permissions or file');
      const { public_key: publicKey, secret_key: secretKey } = JSON.parse(await handle.readFile('utf8'));
      if (typeof publicKey !== 'string' || typeof secretKey !== 'string' ||
        !/^pk-lf-[a-zA-Z0-9_-]+$/.test(publicKey) || !/^sk-lf-[a-zA-Z0-9_-]+$/.test(secretKey)) throw new Error('invalid credentials');
      return { origin, projectId, authorization: `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString('base64')}` };
    } finally { await handle.close(); }
  } catch {
    throw new CrewError('Langfuse credentials must be in a private regular JSON file outside the checkout');
  }
}

const hash = value => createHash('sha256').update(value).digest('hex');

export function langfuseSpan({ run, task, attempt, record, receipt }, projectId) {
  for (const key of [run.project.id, run.id, task.packet.id, task.packet.profileId]) id(key, 'trace scope ID');
  if (run.epic?.id !== undefined) id(run.epic.id, 'trace epic ID');
  requireField(threadPattern.test(attempt.id) && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(run.sourceCommit) &&
    /^[a-f0-9]{64}$/.test(record.digest), 'The trace needs a pinned receipt and source revision');
  requireField(receipt.outcome === 'completed' && typeof receipt.threadId === 'string' && threadPattern.test(receipt.threadId),
    'Only a completed Codex receipt with a native thread ID can be published');
  const traceId = hash(JSON.stringify(['receipt-preview-v2', projectId, run.project.id, run.sourceCommit, run.id,
    task.packet.id, attempt.id, record.digest])).slice(0, 32);
  const spanId = hash(`${traceId}:observed-attempt`).slice(0, 16);
  const measured = Boolean(receipt.startedAt && receipt.endedAt);
  const start = Date.parse(receipt.startedAt ?? attempt.startedAt);
  const end = Date.parse(receipt.endedAt ?? attempt.endedAt);
  requireField(Number.isSafeInteger(start) && Number.isSafeInteger(end) && start > 0 && end >= start,
    'The Codex receipt has no valid execution interval');
  const name = `Codex receipt · ${task.packet.id}`;
  const metadata = {
    projectId: run.project.id, epicId: run.epic?.id, runId: run.id, taskId: task.packet.id, role: task.packet.profileId,
    attemptId: attempt.id, sourceCommit: run.sourceCommit, codexThreadId: receipt.threadId, codexOutcome: receipt.outcome,
    receiptSha256: record.digest, timing: measured ? 'codex-process' : 'crew-attempt',
  };
  const tokens = {};
  for (const key of ['input', 'output', 'total', 'cached', 'reasoning']) {
    const value = receipt.usage?.[key];
    if (Number.isSafeInteger(value) && value >= 0) {
      tokens[key] = value;
      metadata[`tokens_${key}`] = String(value);
    }
  }
  const input = { record: 'Engineering Crew task reference', project: run.project.id, epic: run.epic?.id,
    run: run.id, task: task.packet.id, attempt: attempt.id, sourceCommit: run.sourceCommit };
  const output = { record: 'Observed Codex receipt', outcome: receipt.outcome, thread: receipt.threadId,
    exitCode: Number.isSafeInteger(receipt.exitCode) ? receipt.exitCode : undefined,
    elapsedMs: end - start, timing: measured ? 'Codex process interval' : 'Crew attempt interval',
    ...(Object.keys(tokens).length ? { reportedTokens: tokens } : {}) };
  const attribute = (key, value) => ({ key, value: { stringValue: value } });
  const attributes = [attribute('langfuse.trace.name', `${run.project.id}/${task.packet.id}`),
    attribute('langfuse.observation.type', 'span'), attribute('langfuse.environment', 'local-delivery'),
    attribute('langfuse.observation.input', JSON.stringify(input)), attribute('langfuse.observation.output', JSON.stringify(output)),
    ...Object.entries(metadata).filter(([, value]) => typeof value === 'string').map(([key, value]) =>
      attribute(`langfuse.observation.metadata.${key}`, value))];
  const payload = { resourceSpans: [{ resource: { attributes: [attribute('service.name', 'engineering-crew')] },
    scopeSpans: [{ scope: { name: 'engineering-crew.codex-receipt' }, spans: [{ traceId, spanId, name, kind: 1,
      startTimeUnixNano: String(BigInt(start) * 1_000_000n), endTimeUnixNano: String(BigInt(end) * 1_000_000n), attributes }] }] }] };
  return { traceId, spanId, name, start, end, receiptDigest: record.digest, threadId: receipt.threadId, payload };
}

function api(config, route, payload) {
  const destination = new URL(route, config.origin);
  const body = payload === undefined ? undefined : JSON.stringify(payload);
  const headers = { Authorization: config.authorization, Accept: 'application/json' };
  if (body) Object.assign(headers, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
    'x-langfuse-ingestion-version': '4' });
  return new Promise((resolve, reject) => {
    const client = request(destination, { method: body ? 'POST' : 'GET', headers, agent: false,
      signal: AbortSignal.timeout(5_000) }, async response => {
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.destroy();
        reject(new CrewError(`Langfuse returned HTTP ${response.statusCode}`));
        return;
      }
      try {
        const chunks = [];
        let size = 0;
        for await (const chunk of response) {
          size += chunk.length;
          if (size > 256_000) throw new Error('response too large');
          chunks.push(chunk);
        }
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        response.destroy();
        reject(new CrewError('Langfuse returned an unreadable response'));
      }
    });
    client.on('error', () => reject(new CrewError('Local Langfuse API is unavailable')));
    client.end(body);
  });
}

export async function publishLangfuse(config, span, { retries = 9, intervalMs = 1_000 } = {}) {
  const projects = await api(config, '/api/public/projects');
  requireField(Array.isArray(projects?.data) && projects.data.length === 1 && projects.data[0]?.id === config.projectId,
    'Langfuse credentials do not identify only the configured project');
  const query = new URLSearchParams({ traceId: span.traceId, fields: 'core,basic,metadata,io', limit: '10',
    fromStartTime: new Date(span.start - 60_000).toISOString(), toStartTime: new Date(span.end + 60_000).toISOString() });
  async function readVerified() {
    const visible = await api(config, `/api/public/v2/observations?${query}`);
    if (Array.isArray(visible?.data) && visible.data.some(row => row.id === span.spanId && row.traceId === span.traceId &&
      row.projectId === config.projectId && row.name === span.name && row.metadata?.receiptSha256 === span.receiptDigest &&
      row.metadata?.codexThreadId === span.threadId && row.input != null && row.output != null)) {
      const path = `/project/${encodeURIComponent(config.projectId)}/traces/${span.traceId}`;
      return { status: 'verified', traceId: span.traceId, observationId: span.spanId, projectId: config.projectId,
        verifiedAt: new Date().toISOString(), url: `${config.origin}${path}?observation=${span.spanId}&mobileTab=info` };
    }
  }

  const existing = await readVerified();
  if (existing) return existing;

  const submitted = await api(config, '/api/public/otel/v1/traces', span.payload);
  requireField(!Number(submitted?.partialSuccess?.rejectedSpans), 'Langfuse rejected the execution span');
  for (let index = 0; index <= retries; index++) {
    if (index) await delay(intervalMs);
    const verified = await readVerified();
    if (verified) return verified;
  }
  throw new CrewError('Langfuse received the span, but the expected observation could not be verified');
}

export function verifiedTraceLink(trace) {
  if (trace?.status !== 'verified' || typeof trace.projectId !== 'string' || !projectPattern.test(trace.projectId) ||
    !/^[a-f0-9]{32}$/.test(trace.traceId) || !/^[a-f0-9]{16}$/.test(trace.observationId) || !URL.canParse(trace.url)) return null;
  const url = new URL(trace.url);
  if (!originPattern.test(url.origin) || url.username || url.password || url.hash ||
    url.pathname !== `/project/${encodeURIComponent(trace.projectId)}/traces/${trace.traceId}` ||
    ![`?observation=${trace.observationId}`, `?observation=${trace.observationId}&mobileTab=info`].includes(url.search)) return null;
  return url.href;
}
