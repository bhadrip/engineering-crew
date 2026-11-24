import assert from 'node:assert/strict';
import test from 'node:test';
import { featureDag } from '../ui/feature-dag.mjs';

const event = (seq, type, role, attempt, parents, evidence = {}, phase) => ({ seq, type, role, attempt, parents, evidence, phase });
const request = { status: 'blocked', attempt: 2 };
function edges(html) {
  return [...html.matchAll(/class="workflow-dependency" data-from="([^"]+)" data-to="([^"]+)"/g)].map(([, from, to]) => from + ' → ' + to).sort();
}
function cards(html) {
  const result = new Map();
  for (const level of html.split('<li class="workflow-level').slice(1)) {
    const row = Number(level.match(/data-level="(\d+)"/)[1]);
    for (const node of level.split('<details class="workflow-step"').slice(1)) {
      const key = node.match(/data-key="([^"]+)"/)[1];
      result.set(key, { row, html: node, summary: node.match(/<summary [^>]*>([\s\S]*?)<\/summary>/)[1] });
    }
  }
  return result;
}

test('real parent chains collapse into a build fork, three review lanes, a repair join and a terminal stop', () => {
  const events = [
    event(1, 'request.created', 'controller', 0, []),
    event(2, 'request.started', 'controller', 0, [1]),
    event(3, 'task.started', 'planner', 0, [2]),
    event(6, 'agent.completed', 'planner', 0, [3]),
    event(7, 'task.completed', 'planner', 0, [6], { plan: 'Build a library.' }),
    event(8, 'task.started', 'engineer', 1, [7]),
    event(22, 'tool.completed', 'engineer', 1, [8]),
    event(25, 'task.completed', 'engineer', 1, [22], { revision: 'v1' }),
    event(26, 'task.started', 'qa', 1, [25]),
    event(27, 'task.started', 'reviewer', 1, [25]),
    event(28, 'task.started', 'security', 1, [25]),
    event(31, 'agent.activity', 'qa', 1, [26]),
    event(35, 'task.completed', 'reviewer', 1, [27], { passed: false, revision: 'v1' }),
    event(36, 'task.completed', 'security', 1, [28], { passed: true, revision: 'v1' }),
    event(37, 'task.completed', 'qa', 1, [31], { passed: false, revision: 'v1' }),
    event(40, 'repair.requested', 'controller', 1, [37, 35, 36]),
    event(41, 'task.started', 'engineer', 2, [40]),
    event(44, 'agent.started', 'engineer', 2, [41]),
    event(46, 'task.failed', 'engineer', 2, [44]),
    event(47, 'request.blocked', 'controller', 2, [46]),
  ];
  const page = featureDag(request, events.toReversed());
  assert.match(page, /id="workflow" tabindex="-1"/);
  assert.match(page, /Open a step to see its evidence/);
  const nodes = cards(page);
  assert.deepEqual([...nodes.keys()], ['intake', 'planning', 'build-1', 'qa-1', 'reviewer-1', 'security-1', 'retry-1', 'build-2', 'stop']);
  assert.deepEqual(edges(page), [
    'intake → planning', 'planning → build-1', 'build-1 → qa-1', 'build-1 → reviewer-1', 'build-1 → security-1',
    'qa-1 → retry-1', 'reviewer-1 → retry-1', 'security-1 → retry-1', 'retry-1 → build-2', 'build-2 → stop',
  ].sort());
  assert.match(nodes.get('planning').html, /id="stage-planning".*?data-tone="success"/);
  assert.match(nodes.get('planning').summary, />Plan the work<\/span> <span class="workflow-owner">Run by: Planner<\/span> <span class="workflow-result">Result: Succeeded</);
  assert.match(nodes.get('build-1').html, /id="stage-attempt-1"[\s\S]*?Build first version\. Run by: Engineer\. Result: Succeeded/);
  assert.match(nodes.get('qa-1').html, /aria-label="Run QA tests for the first build\. Run by: QA agent\. Result: Failed\./);
  assert.match(nodes.get('qa-1').html, /href="#event-37">Check record/);
  assert.match(nodes.get('retry-1').html, /Request changes for the first build\. Run by: Crew controller\. Result: Changes requested/);
  assert.match(nodes.get('security-1').summary, />Run by: Security reviewer</);
  assert.match(nodes.get('security-1').summary, />Result: Passed</);
  assert.equal(nodes.get('qa-1').row, nodes.get('reviewer-1').row);
  assert.equal(nodes.get('qa-1').row, nodes.get('security-1').row);
  assert.match(page, /workflow-branches workflow-connected"[\s\S]*?Independent checks <span>for the first build/);
  assert.match(page, /workflow-join workflow-connected"[^>]*><details[^>]*id="stage-retry-1"/);
  assert.match(nodes.get('retry-1').html, /href="#event-40">Repair decision/);
  assert.match(nodes.get('build-2').summary, />Result: Stopped</);
  assert.match(nodes.get('stop').html, /id="stage-delivery"[\s\S]*?Result: No release[\s\S]*?href="#event-47"/);
  const next = node => node.html.match(/<p class="step-next">([\s\S]*?)<\/p>/)?.[1] ?? '';
  const targets = node => Array.from(next(node).matchAll(/href="#([^"]+)"/g), match => match[1]);
  assert.deepEqual(targets(nodes.get('planning')), ['stage-attempt-1']);
  assert.deepEqual(targets(nodes.get('build-1')), ['stage-qa-1', 'stage-reviewer-1', 'stage-security-1']);
  assert.deepEqual(targets(nodes.get('retry-1')), ['stage-attempt-2']);
  assert.deepEqual(targets(nodes.get('build-2')), ['stage-delivery']);
  assert.deepEqual(targets(nodes.get('stop')), []);
  assert.match(page, /aria-label="Workflow layout"[\s\S]*?data-workflow-layout="graph"[\s\S]*?>DAG<\/button>[\s\S]*?data-workflow-layout="list"/);
  assert.match(page, /<svg class="workflow-wires" aria-hidden="true"/);
  assert.equal((page.match(/id="stage-attempt-1"/g) ?? []).length, 1);
  assert.doesNotMatch(page, /workflow-story|journey-stage|technical-trace|tool\.completed|Some earlier events are unavailable/);
  const ids = Array.from(page.matchAll(/ id="([^"]+)"/g), entry => entry[1]);
  assert.equal(ids.length, new Set(ids).size);
  for (const id of page.matchAll(/class="workflow-dependency"[^>]*href="#([^"]+)"/g)) assert.ok(ids.includes(id[1]));
});

test('partial or disconnected histories have only the edges supported by the journal', () => {
  const html = featureDag({ status: 'running', attempt: 1 }, [
    event(4, 'task.completed', 'engineer', 1, [], { revision: 'a' }),
    event(5, 'task.started', 'security', 1, []),
    event(6, 'runtime.started', 'qa', 1, [3]),
    event(7, 'task.completed', 'qa', 1, [6], { revision: 'b', passed: true }),
    event(8, 'repair.requested', 'controller', 1, [7, 144]),
  ]);
  assert.deepEqual(edges(html), ['qa-1 → retry-1']);
  assert.match(html, /Some earlier events are unavailable/);
  const nodes = cards(html);
  assert.doesNotMatch(html, /workflow-branches/);
  assert.equal(nodes.has('reviewer-1'), false);
  assert.equal(nodes.has('planning'), false);
  assert.equal(nodes.has('delivery'), false);
  assert.match(nodes.get('qa-1').summary, /Different build/);
  assert.match(nodes.get('security-1').summary, /In progress/);
  assert.doesNotMatch(nodes.get('security-1').summary, /Passed/);
  const missing = cards(featureDag(request, [event(10, 'task.completed', 'engineer', 1, [], { revision: ' ' })]));
  assert.match(missing.get('build-1').html, /data-tone="neutral"[\s\S]*>Result: Unavailable<\/span>/);
  assert.doesNotMatch(missing.get('build-1').html, /Succeeded/);
});

test('explicit reviewer dependencies use separate rows; delivery and the latest preview follow their own records', () => {
  const html = featureDag({ status: 'completed', attempt: 1 }, [
    event(1, 'task.completed', 'engineer', 1, [], { revision: 'a' }),
    event(2, 'task.completed', 'qa', 1, [1], { passed: true, revision: 'a' }),
    event(3, 'task.completed', 'security', 1, [2], { passed: true, revision: 'a' }),
    event(4, 'candidate.verified', 'controller', 1, [2, 3]),
    event(5, 'task.started', 'controller', 1, [4], {}, 'promote'),
    event(6, 'task.completed', 'controller', 1, [5], { revision: 'a' }, 'promote'),
    event(7, 'request.completed', 'controller', 1, [6], {}, 'promote'),
    event(8, 'app.preview.failed', 'controller', 1, [7]),
    event(15, 'app.preview.ready', 'controller', 1, [7]),
  ]);
  const nodes = cards(html);
  assert.ok(nodes.get('qa-1').row < nodes.get('security-1').row);
  assert.deepEqual(edges(html), ['build-1 → qa-1', 'qa-1 → security-1', 'qa-1 → verified-1', 'security-1 → verified-1', 'verified-1 → delivery', 'delivery → preview'].sort());
  assert.match(nodes.get('delivery').html, /id="stage-delivery"[\s\S]*Released/);
  assert.match(nodes.get('qa-1').html, /class="step-next">[^<]*<strong>Next<\/strong> <a href="#stage-security-1">[^<]*<\/a> · <a href="#stage-verified-1">/);
  assert.match(nodes.get('verified-1').html, /class="step-next"><strong>Next<\/strong> <a href="#stage-delivery">Deliver build/);
  assert.match(nodes.get('delivery').html, /class="step-next"><strong>Next<\/strong> <a href="#stage-preview">Start local preview/);
  assert.match(nodes.get('preview').html, /Result: Ready[\s\S]*href="#event-15"/);
  assert.doesNotMatch(html, /Failed to start|href="#event-8"|No release/);
});

test('queued and interrupted requests never show a future build, review, or delivery', () => {
  const empty = featureDag({ status: 'queued' }, []);
  assert.equal(cards(empty).size, 0);
  assert.match(empty, /first stage/);
  const queued = featureDag({ status: 'queued', attempt: 0 }, [event(1, 'request.created', 'controller', 0, [])]);
  assert.deepEqual([...cards(queued).keys()], ['intake']);
  const paused = featureDag({ status: 'running', attempt: 0, canResume: true }, [
    event(5, 'task.started', 'planner', 0, []), event(6, 'task.resumed', 'planner', 0, [5]),
  ]);
  assert.match(cards(paused).get('planning').summary, /Paused/);
  assert.deepEqual(edges(paused), []);
});

test('the repair step shows which independent checks failed when independent QA and code review reject the revised build', () => {
  const run = { status: 'blocked', attempt: 3 };
  const events = [event(60, 'task.completed', 'engineer', 1, [], { revision: 'first' }),
    event(90, 'repair.requested', 'controller', 1, [60]),
    event(130, 'task.completed', 'engineer', 2, [90], { revision: 'repair' }),
    event(145, 'task.completed', 'security', 2, [130], { revision: 'repair', passed: true }),
    event(148, 'task.completed', 'reviewer', 2, [130], { revision: 'repair', passed: false }),
    event(166, 'task.completed', 'qa', 2, [130], { revision: 'repair', passed: false }),
    event(167, 'repair.requested', 'controller', 2, [166, 148, 145]),
    event(170, 'task.started', 'engineer', 3, [167]),
    event(171, 'request.blocked', 'controller', 3, [170])];
  const nodes = cards(featureDag(run, events));
  assert.match(nodes.get('build-1').summary, /Result: Succeeded/);
  assert.match(nodes.get('build-2').html, /data-tone="warning"[\s\S]+Attempt repair 1\. Run by: Engineer\. Result: Checks failed/);
  assert.match(nodes.get('build-2').html, /QA and code review failed\. Security passed\./);
  assert.match(nodes.get('build-3').summary, /Result: Stopped/);
  const incomplete = cards(featureDag({ status: 'running', attempt: 2 }, [
    events[2], events[3], { ...events[4], evidence: { passed: true } }, { ...events[5], evidence: { revision: 'repair', passed: true } },
  ]));
  assert.match(incomplete.get('reviewer-2').summary, /Result: Unavailable/);
  assert.match(incomplete.get('build-2').summary, /Result: Checks incomplete/);
});
