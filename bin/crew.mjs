#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { CrewError, id, requireField } from '../lib/contracts.mjs';
import { gitControl, readProject } from '../lib/git-control.mjs';
import { listRuns, runStore } from '../lib/run-store.mjs';
import { attachCandidateDiff, decide, dispatch, dispatchInitial, findArtifact, newRun, publishAttemptTrace, requestFix, resolveResource, summarize, triageRun, workspaceCatalog } from '../lib/workflow.mjs';

const usage = `Engineering Crew

crew project validate --project <Git path> [--ref <ref>]
crew project show --project <Git path> [--ref <ref>]
crew workspace show
crew run start <run> --project <Git path> [--ref <ref>] [--no-dispatch] [--events]
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

Set --repo <checkout> to use a different repository. Default is the current directory.`;

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

async function kickOff(store, runId, control, values) {
  if (values['no-dispatch']) return;
  const onStart = values.events ? attempts => emit({ event: 'run.kickoff', runId, attempts }, true) : undefined;
  const attempts = await withAttemptSignal(signal => dispatchInitial(store, signal, onStart, undefined, control,
    { captureActivity: values['capture-activity'] }));
  if (attempts.some(unsuccessful)) process.exitCode = 5;
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs({ allowPositionals: true, options: {
      repo: { type: 'string', default: process.cwd() }, project: { type: 'string' },
      'project-id': { type: 'string' },
      ref: { type: 'string', default: 'HEAD' }, note: { type: 'string' }, port: { type: 'string' }, attempt: { type: 'string' },
      owner: { type: 'string' }, assign: { type: 'string', multiple: true, default: [] },
      events: { type: 'boolean' }, 'no-dispatch': { type: 'boolean' }, 'capture-activity': { type: 'boolean' }, 'include-activity': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    } });
  } catch (error) { throw new CrewError(error.message, 2); }
  const { values, positionals } = parsed;
  if (values.help || !positionals.length) { process.stdout.write(`${usage}\n`); return; }
  const [group, action, ...args] = positionals;
  const expected = { 'project validate': 0, 'project show': 0, 'workspace show': 0, 'run start': 1, 'run show': 1, 'run triage': 1, 'run fix': 2,
    'resource resolve': 2, 'task dispatch': 2, 'task decide': 4, 'task attach-diff': 3, 'artifact read': 2, 'trace publish': 2 };
  const command = `${group} ${action}`;
  if (!(group === 'ui' && positionals.length <= 2) && expected[command] !== args.length) {
    throw new CrewError('Unknown command or incorrect arguments. See crew --help.', 2);
  }
  const control = gitControl(values.repo);
  if (command === 'workspace show') return emit({ projects: workspaceCatalog(await listRuns(control.gitDir)) });
  if (group === 'project' || command === 'run start') {
    if (!values.project) throw new CrewError('Specify the committed config with --project', 2);
    const snapshot = readProject(control, values.project, values.ref);
    const { project, sourceCommit } = snapshot;
    if (command === 'project validate') return emit({ project: project.id, sourceCommit, tasks: project.tasks.map(task => task.id) });
    if (command === 'project show') return emit({ project, sourceCommit, path: values.project });
    const runId = id(args[0], 'run ID');
    const run = newRun(snapshot, runId, values.project);
    const store = runStore(control.gitDir, runId);
    await store.create(run);
    if (run.triage.status === 'assigned') await kickOff(store, runId, control, values);
    return emit({ run: summarize(await store.read()) }, values.events);
  }
  if (group === 'ui') {
    const runProject = action ? (await runStore(control.gitDir, action).read()).project.id : undefined;
    const projectId = values['project-id'] ?? runProject;
    if (projectId) id(projectId, 'project ID');
    requireField(!runProject || runProject === projectId, 'Run does not belong to the selected project');
    const port = Number(values.port ?? '4173');
    requireField(Number.isInteger(port) && port >= 0 && port <= 65535, 'Invalid UI port');
    const { serve } = await import('../ui/server.mjs');
    return serve({ repo: control.root, projectId, port });
  }

  const [runId, taskId, attemptId, disposition] = args;
  const store = runStore(control.gitDir, runId);
  if (command === 'run show') return emit({ run: summarize(await store.read()) });
  if (command === 'run triage') {
    const overrides = values.assign.map(value => {
      const [taskId, profileId, extra] = value.split('=');
      requireField(extra === undefined, 'Assignments must use task=profile');
      return { taskId: id(taskId, 'assignment task ID'), profileId: id(profileId, 'assignment profile ID') };
    });
    const triage = await triageRun(store, values.owner, values.note, overrides);
    await kickOff(store, runId, control, values);
    return emit({ triage }, values.events);
  }
  if (command === 'run fix') return emit({ fixLoop: await requestFix(store, taskId, values.note) });
  if (command === 'resource resolve') {
    const onStart = values.events ? attempts => emit({ event: 'resource.resolved', runId, attempts }, true) : undefined;
    const result = await withAttemptSignal(signal => resolveResource(store, taskId, values.note, signal, onStart, undefined, control,
      { captureActivity: values['capture-activity'] }));
    emit(result, values.events);
    if (result.attempts.some(unsuccessful)) process.exitCode = 5;
    return;
  }
  if (command === 'artifact read') return emit({ artifact: findArtifact(await store.read(), taskId) });
  if (command === 'trace publish') return emit({ trace: await publishAttemptTrace(store, control, taskId, values.attempt, process.env,
    { includeActivity: values['include-activity'] }) });
  if (command === 'task decide') return emit({ decision: await decide(store, taskId, attemptId, disposition, values.note) });
  if (command === 'task attach-diff') return emit({ revision: await attachCandidateDiff(store, control, taskId, attemptId) });

  const onStart = values.events ? attemptId => emit({ event: 'attempt.started', attemptId }, true) : undefined;
  const attempt = await withAttemptSignal(signal => dispatch(store, taskId, signal, onStart, undefined, control,
    { captureActivity: values['capture-activity'] }));
  emit(values.events ? { event: 'attempt.finished', attempt } : { attempt }, values.events);
  if (unsuccessful(attempt)) process.exitCode = 5;
}

main().catch(error => {
  const expected = error instanceof CrewError;
  process.stderr.write(`${JSON.stringify({ schemaVersion: 1, error: expected ? error.message : 'Unexpected local crew error' })}\n`);
  process.exitCode = expected ? error.code : 1;
});
