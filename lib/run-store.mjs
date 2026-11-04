import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CrewError, id } from './contracts.mjs';

export const artifactDigest = content => createHash('sha256').update(content).digest('hex');

export function artifact(id, title, kind, content, provenance) {
  return { id, title, kind, digest: artifactDigest(content), provenance, content };
}

export async function listRuns(gitDir) {
  let entries;
  try { entries = await readdir(join(gitDir, 'engineering-crew', 'runs'), { withFileTypes: true }); }
  catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const runs = [];
  for (const entry of entries) {
    if (entry.isFile() && /^[a-z0-9][a-z0-9-]{0,63}\.json$/.test(entry.name)) {
      runs.push(await runStore(gitDir, entry.name.slice(0, -5)).read());
    }
  }
  return runs;
}

export function runStore(gitDir, runId) {
  id(runId, 'run ID');
  const root = join(gitDir, 'engineering-crew', 'runs');
  const path = join(root, `${runId}.json`);

  async function read() {
    try { return JSON.parse(await readFile(path, 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') throw new CrewError(`Run ${runId} does not exist`, 4);
      if (error instanceof SyntaxError) throw new CrewError(`Run ${runId} has an invalid local record`);
      throw error;
    }
  }

  async function write(record) {
    const temp = join(root, `${runId}.${randomUUID()}.tmp`);
    try {
      await writeFile(temp, JSON.stringify(record), { mode: 0o600, flag: 'wx' });
      await rename(temp, path);
    } finally {
      await rm(temp, { force: true });
    }
  }

  async function locked(callback) {
    await mkdir(root, { mode: 0o700, recursive: true });
    const lockPath = `${path}.lock`;
    let lock;
    for (let retry = 0; !lock; retry++) {
      try { lock = await open(lockPath, 'wx', 0o600); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (retry === 20) throw new CrewError(`Run ${runId} is being updated. Try again.`, 3);
        await delay(25);
      }
    }
    try { return await callback(); }
    finally {
      await lock.close();
      await unlink(lockPath);
    }
  }

  return {
    read,
    create: record => locked(async () => {
      try { await read(); }
      catch (error) {
        if (error.code !== 4) throw error;
        await write(record);
        return;
      }
      throw new CrewError(`Run ${runId} already exists`, 3);
    }),
    update: callback => locked(async () => {
      const record = await read();
      const result = callback(record);
      await write(record);
      return result;
    }),
  };
}
