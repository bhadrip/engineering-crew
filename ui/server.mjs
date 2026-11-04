import { createServer } from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { CrewError, id } from '../lib/contracts.mjs';
import { artifactPage, epicPage, errorPage, projectPage, runPage } from './views.mjs';

const executeFile = promisify(execFile);
const command = fileURLToPath(new URL('../bin/crew.mjs', import.meta.url));
const stylesheet = readFileSync(new URL('crew.css', import.meta.url));
const browserScript = readFileSync(new URL('crew.js', import.meta.url));

function cliError(stderr) {
  try {
    const { error } = JSON.parse(stderr);
    return new CrewError(error);
  } catch { return new CrewError('The crew command did not return a readable response'); }
}

async function call(repo, args) {
  let stdout;
  try {
    ({ stdout } = await executeFile(process.execPath, [command, '--repo', repo, ...args], { maxBuffer: 1_000_000 }));
  } catch (error) { throw cliError(error.stderr); }
  return JSON.parse(stdout);
}

function beginDispatch(repo, runId, taskId) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [command, '--repo', repo, 'task', 'dispatch', runId, taskId, '--events'],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let started = false;
    child.stdout.setEncoding('utf8').on('data', chunk => {
      if (started) return;
      stdout += chunk;
      const boundary = stdout.indexOf('\n');
      if (boundary < 0) return;
      try {
        const event = JSON.parse(stdout.slice(0, boundary));
        if (event.event === 'attempt.started') {
          started = true;
          resolve(event.attemptId);
        }
      } catch { reject(new CrewError('The attempt could not be confirmed')); }
    });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr = (stderr + chunk).slice(0, 4096); });
    child.once('error', () => reject(new CrewError('Could not launch the crew CLI')));
    child.once('close', () => { if (!started) reject(cliError(stderr)); });
  });
}

async function readForm(request) {
  if (!request.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) {
    throw new CrewError('Expected a form submission');
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 12_000) throw new CrewError('Form is too large');
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString());
}

function send(response, status, body, type = 'text/html', headers = {}) {
  response.writeHead(status, {
    'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'self'; script-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', ...headers,
  });
  response.end(body);
}

