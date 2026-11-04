import { randomUUID } from 'node:crypto';
import { CrewError, id, requireField, text, validateResponse } from './contracts.mjs';
import { artifact, artifactDigest } from './run-store.mjs';
import { executeCodex, inputOnlyPolicy } from './codex.mjs';
import { executeEvidence } from './checks.mjs';
import { candidateDiff } from './git-control.mjs';

export function newRun(snapshot, runId, projectPath) {
  const { project, files, sourceCommit } = snapshot;
  const fromGit = (id, title, kind, path) => artifact(id, title, kind, files.get(path), { source: 'git', sourceCommit, path });
  const artifacts = [fromGit('project-config', 'Project configuration', 'json', projectPath)];
  for (const input of project.inputs) artifacts.push(fromGit(`input-${input.id}`, input.title, 'text', input.path));
  const profiles = project.profiles.map(profile => {
    const instructionId = `profile-${profile.id}`;
    artifacts.push(fromGit(instructionId, `${profile.name} instructions`, 'text', profile.instructions));
    const skillIds = profile.skills.map((path, index) => {
      const skillId = `${instructionId}-skill-${index + 1}`;
      artifacts.push(fromGit(skillId, path, 'text', path));
      return skillId;
    });
    return { ...profile, instructionId, skillIds };
  });
  const tasks = project.tasks.map(task => {
    const profile = profiles.find(profile => profile.id === task.profileId);
    const packet = { ...task, schemaVersion: 1, runId, taskId: task.id, packetRevision: task.revision, sourceCommit,
      profileRef: { id: profile.id, revision: profile.revision },
      inputArtifacts: task.inputs.map(input => `input-${input}`) };
    const packetId = `packet-${task.id}`;
    artifacts.push(artifact(packetId, `${task.title} packet`, 'json', JSON.stringify(packet, null, 2),
      { source: 'git', sourceCommit, path: projectPath }));
    return { packet, packetId, attempts: [] };
  });
  requireField(new Set(artifacts.map(value => value.id)).size === artifacts.length, 'Conflicting generated artifact IDs');
  return { schemaVersion: 1, id: runId, startedAt: new Date().toISOString(), epic: project.epic,
    project: { id: project.id, name: project.name, crewName: project.crewName, runtime: project.runtime, path: projectPath },
    sourceCommit, profiles, tasks, artifacts };
}

function findTask(run, taskId) {
  id(taskId, 'task ID');
  const task = run.tasks.find(task => task.packet.id === taskId);
  if (!task) throw new CrewError(`Task ${taskId} does not exist`, 4);
  return task;
}

export function findArtifact(run, artifactId) {
  const value = run.artifacts.find(item => item.id === artifactId);
  if (!value) throw new CrewError('Artifact does not exist', 4);
  requireField(typeof value.content === 'string' && artifactDigest(value.content) === value.digest,
    `Artifact ${artifactId} does not match its recorded digest`);
  return value;
}

export function summarize(run) {
  const { artifacts, ...rest } = run;
  const tasks = run.tasks.map(task => ({ ...task, attempts: task.attempts.map(attempt => ({
    ...attempt, evidenceStatus: attempt.outcome === 'running' ? 'pending' : hasEvidence(run, task.packet, attempt) ? 'recorded' : 'missing',
    verification: verificationOf(run, attempt),
  })) }));
  return { ...rest, tasks, ...runOverview(run), epic: epicOf(run), artifacts: artifacts.map(({ content, ...metadata }) => metadata) };
}

function hasEvidence(run, packet, attempt) {
  const references = [attempt.receiptId];
  if (packet.execution && attempt.result?.state === 'completed') {
    references.push(attempt.runnerArtifacts?.['check-receipt']);
    if (packet.execution.kind === 'build') references.push(attempt.runnerArtifacts?.candidate);
  }
  if (attempt.result?.state === 'completed') {
    references.push(...packet.outputs.filter(slot => slot.required).map(slot => attempt.result.artifacts[slot.id]));
  }
  return references.every(reference => {
    try { return findArtifact(run, reference).provenance.attemptId === attempt.id; }
    catch (error) { if (error instanceof CrewError) return false; throw error; }
  });
}

