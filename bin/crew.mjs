#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { CrewError, id, requireField } from '../lib/contracts.mjs';
import { captureConfiguration, gitControl } from '../lib/git-control.mjs';
import { openDatabase } from '../lib/database.mjs';
import { importLocal } from '../lib/import-local.mjs';
import { listProjectVersions, loadProject, registerProject } from '../lib/project-store.mjs';
import { removeProvisioner, setProvisioner } from '../lib/resources.mjs';
import { listRuns, runStore } from '../lib/run-store.mjs';
import { attachCandidateDiff, decide, dispatch, dispatchInitial, findArtifact, newRun, publishAttemptTrace, requestFix, resolveResource, summarize, triageRun, workspaceCatalog } from '../lib/workflow.mjs';

const usage = `Engineering Crew

crew db init
crew db import-local [--repo <checkout>]
crew project validate --file <config.json> [--ref <ref>] [--input <id=file>]...
crew project register --file <config.json> [--ref <ref>] [--input <id=file>]...
crew project versions --project <id> --epic <id>
crew project show --project <id> --epic <id> [--version <n>]
crew provisioner set <action> <target> --project <id> -- <absolute executable> [args...]
crew provisioner remove <action> <target> --project <id>
crew workspace show
crew run start <run> --project <id> --epic <id> [--version <n>] [--no-dispatch] [--events]
crew run show <run>
crew run triage <run> --owner <owner> --note <reason> [--assign <task=profile>]... [--no-dispatch] [--events]
crew run fix <run> <build-attempt> --note <reason>
crew resource resolve <run> <request> --note <setup or alternative> [--events]
crew task dispatch <run> <task> [--events] [--capture-activity]
crew task decide <run> <task> <attempt> <accepted|rework> --note <reason>
crew task attach-diff <run> <task> <build-task>
crew artifact read <run> <artifact>
crew trace publish <run> <task> [--attempt <id>] [--include-activity]
crew ui [run] [--project-id <project>] [--port <port>]

Set CREW_DATABASE_URL to use a customer-provided Postgres database.
Set --repo <checkout> for commands that read Git. Default is the current directory.`;

function emit(data, compact = false) {
  process.stdout.write(`${JSON.stringify({ schemaVersion: 1, ...data }, null, compact ? 0 : 2)}\n`);
}

async function withAttemptSignal(execute) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, stop);
  try { return await execute(controller.signal); }
  finally {
    for (const signal of ['SIGINT', 'SIGTERM']) process.off(signal, stop);
  }
}

const unsuccessful = attempt => attempt.outcome !== 'completed' || attempt.result?.state !== 'completed';

async function kickOff(store, runId, db, values) {
  if (values['no-dispatch']) return;
  const onStart = values.events ? attempts => emit({ event: 'run.kickoff', runId, attempts }, true) : undefined;
  const attempts = await withAttemptSignal(signal => dispatchInitial(store, signal, onStart, undefined, db,
    { captureActivity: values['capture-activity'] }));
  if (attempts.some(unsuccessful)) process.exitCode = 5;
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs({ allowPositionals: true, options: {
      repo: { type: 'string', default: process.cwd() }, project: { type: 'string' },
      'project-id': { type: 'string' }, epic: { type: 'string' }, version: { type: 'string' }, file: { type: 'string' },
      input: { type: 'string', multiple: true, default: [] },
      ref: { type: 'string' }, note: { type: 'string' }, port: { type: 'string' }, attempt: { type: 'string' },
      owner: { type: 'string' }, assign: { type: 'string', multiple: true, default: [] },
      events: { type: 'boolean' }, 'no-dispatch': { type: 'boolean' }, 'capture-activity': { type: 'boolean' }, 'include-activity': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    } });
  } catch (error) { throw new CrewError(error.message, 2); }
  const { values, positionals } = parsed;
  if (values.help || !positionals.length) { process.stdout.write(`${usage}\n`); return; }
  const [group, action, ...args] = positionals;
  const expected = { 'db init': 0, 'db import-local': 0, 'project validate': 0, 'project register': 0, 'project show': 0,
    'project versions': 0, 'provisioner remove': 2, 'workspace show': 0, 'run start': 1, 'run show': 1, 'run triage': 1, 'run fix': 2,
    'resource resolve': 2, 'task dispatch': 2, 'task decide': 4, 'task attach-diff': 3, 'artifact read': 2, 'trace publish': 2 };
  const command = `${group} ${action}`;
  if (!(group === 'ui' && positionals.length <= 2) && !(command === 'provisioner set' && args.length >= 3) &&
      expected[command] !== args.length) {
    throw new CrewError('Unknown command or incorrect arguments. See crew --help.', 2);
  }
  let snapshot;
  if (command === 'project validate' || command === 'project register') {
    if (!values.file) throw new CrewError('Specify a configuration file with --file', 2);
    const inputs = new Map(values.input.map(value => {
      const split = value.indexOf('=');
      requireField(split > 0 && split < value.length - 1, 'Input overrides must use id=file');
      return [id(value.slice(0, split), 'input ID'), value.slice(split + 1)];
    }));
    requireField(inputs.size === values.input.length, 'Duplicate input override');
    snapshot = captureConfiguration(gitControl(values.repo), values.file, values.ref, inputs);
    if (command === 'project validate') return emit({ project: snapshot.project.id, epic: snapshot.project.epic.id,
      sourceCommit: snapshot.sourceCommit, tasks: snapshot.project.tasks.map(task => task.id) });
  }
  const db = await openDatabase();
  try { await runCommand(db, command, group, action, args, values, snapshot); }
  finally { await db.end(); }
}

