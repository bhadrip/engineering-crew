import assert from 'node:assert/strict';
import test from 'node:test';
import { featurePreviewPage, featureRequestPage, featureRequestsPage } from '../ui/feature-views.mjs';

const project = { id: 'music', name: 'Music classes', featureOnly: true };
const date = '2026-11-24T02:12:00.000Z';
const base = '1'.repeat(40);
const revision = '2'.repeat(40);
const path = '/projects/music/requests/replay';
const predecessor = { featureId: 'lesson-import', revision: base, eventSeq: 46 };
const request = {
  id: 'replay', goal: 'Replay a correction.', createdAt: date, attempt: 1, status: 'running',
  phase: 'verify', plan: { base }, predecessor,
};

function event(seq, type, role, parents, evidence = {}) {
  return { seq, type, role, phase: 'verify', attempt: 1, status: 'running', at: date, parents, evidence };
}

function rows(page) {
  return new Map([...page.matchAll(/<li id="event-(\d+)"[^>]*>([\s\S]*?)<\/li>/g)]
    .map(([, seq, html]) => [Number(seq), html]));
}

test('trace preserves journal order, exact causal parents, input delivery and candidate evidence links', () => {
  const plan = { ...event(2, 'task.completed', 'planner', [1], { plan: { base } }), predecessor };
  const events = [
    event(6, 'candidate.verified', 'controller', [4, 5], { revision }),
    event(4, 'task.completed', 'qa', [3], { revision, passed: true }),
    plan,
    event(5, 'task.completed', 'security', [3], { revision, passed: true }),
    event(3, 'task.completed', 'engineer', [2], { base, revision }),
    event(1, 'request.created', 'controller', []),
  ];
  const page = featureRequestPage(project, { ...request, events });
  const items = rows(page);
  assert.deepEqual([...items.keys()], [1, 2, 3, 4, 5, 6]);
  assert.deepEqual([...items.get(6).matchAll(/<a href="#event-(\d+)"/g)].map(m => Number(m[1])), [4, 5]);
  assert.ok(items.get(2).includes('href="/projects/music/requests/lesson-import#event-46"'));
  assert.ok(items.get(2).includes(`Starting revision <code>${base}</code>`));
  assert.ok(items.get(3).includes(`href="${path}/attempts/1/changes"`));
  assert.match(items.get(4), />Passed<\/span>/);
  assert.match(items.get(4), /<strong>Run QA tests<\/strong>/);
  assert.match(items.get(4), /Run by: QA agent/);
  assert.equal((page.match(/>Candidate diff<\/a>/g) ?? []).length, 1);
  assert.ok(page.includes(`href="${path}/trace.json"`));
  assert.match(page, /id="trace-events" data-live-append data-terminal="false"/);
  assert.match(page, /data-live-section[^>]*id="request-summary"/);
});

