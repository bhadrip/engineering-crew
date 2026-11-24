import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const client = await readFile(new URL('../ui/crew.js', import.meta.url), 'utf8');

class Disclosure {
  constructor(id, open = false) {
    this.id = id;
    this.open = open;
    this.summary = {
      closest: () => this,
      matches: selector => selector === 'summary',
      focus(options) { this.focusedWithoutScrolling = options.preventScroll; },
    };
  }
  querySelector(selector) { return selector === ':scope > summary' ? this.summary : null; }
  closest(selector) { return selector === 'details' ? this : null; }
  scrollIntoView() { this.scrolled = true; }
}

// Supply the controls shared by the server-rendered monitor. Each case adds
// just the DOM nodes and server response that its operator interaction needs.
function start({ hash = '', elements = new Map(), filters, trace, section, nextSection, clock, focused, exactPrompt, inspector }) {
  const control = { addEventListener() {} };
  const handlers = {};
  const location = new URL('http://localhost/request' + hash);
  const monitor = {
    addEventListener(name, callback) { handlers[name] = callback; },
    querySelector: selector => ({
      '[data-trace-filter]': filters, '[data-live-append]': trace,
      '[data-toggle-live]': control, '[data-live-message]': { dataset: {} },
      '#workflow-inspector': inspector && { showModal() {} },
    })[selector],
    querySelectorAll: selector => selector === '[data-live-section]' && section ? [section]
      : selector === 'time[data-elapsed-from]' && clock ? [clock] : [],
  };
  const document = {
    activeElement: focused,
    addEventListener() {},
    getElementById: id => elements.get(id),
    querySelector: selector => selector === '[data-feature-monitor]' ? monitor : selector === '.agents-page details#exact-input' ? exactPrompt : null,
    querySelectorAll: () => [],
  };
  const scheduled = {};
  let now = Date.parse('2026-11-24T12:00:00Z');
  const nextPage = { querySelector: () => monitor, getElementById: () => nextSection };
  runInNewContext(client, {
    document, window: { location, addEventListener() {} },
    connectWorkflowInspector: () => inspector,
    history: {
      replaceState(_state, _title, next) { location.href = new URL(next, location); },
      pushState(_state, _title, next) { location.href = new URL(next, location); },
    },
    URL, Intl, CSS: { escape: text => text }, HTMLDetailsElement: Disclosure, AbortSignal,
    Date: class extends Date { static now() { return now; } },
    setTimeout: callback => { scheduled.refresh = callback; },
    setInterval: callback => { scheduled.tick = callback; },
    clearTimeout() {}, clearInterval() {},
    fetch: async () => ({ ok: true, text: async () => '<main></main>' }),
    DOMParser: class { parseFromString() { return nextPage; } },
  });
  return { scheduled, handlers, location, advance: ms => { now += ms; } };
}

test('only an exact input permalink opens and focuses the saved prompt', () => {
  const prompt = new Disclosure('exact-input');
  start({ exactPrompt: prompt });
  assert.equal(prompt.open, false);
  start({ exactPrompt: prompt, hash:'#agent-output' });
  assert.equal(prompt.open, false);
  start({ exactPrompt: prompt, hash:'#exact-input' });
  assert.equal(prompt.open, true);
  assert.equal(prompt.summary.focusedWithoutScrolling, true);
  assert.equal(prompt.scrolled, true);
});

test('opening and closing an inline step keeps the address on that step or its workflow', () => {
  const { handlers, location } = start({});
  const step = { id: 'stage-planning', open: false, matches: selector => selector === 'details.workflow-step[id]' };
  const target = { closest: selector => selector === 'summary' ? { parentElement: step } : null };
  handlers.click({target});
  assert.equal(location.hash, '#stage-planning');
  step.open = true;
  handlers.click({target});
  assert.equal(location.hash, '#workflow');
});

test('a stage link opens its inspector and a receipt link leaves it for the requested evidence', () => {
  const stage = new Disclosure('stage-qa-2');
  const receipt = new Disclosure('evidence-42');
  const inspector = {
    configure() {},
    stepFor: target => target === stage ? stage : null,
    select(step) { this.selected = step; },
    close() { this.selected = null; },
  };
  const elements = new Map([[stage.id,stage], [receipt.id,receipt]]);
  const { handlers, location } = start({ hash:'#' + stage.id, elements, inspector });
  assert.equal(inspector.selected, stage);
  assert.equal(stage.open, false);
  const anchor = { getAttribute: () => '#' + receipt.id };
  const click = { target: { closest: selector => selector === 'a' ? anchor : null },
    preventDefault() { this.prevented = true; } };
  handlers.click(click);
  assert.equal(click.prevented, true);
  assert.equal(inspector.selected, null);
  assert.equal(location.hash, '#' + receipt.id);
  assert.equal(receipt.open, true);
  assert.equal(receipt.summary.focusedWithoutScrolling, true);
});

