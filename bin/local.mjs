#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import pg from 'pg';
import { id } from '../lib/contracts.mjs';

// Keep credentials and project data local to this Crew installation.
const root = fileURLToPath(new URL('../', import.meta.url));
const state = join(root, '.crew-local');
const dbName = 'engineering-crew-' + createHash('sha256').update(root).digest('hex').slice(0, 10);
const docker = (args, options) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options }).trim();

async function localDatabase() {
  await mkdir(state, { recursive: true, mode: 0o700 });
  const keyPath = join(state, 'postgres-password');
  let password;
  try { password = (await readFile(keyPath, 'utf8')).trim(); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const tempKey = keyPath + '.' + randomBytes(8).toString('hex');
    await writeFile(tempKey, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
    try { await link(tempKey, keyPath); }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
    finally { await unlink(tempKey); }
    password = (await readFile(keyPath, 'utf8')).trim();
  }
  if (!/^[a-f0-9]{64}$/.test(password)) throw new Error('The local Crew database credential file is invalid');
  const list = () => docker(['container', 'ls', '-a', '--filter', 'name=^/' + dbName + '$', '--format', '{{.Names}}']);
  if (list() !== dbName) {
    try {
      docker(['run', '-d', '--name', dbName, '--restart', 'unless-stopped',
        '-p', '127.0.0.1::5432', '-v', dbName + ':/var/lib/postgresql/data',
        '-e', 'POSTGRES_PASSWORD', '-e', 'POSTGRES_DB=crew', 'postgres:17-bookworm'],
      { env: { ...process.env, POSTGRES_PASSWORD: password } });
    } catch (error) { if (list() !== dbName) throw error; }
  }
  if (docker(['inspect', '--format', '{{.State.Running}}', dbName]) !== 'true') docker(['start', dbName]);
  const endpoint = docker(['port', dbName, '5432/tcp']);
  if (!/^127\.0\.0\.1:\d+$/.test(endpoint)) throw new Error('Local database must bind exclusively to loopback');
  const url = 'postgresql://postgres:' + password + '@' + endpoint + '/crew';
  for (let retry = 0; retry < 50; retry++) {
    const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 700 });
    try { await client.connect(); await client.query('SELECT 1'); return url; }
    catch (error) { if (retry === 49) throw error; }
    finally { await client.end().catch(() => {}); }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
}

async function localTelemetry() {
  const keys = ['CREW_LANGFUSE_URL', 'CREW_LANGFUSE_PROJECT_ID', 'CREW_LANGFUSE_CREDENTIALS_FILE'];
  const selector = 'CREW_LANGFUSE_AUTO_PROJECT';
  if (process.env[selector]) id(process.env[selector], selector + ' (an exact Crew project ID)');
  if (keys.some(key => process.env[key] !== undefined)) return {};
  let settings;
  try { settings = JSON.parse(await readFile(join(state, 'langfuse.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  if (!settings || keys.some(key => typeof settings[key] !== 'string' || !settings[key])) {
    throw new Error('The local Langfuse settings need a URL, project ID and credentials file path');
  }
  const connection = Object.fromEntries(keys.map(key => [key, settings[key]]));
  if (process.env[selector] === undefined && settings[selector] !== undefined && settings[selector] !== '') {
    connection[selector] = id(settings[selector], selector + ' (an exact Crew project ID)');
  }
  return connection;
}

try {
  const databaseUrl = process.env.CREW_DATABASE_URL || await localDatabase();
  const args = process.argv.slice(2);
  const child = spawn(process.execPath, [join(root, 'bin', 'crew.mjs'), '--repo', root, ...(args.length ? args : ['ui', '--project-id', 'music-transcribe'])], {
    stdio: 'inherit', env: { ...process.env, ...await localTelemetry(), CREW_DATABASE_URL: databaseUrl },
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
} catch (error) {
  console.error('Could not start local Crew. ' + (error.stderr?.toString().trim() || error.message));
  process.exitCode = 1;
}
