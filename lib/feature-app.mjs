import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { setTimeout as wait } from 'node:timers/promises';
import { checkedRevision, digest, materialize, projectKey } from './feature-workspace.mjs';

const exec = promisify(execFile);
const defaults = ['--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', '1000:1000',
  '--pids-limit', '128', '--memory', '1g', '--cpus', '2', '--log-driver', 'local', '--log-opt', 'max-size=5m',
  '--log-opt', 'max-file=2', '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=128m,mode=1777'];
export function imageName(image) {
  if (typeof image !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_./:@-]{0,250}$/.test(image)) throw new Error('Invalid trusted Docker image');
  return image;
}
const id = () => randomUUID().replaceAll('-', '');
const safeDockerName = /^crew-app-[a-f0-9]{32}$/;
const previewDataVolume = (projectId, scope) => 'crew-data-' + digest(projectId + '\n' + scope).slice(0, 24);
async function docker(args, options = {}) {
  const { stdout } = await exec('docker', args, { timeout: 30_000, maxBuffer: 512_000, encoding: 'utf8', ...options });
  return stdout.trimEnd();
}

function bind(directory, target) {
  if (directory.includes(',') || !directory.startsWith('/')) throw new Error('Invalid snapshot mount path');
  return ['--mount', 'type=bind,src=' + directory + ',dst=' + target + ',readonly'];
}
function boundedLog(text) {
  return String(text || '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(-6000);
}

async function healthError(response) {
  const reader = response.body?.getReader();
  let detail = '';
  if (reader) {
    try {
      const { value } = await reader.read();
      detail = boundedLog(Buffer.from(value?.subarray(0, 320) || '').toString()).replace(/\s+/g, ' ').trim().slice(0, 240);
    } catch { /* The per-probe deadline also bounds a stalled error body. */ }
    finally { await reader.cancel().catch(() => {}); }
  }
  return 'GET /health returned HTTP ' + response.status + (detail ? ' (' + detail + ')' : '');
}

export async function runNodeTests({ directory, image, independentTest, signal, onEvent }) {
  const container = 'crew-app-' + id();
  const testDir = independentTest ? await mkdtemp(join(tmpdir(), 'crew-independent-test-')) : null;
  try {
    if (testDir) {
      await chmod(testDir, 0o755);
      await writeFile(join(testDir, 'acceptance.test.mjs'), independentTest, { mode: 0o644 });
    }
    const command = ['node', '--test', '--test-reporter=tap', ...(testDir ? ['/crew-tests/acceptance.test.mjs'] : [])];
    await onEvent({ type: 'app.test.started', evidence: { command, image, network: 'none', mount: 'read-only' } });
    const args = ['run', '--rm', '--pull=never', '--name', container, '--network', 'none', ...defaults,
      '--tmpfs', '/data:rw,noexec,nosuid,nodev,size=128m,uid=1000,gid=1000', '--env', 'DATA_DIR=/data',
      ...bind(directory, '/app'), ...(testDir ? bind(testDir, '/crew-tests') : []), '--workdir', '/app',
      '--entrypoint', 'node', imageName(image), ...command.slice(1)];
    try {
      const output = await docker(args, { timeout: 120_000, signal });
      const total = [...output.matchAll(/^# pass ([0-9]+)$/gm)].at(-1);
      const passed = Number(total?.[1]) > 0;
      return { passed, command, exitCode: 0, output: boundedLog(output), reason: passed ? 'Tests passed' : 'Runner did not report executing any tests' };
    } catch (error) {
      signal?.throwIfAborted();
      if (error.code === 125 || error.code === 'ENOENT') throw new Error('Docker could not run the pinned application image: ' + boundedLog(error.stderr || error.code));
      return { passed: false, command, exitCode: Number.isInteger(error.code) ? error.code : null, output: boundedLog(String(error.stdout || '') + '\n' + String(error.stderr || '')) };
    }
  } finally {
    await docker(['rm', '-f', container], { timeout: 5000 }).catch(() => {});
    if (testDir) await rm(testDir, { recursive: true, force: true });
  }
}

// Use the local image's immutable ID for every invocation in an attempt.
export async function inspectAppImage(image = process.env.CREW_APP_IMAGE || 'node:22-alpine', signal) {
  const value = await docker(['image', 'inspect', '--format', '{{.Id}}', imageName(image)], { signal });
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) throw new Error('Docker did not return the local image ID');
  return value;
}

export async function stopFeaturePreview({ container, network, directory, lessonSource }) {
  if (!safeDockerName.test(container) || network !== container + '-net') throw new Error('Invalid Crew preview identity');
  // Keep the source directory until its container is known to be gone.
  async function remove(args) {
    try { await docker(args, { timeout: 10000 }); }
    catch (err) { if (!/No such (?:container|network)|network .* not found/i.test(String(err.stderr))) throw err; }
  }
  await remove(['rm', '-f', container + '-http']);
  if (lessonSource) await remove(['rm', '-f', container + '-data-copy']);
  await remove(['rm', '-f', container]);
  await remove(['network', 'rm', network]);
  if (directory && /^crew-app-snapshot-[A-Za-z0-9]+$/.test(basename(directory)) &&
    await realpath(dirname(directory)) === await realpath(tmpdir())) {
    await rm(directory, { recursive: true, force: true });
  }
}

async function copyPreviewLessons({ projectId, source, image, container, dataMount, signal }) {
  const sourceVolume = previewDataVolume(projectId, source.scope);
  let sourceMount = [];
  try {
    await docker(['volume', 'inspect', '--format', '{{.Name}}', sourceVolume], { signal });
    sourceMount = ['--mount', 'type=volume,src=' + sourceVolume + ',dst=/previous,readonly'];
  } catch (error) {
    if (!/no such volume/i.test(error.stderr ?? '')) throw error;
  }
  const script = fileURLToPath(new URL('./music-preview-library.mjs', import.meta.url));
  const result = await docker(['run', '--rm', '--pull=never', '--name', container + '-data-copy', '--network', 'none',
    ...defaults, ...sourceMount, ...dataMount, ...bind(script, '/crew-music-library.mjs'), '--entrypoint', 'node', image,
    '/crew-music-library.mjs', sourceMount.length ? '/previous' : '-', source.runId], { timeout: 120_000, signal });
  return JSON.parse(result);
}

export async function startFeaturePreview({ repoPath, revision, projectId, port = 0, image = process.env.CREW_APP_IMAGE || 'node:22-alpine',
  signal, durable = true, snapshotDirectory, dataScope, inheritLessons, onStarting }) {
  checkedRevision(revision);
  projectKey(projectId);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid loopback preview port');
  if (snapshotDirectory && durable && !dataScope) throw new Error('A durable workspace preview needs an explicit data scope.');
  if (inheritLessons && (projectId !== 'music-transcribe' || !durable || !dataScope || dataScope === inheritLessons.scope))
    throw new Error('Lesson inheritance needs two distinct Music Transcribe delivery data volumes.');
  const deadline = AbortSignal.timeout(120_000);
  const boot = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const pinnedImage = await inspectAppImage(image, boot);
  const directory = snapshotDirectory ?? await materialize(repoPath, revision, boot);
  const container = 'crew-app-' + id();
  const network = container + '-net';
  const volume = durable ? previewDataVolume(projectId, dataScope ?? await realpath(repoPath)) : null;
  const state = { container, network, directory, revision, volume, ...(inheritLessons && { lessonSource: inheritLessons.runId }) };
  try {
    await onStarting?.(state);
    // The app can only reach its own internal bridge. Only the fixed-target
    // relay joins a published network and it has no application or data mount.
    await docker(['network', 'create', '--internal', '--label', 'engineering-crew=preview', network], { signal: boot });
    const dataMount = volume ? ['--mount', 'type=volume,src=' + volume + ',dst=/data']
      : ['--tmpfs', '/data:rw,noexec,nosuid,nodev,size=128m,uid=1000,gid=1000'];
    if (volume) {
      await docker(['volume', 'create', '--label', 'engineering-crew=preview-data', volume], { signal: boot });
      await docker(['run', '--rm', '--pull=never', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--cap-add', 'CHOWN',
        '--user', '0:0', '--security-opt', 'no-new-privileges', ...dataMount, '--entrypoint', 'node', pinnedImage,
        '-e', 'require("node:fs").chownSync("/data",1000,1000)'], { signal: boot });
    }
    const lessonLibrary = inheritLessons && await copyPreviewLessons({ projectId, source: inheritLessons, image: pinnedImage,
      container, dataMount, signal: boot });
    await docker(['run', '--detach', '--pull=never', '--name', container, '--network', network, ...defaults,
      '--label', 'engineering-crew=preview', '--label', 'crew.project=' + projectId, '--label', 'crew.revision=' + revision,
      ...bind(directory, '/app'), ...dataMount,
      '--workdir', '/app', '--env', 'PORT=3000', '--env', 'HOST=0.0.0.0', '--env', 'DATA_DIR=/data',
      '--entrypoint', 'node', pinnedImage, 'server.mjs'], { signal: boot });
    const gateway = container + '-http';
    const relay = [
      "const net=require('node:net');",
      "net.createServer(client=>{const app=net.connect(3000,process.env.CREW_APP_TARGET);",
      "client.on('error',()=>app.destroy());app.on('error',()=>client.destroy());",
      "client.on('close',()=>app.destroy());app.on('close',()=>client.destroy());",
      "client.pipe(app);app.pipe(client);}).listen(3000,'0.0.0.0');",
    ].join('');
    await docker(['run', '--detach', '--pull=never', '--name', gateway, '--network', 'bridge',
      '--publish', '127.0.0.1:' + (port || '') + ':3000', ...defaults, '--label', 'engineering-crew=preview-relay',
      '--env', 'CREW_APP_TARGET=' + container, '--entrypoint', 'node', pinnedImage, '-e', relay], { signal: boot });
    await docker(['network', 'connect', network, gateway], { signal: boot });
    const portMap = await docker(['port', gateway, '3000/tcp'], { signal: boot });
    if (!/^127\.0\.0\.1:[0-9]+$/.test(portMap)) throw new Error('Docker could not publish an isolated loopback preview');
    const url = 'http://' + portMap;
    const healthDeadline = AbortSignal.any([boot, AbortSignal.timeout(20_000)]);
    let healthy = false;
    let lastError = 'Candidate server did not answer GET /health';
    while (!healthDeadline.aborted) {
      let response;
      try {
        response = await fetch(url + '/health', { signal: AbortSignal.any([healthDeadline, AbortSignal.timeout(1000)]), redirect: 'manual' });
      } catch { /* The TCP listener may still be starting. */ }
      if (response?.ok) {
        await response.body?.cancel();
        healthy = true;
        break;
      }
      if (response) {
        lastError = await healthError(response);
        if (response.status >= 300 && response.status < 500) throw new Error(lastError);
      }
      await wait(250, undefined, { signal: healthDeadline }).catch(() => {});
    }
    boot.throwIfAborted();
    if (!healthy) throw new Error(lastError);
    return { ...state, url, image: pinnedImage, ...(lessonLibrary && { lessonLibrary }), stop: () => stopFeaturePreview(state) };
  } catch (error) {
    await stopFeaturePreview(state).catch(() => {});
    throw error;
  }
}