test('a direct link to a tool receipt reveals its journal, event filter and nested disclosure', () => {
  const journal = new Disclosure('technical-journal');
  const record = new Disclosure('evidence-42');
  const row = { hasAttribute: () => false, closest: selector => selector === 'details' ? journal : null };
  record.parentElement = row;
  record.closest = selector => selector === '.trace-event' ? row : record;
  const all = {}, milestones = {};
  const filters = { addEventListener() {}, querySelector: selector => selector.includes('"all"') ? all : milestones };
  const trace = { dataset: { terminal: 'true' }, children: [row], closest: () => journal };

  start({ hash: '#evidence-42', elements: new Map([[record.id, record]]), filters, trace });

  assert.equal(all.checked, true);
  assert.equal(milestones.checked, false);
  assert.equal(row.hidden, false);
  assert.equal(journal.open, true);
  assert.equal(record.open, true);
  assert.equal(record.summary.focusedWithoutScrolling, true);
  assert.equal(record.scrolled, true);
});

test('a live refresh keeps both expanded and collapsed stages and returns keyboard focus to the same control', async () => {
  const planning = new Disclosure('stage-planning', true);
  const files = new Disclosure('planning-files', false);
  const section = new Disclosure('journey', true);
  section.dataset = { liveVersion: '1' };
  section.querySelectorAll = selector => selector === 'details[id]' ? [planning, files] : [];
  section.contains = target => target === files || target === files.summary;
  section.replaceWith = next => { section.replacement = next; };

  const updatedPlanning = new Disclosure(planning.id, false);
  const updatedFiles = new Disclosure(files.id, true);
  const nextSection = new Disclosure(section.id, false);
  nextSection.dataset = { liveVersion: '2', announcement: 'Implementation started' };
  nextSection.querySelectorAll = () => [];
  nextSection.querySelector = selector => [updatedPlanning, updatedFiles].find(d => '#' + d.id === selector);

  const { scheduled } = start({ section, nextSection, focused: files.summary });
  await scheduled.refresh();

  assert.equal(section.replacement, nextSection);
  assert.equal(nextSection.open, true);
  assert.equal(updatedPlanning.open, true);
  assert.equal(updatedFiles.open, false);
  assert.equal(updatedFiles.summary.focusedWithoutScrolling, true);
});

test('the elapsed clock advances between refreshes and exposes a machine-readable duration', () => {
  const clock = { dataset: { elapsedFrom: '2026-11-24T11:59:01Z' } };
  const { scheduled, advance } = start({ clock });
  assert.equal(clock.textContent, '59s');
  advance(2000);
  scheduled.tick();
  assert.equal(clock.textContent, '1m 01s');
  assert.equal(clock.dateTime, 'PT61S');
});

test('a live handoff with a fragment updates in place at completion', async () => {
  const location = new URL('http://localhost/run?view=workflow&step=one#handoff-details');
  const body = { dataset: { liveRun: 'working' } };
  const draft = { dataset: {} };
  let requested, refresh, replacement;
  const terminal = { querySelectorAll: () => [] };
  const current = { contains: () => false, querySelectorAll: () => [], replaceWith: next => { replacement = next; } };
  const listeners = new Map();
  runInNewContext(client, {
    document: {
      body,
      addEventListener: (name, callback) => listeners.set(name, callback),
      querySelector: selector => selector === 'main' ? current :
        selector === 'main form[data-live-draft]' && draft.dataset.liveDraft ? draft : null,
      querySelectorAll: () => [],
    },
    window: { location, addEventListener() {} }, Intl, URL, AbortSignal,
    HTMLDetailsElement: Disclosure,
    setTimeout: callback => { refresh = callback; }, clearTimeout() {},
    fetch: async url => { requested = url; return { ok: true, text: async () => '' }; },
    DOMParser: class { parseFromString() { return { querySelector: () => terminal, body: { dataset: {} } }; } },
  });
  listeners.get('input')({ target: { closest: () => draft } });
  await refresh();
  assert.equal(requested, undefined);
  listeners.get('reset')({ target: draft });
  await refresh();
  assert.equal(requested, location.href);
  assert.equal(location.hash, '#handoff-details');
  assert.equal(replacement, terminal);
  assert.equal(body.dataset.liveRun, undefined);
});
