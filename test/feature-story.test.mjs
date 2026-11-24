import test from 'node:test';
import assert from 'node:assert/strict';
import { featureStory } from '../ui/feature-story.mjs';

const event = (seq, type, role, attempt, evidence = {}) => ({ seq, type, role, attempt, evidence });
const plain = html => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').replace(/ \./g, '.').trim();
const plan = event(7, 'task.completed', 'planner', 0, {
  plan: { steps: Array(10).fill('Implement a planned action.'), acceptance: Array(8).fill('Check a result.') },
});
const build = (seq, attempt, revision) => event(seq, 'task.completed', 'engineer', attempt, { revision });

test('the stopped pilot story distinguishes produced builds, independent check verdicts and the release decision', () => {
  const events = [plan, build(61, 1, 'first'),
    ...['qa', 'security', 'reviewer'].map((role, i) => event(85 + i, 'task.completed', role, 1, { revision: 'first', passed: false })),
    event(96, 'repair.requested', 'controller', 1), build(130, 2, 'second'),
    ...['qa', 'security', 'reviewer'].map((role, i) => event(140 + i, 'task.completed', role, 2, { revision: 'second', passed: role === 'security' })),
    event(167, 'repair.requested', 'controller', 2), event(263, 'task.failed', 'engineer', 3), event(264, 'request.blocked', 'controller', 3)];
  const story = featureStory({ status: 'blocked' }, events.reverse());
  assert.match(plain(story), /The planner laid out 10 steps and 8 checks\. The engineer produced two builds for checking\. The QA agent and code reviewer found issues in both builds\. Security review passed on repair 1\. The Crew controller requested 2 repairs and stopped before release\./);
  for (const id of ['stage-planning', 'stage-attempt-1', 'stage-attempt-2', 'event-167', 'event-264']) assert.ok(story.includes('href="#' + id + '"'));
  assert.equal(story.match(/<li>/g).length, 3);
  assert.doesNotMatch(story, /succeeded|repair passed|Planner assigned|3 builds|delivered the change/);
});

test('only a completed engineering stage with a revision counts as a produced build, which can still be unverified', () => {
  const events = [plan, event(8, 'task.started', 'engineer', 1), event(9, 'task.completed', 'engineer', 1),
    event(10, 'task.failed', 'engineer', 2, { revision: 'in-progress' })];
  assert.doesNotMatch(plain(featureStory({ status: 'blocked' }, events)), /produced|succeeded/);
  const afterRepair = [...events, build(11, 3, 'repaired')];
  const text = plain(featureStory({ status: 'running' }, afterRepair));
  assert.match(text, /The engineer produced one build for checking\. No independent check results were recorded for repair 2\./);
  assert.doesNotMatch(text, /succeeded|passed/);
});

test('a missing verdict or a mismatched revision on either build keeps the summary scoped to one attempt', () => {
  for (const verdict of [{ revision: 'first' }, { revision: 'another', passed: true }]) {
    const events = [plan, build(61, 1, 'first'), event(85, 'task.completed', 'qa', 1, verdict),
      build(130, 2, 'second'), event(140, 'task.completed', 'qa', 2, { revision: 'second', passed: true })];
    const text = plain(featureStory({ status: 'running' }, events));
    assert.match(text, /QA tests passed on repair 1/);
    assert.doesNotMatch(text, /both builds/);
  }
});

test('a review still running, a stopped reviewer and a verified build have distinct accounts', () => {
  const input = [plan, build(61, 1, 'first'), event(62, 'task.started', 'qa', 1),
    event(63, 'task.failed', 'security', 1, { message: 'Worker stopped' })];
  const text = plain(featureStory({ status: 'running', attempt: 1 }, input));
  assert.match(text, /The QA agent is still checking the first build/);
  assert.match(text, /The security reviewer stopped before returning a verdict on the first build/);
  assert.doesNotMatch(text, /found issues|passed|succeeded/);
  assert.doesNotMatch(plain(featureStory({ status: 'blocked' }, input)), /still checking/);
  const verdicts = ['qa', 'security', 'reviewer'].map((role, i) => event(80 + i, 'task.completed', role, 1, { revision: 'first', passed: true }));
  assert.match(plain(featureStory({ status: 'running' }, [...input, ...verdicts])), /All three independent checks passed on the first build/);
});

test('the summary uses the same after-build and recorded-revision checks as the stage card', () => {
  const results = [plan, event(50, 'task.completed', 'qa', 1, { passed: false, revision: 'first' }), build(61, 1, 'first'),
    { ...event(71, 'task.completed', 'reviewer', 1, { passed: true }), revision: 'first' },
    { ...event(72, 'task.completed', 'security', 1, { passed: false }), revision: 'stale' }];
  const text = plain(featureStory({ status: 'completed' }, results));
  assert.match(text, /Code review passed on the first build/);
  assert.doesNotMatch(text, /security reviewer|QA agent|found issues/);
});

test('an ongoing repair is attributed to an actual engineer start and only roles assigned on that build are named', () => {
  const events = [plan, build(61, 1, 'first'), event(85, 'task.completed', 'qa', 1, { revision: 'first' }),
    event(86, 'task.completed', 'security', 1, { revision: 'other' }), event(96, 'repair.requested', 'controller', 1)];
  const status = { status: 'running' };
  assert.doesNotMatch(plain(featureStory(status, events)), /working on the latest repair|security|code review|delivered/);
  events.push(event(97, 'task.started', 'engineer', 2));
  assert.match(featureStory(status, events), /href="#stage-attempt-2">working on the latest repair/);
  assert.doesNotMatch(featureStory({ ...status, canResume: true }, events), /working on the latest repair/);
});

test('queued, failed planning, delivery and incomplete records each make only grounded claims', () => {
  const queued = featureStory({ status: 'queued' }, [event(1, 'request.created', 'controller', 0)]);
  assert.match(plain(queued), /received the request\. Planning is queued/);
  assert.doesNotMatch(queued, /submitted|assigned/);
  const failed = featureStory({ status: 'blocked' }, [event(6, 'task.failed', 'planner', 0), event(7, 'request.blocked', 'controller', 0)]);
  assert.match(plain(failed), /stopped before handing off a plan/);
  assert.doesNotMatch(failed, /steps|checks|submitted|assigned/);
  const delivered = featureStory({ status: 'completed' }, [plan, build(61, 1, 'first'), event(100, 'request.completed', 'controller', 1)]);
  assert.match(delivered, /href="#event-100">delivered the change/);
  assert.doesNotMatch(featureStory({ status: 'completed' }, []), /delivered|passed|verified/);
  assert.doesNotMatch(featureStory({ status: 'running' }, [event(2, 'task.started', 'planner', 0)]), /handed off|laid out/);
});
