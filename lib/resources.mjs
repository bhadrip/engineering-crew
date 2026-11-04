import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { currentAttempt } from './attempts.mjs';
import { requireField } from './contracts.mjs';
import { artifact } from './run-store.mjs';

const executeFile = promisify(execFile);
const provisionTimeout = 30_000;
const sameResource = (a, b) => a.action === b.action && a.target === b.target;

export function resourceWait(run, task) {
  const attempt = currentAttempt(task);
  return (attempt?.resourceIds ?? []).map(id => run.resources.find(resource => resource.id === id));
}

export function openResources(run) {
  const activeIds = new Set(run.tasks.flatMap(task => currentAttempt(task)?.resourceIds ?? []));
  return (run.resources ?? []).filter(resource => activeIds.has(resource.id) && !resource.resolution);
}

export function isProvisioning(resource) {
  return !resource.resolution && resource.automatic?.status === 'running' &&
    Date.now() < Date.parse(resource.automatic.expiresAt);
}

export function recordResourceRequests(run, attempt, taskId, requests) {
  const resources = run.resources ?? [];
  const existing = requests.map(request => resources.find(resource => sameResource(resource, request)));
  requireField(existing.every(resource => !resource?.resolution ||
    !attempt.inputArtifacts.includes(resource.resolution.artifactId)), 'Agent requested a resource whose resolution it already received');
  requireField(resources.length + existing.filter(resource => !resource).length <= 20, 'Run resource request limit reached');
  const claims = [];
  const rules = run.resourcePolicy?.rules ?? [];
  attempt.resourceIds = requests.map(({ action, target, reason }, index) => {
    if (existing[index]) return existing[index].id;
    const rule = rules.find(rule => sameResource(rule, { action, target })) ??
      rules.find(rule => rule.action === action && rule.target === undefined);
    const now = Date.now();
    const resource = { id: randomUUID(), action, target, reason, mode: rule?.mode ?? 'manual',
      taskId, attemptId: attempt.id, requestedAt: new Date(now).toISOString() };
    if (resource.mode === 'auto') {
      resource.automatic = { status: 'running', expiresAt: new Date(now + provisionTimeout + 5_000).toISOString() };
      claims.push(resource);
    }
    resources.push(resource);
    return resource.id;
  });
  run.resources = resources;
  return claims;
}

export function recordResourceResolution(run, resource, disposition, source, note) {
  const artifactId = `resource-${resource.id}`;
  resource.resolution = { disposition, source, note, artifactId, recordedAt: new Date().toISOString() };
  const { id, action, target, mode, taskId, attemptId, resolution } = resource;
  run.artifacts.push(artifact(artifactId, `Resource resolution · ${target}`, 'json',
    JSON.stringify({ schemaVersion: 1, runId: run.id, resourceId: id, action, target, mode, taskId, attemptId, ...resolution }, null, 2),
    { source: 'resource-resolution', sourceCommit: run.sourceCommit, attemptId }));
  return resolution;
}

export async function provisionResource(control, projectId, resource, signal) {
  if (!control) return { status: 'unavailable', detail: 'No local provisioner is configured.' };
  let command;
  try {
    const path = join(control.gitDir, 'engineering-crew', 'provisioners.json');
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const info = await file.stat();
      requireField(info.isFile() && !(info.mode & 0o022) && info.size <= 65_536, 'Invalid provisioner file');
      const entries = JSON.parse(await file.readFile('utf8'));
      const matches = entries.filter(entry => entry?.project === projectId && sameResource(entry, resource));
      requireField(matches.length <= 1, 'Duplicate provisioner');
      command = matches[0]?.command;
      requireField(!matches.length || (Array.isArray(command) && command.length > 0 && command.length <= 32 &&
        command.every(arg => typeof arg === 'string' && arg.length <= 4096 && !arg.includes('\0')) &&
        isAbsolute(command[0])), 'Invalid provisioner command');
    } finally { await file.close(); }
  } catch (error) {
    if (error.code !== 'ENOENT') return { status: 'unavailable', detail: 'The local provisioner configuration could not be loaded.' };
  }
  if (!command) return { status: 'unavailable', detail: 'No matching local provisioner is configured.' };
  const remaining = Date.parse(resource.automatic.expiresAt) - Date.now() - 5_000;
  if (remaining <= 0) return { status: 'failed', detail: 'Automatic setup expired. Verify the resource before confirming it.' };
  try {
    await executeFile(command[0], command.slice(1), { cwd: dirname(command[0]), signal,
      timeout: Math.min(remaining, provisionTimeout), killSignal: 'SIGKILL', maxBuffer: 64 * 1024 });
    return { status: 'succeeded', detail: 'The configured provisioner reported success.' };
  } catch {
    return { status: 'failed', detail: 'Automatic setup failed. Verify or finish setup before confirming the resource.' };
  }
}
