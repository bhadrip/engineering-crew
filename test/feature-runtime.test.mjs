import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFeatureRuntime } from '../lib/feature-runtime.mjs';
import { runtimeForFeature } from '../lib/local-feature.mjs';
import { resolveRoleProfiles } from '../lib/feature-profiles.mjs';
import { git, project, commitChanges, promoteCandidate, priorCandidate, materialize } from '../lib/feature-workspace.mjs';

async function setup(t) {
  const rootDir = await mkdtemp(join(tmpdir(), 'crew-runtime-test-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const ctx = { projectId: 'test-project', goal: 'Serve a healthy local application', operationId: 'feature:build:1', onEvent: async () => {} };
  return { rootDir, ctx, repo: await project(rootDir, ctx) };
}
const write = (path, content) => ({ action: 'write', path, content });

test('operator role declarations retain role ceilings and reject unsupported privileges at project load', async t => {
  const { rootDir } = await setup(t);
  const path = join(rootDir, '.crew-local', 'profiles');
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'test-project.json'), JSON.stringify({ roles: { security: { access: 'workspace-write' } } }));
  await assert.rejects(runtimeForFeature(rootDir, { projectId: 'test-project' }), /workspace access for security/);
  assert.throws(() => createFeatureRuntime({ roles: { qa: { network: 'host' } } }), /Unsupported profile field qa.network/);
  assert.throws(() => createFeatureRuntime({ roles: { publisher: {} } }), /Unknown project role publisher/);
  const profiles = resolveRoleProfiles({ engineer: { access: 'read-only' } }, { agentImage: 'node:22-alpine' });
  assert.equal(profiles.engineer.tools.includes('edit'), false);
  assert.equal(profiles.qa.tools.includes('operator-acceptance'), false);
  assert.equal(profiles.planner.modelSource, 'codex-default');
  assert.equal(profiles.security.access, 'read-only');
});

test('agent workspace pins revisions, rejects path escapes, preserves delivery until promotion', async t => {
  const { repo, ctx } = await setup(t);
  const build = changes => commitChanges({ repoPath: repo.repoPath, parent: repo.base, changes, ...ctx });
  await assert.rejects(build([write('../outside', 'unsafe')]), /unsupported/);
  await assert.rejects(build([write('.git/config', 'unsafe')]), /unsupported/);
  const revision = await build([write('src/a.mjs', 'export const a=1;\n')]);
  assert.equal(await priorCandidate(repo.repoPath, ctx.operationId), revision);
  assert.equal(await git(repo.repoPath, ['rev-parse', 'HEAD']), repo.base);
  const snapshot = await materialize(repo.repoPath, revision);
  t.after(() => rm(snapshot, { recursive: true, force: true }));
  assert.equal(await readFile(join(snapshot, 'src/a.mjs'), 'utf8'), 'export const a=1;\n');
  await assert.rejects(readFile(join(snapshot, '.git')), { code: 'ENOENT' });
  const delivery = { candidate: { base: repo.base, revision }, revision };
  assert.deepEqual(await promoteCandidate(repo, delivery), await promoteCandidate(repo, delivery));
  assert.equal(await git(repo.repoPath, ['rev-parse', 'HEAD']), revision);
  assert.equal(await readFile(join(repo.repoPath, 'src/a.mjs'), 'utf8'), 'export const a=1;\n');
});

test('a populated checkout supplies its manifest and rejects an engineer listing request on the first turn',
  { skip: process.env.CREW_RUNTIME_DOCKER_TEST !== '1', timeout: 30_000 }, async t => {
    const { rootDir, ctx, repo } = await setup(t);
    const base = await commitChanges({ repoPath: repo.repoPath, parent: repo.base, onEvent: ctx.onEvent,
      changes: [write('existing.mjs', 'export const value = 1;\n')] });
    const calls = [];
    const runtime = createFeatureRuntime({ rootDir, agent: async ({ prompt, allowedActions }) => {
      calls.push({ input: JSON.parse(prompt.split('\n').at(-1)), allowedActions });
      if (calls.length > 1) throw new Error('Repeated model invocation');
      return { value: { action: 'list', summary: 'List files again', paths: [], changes: [] } };
    } });
    await assert.rejects(runtime.build({ ...ctx, plan: { base } }), /action|list/i);
    assert.equal(calls.length, 1);
    const [{ input, allowedActions }] = calls;
    assert.deepEqual(input.manifest.map(file => file.path), ['existing.mjs']);
    assert.deepEqual(input.allowedActions, allowedActions);
    assert.ok(allowedActions.includes('read'));
    assert.ok(!allowedActions.includes('list'));
    assert.ok(!allowedActions.includes('finish'));
    assert.equal(await priorCandidate(repo.repoPath, ctx.operationId), null);
  });

