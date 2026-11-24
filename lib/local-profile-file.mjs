import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { CrewError, id } from './contracts.mjs';

function profilePath(repo, projectId) {
  return join(resolve(repo), '.crew-local', 'profiles', id(projectId, 'project ID') + '.json');
}

async function readConfig(path) {
  try {
    const config = JSON.parse(await readFile(path, 'utf8'));
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new CrewError('Expected a project profile JSON object', 2);
    return config;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error instanceof SyntaxError) throw new CrewError('The project profile contains invalid JSON', 2);
    throw error;
  }
}

export async function readProjectProfile(repo, projectId) {
  return await readConfig(profilePath(repo, projectId)) ?? {};
}

// The CLI, dashboard and standalone pilot preparer can update the same file.
// Publish a unique intent before choosing a ticket so simultaneous writers
// can order themselves by (ticket, unique name). A crashed process leaves
// only its own entry, which can be discarded without removing a newer lock.
async function liveTickets(directory) {
  const tickets = [];
  for (const name of await readdir(directory)) {
    const match = /^(\d+)-(\d+)-([a-f0-9-]+)$/.exec(name);
    if (!match) continue;
    const pid = Number(match[2]);
    try { process.kill(pid, 0); }
    catch (error) {
      if (error.code === 'ESRCH') { await rm(join(directory, name), { force: true }); continue; }
      if (error.code !== 'EPERM') throw error;
    }
    tickets.push({ name, number: Number(match[1]) });
  }
  return tickets;
}

export async function editProjectProfile(repo, projectId, edit) {
  const path = profilePath(repo, projectId);
  const directory = join(dirname(path), '.' + projectId + '-writers');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const unique = process.pid + '-' + randomUUID();
  let claim = join(directory, '0-' + unique);
  await writeFile(claim, '', { flag: 'wx', mode: 0o600 });
  try {
    const tickets = await liveTickets(directory);
    const number = tickets.reduce((largest, entry) => Math.max(largest, entry.number), 0) + 1;
    const name = number + '-' + unique;
    const ready = join(directory, name);
    await rename(claim, ready);
    claim = ready;
    const deadline = Date.now() + 5000;
    while ((await liveTickets(directory)).some(entry => entry.number < number || (entry.number === number && entry.name < name))) {
      if (Date.now() >= deadline) throw new CrewError('Another writer is updating the project profile. Try saving again.', 3);
      await wait(25);
    }
    const saved = await readConfig(path);
    const current = saved ?? {};
    const next = await edit(current, { exists: saved !== null });
    if (next !== current) {
      const temp = path + '.' + unique;
      try {
        await writeFile(temp, JSON.stringify(next, null, 2) + '\n', { flag: 'wx', mode: 0o600, flush: true });
        await rename(temp, path);
      } finally { await rm(temp, { force: true }); }
    }
    return next;
  } finally { await rm(claim, { force: true }); }
}
