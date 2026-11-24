import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { callFeatureCodex } from './feature-codex.mjs';
import { candidateRef, checkedRevision, commitChanges, digest, git, materialize, priorCandidate, project, promoteCandidate, sourcePath } from './feature-workspace.mjs';
import { withAgentWorkspace } from './feature-agent-workspace.mjs';
import { featurePrompt } from './feature-prompts.mjs';
import { resolveProjectAgents } from './feature-profiles.mjs';
import { inspectAppImage, runNodeTests, startFeaturePreview } from './feature-app.mjs';
export { startFeaturePreview, stopFeaturePreview } from './feature-app.mjs';

const noEvent = async () => {};
const remove = dir => rm(dir, { recursive: true, force: true });
function activeContext(ctx, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return { ...ctx, signal: ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout, onEvent: ctx.onEvent ?? noEvent };
}

async function attachedToolContext(profile, repoPath, revision, { signal, onEvent }) {
  if (!profile.extraTools?.length) return {};
  checkedRevision(revision);
  const tools = await Promise.all(profile.extraTools.map(async action => {
    const history = action === 'git-history';
    const args = history ? ['log', '-8', '--first-parent', '--no-notes', '--no-show-signature', '--format=%h%x09%s', revision, '--']
      : ['diff-tree', '--root', '--no-commit-id', '--diff-merges=first-parent', '--name-only', '--no-renames', '-r', '-z', revision, '--'];
    let output;
    try { output = await git(repoPath, args, { signal }); }
    catch (error) {
      signal.throwIfAborted();
      await onEvent({ type: 'tool.failed', evidence: { action, revision } });
      return [action, { unavailable: true }];
    }
    const rows = history ? output.split('\n').filter(Boolean).map(row => row.slice(0, 260))
      : output.split('\0').filter(sourcePath).slice(0, 120);
    await onEvent({ type: 'tool.completed', evidence: { action, revision, count: rows.length } });
    return [action, rows];
  }));
  return { toolContext: { revision, results: Object.fromEntries(tools) } };
}

