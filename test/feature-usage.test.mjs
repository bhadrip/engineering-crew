import test from 'node:test';
import assert from 'node:assert/strict';
import { featureCalls, intervalMs, summarizeCalls } from '../lib/feature-usage.mjs';
import { elapsedTime, featureUsage, stageUsage } from '../ui/feature-usage.mjs';

const path = '/projects/music/requests/lesson-replay';
const at = second => new Date(Date.UTC(2026, 10, 24, 2, 0, second)).toISOString();
const phase = { planner: 'plan', engineer: 'build', qa: 'verify', security: 'verify' };
function event(seq, role, receipt, { embedded = false, parents = [] } = {}) {
  const attempt = role === 'planner' ? 0 : 1;
  return { seq, role, phase: phase[role], attempt, operationId: 'lesson-replay:' + role + ':' + attempt,
    type: embedded ? 'task.completed' : 'agent.completed', evidence: embedded ? { receipt } : receipt, parents };
}
function receipt(id, start, end, input, output, cached = 0, reasoning = 0) {
  return { threadId: id, startedAt: at(start), endedAt: at(end), model: 'codex default', reportedModel: 'observed-model',
    usage: { input_tokens: input, output_tokens: output, cached_input_tokens: cached, reasoning_output_tokens: reasoning } };
}

test('each completed call contributes input plus output once, including separate engineering turns and concurrent reviewers', () => {
  const planning = receipt('p', 0, 10, 120, 11, 30, 6);
  const engineer1 = receipt('e1', 10, 13, 200, 50, 80, 10);
  const engineer2 = receipt('e2', 13, 17, 110, 27, 40, 8);
  const qa = receipt('q', 17, 27, 50, 5, 10, 1);
  const security = receipt('s', 17, 21, 20, 3, 6, 2);
  const events = [event(7, 'planner', planning), event(9, 'planner', { ...planning }, { embedded: true, parents: [7] }),
    event(15, 'engineer', engineer1), event(25, 'engineer', engineer2), event(31, 'qa', qa), event(34, 'security', security),
    event(36, 'qa', qa, { embedded: true, parents: [31] }), event(38, 'security', security, { embedded: true, parents: [34] })];
  const calls = featureCalls(events);
  assert.deepEqual(calls.map(c => c.seq), [7, 15, 25, 31, 34]);
  assert.equal(calls[0].model, 'observed-model');
  assert.deepEqual(summarizeCalls(calls), {
    count: 5, input: 500, output: 96, total: 596, cached: 166, reasoning: 27,
    durationMs: 31000, missingTotals: 0, missingTimes: 0,
  });
  const page = featureUsage({ events, status: 'completed', startedAt: at(0), endedAt: at(27) }, path, false);
  assert.match(page, /27s elapsed/);
  assert.match(page, /596 reported tokens/);
  assert.match(page, /<th>Agent<\/th><th>Model<\/th><th>Calls<\/th>/);
  const engineer = page.match(/<tr><th[^>]*>Engineer<\/th>[^]*?<\/tr>/)[0];
  assert.match(engineer, /observed-model<\/span>.*Reported by Codex/);
  assert.match(engineer, /data-label="Calls">2<\/td><td[^>]*>310<\/td><td[^>]*>77<\/td><td[^>]*>7s/);
  assert.match(page, /href="#event-7">Planner/);
  assert.match(page, /href="#event-25">Engineer/);
  assert.match(page, /href="#event-31">QA agent/);
  assert.match(page, /href="#event-34">Security reviewer/);
  assert.doesNotMatch(page, /href="#event-(9|36|38)"/);
  const engineering = stageUsage('attempt-1', events.filter(e => e.role === 'engineer'));
  assert.match(engineering, /387 tokens · 7s of agent time · 2 calls/);
});

test('agent usage splits different model identities and sources with partial counters and unknown names', () => {
  const events = [
    event(1, 'engineer', { model: 'model-a', reportedModel: 'model-b', usage: { input: 10, output: 5 } }),
    event(2, 'engineer', { model: 'model-a', reportedModel: 'model-b', usage: { output: 2 } }),
    event(3, 'engineer', { model: 'model-b', usage: { input: 11, output: 1 } }),
    event(4, 'engineer', { model: 'codex default', usage: { input: 8, output: 1 } }),
    event(5, 'engineer', { model: 'model-c', modelSelection: 'catalog-default', usage: { input: 4, output: 1 } }),
  ];
  const html = featureUsage({ events }, path, false);
  const rows = html.match(/<tr><th scope="row"[^>]*>Engineer<\/th>[^]*?<\/tr>/g);
  assert.equal(rows.length, 4);
  assert.match(rows[0], /model-b.*Reported by Codex.*data-label="Input">10 \(partial\)/);
  assert.match(rows[1], /model-b.*Requested.*data-label="Input">11</);
  assert.match(rows[2], /Unreported.*data-label="Input">8</);
  assert.match(rows[3], /model-c.*Requested.*data-label="Input">4</);
  assert.match(html, /href="#event-1"[^]*?model-b[^]*?Reported by Codex/);
});

