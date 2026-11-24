import { randomUUID } from 'node:crypto';
import { CrewError, requireField, text } from './contracts.mjs';
import { currentAttempt, currentAttempts } from './attempts.mjs';
import { artifact } from './run-store.mjs';
import { approvalReview } from './workflow-approvals.mjs';
import { readCodexCheckpoint, readWorkspaceCheckpoint, workspaceCheckpointReference } from './workflow-checkpoint.mjs';

export const agentMessageLimit = 12_000;

function attemptFor(run, taskId, attemptId) {
  const task = run.tasks.find(task => task.packet.id === taskId);
  const attempt = task && currentAttempt(task);
  return attempt?.id === attemptId && attempt.outcome === 'running' ? attempt : null;
}

export function savedCodexHistory(attempt) {
  const session = attempt?.codexSession;
  if (!session?.persisted || !session.threadId || !session.turnId) return;
  return { attemptId: attempt.id, threadId: session.threadId, turnId: session.turnId };
}

export function agentConversationEnabled(run, task) {
  return Boolean(run.agentRun && run.project.id === 'music-transcribe' &&
    run.profiles.find(profile => profile.id === task.packet.profileId)?.codexRuntime?.saveThread);
}

export function agentConversationHistory(run, task, attempt = currentAttempt(task)) {
  if (!agentConversationEnabled(run, task) || attempt?.outcome !== 'completed' || attempt.result?.state !== 'completed' ||
    attempt.packetRevision !== task.packet.revision || attempt.decision?.disposition === 'rework' || attempt.resourceIds?.length) return;
  return savedCodexHistory(attempt);
}

export function canReuseCodexHistory(task, attempt) {
  if (attempt?.packetRevision !== task.packet.revision) return;
  if (attempt.decision?.disposition === 'rework' || attempt.outcome === 'worker-disconnected') return savedCodexHistory(attempt);
}

export const infrastructureRetry = attempt => ['history-unavailable', 'worker-disconnected'].includes(attempt?.outcome);

export function packetAttemptsUsed(task) {
  return currentAttempts(task).filter(attempt => attempt.packetRevision === task.packet.revision &&
    !attempt.resourceIds?.length && !infrastructureRetry(attempt)).length;
}

export function workflowAttemptLimit(task) {
  const change = task.attemptBudgetChange;
  return change?.packetRevision === task.packet.revision ? change.limit : task.packet.budget.maxAttempts;
}

export function canAllowAdditionalAttempt(task, attempt = currentAttempt(task)) {
  const limit = workflowAttemptLimit(task);
  return attempt?.decision?.disposition === 'rework' && attempt.packetRevision === task.packet.revision &&
    packetAttemptsUsed(task) === limit && limit < 5;
}