test('missing or mismatched evidence leaves verdicts, links and previews unclaimed', () => {
  const wrongBase = { ...predecessor, revision };
  const old = { ...request, status: 'blocked', reason: 'Out of attempts', predecessor: wrongBase, events: [
    { ...event(1, 'task.completed', 'planner', [], { plan: { base } }), predecessor: wrongBase },
    event(2, 'task.completed', 'engineer', [1], { revision }),
    event(3, 'task.started', 'qa', [2], { summary: 'Tests should pass' }),
    event(4, 'app.test.completed', 'qa', [3], { passed: false }),
    event(5, 'request.blocked', 'controller', [4, 99], { message: 'Out of attempts' }),
  ] };
  const page = featureRequestPage(project, old);
  const items = rows(page);
  assert.doesNotMatch(page, /lesson-import|Built on delivery|Candidate diff|Open current app|>Passed<\/span>/);
  assert.match(items.get(4), />Failed<\/span>/);
  assert.match(items.get(5), /#99 \(unavailable\)/);
  assert.doesNotMatch(page, /href="#event-99"/);
  assert.match(page, /data-terminal="true"/);
  const completed = featureRequestPage(project, { ...old, status: 'completed', delivery: { revision } });
  assert.ok(completed.includes(`method="post" action="${path}/preview"`));
  assert.match(featureRequestPage(project, { ...request, canResume: true }), /Resume request/);
});

test('plain requests and evidence remain readable text and request history keeps durable links', () => {
  const input = '<img src=x onerror=alert(1)>';
  const longGoal = (input + '\n').repeat(12);
  const feature = { ...request, goal: longGoal, events: [event(1, 'task.failed', 'qa', [], { message: input })] };
  const history = featureRequestsPage(project, [
    { ...feature, id: 'older', createdAt: '2026-11-21T09:00:00Z' }, feature,
  ]);
  const page = featureRequestPage(project, feature);
  assert.ok(history.indexOf(`href="${path}"`) < history.indexOf('href="/projects/music/requests/older"'));
  assert.doesNotMatch(history + page, /<img/);
  assert.match(page, /id="original-request"/);
  assert.match(rows(page).get(1), /<p class="trace-message">&lt;img src=x onerror=alert\(1\)&gt;<\/p>/);
  assert.match(history, /id="request-list" data-live-section/);
  assert.throws(() => featurePreviewPage('http://127.0.0.1:5601/?redirect=elsewhere'));
  assert.throws(() => featurePreviewPage('https://example.org/'));
  assert.match(featurePreviewPage('http://127.0.0.1:5601'), /data-open-preview href="http:\/\/127\.0\.0\.1:5601\/"/);
});

test('completed deliveries keep polling through the initial preview and retain each preview outcome', () => {
  const delivered = event(6, 'request.completed', 'controller', [5], { revision });
  const failure = event(7, 'app.preview.failed', 'controller', [6], { revision, message: 'Health check timed out' });
  const ready = event(8, 'app.preview.ready', 'controller', [6], { revision, url: 'http://127.0.0.1:5601' });
  const feature = { ...request, status: 'completed', delivery: { revision }, events: [delivered] };
  const legacy = featureRequestPage(project, feature);
  const pending = featureRequestPage(project, { ...feature, previewStatus: 'pending' });
  assert.match(legacy, /data-terminal="true"/);
  assert.doesNotMatch(legacy, /Local preview pending/);
  assert.match(pending, /data-terminal="false"/);
  assert.match(pending, /Local preview pending/);
  const failed = featureRequestPage(project, { ...feature, events: [delivered, failure], previewStatus: 'failed' });
  assert.match(failed, /data-terminal="true"/);
  assert.ok(failed.includes(`method="post" action="${path}/preview"><button type="submit">Retry local preview`));
  assert.match(failed, /href="#event-7">Preview record<\/a>/);
  assert.match(failed, /Start local preview[^"]*Result: Failed to start/);
  assert.match(rows(failed).get(7), /Health check timed out/);
  const recovered = featureRequestPage(project, { ...feature, events: [delivered, failure, ready], previewStatus: 'ready' });
  assert.match(recovered, /data-terminal="true"/);
  assert.match(recovered, /href="#event-8">Preview record<\/a>/);
  assert.match(recovered, /Start local preview[^"]*Result: Ready/);
  assert.match(rows(recovered).get(8), /Follows <a href="#event-6">Request completed #6<\/a>/);
  assert.match(recovered, /Local preview ready/);
  assert.match(recovered, />Open current app<\/button>/);
  assert.doesNotMatch(recovered, />Retry local preview<\/button>/);
});

test('overview explains the final observed product failure and engineer stop without a manual approval loop', () => {
  const e = (seq, type, role, parents, evidence) => ({ ...event(seq, type, role, parents, evidence), attempt: 3 });
  const record = { ...request, id: 'lesson-replay', status: 'blocked', attempt: 3, limits: {maxAttempts:3},
    reason: 'All required checks did not pass.', events: [
      e(167, 'repair.requested', 'controller', [], {feedback:[]}),
      e(230, 'app.probe.completed', 'engineer', [], {passed:false, lessons:[{fixture:'lesson', passed:false,
        fullRenditionMatched:false, correctionMatched:false, phrasePaired:false, saved:true, sameAudio:true}]}),
      e(260, 'tool.called', 'engineer', [], {action:'edit', turn:14}),
      e(261, 'tool.completed', 'engineer', [260], {action:'edit', revision}),
      e(263, 'task.failed', 'engineer', [261], {message:'Engineer exhausted its workspace turn budget before submitting a tested candidate'}),
      e(264, 'request.blocked', 'controller', [263], {message:'All required checks did not pass.'}),
    ] };
  const page = featureRequestPage(project, record);
  const summary = page.match(/<section class="feature-summary"[\s\S]*?<\/section>/)[0];
  assert.match(page, /<h1>Lesson replay<\/h1>/);
  assert.match(summary, /Attempt 3 of 3/);
  assert.match(summary, /href="#event-230">Song and correction detection failed/);
  assert.match(summary, /Lesson storage and original audio replay passed/);
  assert.match(summary, /the teacher’s full rendition, the spoken correction, and the linked practice phrase/);
  assert.match(summary, /href="#event-263">Engineer reached its 14-step limit/);
  assert.match(summary, /href="\/projects\/music\/requests#new-request">Create a follow-up request/);
  assert.doesNotMatch(summary, /All required checks|Request blocked|Start request/);
  const edit = rows(page).get(261);
  assert.match(edit, /<details id="evidence-261">[\s\S]*href="\/projects\/music\/requests\/lesson-replay\/events\/261\/changes">View edit/);
  assert.match(page, /id="event-261" class="trace-event trace-detail"/);
  assert.match(page, /id="event-230" class="trace-event trace-milestone" tabindex="-1" data-milestone/);
  assert.match(page, /name="trace-view" value="milestones" checked>Milestones/);
  assert.match(page, /name="trace-view" value="all">All events/);
  assert.match(page, /<details class="feature-details" id="request-details">[\s\S]*All required checks/);
});

test('repair reports link the failed result and prefer its real diagnostics over passing TAP output', () => {
  const qa = {passed:false, checks:[{check:'Author tests', passed:true, output:'TAP 400 passes'},
    {check:'Operator acceptance', passed:false, evidence:'Class upload returned HTTP 415'}]};
  const feature = {...request, attempt:2, status:'running', limits:{maxAttempts:3}, events:[
    event(2, 'task.completed','qa',[],qa),
    event(3, 'task.completed','security',[],{passed:true}),
    event(4, 'repair.requested','controller',[2,3],{feedback:[{role:'qa',...qa}]}),
    {...event(5, 'task.started','engineer',[4]), phase:'build', attempt:2},
    {...event(6, 'agent.thread','engineer',[5],{threadId:'session-6'}), phase:'build', attempt:2},
  ]};
  const page = featureRequestPage(project, feature);
  const summary = page.match(/<section class="feature-summary"[\s\S]*?<\/section>/)[0];
  assert.match(summary, />Active · Engineer<\/span>/);
  assert.match(summary, /Attempt repair 1 · Started/);
  assert.match(summary, /href="#event-2">Last issue · QA agent/);
  assert.match(summary, /Class upload returned HTTP 415/);
  assert.doesNotMatch(summary, /Agent session recorded|TAP 400/);
  const repair = rows(page).get(4).split('<details')[0];
  assert.match(repair, /href="#event-2">QA agent finding/);
  assert.match(repair, /Class upload returned HTTP 415/);
  assert.doesNotMatch(repair, /TAP 400|Security reviewer finding/);
});

test('active request precedes history and new-request disclosure is compact until opened', () => {
  const uuid = 'e52e394b-6e82-47e1-a690-64b319445b92';
  const current = {...request, id:uuid, goal:'Replay a spoken correction. Later requirements follow.', createdAt:date};
  const completed = {...request, id:'archive-a-lesson',status:'completed',createdAt:'2026-11-25T02:12:00.000Z'};
  const page = featureRequestsPage(project,[completed,current]);
  assert.match(page, /<details id="new-request" class="new-request"><summary>New request/);
  assert.ok(page.indexOf('/requests/'+uuid) < page.indexOf('/requests/archive-a-lesson'));
  assert.match(page, /Replay a spoken correction\.<\/a>/);
  assert.match(featureRequestPage(project,current), /<h1>Replay a spoken correction\.<\/h1>/);
  assert.match(featureRequestsPage(project,[]), /id="new-request" class="new-request" open/);
});

test('a failed lesson probe exposes its own attempt, observed and expected timings, correction words, and return path', () => {
  const lesson = {fixture:'Practice lesson', passed:false, fullRenditionMatched:false, correctionMatched:false,
    expectedTeacherRendition:{start:11.123456,end:22.5}, observedSong:{start:9,end:13},
    expectedCorrection:{start:27,end:30,text:'Hold <the final note> for two counts.'},
    corrections:[{start:25,end:26.5,text:'Hold the note.',phraseStart:11.1,phraseEnd:13.25}],
    expectedPhraseOptions:[{start:12,end:13.4},{start:18,end:20.1}]};
  const fixture = event(230,'app.probe.completed','engineer',[],{passed:false,lessons:[lesson]});
  const page = featureRequestPage(project,{...request,status:'blocked',attempt:2,events:[
    fixture, {...event(263,'task.failed','engineer',[230],{message:'No tested candidate'}),attempt:2},
    {...event(264,'request.blocked','controller',[263],{message:'No tested candidate'}),attempt:2}]});
  assert.match(page, /id="request-overview" tabindex="-1"/);
  assert.match(page, /href="#event-230">Song and correction detection failed on attempt 1/);
  const row = rows(page).get(230);
  assert.match(row, /class="trace-return" href="#request-overview">Back to overview/);
  assert.match(row, /<details id="evidence-230" data-probe-evidence><summary>Recorded evidence<\/summary>/);
  const [structured, raw] = row.split('<details><summary>Raw JSON</summary>');
  assert.match(structured, /Expected full rendition<\/dt><dd>11\.123–22\.5 s/);
  assert.match(structured, /Observed full rendition<\/dt><dd>9–13 s/);
  assert.match(structured, /27–30 s · “Hold &lt;the final note&gt; for two counts\.”/);
  assert.match(structured, /25–26\.5 s · “Hold the note\.” · Linked phrase 11\.1–13\.25 s/);
  assert.match(structured, /12–13\.4 s · 18–20\.1 s/);
  assert.match(raw, /expectedTeacherRendition/);
  const missing = rows(featureRequestPage(project,{...request,events:[
    event(4,'app.probe.completed','qa',[],{passed:false,lessons:[{fixture:'Private fixture', passed:false,
      fullRenditionMatched:false}]})]})).get(4);
  assert.doesNotMatch(missing,/timing comparison|Invalid time range|None returned|Expected correction/);
  assert.match(missing,/<details><summary>Raw JSON<\/summary>/);
});
