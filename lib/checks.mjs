import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual, promisify } from 'node:util';
import { CrewError, id, requireField, text } from './contracts.mjs';
import { candidateDiff, createCandidate, gitFile } from './git-control.mjs';

const exec = promisify(execFile);

function readCases(content, task) {
  let cases;
  try { cases = JSON.parse(content); } catch { throw new CrewError('QA cases must be valid JSON'); }
  requireField(Array.isArray(cases) && cases.length > 0 && cases.length <= 20, 'QA must return 1 to 20 cases');
  const ids = new Set();
  const invocations = new Set();
  for (const entry of cases) {
    id(entry?.id, 'QA case ID');
    requireField(!ids.has(entry.id), 'QA case IDs must be unique');
    ids.add(entry.id);
    requireField(task.criteria.includes(entry.criterion), 'QA case references an unknown criterion');
    requireField(Array.isArray(entry.args) && entry.args.length <= 10 && entry.args.every(arg => typeof arg === 'string' &&
      arg.length <= 200 && !arg.includes('\0')), 'QA arguments must be bounded strings');
    const invocation = JSON.stringify(entry.args);
    requireField(!invocations.has(invocation), 'QA must cover distinct invocations');
    invocations.add(invocation);
    const { exitCode, stdout, stderr } = entry.expected ?? {};
    requireField(Number.isInteger(exitCode) && exitCode >= 0 && exitCode < 125 && typeof stderr === 'string' && stderr.length < 4_000,
      'QA requires an expected exit code and stderr');
    requireField(stdout && Object.keys(stdout).length === 1 &&
      (typeof stdout.text === 'string' || Object.hasOwn(stdout, 'json')), 'QA stdout must specify exact text or a JSON value');
  }
  for (const criterion of task.criteria) {
    const count = task.execution.minCases?.[criterion] ?? 1;
    requireField(cases.filter(entry => entry.criterion === criterion).length >= count, `Missing required QA cases for ${criterion}`);
  }
  return cases;
}

async function inDocker(image, directory, argv, options) {
  const startedAt = new Date().toISOString();
  const name = `crew-check-${randomUUID()}`;
  const args = ['run', '--name', name, '--rm', '--pull=never', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges', '--user', 'node', '--pids-limit', '64', '--memory', '128m',
    '--mount', `type=bind,src=${directory},dst=/app,readonly`, '--workdir', '/app', image, 'node', ...argv];
  let observed;
  try {
    const { stdout, stderr } = await exec('docker', args, options);
    observed = { exitCode: 0, stdout, stderr };
  } catch (error) {
    observed = { exitCode: typeof error.code === 'number' ? error.code : null,
      stdout: error.stdout ?? '', stderr: error.stderr ?? '', ...(error.signal ? { signal: error.signal } : {}) };
    if (observed.exitCode === null) {
      await exec('docker', ['rm', '-f', name], { timeout: 5_000 }).catch(() => {});
    }
  }
  return { command: ['node', ...argv], startedAt, endedAt: new Date().toISOString(), observed };
}

function matchStdout(observed, expected) {
  if (typeof expected.text === 'string') return observed === expected.text;
  if (!observed.endsWith('\n')) return false;
  try { return isDeepStrictEqual(JSON.parse(observed), expected.json); }
  catch { return false; }
}

export async function executeEvidence(control, job, response, signal) {
  const { task, attempt } = job;
  const execution = task.execution;
  requireField(control, 'Runner needs a Git checkout for execution');
  const verifying = execution.kind === 'verify';
  const output = slot => response.outputs.find(value => value.slot === slot)?.content;
  const cases = verifying ? readCases(output(task.outputs.find(slot => slot.kind === 'check-cases').id), task) : undefined;
  const candidateStartedAt = new Date().toISOString();
  const candidate = verifying ? job.candidate : createCandidate(control, task.sourceCommit,
    `refs/crew/candidates/${task.runId}/${attempt.id}`, task.outputs.filter(slot => slot.kind === 'source')
      .map(slot => ({ path: slot.path, content: text(output(slot.id), slot.path) })));
  const candidateTiming = verifying ? undefined : { startedAt: candidateStartedAt, endedAt: new Date().toISOString() };
  requireField(candidate?.commit, 'An accepted candidate is required');
  const directory = await mkdtemp(join(tmpdir(), 'crew-docker-'));
  const options = { timeout: 30_000, signal, encoding: 'utf8', maxBuffer: 16_384 };
  try {
    await chmod(directory, 0o755);
    for (const path of execution.files) {
      const destination = join(directory, path);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, gitFile(control, candidate.commit, path).content, { mode: 0o644 });
    }
    const { stdout } = await exec('docker', ['image', 'inspect', '--format', '{{.Id}} {{.Os}}/{{.Architecture}}', execution.image], options);
    const [imageId, platform] = stdout.trim().split(' ');
    const checks = [];
    if (verifying) {
      for (const entry of cases) {
        if (signal?.aborted) throw new CrewError('Docker verification was interrupted');
        const executionResult = await inDocker(execution.image, directory, [execution.entry, ...entry.args], options);
        const { observed } = executionResult;
        const passed = observed.exitCode === entry.expected.exitCode && observed.stderr === entry.expected.stderr &&
          matchStdout(observed.stdout, entry.expected.stdout);
        checks.push({ id: entry.id, criterion: entry.criterion, expected: entry.expected, ...executionResult, passed });
      }
    } else {
      const result = await inDocker(execution.image, directory, ['--test', execution.tests], options);
      checks.push({ id: 'author-tests', ...result, passed: result.observed.exitCode === 0 });
    }
    return { candidate, diff: verifying ? undefined : candidateDiff(control, candidate),
      receipt: { kind: verifying ? 'independent-qa' : 'author-tests', testedCommit: candidate.commit, candidateTiming,
      image: execution.image, imageId, platform, network: 'none', mount: 'read-only', checks, passed: checks.every(check => check.passed) } };
  } catch (error) {
    const detail = error instanceof CrewError ? error.message : 'Docker could not complete the configured execution';
    throw new CrewError(detail);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
