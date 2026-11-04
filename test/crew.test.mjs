import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { captureConfiguration, gitControl, readProject } from '../lib/git-control.mjs';
import { buildCandidate } from '../lib/candidates.mjs';
import { executeEvidence } from '../lib/checks.mjs';
import { importLocal } from '../lib/import-local.mjs';
import { registerProject, loadProject } from '../lib/project-store.mjs';
import { setProvisioner } from '../lib/resources.mjs';
import { memoryRunStore, postgres, testDatabase } from '../test-support/stores.mjs';
import { currentAttempt } from '../lib/attempts.mjs';
import { validateProject } from '../lib/contracts.mjs';
import { artifact, runStore } from '../lib/run-store.mjs';
import { decide, dispatch, dispatchInitial, findArtifact, newRun, requestFix, resolveResource, summarize, triageRun, workspaceCatalog } from '../lib/workflow.mjs';
import { epicPage, projectPage } from '../ui/views.mjs';

const config = 'examples/hello-world/crew.project.json';
const websiteConfig = 'examples/hello-world/website.crew.project.json';

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

test('the static team is recorded at intake and existing runs still dispatch', async t => {
  const { snapshot } = await fixture(t);
  const run = newRun(snapshot, 'static', config);
  const store = memoryRunStore();
  await store.create(run);
  assert.equal(run.triage.status, 'assigned');
  assert.equal(run.triage.mode, 'static');
  assert.equal(run.triage.brief.digest, findArtifact(run, 'input-brief').digest);
  assert.deepEqual(run.triage.assignments.map(assignment => assignment.profileId), snapshot.project.tasks.map(task => task.profileId));
  await assert.rejects(triageRun(store, 'SDM', 'Replace the team'), /not awaiting triage/);
  const execute = async () => ({ outcome: 'execution-failed', receipt: {} });
  const attempt = await dispatch(store, 'product-review', undefined, undefined, execute);
  assert.equal(attempt.triageArtifactId, run.triage.artifactId);

  const legacy = memoryRunStore();
  const record = newRun(snapshot, 'legacy', config);
  record.artifacts = record.artifacts.filter(value => value.id !== record.triage.artifactId);
  delete record.triage;
  await legacy.create(record);
  const legacyAttempt = await dispatch(legacy, 'product-review', undefined, undefined, execute);
  assert.equal(legacyAttempt.triageArtifactId, undefined);
});

test('manual triage gates dispatch and saves exactly one complete team for the pinned brief', async t => {
  const { control } = await fixture(t);
  const run = newRun(readProject(control, websiteConfig), 'intake', websiteConfig);
  const store = memoryRunStore();
  await store.create(run);
  const override = { taskId: 'website-build', profileId: 'frontend-engineer' };
  const approve = (owner, ...overrides) => triageRun(store, owner, 'The brief needs responsive interactions.', overrides);

  assert.equal(workspaceCatalog([run])[0].epics[0].runs[0].triagePending, true);
  await assert.rejects(dispatch(store, 'ux-review'), /Confirm team assignments/);
  await assert.rejects(approve('Product Manager', override), /configured triage owner/);
  await assert.rejects(approve('SDM', override, override), /Duplicate assignment/);
  await assert.rejects(approve('SDM', override, { taskId: 'security-engineer-review', profileId: 'engineer' }), /not eligible/);
  assert.deepEqual(await store.read(), JSON.parse(JSON.stringify(run)));

  const results = await Promise.allSettled([approve('Principal Engineer', override), approve('Tech Lead', override)]);
  const [saved] = results.filter(result => result.status === 'fulfilled');
  const [rejected] = results.filter(result => result.status === 'rejected');
  assert.match(rejected.reason.message, /not awaiting triage/);
  const summary = summarize(await store.read());
  assert.equal(summary.triagePending, false);
  assert.deepEqual(summary.triage, saved.value);
  assert.equal(summary.triage.assignments.length, run.tasks.length);
  const build = summary.tasks.find(task => task.packet.id === override.taskId);
  assert.deepEqual(build.packet.profileRef, { id: 'frontend-engineer', revision: 1 });
  assert.deepEqual(build.packet.prerequisites, run.tasks.find(task => task.packet.id === override.taskId).packet.prerequisites);
  assert.equal(summary.artifacts.find(value => value.id === build.packetId).provenance.decisionId, summary.triage.artifactId);
  await assert.rejects(dispatch(store, 'website-build'), /Waiting for accepted handoff/);
});

