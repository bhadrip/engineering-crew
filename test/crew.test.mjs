import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { candidateDiff, createCandidate, gitControl, readProject } from '../lib/git-control.mjs';
import { currentAttempt } from '../lib/attempts.mjs';
import { validateProject } from '../lib/contracts.mjs';
import { artifact, runStore } from '../lib/run-store.mjs';
import { decide, dispatch, dispatchInitial, findArtifact, newRun, requestFix, summarize, triageRun, workspaceCatalog } from '../lib/workflow.mjs';

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
  const { control, snapshot } = await fixture(t);
  const run = newRun(snapshot, 'static', config);
  const store = runStore(control.gitDir, run.id);
  await store.create(run);
  assert.equal(run.triage.status, 'assigned');
  assert.equal(run.triage.mode, 'static');
  assert.equal(run.triage.brief.digest, findArtifact(run, 'input-brief').digest);
  assert.deepEqual(run.triage.assignments.map(assignment => assignment.profileId), snapshot.project.tasks.map(task => task.profileId));
  await assert.rejects(triageRun(store, 'SDM', 'Replace the team'), /not awaiting triage/);
  const execute = async () => ({ outcome: 'execution-failed', receipt: {} });
  const attempt = await dispatch(store, 'product-review', undefined, undefined, execute);
  assert.equal(attempt.triageArtifactId, run.triage.artifactId);

  const legacy = runStore(control.gitDir, 'legacy');
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
  const store = runStore(control.gitDir, run.id);
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

test('the CLI starts the initial assignments on static intake or manual confirmation', async t => {
  const { repo } = await fixture(t);
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
      encoding: 'utf8', env: { ...process.env, PATH: `${repo}:${process.env.PATH}` },
    });
  }
  const catalog = cli('run', 'start', 'catalog', '--project', config);
  assert.equal(catalog.status, 0, catalog.stderr);
  const { run: staticRun } = JSON.parse(catalog.stdout);
  assert.deepEqual(staticRun.tasks.filter(task => task.attempts.length).map(task => task.packet.id), ['product-review', 'lead-review']);
  assert.ok(staticRun.tasks.slice(0, 2).every(task => task.attempts[0].evidenceStatus === 'recorded'));

  const website = cli('run', 'start', 'website', '--project', websiteConfig);
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
  const prepared = cli('run', 'start', 'prepared', '--project', config, '--no-dispatch');
  assert.equal(prepared.status, 0, prepared.stderr);
  assert.ok(JSON.parse(prepared.stdout).run.tasks.every(task => !task.attempts.length));
});

test('concurrent kickoff calls reserve each initial assignment once', async t => {
  const { control, snapshot } = await fixture(t);
  const store = runStore(control.gitDir, 'kickoff');
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
  const store = runStore(control.gitDir, website.id);
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

test('implementation blockers gate delivery and a fix loop replaces only candidate-dependent handoffs', async t => {
  const { control, repo } = await fixture(t);
  const snapshot = readProject(control, websiteConfig);
  const run = newRun(snapshot, 'fix-test', websiteConfig);
  const store = runStore(control.gitDir, run.id);
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
    const candidate = createCandidate(control, run.sourceCommit, `refs/crew/test/${id}`, [{ path: file, content }]);
    await store.update(record => {
      const task = record.tasks.find(task => task.packet.id === buildId);
      const add = (slot, content) => {
        const key = `${id}-${slot}`;
        record.artifacts.push(artifact(key, slot, 'text', content, { source: 'runtime', attemptId: id }));
        return key;
      };
      task.attempts.push({
        id, number: task.attempts.length + 1, packetRevision: task.packet.revision, outcome: 'completed', startedAt: new Date().toISOString(),
        receiptId: add('receipt', '{}'), candidate, result: { state: 'completed', artifacts: { website: add('website', content) } },
        runnerArtifacts: { candidate: add('candidate', JSON.stringify(candidate)), 'check-receipt': add('check-receipt', '{}'),
          'candidate-diff': add('candidate-diff', candidateDiff(control, candidate)) },
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
  await assert.rejects(dispatch(store, 'website-delivery'), /Waiting for accepted handoff/);
  await assert.rejects(requestFix(store, randomUUID(), 'Stale click'), /build candidate changed/);
  const loop = await requestFix(store, first.id, 'Fix the filter');
  assert.equal(loop.number, 1);
  let summary = summarize(await store.read());
  assert.equal(summary.fix.used, 1);
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
  }, control);
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
