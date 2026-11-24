#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CrewError, id, requireField } from '../lib/contracts.mjs';
import { captureConfiguration, gitControl } from '../lib/git-control.mjs';
import { openDatabase } from '../lib/database.mjs';
import { importLocal } from '../lib/import-local.mjs';
import { listProjectVersions, loadProject, registerProject } from '../lib/project-store.mjs';
import { removeProvisioner, setProvisioner } from '../lib/resources.mjs';
import { listRuns, observeRunWorkers, runStore } from '../lib/run-store.mjs';
import { recoverWorkflowAttempt } from '../lib/workflow-session.mjs';
import { reportWorkflowDispatchError, runWorkflowWorker, workflowWorkerConnected } from '../lib/workflow-scheduler.mjs';
import { attachCandidateDiff, decide, dispatch, dispatchInitial, dispatchNext, findArtifact, prepareWorkflowRun, publishAttemptTrace, publishWorkspaceDelivery, requestFix, requestWorkspaceRepair,
  resolveResource, setWorkflowAutomation, summarize, triageRun, workspaceCatalog } from '../lib/workflow.mjs';

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
crew feature submit --project <id> --goal <request> [--id <id>] [--checkout <project repo>] [--no-dispatch]
crew feature submit --project <id> --file <brief.md>
crew feature list [--project <id>]
crew feature show <id>
crew feature profiles <project-id>
crew feature update-profile <project-id> <role> --if-revision=<revision> --model=<model-or-empty> --instructions=<text-or-empty>
crew feature input <id> <call-event-number>
crew feature watch <id> [--after <event-number>]
crew feature diff <id> <attempt>
crew feature changes <id> <edit-event-number>
crew feature run <id>
crew feature preview <id>
crew feature publish-trace <id>
crew feature attach-qa-trace <id> <trace-id>
crew run start <run> --project <id> --epic <id> [--version <n>] [--brief-file <file>] [--from-delivery <run>] [--no-dispatch] [--events]
crew run show <run>
crew run publish <run> --attempt <verification-attempt>
crew run preview <run>
crew run stop-preview <run>
crew run advance <run> [--events]
crew run automation <run> <pause|resume>
crew run triage <run> --owner <owner> --note <reason> [--assign <task=profile>]... [--no-dispatch] [--events]
crew run fix <run> <build-attempt> --note <reason>
crew resource resolve <run> <request> --note <setup or alternative> [--events]
crew task dispatch <run> <task> [--resume-attempt <attempt>] [--events] [--capture-activity]
crew task recover <run> <task> <attempt>
crew task repair <run> <verification-step> <attempt> --note <reason>
crew task decide <run> <task> <attempt> <accepted|rework> --note <reason>
crew task attach-diff <run> <task> <build-task>
crew artifact read <run> <artifact>
crew trace publish <run> <task> [--attempt <id>] [--include-activity]
crew worker [status] --project-id <project>
crew ui [run] [--project-id <project>] [--port <port>] [--external-worker]

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

async function advanceQueued(store, signal, db, options, onStart) {
  const attempts = [];
  while (!signal.aborted) {
    const next = await dispatchNext(store, signal, onStart, undefined, db, options);
    if (!next) break;
    attempts.push(next);
  }
  return attempts;
}

