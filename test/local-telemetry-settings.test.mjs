import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);

test('the local launcher scopes automatic publication to an exact project on its selected connection', async t => {
  const root = await mkdtemp(join(tmpdir(), 'crew-settings-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  const state = join(root, '.crew-local');
  await Promise.all([mkdir(bin), mkdir(state)]);
  const launcher = join(bin, 'local.mjs');
  const source = name => fileURLToPath(new URL('../' + name, import.meta.url));
  const selector = 'CREW_LANGFUSE_AUTO_PROJECT';
  const url = 'CREW_LANGFUSE_URL';
  const settings = { [url]: 'http://localhost:3123', CREW_LANGFUSE_PROJECT_ID: 'test-fixture', CREW_LANGFUSE_CREDENTIALS_FILE: '/unused/test-path' };
  await Promise.all([
    copyFile(source('bin/local.mjs'), launcher),
    symlink(source('node_modules'), join(root, 'node_modules')),
    symlink(source('lib'), join(root, 'lib')),
    writeFile(join(bin, 'crew.mjs'), `console.log(JSON.stringify([process.env.${selector} ?? null, process.env.${url} ?? null]))`),
  ]);
  async function launch(env = {}) {
    const { stdout } = await exec(process.execPath, [launcher], { env: { CREW_DATABASE_URL: 'test-only', ...env } });
    return JSON.parse(stdout);
  }
  const configFile = join(state, 'langfuse.json');
  await writeFile(configFile, JSON.stringify(settings));
  assert.deepEqual(await launch(), [null, settings[url]]);
  await writeFile(configFile, JSON.stringify({ ...settings, [selector]: 'music-transcribe' }));
  assert.deepEqual(await launch(), ['music-transcribe', settings[url]]);
  assert.deepEqual(await launch({ [selector]: '' }), ['', settings[url]]);
  assert.deepEqual(await launch({ [selector]: 'other-project' }), ['other-project', settings[url]]);
  assert.deepEqual(await launch({ [url]: 'http://localhost:8888' }), [null, 'http://localhost:8888']);
  await assert.rejects(launch({ [selector]: '*' }), /exact Crew project ID/);
  await writeFile(configFile, JSON.stringify({ ...settings, [selector]: '*' }));
  await assert.rejects(launch(), /exact Crew project ID/);
});
