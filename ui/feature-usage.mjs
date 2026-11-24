import { escape } from './views.mjs';
import { buildName, featureRole } from './feature-language.mjs';
import { intervalMs, featureCalls, summarizeCalls } from '../lib/feature-usage.mjs';
import { verifiedFeatureTraceLink } from '../lib/feature-langfuse.mjs';

const number = new Intl.NumberFormat('en-US');
const n = value => value === null ? '—' : number.format(value);

export function duration(ms) {
  if (ms === null) return '—';
  if (ms < 1000) return ms + ' ms';
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  return m < 60 ? m + 'm ' + s % 60 + 's' : Math.floor(m / 60) + 'h ' + m % 60 + 'm';
}

const fmtTotal = usage => n(usage.total) + (usage.missingTotals && usage.total !== null ? ' (partial)' : '');
const fmtDuration = usage => duration(usage.durationMs) + (usage.missingTimes && usage.durationMs !== null ? ' (partial)' : '');

export function visibleModel(call) {
  const name = typeof call.model === 'string' && call.model.trim();
  if (!name || name === 'codex default') return { name: 'Unreported', source: '' };
  return { name, source: call.modelSource === 'reported' ? 'Reported by Codex' : 'Requested' };
}

function modelCell(call) {
  const { name, source } = visibleModel(call);
  return `<span class="usage-model-name">${escape(name)}</span>${source ? ` <small class="usage-model-source">${source}</small>` : ''}`;
}

function tokenCell(usage, calls, field) {
  return n(usage[field]) + (usage[field] !== null && calls.some(call => call.usage[field] === null) ? ' (partial)' : '');
}

export function elapsedTime(request) {
  const active = request.status === 'running' && !request.endedAt;
  const elapsed = intervalMs(request.startedAt, request.endedAt ?? (active ? new Date().toISOString() : null));
  return elapsed === null ? '—' : active ? `<time data-elapsed-from="${escape(request.startedAt)}">${duration(elapsed)}</time>` : duration(elapsed);
}

export function stageUsage(_stage, events) {
  const calls = featureCalls(events);
  if (!calls.length) return '';
  const usage = summarizeCalls(calls);
  const stats = [usage.total !== null ? fmtTotal(usage) + ' tokens' : 'Tokens unreported',
    usage.durationMs !== null && fmtDuration(usage) + ' of agent time', calls.length + (calls.length === 1 ? ' call' : ' calls')].filter(Boolean);
  return `<p class="stage-usage"><a href="#usage">${stats.map(escape).join(' · ')}</a></p>`;
}

function traceStatus(request, path, configured) {
  const url = verifiedFeatureTraceLink(request);
  if (url) return `<div class="trace-connection"><strong>Langfuse</strong><a href="${escape(url)}">Open verified trace ↗</a>
<p class="trace-destination">Published from completed Codex call receipts after this request ended. Local project <code>${escape(request.langfuseTrace.projectId)}</code> · Viewer uses your Langfuse sign-in.</p></div>`;
  if (request.langfuseExport?.status === 'pending') return '<p class="trace-connection"><strong>Langfuse</strong><span>Publishing and verifying call receipts…</span></p>';
  const ended = request.status === 'completed' || request.status === 'blocked';
  if (configured && ended && featureCalls(request.events ?? []).length) {
    const failed = request.langfuseExport?.status === 'failed';
    return `<form method="post" action="${escape(path)}/langfuse" class="trace-publish"><strong>Langfuse</strong><button type="submit" class="secondary">${failed ? 'Retry receipt export' : 'Publish receipt trace'}</button><p>${failed ? escape(request.langfuseExport.message || 'Crew could not verify the receipt trace.') : 'Sends call times, model names and token counts to your configured local project.'}</p></form>`;
  }
  if (configured) return '<p class="trace-connection"><strong>Langfuse</strong><span>Export is available after a request ends with a recorded Codex call.</span></p>';
  return `<details id="langfuse-setup" class="trace-setup"><summary><strong>Langfuse</strong><span>Not connected · Setup</span></summary>
<p>Start your local Langfuse project and set these variables when starting Crew.</p>
<dl><div><dt><code>CREW_LANGFUSE_URL</code></dt><dd>Local HTTP origin, for example <code>http://127.0.0.1:3312</code></dd></div>
<div><dt><code>CREW_LANGFUSE_PROJECT_ID</code></dt><dd>Your Langfuse project ID</dd></div>
<div><dt><code>CREW_LANGFUSE_CREDENTIALS_FILE</code></dt><dd>Absolute path to a private JSON file outside the checkout with <code>public_key</code> and <code>secret_key</code>, mode <code>0600</code></dd></div></dl>
<p>Then choose <strong>Publish receipt trace</strong> here. Crew verifies the trace in that project before showing its link.</p></details>`;
}