async function kickOff(store, runId, db, values) {
  if (values['no-dispatch']) return;
  const onStart = values.events ? attempts => emit({ event: 'run.kickoff', runId, attempts }, true) : undefined;
  const options = { captureActivity: values['capture-activity'], repo: values.repo };
  const automatic = Boolean((await store.read()).automation);
  const attempts = await withAttemptSignal(async signal => {
    if (!automatic) return dispatchInitial(store, signal, onStart, undefined, db, options);
    let started = false;
    const results = await advanceQueued(store, signal, db, options, assignment => {
      if (!started) onStart?.([assignment]);
      started = true;
    });
    if (!started) onStart?.([]);
    return results;
  });
  if (attempts.some(unsuccessful)) process.exitCode = 5;
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs({ allowPositionals: true, options: {
      repo: { type: 'string', default: process.cwd() }, project: { type: 'string' },
      'project-id': { type: 'string' }, epic: { type: 'string' }, version: { type: 'string' }, file: { type: 'string' },
      'resume-attempt': { type: 'string' },
      'brief-file': { type: 'string' }, 'from-delivery': { type: 'string' },
      input: { type: 'string', multiple: true, default: [] },
      ref: { type: 'string' }, note: { type: 'string' }, port: { type: 'string' }, attempt: { type: 'string' },
      goal: { type: 'string' }, id: { type: 'string' }, checkout: { type: 'string' },
      after: { type: 'string' }, 'if-revision': { type: 'string' }, model: { type: 'string' }, instructions: { type: 'string' },
      'wait-for-worker': { type: 'boolean' },
      'external-worker': { type: 'boolean' },
      owner: { type: 'string' }, assign: { type: 'string', multiple: true, default: [] },
      events: { type: 'boolean' }, 'no-dispatch': { type: 'boolean' }, 'capture-activity': { type: 'boolean' }, 'include-activity': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    } });
  } catch (error) { throw new CrewError(error.message, 2); }
  const { values, positionals } = parsed;
  if (values.help || !positionals.length) { process.stdout.write(`${usage}\n`); return; }
  const [group, action, ...args] = positionals;
  const expected = { 'db init': 0, 'db import-local': 0, 'project validate': 0, 'project register': 0, 'project show': 0,
    'feature submit': 0, 'feature list': 0, 'feature show': 1, 'feature diff': 2, 'feature changes': 2, 'feature run': 1, 'feature preview': 1, 'feature watch': 1,
    'feature publish-trace': 1, 'feature attach-qa-trace': 2, 'feature profiles': 1, 'feature update-profile': 2, 'feature input': 2,
    'project versions': 0, 'provisioner remove': 2, 'workspace show': 0, 'run start': 1, 'run show': 1, 'run advance': 1,
    'run publish': 1, 'run preview': 1, 'run stop-preview': 1, 'run automation': 2, 'run triage': 1, 'run fix': 2,
    'resource resolve': 2, 'task dispatch': 2, 'task recover': 3, 'task repair': 3, 'task decide': 4, 'task attach-diff': 3, 'artifact read': 2, 'trace publish': 2 };
  const command = `${group} ${action}`;
  if (values['resume-attempt'] !== undefined) requireField(command === 'task dispatch' &&
    /^[a-f0-9-]{36}$/.test(values['resume-attempt']), 'Choose an attempt to continue with task dispatch.');
  if (values['brief-file'] !== undefined) requireField(command === 'run start', 'Use --brief-file with run start.');
  if (values['from-delivery'] !== undefined) requireField(command === 'run start', 'Use --from-delivery with run start.');
  if (values['external-worker'] !== undefined) requireField(group === 'ui', 'Use --external-worker with ui.');
  const workerCommand = group === 'worker' && (action === undefined || action === 'status') && !args.length;
  if (!(group === 'ui' && positionals.length <= 2) && !workerCommand && !(command === 'provisioner set' && args.length >= 3) &&
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
  if (command === 'feature profiles' || command === 'feature update-profile') {
    const { profilesForFeature, updateFeatureProfile } = await import('../lib/local-feature.mjs');
    const repo = resolve(values.repo);
    const projectId = id(args[0], 'project ID');
    if (command === 'feature profiles') return emit(await profilesForFeature(repo, projectId));
    return emit(await updateFeatureProfile(repo, projectId, args[1], {
      revision: values['if-revision'], model: values.model, instructions: values.instructions,
    }));
  }
  const db = await openDatabase();
  try { await runCommand(db, command, group, action, args, values, snapshot); }
  finally { await db.end(); }
}

