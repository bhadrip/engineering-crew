import assert from 'node:assert/strict';
import test from 'node:test';
import { featureDag } from '../ui/feature-dag.mjs';
import { buildOutcome, checkFailures, workflowStepFinding } from '../ui/feature-journey.mjs';

const path = '/projects/music/requests/replay';
const req = { status: 'running', attempt: 1 };
function step(page, id) {
  const html = page.split('<details class="workflow-step" id="stage-' + id + '"')[1];
  assert.ok(html, 'Missing inline step ' + id);
  return html.split('<details class="workflow-step"')[0];
}

function event(seq, type, role, attempt, evidence = {}, parents = []) {
  const phase = role === 'planner' ? 'plan' : role === 'engineer' ? 'build' : 'verify';
  return { seq, type, role, attempt, evidence, parents, phase };
}

test('planning gives the recorded plan and its source without submitting work or opening JSON', () => {
  const plan = { summary: 'Replay a lesson and locate the correction.', steps: ['Import the WAV'], acceptance: ['Hear the corrected phrase'] };
  const page = featureDag(req, [
    event(1, 'request.created', 'controller', 0),
    event(7, 'task.completed', 'planner', 0, { plan }),
  ], path);
  const planning = step(page, 'planning');
  assert.match(planning, /data-tone="success"[\s\S]*?Plan the work\. Run by: Planner\. Result: Succeeded/);
  assert.match(planning, /Planned approach[\s\S]*?Replay a lesson and locate the correction/);
  assert.match(planning, /Import the WAV/);
  assert.match(planning, /Hear the corrected phrase/);
  assert.match(planning, /href="#event-7">Planning record/);
  assert.match(planning, /href="#workflow">Back to workflow/);
  assert.doesNotMatch(page, /stage-delivery|stage-attempt-|<pre>|<form|<details[^>]*\sopen/);
  for (const plan of [undefined, {}, { base: 'rev' }]) {
    const partial = step(featureDag(req, [event(7, 'task.completed', 'planner', 0, { plan })]), 'planning');
    assert.match(partial, /Result: Unavailable/);
    assert.doesNotMatch(partial, /Succeeded/);
  }
});

test('build, verification, and repair expose the observed change, its checks, and the precise retry cause', () => {
  const events = [
    event(2, 'task.completed', 'planner', 0, { plan: 'Import a class recording.' }),
    event(3, 'task.completed', 'engineer', 1, { base: 'a', revision: 'b', summary: 'Add WAV imports.' }),
    event(4, 'task.completed', 'qa', 1, { passed: false, checks: [{ check: 'New recording import', passed: false }] }),
    event(5, 'task.completed', 'security', 1, { passed: true }),
    event(6, 'repair.requested', 'controller', 1, {}, [4, 5]),
    event(7, 'task.started', 'engineer', 2, {}, [6]),
    event(8, 'app.probe.completed', 'engineer', 2, { passed: false }),
    event(9, 'task.failed', 'engineer', 2, { message: 'Engineer exhausted its workspace turn budget before submitting a tested candidate' }, [7]),
    event(10, 'request.blocked', 'controller', 2, { message: 'Attempt limit reached.' }, [9]),
  ];
  const metrics = new Map();
  const page = featureDag({ status: 'blocked', attempt: 2 }, events, path, { stageMetrics(id, records) {
    metrics.set(id, records.map(e => e.seq));
    return '<p>Recorded usage</p>';
  } });
  assert.deepEqual([...metrics], [['planning', [2]], ['attempt-1', [3]], ['qa-1', [4]], ['security-1', [5]], ['attempt-2', [7, 8, 9]], ['delivery', [10]]]);
  const build = step(page, 'attempt-1'), qa = step(page, 'qa-1'), security = step(page, 'security-1');
  assert.match(build, /data-tone="success"[\s\S]*?Result: Succeeded[\s\S]*?QA failed\. Security passed\./);
  assert.match(build, /<div class="workflow-body"><p class="step-outcome"><strong>Outcome<\/strong> Add WAV imports\./);
  assert.match(build, /<summary>Technical details<\/summary>[\s\S]+Produced revision b\.[\s\S]+<p>Recorded usage<\/p>/);
  assert.match(build, /<details class="step-agent-output" id="engineer-note-1"><summary>Agent output<\/summary><p>Add WAV imports\.<\/p>/);
  assert.match(build, /href="\/projects\/music\/requests\/replay\/attempts\/1\/changes">View code changes/);
  assert.doesNotMatch(build, /New recording import|Check record|class="workflow-findings"/);
  assert.match(qa, /Result: Failed[\s\S]+New recording import · Failed[\s\S]+href="#event-4">Check record/);
  assert.match(security, /Run by: Security reviewer\. Result: Passed[\s\S]+href="#event-5">Check record/);
  const repair = step(page, 'attempt-2');
  assert.match(repair, /Attempt repair 1[\s\S]*ran out of steps/);
  assert.match(repair, /href="#event-6">Why this repair started/);
  assert.match(repair, /href="#event-8">App check failed/);
  assert.match(repair, /href="#event-9">Why the build stopped/);
  assert.match(step(page, 'delivery'), /Result: No release[\s\S]+href="#event-10">Stop decision/);
  assert.doesNotMatch(page, /attempts\/2\/changes/);
});

