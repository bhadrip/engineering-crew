import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CrewError, repoPath, requireField, validateProject } from './contracts.mjs';

const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));

function git(directory, ...args) {
  return execFileSync('git', ['--no-replace-objects', '-C', directory, ...args], {
    env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024,
  });
}

export function gitFile(control, commit, path) {
  repoPath(path);
  requireField(/^[a-f0-9]{40,64}$/.test(commit), 'Expected a pinned Git revision');
  const entry = git(control.root, '--literal-pathspecs', 'ls-tree', commit, '--', path).trimEnd();
  const mode = /^(100(?:644|755)) blob [0-9a-f]+\t/.exec(entry)?.[1];
  requireField(mode, `Expected a committed regular file at ${path}`);
  try { return { content: git(control.root, 'show', `${commit}:${path}`), mode }; }
  catch { throw new CrewError(`Could not read ${path} from Git within the input size limit`); }
}

export function createCandidate(control, base, ref, changes) {
  const directory = mkdtempSync(join(tmpdir(), 'crew-index-'));
  const env = { ...gitEnv, GIT_INDEX_FILE: join(directory, 'index'), GIT_AUTHOR_NAME: 'Engineering Crew',
    GIT_AUTHOR_EMAIL: 'crew@example.invalid', GIT_COMMITTER_NAME: 'Engineering Crew', GIT_COMMITTER_EMAIL: 'crew@example.invalid' };
  const run = (args, input) => execFileSync('git', ['--no-replace-objects', '-C', control.root, ...args], {
    env, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 256 * 1024,
  }).trim();
  try {
    run(['read-tree', base]);
    for (const { path, content } of changes) {
      const original = gitFile(control, base, path);
      const blob = run(['hash-object', '-w', '--stdin', '--no-filters'], content);
      run(['update-index', '--cacheinfo', `${original.mode},${blob},${path}`]);
    }
    const tree = run(['write-tree']);
    requireField(tree !== run(['rev-parse', `${base}^{tree}`]), 'Engineer returned no changes to the base tree');
    const commit = run(['commit-tree', tree, '-p', base, '-m', 'Engineering Crew candidate']);
    run(['update-ref', ref, commit, '0'.repeat(commit.length)]);
    return { commit, ref, base, paths: changes.map(change => change.path) };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

export function candidateDiff(control, candidate) {
  return git(control.root, 'diff', '--no-ext-diff', '--no-textconv', '--no-color', candidate.base, candidate.commit, '--');
}

export function gitControl(directory) {
  try {
    const root = git(resolve(directory), 'rev-parse', '--show-toplevel').trimEnd();
    return { root, gitDir: git(root, 'rev-parse', '--absolute-git-dir').trimEnd() };
  } catch {
    throw new CrewError('Choose a local Git checkout with --repo');
  }
}

export function readProject(control, projectPath, ref = 'HEAD') {
  repoPath(projectPath);
  let sourceCommit;
  try {
    sourceCommit = git(control.root, 'rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`).trim();
  } catch {
    throw new CrewError(`Git cannot resolve ${ref} to a commit. Commit the project inputs or select an existing ref.`);
  }

  const read = path => gitFile(control, sourceCommit, path).content;

  const raw = read(projectPath);
  let project;
  try { project = JSON.parse(raw); }
  catch { throw new CrewError('Project configuration is not valid JSON'); }
  validateProject(project);

  const files = new Map([[projectPath, raw]]);
  for (const path of [...project.inputs.map(input => input.path),
    ...project.profiles.flatMap(profile => [profile.instructions, ...profile.skills])]) {
    if (!files.has(path)) files.set(path, read(path));
  }
  requireField([...files.values()].reduce((size, contents) => size + Buffer.byteLength(contents), 0) <= 180_000,
    'The committed project inputs exceed the pilot size limit');
  return { project, sourceCommit, files };
}