test('the CLI starts the initial assignments on static intake or manual confirmation', { skip: !postgres }, async t => {
  const { repo } = await fixture(t);
  const { url } = await testDatabase(t);
  const fakeCodex = join(repo, 'codex');
  await writeFile(fakeCodex, `#!${process.execPath}
const fs = require('node:fs');
const { task } = JSON.parse(fs.readFileSync(0, 'utf8').split('\\n').at(-1));
if (task.id === 'visual-review') process.exit(1);
const output = process.argv[process.argv.indexOf('--output-last-message') + 1];
fs.writeFileSync(output, JSON.stringify({ state: 'completed', summary: 'Fixture result',
  outputs: task.outputs.map(slot => ({ slot: slot.id, content: 'Fixture output' })),
  decisions: [], questions: [], blockers: [] }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 2, output_tokens: 1 } }));
`, { mode: 0o700 });
  function cli(...args) {
    const entry = fileURLToPath(new URL('../bin/crew.mjs', import.meta.url));
    return spawnSync(process.execPath, [entry, '--repo', repo, ...args], {
      encoding: 'utf8', env: { ...process.env, CREW_DATABASE_URL: url, PATH: `${repo}:${process.env.PATH}` }, cwd: repo,
    });
  }
  assert.equal(cli('project', 'register', '--file', config).status, 0);
  assert.equal(cli('project', 'register', '--file', websiteConfig).status, 0);
  const catalog = cli('run', 'start', 'catalog', '--project', 'pet-store', '--epic', 'epic-1');
  assert.equal(catalog.status, 0, catalog.stderr);
  const { run: staticRun } = JSON.parse(catalog.stdout);
  assert.deepEqual(staticRun.tasks.filter(task => task.attempts.length).map(task => task.packet.id), ['product-review', 'lead-review']);
  assert.ok(staticRun.tasks.slice(0, 2).every(task => task.attempts[0].evidenceStatus === 'recorded'));

  const website = cli('run', 'start', 'website', '--project', 'pet-store', '--epic', 'epic-2');
  assert.equal(website.status, 0, website.stderr);
  assert.equal(JSON.parse(website.stdout).run.triage.status, 'pending');
  assert.ok(JSON.parse(website.stdout).run.tasks.every(task => !task.attempts.length));
  const confirmation = cli('run', 'triage', 'website', '--owner', 'SDM', '--note', 'Use the proposed team.', '--events');
  assert.equal(confirmation.status, 5, confirmation.stderr);
  const [kickoff, decision] = confirmation.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(kickoff.event, 'run.kickoff');
  assert.equal(decision.triage.status, 'assigned');
  const { run: manualRun } = JSON.parse(cli('run', 'show', 'website').stdout);
  const started = manualRun.tasks.filter(task => task.attempts.length);
  assert.deepEqual(started.map(task => task.packet.id), ['ux-review', 'visual-review']);
  assert.deepEqual(kickoff.attempts.map(attempt => attempt.attemptId), started.map(task => task.attempts[0].id));
  assert.deepEqual(started.map(task => task.attempts[0].outcome), ['completed', 'execution-failed']);
  assert.equal(cli('run', 'triage', 'website', '--owner', 'SDM', '--note', 'Duplicate').status, 3);
  assert.equal(cli('task', 'dispatch', 'website', 'website-plan').status, 3);
  const prepared = cli('run', 'start', 'prepared', '--project', 'pet-store', '--epic', 'epic-1', '--no-dispatch');
  assert.equal(prepared.status, 0, prepared.stderr);
  assert.ok(JSON.parse(prepared.stdout).run.tasks.every(task => !task.attempts.length));
});

