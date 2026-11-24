import { constants } from 'node:fs';
import { chmod, mkdir, mkdtemp, open, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { CrewError, repoPath, requireField } from './contracts.mjs';

export const workspaceFileLimit = 300;
export const workspaceFileBytes = 256 * 1024;
export const workspaceTotalBytes = 2 * 1024 * 1024;
const reserved = new Set(['.git', '.agents', '.crew-tmp', 'node_modules']);
export const repositoryInstructionPaths = Object.freeze(['AGENTS.override.md', 'AGENTS.md']);

export function workspaceRepositoryInstruction(files = []) {
  const file = repositoryInstructionPaths.map(path => files.find(file => file.path === path)).find(Boolean);
  if (!file) return;
  const data = Buffer.from(file.data, 'base64');
  const content = data.toString('utf8');
  return { path: file.path, data, content };
}

export function validateRepositoryInstructionWorkspace(files = []) {
  requireField(!files.some(({ path }) => /^(?:config\.toml$|\.codex(?:\/|$))/i.test(path)),
    'Choose a workspace without Codex project configuration to load native repository instructions.');
}

export function workspacePath(path) {
  repoPath(path);
  requireField(!path.split('/').some(part => reserved.has(part.toLowerCase())), 'Workspace file uses a reserved path: ' + path);
  return path;
}

export function workspaceFiles(files) {
  requireField(Array.isArray(files), 'The Codex attempt did not return a workspace capture.');
  requireField(files.length <= workspaceFileLimit, 'The workspace exceeds the 300-file limit.');
  const seen = new Set();
  const casing = new Map();
  let bytes = 0;
  for (const file of files) {
    workspacePath(file?.path);
    requireField(!seen.has(file.path), 'Duplicate workspace file: ' + file.path);
    seen.add(file.path);
    let prefix = '';
    for (const component of file.path.split('/')) {
      prefix += (prefix ? '/' : '') + component;
      const key = prefix.toLowerCase();
      requireField(!casing.has(key) || casing.get(key) === prefix, 'Conflicting workspace file path: ' + file.path);
      casing.set(key, prefix);
    }
    requireField(['100644', '100755'].includes(file.mode) && typeof file.data === 'string' && file.data.length <= Math.ceil(workspaceFileBytes / 3) * 4,
      'Invalid or oversized workspace file: ' + file.path);
    const data = Buffer.from(file.data, 'base64');
    requireField(data.length <= workspaceFileBytes && data.toString('base64') === file.data, 'Invalid workspace file data: ' + file.path);
    bytes += data.length;
  }
  requireField(bytes <= workspaceTotalBytes, 'The captured workspace exceeds 2 MiB.');
  for (const path of seen) {
    const parts = path.split('/');
    for (let n = 1; n < parts.length; n++) requireField(!seen.has(parts.slice(0, n).join('/')), 'Conflicting workspace file path: ' + path);
  }
  return { files: files.toSorted((a, b) => a.path.localeCompare(b.path)), bytes };
}

export function readWorkspaceArtifact(content) {
  let parsed;
  try { parsed = JSON.parse(content); }
  catch { throw new CrewError('The saved workspace is unreadable.'); }
  requireField(parsed?.schemaVersion === 1, 'Unknown workspace artifact version.');
  return workspaceFiles(parsed.files);
}

export async function materializeWorkspaceFiles(inputs, signal) {
  const { files } = workspaceFiles(inputs);
  const directory = await mkdtemp(join(tmpdir(), 'crew-app-snapshot-'));
  try {
    await chmod(directory, 0o755);
    for (const file of files) {
      signal?.throwIfAborted();
      const path = join(directory, file.path);
      await mkdir(dirname(path), { recursive: true, mode: 0o755 });
      await writeFile(path, Buffer.from(file.data, 'base64'), { flag: 'wx', mode: file.mode === '100755' ? 0o755 : 0o644 });
    }
    return directory;
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}

export async function captureWorkflowWorkspace(directory, inputFolder, signal) {
  const root = await realpath(directory);
  const files = [];
  let bytes = 0;
  async function visit(parent = '') {
    signal?.throwIfAborted();
    for (const entry of await readdir(join(root, parent), { withFileTypes: true })) {
      const path = parent ? parent + '/' + entry.name : entry.name;
      if (reserved.has(entry.name.toLowerCase()) || path === inputFolder) continue;
      workspacePath(path);
      const absolute = join(root, path);
      requireField(await realpath(absolute) === absolute && absolute.startsWith(root + sep), 'Workspace paths must stay inside the assignment: ' + path);
      if (entry.isDirectory()) { await visit(path); continue; }
      requireField(entry.isFile(), 'Only regular files can be saved in a workspace: ' + path);
      requireField(files.length < workspaceFileLimit, 'The workspace exceeds the 300-file limit.');
      const file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stats = await file.stat();
        requireField(stats.isFile() && stats.nlink === 1 && stats.size <= workspaceFileBytes, 'Invalid or oversized workspace file: ' + path);
        const data = Buffer.alloc(stats.size + 1);
        let offset = 0;
        while (offset < data.length) {
          const { bytesRead } = await file.read(data, offset, data.length - offset, offset);
          if (!bytesRead) break;
          offset += bytesRead;
        }
        requireField(offset === stats.size, 'Workspace file changed during capture: ' + path);
        bytes += offset;
        requireField(bytes <= workspaceTotalBytes, 'The captured workspace exceeds 2 MiB.');
        files.push({ path, mode: stats.mode & 0o111 ? '100755' : '100644', data: data.subarray(0, offset).toString('base64') });
      } finally { await file.close(); }
    }
  }
  await visit();
  return workspaceFiles(files).files;
}

export function validateWorkspaceSteps(project, profileRuntime, baseline) {
  requireField(project.tasks.filter(task => task.publishWorkspace === true).length <= 1, 'Choose one verification step for local delivery.');
  for (const task of project.tasks) {
    const source = task.workspaceSource;
    requireField(task.publishWorkspace === undefined || (task.publishWorkspace === true && task.workspaceCheck),
      'Local delivery requires a workflow step with workspace acceptance checks.');
    if (task.workspaceRepair !== undefined) {
      const repair = task.workspaceRepair;
      requireField(task.workspaceCheck && typeof source === 'string' && source.startsWith('step:') &&
        ['manual', 'automatic'].includes(repair?.mode) && Number.isInteger(repair.limit) && repair.limit >= 1 && repair.limit <= 5,
      'Configure 1–5 repair rounds on a checked workspace from an accepted prerequisite.');
    }
    requireField(task.captureWorkspace === undefined || typeof task.captureWorkspace === 'boolean', 'Choose whether to save the step workspace.');
    if (!task.captureWorkspace && source === undefined) continue;
    const mode = profileRuntime(task.profileId)?.workspace;
    requireField(!task.execution && ['read-only', 'workspace-write'].includes(mode), 'Choose a native workspace agent for “' + task.title + '”.');
    requireField(!task.captureWorkspace || mode === 'workspace-write', 'Choose an editable workspace agent to save files from “' + task.title + '”.');
    if (source === undefined || source === 'delivery') continue;
    if (source === 'baseline') {
      requireField(baseline?.files.length, 'Pin committed project files before using them in “' + task.title + '”.');
      if (profileRuntime(task.profileId)?.repositoryInstructions && workspaceRepositoryInstruction(baseline.files))
        validateRepositoryInstructionWorkspace(baseline.files);
      continue;
    }
    const parent = typeof source === 'string' && source.startsWith('step:') && project.tasks.find(step => step.id === source.slice(5));
    requireField(parent?.captureWorkspace && task.prerequisites.includes(parent.id) && !task.joinPrerequisites?.includes(parent.id),
      'Choose an accepted prerequisite that saves workspace files for “' + task.title + '”.');
  }
}

export const usesPublishedWorkspace = project => project.tasks.some(task => task.workspaceSource === 'delivery');
