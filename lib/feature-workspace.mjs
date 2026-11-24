import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export const digest = value => createHash('sha256').update(value).digest('hex');
const oidPattern = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
export function checkedRevision(value) {
  if (!oidPattern.test(value)) throw new Error('Expected an immutable Git commit');
  return value;
}
export function projectKey(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(value)) throw new Error('Invalid project ID');
  return value;
}
// Keep project config, dependencies, credential files and non-regular Git
// entries outside the model input and the application mount.
export function sourcePath(path) {
  if (typeof path !== 'string' || path.length > 280 || !path.split('/').every(part =>
    /^[A-Za-z0-9_][A-Za-z0-9_ .+@()-]*$/.test(part) && !part.endsWith('.') && !part.endsWith(' ')
    && !['node_modules', '__pycache__'].includes(part))) return false;
  return !/(?:^|\/)(?:id_(?:rsa|ed25519)|credentials(?:\.[^/]*)?|auth\.json|[^/]*\.(?:pem|key|p12|pfx))$/i.test(path);
}

const gitEnvironment = {
  PATH: process.env.PATH, LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Engineering Crew', GIT_COMMITTER_NAME: 'Engineering Crew',
  GIT_AUTHOR_EMAIL: 'crew@localhost', GIT_COMMITTER_EMAIL: 'crew@localhost',
  GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_PAGER: 'cat',
};

