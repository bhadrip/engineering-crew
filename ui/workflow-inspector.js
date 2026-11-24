// Move the recorded content into the inspector so permalinks and evidence IDs
// keep pointing to the same elements in both layouts.
function connectWorkflowInspector(dialog) {
  const title = dialog.querySelector('#inspector-title');
  const context = dialog.querySelector('[data-inspector-context]');
  const performer = dialog.querySelector('[data-inspector-performer]');
  const status = dialog.querySelector('[data-inspector-status]');
  const slot = dialog.querySelector('[data-inspector-body]');
  const scroller = dialog.querySelector('[data-inspector-scroll]') ?? slot;
  const desktop = window.matchMedia('(min-width: 840px)');
  let selected, content, trigger;

  function clearSelection() {
    if (!selected) return;
    selected.removeAttribute('data-selected');
    const summary = selected.querySelector(':scope > summary');
    summary.setAttribute('aria-expanded', 'false');
    summary.removeAttribute('aria-current');
  }

  function setSelection(step, body) {
    selected = step;
    content = body;
    step.open = false;
    step.dataset.selected = 'true';
    const summary = step.querySelector(':scope > summary');
    summary.setAttribute('aria-expanded', 'true');
    summary.setAttribute('aria-current', 'step');
    title.textContent = step.dataset.stepTitle;
    context.textContent = step.dataset.stepContext || '';
    context.hidden = !context.textContent;
    performer.textContent = step.dataset.stepRole;
    status.textContent = step.dataset.stepResult;
    dialog.dataset.tone = step.dataset.tone;
  }

  function show() {
    if (desktop.matches) dialog.show();
    else dialog.showModal();
  }

  function close(restoreFocus) {
    if (!selected) return;
    const summary = selected.querySelector(':scope > summary');
    const returnTo = trigger?.isConnected ? trigger : summary.isConnected ? summary : document.getElementById('workflow');
    clearSelection();
    selected.append(content);
    selected = content = trigger = null;
    dialog.close();
    document.body.removeAttribute('data-inspecting-workflow');
    if (restoreFocus) returnTo?.focus({ preventScroll: true });
  }

  function backToWorkflow() {
    const next = new URL(window.location.href);
    next.hash = 'workflow';
    history.replaceState(null, '', next);
    close(true);
  }

  function keepNodeInView(step) {
    const summary = step.querySelector(':scope > summary');
    const box = summary.getBoundingClientRect();
    if (box.top < 32 || box.bottom > window.innerHeight - 32) {
      summary.scrollIntoView({ block: 'center', inline: 'nearest' });
    }
  }

  function select(step, { align, opener } = {}) {
    if (step === selected) {
      if (align) keepNodeInView(step);
      return;
    }
    if (selected) {
      clearSelection();
      selected.append(content);
    }
    // An inspector link moves with its body. Restore focus to the newly
    // selected map node when the operator follows such a link, then closes.
    trigger = opener && !opener.closest('.workflow-body') ? opener : step.querySelector(':scope > summary');
    setSelection(step, step.querySelector(':scope > .workflow-body'));
    slot.append(content);
    document.body.dataset.inspectingWorkflow = 'true';
    if (!dialog.open) show();
    if (align) keepNodeInView(step);
    scroller.scrollTop = 0;
    title.focus({ preventScroll: true });
  }

  function configure(workflow) {
    for (const summary of workflow?.querySelectorAll('.workflow-step > summary') ?? []) {
      summary.setAttribute('aria-haspopup', 'dialog');
      summary.setAttribute('aria-controls', dialog.id);
      summary.setAttribute('aria-expanded', 'false');
    }
    if (!selected) return;
    const fresh = workflow?.querySelector('#' + CSS.escape(selected.id));
    if (fresh === selected) {
      fresh.querySelector(':scope > summary').setAttribute('aria-expanded', 'true');
      return;
    }
    if (!fresh) { backToWorkflow(); return; }
    const newBody = fresh.querySelector(':scope > .workflow-body');
    const offset = scroller.scrollTop;
    clearSelection();
    // Reconcile nested disclosures and keyboard focus inside the persistent dock.
    replaceLiveSection(content, newBody);
    setSelection(fresh, newBody);
    scroller.scrollTop = offset;
  }

  function stepFor(target) {
    if (!target) return null;
    return content?.contains(target) ? selected : target.closest('details.workflow-step[id]');
  }

  dialog.querySelector('[data-inspector-close]').addEventListener('click', backToWorkflow);
  dialog.addEventListener('cancel', event => {
    event.preventDefault();
    backToWorkflow();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && selected && !event.defaultPrevented) {
      event.preventDefault();
      backToWorkflow();
    }
  });
  dialog.addEventListener('click', event => {
    if (event.target !== dialog || desktop.matches) return;
    const box = dialog.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) backToWorkflow();
  });
  desktop.addEventListener('change', () => {
    if (!selected) return;
    const focused = document.activeElement;
    const offset = scroller.scrollTop;
    dialog.close();
    show();
    (dialog.contains(focused) ? focused : title).focus({ preventScroll: true });
    scroller.scrollTop = offset;
  });
  return { select, close, configure, stepFor, get selected() { return selected; } };
}
