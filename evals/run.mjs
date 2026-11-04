#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { executeCodex } from '../lib/codex.mjs';
import { gitControl, readProject } from '../lib/git-control.mjs';
import { artifact, artifactDigest } from '../lib/run-store.mjs';
import { id, repoPath, requireField } from '../lib/contracts.mjs';

export const root = fileURLToPath(new URL('..', import.meta.url));
const read = path => readFileSync(join(root, repoPath(path)), 'utf8');
export const json = path => JSON.parse(read(path));

export async function loadSuite(suitePath) {
  const { digest } = json(`${suitePath}/lock.json`);
  const sources = ['task.json', 'cases.json', 'rubric.json', 'grade.mjs']
    .map(file => read(`${suitePath}/${file}`));
  requireField(artifactDigest(JSON.stringify(sources)) === digest,
    `Frozen eval changed: ${suitePath}. Create a new version and keep the old one.`);
  const [task, cases, rubric] = sources.slice(0, 3).map(source => JSON.parse(source));
  requireField(cases.length && new Set(cases.map(item => id(item.id, 'case ID'))).size === cases.length &&
    cases.every(item => Object.hasOwn(rubric, item.id) && ['regression', 'transfer'].includes(item.split)) &&
    Object.keys(rubric).length === cases.length, 'Cases and rubric must map one to one');
  if (task.tasks) {
    requireField(cases.every(item => Object.hasOwn(task.tasks, item.task) && Array.isArray(item.artifacts) &&
      item.artifacts.length && new Set(item.artifacts.map(([id]) => id)).size === item.artifacts.length &&
      item.artifacts.every(([id, title, kind, content]) => [id, title, kind, content].every(value =>
        typeof value === 'string' && value.trim()))), 'Packet cases need a declared task and unique named artifacts');
  }
  const { grade } = await import(pathToFileURL(join(root, suitePath, 'grade.mjs')));
  return { digest, task, cases, rubric, grade };
}

export function loadProfile(entry, ref) {
  const snapshot = ref ? readProject(gitControl(root), entry.project, ref) : null;
  const project = snapshot?.project ?? json(entry.project);
  const profile = project.profiles.find(profile => profile.id === entry.profile);
  requireField(profile, `No profile ${entry.profile} in ${entry.project}`);
  const paths = [profile.instructions, ...profile.skills];
  const instructions = paths.map(path => snapshot ? snapshot.files.get(path) : read(path));
  const digest = artifactDigest(JSON.stringify({ profile, instructions }));
  return { profile, instructions, digest, sourceCommit: snapshot?.sourceCommit };
}

export function assignment(suite, item) {
  const provenance = { source: 'fixture' };
  const inputs = suite.task.tasks ? item.artifacts.map(([id, title, kind, content]) =>
    artifact(id, title, kind, content, provenance)) : [
    artifact('approved-plan', 'Approved plan and environment', 'markdown', item.plan, provenance),
    artifact('candidate-diff', 'Pinned candidate diff', 'diff', item.changes.map(change => change.diff).join('\n'), provenance),
    ...(item.evidence ? [artifact('check-receipt', 'Available verification evidence', 'text', item.evidence, provenance)] : []),
  ];
  const task = suite.task.tasks?.[item.task] ?? suite.task;
  return { task: { ...task, inputArtifacts: inputs.map(input => input.id) }, inputs };
}

export function score(suite, item, observation) {
  return suite.grade(observation, suite.task.tasks?.[item.task] ?? suite.task, suite.rubric[item.id]);
}

export const runtimeDigest = () => artifactDigest(JSON.stringify(['lib/codex.mjs', 'lib/contracts.mjs', 'evals/run.mjs'].map(read)));

async function main(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    model: { type: 'string' }, baseline: { type: 'string' }, samples: { type: 'string', default: '2' },
    out: { type: 'string' }, split: { type: 'string', default: 'all' }, case: { type: 'string' },
  } });
  const [name] = positionals;
  const registry = json('evals/registry.json');
  requireField(positionals.length === 1 && Object.hasOwn(registry, name) && values.model?.trim() && values.out,
    'Usage: node evals/run.mjs <profile> --model <model> --out <new-report.json> [--baseline <git-ref>] [--samples 1–3] [--split regression|transfer] [--case <case-id>]');
  const entry = registry[name];
  const samples = Number(values.samples);
  requireField(Number.isInteger(samples) && samples >= 1 && samples <= 3, 'Use 1 to 3 samples per case');
  requireField(['all', 'regression', 'transfer'].includes(values.split), 'Unknown eval split');
  const suite = await loadSuite(entry.suite);
  const cases = suite.cases.filter(item => (values.split === 'all' || values.split === item.split) &&
    (!values.case || values.case === item.id));
  requireField(cases.length, 'No matching eval cases');

  const variants = { ...(values.baseline ? { baseline: loadProfile(entry, values.baseline) } : {}), candidate: loadProfile(entry) };
  const jobs = cases.flatMap(item => Array.from({ length: samples }, (_, i) =>
    Object.keys(variants).map(variant => ({ item, sample: i + 1, variant }))).flat());
  const runtime = { model: values.model, cli: execFileSync('codex', ['--version'], { encoding: 'utf8' }).trim(), digest: runtimeDigest() };
  const rows = Array(jobs.length);
  const report = { profile: name, suite: entry.suite, suiteDigest: suite.digest, runtime, samples,
    variants: Object.fromEntries(Object.entries(variants).map(([key, { profile, digest, sourceCommit }]) =>
      [key, { revision: profile.revision, digest, sourceCommit }])),
    rows };
  // Reserve the requested file before spending model calls.
  writeFileSync(values.out, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });

  const stop = new AbortController();
  const interrupt = () => stop.abort();
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  let cursor = 0;
  async function worker() {
    while (!stop.signal.aborted && cursor < jobs.length) {
      const index = cursor++;
      const { item, sample, variant } = jobs[index];
      const { profile, instructions } = variants[variant];
      const start = performance.now();
      const { outcome, response, error, receipt } = await executeCodex({
        ...assignment(suite, item), profile, instructions, model: runtime.model, signal: stop.signal,
      });
      const observation = { outcome, response, error, usage: receipt?.usage, elapsedMs: Math.round(performance.now() - start) };
      const result = score(suite, item, observation);
      rows[index] = { case: item.id, split: item.split, sample, variant, ...observation, ...result };
      process.stderr.write(`${variant} ${item.id} #${sample}: ${result.pass ? 'pass' : result.issues.join('; ')}\n`);
    }
  }
  try { await Promise.all(Array.from({ length: Math.min(4, jobs.length) }, worker)); }
  finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
    writeFileSync(values.out, JSON.stringify(report, null, 2) + '\n');
  }
  for (const variant of Object.keys(variants)) {
    const matching = rows.filter(row => row.variant === variant);
    process.stdout.write(`${variant}: ${matching.filter(row => row.pass).length}/${jobs.filter(job => job.variant === variant).length} passed\n`);
  }
  process.exitCode = stop.signal.aborted || rows.filter(row => row.variant === 'candidate' && row.pass).length !== cases.length * samples ? 1 : 0;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main(process.argv.slice(2)).catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
