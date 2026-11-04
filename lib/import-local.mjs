import { constants } from 'node:fs';
import { open, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { candidateFilesDigest } from './candidates.mjs';
import { CrewError, requireField } from './contracts.mjs';
import { transaction } from './database.mjs';
import { captureSourceFiles, legacyCandidateDiff } from './git-control.mjs';
import { artifactDigest, insertRun } from './run-store.mjs';
import { setProvisioner } from './resources.mjs';

export async function importLocal(db, control) {
  const root = join(control.gitDir, 'engineering-crew');
  const runs = join(root, 'runs');
  const entries = await readdir(runs, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  let bindings = [];
  const file = await open(join(root, 'provisioners.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    .catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
  if (file) {
    try {
      const info = await file.stat();
      requireField(info.isFile() && !(info.mode & 0o022) && info.size <= 65_536, 'Invalid legacy provisioner file');
      bindings = JSON.parse(await file.readFile('utf8'));
      requireField(Array.isArray(bindings), 'Invalid legacy provisioner list');
    } finally { await file.close(); }
  }

  return transaction(db, async client => {
    let imported = 0;
    let skipped = 0;
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile() || !/^[a-z0-9][a-z0-9-]{0,63}\.json$/.test(entry.name)) continue;
      const raw = await readFile(join(runs, entry.name), 'utf8');
      let run;
      try { run = JSON.parse(raw); }
      catch { throw new CrewError(`Invalid legacy run record ${entry.name}`); }
      requireField(run.id === entry.name.slice(0, -5) && run.project?.id && Array.isArray(run.tasks), 'Invalid legacy run record');
      const digest = artifactDigest(raw);
      await client.query('SELECT pg_advisory_xact_lock(710923815, hashtext($1))', [run.id]);
      const { rows: [existing] } = await client.query('SELECT import_digest FROM engineering_crew.runs WHERE id = $1', [run.id]);
      if (existing?.import_digest === digest) { skipped++; continue; }
      if (existing) throw new CrewError(`Run ${run.id} already exists`, 3);
      try {
        run.sourceFiles = captureSourceFiles(control, run.sourceCommit, run.tasks.map(task => task.packet));
        for (const task of run.tasks) {
          if (task.packet.execution?.kind !== 'build') continue;
          for (const attempt of task.attempts.filter(attempt => attempt.candidate)) {
            attempt.candidateFiles = captureSourceFiles(control, attempt.candidate.commit, [task.packet]);
            attempt.candidateFilesDigest = candidateFilesDigest(attempt.candidateFiles);
            if (!attempt.runnerArtifacts?.['candidate-diff']) attempt.candidateDiff = legacyCandidateDiff(control, attempt.candidate);
          }
        }
      } catch {
        throw new CrewError(`Could not capture the Git source or candidate files for legacy run ${run.id}`);
      }
      await insertRun(client, run, digest);
      imported++;
    }
    for (const { project, action, target, command } of bindings) {
      await setProvisioner(client, project, action, target, command, { importing: true });
    }
    return { imported, skipped };
  });
}
