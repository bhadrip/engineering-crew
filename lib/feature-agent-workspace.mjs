import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import { materialize, sourcePath } from './feature-workspace.mjs';
import { inspectAppImage } from './feature-app.mjs';
import { skillRecords } from './feature-profiles.mjs';

const exec = promisify(execFile);
// This program is supplied by the operator and is the only tool executable.
// Project bytes go over stdin and never become shell commands or Node code.
const bridge = String.raw`
const fs = require('node:fs/promises');
const { dirname, join } = require('node:path');
const root = '/work';
async function run() {
  const parts = [];
  for await (const chunk of process.stdin) parts.push(chunk);
  const input = JSON.parse(Buffer.concat(parts));
  if (input.action === 'initialize') {
    for (const file of await fs.readdir('/seed')) {
      await fs.cp(join('/seed', file), join(root, file), { recursive: true });
    }
    return true;
  }
  if (input.action === 'list') {
    const rows = [];
    async function list(dir, prefix) {
      for (const entry of await fs.readdir(dir,{withFileTypes:true})) {
        const path = prefix + entry.name;
        if (entry.isDirectory()) await list(join(dir, entry.name), path + '/');
        if (entry.isFile()) rows.push({path,size:(await fs.stat(join(dir,entry.name))).size});
      }
    }
    await list(root,'');
    return rows.sort((a,b) => a.path.localeCompare(b.path));
  }
  if (input.action === 'read') {
    const result = [];
    let bytes = 0;
    for (const path of input.paths) {
      try {
        const file = join(root,path);
        const stat = await fs.lstat(file);
        if (!stat.isFile() || stat.size > 150000 || bytes + stat.size > input.limit) throw new Error();
        const data = await fs.readFile(file);
        if (data.includes(0)) throw new Error();
        result.push({path,content:data.toString('utf8')}); bytes+=data.length;
      } catch { result.push({path,error:'Unavailable, binary or too large'}); }
    }
    return result;
  }
  if (input.action === 'edit') {
    for (const item of input.changes) {
      const path = join(root,item.path);
      if (item.action === 'write') {
        await fs.mkdir(dirname(path), {recursive:true});
        await fs.writeFile(path,item.content);
      } else await fs.unlink(path);
    }
    return true;
  }
  throw new Error('Invalid workspace operation');
}
run().then(value=>process.stdout.write(JSON.stringify(value))).catch(()=>{process.stderr.write('Workspace operation failed');process.exitCode=1});
`;

function request(container, value, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['exec','--interactive',container,'node','-e',bridge], {
      stdio: ['pipe','pipe','pipe'], signal, timeout: 30_000,
    });
    const output = [];
    let bytes = 0;
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 2_000_000) child.kill();
      else output.push(chunk);
    });
    child.stderr.resume();
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) return reject(new Error('Agent workspace ' + value.action + ' failed'));
      try { resolve(JSON.parse(Buffer.concat(output))); } catch { reject(new Error('Invalid agent workspace receipt')); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(value));
  });
}

export async function withAgentWorkspace({ repoPath, revision, ctx, profile }, complete) {
  const { signal, onEvent } = ctx;
  const { role, workerImage } = profile;
  const write = profile.access === 'workspace-write';
  await onEvent({ type: 'runtime.profile', evidence: {
    ...profile, ...(profile.skills && { skills: skillRecords(profile.skills) }), revision,
  } });
  const imageId = await inspectAppImage(workerImage, signal);
  const directory = await materialize(repoPath, revision, signal, { allowEmpty: true });
  const container = 'crew-agent-' + randomUUID().replaceAll('-', '');
  try {
    if (directory.includes(',')) throw new Error('Invalid agent snapshot mount path');
    const mountTarget = write ? '/seed' : '/work';
    const args = ['run', '--rm', '--detach', '--pull=never', '--name', container, '--network', 'none', '--read-only',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', '1000:1000', '--pids-limit', '32',
      '--memory', '384m', '--cpus', '1', '--label', 'engineering-crew=agent', '--label', 'crew.role=' + role,
      '--mount', 'type=bind,src=' + directory + ',dst=' + mountTarget + ',readonly',
      ...(write ? ['--tmpfs', '/work:rw,nosuid,nodev,noexec,size=160m,uid=1000,gid=1000'] : []),
      '--workdir', '/work', '--entrypoint', 'node', imageId, '-e', 'setTimeout(()=>process.exit(),3600000)'];
    await exec('docker', args, { signal, timeout: 30_000 });
    if (write) await request(container, { action: 'initialize' }, signal);
    await onEvent({ type: 'runtime.started', evidence: { role, profileId: profile.id, profileDigest: profile.digest,
      container, revision, image: imageId, workerImage, model: profile.model, modelSource: profile.modelSource,
      network: 'none', access: write ? 'edit and test' : 'read-only mount' } });
    const workspace = {
      list: () => request(container,{action:'list'},signal),
      async read(paths, limit=200000) {
        if (!Array.isArray(paths) || paths.some(path => !sourcePath(path))) throw new Error('Invalid agent read path');
        return request(container,{action:'read',paths,limit},signal);
      },
      async edit(changes) {
        if (!write || !Array.isArray(changes) || !changes.length || changes.length > 100 ||
          changes.some(item => !sourcePath(item.path) || !['write','delete'].includes(item.action) ||
          typeof item.content !== 'string' || Buffer.byteLength(item.content) > 512000)) throw new Error('Invalid agent edit');
        return request(container,{action:'edit',changes},signal);
      },
      async snapshot(prioritize=[]) {
        const manifest = await workspace.list();
        const priority = new Set(prioritize);
        const ordered = [...manifest].sort((a,b) => Number(priority.has(b.path))-Number(priority.has(a.path)));
        const paths = ordered.filter(({path,size}) => size <= 150000 &&
          !/(?:^|\/)(?:package-lock\.json|[^/]+\.(?:wav|mp3|png|jpg|pdf|wasm|zip))$/i.test(path)).map(f=>f.path);
        const files = await workspace.read(paths,320000);
        return {manifest, files:files.filter(f=>f.content !== undefined)};
      },
    };
    return await complete(workspace);
  } finally {
    let removed = false;
    try {
      await exec('docker',['rm','-f',container],{timeout:10_000});
      removed = true;
    } catch (error) { if (/no such container/i.test(error.stderr || '')) removed = true; }
    if (removed) await rm(directory,{recursive:true,force:true});
    await onEvent({type:'runtime.stopped',evidence:{role,container,removed}});
  }
}
