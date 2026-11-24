import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { codexQuestionSet } from './workflow-session.mjs';
import { codexApproval, codexApprovalMethods } from './workflow-approvals.mjs';
import { mcpElicitationRequest } from './workflow-elicitation.mjs';
import { codexServiceTierLabel, validCodexServiceTier } from './workflow-native.mjs';
import { codexFlagReport, codexMcpReport, codexSkillReport, codexThreadReport } from './workflow-runtime-report.mjs';

const itemTypes = {
  agentMessage: 'agent_message', commandExecution: 'command_execution', fileChange: 'file_change',
  mcpToolCall: 'mcp_tool_call', dynamicToolCall: 'dynamic_tool_call',
  collabAgentToolCall: 'collab_agent_tool_call', webSearch: 'web_search', imageGeneration: 'image_generation',
};

function execItem(item) {
  if (!item || !Object.hasOwn(itemTypes, item.type)) return null;
  return { type: itemTypes[item.type], id: item.id, text: item.text, phase: item.phase, server: item.server,
    tool: item.tool, status: item.status, error: item.error, exit_code: item.exitCode, receiver_thread_ids: item.receiverThreadIds,
    ...(item.type === 'commandExecution' && { command: item.command, aggregated_output: item.aggregatedOutput, duration_ms: item.durationMs }),
    ...(item.type === 'imageGeneration' && { result: item.result, error: item.failure }) };
}

function execUsage(tokens) {
  return { input_tokens: tokens?.inputTokens, output_tokens: tokens?.outputTokens,
    cached_input_tokens: tokens?.cachedInputTokens, reasoning_output_tokens: tokens?.reasoningOutputTokens };
}

const textInput = text => [{ type: 'text', text, textElements: [] }];

export class CodexTurnInterrupted extends Error {}
export class CodexHistoryUnavailable extends Error {}
const liveReplyLimit = 16_000;