async function runCommand(db, command, group, action, args, values, snapshot) {
  if (command === 'db init') return emit({ database: 'ready' });
  if (command === 'db import-local') return emit(await importLocal(db, gitControl(values.repo)));
  if (command === 'workspace show') return emit({ projects: workspaceCatalog(await listRuns(db)) });
  if (command === 'project register') {
    const version = await registerProject(db, snapshot);
    return emit({ project: snapshot.project.id, epic: snapshot.project.epic.id, version, sourceCommit: snapshot.sourceCommit });
  }
  if (group === 'provisioner') {
    const [action, target, ...binding] = args;
    if (command === 'provisioner set') await setProvisioner(db, values.project, action, target, binding);
    else await removeProvisioner(db, values.project, action, target);
    return emit({ project: values.project, action, target, status: command === 'provisioner set' ? 'registered' : 'removed' });
  }
  if (command === 'project versions') return emit({ versions: await listProjectVersions(db, values.project, values.epic) });
  if (command === 'project show' || command === 'run start') {
    requireField(values.project && values.epic, 'Specify the project and epic IDs with --project and --epic');
    requireField(values.ref === undefined, 'Use --version to select the registered configuration');
    const version = values.version === undefined ? undefined : Number(values.version);
    const configured = await loadProject(db, values.project, values.epic, version);
    if (command === 'project show') return emit({ project: configured.project, sourceCommit: configured.sourceCommit, version: configured.version });
    const runId = id(args[0], 'run ID');
    const run = newRun(configured, runId);
    const store = runStore(db, runId);
    await store.create(run);
    if (run.triage.status === 'assigned') await kickOff(store, runId, db, values);
    return emit({ run: summarize(await store.read()) }, values.events);
  }
  if (group === 'ui') {
    const runProject = action ? (await runStore(db, action).read()).project.id : undefined;
    const projectId = values['project-id'] ?? runProject;
    if (projectId) id(projectId, 'project ID');
    requireField(!runProject || runProject === projectId, 'Run does not belong to the selected project');
    const port = Number(values.port ?? '4173');
    requireField(Number.isInteger(port) && port >= 0 && port <= 65535, 'Invalid UI port');
    const { serve } = await import('../ui/server.mjs');
    return serve({ repo: values.repo, projectId, port });
  }

  const [runId, taskId, attemptId, disposition] = args;
  const store = runStore(db, runId);
  if (command === 'run show') return emit({ run: summarize(await store.read()) });
  if (command === 'run triage') {
    const overrides = values.assign.map(value => {
      const [taskId, profileId, extra] = value.split('=');
      requireField(extra === undefined, 'Assignments must use task=profile');
      return { taskId: id(taskId, 'assignment task ID'), profileId: id(profileId, 'assignment profile ID') };
    });
    const triage = await triageRun(store, values.owner, values.note, overrides);
    await kickOff(store, runId, db, values);
    return emit({ triage }, values.events);
  }
  if (command === 'run fix') return emit({ fixLoop: await requestFix(store, taskId, values.note) });
  if (command === 'resource resolve') {
    const onStart = values.events ? attempts => emit({ event: 'resource.resolved', runId, attempts }, true) : undefined;
    const result = await withAttemptSignal(signal => resolveResource(store, taskId, values.note, signal, onStart, undefined, db,
      { captureActivity: values['capture-activity'] }));
    emit(result, values.events);
    if (result.attempts.some(unsuccessful)) process.exitCode = 5;
    return;
  }
  if (command === 'artifact read') return emit({ artifact: findArtifact(await store.read(), taskId) });
  if (command === 'trace publish') return emit({ trace: await publishAttemptTrace(store, gitControl(values.repo, { optional: true }), taskId, values.attempt, process.env,
    { includeActivity: values['include-activity'] }) });
  if (command === 'task decide') return emit({ decision: await decide(store, taskId, attemptId, disposition, values.note) });
  if (command === 'task attach-diff') return emit({ revision: await attachCandidateDiff(store, taskId, attemptId) });

  const onStart = values.events ? attemptId => emit({ event: 'attempt.started', attemptId }, true) : undefined;
  const attempt = await withAttemptSignal(signal => dispatch(store, taskId, signal, onStart, undefined, db,
    { captureActivity: values['capture-activity'] }));
  emit(values.events ? { event: 'attempt.finished', attempt } : { attempt }, values.events);
  if (unsuccessful(attempt)) process.exitCode = 5;
}

main().catch(error => {
  const expected = error instanceof CrewError;
  process.stderr.write(`${JSON.stringify({ schemaVersion: 1, error: expected ? error.message : 'Unexpected Crew error' })}\n`);
  process.exitCode = expected ? error.code : 1;
});