export async function git(directory, args, { signal, index, input, binary = false } = {}) {
  signal?.throwIfAborted();
  const env = { ...gitEnvironment, ...(index ? { GIT_INDEX_FILE: index } : {}) };
  const argv = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false',
    '-c', 'core.attributesFile=/dev/null', '-C', directory, ...args];
  if (input === undefined) {
    const { stdout } = await exec('git', argv, { env, signal, encoding: binary ? 'buffer' : 'utf8',
      timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
    return binary ? stdout : stdout.trimEnd();
  }
  return new Promise((res, rej) => {
    const child = spawn('git', argv, { env, signal, timeout: 30_000, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', chunk => { out = (out + chunk).slice(-4096); });
    child.stderr.on('data', chunk => { err = (err + chunk).slice(-4096); });
    child.on('error', rej);
    child.on('close', code => code === 0 ? res(out.trim()) : rej(new Error('Git operation failed: ' + err.trim())));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

async function maybeRef(dir, ref, signal) {
  try { return checkedRevision(await git(dir, ['rev-parse', '--verify', '--quiet', ref], { signal })); }
  catch (err) { if (err.code === 1) return null; throw err; }
}

export async function project(rootDir, ctx) {
  projectKey(ctx.projectId);
  const managed = !ctx.repoPath || resolve(ctx.repoPath) === resolve(rootDir, ctx.projectId);
  const path = resolve(ctx.repoPath || join(rootDir, ctx.projectId));
  if (managed) {
    await mkdir(rootDir, { recursive: true, mode: 0o700 });
    await mkdir(path, { recursive: true, mode: 0o700 });
    if ((await lstat(path)).isSymbolicLink()) throw new Error('Managed project must be a local directory');
    if (!(await readdir(path)).length) {
      await git(path, ['init', '--initial-branch=main', '--template='], { signal: ctx.signal });
    }
  }
  const repoPath = await realpath(path);
  const root = await git(repoPath, ['rev-parse', '--show-toplevel'], { signal: ctx.signal });
  if (await realpath(root) !== repoPath) throw new Error('Choose the root of a local Git repository');
  let head = await maybeRef(repoPath, 'HEAD', ctx.signal);
  if (!head && managed) {
    await git(repoPath, ['commit', '--allow-empty', '-m', 'Initialize local Engineering Crew project'], { signal: ctx.signal });
    head = await maybeRef(repoPath, 'HEAD', ctx.signal);
  }
  if (!head) throw new Error('Project needs an existing local commit');
  const branch = managed ? 'main' : 'crew/delivered';
  const base = await maybeRef(repoPath, 'refs/heads/' + branch, ctx.signal) || head;
  return { repoPath, branch, base, managed };
}

// Git blobs are read directly. Checkout filters, symlinks, Git metadata and
// dirty files from the user's checkout never enter an agent or app workspace.
export async function entries(dir, commit, signal) {
  checkedRevision(commit);
  const tree = await git(dir, ['ls-tree', '-r', '-l', '-z', commit], { signal, binary: true });
  const files = tree.toString().split('\0').filter(Boolean).flatMap(line => {
    const match = /^(100644|100755) blob ([a-f0-9]+) +([0-9]+)\t([^\n]+)$/.exec(line);
    if (!match || !sourcePath(match[4])) return [];
    return [{ path: match[4], oid: match[2], size: Number(match[3]), mode: match[1] }];
  });
  if (files.length > 5000 || files.reduce((n,f) => n + f.size, 0) > 128*1024*1024
      || files.some(f => f.size > 12*1024*1024)) throw new Error('Project exceeds the local snapshot limit');
  return files;
}

export async function materialize(repoPath, revision, signal, { allowEmpty = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'crew-app-snapshot-'));
  try {
    const files = await entries(repoPath, revision, signal);
    if (!files.length && !allowEmpty) throw new Error('Application snapshot is empty');
    await chmod(directory, 0o755);
    for (const file of files) {
      const dest = join(directory, file.path);
      await mkdir(dirname(dest), { recursive: true, mode: 0o755 });
      const data = await git(repoPath, ['cat-file', 'blob', file.oid], { signal, binary: true });
      await writeFile(dest, data, { flag: 'wx', mode: file.mode === '100755' ? 0o755 : 0o644 });
    }
    return directory;
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}

export const candidateRef = id => 'refs/crew/candidates/' + digest(String(id));
export const priorCandidate = (repoPath, id, signal) => maybeRef(repoPath, candidateRef(id), signal);

export async function commitChanges({ repoPath, parent, changes, operationId, signal, onEvent }) {
  checkedRevision(parent);
  if (!Array.isArray(changes) || !changes.length || changes.length > 100) throw new Error('Engineer must supply 1–100 file changes');
  const dir = await mkdtemp(join(tmpdir(), 'crew-index-'));
  const index = join(dir, 'index');
  const paths = new Set();
  try {
    await git(repoPath, ['read-tree', parent], { index, signal });
    for (const item of changes) {
      if (!sourcePath(item.path) || !['write', 'delete'].includes(item.action) || paths.has(item.path)
        || typeof item.content !== 'string' || Buffer.byteLength(item.content) > 512_000) throw new Error('Rejected unsupported agent file operation');
      paths.add(item.path);
      if (item.action === 'write') {
        const blob = await git(repoPath, ['hash-object', '-w', '--stdin'], { input: item.content, signal });
        const old = await git(repoPath, ['ls-tree', parent, '--', item.path], { signal });
        if (old && !/^100(?:644|755) blob /.test(old)) throw new Error('Cannot replace a directory or special Git entry');
        await git(repoPath, ['update-index', '--add', '--cacheinfo', old.startsWith('100755 ') ? '100755' : '100644', blob, item.path], { index, signal });
      } else {
        const old = await git(repoPath, ['ls-tree', parent, '--', item.path], { signal });
        if (!/^100(?:644|755) blob /.test(old)) throw new Error('Cannot delete a missing or special Git entry');
        await git(repoPath, ['update-index', '--force-remove', '--', item.path], { index, signal });
      }
      await onEvent({ type: 'workspace.changed', evidence: { action: item.action, path: item.path, bytes: Buffer.byteLength(item.content) } });
    }
    const tree = await git(repoPath, ['write-tree'], { index, signal });
    const previousTree = await git(repoPath, ['rev-parse', parent + '^{tree}'], { signal });
    if (tree === previousTree) throw new Error('Engineer produced no changes');
    const revision = await git(repoPath, ['commit-tree', tree, '-p', parent, '-m', 'Implement Engineering Crew feature'], { signal });
    if (operationId === undefined) return checkedRevision(revision);
    try { await git(repoPath, ['update-ref', candidateRef(operationId), revision, ''], { signal }); }
    catch (error) {
      const winner = await priorCandidate(repoPath, operationId, signal);
      if (winner) return winner;
      throw error;
    }
    return checkedRevision(revision);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

export async function promoteCandidate(project, ctx) {
  const { repoPath, branch, managed } = project;
  const revision = checkedRevision(ctx.revision || ctx.candidate?.revision);
  const base = checkedRevision(ctx.candidate.base);
  const { signal } = ctx;
  await git(repoPath, ['merge-base', '--is-ancestor', base, revision], { signal });
  const ref = 'refs/heads/' + branch;
  const current = await maybeRef(repoPath, ref, signal);
  if (current !== revision) {
    if (current && current !== base) throw new Error('Delivery branch advanced after planning; replan against its new revision');
    if (managed) {
      if (await git(repoPath, ['symbolic-ref', 'HEAD'], { signal }) !== ref
        || await git(repoPath, ['status', '--porcelain'], { signal })) throw new Error('Managed checkout has local changes or an unexpected branch');
      await git(repoPath, ['merge', '--ff-only', '--no-edit', revision], { signal });
    } else {
      const worktrees = await git(repoPath, ['worktree', 'list', '--porcelain'], { signal });
      if (worktrees.split('\n').includes('branch ' + ref)) throw new Error('Check out another branch before Crew updates its delivery branch');
      await git(repoPath, ['update-ref', ref, revision, current || ''], { signal });
    }
  }
  return { revision, branch, repoPath, local: true };
}
