import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { musicProfile } from '../examples/music-transcribe/profile.mjs';
import { profilesForFeature, runtimeForFeature, updateFeatureProfile } from '../lib/local-feature.mjs';
import { editProjectProfile } from '../lib/local-profile-file.mjs';

async function fixture(t) {
  const repo = await mkdtemp(join(tmpdir(), 'crew-profile-edit-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const projectId = 'music-test';
  const path = join(repo, '.crew-local', 'profiles', projectId + '.json');
  const read = () => profilesForFeature(repo, projectId);
  const edit = (role, edit) => updateFeatureProfile(repo, projectId, role, edit);
  return { repo, projectId, path, read, edit };
}

test('edits one role, tracks explicit vs inherited model, and preserves project fields and old runtime snapshots', async t => {
  const { repo, projectId, path, read, edit } = await fixture(t);
  const oldDefault = process.env.CREW_CODEX_MODEL;
  process.env.CREW_CODEX_MODEL = 'local-default';
  t.after(() => {
    if (oldDefault === undefined) delete process.env.CREW_CODEX_MODEL;
    else process.env.CREW_CODEX_MODEL = oldDefault;
  });
  const initial = { acceptance: 'carnatic-lesson', image: 'music:local', note: 'keep me', roles: {
    planner: { id: 'lead', workerImage: 'worker:pin' }, engineer: { access: 'read-only' },
  } };
  await editProjectProfile(repo, projectId, () => initial);
  const oldRuntime = await runtimeForFeature(repo, { projectId });
  const before = await read();
  assert.equal(before.developmentProbe, true);
  assert.equal(before.defaultModel, 'local-default');
  assert.equal(before.definitions.planner.model, '');
  assert.equal(before.profiles.planner.model, 'local-default');
  const pinned = await edit('planner', { ...before.definitions.planner, model: 'local-default' });
  assert.equal(pinned.profiles.planner.digest, before.profiles.planner.digest);
  assert.notEqual(pinned.definitions.planner.revision, before.definitions.planner.revision);
  await assert.rejects(edit('planner', { ...before.definitions.planner, instructions: 'stale' }), { code: 3 });
  const instructions = 'Plan for svara.\nVerify the requested behavior.';
  const changed = await edit('planner', { ...pinned.definitions.planner, model: 'provider:model/name', instructions });
  assert.equal(changed.profiles.planner.model, 'provider:model/name');
  assert.equal(oldRuntime.profiles.planner.instructions, '');
  assert.equal((await runtimeForFeature(repo, { projectId })).profiles.planner.instructions, instructions);
  const json = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual(json, { ...initial, roles: { ...initial.roles, planner: { ...initial.roles.planner, model: 'provider:model/name', instructions } } });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const cleared = await edit('planner', { ...changed.definitions.planner, model: '', instructions: '' });
  assert.deepEqual(cleared.definitions.planner, before.definitions.planner);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), initial);
});

test('all writers merge against the latest file; concurrent stale edits and invalid drafts cannot replace it', async t => {
  const { repo, projectId, path, read, edit } = await fixture(t);
  const { definitions } = await read();
  const roles = Object.keys(definitions);
  await Promise.all([editProjectProfile(repo, projectId, config => ({ ...config, metadata: 'pilot-setup' })),
    ...roles.map(role => edit(role, { ...definitions[role], instructions: 'Task for ' + role }))]);
  const { definitions: updated } = await read();
  for (const role of roles) assert.equal(updated[role].instructions, 'Task for ' + role);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).metadata, 'pilot-setup');
  const attempts = await Promise.allSettled(['one', 'two'].map(model => edit('qa', { ...updated.qa, model })));
  assert.equal(attempts.filter(a => a.status === 'fulfilled').length, 1);
  assert.equal(attempts.find(a => a.status === 'rejected').reason.code, 3);
  const original = await readFile(path, 'utf8');
  for (const draft of [{ model: '--bad' }, { instructions: 'x'.repeat(8001) }, { revision: '' }]) {
    await assert.rejects(edit('security', { ...updated.security, ...draft }), { code: 2 });
  }
  await assert.rejects(edit('__proto__', updated.qa), { code: 2 });
  assert.equal(await readFile(path, 'utf8'), original);
});

test('fresh music preparation pins each role to Luna and repeat preparation keeps user edits and intentional clears', async t => {
  const { repo, projectId, read, edit } = await fixture(t);
  await editProjectProfile(repo, projectId, musicProfile);
  const { definitions } = await read();
  assert.equal(Object.keys(definitions).length, 5);
  assert.ok(Object.values(definitions).every(d => d.model === 'gpt-6-luna'));
  await edit('planner', { ...definitions.planner, model: '', instructions: '' });
  await edit('qa', { ...definitions.qa, model: 'chosen-model' });
  await editProjectProfile(repo, projectId, musicProfile);
  const { definitions: next } = await read();
  assert.equal(next.planner.model, '');
  assert.equal(next.qa.model, 'chosen-model');
});

test('another writer can proceed after a process exits while holding the project profile', { timeout: 8000 }, async t => {
  const { repo, projectId, read, edit } = await fixture(t);
  const initial = await read();
  const moduleUrl = new URL('../lib/local-profile-file.mjs', import.meta.url).href;
  const code = `import { editProjectProfile } from ${JSON.stringify(moduleUrl)};
    await editProjectProfile(process.argv[1], process.argv[2], () => {
      process.send('locked');
      setInterval(() => {}, 60000);
      return new Promise(() => {});
    });`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code, repo, projectId], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const exit = once(child, 'exit');
  const [ready] = await Promise.race([once(child, 'message'), exit]);
  assert.equal(ready, 'locked');
  child.kill('SIGKILL');
  await exit;
  const saved = await edit('planner', { ...initial.definitions.planner, model: 'recovered-model' });
  assert.equal(saved.profiles.planner.model, 'recovered-model');
});