test('concurrent kickoff calls reserve each initial assignment once', async t => {
  const { snapshot } = await fixture(t);
  const store = memoryRunStore();
  await store.create(newRun(snapshot, 'kickoff', config));
  const execute = async () => ({ outcome: 'execution-failed', receipt: {} });
  const start = () => dispatchInitial(store, undefined, undefined, execute);
  const started = await Promise.all([start(), start()]);
  assert.deepEqual(started.map(attempts => attempts.length).sort(), [0, 2]);
  assert.deepEqual((await store.read()).tasks.map(task => task.attempts.length), [1, 1, 0, 0, 0, 0, 0, 0, 0]);
});

test('a project cannot configure manual triage without a pinned brief or with an unknown alternate', async t => {
  const { control, repo, git } = await fixture(t);
  const { project } = readProject(control, websiteConfig);
  async function commitConfig() {
    await writeFile(join(repo, websiteConfig), JSON.stringify(project));
    git('add', websiteConfig);
    git('-c', 'user.name=Crew Test', '-c', 'user.email=crew@example.invalid', 'commit', '-qm', 'Change triage config');
  }
  project.triage.briefInput = 'missing';
  await commitConfig();
  assert.throws(() => readProject(control, websiteConfig), /configured brief input/);
  project.triage.briefInput = 'brief';
  project.tasks.find(task => task.id === 'website-build').alternateProfiles = ['unknown-engineer'];
  await commitConfig();
  assert.throws(() => readProject(control, websiteConfig), /Unknown alternate profile/);
});

test('the attention queue gates the handoff and the last resolution resumes it with evidence', async t => {
  const { snapshot } = await fixture(t);
  snapshot.project.resourcePolicy = { rules: [{ action: 'create-database', mode: 'deny' }] };
  snapshot.project.tasks[0].budget.maxAttempts = 1;
  const store = memoryRunStore();
  await store.create(newRun(snapshot, 'resources', config));
  const reply = { decisions: [], questions: [], blockers: [] };
  const requests = [
    { action: 'create-account', target: 'OpenRouter', reason: 'The brief requires an inference account.' },
    { action: 'create-database', target: 'catalog-prod', reason: 'The brief needs persistent storage.' },
  ];
  const blocked = await dispatch(store, 'product-review', undefined, undefined, async () => ({
    outcome: 'completed', receipt: {}, response: { ...reply, state: 'blocked', summary: 'Setup needed',
      outputs: [], resourceRequests: requests },
  }));
  const raw = await store.read();
  const run = summarize(raw);
  const [project] = workspaceCatalog([raw]);
  assert.deepEqual(run.pendingResources.map(resource => resource.target), ['OpenRouter', 'catalog-prod']);
  assert.match(projectPage(project, 'attention'), /Create account · OpenRouter/);
  const page = epicPage(project, project.epics[0], run, { view: 'attention' });
  assert.match(page, /Confirm resource ready/);
  assert.match(page, /Continue with alternative/);
  assert.match(page, new RegExp(blocked.receiptId));
  await assert.rejects(dispatch(store, 'product-review'), /Resolve the resource requests/);
  await assert.rejects(decide(store, 'product-review', blocked.id, 'rework', 'Ignore setup'), /Resolve the resource requests/);
  const [account, database] = run.pendingResources;
  const ready = await resolveResource(store, account.id, 'Account set up for the crew.', undefined, undefined,
    () => assert.fail('Still waiting for the database decision'));
  assert.deepEqual(ready.attempts, []);

  const resume = () => resolveResource(store, database.id, 'Use the existing catalog database.', undefined, undefined,
    async ({ attempt, inputs }) => {
      assert.equal(attempt.resumedFrom, blocked.id);
      const records = inputs.filter(input => input.provenance.source === 'resource-resolution').map(input => JSON.parse(input.content));
      assert.deepEqual(records.map(record => [record.target, record.disposition]), [['OpenRouter', 'ready'], ['catalog-prod', 'declined']]);
      return { outcome: 'completed', receipt: {}, response: { ...reply, state: 'completed', summary: 'Criteria prepared',
        outputs: [{ slot: 'criteria', content: 'List available pets.' }], resourceRequests: [] } };
    });
  const attempts = await Promise.allSettled([resume(), resume()]);
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
  assert.match(attempts.find(result => result.status === 'rejected').reason.message, /no longer open/);
  const resumed = summarize(await store.read());
  assert.equal(resumed.tasks[0].attempts.length, 2);
  assert.equal(resumed.handoffs.review, 1);
  assert.deepEqual(resumed.pendingResources, []);
});