test('repair status waits for independent checks, follows negative verdicts, and respects the revised candidate', () => {
  const build = event(11, 'task.completed', 'engineer', 2, { revision: 'repair' });
  const qa = event(12, 'task.completed', 'qa', 2, { revision: 'repair', passed: true });
  const code = event(13, 'task.completed', 'reviewer', 2, { revision: 'repair', passed: true });
  const security = event(14, 'task.completed', 'security', 2, { revision: 'repair', passed: true });
  function status(events, request = { status: 'running', attempt: 2 }) {
    return buildOutcome(request, 2, [build, ...events]).status;
  }
  assert.equal(status([]), 'Awaiting checks');
  assert.equal(status([event(12, 'task.started', 'qa', 2)]), 'Checks running');
  assert.equal(status([qa, code]), 'Checks running');
  assert.equal(status([qa, code], { status: 'blocked', attempt: 2 }), 'Checks incomplete');
  assert.equal(status([qa, code, security]), 'Checks passed');
  assert.equal(status([event(12, 'candidate.verified', 'controller', 2, { revision: 'repair' })]), 'Checks passed');
  assert.equal(status([event(12, 'candidate.verified', 'controller', 2, { revision: 'older' })]), 'Awaiting checks');
  assert.equal(status([qa, code, { ...security, evidence: { revision: 'other', passed: true } }]), 'Checks incomplete');
  assert.equal(status([qa, code, { ...security, evidence: { passed: true } }]), 'Checks incomplete');
  assert.equal(status([qa, code, { ...security, evidence: { passed: false } }]), 'Checks incomplete');
  assert.equal(status([qa, code, { ...security, revision: 'repair', evidence: { passed: true } }]), 'Checks passed');
  assert.equal(status([qa, { ...code, evidence: { revision: 'repair', passed: false } }, security]), 'Checks failed');
  assert.equal(status([qa, { ...security, type: 'task.failed' }]), 'Checks stopped');
  assert.equal(status([event(17, 'repair.requested', 'controller', 2)]), 'Changes needed');
});

