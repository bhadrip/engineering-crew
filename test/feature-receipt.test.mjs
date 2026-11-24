import assert from 'node:assert/strict';
import test from 'node:test';
import { receiptMetrics } from '../ui/feature-receipt.mjs';
import { featureCalls } from '../lib/feature-usage.mjs';

test('a call receipt shows localized start and end, elapsed time and reported token subsets', () => {
  const [call] = featureCalls([{ seq: 7, role: 'planner', phase: 'plan', attempt: 0, type: 'agent.completed',
    evidence: { startedAt: '2026-11-23T23:59:59.500Z', endedAt: '2026-11-24T00:01:06.500Z',
      model: 'codex default', reportedModel: 'gpt-6-codex',
      usage: { input_tokens: 1500, output_tokens: 400, cached_input_tokens: 600, reasoning_output_tokens: 50 } } }]);
  const html = receiptMetrics(call);
  assert.match(html, /<dl class="receipt-metrics" aria-label="Codex call receipt">/);
  assert.match(html, /<dt>Run by<\/dt><dd>Planner</);
  assert.match(html, /<dt>Action<\/dt><dd>Plan the work</);
  assert.match(html, /<dt>Model<\/dt><dd>gpt-6-codex/);
  assert.match(html, /<dt>Duration<\/dt><dd>1m 7s/);
  assert.match(html, /Started<\/dt><dd><time data-local data-precise datetime="2026-11-23T23:59:59\.500Z"/);
  assert.match(html, /Finished<\/dt><dd><time data-local data-precise datetime="2026-11-24T00:01:06\.500Z"/);
  assert.match(html, /<dt>Input tokens<\/dt><dd>1,500 <span class="receipt-subset">\(600 cached\)/);
  assert.match(html, /<dt>Output tokens<\/dt><dd>400 <span class="receipt-subset">\(50 reasoning\)/);
  assert.match(html, /<dt>Total tokens<\/dt><dd>1,900/);
});

test('missing values and a default model alias remain unknown, while reported zeros remain visible', () => {
  assert.equal(receiptMetrics(null), '');
  const unknown = receiptMetrics({ model: 'codex default', endedAt: 'invalid', usage: {}, durationMs: null });
  assert.match(unknown, /<dt>Total tokens<\/dt><dd>Unreported/);
  assert.match(unknown, /Model<\/dt><dd>Unreported/);
  assert.doesNotMatch(unknown, /Duration|<time|cached|reasoning|>0</);
  const onlyCache = receiptMetrics({ model: '<script>model</script>', modelSource: 'configured', durationMs: 0,
    usage: { input: null, output: 0, cached: 15, reasoning: 0 } });
  assert.match(onlyCache, /Requested model<\/dt><dd>&lt;script&gt;model/);
  assert.match(onlyCache, /Duration<\/dt><dd>0 ms/);
  assert.match(onlyCache, /Input tokens<\/dt><dd>Unreported <span class="receipt-subset">\(15 cached\)/);
  assert.match(onlyCache, /Output tokens<\/dt><dd>0 <span class="receipt-subset">\(0 reasoning\)/);
  assert.doesNotMatch(onlyCache, /<script>|Total tokens/);
});

test('the receipt retains the requested model when the harness reports a different model', () => {
  const [call] = featureCalls([{ seq: 1, role: 'qa', type: 'agent.completed', evidence: {
    model: 'model-a', modelSelection: 'catalog-default', reportedModel: 'model-b', reportedModelSource: 'codex-json' } }]);
  const html = receiptMetrics(call);
  assert.match(html, /Model<\/dt><dd>model-b[^]*?reported by Codex/);
  assert.match(html, /Model evidence<\/dt><dd>Codex event stream/);
  assert.match(html, /Requested model<\/dt><dd>model-a/);
  assert.match(html, /Selection<\/dt><dd>Codex catalog default/);
});