test('an entire feature runs and verifies a separately mounted application in Docker',
  { skip: process.env.CREW_RUNTIME_DOCKER_TEST !== '1', timeout: 180_000 }, async t => {
    const { rootDir, ctx, repo } = await setup(t);
    const actions = [];
    const source = [
      "import { createServer } from 'node:http';",
      "createServer((req,res)=>{if(req.url==='/development'){res.writeHead(200);res.end('accepted');return;}res.writeHead(req.url === '/health' ? 200 : 404);res.end('healthy');}).listen(Number(process.env.PORT || 3000),'0.0.0.0');",
    ].join('\n');
    const testSource = "import {test} from 'node:test'; import assert from 'node:assert/strict'; import {readFileSync} from 'node:fs'; test('server provided',()=>assert.match(readFileSync('/app/server.mjs','utf8'),/createServer/));";
    const draft = source.replace("res.writeHead(200);res.end('accepted')", "res.writeHead(422);res.end('Development input rejected')");
    const turns = [{ action: 'edit', changes: [write('server.mjs', draft), write('server.test.mjs', testSource)] },
      { action: 'read', paths: ['server.mjs'] }, { action: 'test' }, { action: 'edit', changes: [write('server.mjs', source)] },
      { action: 'test' }, { action: 'finish' }];
    let qaSource = testSource;
    let liveChecks = 0;
    let devProbes = 0;
    const configured = { id: 'health-review', model: 'example-model', workerImage: 'node:22-alpine',
      instructions: 'Audit the public health endpoint.', extraTools: ['git-changes'] };
    const agentId = 'agent-' + 'a'.repeat(32);
    const skill = { name: 'Planning checklist', content: 'Include an acceptance test for health.' };
    const runtime = createFeatureRuntime({ rootDir, image: 'node:22-alpine',
      roles: { security: configured },
      agents: { [agentId]: { role: 'planner', name: 'Test planner', settings: { skills: [skill], extraTools: ['git-history', 'git-changes'] } } },
      activeAgents: { planner: agentId },
      probeApp: async ({ url, signal }) => {
        devProbes++;
        const response = await fetch(url + '/development', { method: 'POST', body: 'synthetic development input', signal });
        return { passed: response.ok, status: response.status, message: await response.text() };
      },
      verifyApp: async ({url, signal}) => {
        liveChecks++;
        return { passed: await (await fetch(url + '/health', {signal})).text() === 'healthy' };
      },
      agent: async ({role, model, prompt, allowedActions, profile}) => {
        if (role === 'planner') {
          assert.equal(profile.id, agentId);
          assert.ok(prompt.includes(skill.content));
          const { toolContext } = JSON.parse(prompt.split('\n').at(-1));
          assert.equal(toolContext.revision, repo.base);
          assert.match(toolContext.results['git-history'][0], /Initialize local Engineering Crew project/);
          assert.deepEqual(toolContext.results['git-changes'], []);
        }
        if (role === 'engineer') {
          const input = JSON.parse(prompt.split('\n').at(-1));
          assert.deepEqual(input.allowedActions, allowedActions);
          if (input.history.length === 0) {
            assert.deepEqual(input.manifest, []);
            assert.deepEqual(allowedActions, ['edit']);
          }
          assert.ok(allowedActions.includes(turns[0].action));
          assert.ok(!allowedActions.includes('list'));
          assert.equal(allowedActions.includes('finish'), turns[0].action === 'finish');
        }
        if (role === 'engineer' && devProbes === 1 && turns[0]?.action === 'edit') {
          const last = JSON.parse(prompt.split('\n').at(-1)).history.at(-1).result;
          assert.equal(last.passed, false);
          assert.equal(last.nodeTests.passed, true);
          assert.equal(last.liveChecks[1].status, 422);
          assert.equal(last.liveChecks[1].message, 'Development input rejected');
        }
        if (role === 'security') {
          assert.equal(model, configured.model);
          assert.ok(prompt.includes(configured.instructions));
          const { toolContext } = JSON.parse(prompt.split('\n').at(-1));
          assert.deepEqual(toolContext.results['git-changes'], ['server.mjs']);
        }
        const value = role === 'planner' ? { steps: ['implement health'], acceptance: ['healthy'] }
          : role === 'engineer' ? { ...turns.shift(), summary: 'Implement health' }
          : role === 'qa' ? { summary: 'Health check', testSource: qaSource } : { passed: true, findings: [] };
        return { value, receipt: { role } };
      },
    });
    const context = { ...ctx, onEvent: async event => actions.push(event) };
    const { plan } = await runtime.plan(context);
    const planner = actions.find(event => event.type === 'runtime.profile').evidence;
    assert.deepEqual(planner.skills, [{ name: skill.name, sha256: createHash('sha256').update(skill.content).digest('hex') }]);
    const candidate = await runtime.build({ ...context, plan });
    assert.equal((await runtime.build({ ...context, plan })).revision, candidate.revision);
    const checks = await Promise.all(['qa','security','reviewer'].map(role => runtime.verify({ ...context, role, plan, candidate })));
    assert.ok(checks.every(check => check.passed), JSON.stringify(checks));
    await runtime.promote({ ...context, candidate });
    assert.ok(actions.some(event => event.type === 'app.healthy'));
    const selected = actions.find(event => event.type === 'runtime.profile' && event.evidence.role === 'security').evidence;
    assert.equal(selected.id, configured.id);
    assert.equal(selected.workerImage, configured.workerImage);
    assert.equal(selected.network, 'none');
    assert.deepEqual(selected.tools, ['list', 'read']);
    const started = actions.find(event => event.type === 'runtime.started' && event.evidence.role === 'security').evidence;
    assert.equal(started.profileDigest, selected.digest);
    assert.match(started.image, /^sha256:[0-9a-f]{64}$/);
    assert.ok(actions.filter(event => event.type === 'app.test.started').every(event => event.evidence.image === candidate.image));
    assert.deepEqual(actions.filter(event => event.type === 'tool.called').map(event => event.evidence.action), ['edit','read','test','edit','test','finish']);
    assert.equal(devProbes, 2);
    qaSource = "import {test} from 'node:test'; test('independent assertion',()=>{throw Error('unmet requirement')});";
    const failedTest = await runtime.verify({ ...context, role: 'qa', plan, candidate });
    assert.equal(failedTest.passed, false);
    assert.equal(failedTest.checks.find(check => check.check === 'Operator acceptance test').passed, true);
    assert.equal(failedTest.checks.find(check => check.check === 'Independent QA tests').passed, false);
    const refusing = source.replace("req.url === '/health' ? 200 : 404", '403').replace("'healthy'", "'Loopback required '+ 'x'.repeat(1000)");
    const denied = await commitChanges({ repoPath: candidate.repoPath, parent: candidate.revision, changes: [write('server.mjs', refusing)], onEvent: ctx.onEvent });
    const unhealthy = await runtime.verify({ ...context, role: 'qa', plan, candidate: { ...candidate, revision: denied } });
    const health = unhealthy.checks.find(check => check.check === 'HTTP /health');
    assert.equal(health.passed, false);
    assert.match(health.evidence, /HTTP 403 \(Loopback required/);
    assert.ok(health.evidence.length < 300);
    assert.equal(unhealthy.checks.find(check => check.check === 'Operator acceptance test').status, 'skipped');
    assert.equal(liveChecks, 2);
  });