test('queue, interrupted work, partial records, and stopped planning do not claim completed work', () => {
  const queued = featureDag({ status: 'queued', attempt: 0, canResume: true }, [], path);
  assert.match(queued, /first stage/);
  assert.doesNotMatch(queued, /In progress|Finished|Build first version|Deliver build/);
  const interrupted = featureDag({ status: 'running', attempt: 0, canResume: true }, [event(2, 'task.started', 'planner', 0)], path);
  assert.match(interrupted, /Paused/);
  const verification = featureDag({ status: 'running', attempt: 1 }, [
    event(3, 'task.completed', 'engineer', 1, { summary: '<script>x()</script>', revision: 'b' }),
    event(4, 'task.started', 'qa', 1),
    event(5, 'task.completed', 'reviewer', 1, { summary: 'Looks fine' }),
    event(6, 'task.completed', 'security', 1, { passed: true, revision: 'a' }),
  ], path);
  assert.match(verification, /&lt;script&gt;/);
  assert.match(step(verification, 'qa-1'), /Result: In progress/);
  assert.match(step(verification, 'reviewer-1'), /Result: Unavailable/);
  assert.match(step(verification, 'security-1'), /Result: Different build/);
  assert.doesNotMatch(verification, /<script>|\/changes"|Result: Passed|Result: Checks passed/);
  const failed = featureDag({ status: 'blocked' }, [
    event(2, 'task.failed', 'planner', 0, { message: 'The planner stopped.' }),
    event(3, 'request.blocked', 'controller', 0, {}, [2]),
  ], path);
  assert.match(failed, /id="stage-planning"[\s\S]*The planner stopped\./);
  assert.match(failed, /href="#event-3">Stop decision/);
  assert.doesNotMatch(failed, /id="stage-attempt/);
});

test('a recorded release stays distinct from preview readiness and a stop during delivery', () => {
  const feature = { status: 'completed', attempt: 1, previewStatus: 'failed' };
  const events = [event(8, 'candidate.verified', 'controller', 1),
    { ...event(9, 'request.completed', 'controller', 1), phase: 'promote' },
    { ...event(10, 'app.preview.failed', 'controller', 1), phase: 'preview' },
  ];
  const page = featureDag(feature, events, path);
  assert.match(step(page, 'delivery'), /Deliver build\. Run by: Crew controller\. Result: Released/);
  assert.match(step(page, 'delivery'), /href="#event-9">Delivery record/);
  assert.match(step(page, 'preview'), /Result: Failed to start[\s\S]*href="#event-10">Preview record/);
  const stopped = featureDag({ status: 'blocked', attempt: 1 }, [
    ...events.slice(0, 1), { ...event(9, 'task.failed', 'controller', 1, { message: 'Delivery failed' }), phase: 'promote' },
    { ...event(10, 'request.blocked', 'controller', 1, { message: 'Delivery failed' }, [9]), phase: 'promote' },
  ], path);
  assert.doesNotMatch(stopped, /id="stage-attempt-1"|Result: Delivered|Result: Released/);
  assert.match(step(stopped, 'verified-1'), /href="#event-8">Verification record/);
  assert.match(step(stopped, 'delivery'), /data-tone="warning"[\s\S]*Delivery failed/);
  assert.match(step(stopped, 'delivery'), /href="#event-9">Why delivery stopped/);
  assert.equal(stopped.match(/id="stage-delivery"/g).length, 1);
});

test('build evidence links only to the engineer test result on the revision the engineer completed', () => {
  const events = [
    event(4, 'app.test.completed', 'engineer', 1, { revision: 'old', passed: true }),
    event(5, 'app.test.completed', 'engineer', 1, { revision: 'built', passed: true }),
    event(6, 'task.completed', 'engineer', 1, { revision: 'built', base: 'old' }),
    event(7, 'app.test.completed', 'qa', 1, { revision: 'built', passed: false }),
    event(8, 'task.completed', 'qa', 1, { revision: 'built', passed: false }),
  ];
  const page = featureDag({ status: 'blocked', attempt: 1 }, events, path);
  assert.match(page, /href="#event-5">Build tests passed/);
  assert.doesNotMatch(page, /href="#event-(4|7)">Build tests/);
  assert.match(step(page, 'qa-1'), /Result: Failed/);
  const noMatch = featureDag(req, events.filter(e => e.seq !== 5), path);
  assert.match(noMatch, /class="workflow-result">Result: Succeeded/);
  assert.doesNotMatch(noMatch, /Build tests passed/);
  for (const revision of [null, ' ']) {
    const partial = featureDag(req, [event(4, 'task.completed', 'engineer', 1, { revision })], path);
    assert.match(partial, /class="workflow-result">Result: Unavailable/);
    assert.doesNotMatch(partial, /Succeeded|Build tests passed|View code changes/);
  }
});

test('QA leads with the observed health failure and separates the author suite, independent test, skipped acceptance, and model output', () => {
  const rev = 'a'.repeat(40);
  const author = { revision: rev, command: ['node', '--test', '--test-reporter=tap'], passed: true, output: 'TAP version 13\n# pass 44' };
  const independent = { revision: rev, command: [...author.command, '/crew-tests/acceptance.test.mjs'], passed: false, exitCode: 1,
    output: "TAP version 13\nnot ok 1 - lesson import accepts WAV\n  error: 'Expected HTTP 201'\n# fail 1" };
  const health = { revision: rev, check: 'HTTP /health', passed: false, evidence: 'GET /health returned HTTP 403 ({"error":"Access is limited to this computer."})' };
  const result = event(16, 'task.completed', 'qa', 1, { revision: rev, passed: false, summary: 'Wrote a test for the recording import flow.',
    checks: [{ ...author, check: 'Author tests' }, { ...independent, check: 'Independent QA tests' }, health,
      { check: 'Operator acceptance test', status: 'skipped', reason: 'A healthy preview is required' }, { check: 'Legacy check' }],
    independentTest: "test('WAV <import>', runImport)" }, [15]);
  const events = [
    event(7, 'app.test.completed', 'engineer', 1, author),
    event(8, 'app.test.completed', 'qa', 1, { ...author, revision: 'old' }),
    event(9, 'app.test.completed', 'qa', 2, author), event(10, 'task.completed', 'engineer', 1, { revision: rev }),
    event(11, 'agent.completed', 'qa', 1, { outputDigest: 'output' }),
    event(12, 'app.test.completed', 'qa', 1, author), event(13, 'app.unhealthy', 'qa', 1, health),
    event(15, 'app.test.completed', 'qa', 1, independent), result, event(17, 'repair.requested', 'controller', 1, {}, [16]),
  ];
  const qa = step(featureDag(req, events, path), 'qa-1');
  const body = qa.slice(qa.indexOf('<div class="workflow-body">'));
  assert.match(body, /^<div class="workflow-body"><p class="step-outcome"><strong>Why it failed<\/strong> GET \/health returned HTTP 403\. Access is limited to this computer\.<\/p>/);
  assert.match(body, /<li data-result="passed"><details[^>]+><summary>Author tests · Passed<\/summary><a href="#event-12">Check receipt/);
  assert.match(body, /<li data-result="failed"><details[^>]+><summary>Independent QA tests · Failed<\/summary><p>lesson import accepts WAV<\/p>[\s\S]+Expected HTTP 201[\s\S]+Exit 1[\s\S]+href="#event-15">Check receipt/);
  assert.match(body, /<summary>HTTP \/health · Failed<\/summary>[\s\S]+href="#event-13">Check receipt/);
  assert.match(body, /<li data-result="skipped">Operator acceptance test · Skipped<p>A healthy preview is required<\/p><\/li>/);
  assert.equal(body.split('A healthy preview is required').length, 2);
  assert.match(body, /<li data-result="unknown">Legacy check · No verdict<\/li>/);
  assert.match(body, /class="step-next"><strong>Next<\/strong> <a href="#stage-retry-1">Request changes for the first build/);
  assert.match(body, /<summary>Agent output<\/summary><p>Wrote a test[\s\S]+QA-authored test source<\/summary><pre><code>test\(&#39;WAV &lt;import&gt;[\s\S]+events\/11\/input#agent-output"/);
  assert.doesNotMatch(body, /href="#event-(7|8|9)"|TAP version|# pass 44|<details[^>]*\sopen/);
  assert.equal(workflowStepFinding({ key: 'qa-1', status: 'Failed', event: result }, req, events), 'GET /health returned HTTP 403. Access is limited to this computer.');
});

test('health response diagnostics preserve unknown text, truncated bodies and unrecognized shapes', () => {
  const prefix = 'GET /health returned HTTP 503';
  const reason = evidence => checkFailures({ passed: false, evidence })[0];
  assert.equal(reason(prefix + ' ({"error":{"message":"Service is starting."}})'), prefix + '. Service is starting.');
  for (const body of ['({"error":', '({"retry":true})', '(Service unavailable)', '({"message":4})']) {
    assert.equal(reason(prefix + ' ' + body), prefix + ' ' + body);
  }
  const unrelated = 'Upload returned HTTP 403 ({"error":"Upload rejected."})';
  assert.equal(reason(unrelated), unrelated);
});

test('reviewers retain their actual report and exact output while stale, missing and disconnected evidence remains scoped', () => {
  const result = event(8, 'task.completed', 'reviewer', 2, { revision: 'b', passed: false, summary: 'Reviewed upload and export.',
    findings: ['export.mjs drops the last phrase.', 'The correction timestamp is rounded.'] });
  const feature = { status: 'blocked', attempt: 2 };
  const html = featureDag(feature, [event(1, 'task.completed', 'engineer', 2, { revision: 'b', summary: 'Added export.', filesChanged: ['music.mjs', 'export.mjs'] }),
    event(2, 'agent.completed', 'reviewer', 2, {}), result,
    event(9, 'app.unhealthy', 'qa', 2, { revision: 'unrelated', evidence: 'Foreign health error' }),
    event(10, 'task.completed', 'qa', 2, { passed: false }), event(11, 'request.blocked', 'controller', 2, {}, [10])], path);
  const reviewer = step(html, 'reviewer-2'), qa = step(html, 'qa-2');
  assert.match(reviewer, /class="step-outcome"><strong>Why it failed<\/strong> Reviewed upload and export\./);
  assert.match(reviewer, /<summary>Agent output · 2 findings<\/summary><h4>Findings<\/h4>[\s\S]+export\.mjs drops the last phrase[\s\S]+The correction timestamp is rounded/);
  assert.doesNotMatch(reviewer, /class="step-next"|input#agent-output/);
  assert.match(qa, /could not confirm a verdict/);
  assert.doesNotMatch(qa, /Foreign health error|href="#event-9"/);
  assert.match(qa, /class="step-next"><strong>Next<\/strong> <a href="#stage-delivery">Stop without release/);
  assert.match(step(html, 'attempt-2'), /<h4>Changed files<\/h4>[\s\S]+music\.mjs[\s\S]+<summary>Technical details<\/summary>[\s\S]+Produced revision b with 2 changed files\./);
});

test('an inspected review puts its full conclusion and recorded next decision before findings and technical evidence', () => {
  const report = 'The recording imports successfully and the app retains its original audio. The detector splits the rendition at ordinary pauses, so pressing Play full song plays a fragment of the song.';
  const finding = 'Blocking — src/detect.mjs, segment: ' + report;
  function review(summary, revision = 'candidate') {
    const events = [
      event(3, 'task.completed', 'engineer', 1, { revision: 'candidate' }),
      event(6, 'task.completed', 'reviewer', 1, { revision, passed: false, summary, findings: [finding] }, [3]),
      event(7, 'repair.requested', 'controller', 1, {}, [6]),
    ];
    return step(featureDag(req, events, path), 'reviewer-1');
  }
  const html = review(report);
  assert.match(html, /data-step-title="Review code" data-step-context="First build" data-step-role="Code reviewer" data-step-result="Failed"/);
  const body = html.slice(html.indexOf('<div class="workflow-body">'));
  const headline = body.slice(0, body.indexOf('<p class="step-next">'));
  assert.ok(headline.includes(report));
  assert.doesNotMatch(headline, /…|Blocking —|src\/detect/);
  assert.match(body, /href="#stage-retry-1">Request changes for the first build[\s\S]+<summary>Agent output · 1 finding<\/summary>[\s\S]+Blocking — src\/detect/);
  const [primary, technical] = body.split('<summary>Technical details</summary>');
  assert.doesNotMatch(primary, /Check record|configuration and calls|step-revision|workflow-dependency/);
  assert.match(technical, /Build revision <code>candidate<\/code>[\s\S]+href="#event-6">Check record[\s\S]+reviewer configuration and calls[\s\S]+workflow-dependency/);
  assert.ok(review('').includes('<strong>Why it failed</strong> ' + finding + '</p>'));
  assert.ok(review(report, 'older').includes('<strong>Outcome</strong> This result refers to a different build revision.</p>'));
});