test('an unevidenced resource request leaves a failed handoff and no provisionable item', async t => {
  const { snapshot } = await fixture(t);
  const store = memoryRunStore();
  await store.create(newRun(snapshot, 'unevidenced', config));
  const attempt = await dispatch(store, 'product-review', undefined, undefined, async () => ({
    outcome: 'completed', response: { state: 'blocked', summary: 'Setup needed', decisions: [], questions: [],
      blockers: [], outputs: [], resourceRequests: [{ action: 'create-repository', target: 'org/catalog', reason: 'Host the code.' }] },
  }));
  assert.equal(attempt.outcome, 'invalid-result');
  assert.match(attempt.error, /needs a recorded execution receipt/);
  const run = summarize(await store.read());
  assert.deepEqual(run.pendingResources, []);
  assert.deepEqual(run.attentionTasks.map(task => task.id), ['product-review']);
});

test('only an exact rule and database binding can provision a requested resource', { skip: !postgres }, async t => {
  const { snapshot, repo } = await fixture(t);
  const { db } = await testDatabase(t);
  const action = 'create-table';
  const target = 'dev.catalog';
  snapshot.project.resourcePolicy = { rules: [{ action, mode: 'deny' }, { action, target, mode: 'auto' }] };
  validateProject(snapshot.project);
  assert.throws(() => validateProject({ ...snapshot.project, resourcePolicy: { rules: [{ action, mode: 'auto' }] } }),
    /require an exact target/);
  const reply = { decisions: [], questions: [], blockers: [], outputs: [] };
  const execute = async ({ attempt, task }) => attempt.resumedFrom
    ? { outcome: 'completed', receipt: {}, response: { ...reply, state: 'completed', summary: 'Ready',
      outputs: task.outputs.map(slot => ({ slot: slot.id, content: 'Fixture output.' })) } }
    : { outcome: 'completed', receipt: {}, response: { ...reply, state: 'blocked', summary: 'Table needed',
      resourceRequests: [{ action, target, reason: 'Store catalog rows.' }] } };
  const missing = runStore(db, 'missing');
  await missing.create(newRun(snapshot, 'missing', config));
  await dispatch(missing, 'product-review', undefined, undefined, execute, db);
  assert.equal((await missing.read()).resources[0].automatic.status, 'unavailable');

  const marker = join(repo, 'provisioned');
  const project = snapshot.project.id;
  await setProvisioner(db, project, action, target, [process.execPath, '-e', 'process.exit(1)']);
  const failed = runStore(db, 'failed');
  await failed.create(newRun(snapshot, 'failed', config));
  await dispatch(failed, 'product-review', undefined, undefined, execute, db);
  assert.equal((await failed.read()).resources[0].automatic.status, 'failed');

  await setProvisioner(db, project, action, target, [process.execPath, '-e',
    'require("node:fs").appendFileSync(process.argv[1], "provisioned")', marker]);
  const auto = runStore(db, 'auto');
  await auto.create(newRun(snapshot, 'auto', config));
  const results = await dispatchInitial(auto, undefined, undefined, execute, db);
  assert.deepEqual(results.map(attempt => attempt.result.state), ['completed', 'completed']);
  assert.equal(await readFile(marker, 'utf8'), 'provisioned');
  const provisioned = summarize(await auto.read());
  assert.equal(provisioned.resources[0].resolution.source, 'provisioner');
  assert.equal(provisioned.handoffs.review, 2);
  assert.deepEqual(provisioned.pendingResources, []);
});