async function runCommand(db, command, group, action, args, values, snapshot) {
  if (group === 'feature') {
    const { createFeature, listFeatures, getFeature, readFeatureCall, runFeature } = await import('../lib/feature-controller.mjs');
    if (action === 'list') return emit({ requests: await listFeatures(db, values.project) });
    if (action === 'show') return emit({ request: await getFeature(db, args[0]) });
    if (action === 'input') return emit(await readFeatureCall(db, args[0], Number(args[1])));
    if (action === 'publish-trace') {
      const { publishFeatureTrace } = await import('../lib/feature-langfuse.mjs');
      return emit({ trace: await publishFeatureTrace(db, gitControl(values.repo, { optional: true }), args[0]) });
    }
    if (action === 'attach-qa-trace') {
      const { attachQaTrace } = await import('../lib/feature-qa-trace.mjs');
      return emit({ qaDiagnostic: await attachQaTrace(db, gitControl(values.repo, { optional: true }), args[0], args[1]) });
    }
    if (action === 'watch') {
      const { readFeatureEvents } = await import('../lib/feature-controller.mjs');
      const { setTimeout: wait } = await import('node:timers/promises');
      let cursor = Number(values.after ?? 0);
      return withAttemptSignal(async signal => {
        while (!signal.aborted) {
          const page = await readFeatureEvents(db, args[0], cursor);
          for (const event of page.events) { emit({ event }, true); cursor = event.seq; }
          if (cursor < page.lastSeq) continue;
          if (['completed', 'blocked'].includes(page.status) && page.previewStatus !== 'pending' && page.langfuseExport?.status !== 'pending') return;
          await wait(1000, undefined, { signal }).catch(error => { if (!signal.aborted) throw error; });
        }
      });
    }
    if (action === 'diff' || action === 'changes') {
      const request = await getFeature(db, args[0]);
      const { git, checkedRevision } = await import('../lib/feature-workspace.mjs');
      let base, revision, repoPath;
      if (action === 'diff') {
        const build = request.events.find(e => e.type === 'task.completed' && e.role === 'engineer' && e.attempt === Number(args[1]));
        requireField(build?.evidence?.revision && build?.evidence?.base, 'This attempt has no recorded candidate');
        ({ base, revision, repoPath } = build.evidence);
      } else {
        const edit = request.events.find(e => e.seq === Number(args[1]) && e.type === 'tool.completed' && e.role === 'engineer' && e.evidence?.action === 'edit');
        requireField(edit?.evidence?.revision, 'This event has no recorded edit');
        revision = checkedRevision(edit.evidence.revision);
        repoPath = request.repoPath ?? resolve(values.repo, '.crew-local', 'projects', request.projectId);
        base = await git(repoPath, ['rev-parse', '--verify', revision + '^']);
      }
      const patch = await git(repoPath, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', checkedRevision(base), checkedRevision(revision), '--'], { binary: true });
      return emit({ base, revision, diff: patch.toString('utf8').replace(/\n$/, '') });
    }
    if (action === 'submit') {
      requireField(values.project && Boolean(values.goal) !== Boolean(values.file), 'Specify --project and either --goal or --file');
      const request = await createFeature(db, { projectId: values.project, id: values.id,
        goal: values.goal || await readFile(values.file, 'utf8'), repoPath: values.checkout });
      if (!values['no-dispatch']) {
        const worker = spawn(process.execPath, [fileURLToPath(import.meta.url), '--repo', resolve(values.repo), 'feature', 'run', request.id, '--wait-for-worker'],
          { detached: true, stdio: 'ignore' });
        await new Promise((ready, fail) => { worker.once('spawn', ready); worker.once('error', fail); });
        worker.unref();
      }
      return emit({ request, path: '/projects/' + request.projectId + '/requests/' + request.id });
    }
    const { runtimeForFeature, openFeaturePreview } = await import('../lib/local-feature.mjs');
    const request = await getFeature(db, args[0]);
    if (action === 'preview') return emit({ preview: await openFeaturePreview(db, values.repo, request) });
    const runtime = await runtimeForFeature(values.repo, request);
    const finished = await withAttemptSignal(async signal => {
      const { setTimeout: wait } = await import('node:timers/promises');
      while (true) {
        try { return await runFeature(db, request.id, { runtime, signal, autoPreview: true, autoTraceProject: process.env.CREW_LANGFUSE_AUTO_PROJECT }); }
        catch (error) {
          if (!values['wait-for-worker'] || error.code !== 3 || !error.message.startsWith('A worker is active')) throw error;
          await wait(1500, undefined, { signal });
        }
      }
    });
    const preview = finished.status === 'completed' && openFeaturePreview(db, values.repo, finished)
      .then(live => ({ url: live.url })).catch(error => ({ error: String(error.message).slice(0, 500) }));
    if (finished.projectId === process.env.CREW_LANGFUSE_AUTO_PROJECT && finished.langfuseExport?.status === 'pending') {
      try {
        const { publishFeatureTrace } = await import('../lib/feature-langfuse.mjs');
        await publishFeatureTrace(db, gitControl(values.repo, { optional: true }), request.id, process.env, { automatic: true });
      } catch { /* The publisher records its failure separately from the build outcome. */ }
    }
    const outcome = preview ? { preview: await preview } : {};
    emit({ request: await getFeature(db, request.id), ...outcome });
    if (finished.status === 'blocked') process.exitCode = 5;
    return;
  }
  if (command === 'db init') return emit({ database: 'ready' });
  if (command === 'db import-local') return emit(await importLocal(db, gitControl(values.repo)));
  if (command === 'workspace show') return emit({ projects: workspaceCatalog(await observeRunWorkers(db, await listRuns(db))) });
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
    let requestBrief;
    if (values['brief-file'] !== undefined) {
      try { requestBrief = await readFile(values['brief-file'], 'utf8'); }
      catch { throw new CrewError('Could not read the request brief file.', 2); }
    }
    const run = await prepareWorkflowRun(db, configured, runId, { pauseDispatch: values['no-dispatch'],
      requestBrief, deliveryRunId: values['from-delivery'] });
    const store = runStore(db, runId);
    await store.create(run);
    if (run.triage.status === 'assigned') await kickOff(store, runId, db, values);
    return emit({ run: summarize(await store.read()) }, values.events);
  }
  if (group === 'worker') {
    const projectId = id(values['project-id'], 'project ID');
    if (action === 'status') return emit({ worker: { projectId, connected: await workflowWorkerConnected(db, projectId) } });
    return withAttemptSignal(signal => runWorkflowWorker(db, projectId, signal, {
      repo: values.repo, onError: reportWorkflowDispatchError,
      onReady: () => emit({ worker: { projectId, connected: true } }, true),
    }));
  }
  if (group === 'ui') {
    const runProject = action ? (await runStore(db, action).read()).project.id : undefined;
    const projectId = values['project-id'] ?? runProject;
    if (projectId) id(projectId, 'project ID');
    requireField(!runProject || runProject === projectId, 'Run does not belong to the selected project');
    const port = Number(values.port ?? '4173');
    requireField(Number.isInteger(port) && port >= 0 && port <= 65535, 'Invalid UI port');
    const { serve } = await import('../ui/server.mjs');
    return serve({ repo: values.repo, projectId, port, externalWorker: values['external-worker'] });
  }

  const [runId, taskId, attemptId, disposition] = args;
  const store = runStore(db, runId);
  if (command === 'run show') {
    const [run] = await observeRunWorkers(db, [await store.read()]);
    return emit({ run: summarize(run, { includeAgentConversation: true }) });
  }
  if (command === 'run publish') return emit({ delivery: await publishWorkspaceDelivery(store, values.attempt) });
  if (command === 'run preview' || command === 'run stop-preview') {
    const { openWorkspacePreview, stopWorkspacePreview } = await import('../lib/workflow-preview.mjs');
    const preview = await withAttemptSignal(signal => command === 'run preview' ? openWorkspacePreview(db, values.repo, runId, signal) :
      stopWorkspacePreview(db, runId, signal));
    return emit({ preview });
  }
  if (command === 'run automation') {
    requireField(['pause', 'resume'].includes(taskId), 'Choose pause or resume.');
    return emit({ automation: await setWorkflowAutomation(store, taskId === 'resume') });
  }
  if (command === 'run advance') {
    requireField((await store.read()).automation?.enabled, 'Resume automatic dispatch before advancing this run.');
    const onStart = values.events ? assignment => emit({ event: 'attempt.started', runId, ...assignment }, true) : undefined;
    const attempts = await withAttemptSignal(signal => advanceQueued(store, signal, db,
      { captureActivity: values['capture-activity'], repo: values.repo }, onStart));
    emit({ attempts }, values.events);
    if (attempts.some(unsuccessful)) process.exitCode = 5;
    return;
  }
  if (command === 'run triage') {
    const overrides = values.assign.map(value => {
      const [taskId, profileId, extra] = value.split('=');
      requireField(extra === undefined, 'Assignments must use task=profile');
      return { taskId: id(taskId, 'assignment task ID'), profileId: id(profileId, 'assignment profile ID') };
    });
    const triage = await triageRun(store, values.owner, values.note, overrides, { pauseDispatch: values['no-dispatch'] });
    await kickOff(store, runId, db, values);
    return emit({ triage }, values.events);
  }
  if (command === 'run fix') return emit({ fixLoop: await requestFix(store, taskId, values.note) });
  if (command === 'resource resolve') {
    const onStart = values.events ? attempts => emit({ event: 'resource.resolved', runId, attempts }, true) : undefined;
    const result = await withAttemptSignal(signal => resolveResource(store, taskId, values.note, signal, onStart, undefined, db,
      { captureActivity: values['capture-activity'], repo: values.repo }));
    emit(result, values.events);
    if (result.attempts.some(unsuccessful)) process.exitCode = 5;
    return;
  }
  if (command === 'artifact read') return emit({ artifact: findArtifact(await store.read(), taskId) });
  if (command === 'trace publish') return emit({ trace: await publishAttemptTrace(store, gitControl(values.repo, { optional: true }), taskId, values.attempt, process.env,
    { includeActivity: values['include-activity'] }) });
  if (command === 'task decide') return emit({ decision: await decide(store, taskId, attemptId, disposition, values.note) });
  if (command === 'task repair') return emit({ repair: await requestWorkspaceRepair(store, taskId, attemptId, values.note) });
  if (command === 'task recover') return emit({ attempt: await recoverWorkflowAttempt(store, id(taskId, 'task ID'), attemptId) });
  if (command === 'task attach-diff') return emit({ revision: await attachCandidateDiff(store, taskId, attemptId) });

  const onStart = values.events ? attemptId => emit({ event: 'attempt.started', attemptId }, true) : undefined;
  const attempt = await withAttemptSignal(signal => dispatch(store, taskId, signal, onStart, undefined, db,
    { captureActivity: values['capture-activity'], resumeAttemptId: values['resume-attempt'], repo: values.repo }));
  emit(values.events ? { event: 'attempt.finished', attempt } : { attempt }, values.events);
  if (unsuccessful(attempt)) process.exitCode = 5;
}

main().catch(error => {
  const expected = error instanceof CrewError;
  process.stderr.write(`${JSON.stringify({ schemaVersion: 1, error: expected ? error.message : 'Unexpected Crew error' })}\n`);
  process.exitCode = expected ? error.code : 1;
});