// The CLI and the app-server share the worker's item policy and receipts.
// Translate the app-server stream without recording internal reasoning.
export function workflowAppServer({ child, thread, history, schema, prompt, controls, record, stop, finish,
  explicitSkills = [], imagePaths = [], streamReply = false, reportSpeed = false, followUp, inspection }) {
  let sequence = 0, threadId, turnId, completed, exitSeen = false, previousTurnId = history?.turnId;
  let final = '', lastMessage = '', tokens, priorTokens;
  let reply, replyTimer;
  const pending = new Map();
  const operatorRequests = new Map();
  const startedItems = new Map();
  let polling, connection, ready, processing, completion, operatorUpdates = Promise.resolve();
  let interruptRequested = false;
  let canonicalCwd;
  const send = msg => child.stdin.write(JSON.stringify(msg) + '\n');
  function observeTurn(id) {
    if (typeof id !== 'string' || id === previousTurnId || turnId) return;
    turnId = id;
    record({ type: 'turn.started', turn_id: id });
  }

  function flushReply() {
    if (!replyTimer) return;
    clearTimeout(replyTimer);
    replyTimer = undefined;
    record({ type: 'agent.reply', reply: { ...reply, text: reply.text.toWellFormed() } });
  }

  function collectReply({ itemId, delta }) {
    if (typeof itemId !== 'string' || typeof delta !== 'string' || !delta) return;
    if (reply?.itemId !== itemId) reply = { itemId, text: '', truncated: false };
    if (reply.truncated) return;
    const available = liveReplyLimit - reply.text.length;
    reply.text += delta.slice(0, available);
    reply.truncated = delta.length > available;
    replyTimer ??= setTimeout(flushReply, 500);
  }
  function request(method, params) {
    if (exitSeen) return Promise.reject(new Error('Codex app server disconnected'));
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      send({ id, method, params });
    });
  }

  function updateOperatorRequests(work) {
    const active = ready;
    operatorUpdates = operatorUpdates.then(() => active).then(work).catch(stop);
  }

  function showOperatorRequest(requestId, params, card, respond, expiryResult) {
    if (!controls || !threadId || params?.threadId !== threadId || !card) {
      send({ id: requestId, error: { code: -32601, message: 'This worker cannot display this Codex request.' } });
      return;
    }
    const timeout = expiryResult && params.autoResolutionMs;
    const expiresAt = Number.isInteger(timeout) && timeout >= 0 && timeout <= 2_147_483_647 ? Date.now() + timeout : null;
    const operatorRequest = { id: randomUUID(), kind: card.kind, respond, expiresAt, sent: false };
    operatorRequests.set(requestId, operatorRequest);
    updateOperatorRequests(async () => {
      if (completed || exitSeen) return;
      if (params.turnId !== turnId) {
        if (operatorRequests.delete(requestId))
          send({ id: requestId, error: { code: -32601, message: 'This Codex request is outside the active turn.' } });
        return;
      }
      if (expiresAt !== null && operatorRequests.has(requestId)) operatorRequest.timer = setTimeout(() => {
        if (!completed && !exitSeen) send({ id: requestId, result: expiryResult });
      }, Math.max(0, expiresAt - Date.now()));
      await controls.ask({ id: operatorRequest.id, ...card,
        ...(expiresAt !== null && { expiresAt: new Date(expiresAt).toISOString() }) });
    });
  }

  function ask(requestId, params) {
    const items = codexQuestionSet(params?.questions);
    showOperatorRequest(requestId, params, items && { kind: 'answer', questions: items, blocking: params.isBlocking !== false }, command => ({
      answers: Object.fromEntries(items.map(({ id }, index) => {
        const { text, freeform } = command.answers[index];
        return [id, { answers: [freeform ? 'user_note: ' + text : text] }];
      })),
    }), { answers: {} });
  }

  function approve(event) {
    const request = thread.approvalsReviewer === 'user' && event.params &&
      codexApproval(event.method, event.params, startedItems.get(event.params.itemId));
    showOperatorRequest(event.id, event.params, request && { kind: 'approval', approval: request.approval },
      command => request.respond(command.review));
  }

  function elicit(event) {
    const { id, params } = event;
    const server = inspection?.servers.find(server => server.id === params?.serverName);
    const request = mcpElicitationRequest(params, server);
    const correlatedTurn = params?.turnId ?? turnId;
    if (!request || !controls || params.threadId !== threadId || !correlatedTurn || (turnId && correlatedTurn !== turnId) || completed) {
      send({ id, result: { action: 'cancel', content: null } });
      return;
    }
    showOperatorRequest(id, { ...params, turnId: correlatedTurn }, { kind: 'elicitation', ...request }, command => ({
      action: command.responseAction,
      content: command.responseAction === 'accept' ? command.pendingElicitationValues ?? null : null,
    }));
  }

  async function sendOperatorDecision(command) {
    const entry = [...operatorRequests].find(([, request]) => request.id === command.id && request.kind === command.kind);
    if (!entry) return controls.settle(command.id, 'not-delivered');
    const [requestId, request] = entry;
    if (request.expiresAt !== null && request.expiresAt <= Date.now())
      return controls.settle(command.id, 'not-delivered');
    const result = request.respond(command);
    if (!result) return controls.settle(command.id, 'not-delivered');
    clearTimeout(request.timer);
    request.sent = true;
    send({ id: requestId, result });
  }

  async function pollControls(signal) {
    while (!signal.aborted) {
      const command = await controls.next();
      if (!command) {
        await wait(350, undefined, { signal }).catch(() => {});
        continue;
      }
      if (command.kind === 'interrupt') interruptRequested = true;
      if (completed || exitSeen) {
        await controls.settle(command.id, 'not-delivered');
        break;
      }
      if (['answer', 'approval', 'elicitation'].includes(command.kind)) {
        await sendOperatorDecision(command);
        continue;
      }
      let status = 'acknowledged';
      try {
        if (command.kind === 'interrupt') await request('turn/interrupt', { threadId, turnId });
        else {
          const result = await request('turn/steer', { threadId, expectedTurnId: turnId,
            clientUserMessageId: command.id, input: textInput(command.text) });
          if (result.turnId !== turnId) status = 'unknown';
        }
      } catch (error) { status = error.name === 'CodexRequestRejected' ? 'not-delivered' : 'unknown'; }
      await controls.settle(command.id, status);
    }
  }

  async function connect() {
    await request('initialize', {
      clientInfo: { name: 'engineering_crew_workflow', title: 'Engineering Crew', version: '1' },
      capabilities: { experimentalApi: true, ...(streamReply ? {} : { optOutNotificationMethods: ['item/agentMessage/delta'] }) },
    });
    send({ method: 'initialized' });
    let started;
    if (history) {
      const { ephemeral, ...settings } = thread;
      const fork = history.kind === 'fork';
      try {
        started = await request(fork ? 'thread/fork' : 'thread/resume', {
          ...settings, threadId: history.threadId, excludeTurns: true,
          ...(fork && { ephemeral, lastTurnId: history.turnId, deferGoalContinuation: true }),
        });
      } catch (error) {
        if (error.name !== 'CodexRequestRejected') throw error;
        throw new CodexHistoryUnavailable('The Codex worker could not open the saved thread. Check that its history is available on this worker.');
      }
      if (fork ? started.thread?.forkedFromId !== history.threadId || started.thread.id === history.threadId :
        started.thread?.id !== history.threadId)
        throw new Error('Codex returned a different history source than the workflow requested.');
      if (started.thread.status?.type === 'active')
        throw new CodexHistoryUnavailable('The saved Codex thread is still active. Wait for its current turn to finish.');
    } else {
      started = await request('thread/start', thread);
    }
    canonicalCwd = await realpath(thread.cwd);
    const verified = typeof started.thread?.id === 'string' && started.thread.ephemeral === thread.ephemeral &&
      started.approvalPolicy === thread.approvalPolicy && typeof started.cwd === 'string' &&
      await realpath(started.cwd).catch(() => null) === canonicalCwd &&
      (!thread.approvalsReviewer || started.approvalsReviewer === thread.approvalsReviewer) &&
      (thread.permissions ? started.activePermissionProfile?.id === thread.permissions :
        started.sandbox?.type === 'readOnly' && started.sandbox.networkAccess === false);
    if (inspection) record({ type: 'thread.runtime', part: 'thread', value: codexThreadReport(started, verified) });
    if (!verified)
      throw new Error('The Codex app server did not apply the assignment’s workspace and approval policy.');
    threadId = started.thread.id;
    record({ type: 'thread.started', thread_id: threadId, model: started.model });
    if (reportSpeed && (thread.serviceTier || Object.hasOwn(started, 'serviceTier'))) {
      const requested = thread.serviceTier ?? null;
      const applied = validCodexServiceTier(started.serviceTier) ? started.serviceTier : null;
      record({ type: 'thread.speed', speed: { requested, applied } });
      if (requested && applied !== requested)
        throw new Error('Codex did not apply the requested ' + codexServiceTierLabel(requested) + ' speed. Check availability on the selected model and worker.');
    }
    const input = textInput(prompt);
    if (explicitSkills.length) {
      const result = await request('skills/list', { cwds: [canonicalCwd], forceReload: true });
      if (inspection?.attachedSkillPaths.length) record({ type: 'thread.runtime', part: 'skills',
        value: codexSkillReport(result, canonicalCwd, inspection.attachedSkillPaths) });
      const { data } = result;
      const discovered = data?.find(entry => entry.cwd === canonicalCwd)?.skills ?? [];
      for (const skill of explicitSkills) {
        const path = join(canonicalCwd, skill.manifestPath);
        if (!discovered.some(item => item.path === path && item.name === skill.name && item.enabled))
          throw new Error('Codex could not load the pinned skill ' + skill.title + '. Check its SKILL.md and worker settings.');
        input.push({ type: 'skill', name: skill.name, path });
      }
    }
    input.push(...imagePaths.map(path => ({ type: 'localImage', path })));
    if (!exitSeen) beginTurn(input);
  }

  function beginTurn(input, followUpInput) {
    previousTurnId = turnId ?? previousTurnId;
    turnId = completed = undefined;
    final = lastMessage = '';
    reply = undefined;
    polling = new AbortController();
    ready = startTurn(input, followUpInput);
    processing = ready.then(() => controls && pollControls(polling.signal)).catch(stop);
  }

  async function startTurn(input, followUpInput) {
    const startedTurn = await request('turn/start', { threadId, input, ...(schema && { outputSchema: schema }) });
    if (typeof startedTurn.turn?.id !== 'string' || startedTurn.turn.id === previousTurnId || (turnId && startedTurn.turn.id !== turnId))
      throw new Error('Codex did not report the assignment turn.');
    observeTurn(startedTurn.turn.id);
    if (followUpInput) record({ type: 'turn.follow-up', followUp: { previousTurnId, turnId, ...followUpInput } });
    else {
      if (explicitSkills.length) record({ type: 'turn.skills' });
      if (imagePaths.length) record({ type: 'turn.images' });
      if (inspection) inspectThread();
    }
    if (controls) await controls.ready({ threadId, turnId, ...(!thread.ephemeral && { persisted: true }) });
  }

  function inspectThread() {
    function inspect(method, params, part, summary) {
      // The agent proceeds while optional inventory requests are in flight.
      request(method, params).catch(() => null).then(result => {
        if (!exitSeen) record({ type: 'thread.runtime', part, value: summary(result) });
      }).catch(stop);
    }
    const flags = new Set(Object.keys(inspection.flags));
    if (flags.size) inspect('experimentalFeature/list', { threadId, limit: 250 }, 'flags', result => codexFlagReport(result, flags));
    for (const { id } of inspection.servers)
      inspect('mcpServerStatus/list', { threadId, serverName: id, detail: 'toolsAndAuthOnly', limit: 1 }, 'mcp', result => codexMcpReport(result, id));
    if (inspection.attachedSkillPaths.length && !explicitSkills.length)
      inspect('skills/list', { cwds: [canonicalCwd], forceReload: true }, 'skills',
        result => codexSkillReport(result, canonicalCwd, inspection.attachedSkillPaths));
  }

  async function completeTurn(turn) {
    await Promise.all([processing, operatorUpdates]);
    if (exitSeen) return;
    if (followUp && turn.status === 'completed') {
      const endedByOperator = await controls?.endTurn(turnId);
      if (!interruptRequested && !endedByOperator && !exitSeen) {
        const next = await followUp(turnId);
        if (next && !exitSeen) {
          const text = final || lastMessage;
          for (const request of operatorRequests.values()) clearTimeout(request.timer);
          operatorRequests.clear();
          startedItems.clear();
          beginTurn(textInput(next.prompt), { ...next, previousReply: {
            text: text.slice(0, liveReplyLimit).toWellFormed(), truncated: text.length > liveReplyLimit,
          } });
          return;
        }
      }
    }
    if (exitSeen) return;
    const usage = priorTokens && tokens && Object.fromEntries(Object.entries(tokens).map(([key, count]) =>
      [key, Number.isSafeInteger(count) && Number.isSafeInteger(priorTokens[key]) ? count - priorTokens[key] : undefined]));
    finish({ status: turn.status, error: turn.error, text: final || lastMessage, usage: usage ?? tokens });
    child.stdin.end();
  }

  function receive(event) {
    if (event.id !== undefined && !event.method) {
      const reply = pending.get(event.id);
      if (!reply) return;
      pending.delete(event.id);
      if (event.error || event.result === undefined) {
        const error = new Error('The Codex app server rejected the request.');
        error.name = 'CodexRequestRejected';
        reply.reject(error);
      } else reply.resolve(event.result);
      return;
    }
    if (event.id !== undefined && event.method) {
      if (event.method === 'item/tool/requestUserInput') ask(event.id, event.params);
      else if (codexApprovalMethods.has(event.method)) approve(event);
      else if (event.method === 'mcpServer/elicitation/request') elicit(event);
      else send({ id: event.id, error: { code: -32601, message: 'This turn uses the configured worker approval policy.' } });
      return;
    }
    const params = event.params;
    if (!threadId || params?.threadId !== threadId) return;
    if (event.method === 'serverRequest/resolved') {
      const request = operatorRequests.get(params.requestId);
      if (!request) return;
      operatorRequests.delete(params.requestId);
      clearTimeout(request.timer);
      const status = request.sent ? request.kind === 'answer' ? 'answered' : 'acknowledged' : 'closed';
      updateOperatorRequests(() => controls.settle(request.id, status));
      return;
    }
    if (event.method === 'turn/started') { observeTurn(params.turn?.id); return; }
    if (event.method === 'turn/completed' && turnId && params.turn?.id === turnId) {
      if (completed) return;
      completed = params.turn;
      flushReply();
      polling.abort();
      completion = completeTurn(completed).catch(stop);
      return;
    }
    if (!turnId || params.turnId !== turnId) return;
    if (streamReply && event.method === 'item/agentMessage/delta') collectReply(params);
    if (event.method === 'thread/tokenUsage/updated') {
      const total = execUsage(params.tokenUsage?.total);
      if (history && !tokens) {
        const last = execUsage(params.tokenUsage?.last);
        priorTokens = Object.fromEntries(Object.entries(total).map(([key, count]) =>
          [key, Number.isSafeInteger(count) && Number.isSafeInteger(last[key]) ? count - last[key] : undefined]));
      }
      tokens = total;
    }
    if (event.method !== 'item/started' && event.method !== 'item/completed') return;
    if (thread.approvalsReviewer === 'user' && ['fileChange', 'commandExecution'].includes(params.item?.type)) {
      if (event.method === 'item/started') startedItems.set(params.item.id, params.item);
      else startedItems.delete(params.item.id);
    }
    const item = execItem(params.item);
    if (!item) return;
    if (item.type === 'agent_message' && event.method === 'item/completed' && typeof item.text === 'string') {
      lastMessage = item.text;
      if (['final_answer', 'finalAnswer'].includes(item.phase)) final = item.text;
    }
    record({ type: event.method.replace('/', '.'), item });
  }
  function closed() {
    exitSeen = true;
    clearTimeout(replyTimer);
    polling?.abort();
    for (const request of operatorRequests.values()) clearTimeout(request.timer);
    for (const reply of pending.values()) reply.reject(new Error('Codex app server disconnected'));
    pending.clear();
    return Promise.all([connection, processing, operatorUpdates, completion]);
  }
  return { receive, closed, start() {
    connection = connect().catch(stop);
  } };
}