export function recoverWorkflowAttempt(store, taskId, attemptId) {
  return store.update(async (run, workerStopped) => {
    const attempt = attemptFor(run, taskId, attemptId);
    if (!attempt) throw new CrewError('This attempt has already ended or been replaced. Reopen the handoff.', 3);
    if (!attempt.workerId) throw new CrewError('Worker ownership was not recorded for this attempt.', 3);
    if (!await workerStopped(attempt.workerId)) throw new CrewError('The workflow worker still owns this attempt.', 3);

    const endedAt = new Date().toISOString();
    const recoveryId = `recovery-${attempt.id}`;
    let checkpoint, checkpointUnavailable;
    try { checkpoint = readCodexCheckpoint(run, taskId, attempt); }
    catch (error) {
      if (!(error instanceof CrewError || error instanceof SyntaxError)) throw error;
      checkpointUnavailable = true;
    }
    const reference = workspaceCheckpointReference(attempt);
    let workspaceCheckpoint;
    try {
      if (reference) {
        const task = run.tasks.find(value => value.packet.id === taskId);
        workspaceCheckpoint = { ...readWorkspaceCheckpoint(run, task, reference).checkpoint, attemptId: reference.attemptId };
      }
    } catch (error) {
      if (!(error instanceof CrewError)) throw error;
      attempt.workspaceCheckpointUnavailable = true;
    }
    const uncertainTools = attempt.pendingToolCalls ?? attempt.toolActivity?.filter(tool => tool.status === 'running') ?? [];
    const reply = checkpoint?.finalReply ? { kind: 'final', text: checkpoint.finalReply.text } :
      attempt.agentReply?.text ? { kind: 'partial', ...attempt.agentReply } : undefined;
    if (reply) {
      reply.truncated ||= reply.text.length > 8_000;
      reply.text = reply.text.slice(0, 8_000).toWellFormed();
    }
    Object.assign(attempt, { outcome: 'worker-disconnected', endedAt, recoveryId,
      error: 'The workflow worker disconnected before saving a final result.' });
    finishWorkflowSession(attempt);
    const recovery = { schemaVersion: 1, runId: run.id, taskId, attemptId, sourceCommit: attempt.sourceCommit,
      workerId: attempt.workerId, observedAt: endedAt, outcome: attempt.outcome,
      ...(checkpoint && { checkpoint: attempt.codexCheckpoint, savedOutputs: checkpoint.outputs, reportedBlocker: checkpoint.blocker }),
      ...(checkpoint?.outputFollowUps?.length && { outputFollowUps: checkpoint.outputFollowUps }),
      ...(checkpointUnavailable && { checkpointUnavailable }),
      ...(workspaceCheckpoint && { workspaceCheckpoint }),
      ...(attempt.workspaceCheckpointUnavailable && { workspaceCheckpointUnavailable: true }),
      ...(attempt.generatedImages?.length && { generatedImages: attempt.generatedImages }),
      ...(attempt.codexSpeed && { codexSpeed: attempt.codexSpeed }),
      ...(reply && { reply }),
      ...(uncertainTools.length && { uncertainTools }),
      ...(attempt.codexSession && { codexSession: attempt.codexSession }),
      ...(attempt.agentActivity?.length && { recentActivity: attempt.agentActivity }) };
    run.artifacts.push(artifact(recoveryId, 'Worker recovery record', 'json', JSON.stringify(recovery, null, 2),
      { source: 'recovery', attemptId }));
    return attempt;
  });
}

export const workflowAnswerLimit = 2_000;

export function codexQuestionSet(questions) {
  if (!Array.isArray(questions) || !questions.length || questions.length > 3) return null;
  const ids = new Set();
  const normalized = [];
  for (const question of questions) {
    if (!question || question.isSecret || typeof question.id !== 'string' || !question.id || ids.has(question.id) ||
      typeof question.header !== 'string' || typeof question.question !== 'string' || !question.question) return null;
    const options = question.options ?? [];
    if (!Array.isArray(options) || options.some(option => !option || typeof option.label !== 'string' ||
      typeof option.description !== 'string')) return null;
    ids.add(question.id);
    normalized.push({ id: question.id, header: question.header, text: question.question, other: question.isOther === true,
      options: options.map(({ label, description }) => ({ label, description })) });
  }
  return normalized;
}

function formAnswers(questions, form) {
  return questions.map((question, index) => {
    const choice = form.get('choice-' + index);
    if (question.options.length && /^(0|[1-9][0-9]*)$/.test(choice ?? '')) {
      const option = question.options[Number(choice)];
      if (option) return { text: option.label, freeform: false };
    }
    if (!question.options.length || (choice === 'other' && question.other)) {
      const value = form.get('answer-' + index);
      requireField(typeof value === 'string' && value.trim() && value.length <= workflowAnswerLimit,
        `Enter an answer for question ${index + 1} in ${workflowAnswerLimit} characters or fewer.`);
      return { text: value.trim(), freeform: true };
    }
    throw new CrewError(`Choose an option for question ${index + 1}.`);
  });
}