export function createFeatureRuntime({ rootDir = resolve('.crew-local/projects'), model = process.env.CREW_CODEX_MODEL,
  image = process.env.CREW_APP_IMAGE || 'node:22-alpine', agentImage = process.env.CREW_AGENT_IMAGE || 'node:22-alpine', timeoutMs = 30 * 60_000,
  verifyApp, probeApp, agent = callFeatureCodex, roles, agents, activeAgents } = {}) {
  const definitions = resolveProjectAgents({ roles, agents, activeAgents }, { model, agentImage, verifyApp });
  const { profiles } = definitions;
  const call = (role, payload, ctx) => {
    const profile = profiles[role];
    return agent({ role, model: profile.model, profile, allowedActions: payload.allowedActions, developmentProbe: Boolean(probeApp), signal: ctx.signal, onEvent: ctx.onEvent,
      prompt: featurePrompt(role, profile.instructions, payload, { developmentProbe: Boolean(probeApp), skills: profile.skills }) });
  };
  const runTests = async (repoPath, revision, pinned, ctx, independentTest) => {
    const directory = await materialize(repoPath, revision, ctx.signal);
    try {
      const result = await runNodeTests({ directory, image: pinned, independentTest, signal: ctx.signal, onEvent: ctx.onEvent });
      await ctx.onEvent({ type: 'app.test.completed', evidence: { revision, imageId: pinned, ...result } });
      return result;
    } finally { await remove(directory); }
  };
  async function checkLiveApp(repoPath, revision, imageId, ctx, hook, name) {
    const checks = [];
    let preview;
    try {
      preview = await startFeaturePreview({ repoPath, revision, projectId: ctx.projectId, image: imageId, durable: false, signal: ctx.signal });
    } catch (error) {
      ctx.signal.throwIfAborted();
      const failure = { passed: false, check: 'HTTP /health', evidence: String(error.message).slice(0, 2000) };
      await ctx.onEvent({ type: 'app.unhealthy', evidence: { revision, ...failure } });
      return [failure, ...(hook ? [{ check: name, status: 'skipped', reason: 'A healthy preview is required' }] : [])];
    }
    try {
      checks.push({ passed: true, check: 'HTTP /health' });
      await ctx.onEvent({ type: 'app.healthy', evidence: { revision, image: imageId, route: '/health' } });
      if (hook) {
        await ctx.onEvent({ type: 'app.probe.started', evidence: { revision, check: name } });
        let result;
        try {
          const observed = await hook({ url: preview.url, directory: preview.directory, revision, projectId: ctx.projectId,
            featureId: ctx.featureId, signal: ctx.signal });
          if (typeof observed?.passed !== 'boolean') throw new Error('Application probe omitted its verdict');
          const detail = JSON.stringify(observed);
          result = detail.length <= 12000 ? observed : { passed: observed.passed, evidence: detail.slice(0, 11900) + '…' };
        } catch (error) {
          ctx.signal.throwIfAborted();
          result = { passed: false, evidence: String(error.message).slice(0, 2000) };
        }
        checks.push({ ...result, check: name });
        await ctx.onEvent({ type: 'app.probe.completed', evidence: { ...result, revision, check: name } });
      }
      return checks;
    } finally { await preview.stop(); }
  }
  async function reportCandidate(repoPath, base, revision, summary, imageId, ctx) {
    const paths = await git(repoPath, ['diff', '--name-only', '--no-ext-diff', '--no-textconv', base, revision, '--'], { signal: ctx.signal });
    return { revision, base, repoPath, image: imageId, summary, filesChanged: paths.split('\n').filter(Boolean) };
  }
  return {
    ...definitions, developmentProbe: Boolean(probeApp),
    async plan(input) {
      const ctx = activeContext(input, timeoutMs);
      const { repoPath, base } = await project(rootDir, ctx);
      return withAgentWorkspace({ repoPath, revision: base, ctx, profile: profiles.planner }, async workspace => {
        const source = await workspace.snapshot();
        const { value, receipt } = await call('planner', {
          goal: ctx.goal, base, source, ...await attachedToolContext(profiles.planner, repoPath, base, ctx),
        }, ctx);
        return { plan: { ...value, base }, receipt };
      });
    },
    async build(input) {
      const ctx = activeContext(input, timeoutMs);
      const { repoPath } = await project(rootDir, ctx);
      const base = checkedRevision(ctx.plan.base);
      const imageId = await inspectAppImage(image, ctx.signal);
      const previous = await priorCandidate(repoPath, ctx.operationId, ctx.signal);
      if (previous) return reportCandidate(repoPath, base, previous, 'Recovered recorded candidate', imageId, ctx);
      const start = ctx.candidate?.revision || base;
      return withAgentWorkspace({ repoPath, revision: start, ctx, profile: profiles.engineer }, async workspace => {
        if (!profiles.engineer.tools.includes('edit')) throw new Error('Engineer profile ' + profiles.engineer.id + ' is read-only; implementation requires workspace-write');
        const toolContext = await attachedToolContext(profiles.engineer, repoPath, start, ctx);
        let revision = start, tested = null;
        const history = [];
        // Bounded file access and command execution give the engineer a private
        // evolving checkout. Every mutating tool creates a new immutable tree.
        for (let turn = 1; turn <= 14; turn++) {
          ctx.signal.throwIfAborted();
          const manifest = await workspace.list();
          const canFinish = tested === revision && revision !== start;
          const allowedActions = manifest.length
            ? profiles.engineer.tools.filter(action => action !== 'finish' || canFinish)
            : ['edit'];
          const { value } = await call('engineer', { goal: ctx.goal, plan: ctx.plan, feedback: ctx.feedback, manifest, allowedActions, history,
            currentRevision: revision, turnsLeft: 15 - turn, ...toolContext }, ctx);
          if (!allowedActions.includes(value.action)) throw new Error('Unsupported workspace action for this revision. Choose from ' + allowedActions.join(', '));
          const evidence = { role: 'engineer', action: value.action, turn, revision, summary: String(value.summary || '').slice(0, 1600) };
          await ctx.onEvent({ type: 'tool.called', evidence });
          let result;
          if (value.action === 'read') {
            if (!Array.isArray(value.paths) || !value.paths.length || value.paths.length > 12) throw new Error('Read requires 1–12 regular source paths');
            result = { files: await workspace.read(value.paths) };
          }
          if (value.action === 'edit') {
            await workspace.edit(value.changes);
            revision = await commitChanges({ repoPath, parent: revision, changes: value.changes, signal: ctx.signal, onEvent: ctx.onEvent });
            await git(repoPath, ['update-ref', 'refs/crew/attempts/' + digest(ctx.operationId) + '/turn-' + turn + '-' + revision, revision], { signal: ctx.signal });
            tested = null;
            result = { revision, filesChanged: value.changes.map(({ path }) => path) };
          }
          if (value.action === 'test') {
            let nodeTests;
            try { nodeTests = await runTests(repoPath, revision, imageId, ctx); }
            catch (error) {
              ctx.signal.throwIfAborted();
              nodeTests = { passed: false, evidence: String(error.message).slice(0, 2000) };
            }
            const liveChecks = probeApp ? await checkLiveApp(repoPath, revision, imageId, ctx, probeApp, 'Development application probe') : [];
            result = { passed: nodeTests.passed && liveChecks.every(check => check.passed === true), nodeTests, liveChecks };
            tested = result.passed ? revision : null;
          }
          if (value.action === 'finish') {
            await git(repoPath, ['update-ref', candidateRef(ctx.operationId), revision, ''], { signal: ctx.signal });
            await ctx.onEvent({ type: 'tool.completed', evidence: { ...evidence, revision } });
            return reportCandidate(repoPath, base, revision, value.summary, imageId, ctx);
          }
          await ctx.onEvent({ type: 'tool.completed', evidence: { ...evidence, revision,
            ...(value.action === 'read' ? { paths: value.paths } : {}),
            ...(result?.passed !== undefined ? { passed: result.passed } : {}) } });
          history.push({ action: value.action, summary: value.summary, result });
          // Expire old reads; a subsequent explicit read always returns current content.
          for (const entry of history.slice(0, -2)) if (entry.action === 'read') {
            entry.result = { paths: entry.result.paths || entry.result.files?.map(file => file.path) || [] };
          }
        }
        throw new Error('Engineer exhausted its workspace turn budget before submitting a tested candidate');
      });
    },
    async verify(input) {
      const ctx = activeContext(input, timeoutMs);
      const { repoPath } = await project(rootDir, ctx);
      const revision = checkedRevision(ctx.candidate.revision);
      if (!['qa', 'security', 'reviewer'].includes(ctx.role)) throw new Error('Unknown verification role');
      return withAgentWorkspace({ repoPath, revision, ctx, profile: profiles[ctx.role] }, async workspace => {
        const source = await workspace.snapshot(ctx.candidate.filesChanged);
        const payload = { goal: ctx.goal, plan: ctx.plan, revision, source, changedPaths: ctx.candidate.filesChanged, repairHistory: ctx.feedback,
          ...await attachedToolContext(profiles[ctx.role], repoPath, revision, ctx) };
        if (ctx.role !== 'qa') {
          const { value, receipt } = await call(ctx.role, payload, ctx);
          if (typeof value.passed !== 'boolean' || !Array.isArray(value.findings)) throw new Error('Invalid review verdict');
          return { ...value, revision, receipt };
        }
        const pinned = ctx.candidate.image;
        const detail = error => String(error?.message || 'Check failed').slice(0, 2000);
        let qaResult;
        async function recordCheck(check, work) {
          try {
            const result = await work();
            if (typeof result?.passed !== 'boolean') throw new Error('Check omitted its verdict');
            return { ...result, check };
          } catch (error) {
            ctx.signal.throwIfAborted();
            return { check, passed: false, evidence: detail(error) };
          }
        }
        async function independent() {
          const result = await call('qa', payload, ctx);
          const { value } = result;
          if (typeof value.testSource !== 'string' || !value.testSource.trim() || Buffer.byteLength(value.testSource) > 100_000) throw new Error('QA did not supply a bounded independent test');
          qaResult = result;
          return runTests(repoPath, revision, pinned, ctx, value.testSource);
        }
        // Each verifier has its own container and lifetime. One failed test or
        // invalid QA response must not prevent evidence from the other checks.
        const groups = await Promise.allSettled([
          recordCheck('Author tests', () => runTests(repoPath, revision, pinned, ctx)),
          recordCheck('Independent QA tests', independent),
          checkLiveApp(repoPath, revision, pinned, ctx, verifyApp, 'Operator acceptance test'),
        ]);
        ctx.signal.throwIfAborted();
        const checks = groups.flatMap(group => {
          if (group.status === 'rejected') throw group.reason;
          return group.value;
        });
        return { passed: checks.every(check => check.passed === true), revision, image: pinned, checks,
          ...(qaResult ? { summary: qaResult.value.summary, receipt: qaResult.receipt, independentTest: qaResult.value.testSource } : {}) };
      });
    },
    async promote(input) {
      const ctx = activeContext(input, timeoutMs);
      return promoteCandidate(await project(rootDir, ctx), ctx);
    },
  };
}
