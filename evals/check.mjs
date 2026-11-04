#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { globSync } from 'node:fs';
import { posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { requireField } from '../lib/contracts.mjs';
import { json, loadProfile, loadSuite, root, runtimeDigest, score } from './run.mjs';

const projectsFor = entry => [entry.project, ...(entry.alsoProjects ?? [])];

function verifyReports(entry, name, suite, profile) {
  const seen = new Set();
  let model, cli, baseline;
  for (const path of entry.reports) {
    const report = json(path);
    requireField(report.profile === name && report.suite === entry.suite && report.suiteDigest === suite.digest,
      `Eval evidence does not match the frozen suite: ${path}`);
    requireField(report.runtime.digest === runtimeDigest(), `Runtime changed; rerun ${name}`);
    requireField(report.variants.candidate?.digest === profile.digest &&
      report.variants.candidate.revision === profile.profile.revision, `Profile changed; rerun ${name}`);
    requireField(report.samples === 2 && report.runtime.model && report.runtime.cli &&
      /^[a-f0-9]{40,64}$/.test(report.variants.baseline?.sourceCommit) &&
      /^[a-f0-9]{64}$/.test(report.variants.baseline.digest),
    `Acceptance requires two samples and a pinned baseline: ${path}`);
    model ??= report.runtime.model;
    cli ??= report.runtime.cli;
    baseline ??= report.variants.baseline;
    requireField(model === report.runtime.model && cli === report.runtime.cli &&
      baseline.digest === report.variants.baseline.digest && baseline.sourceCommit === report.variants.baseline.sourceCommit,
    'Acceptance reports must use the same runtime and baseline');
    if (profile.model) requireField(model === profile.model, `Eval model must match ${entry.project}`);
    for (const row of report.rows) {
      const item = suite.cases.find(item => item.id === row?.case);
      requireField(item && item.split === row.split && [1, 2].includes(row.sample) &&
        ['baseline', 'candidate'].includes(row.variant), `Invalid or incomplete eval row: ${path}`);
      const key = [row.variant, row.case, row.sample].join('/');
      requireField(!seen.has(key), `Duplicate eval row: ${key}`);
      seen.add(key);
      const computed = score(suite, item, row);
      requireField(row.pass === computed.pass && JSON.stringify(row.issues) === JSON.stringify(computed.issues),
        `Eval score disagrees with the recorded output: ${key}`);
      requireField(row.outcome === 'completed', `Eval transport failed: ${key}`);
      requireField(row.variant !== 'candidate' || computed.pass, `Candidate did not pass: ${key}`);
    }
  }
  requireField(seen.size === suite.cases.length * 4, `Missing baseline or candidate samples for ${name}`);
}

export async function checkEvals() {
  const registry = json('evals/registry.json');
  const projects = new Set([...globSync('examples/**/*crew.project.json', { cwd: root }), ...Object.values(registry).flatMap(projectsFor)]);
  for (const project of projects) {
    for (const profile of json(project).profiles.filter(profile => profile.skills.length)) {
      requireField(Object.values(registry).filter(entry => projectsFor(entry).includes(project) && entry.profile === profile.id).length === 1,
        `Register eval coverage for ${profile.id} in ${project} before activating skills`);
    }
  }
  for (const [name, entry] of Object.entries(registry)) {
    const profile = loadProfile(entry);
    const suite = await loadSuite(entry.suite);
    const projects = projectsFor(entry);
    const models = new Set(projects.map(project => json(project).runtime.model).filter(Boolean));
    requireField(models.size <= 1 && projects.every(project => loadProfile({ ...entry, project }).digest === profile.digest),
      `All projects covered by ${name} must use the same profile and compatible model`);
    const skills = profile.profile.skills;
    requireField(skills.length === Object.keys(entry.coverage).length && skills.every(path =>
      Array.isArray(entry.coverage[path]) && entry.coverage[path].length &&
      entry.coverage[path].every(id => suite.cases.some(item => item.id === id))),
    `Every active skill in ${name} needs a mapping to frozen cases`);
    verifyReports(entry, name, suite, { ...profile, model: [...models][0] });
  }
}

export function checkFrozenHistory(ref) {
  const git = (...args) => execFileSync('git', ['--no-replace-objects', '-C', root, ...args], { encoding: 'utf8' });
  const base = git('rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`).trim();
  const registryPath = 'evals/registry.json';
  const files = git('ls-tree', '-rz', '--name-only', base, '--', 'evals/').split('\0');
  const registry = json(registryPath);
  if (files.includes(registryPath)) {
    const previous = JSON.parse(git('show', `${base}:${registryPath}`));
    for (const [name, entry] of Object.entries(previous)) {
      const current = registry[name];
      requireField(current?.project === entry.project && current.profile === entry.profile &&
        projectsFor(entry).every(project => projectsFor(current).includes(project)),
        `Keep the existing eval registration for ${name}`);
    }
    for (const [name, current] of Object.entries(registry)) {
      const entry = previous[name] ?? current;
      if (!git('ls-tree', '--name-only', base, '--', entry.project).trim()) continue;
      const priorProject = JSON.parse(git('show', `${base}:${entry.project}`));
      if (!priorProject.profiles.some(profile => profile.id === entry.profile)) continue;
      const currentProfile = loadProfile(entry);
      const priorProfile = loadProfile(entry, base);
      if (currentProfile.digest !== priorProfile.digest) {
        requireField(currentProfile.profile.revision > priorProfile.profile.revision, `Bump the profile revision for ${name}`);
        requireField(json(current.reports[0]).variants.baseline.digest === priorProfile.digest,
          `Compare ${name} against the profile from the base branch`);
      }
    }
  }
  for (const file of files.filter(file => file.endsWith('/lock.json'))) {
    const dir = posix.dirname(file);
    requireField(!git('diff', '--no-ext-diff', '--no-renames', '--name-only', base, '--', dir).trim(),
      `Frozen suite changed: ${dir}. Add a new version and retain this one.`);
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const { values } = parseArgs({ options: { base: { type: 'string' } } });
    if (values.base) checkFrozenHistory(values.base);
    await checkEvals();
    process.stdout.write('Agent eval evidence matches the active profiles and frozen suites.\n');
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
