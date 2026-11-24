import { isDeepStrictEqual } from 'node:util';

// A role result can repeat the receipt already recorded by agent.completed.
// Count the Codex call once, even if the engineer takes many turns in one task.
const isCount = value => Number.isSafeInteger(value) && value >= 0;
const counter = (...values) => values.find(isCount) ?? null;

export function intervalMs(start, end) {
  const duration = Date.parse(end) - Date.parse(start);
  return Number.isFinite(duration) && duration >= 0 ? duration : null;
}

export function featureCalls(events) {
  const calls = [], perTask = new Map();
  for (const event of events) {
    const receipt = event.type === 'agent.completed' ? event.evidence
      : event.type === 'task.completed' ? event.evidence?.receipt : null;
    if (!receipt || typeof receipt !== 'object') continue;
    const key = JSON.stringify([event.operationId, event.role, event.attempt]);
    const previous = perTask.get(key) ?? [];
    if (previous.some(other => {
      if (receipt.threadId && other.threadId && other.threadId !== receipt.threadId) return false;
      if (receipt.startedAt && other.startedAt) return receipt.startedAt === other.startedAt;
      return event.type === 'task.completed' && ((receipt.threadId && receipt.threadId === other.threadId) || isDeepStrictEqual(other, receipt));
    })) continue;
    const u = receipt.usage ?? {};
    const input = counter(u.input_tokens, u.input), output = counter(u.output_tokens, u.output);
    const call = { seq: event.seq, role: event.role, phase: event.phase, attempt: event.attempt,
      threadId: receipt.threadId ?? null, startedAt: receipt.startedAt ?? null, endedAt: receipt.endedAt ?? null,
      model: receipt.reportedModel || receipt.model || null, modelSource: receipt.reportedModel ? 'reported' : receipt.model ? 'configured' : null,
      requestedModel: typeof receipt.model === 'string' && receipt.model !== 'codex default' ? receipt.model : null,
      modelSelection: receipt.modelSelection ?? null, reportedModelSource: receipt.reportedModelSource ?? null,
      durationMs: intervalMs(receipt.startedAt, receipt.endedAt),
      usage: { input, output, total: counter(u.total_tokens, u.total, input !== null && output !== null ? input + output : null),
        cached: counter(u.cached_input_tokens, u.cached), reasoning: counter(u.reasoning_output_tokens, u.reasoning) } };
    calls.push(call);
    previous.push(receipt);
    perTask.set(key, previous);
  }
  return calls;
}

export function summarizeCalls(calls) {
  const sum = values => {
    const known = values.filter(isCount);
    return known.length ? known.reduce((a, b) => a + b, 0) : null;
  };
  return { count: calls.length, durationMs: sum(calls.map(c => c.durationMs)),
    missingTotals: calls.filter(c => c.usage.total === null).length,
    missingTimes: calls.filter(c => c.durationMs === null).length,
    ...Object.fromEntries(['input','output','total','cached','reasoning'].map(key => [key, sum(calls.map(c => c.usage[key]))])) };
}