function verificationOf(run, attempt) {
  const reference = attempt.runnerArtifacts?.['check-receipt'];
  if (!reference) return undefined;
  try { return JSON.parse(findArtifact(run, reference).content); }
  catch (error) { if (error instanceof CrewError || error instanceof SyntaxError) return undefined; throw error; }
}

function acceptedAttempt(run, taskId) {
  const task = findTask(run, taskId);
  const attempt = task.attempts.at(-1);
  if (attempt?.decision?.disposition !== 'accepted' || !hasEvidence(run, task.packet, attempt)) {
    throw new CrewError(`Waiting for accepted handoff: ${task.packet.title}`, 3);
  }
  return attempt;
}

function handoffCounts(run) {
  const counts = { total: run.tasks.length, accepted: 0, running: 0, review: 0, attention: 0 };
  for (const { packet, attempts } of run.tasks) {
    const attempt = attempts.at(-1);
    if (!attempt) continue;
    if (attempt.outcome === 'running') counts.running++;
    else if (attempt.outcome !== 'completed' || attempt.result?.state !== 'completed' || attempt.decision?.disposition === 'rework' ||
      !hasEvidence(run, packet, attempt)) counts.attention++;
    else if (attempt.decision?.disposition === 'accepted') counts.accepted++;
    else counts.review++;
  }
  return counts;
}

function runOverview(run) {
  const handoffs = handoffCounts(run);
  const recent = run.tasks.flatMap(({ packet, attempts }) => attempts.map(attempt => ({
    taskId: packet.id, title: packet.title, at: attempt.decision?.recordedAt ?? attempt.endedAt ?? attempt.startedAt,
    action: attempt.decision?.disposition ?? attempt.outcome, attempt: attempt.number,
    detail: attempt.decision?.note,
  }))).sort((a, b) => b.at.localeCompare(a.at));
  const qaPassed = run.tasks.some(({ packet, attempts }) => packet.execution?.kind === 'verify' &&
    attempts.at(-1)?.decision?.disposition === 'accepted' && verificationOf(run, attempts.at(-1))?.passed);
  return { handoffs, latestActivity: recent[0], recentDecisions: recent.filter(event => event.detail).slice(0, 3),
    readyForProjectReview: handoffs.accepted === handoffs.total && qaPassed };
}

function epicOf(run) {
  return run.epic ?? { id: 'epic-1', title: 'Epic 1', goal: run.tasks[0].packet.objective };
}

export function workspaceCatalog(runs) {
  const projects = new Map();
  for (const run of runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt))) {
    const epic = epicOf(run);
    if (!projects.has(run.project.id)) projects.set(run.project.id, {
      id: run.project.id, name: run.project.name, crewName: run.project.crewName, profiles: run.profiles,
      configurationRun: run.id, epics: [],
    });
    const project = projects.get(run.project.id);
    let entry = project.epics.find(value => value.id === epic.id);
    if (!entry) {
      entry = { ...epic, runs: [] };
      project.epics.push(entry);
    }
    entry.runs.push({ id: run.id, startedAt: run.startedAt, sourceCommit: run.sourceCommit, ...runOverview(run) });
  }
  return [...projects.values()];
}