export function queueWorkflowSessionAction(store, taskId, attemptId, { kind, turnId, message, requestId, form }) {
  requireField(['steer', 'interrupt', 'answer', 'approval'].includes(kind), 'Choose a live Codex action.');
  if (kind === 'steer') text(message, 'Codex guidance', 2_000);
  return store.update(async (run, workerStopped) => {
    const attempt = attemptFor(run, taskId, attemptId);
    const session = attempt?.codexSession;
    if (!session || session.turnId !== turnId || session.endedAt || attempt.workspaceChecksStartedAt)
      throw new CrewError('This Codex turn has ended. Reopen the handoff to see its status.', 3);
    if (attempt.workerId && await workerStopped(attempt.workerId))
      throw new CrewError('The workflow worker disconnected. Reopen the handoff to recover the attempt.', 3);
    const stopping = session.actions.some(action => action.kind === 'interrupt' &&
      ['queued', 'sending', 'acknowledged'].includes(action.status));
    if (stopping) {
      if (kind === 'interrupt') return;
      throw new CrewError('Codex is stopping this turn.', 3);
    }
    if (kind === 'answer' || kind === 'approval') {
      const request = session.actions.find(action => action.kind === kind && action.id === requestId);
      if (request?.status !== 'waiting' || (request.expiresAt && Date.parse(request.expiresAt) <= Date.now()))
        throw new CrewError(`This Codex request is closed or already has ${kind === 'answer' ? 'an answer' : 'a decision'}. Reopen the handoff to see its status.`, 3);
      const submitted = kind === 'answer' ? { answers: formAnswers(request.questions, form) } : { review: approvalReview(request.approval, form) };
      Object.assign(request, { status: 'queued', ...submitted, answeredAt: new Date().toISOString() });
      return;
    }
    session.actions.push({ id: randomUUID(), kind, turnId, createdAt: new Date().toISOString(), status: 'queued',
      ...(kind === 'steer' && { text: message.trim() }) });
  });
}

export function workflowSessionControls(store, taskId, attemptId) {
  const sessionOf = run => attemptFor(run, taskId, attemptId)?.codexSession;
  return {
    ready(identity) {
      return store.update(run => {
        const attempt = attemptFor(run, taskId, attemptId);
        if (attempt) attempt.codexSession = { ...identity, actions: attempt.codexSession?.actions ?? [] };
      });
    },
    endTurn(turnId) {
      return store.update(run => {
        const attempt = attemptFor(run, taskId, attemptId);
        const session = attempt?.codexSession;
        if (!session || session.turnId !== turnId) return true;
        const interrupted = session.actions.some(action => action.kind === 'interrupt' &&
          ['queued', 'sending', 'acknowledged'].includes(action.status));
        finishWorkflowSession(attempt);
        session.endedAt = new Date().toISOString();
        return interrupted;
      });
    },
    ask({ kind = 'answer', ...request }) {
      return store.update(run => {
        const session = sessionOf(run);
        if (!session) return;
        session.actions.push({ ...request, kind, turnId: session.turnId, status: 'waiting', createdAt: new Date().toISOString() });
      });
    },
    async next() {
      if (!sessionOf(await store.read())?.actions.some(action => action.status === 'queued')) return null;
      return store.update(run => {
        const action = sessionOf(run)?.actions.find(action => action.status === 'queued');
        if (!action) return null;
        action.status = 'sending';
        return action;
      });
    },
    settle(id, status) {
      return store.update(run => {
        const action = sessionOf(run)?.actions.find(action => action.id === id);
        const canClose = status === 'closed' && ['waiting', 'queued'].includes(action?.status) &&
          (action.kind === 'answer' || action.kind === 'approval');
        if (action?.status === 'sending' || canClose) Object.assign(action, { status, settledAt: new Date().toISOString() });
      });
    },
  };
}

export function finishWorkflowSession(attempt) {
  const session = attempt.codexSession;
  if (!session) return;
  for (const action of session.actions) {
    const status = { waiting: 'closed', queued: 'not-delivered', sending: 'unknown' }[action.status];
    if (status) Object.assign(action, { status, settledAt: new Date().toISOString() });
  }
}