export async function serve({ repo, projectId, port }) {
  const { projects } = await call(repo, ['workspace', 'show']);
  const selectedProject = projectId ? projects.find(project => project.id === projectId)
    : projects.length === 1 ? projects[0] : undefined;
  if (!selectedProject) {
    throw new CrewError(projectId ? `Project ${projectId} has no runs in this checkout`
      : projects.length ? 'Choose the project with --project-id or provide a run ID'
        : 'Start a project run before opening its browser UI');
  }

  async function readProjectRun(runId) {
    const { run } = await call(repo, ['run', 'show', runId]);
    if (run.project.id !== selectedProject.id) throw new CrewError('Run does not belong to this project');
    return run;
  }

  let host;
  const server = createServer(async (request, response) => {
    if (request.headers.host !== host) return send(response, 403, errorPage('Use the local crew address.'));
    const origin = `http://${host}`;
    try {
      const url = new URL(request.url, origin);
      const projectRoute = /^\/projects\/([a-z0-9-]+)(?:(\/agents)|\/epics\/([a-z0-9-]+))?$/.exec(url.pathname);
      const runRoute = /^\/runs\/([a-z0-9-]+)(?:\/(tasks|artifacts)\/([a-z0-9-]+)|\/(fix))?$/.exec(url.pathname);
      const [, selectedRun, section, item, fix] = runRoute ?? [];
      if (request.method === 'GET') {
        if (url.pathname === '/crew.css') return send(response, 200, stylesheet, 'text/css');
        if (url.pathname === '/crew.js') return send(response, 200, browserScript, 'text/javascript');
        const query = url.searchParams.get('q')?.trim().slice(0, 160) ?? '';
        if (url.pathname === '/' || projectRoute) {
          const { projects } = await call(repo, ['workspace', 'show']);
          const [, routeProject, agents, epicId] = projectRoute ?? [];
          const project = projects.find(project => project.id === selectedProject.id && (!routeProject || routeProject === project.id));
          if (project && !epicId) {
            const configurations = agents ? await Promise.all(project.epics.map(async epic => {
              try {
                const config = await call(repo, ['project', 'show', '--project', epic.configurationPath]);
                if (config.project.id !== project.id || config.project.epic.id !== epic.id) throw new CrewError('Configuration belongs to another epic');
                return { epic, ...config };
              } catch (error) {
                if (!(error instanceof CrewError)) throw error;
                return { epic, error: error.message };
              }
            })) : [];
            return send(response, 200, projectPage(project, Boolean(agents), { query, status: url.searchParams.get('status'), configurations }));
          }
          const epic = project?.epics.find(epic => epic.id === epicId);
          if (epic) {
            const activeRun = url.searchParams.get('run') ?? epic.runs[0].id;
            if (!epic.runs.some(run => run.id === activeRun)) return send(response, 404, errorPage('Run does not belong to this epic.'));
            const run = await readProjectRun(activeRun);
            const step = url.searchParams.get('step');
            if (step && !run.tasks.some(task => task.packet.id === step)) {
              return send(response, 404, errorPage('Handoff does not belong to this run.'));
            }
            return send(response, 200, epicPage(project, epic, run, {
              step, view: url.searchParams.get('view'), query, type: url.searchParams.get('type'),
            }));
          }
        }
        if (section === 'artifacts') {
          const run = await readProjectRun(selectedRun);
          const { artifact } = await call(repo, ['artifact', 'read', selectedRun, item]);
          const fromTask = url.searchParams.get('task');
          const task = run.tasks.find(value => value.packet.id === fromTask);
          return send(response, 200, artifactPage(artifact, run, task?.packet.id, url.searchParams.get('view')));
        }
        if (selectedRun) {
          const run = await readProjectRun(selectedRun);
          const selection = item ? run.tasks.find(value => value.packet.id === item) : run.tasks[0];
          if (selection) return send(response, 200, runPage(run, selection));
        }
      }
      if (request.method === 'POST' && (section === 'tasks' || fix)) {
        if (request.headers.origin !== origin) return send(response, 403, errorPage('Open the crew UI before submitting a decision.'));
        const run = await readProjectRun(selectedRun);
        const form = await readForm(request);
        if (fix) {
          const attempt = form.get('attempt');
          if (!/^[a-f0-9-]{36}$/.test(attempt ?? '')) throw new CrewError('Invalid build attempt');
          await call(repo, ['run', 'fix', selectedRun, attempt, `--note=${form.get('note') ?? ''}`]);
          const location = `/projects/${run.project.id}/epics/${run.epic.id}?run=${run.id}&view=reviews`;
          return send(response, 303, '', 'text/plain', { Location: location });
        }
        if (form.get('action') === 'dispatch') await beginDispatch(repo, selectedRun, id(item, 'task ID'));
        else if (form.get('action') === 'attach-diff') {
          await call(repo, ['task', 'attach-diff', selectedRun, item, id(form.get('build'), 'build task ID')]);
        }
        else if (form.get('action') === 'decide') {
          const attempt = form.get('attempt');
          const disposition = form.get('disposition');
          if (!/^[a-f0-9-]{36}$/.test(attempt ?? '') || !['accepted', 'rework'].includes(disposition)) {
            throw new CrewError('Invalid decision target or outcome');
          }
          await call(repo, ['task', 'decide', selectedRun, item, attempt, disposition, `--note=${form.get('note') ?? ''}`]);
        } else throw new CrewError('Unknown action');
        return send(response, 303, '', 'text/plain', { Location: url.pathname });
      }
      return send(response, 404, errorPage('This page does not exist.'));
    } catch (error) {
      return send(response, error instanceof CrewError ? 400 : 500,
        errorPage(error instanceof CrewError ? error.message : 'The local UI could not load the crew record.'));
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  host = `127.0.0.1:${server.address().port}`;
  process.stdout.write(`${selectedProject.name} at http://${host}/\n`);
}
