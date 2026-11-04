import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assignment, json, loadSuite, score } from '../evals/run.mjs';
import { checkEvals } from '../evals/check.mjs';

const entry = json('evals/registry.json')['security-engineer'];

test('the active Crew skills have passing, reproducible eval evidence', checkEvals);

test('the security review grader rejects unsupported findings and distinguishes review blocking from release blocking', async () => {
  const suite = await loadSuite(entry.suite);
  const item = suite.cases.find(item => item.id === 'order-summary');
  const decision = findings => ({ outcome: 'completed', response: {
    state: 'completed', summary: 'Reviewed the supplied candidate.',
    outputs: [{ slot: 'findings', content: JSON.stringify(findings) }], questions: [], blockers: [], decisions: [],
  } });
  const crossTenant = { id: 'unscoped-order', title: 'Cross-tenant read', severity: 'blocker',
    evidence: 'server/orders.js uses orderId alone, so any tenant can fetch another tenant’s address.' };
  const logLeak = { id: 'session-in-logs', title: 'Logs expose session credentials', severity: 'blocker',
    evidence: 'server/orders.js adds the Authorization header to audit.info. Support readers can replay the bearer token.' };
  const valid = decision([crossTenant, logLeak]);
  assert.equal(score(suite, item, valid).pass, true);
  assert.equal(score(suite, item, decision([crossTenant])).pass, false);
  assert.equal(score(suite, item, decision([crossTenant, { ...logLeak, severity: 'backlog' }])).pass, false);
  const clean = suite.cases.find(item => item.id === 'catalog-label-text');
  assert.equal(score(suite, clean, decision([crossTenant])).pass, false);
  assert.equal(score(suite, clean, decision([])).pass, true);
  const blocked = structuredClone(valid);
  blocked.response.blockers = ['Block the release'];
  assert.equal(score(suite, item, blocked).pass, false);
});

test('the live assignment carries no case ID, expected findings, or grader instructions', async () => {
  const suite = await loadSuite(entry.suite);
  const item = suite.cases.find(item => item.id === 'thumbnail-redirect');
  const packet = assignment(suite, item);
  assert.deepEqual(packet.inputs.map(input => input.id), ['approved-plan', 'candidate-diff']);
  assert.match(packet.inputs[1].content, /redirect: 'follow'/);
  assert.doesNotMatch(JSON.stringify(packet), /thumbnail-redirect|rubric|transfer/);
});

test('SDM cases use distinct production slots and the QA grader rejects a leaked author oracle', async () => {
  const sdm = json('evals/registry.json').sdm;
  const suite = await loadSuite(sdm.suite);
  const qa = suite.cases.find(item => item.id === 'qa-exact-candidate');
  const plan = suite.cases.find(item => item.id === 'small-cli-slice');
  const packet = assignment(suite, qa);
  assert.equal(packet.task.outputs[0].id, 'qa-packet');
  assert.equal(assignment(suite, plan).task.outputs[0].id, 'plan');
  assert.deepEqual(packet.inputs.map(input => input.id), ['candidate', 'check-receipt', 'criteria']);
  assert.doesNotMatch(JSON.stringify(packet), /qa-exact-candidate|rubric|transfer/);

  const commit = JSON.parse(packet.inputs[0].content).commit;
  const content = `QA candidate ${commit}. CAT-1 --list-pets JSON to stdout. CAT-2 no args greets. CAT-3 exits 2 and writes usage to stderr.`;
  const observation = { outcome: 'completed', response: { state: 'completed', summary: 'Independent QA scope',
    outputs: [{ slot: 'qa-packet', content }], decisions: [], blockers: [], questions: [] } };
  assert.equal(score(suite, qa, observation).pass, true);
  observation.response.outputs[0].content += ' Run author fixture AUTHOR_HIDDEN_ORACLE_887.';
  assert.deepEqual(score(suite, qa, observation).issues, ['Leaked author-only implementation detail']);
  assert.equal(score(suite, suite.cases.find(item => item.id === 'qa-stale-receipt'), observation).pass, false);
});
