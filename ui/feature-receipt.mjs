import { escape } from './views.mjs';
import { duration, visibleModel } from './feature-usage.mjs';
import { featureRole, featureTaskAction } from './feature-language.mjs';

const numbers = new Intl.NumberFormat('en-US');
const utc = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'medium' });
const known = value => Number.isSafeInteger(value) && value >= 0;
const modelReporters = new Map([
  ['codex-response', 'Codex · response model'], ['codex-json', 'Codex event stream'],
  ['codex-otel', 'Codex OpenTelemetry'], ['codex-hook', 'Codex hook'],
]);

function field(title, html) {
  return html ? `<div><dt>${title}</dt><dd>${html}</dd></div>` : '';
}

function timestamp(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return '';
  const iso = new Date(value).toISOString();
  return `<time data-local data-precise datetime="${iso}" title="${iso}">${utc.format(new Date(iso))} UTC</time>`;
}

function tokens(value, subset, subsetName) {
  if (!known(value) && !known(subset)) return '';
  const total = known(value) ? numbers.format(value) : 'Unreported';
  return total + (known(subset) ? ` <span class="receipt-subset">(${numbers.format(subset)} ${subsetName})</span>` : '');
}

export function receiptMetrics(call) {
  if (!call) return '';
  const usage = call.usage ?? {};
  const model = visibleModel(call);
  const input = tokens(usage.input, usage.cached, 'cached');
  const output = tokens(usage.output, usage.reasoning, 'reasoning');
  const fields = [
    field('Run by', escape(featureRole(call.role))),
    field('Action', escape(featureTaskAction(call))),
    field(model.source === 'Requested' ? 'Requested model' : 'Model', escape(model.name) +
      (model.source === 'Reported by Codex' ? ' <span class="receipt-subset">(reported by Codex)</span>' : '')),
    field('Model evidence', call.modelSource === 'reported' ? modelReporters.get(call.reportedModelSource) : ''),
    field('Requested model', call.modelSource === 'reported' && call.requestedModel && call.requestedModel !== model.name ? escape(call.requestedModel) : ''),
    field('Selection', call.modelSelection === 'catalog-default' ? 'Codex catalog default' : ''),
    field('Duration', known(call.durationMs) ? duration(call.durationMs) : ''),
    field('Started', timestamp(call.startedAt)),
    field('Finished', timestamp(call.endedAt)),
    field('Input tokens', input),
    field('Output tokens', output),
    field('Total tokens', known(usage.total) ? numbers.format(usage.total) : !input && !output ? 'Unreported' : ''),
  ];
  return `<dl class="receipt-metrics" aria-label="Codex call receipt">${fields.join('')}</dl>`;
}