export function featureUsage(request, path, configured) {
  const calls = featureCalls(request.events ?? []);
  const total = summarizeCalls(calls);
  const groups = Map.groupBy(calls, call => {
    const { name, source } = visibleModel(call);
    return JSON.stringify([call.role, name, source]);
  });
  const callsBySeq = new Map(calls.map(call => [call.seq, call]));
  const pendingByTask = new Map();
  for (const event of request.events ?? []) {
    const key = JSON.stringify([event.role, event.operationId, event.attempt]);
    if (event.type === 'agent.started') pendingByTask.set(key, (pendingByTask.get(key) ?? 0) + 1);
    else if (callsBySeq.has(event.seq) && pendingByTask.get(key) > 0) pendingByTask.set(key, pendingByTask.get(key) - 1);
  }
  const incomplete = [...pendingByTask.values()].reduce((a,b) => a+b, 0);
  const table = calls.length ? `<div class="usage-table-scroll"><table class="role-usage"><caption class="visually-hidden">Usage by agent and model for completed Codex calls</caption>
<thead><tr><th>Agent</th><th>Model</th><th>Calls</th><th>Input</th><th>Output</th><th>Agent time</th></tr></thead><tbody>${[...groups.values()].map(group => {
    const u = summarizeCalls(group);
    const call = group[0];
    return `<tr><th scope="row" class="usage-agent" data-label="Agent">${escape(featureRole(call.role))}</th><td class="usage-model" data-label="Model">${modelCell(call)}</td><td class="usage-calls" data-label="Calls">${group.length}</td><td class="usage-input" data-label="Input">${tokenCell(u, group, 'input')}</td><td class="usage-output" data-label="Output">${tokenCell(u, group, 'output')}</td><td class="usage-time" data-label="Agent time">${fmtDuration(u)}</td></tr>`;
  }).join('')}</tbody></table></div>
<p class="usage-note">Agent time adds up completed calls, including calls that overlapped. Elapsed time runs from start to stop.${incomplete ? ' ' + incomplete + (incomplete === 1 ? ' call started without a completed receipt.' : ' calls started without completed receipts.') : ''}${total.missingTotals ? ' Some calls have no reported token total.' : ''}</p>
<details id="call-receipts" class="call-receipts"><summary>Individual calls (${calls.length})</summary><ol>${calls.map(c => `<li><a href="#event-${escape(c.seq)}">${escape(featureRole(c.role))}${c.attempt ? ' · ' + escape(buildName(c.attempt)) : ''} · #${escape(c.seq)}</a><span>${modelCell(c)} · ${n(c.usage.total)} tokens · ${duration(c.durationMs)}</span></li>`).join('')}</ol>
<p class="usage-note">${n(total.cached)} cached input · ${n(total.reasoning)} reasoning output. Both are already included in the totals.</p></details>
<details id="measurement-source" class="metric-source"><summary>How Crew measures usage</summary>
<p>Codex reports input and output tokens when a turn completes. Crew measures time from launch to answer, including model wait and local processing.</p>
<p>Reported models come from the Codex response or event stream. “Requested” is the model Crew passed to Codex. Older calls that used an unnamed default display “Unreported” when their receipt has no model name.</p></details>`
    : '<p class="usage-note">Usage appears when Codex returns a receipt for a completed call.</p>';
  return `<details class="usage-disclosure" id="usage"><summary><span class="disclosure-title">Time &amp; tokens</span>
<span class="usage-glance"><span>${elapsedTime(request)} elapsed</span>${total.total !== null ? `<span>${fmtTotal(total)} reported tokens</span>` : ''}</span></summary>
<div class="usage-body">${table}${traceStatus(request, path, configured)}</div></details>`;
}
