import { escape } from './views.mjs';

const sentences = new Intl.Segmenter('en', { granularity: 'sentence' });
const visibleItems = 3;
const normalText = value => typeof value === 'string' ? value.trim() : '';

function entries(value) {
  return Array.isArray(value) ? value.map(normalText).filter(Boolean) : [];
}

// Use the planner's own words. A natural sentence or clause is more useful
// than a fixed character cut, especially when the next sentence specifies a limit.
function excerpt(text, limit) {
  const firstLine = text.split(/\r?\n/, 1)[0];
  const first = sentences.segment(firstLine)[Symbol.iterator]().next().value?.segment.trimEnd() ?? '';
  if (first.length <= limit) return { lead: first, rest: text.slice(first.length).trim() };

  const window = first.slice(0, limit + 1);
  const boundary = [...window.matchAll(/[;:]\s+|\s+[—–]\s+|,\s+(?=including\b|using\b|while\b|such as\b)/g)]
    .find(match => match.index >= 24);
  if (boundary) {
    const end = boundary.index;
    return { lead: first.slice(0, end) + '…', full: text };
  }
  const space = window.search(/\s+\S*$/);
  const end = space > 0 ? space : limit;
  return { lead: first.slice(0, end).trimEnd() + '…', full: text };
}

function count(number, singular, plural = singular + 's') {
  return number + ' ' + (number === 1 ? singular : plural);
}

export function planSynopsis(plan) {
  const text = normalText(typeof plan === 'string' ? plan : plan?.summary);
  if (text) return excerpt(text, 185).lead;
  const steps = entries(plan?.steps).length;
  const checks = entries(plan?.acceptance).length;
  return [steps && count(steps, 'implementation step'), checks && count(checks, 'planned check')].filter(Boolean).join(' and ');
}

function paragraphs(text) {
  return text.split(/\n\s*\n/).map(part => '<p class="plan-copy">' + escape(part) + '</p>').join('');
}

function planGroup(items, isSteps, prefix) {
  if (!items.length) return '';
  const label = isSteps ? 'Implementation steps' : 'Planned checks';
  const itemNoun = isSteps ? 'step' : 'check';
  const list = isSteps ? 'ol' : 'ul';
  const id = prefix + '-' + (isSteps ? 'steps' : 'checks');
  const listItems = (start, end) => items.slice(start, end).map((text, i) => {
    const { lead, rest, full } = excerpt(text, 105);
    const body = rest || full;
    return body
      ? `<li class="plan-item"><details id="${escape(id)}-${start + i + 1}"><summary>${escape(lead)}</summary>${paragraphs(body)}</details></li>`
      : `<li class="plan-item">${escape(lead)}</li>`;
  }).join('');
  const extra = items.length - visibleItems;
  const more = extra > 0 ? `<details class="plan-more" id="${escape(id)}-more"><summary>Show ${count(extra, 'more ' + itemNoun, 'more ' + itemNoun + 's')}</summary>
<${list} class="plan-items"${isSteps ? ` start="${visibleItems + 1}"` : ''}>${listItems(visibleItems)}</${list}></details>` : '';
  return `<section class="plan-group" aria-labelledby="${escape(id)}-title"><h4 class="plan-group-head" id="${escape(id)}-title">${label} <span class="plan-count">(${items.length})</span></h4>
<${list} class="plan-items">${listItems(0, visibleItems)}</${list}>${more}</section>`;
}

export function renderFeaturePlan(plan, { id = 'feature-plan', goal } = {}) {
  const intent = normalText(typeof plan === 'string' ? plan : plan?.summary);
  const steps = entries(plan?.steps);
  const checks = entries(plan?.acceptance);
  if (!intent && !steps.length && !checks.length) return '<p class="plan-unavailable">Planning details are unavailable for this record.</p>';
  const { lead, rest, full } = intent ? excerpt(intent, 185) : {};
  const extra = rest || full;
  const requestGoal = normalText(goal);
  const outcome = requestGoal ? excerpt(requestGoal, 155).lead : '';
  const goalText = outcome && outcome !== lead ? `<h3>Requested outcome</h3><p>${escape(outcome)}</p>` : '';
  const summary = intent ? `<div class="plan-intent">${goalText}<h3>Planned approach</h3><p>${escape(lead)}</p>
${extra ? `<details class="plan-continuation" id="${escape(id)}-summary"><summary>Full summary</summary>${paragraphs(extra)}</details>` : ''}</div>` : '';
  const groups = steps.length || checks.length ? `<div class="plan-groups">${planGroup(steps, true, id)}${planGroup(checks, false, id)}</div>` : '';
  return `<div class="feature-plan">${summary}${groups}</div>`;
}
