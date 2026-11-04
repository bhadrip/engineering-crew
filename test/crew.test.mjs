import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { gitControl, readProject } from '../lib/git-control.mjs';
import { validateProject } from '../lib/contracts.mjs';
import { runStore } from '../lib/run-store.mjs';
import { decide, dispatch, findArtifact, newRun, summarize, workspaceCatalog } from '../lib/workflow.mjs';

const config = 'examples/hello-world/crew.project.json';

async function fixture(t) {
  const repo = await mkdtemp(join(tmpdir(), 'crew-test-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  await mkdir(join(repo, 'examples'));
  await cp(new URL('../examples/hello-world', import.meta.url), join(repo, 'examples/hello-world'), { recursive: true });
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
  git('init', '-q');
  git('add', 'examples');
  git('-c', 'user.name=Crew Test', '-c', 'user.email=crew@example.invalid', 'commit', '-qm', 'Pilot');
  const control = gitControl(repo);
  return { repo, git, control, snapshot: readProject(control, config) };
}

test('project inputs come from the pinned Git commit and the catalog groups projects independently', async t => {
  const { repo, control, snapshot } = await fixture(t);
  await writeFile(join(repo, 'examples/hello-world/pet-store-brief.md'), 'Uncommitted change');
  const first = newRun(readProject(control, config), 'first', config);
  assert.equal(first.sourceCommit, snapshot.sourceCommit);
  assert.match(findArtifact(first, 'input-brief').content, /Mochi the cat/);
  assert.equal(first.tasks[0].packet.profileRef.id, 'catalog-product');
  const second = structuredClone(first);
  second.id = 'second';
  second.project.id = 'another-project';
  assert.equal(workspaceCatalog([first, second]).length, 2);
});

test('permission requests beyond the input-only runtime are rejected before dispatch', async t => {
  const { repo, git, control, snapshot } = await fixture(t);
  snapshot.project.tasks[0].permissions.writePaths.push('examples/hello-world/hello.mjs');
  await writeFile(join(repo, config), JSON.stringify(snapshot.project));
  git('add', config);
  git('-c', 'user.name=Crew Test', '-c', 'user.email=crew@example.invalid', 'commit', '-qm', 'Request write access');
  assert.throws(() => readProject(control, config), /input-only permissions/);
});

test('an incomplete result needs rework and acceptance requires evidence from the new attempt', async t => {
  const { control, snapshot } = await fixture(t);
  const store = runStore(control.gitDir, 'test-run');
  await store.create(newRun(snapshot, 'test-run', config));
  const receipt = { usage: { input: 50, output: 10, total: 60, source: 'test' } };
  const result = { state: 'completed', summary: 'Criteria prepared', decisions: [], questions: [], blockers: [], outputs: [] };
  const run = () => dispatch(store, 'product-review', undefined, undefined, async ({ task }) => {
    assert.equal(task.rework?.note, result.outputs.length ? 'Return the criteria.' : undefined);
    return { outcome: 'completed', receipt, response: result };
  });

  const first = await run();
  assert.equal(first.outcome, 'invalid-result');
  await assert.rejects(decide(store, 'product-review', first.id, 'accepted', 'Ready'), /valid outputs/);
  await assert.rejects(run(), /Record a rework decision/);
  await decide(store, 'product-review', first.id, 'rework', 'Return the criteria.');

  result.outputs = [{ slot: 'criteria', content: '### CAT-1\nList the available pets.' }];
  const second = await run();
  assert.equal(second.outcome, 'completed');
  assert.equal(summarize(await store.read()).tasks[0].attempts[1].evidenceStatus, 'recorded');
  await store.update(record => {
    findArtifact(record, second.receiptId).content = 'Tampered receipt';
  });
  const incomplete = await store.read();
  assert.equal(summarize(incomplete).tasks[0].attempts[1].evidenceStatus, 'missing');
  assert.equal(workspaceCatalog([incomplete])[0].epics[0].runs[0].handoffs.attention, 1);
  await assert.rejects(decide(store, 'product-review', second.id, 'accepted', 'Ready'), /evidence/);
});

test('the plan joins only accepted reviews and pins both upstream artifacts', async t => {
  const { control, snapshot } = await fixture(t);
  const store = runStore(control.gitDir, 'join');
  await store.create(newRun(snapshot, 'join', config));
  const receipt = { threadId: 'offline-test' };
  const complete = (slot, content) => ({ outcome: 'completed', receipt,
    response: { state: 'completed', summary: content, decisions: [], questions: [], blockers: [], outputs: [{ slot, content }] } });
  const product = await dispatch(store, 'product-review', undefined, undefined, async () => complete('criteria', 'CAT-1 to CAT-3'));
  const lead = await dispatch(store, 'lead-review', undefined, undefined, async () => complete('technical-review', 'Two files'));
  await decide(store, 'product-review', product.id, 'accepted', 'Criteria reviewed');
  await assert.rejects(dispatch(store, 'implementation-plan'), /Waiting for accepted handoff: Lead Engineer review/);
  await decide(store, 'lead-review', lead.id, 'accepted', 'Scope reviewed');

  const plan = await dispatch(store, 'implementation-plan', undefined, undefined, async job => {
    assert.deepEqual(job.inputs.map(input => input.id), ['input-brief', product.result.artifacts.criteria, lead.result.artifacts['technical-review']]);
    assert.deepEqual(job.task.handoffs, [
      { taskId: 'product-review', slot: 'criteria', attemptId: product.id, artifactId: job.inputs[1].id, digest: job.inputs[1].digest },
      { taskId: 'lead-review', slot: 'technical-review', attemptId: lead.id, artifactId: job.inputs[2].id, digest: job.inputs[2].digest },
    ]);
    return complete('plan', 'Approved inputs received');
  });
  assert.equal(plan.outcome, 'completed');
  assert.deepEqual(plan.prerequisites.map(value => value.attemptId), [product.id, lead.id]);
  assert.equal(plan.handoffs.length, 2);
});

test('the website plan joins both design outputs and the roster retains each epic’s profiles', async t => {
  const { control, snapshot } = await fixture(t);
  const websiteConfig = 'examples/hello-world/website.crew.project.json';
  const catalog = newRun(snapshot, 'catalog', config);
  const website = newRun(readProject(control, websiteConfig), 'website', websiteConfig);
  const store = runStore(control.gitDir, website.id);
  await store.create(website);
  const roster = workspaceCatalog([website, catalog])[0].profiles;
  assert.equal(roster.find(profile => profile.id === 'visual-designer').configurationRun, 'website');
  assert.equal(roster.find(profile => profile.id === 'qa').configurationRun, 'catalog');
  assert.deepEqual(website.tasks[2].packet.handoffInputs, [
    { task: 'ux-review', slot: 'ux-spec' }, { task: 'visual-review', slot: 'visual-spec' },
  ]);
  await assert.rejects(dispatch(store, 'website-plan'), /Waiting for accepted handoff: UX review/);
});

test('task usage counts retries and leaves unpriced attempts visible', async t => {
  const { snapshot, control } = await fixture(t);
  const project = snapshot.project;
  const budget = project.tasks[0].budget;
  budget.costOwner = 'Budget reviewer';
  budget.costTargetUsd = 0.002;
  project.runtime.tokenRates = { inputUsdPerMillion: 2, cachedInputUsdPerMillion: 0.5, outputUsdPerMillion: 5 };
  assert.throws(() => validateProject(project), /explicit runtime model/);
  project.runtime.model = 'test-model';
  validateProject(project);

  const run = newRun(snapshot, 'budget', config);
  assert.equal(run.tasks[1].packet.budget.costOwner, 'SDM');
  const store = runStore(control.gitDir, run.id);
  await store.create(run);
  const first = await dispatch(store, 'product-review', undefined, undefined, async () => ({
    outcome: 'execution-failed', receipt: { usage: { input: 1_000, cached: 600, output: 200, total: 1_200 } },
  }));
  await decide(store, 'product-review', first.id, 'rework', 'Retry the review.');
  await dispatch(store, 'product-review', undefined, undefined, async () => ({ outcome: 'execution-failed', receipt: {} }));
  const task = summarize(await store.read()).tasks[0];
  assert.deepEqual(task.usage, { costOwner: 'Budget reviewer', costTargetUsd: 0.002, totalTokens: 1_200,
    estimatedUsd: 0.0021, unpricedAttempts: 1, attemptsMissingUsage: 1, overCostTarget: true });
  assert.equal(task.attempts[1].estimatedUsd, null);
  assert.equal(task.attempts[0].estimatedUsd, 0.0021);
});
