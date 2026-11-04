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
