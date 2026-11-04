import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requireField } from './contracts.mjs';
import { artifactDigest } from './run-store.mjs';

const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'Engineering Crew', GIT_AUTHOR_EMAIL: 'crew@example.invalid',
  GIT_COMMITTER_NAME: 'Engineering Crew', GIT_COMMITTER_EMAIL: 'crew@example.invalid',
  GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z' });

export function candidateFilesDigest(files) {
  return artifactDigest(JSON.stringify(Object.keys(files).sort().map(path => {
    const { mode, content } = files[path];
    return [path, mode, content];
  })));
}

export function buildCandidate(base, sourceFiles, execution, changes) {
  const directory = mkdtempSync(join(tmpdir(), 'crew-candidate-'));
  const git = (args, input) => execFileSync('git', ['-C', directory, ...args], {
    env, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 512 * 1024,
  });
  const index = (path, { mode, content }) => {
    const blob = git(['hash-object', '-w', '--stdin', '--no-filters'], content).trim();
    git(['update-index', '--add', '--cacheinfo', `${mode},${blob},${path}`]);
  };
  try {
    git(['init', '-q', '--template=', '--object-format=sha1']);
    const files = Object.fromEntries([...new Set(execution.files)].sort().map(path => {
      requireField(Object.hasOwn(sourceFiles, path), `No captured source at ${path}`);
      return [path, sourceFiles[path]];
    }));
    for (const [path, file] of Object.entries(files)) index(path, file);
    const baseline = git(['write-tree']).trim();
    for (const { path, content } of changes) {
      files[path] = { ...files[path], content };
      index(path, files[path]);
    }
    const tree = git(['write-tree']).trim();
    requireField(tree !== baseline, 'Engineer returned no changes to the base tree');
    const commit = git(['commit-tree', tree, '-m', `Engineering Crew candidate from ${base}`]).trim();
    const diff = git(['diff', '--no-ext-diff', '--no-textconv', '--no-color', baseline, tree, '--']);
    return { candidate: { commit, base, filesDigest: candidateFilesDigest(files), paths: changes.map(change => change.path) }, files, diff };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
