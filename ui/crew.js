const url = new URL(window.location.href);
const preview = document.querySelector('a[data-open-preview]');
if (preview) window.location.replace(preview.href);
if (document.querySelector('[data-epic-view]') && !url.searchParams.has('view')) {
  const legacyViews = { '#pipeline': 'workflow', '#handoff-details': 'workflow', '#qa-heading': 'checks' };
  const view = legacyViews[url.hash];
  if (view) {
    url.searchParams.set('view', view);
    window.location.replace(url);
  }
}
if (url.hash.startsWith('#check-')) {
  const check = document.getElementById(url.hash.slice(1));
  if (check instanceof HTMLDetailsElement) check.open = true;
}
const exactPrompt = document.querySelector('.agents-page details#exact-input');
const codexCommand = document.querySelector('.agents-page details#codex-command');
if (exactPrompt || codexCommand) {
  function revealPrompt() {
    if (window.location.hash === '#call-input' && codexCommand) codexCommand.open = true;
    if (window.location.hash !== '#exact-input' || !exactPrompt) return;
    exactPrompt.open = true;
    exactPrompt.querySelector(':scope > summary')?.focus({ preventScroll: true });
    exactPrompt.scrollIntoView({ block: 'start' });
  }
  revealPrompt();
  window.addEventListener('hashchange', revealPrompt);
}
if (document.querySelector('.diff-page')) {
  const revealFile = hash => {
    if (!/^#diff-file-\d+$/.test(hash)) return;
    const file = document.getElementById(hash.slice(1));
    if (!(file instanceof HTMLDetailsElement)) return;
    file.open = true;
    file.querySelector('summary')?.focus({ preventScroll: true });
    file.scrollIntoView({ block: 'start' });
  };
  revealFile(url.hash);
  window.addEventListener('hashchange', () => revealFile(window.location.hash));
  document.addEventListener('click', event => {
    const href = event.target.closest('a')?.getAttribute('href');
    if (href && href === window.location.hash) revealFile(href);
  });
}

const date = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const preciseDate = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
function localizeTimes(root) {
  for (const timestamp of root.querySelectorAll('time[data-local]')) {
    const value = new Date(timestamp.dateTime);
    if (!Number.isNaN(value.valueOf())) {
      timestamp.textContent = (timestamp.hasAttribute('data-precise') ? preciseDate : date).format(value);
    }
  }
}
localizeTimes(document);

function updateElapsedTimes(clocks) {
  const now = Date.now();
  for (const clock of clocks) {
    const startedAt = Date.parse(clock.dataset.elapsedFrom);
    if (!Number.isFinite(startedAt)) continue;
    const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
    const minutes = Math.floor(seconds / 60);
    const label = minutes ? minutes + 'm ' + String(seconds % 60).padStart(2, '0') + 's' : seconds + 's';
    clock.textContent = label;
    clock.dateTime = 'PT' + seconds + 'S';
  }
}

function replaceLiveSection(section, next, afterReplace) {
  const focused = section.contains(document.activeElement) ? document.activeElement : null;
  const identified = focused?.closest('[id]');
  const scope = focused && (identified && section.contains(identified) ? identified : section);
  const nextScope = scope === section ? next : scope && next.querySelector('#' + CSS.escape(scope.id));
  if (section instanceof HTMLDetailsElement && next instanceof HTMLDetailsElement) next.open = section.open;
  for (const detail of section.querySelectorAll('details[id]')) {
    const replacement = next.querySelector('#' + CSS.escape(detail.id));
    if (replacement instanceof HTMLDetailsElement) replacement.open = detail.open;
  }
  localizeTimes(next);
  section.replaceWith(next);
  afterReplace?.();
  if (!nextScope) return;

  let nextFocus;
  if (focused === scope) nextFocus = nextScope;
  else if (focused.matches('summary')) nextFocus = nextScope.querySelector(':scope > summary');
  else if (focused.matches('a[href]')) {
    nextFocus = [...nextScope.querySelectorAll('a[href]')].find(link => link.getAttribute('href') === focused.getAttribute('href'));
  } else if (focused.matches('button')) {
    nextFocus = [...nextScope.querySelectorAll('button')].find(button => button.textContent === focused.textContent);
  }
  (nextFocus ?? nextScope.querySelector(':scope > summary'))?.focus({ preventScroll: true });
}

if (document.body?.dataset.liveRun) {
  let timer;
  let pending = false;
  const editing = () => document.querySelector('main form[data-live-draft]') ||
    document.activeElement?.matches('main input, main textarea, main select');

  function scheduleRunRefresh() {
    clearTimeout(timer);
    if (!document.hidden && document.body.dataset.liveRun) timer = setTimeout(refreshRun, 3_000);
  }

  async function refreshRun() {
    if (pending || document.hidden || editing()) return scheduleRunRefresh();
    pending = true;
    try {
      const response = await fetch(window.location.href, { cache: 'no-store', signal: AbortSignal.timeout(10_000) });
      if (!response.ok || document.hidden || editing()) return;
      const page = new DOMParser().parseFromString(await response.text(), 'text/html');
      const next = page.querySelector('main');
      const current = document.querySelector('main');
      const version = page.body.dataset.liveRun;
      if (!next || !current || editing() || document.hidden || version === document.body.dataset.liveRun) return;
      replaceLiveSection(current, next);
      if (version) document.body.dataset.liveRun = version;
      else delete document.body.dataset.liveRun;
    } catch {
      // The next poll can recover from a transient network error.
    } finally {
      pending = false;
      scheduleRunRefresh();
    }
  }

  document.addEventListener('input', event => {
    if (event.target.matches?.('.codex-choice input')) {
      const question = event.target.closest('.codex-question');
      const answer = question.querySelector('.codex-other-answer textarea');
      if (answer) answer.required = Boolean(question.querySelector('.codex-other:checked'));
    }
    const form = event.target.closest?.('main form[method="post"]');
    if (form) form.dataset.liveDraft = 'true';
  });
  document.addEventListener('reset', event => {
    delete event.target.dataset.liveDraft;
  });
  document.addEventListener('visibilitychange', scheduleRunRefresh);
  scheduleRunRefresh();
}

document.addEventListener('keydown', event => {
  if (event.defaultPrevented || event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey ||
    event.target.closest?.('input, textarea, select, [contenteditable]')) return;
  const search = document.querySelector('[data-search]');
  if (!search) return;
  event.preventDefault();
  search.focus();
});

const monitor = document.querySelector('[data-feature-monitor]');
if (monitor) {
  const dialog = monitor.querySelector('#workflow-inspector');
  const inspector = dialog && typeof dialog.showModal === 'function' ? connectWorkflowInspector(dialog) : null;
  let workflow = null;
  let layoutMode = 'graph';
  try { if (window.localStorage.getItem('crew.workflow.layout') === 'list') layoutMode = 'list'; } catch {}
  let disconnectGraph;
  function initializeWorkflow() {
    disconnectGraph?.();
    workflow = monitor.querySelector('#workflow');
    inspector?.configure(workflow);
    const control = workflow?.querySelector('.workflow-switch');
    if (!control) return;
    workflow.dataset.layout = layoutMode;
    control.hidden = false;
    for (const choice of control.querySelectorAll('button')) {
      choice.setAttribute('aria-pressed', String(choice.dataset.workflowLayout === layoutMode));
    }
    for (const level of workflow.querySelectorAll('.workflow-branches')) {
      for (const step of level.querySelectorAll(':scope > details')) {
        if (layoutMode === 'graph') step.setAttribute('name', 'crew-graph-level-' + level.dataset.level);
        else step.removeAttribute('name');
      }
    }
    if (layoutMode === 'graph') disconnectGraph = connectWorkflowGraph(workflow.querySelector('.workflow-canvas'), monitor);
    else disconnectGraph = null;
  }
  initializeWorkflow();
  const button = monitor.querySelector('[data-toggle-live]');
  const message = monitor.querySelector('[data-live-message]');
  const trace = monitor.querySelector('[data-live-append]');
  const filters = monitor.querySelector('[data-trace-filter]');
  let allEvents = url.searchParams.get('events') === 'all';
  let pendingHash = '';
  function filterEvents() {
    if (!trace) return;
    for (const row of trace.children) row.hidden = !allEvents && !row.hasAttribute('data-milestone');
    filters.querySelector('input[value="all"]').checked = allEvents;
    filters.querySelector('input[value="milestones"]').checked = !allEvents;
  }
  function revealTarget(hash, scroll = false, opener = null) {
    const target = document.getElementById(hash === '#stage-details' ? 'workflow' : hash.slice(1));
    pendingHash = target ? '' : hash;
    if (inspector) {
      const step = inspector.stepFor(target);
      if (step) {
        inspector.select(step, { align: scroll && opener !== step.querySelector(':scope > summary'), opener });
        if (step === target) return;
      } else inspector.close(false);
    }
    if (!target) return;
    const row = target.closest('.trace-event');
    if (row?.hidden) {
      allEvents = true;
      filterEvents();
    }
    if (row === target) {
      const comparison = row.querySelector('details[data-probe-evidence]');
      if (comparison) comparison.open = true;
    }
    for (let detail = target.closest('details'); detail; detail = detail.parentElement?.closest('details')) {
      detail.open = true;
    }
    if (scroll) {
      const focusTarget = target instanceof HTMLDetailsElement ? target.querySelector(':scope > summary') : target;
      focusTarget?.focus({ preventScroll: true });
      target.scrollIntoView({ block: 'start' });
    }
  }
  if (filters) {
    filters.hidden = false;
    filterEvents();
    const journal = trace.closest('details');
    if (allEvents && journal) journal.open = true;
    filters.addEventListener('change', event => {
      allEvents = event.target.value === 'all';
      const next = new URL(window.location.href);
      if (allEvents) next.searchParams.set('events', 'all');
      else {
        next.searchParams.delete('events');
        const row = document.getElementById(next.hash.slice(1))?.closest('.trace-event');
        if (row && !row.hasAttribute('data-milestone')) next.hash = '';
      }
      history.replaceState(null, '', next);
      filterEvents();
    });
  }
  if (url.hash) {
    revealTarget(url.hash, true);
    // A reload can restore an old scroll offset after the disclosures open.
    window.addEventListener('pageshow', event => {
      if (!event.persisted && window.location.hash === url.hash) requestAnimationFrame(() => revealTarget(url.hash, true));
    }, { once: true });
  }
  window.addEventListener('hashchange', () => {
    allEvents = new URL(window.location.href).searchParams.get('events') === 'all';
    filterEvents();
    revealTarget(window.location.hash, true);
  });
  monitor.addEventListener('click', event => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button > 0) return;
    const choice = event.target.closest('[data-workflow-layout]');
    if (choice && choice.dataset.workflowLayout !== layoutMode) {
      layoutMode = choice.dataset.workflowLayout;
      try { window.localStorage.setItem('crew.workflow.layout', layoutMode); } catch {}
      initializeWorkflow();
      // Keep the linked stage expanded if this layout groups open siblings.
      if (window.location.hash.startsWith('#stage-')) revealTarget(window.location.hash);
      return;
    }
    const step = event.target.closest('summary')?.parentElement;
    if (step?.matches('details.workflow-step[id]') && inspector) {
      event.preventDefault();
      if (inspector.selected === step) {
        const next = new URL(window.location.href);
        next.hash = 'workflow';
        history.replaceState(null, '', next);
        inspector.close(true);
      } else {
        const next = new URL(window.location.href);
        next.hash = step.id;
        if (next.hash !== window.location.hash) history.pushState(null, '', next);
        revealTarget(next.hash, true, step.querySelector(':scope > summary'));
      }
      return;
    } else if (step?.matches('details.workflow-step[id]')) {
      const next = new URL(window.location.href);
      if (!step.open) next.hash = step.id;
      else if (next.hash === '#' + step.id) next.hash = 'workflow';
      history.replaceState(null, '', next);
    }
    const anchor = event.target.closest('a');
    const href = anchor?.getAttribute('href');
    if (href?.startsWith('#')) {
      if (inspector && (inspector.selected || inspector.stepFor(document.getElementById(href.slice(1))))) {
        event.preventDefault();
        if (href !== window.location.hash) history.pushState(null, '', href);
        revealTarget(href, true, anchor);
      } else revealTarget(href, href === window.location.hash);
    }
  });
  let timer, clockTimer;
  let paused = false;
  let pending = false;
  const terminal = () => trace?.dataset.terminal === 'true';

  function schedule() {
    clearTimeout(timer);
    clearInterval(clockTimer);
    if (paused || terminal() || document.hidden) return;
    timer = setTimeout(refresh, 3000);
    const clocks = monitor.querySelectorAll('time[data-elapsed-from]');
    if (clocks.length) {
      updateElapsedTimes(clocks);
      clockTimer = setInterval(() => updateElapsedTimes(clocks), 1000);
    }
  }

  async function refresh() {
    if (pending || paused || document.hidden || terminal()) return;
    pending = true;
    try {
      const response = await fetch(window.location.href, { cache: 'no-store', signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error();
      const page = new DOMParser().parseFromString(await response.text(), 'text/html');
      if (!page.querySelector('[data-feature-monitor]')) throw new Error();
      if (paused || document.hidden) return;
      let announcement = '';
      for (const section of monitor.querySelectorAll('[data-live-section]')) {
        const next = page.getElementById(section.id);
        if (!next || next.dataset.liveVersion === section.dataset.liveVersion) continue;
        replaceLiveSection(section, next, () => {
          if (monitor.querySelector('#workflow') !== workflow) initializeWorkflow();
        });
        announcement = next.dataset.announcement;
      }
      if (trace) {
        const next = page.getElementById(trace.id);
        for (const event of next.children) {
          if (document.getElementById(event.id)) continue;
          localizeTimes(event);
          event.hidden = !allEvents && !event.hasAttribute('data-milestone');
          trace.append(event.cloneNode(true));
        }
        trace.dataset.terminal = next.dataset.terminal;
        if (trace.children.length) monitor.querySelector('[data-no-events]')?.remove();
      }
      if (pendingHash && pendingHash === window.location.hash && document.getElementById(pendingHash.slice(1))) {
        revealTarget(pendingHash, true);
      }
      if (announcement) message.textContent = announcement;
      else if (message.dataset.interrupted) message.textContent = 'Live';
      delete message.dataset.interrupted;
      button.hidden = terminal();
    } catch {
      if (!paused && !message.dataset.interrupted) {
        message.dataset.interrupted = 'true';
        message.textContent = 'Live updates interrupted. Reconnecting…';
      }
    } finally {
      pending = false;
      schedule();
    }
  }

  if (!terminal()) {
    button.hidden = false;
    message.textContent = 'Live';
    button.addEventListener('click', () => {
      paused = !paused;
      button.textContent = paused ? 'Resume live updates' : 'Pause live updates';
      message.textContent = paused ? 'Updates paused' : 'Live';
      if (!paused) refresh();
      schedule();
    });
    document.addEventListener('visibilitychange', schedule);
    schedule();
  }
}
{
  const workflow = document.querySelector('#request-workflow');
  const setup = workflow?.form?.querySelector('[data-request-run-setup]');
  if (setup) workflow.addEventListener('change', () => {
    const href = workflow.selectedOptions[0]?.dataset.runSetup;
    setup.hidden = !href;
    if (href) setup.href = href;
    else setup.removeAttribute('href');
  });
  const imageInputs = workflow?.form?.querySelector('[data-request-image-inputs]');
  if (imageInputs) workflow.addEventListener('change', () => {
    const steps = JSON.parse(workflow.selectedOptions[0]?.dataset.requestImageSteps ?? '[]');
    imageInputs.querySelector('input[type="file"]').value = '';
    imageInputs.querySelector('[data-request-image-steps]').replaceChildren(...steps.map(title => {
      const entry = document.createElement('li');
      entry.textContent = title;
      return entry;
    }));
    imageInputs.disabled = imageInputs.hidden = steps.length === 0;
  });
}

{
  let setup = document.querySelector('[data-workflow-setup-results]');
  let timer, pending = false;
  const poll = async () => {
    if (pending || document.hidden) return;
    pending = true;
    try {
      const response = await fetch(location.href, { cache: 'no-store', signal: AbortSignal.timeout(8_000) });
      if (!response.ok) return;
      const page = new DOMParser().parseFromString(await response.text(), 'text/html');
      const next = page.querySelector('[data-workflow-setup-results]');
      if (!next || setup.dataset.state === next.dataset.state) return;
      localizeTimes(next);
      setup.replaceWith(next);
      setup = next;
    } catch {} finally { pending = false; schedule(); }
  };
  function schedule() {
    clearTimeout(timer);
    if (!pending && setup?.hasAttribute('data-setup-pending') && !document.hidden) timer = setTimeout(poll, 2000);
  }
  if (setup) {
    document.addEventListener('visibilitychange', schedule);
    schedule();
  }
}
