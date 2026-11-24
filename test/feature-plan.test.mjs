import test from 'node:test';
import assert from 'node:assert/strict';
import { planSynopsis, renderFeaturePlan } from '../ui/feature-plan.mjs';

test('planning shows recorded intent, implementation order and planned checks without inferring a verdict', () => {
  const plan = {
    summary: 'Find the full rendition and link each correction to a phrase. The base checkout was empty.',
    steps: ['Inspect the checkout.', 'Accept WAV files up to 20 MiB.', 'Store the original recording.', 'Run local speech recognition.', 'Link spoken corrections to sung phrases.'],
    acceptance: ['An imported WAV persists.', 'The player seeks to the selected interval.'],
    base: '4'.repeat(40),
  };
  const html = renderFeaturePlan(plan, { id: 'event-7-plan' });
  assert.equal(planSynopsis(plan), 'Find the full rendition and link each correction to a phrase.');
  assert.match(html, /<h3>Planned approach<\/h3><p>Find the full rendition and link each correction to a phrase\.<\/p>/);
  assert.match(html, /<details class="plan-continuation" id="event-7-plan-summary">[\s\S]*The base checkout was empty\./);
  assert.match(html, /Implementation steps <span class="plan-count">\(5\)/);
  assert.match(html, /Planned checks <span class="plan-count">\(2\)/);
  assert.match(html, /id="event-7-plan-steps-more"[^>]*>[\s\S]*<ol class="plan-items" start="4"><li class="plan-item">Run local speech recognition/);
  assert.doesNotMatch(html, /passed|verified|4444444|<pre>/i);
});

test('long technical items disclose exact wording while preserving code tokens and escaping agent text', () => {
  const long = 'Offer playback for the original recording and each corrected phrase; use <audio> with bounded seek intervals and a keyboard shortcut.';
  const html = renderFeaturePlan({
    summary: 'Use Node.js to serve example.test locally.',
    steps: ['Listen on 0.0.0.0 at PORT or 3000. Validate Host and Origin.', long],
    acceptance: ['Display <script onload="bad"> as lesson text.'],
  }, { id: 'stage-plan' });
  assert.match(html, /id="stage-plan-steps-1"><summary>Listen on 0\.0\.0\.0 at PORT or 3000\.<\/summary><p class="plan-copy">Validate Host and Origin\./);
  assert.match(html, /id="stage-plan-steps-2"><summary>Offer playback for the original recording and each corrected phrase…<\/summary>/);
  assert.ok(html.includes(long.replace('<audio>', '&lt;audio&gt;')));
  assert.match(html, /&lt;script onload=&quot;bad&quot;&gt;/);
  assert.doesNotMatch(html, /<script\b|<audio>/i);
});

test('short authored step and check headings keep their implementation and test instructions one disclosure away', () => {
  const html = renderFeaturePlan({
    summary: 'Students can replay the phrase their teacher corrected.',
    steps: ['Keep the original recording. Save the uploaded bytes atomically in the lesson directory.'],
    acceptance: ['The recording reopens after restart. Import a WAV, restart the app and compare the returned audio bytes.'],
  });
  assert.match(html, /<summary>Keep the original recording\.<\/summary><p class="plan-copy">Save the uploaded bytes atomically/);
  assert.match(html, /<summary>The recording reopens after restart\.<\/summary><p class="plan-copy">Import a WAV/);
  assert.doesNotMatch(html, /<details[^>]*\sopen\b/);
});

test('legacy free text, incomplete records and missing lists remain readable', () => {
  assert.equal(planSynopsis('Implement then verify'), 'Implement then verify');
  assert.match(renderFeaturePlan('Implement then verify'), />Implement then verify<\/p>/);
  assert.equal(planSynopsis({ steps: ['  ', null, 'Upload WAV'], acceptance: ['reject invalid audio'] }), '1 implementation step and 1 planned check');
  assert.doesNotMatch(renderFeaturePlan({ acceptance: ['Analyze a lesson.', false, null] }), /Implementation steps|\[object Object\]|false/);
  for (const plan of [null, [], 0, { base: 'abc' }, { summary: {}, steps: [' '] }]) {
    assert.equal(planSynopsis(plan), '');
    assert.match(renderFeaturePlan(plan), /Planning details are unavailable/);
  }
});