export async function dispatch(store, taskId, signal, onStart, execute = executeCodex, control) {
  const job = await store.update(run => {
    const task = findTask(run, taskId);
    const previous = task.attempts.at(-1);
    if (previous && previous.decision?.disposition !== 'rework') {
      throw new CrewError('Record a rework decision before dispatching another attempt', 3);
    }
    const attemptsAtRevision = task.attempts.filter(attempt => attempt.packetRevision === task.packet.revision).length;
    if (attemptsAtRevision >= task.packet.budget.maxAttempts) throw new CrewError('Packet attempt limit reached', 3);
    const profile = run.profiles.find(profile => profile.id === task.packet.profileId);
    const prerequisites = new Map(task.packet.prerequisites.map(id => [id, acceptedAttempt(run, id)]));
    const received = (task.packet.handoffInputs ?? []).map(({ task, slot }) => {
      const attempt = prerequisites.get(task);
      return findArtifact(run, attempt.result.artifacts[slot] ?? attempt.runnerArtifacts?.[slot]);
    });
    const candidate = prerequisites.get(task.packet.execution?.candidateFrom)?.candidate;
    const inputs = [...task.packet.inputArtifacts.map(id => findArtifact(run, id)), ...received];
    const attempt = {
      id: randomUUID(), number: task.attempts.length + 1, packetRevision: task.packet.revision,
      profileRevision: profile.revision, sourceCommit: run.sourceCommit, startedAt: new Date().toISOString(),
      outcome: 'running', runtime: run.project.runtime, effectivePermissions: inputOnlyPolicy,
      packetId: task.packetId,
      inputArtifacts: inputs.map(input => input.id),
      prerequisites: [...prerequisites].map(([taskId, attempt]) => ({ taskId, attemptId: attempt.id })),
    };
    task.attempts.push(attempt);
    const instructions = [profile.instructionId, ...profile.skillIds].map(id => findArtifact(run, id).content);
    return { attempt, task: { ...task.packet, inputArtifacts: attempt.inputArtifacts }, candidate, profile, inputs, instructions,
      model: run.project.runtime.model };
  });
  onStart?.(job.attempt.id);
  const deadline = AbortSignal.timeout(job.task.budget.timeoutSeconds * 1000);
  const attemptSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;

  let observation;
  let result;
  try {
    observation = await execute({ ...job, signal: attemptSignal });
    if (observation.outcome === 'completed') result = validateResponse(observation.response, job.task);
  } catch (error) {
    observation = { ...observation, outcome: observation ? 'invalid-result' : 'execution-failed',
      error: error instanceof CrewError ? error.message : 'Could not complete the local Codex attempt' };
  }
  let checked;
  if (job.task.execution && result?.state === 'completed') {
    try {
      checked = await executeEvidence(control, job, result, attemptSignal);
      if (!checked.receipt.passed) observation = { ...observation, outcome: 'check-failed', error: 'One or more Docker checks failed' };
    } catch (error) {
      observation = { ...observation, outcome: 'check-failed', error: error instanceof CrewError ? error.message : 'Could not execute Docker checks' };
    }
  }

  return store.update(run => {
    const task = findTask(run, taskId);
    const attempt = task.attempts.find(attempt => attempt.id === job.attempt.id);
    const { receipt, outcome, error } = observation;
    Object.assign(attempt, { outcome, error, endedAt: new Date().toISOString(), usage: receipt?.usage ?? null });
    attempt.overTokenTarget = attempt.usage ? attempt.usage.total > task.packet.budget.targetTotalTokens : null;
    if (receipt) {
      const receiptId = `receipt-${attempt.id}`;
      run.artifacts.push(artifact(receiptId, 'Codex execution receipt', 'json', JSON.stringify({
        schemaVersion: 1, runId: run.id, taskId, attemptId: attempt.id, sourceCommit: run.sourceCommit,
        outcome: checked || outcome === 'check-failed' ? 'completed' : outcome, ...receipt,
      }, null, 2), { source: 'runtime', attemptId: attempt.id }));
      attempt.receiptId = receiptId;
    }
    if (checked) {
      attempt.candidate = checked.candidate;
      attempt.runnerArtifacts = {};
      const evidence = { ...checked.receipt, runId: run.id, taskId, attemptId: attempt.id };
      const entries = [['check-receipt', checked.receipt.kind === 'independent-qa' ? 'Independent QA · Docker receipt' : 'Author tests · Docker receipt', evidence]];
      if (task.packet.execution.kind === 'build') entries.push(['candidate', 'Candidate commit', checked.candidate]);
      for (const [slot, title, data] of entries) {
        const artifactId = `evidence-${attempt.id}-${slot}`;
        run.artifacts.push(artifact(artifactId, title, 'json', JSON.stringify(data, null, 2), { source: 'runtime', attemptId: attempt.id }));
        attempt.runnerArtifacts[slot] = artifactId;
      }
      if (checked.diff) {
        const artifactId = `evidence-${attempt.id}-candidate-diff`;
        run.artifacts.push(artifact(artifactId, 'Candidate Git diff', 'text', checked.diff,
          { source: 'runtime', attemptId: attempt.id, sourceCommit: checked.candidate.commit }));
        attempt.runnerArtifacts['candidate-diff'] = artifactId;
      }
    }
    if (result) {
      const { outputs, ...summary } = result;
      attempt.result = { ...summary, schemaVersion: 1, runId: run.id, taskId, packetRevision: attempt.packetRevision,
        artifacts: Object.fromEntries(outputs.map(output => {
          const artifactId = `output-${attempt.id}-${output.slot}`;
          const slot = task.packet.outputs.find(slot => slot.id === output.slot);
          run.artifacts.push(artifact(artifactId, slot.title ?? output.slot, slot.kind, output.content,
            { source: 'agent-result', attemptId: attempt.id }));
          return [output.slot, artifactId];
        })) };
    }
    return attempt;
  });
}