test('an incomplete result needs rework and acceptance requires evidence from the new attempt', async t => {
  const { snapshot } = await fixture(t);
  const store = memoryRunStore();
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
  const { snapshot } = await fixture(t);
  const store = memoryRunStore();
  await store.create(newRun(snapshot, 'join', config));
  const receipt = { threadId: 'offline-test' };
  const complete = (slot, content) => ({ outcome: 'completed', receipt,
    response: { state: 'completed', summary: content, decisions: [], questions: [], blockers: [], outputs: [{ slot, content }] } });
  const product = await dispatch(store, 'product-review', undefined, undefined, async () => complete('criteria', 'CAT-1 to CAT-3'));
  const lead = await dispatch(store, 'lead-review', undefined, undefined, async job => {
    const profile = snapshot.project.profiles.find(profile => profile.id === 'lead-engineer');
    assert.equal(job.attempt.profileRevision, profile.revision);
    assert.equal(profile.skills.length, 2);
    assert.deepEqual(job.instructions, [profile.instructions, ...profile.skills].map(path => snapshot.files.get(path)));
    return complete('technical-review', 'Two files');
  });
  await decide(store, 'product-review', product.id, 'accepted', 'Criteria reviewed');
  await assert.rejects(dispatch(store, 'implementation-plan'), /Waiting for accepted handoff: Lead Engineer review/);
  await decide(store, 'lead-review', lead.id, 'accepted', 'Scope reviewed');

  const plan = await dispatch(store, 'implementation-plan', undefined, undefined, async job => {
    const sdm = snapshot.project.profiles.find(profile => profile.id === 'sdm');
    assert.equal(job.attempt.profileRevision, sdm.revision);
    assert.equal(sdm.skills.length, 2);
    assert.deepEqual(job.instructions, [sdm.instructions, ...sdm.skills].map(path => snapshot.files.get(path)));
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
  const catalog = newRun(snapshot, 'catalog', config);
  const website = newRun(readProject(control, websiteConfig), 'website', websiteConfig);
  const store = memoryRunStore();
  await store.create(website);
  const roster = workspaceCatalog([website, catalog])[0].profiles;
  assert.equal(roster.find(profile => profile.id === 'visual-designer').configurationRun, 'website');
  assert.equal(roster.find(profile => profile.id === 'qa').configurationRun, 'catalog');
  assert.deepEqual(website.tasks[2].packet.handoffInputs, [
    { task: 'ux-review', slot: 'ux-spec' }, { task: 'visual-review', slot: 'visual-spec' },
  ]);
  await triageRun(store, 'SDM', 'Use the proposed team.');
  await assert.rejects(dispatch(store, 'website-plan'), /Waiting for accepted handoff: UX review/);
});

test('workflow usage attributes retries and overlapping attempts, preserving missing measurements', async t => {
  const { snapshot } = await fixture(t);
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
  const store = memoryRunStore();
  await store.create(run);
  const first = await dispatch(store, 'product-review', undefined, undefined, async () => ({
    outcome: 'execution-failed', receipt: {
      startedAt: '2026-01-01T00:00:01Z', endedAt: '2026-01-01T00:00:04Z',
      usage: { input: 1_000, cached: 600, output: 200, total: 1_200 },
    },
  }));
  await decide(store, 'product-review', first.id, 'rework', 'Retry the review.');
  await dispatch(store, 'product-review', undefined, undefined, async () => ({ outcome: 'execution-failed', receipt: {} }));
  await dispatch(store, 'lead-review', undefined, undefined, async () => ({
    outcome: 'completed', receipt: { usage: { input: 100, cached: 0, output: 0, total: 100 } },
    response: { state: 'completed', summary: 'Reviewed scope', decisions: [], questions: [], blockers: [],
      outputs: [{ slot: 'technical-review', content: 'Scope checked' }] },
  }));
  await store.update(record => {
    const [product, lead] = record.tasks;
    const time = (attempt, start, end) => Object.assign(attempt, {
      startedAt: `2026-01-01T00:00:${start}Z`, endedAt: `2026-01-01T00:00:${end}Z`,
    });
    time(product.attempts[0], '00', '05');
    time(product.attempts[1], '08', '09');
    time(lead.attempts[0], '01', '06');
    record.tasks[2].attempts.push({ id: randomUUID(), outcome: 'running', startedAt: '2026-01-01T00:00:10Z' });
  });
  const summary = summarize(await store.read());
  const task = summary.tasks[0];
  assert.deepEqual(task.usage, { costOwner: 'Budget reviewer', costTargetUsd: 0.002, attempts: 2, runningAttempts: 0,
    totalTokens: 1_200, estimatedUsd: 0.0021, durationMs: 6_000, unpricedAttempts: 1, attemptsMissingUsage: 1,
    attemptsMissingDuration: 0, overCostTarget: true });
  assert.equal(task.attempts[1].estimatedUsd, null);
  assert.equal(task.attempts[0].codexDurationMs, 3_000);
  assert.equal(summary.usage.totalTokens, 1_300);
  assert.equal(summary.usage.durationMs, 11_000);
  assert.equal(summary.usage.attemptWindowMs, 9_000);
  assert.equal(summary.usage.runningAttempts, 1);
  assert.equal(summary.usage.attemptsMissingUsage, 1);
  assert.equal(summary.usage.byProfile.find(profile => profile.profileId === 'lead-engineer').totalTokens, 100);
  assert.equal(summary.quality.reworkDecisions, 1);
});

test('implementation blockers gate delivery and a fix loop replaces only candidate-dependent handoffs', async t => {
  const { control, repo } = await fixture(t);
  const snapshot = readProject(control, websiteConfig);
  const run = newRun(snapshot, 'fix-test', websiteConfig);
  const store = memoryRunStore();
  await store.create(run);
  const buildId = run.orchestration.buildTask;
  const triage = await triageRun(store, 'Tech Lead', 'Assign prototype implementation to the frontend specialist.',
    [{ taskId: buildId, profileId: 'frontend-engineer' }]);
  const completed = (slot, content) => ({
    outcome: 'completed', receipt: {},
    response: { state: 'completed', summary: 'Offline result', decisions: [], questions: [], blockers: [], outputs: [{ slot, content }] },
  });
  for (const [task, slot] of [['ux-review', 'ux-spec'], ['visual-review', 'visual-spec'], ['website-plan', 'build-plan']]) {
    const attempt = await dispatch(store, task, undefined, undefined, async () => completed(slot, 'Approved planning artifact'));
    await decide(store, task, attempt.id, 'accepted', 'Planning checked');
  }
  const [ux, visual, lead, security] = run.orchestration.reviewTasks;
  const securityProfile = snapshot.project.profiles.find(profile => profile.id === 'security-engineer');
  const [securitySkill] = securityProfile.skills;
  await writeFile(join(repo, securitySkill), 'Uncommitted skill change');
  const file = run.tasks.find(task => task.packet.id === buildId).packet.outputs[0].path;
  async function seedBuild(content) {
    const id = randomUUID();
    const execution = run.tasks.find(task => task.packet.id === buildId).packet.execution;
    const { candidate, files, diff } = buildCandidate(run.sourceCommit, run.sourceFiles, execution, [{ path: file, content }]);
    await store.update(record => {
      const task = record.tasks.find(task => task.packet.id === buildId);
      const add = (slot, content) => {
        const key = `${id}-${slot}`;
        record.artifacts.push(artifact(key, slot, 'text', content, { source: 'runtime', attemptId: id }));
        return key;
      };
      task.attempts.push({
        id, number: task.attempts.length + 1, packetRevision: task.packet.revision, outcome: 'completed', startedAt: new Date().toISOString(),
        receiptId: add('receipt', '{}'), candidate, candidateFiles: files, result: { state: 'completed', artifacts: { website: add('website', content) } },
        runnerArtifacts: { candidate: add('candidate', JSON.stringify(candidate)), 'check-receipt': add('check-receipt', JSON.stringify({
          kind: 'author-tests', testedCommit: candidate.commit, platform: 'test-fixture',
          checks: [{ id: 'author-tests', passed: true }], passed: true,
        })),
          'candidate-diff': add('candidate-diff', diff) },
      });
    });
    await decide(store, buildId, id, 'accepted', 'Seeded candidate');
    return { id, candidate };
  }
  const blocker = { id: 'filter-label', severity: 'blocker', title: 'Label the filter', evidence: 'The select has no label.' };
  const backlog = { id: 'card-spacing', severity: 'backlog', title: 'Refine spacing', evidence: 'The cards use a tight gap.' };
  const review = (task, findings) => dispatch(store, task, undefined, undefined, async job => {
    if (task === security) {
      assert.equal(job.attempt.profileRevision, securityProfile.revision);
      assert.deepEqual(job.instructions, [securityProfile.instructions, securitySkill].map(path => snapshot.files.get(path)));
    }
    return completed('findings', JSON.stringify(findings));
  });
  const source = '<main>First candidate</main>';
  const first = await seedBuild(source);
  const blocked = await review(ux, [blocker]);
  await assert.rejects(decide(store, ux, blocked.id, 'accepted', 'Accept'), /unresolved blockers/);
  await assert.rejects(requestFix(store, first.id, 'Fix the filter'), /all implementation review findings/);
  const deferred = await review(visual, [backlog]);
  await decide(store, visual, deferred.id, 'accepted', 'Polish can wait');
  for (const task of [lead, security]) await review(task, []);
  const reviewed = await store.read();
  assert.deepEqual(summarize(reviewed).quality.checks, { passed: 1, total: 1, missingReceipts: 0 });
  const checkReceipt = currentAttempt(reviewed.tasks.find(task => task.packet.id === buildId)).runnerArtifacts['check-receipt'];
  reviewed.artifacts = reviewed.artifacts.filter(record => record.id !== checkReceipt);
  assert.deepEqual(summarize(reviewed).quality.checks, { passed: 0, total: 0, missingReceipts: 1 });
  await assert.rejects(dispatch(store, 'website-delivery'), /Waiting for accepted handoff/);
  await assert.rejects(requestFix(store, randomUUID(), 'Stale click'), /build candidate changed/);
  const loop = await requestFix(store, first.id, 'Fix the filter');
  assert.equal(loop.number, 1);
  let summary = summarize(await store.read());
  assert.equal(summary.fix.used, 1);
  assert.deepEqual(summary.quality.checks, { passed: 0, total: 0, missingReceipts: 0 });
  assert.equal(summary.backlog[0].title, backlog.title);
  assert.equal(currentAttempt(summary.tasks.find(task => task.packet.id === ux)), undefined);
  assert.equal(summary.tasks.find(task => task.packet.id === visual).attempts[0].decision.disposition, 'accepted');
  assert.equal(currentAttempt(summary.tasks[2]).decision.disposition, 'accepted');

  const repeated = await dispatch(store, buildId, undefined, undefined, async job => {
    assert.equal(job.profile.id, 'frontend-engineer');
    assert.equal(job.attempt.triageArtifactId, triage.artifactId);
    assert.equal(job.task.fixLoop.previousCandidate, first.candidate.commit);
    assert.ok(loop.artifacts.every(record => job.inputs.some(input => input.id === record.id && input.digest === record.digest)));
    return completed('website', source);
  });
  assert.match(repeated.error, /must change the reviewed candidate source/);
  const second = await seedBuild('<main>Replacement candidate</main>');
  assert.notEqual(second.candidate.commit, first.candidate.commit);
  const secondUx = await review(ux, []);
  const secondVisual = await review(visual, []);
  assert.equal(secondUx.prerequisites.find(source => source.taskId === buildId).attemptId, second.id);
  await decide(store, ux, secondUx.id, 'accepted', 'Checked replacement');
  await assert.rejects(dispatch(store, 'website-delivery'), /Visual implementation review/);
  await decide(store, visual, secondVisual.id, 'accepted', 'Checked replacement');
  for (const task of [lead, security]) {
    const attempt = await review(task, []);
    await decide(store, task, attempt.id, 'accepted', 'Checked replacement');
  }
  const delivery = await dispatch(store, 'website-delivery', undefined, undefined, async () => completed('delivery', 'Ready for review'));
  assert.equal(delivery.outcome, 'completed');
  await assert.rejects(requestFix(store, second.id, 'Try again'), /limit reached/);
  summary = summarize(await store.read());
  assert.equal(summary.backlog[0].title, backlog.title);
});

test('Postgres versions pin the configuration and files across checkouts and concurrent writers', { skip: !postgres }, async t => {
  const { repo, control } = await fixture(t);
  const { db } = await testDatabase(t);
  const brief = join(repo, 'uncommitted-brief.md');
  await writeFile(brief, 'Private version-one brief');
  const capture = () => captureConfiguration(control, join(repo, config), 'HEAD', new Map([['brief', brief]]));
  const first = capture();
  assert.deepEqual(await Promise.all([registerProject(db, first), registerProject(db, first)]), [1, 1]);
  await writeFile(brief, 'Private version-two brief');
  assert.equal(await registerProject(db, capture()), 2);

  const configured = await loadProject(db, 'pet-store', 'epic-1', 1);
  assert.equal((await loadProject(db, 'pet-store', 'epic-1')).version, 2);
  const run = newRun(configured, 'pinned-run');
  const store = runStore(db, run.id);
  await store.create(run);
  await assert.rejects(store.create(run), /already exists/);
  await rm(repo, { recursive: true, force: true });
  const persisted = await store.read();
  assert.equal(findArtifact(persisted, 'input-brief').content, 'Private version-one brief');
  assert.equal(findArtifact(persisted, 'project-config').provenance.version, 1);
  const execute = async () => ({ outcome: 'execution-failed', receipt: {} });
  const kickoffs = await Promise.all([dispatchInitial(store, undefined, undefined, execute),
    dispatchInitial(store, undefined, undefined, execute)]);
  assert.deepEqual(kickoffs.map(result => result.length).sort(), [0, 2]);
  await assert.rejects(store.update(record => { record.project.name = 'Uncommitted'; throw new Error('Rollback'); }), /Rollback/);
  assert.equal((await store.read()).project.name, run.project.name);

  const { execution, outputs } = run.tasks.find(task => task.packet.execution?.kind === 'build').packet;
  const source = outputs.find(slot => slot.kind === 'source');
  const changes = [{ path: source.path, content: 'export const candidate = true;\n' }];
  const candidate = buildCandidate(run.sourceCommit, persisted.sourceFiles, execution, changes);
  assert.match(candidate.diff, /\+export const candidate = true/);
  assert.equal(candidate.files[source.path].content, changes[0].content);
  assert.deepEqual(candidate, buildCandidate(run.sourceCommit, persisted.sourceFiles, execution, changes));

  const tamperedFiles = structuredClone(candidate.files);
  tamperedFiles[source.path].content += '// unexpected change';
  const { packet } = run.tasks.find(task => task.packet.execution?.kind === 'verify');
  const checkSlot = packet.outputs.find(slot => slot.kind === 'check-cases');
  const cases = packet.criteria.flatMap(criterion =>
    Array.from({ length: packet.execution.minCases[criterion] }, (_, index) => {
      const id = `${criterion.toLowerCase()}-${index}`;
      return { id, criterion, args: [id], expected: { exitCode: 0, stdout: { text: '' }, stderr: '' } };
    }));
  await assert.rejects(executeEvidence({ task: packet, attempt: {}, candidate: candidate.candidate, candidateFiles: tamperedFiles },
    { outputs: [{ slot: checkSlot.id, content: JSON.stringify(cases) }] }), /Captured files do not match the accepted candidate/);
});

test('legacy import is repeatable and preserves old run state without writing local records', { skip: !postgres }, async t => {
  const { control, snapshot, git } = await fixture(t);
  const { db } = await testDatabase(t);
  const run = newRun(snapshot, 'imported', config);
  delete run.sourceFiles;
  const { packet, attempts } = run.tasks.find(task => task.packet.execution?.kind === 'build');
  const ref = `refs/crew/candidates/${run.id}/fixture`;
  git('update-ref', ref, run.sourceCommit);
  attempts.push({ id: randomUUID(), candidate: { base: run.sourceCommit, commit: run.sourceCommit, ref } });
  const directory = join(control.gitDir, 'engineering-crew', 'runs');
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${run.id}.json`);
  const raw = JSON.stringify(run);
  await writeFile(path, raw);
  assert.deepEqual(await importLocal(db, control), { imported: 1, skipped: 0 });
  const store = runStore(db, run.id);
  const imported = await store.read();
  assert.ok(imported.sourceFiles[packet.execution.entry].content);
  assert.ok(imported.tasks.find(task => task.packet.id === packet.id).attempts[0].candidateFiles[packet.execution.entry].content);
  await store.update(record => { record.project.name = 'Updated in Postgres'; });
  assert.deepEqual(await importLocal(db, control), { imported: 0, skipped: 1 });
  assert.equal((await store.read()).project.name, 'Updated in Postgres');
  assert.equal(await readFile(path, 'utf8'), raw);
});
