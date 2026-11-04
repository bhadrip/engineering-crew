import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CrewError, repoPath, requireField, text, validateProject } from './contracts.mjs';

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

export function legacyCandidateDiff(control, { base, commit }) {
  requireField([base, commit].every(revision => /^[a-f0-9]{40,64}$/.test(revision)), 'Invalid legacy candidate revisions');
  return git(control.root, 'diff', '--no-ext-diff', '--no-textconv', '--no-color', base, commit, '--');
}

export function gitControl(directory, { optional = false } = {}) {
  try {
    const root = git(resolve(directory), 'rev-parse', '--show-toplevel').trimEnd();
    return { root, gitDir: git(root, 'rev-parse', '--absolute-git-dir').trimEnd() };
  } catch {
    if (optional) return { root: resolve(directory) };
    throw new CrewError('Choose a local Git checkout with --repo');
  }
}

function validateTriage({ triage, inputs, tasks, profiles }) {
  if (triage !== undefined) {
    requireField(['manual', 'static'].includes(triage?.mode), 'Triage mode must be manual or static');
    const { briefInput = 'brief', owners } = triage;
    requireField(inputs.some(input => input.id === briefInput), 'Triage must reference a configured brief input');
    if (triage.mode === 'manual') {
      requireField(Array.isArray(owners) && owners.length > 0 && owners.length <= 20 && new Set(owners).size === owners.length,
        'Manual triage needs 1 to 20 distinct owners');
      for (const owner of owners) {
        text(owner, 'triage owner', 120);
        requireField(owner === owner.trim(), 'Triage owners must not have surrounding whitespace');
      }
    } else requireField(owners === undefined, 'Only manual triage can configure owners');
  }
  for (const { id, profileId, alternateProfiles } of tasks) {
    if (alternateProfiles === undefined) continue;
    requireField(triage?.mode === 'manual', 'Alternate profiles require manual triage');
    requireField(Array.isArray(alternateProfiles) && alternateProfiles.length < profiles.length &&
      new Set([profileId, ...alternateProfiles]).size === alternateProfiles.length + 1, `Invalid alternate profiles for ${id}`);
    for (const alternate of alternateProfiles) {
      requireField(profiles.some(profile => profile.id === alternate), `Unknown alternate profile: ${alternate}`);
    }
  }
}

function resolveCommit(control, ref) {
  try {
    return git(control.root, 'rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`).trim();
  } catch {
    throw new CrewError(`Git cannot resolve ${ref} to a commit. Commit the source and agent files or select an existing ref.`);
  }
}

function parseProject(raw) {
  let project;
  try { project = JSON.parse(raw); }
  catch { throw new CrewError('Project configuration is not valid JSON'); }
  validateProject(project);
  validateTriage(project);
  return project;
}

function captureProject(control, sourceCommit, raw, overrides = new Map()) {
  const project = parseProject(raw);
  const files = new Map();
  const inputOverrides = [];
  for (const input of project.inputs) {
    const path = overrides.get(input.id);
    if (path !== undefined) inputOverrides.push([input.id, readLocal(path, 'input')]);
    else files.set(input.path, gitFile(control, sourceCommit, input.path).content);
  }
  for (const key of overrides.keys()) {
    requireField(project.inputs.some(input => input.id === key), `Unknown input ${key}`);
  }
  for (const path of project.profiles.flatMap(profile => [profile.instructions, ...profile.skills])) {
    if (!files.has(path)) files.set(path, gitFile(control, sourceCommit, path).content);
  }
  const sourceFiles = captureSourceFiles(control, sourceCommit, project.tasks);
  const contents = [raw, ...files.values(), ...inputOverrides.map(([, content]) => content)];
  requireField(contents.reduce((size, content) => size + Buffer.byteLength(content), 0) <= 180_000,
    'The captured configuration and inputs exceed the project size limit');
  return { project, sourceCommit, raw, files, inputOverrides, sourceFiles };
}

export function captureSourceFiles(control, sourceCommit, tasks) {
  const paths = new Set(tasks.flatMap(task => task.execution?.files ?? []));
  return Object.fromEntries([...paths].map(path => [path, gitFile(control, sourceCommit, path)]));
}

function readLocal(path, label) {
  try { return readFileSync(path, 'utf8'); }
  catch { throw new CrewError(`Could not read the ${label} file`); }
}

export function captureConfiguration(control, path, ref = 'HEAD', overrides) {
  return captureProject(control, resolveCommit(control, ref), readLocal(path, 'configuration'), overrides);
}

// Committed example configuration reader for fixture and agent evaluation tooling.
export function readProject(control, projectPath, ref = 'HEAD') {
  const sourceCommit = resolveCommit(control, ref);
  return captureProject(control, sourceCommit, gitFile(control, sourceCommit, projectPath).content);
}