test('missing usage and timestamps remain unknown while actual zeros and partial totals stay visible', () => {
  const events = [
    event(1, 'engineer', { startedAt: at(0), endedAt: at(0), usage: { input_tokens: 0, output_tokens: 0 } }),
    event(2, 'engineer', { threadId: 'missing', usage: null }),
    event(3, 'qa', { threadId: 'counter-only', usage: { total_tokens: 100 } }, { embedded: true }),
  ];
  const calls = featureCalls(events);
  assert.equal(calls[0].durationMs, 0);
  assert.equal(calls[0].usage.total, 0);
  assert.equal(calls[1].durationMs, null);
  assert.equal(calls[1].usage.total, null);
  assert.equal(calls[2].usage.total, 100);
  assert.equal(calls[2].usage.output, null);
  const total = summarizeCalls(calls);
  assert.equal(total.total, 100);
  assert.equal(total.missingTotals, 1);
  assert.equal(total.missingTimes, 2);
  assert.equal(total.durationMs, 0);
  assert.equal(summarizeCalls([]).total, null);
  assert.equal(summarizeCalls([]).durationMs, null);
  assert.match(stageUsage('attempt-1', [events[0]]), /0 tokens · 0 ms of agent time/);
  assert.match(stageUsage('attempt-1', [events[1]]), /Tokens unreported/);
  assert.match(stageUsage('attempt-1', events), /100 \(partial\) tokens · 0 ms \(partial\) of agent time/);
  assert.equal(stageUsage('planning', []), '');
  assert.match(featureUsage({ events }, path, false), /href="#event-3">QA agent/);
  assert.equal(intervalMs(at(3), at(2)), null);
  assert.equal(intervalMs(null, at(2)), null);
});

test('elapsed time ticks only for a running request and stops at its durable end time', () => {
  const startedAt = new Date(Date.now() - 123_000).toISOString();
  assert.match(elapsedTime({ status: 'running', startedAt }), /<time data-elapsed-from="[^"]+">2m \d+s<\/time>/);
  assert.equal(elapsedTime({ status: 'completed', startedAt: at(0), endedAt: at(65) }), '1m 5s');
  assert.equal(elapsedTime({ status: 'blocked', startedAt: at(0), endedAt: at(0) }), '0 ms');
  assert.equal(elapsedTime({ status: 'blocked', startedAt }), '—');
  assert.equal(elapsedTime({ status: 'queued' }), '—');
});

test('unconfigured Langfuse and unverified trace metadata never fabricate a destination', () => {
  const request = { status: 'completed', events: [event(22, 'qa', receipt('q', 1, 2, 2, 1))],
    langfuseTrace: { status: 'published', url: 'https://example.org/fake-trace' } };
  const unconfigured = featureUsage(request, path, false);
  assert.match(unconfigured, /Not connected/);
  assert.match(unconfigured, /href="#event-22"/);
  assert.doesNotMatch(unconfigured, /Open verified trace|href="https?:|example\.org|<form/);
  const configured = featureUsage(request, path, true);
  assert.match(configured, /action="\/projects\/music\/requests\/lesson-replay\/langfuse"/);
  assert.doesNotMatch(configured, /Open verified trace|href="https?:/);
});

test('an exact embedded receipt without an identifying timestamp or thread can be matched to its recorded call', () => {
  const recorded = { model: 'codex default', usage: { input_tokens: 9, output_tokens: 4 } };
  const events = [event(4, 'qa', recorded),
    { seq: 5, role: 'qa', type: 'app.test.completed', operationId: 'lesson-replay:qa:1', parents: [4] },
    event(6, 'qa', structuredClone(recorded), { embedded: true, parents: [5] })];
  assert.deepEqual(featureCalls(events).map(c => c.seq), [4]);
});

test('two receipts with different start times in the same thread still identify separate calls', () => {
  const first = receipt('continuing-thread', 2, 5, 14, 2);
  const second = receipt('continuing-thread', 7, 9, 10, 2);
  const events = [event(4, 'engineer', first), event(6, 'engineer', second, { embedded: true })];
  assert.deepEqual(featureCalls(events).map(c => c.seq), [4, 6]);
});