export function attachCandidateDiff(store, control, taskId, buildId) {
  return store.update(run => {
    const task = findTask(run, taskId);
    const prior = task.attempts.at(-1);
    requireField(prior?.decision?.disposition === 'rework' && prior.packetRevision === task.packet.revision,
      'Record a rework decision for the current packet first');
    requireField(task.packet.prerequisites.includes(buildId), 'Build must be a direct prerequisite');
    const build = acceptedAttempt(run, buildId);
    requireField(findTask(run, buildId).packet.execution?.kind === 'build' && build.candidate?.commit,
      'An accepted Git candidate is required');
    const input = { task: buildId, slot: 'candidate-diff' };
    const inputs = task.packet.handoffInputs ?? [];
    requireField(!inputs.some(value => value.task === buildId && value.slot === input.slot), 'This packet already receives the candidate diff');
    if (!build.runnerArtifacts['candidate-diff']) {
      const artifactId = `evidence-${build.id}-candidate-diff`;
      run.artifacts.push(artifact(artifactId, 'Candidate Git diff', 'text', candidateDiff(control, build.candidate),
        { source: 'git-candidate', attemptId: build.id, sourceCommit: build.candidate.commit }));
      build.runnerArtifacts['candidate-diff'] = artifactId;
    }
    prior.packetId ??= task.packetId;
    const revision = task.packet.revision + 1;
    task.packet = { ...task.packet, revision, packetRevision: revision, handoffInputs: [...inputs, input] };
    task.packetId = `packet-${taskId}-r${revision}`;
    run.artifacts.push(artifact(task.packetId, `${task.packet.title} packet · revision ${revision}`, 'json',
      JSON.stringify(task.packet, null, 2), { source: 'revised-after-review', attemptId: prior.id, sourceCommit: run.sourceCommit }));
    return { packetRevision: revision, packetId: task.packetId, diffId: build.runnerArtifacts['candidate-diff'] };
  });
}

export function decide(store, taskId, attemptId, disposition, note) {
  requireField(['accepted', 'rework'].includes(disposition), 'Decision must be accepted or rework');
  text(note, 'decision reason', 2_000);
  return store.update(run => {
    const task = findTask(run, taskId);
    const attempt = task.attempts.at(-1);
    if (attempt?.id !== attemptId) throw new CrewError('Decision must target the current attempt', 3);
    if (attempt.decision) throw new CrewError('This attempt already has a decision', 3);
    if (attempt.outcome === 'running') throw new CrewError('This attempt is still running', 3);
    if (disposition === 'accepted') {
      if (attempt.outcome !== 'completed' || attempt.result?.state !== 'completed') {
        throw new CrewError('Only a completed handoff with valid outputs can be accepted', 3);
      }
      requireField(hasEvidence(run, task.packet, attempt), 'Required outputs and evidence must come from the current attempt');
    }
    attempt.decision = { disposition, note, owner: task.packet.acceptedBy, recordedAt: new Date().toISOString() };
    return attempt.decision;
  });
}
