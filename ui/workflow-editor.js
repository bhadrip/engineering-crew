{
  const form = document.querySelector('[data-config-workflow]');
  const preview = form?.querySelector('[data-config-preview]');
  const cards = [...(form?.querySelectorAll('[data-config-step]') ?? [])];
  const byId = new Map(cards.map(card => [card.dataset.configStep, card]));
  const graph = preview?.hasAttribute('data-dependency-graph') ? workflowDependencyEditor(preview, byId) : null;

  function renderDependencies() {
    const steps = new Map(cards.map(card => {
      const id = card.dataset.configStep;
      const agent = card.querySelector('select[name$=".agent"]').selectedOptions[0];
      return [id, { title: card.querySelector('[data-config-step-title]').textContent,
        ...(agent?.value && { agent: agent.textContent.trim() }),
        parents: Array.from(card.querySelectorAll('input[name$=".dependency"]:checked'), input => input.value) }];
    }));
    if (graph) return graph.render(steps);
    const orders = preview.querySelector('[data-config-order]');
    const status = preview.querySelector('[data-config-status]');
    const { ranks, remaining } = workflowDependencyRanks(steps);
    const rows = ranks.map(rank => {
      const row = document.createElement('li');
      for (const id of rank) {
        const step = steps.get(id);
        const card = document.createElement('a');
        card.href = '#config-' + id;
        card.textContent = step.title;
        if (step.parents.length) {
          const parents = document.createElement('small');
          parents.textContent = 'After ' + step.parents.map(parent => steps.get(parent)?.title ?? parent).join(', ');
          card.append(parents);
        }
        row.append(card);
      }
      return row;
    });
    const message = remaining.length ? 'A dependency cycle prevents some steps from starting.' : '';
    if (status.textContent !== message) status.textContent = message;
    orders.replaceChildren(...rows);
    preview.hidden = cards.length < 2;
  }

  function renderArtifactRoutes() {
    for (const card of cards) {
      const prerequisites = new Set([...card.querySelectorAll('input[name$=".dependency"]:checked')].map(input => input.value));
      for (const join of card.querySelectorAll('[data-join-from]')) {
        const parent = byId.get(join.dataset.joinFrom);
        join.querySelector('span').textContent = parent.querySelector('input[name$=".title"]').value.trim() || join.dataset.joinFrom;
        join.hidden = !prerequisites.has(join.dataset.joinFrom);
        if (join.hidden) join.querySelector('input').checked = false;
      }
      const condition = card.querySelector('[data-condition-source]');
      for (const option of condition?.options ?? []) {
        if (!option.dataset.conditionStep) continue;
        const parent = byId.get(option.dataset.conditionStep);
        const slot = [...parent.querySelectorAll('[data-output-slot]')].find(item => item.dataset.outputSlot === option.dataset.conditionOutput);
        if (!slot) continue;
        const parentName = parent.querySelector('input[name$=".title"]').value.trim() || parent.dataset.configStep;
        const outputName = slot.querySelector('input[name$=".title"]').value.trim() || slot.querySelector('input[name$=".id"]').value.trim() || slot.dataset.outputSlot;
        const eligible = prerequisites.has(parent.dataset.configStep) && slot.querySelector('select[name$=".kind"]').value === 'json' &&
          slot.querySelector('input[name$=".required"]').checked;
        option.disabled = !eligible && !option.selected;
        option.textContent = parentName + ' · ' + outputName + (option.disabled || eligible ? '' : ' (unavailable)');
      }
      for (const group of card.querySelectorAll('[data-route-from]')) {
        const parent = byId.get(group.dataset.routeFrom);
        const enabled = prerequisites.has(group.dataset.routeFrom);
        group.querySelector('[data-route-title]').textContent =
          parent.querySelector('input[name$=".title"]').value.trim() || parent.dataset.configStep;
        let available = false;
        for (const label of group.querySelectorAll('[data-route-output]')) {
          const slot = [...parent.querySelectorAll('[data-output-slot]')].find(item => item.dataset.outputSlot === label.dataset.routeOutput);
          const input = label.querySelector('input');
          const capability = label.dataset.routeCapability;
          const required = capability === 'browser' ? parent.querySelector('select[name$=".agent"]').selectedOptions[0]?.hasAttribute('data-browser-capability')
            : capability === 'workspace-check' ? parent.querySelector('input[name$=".workspace-check"]')?.checked
              : (slot?.querySelector('input[name$=".required"]').checked ?? true);
          label.hidden = !required;
          input.disabled = !required;
          if (slot) {
            const name = slot.querySelector('input[name$=".title"]').value.trim() || slot.querySelector('input[name$=".id"]').value.trim() || slot.dataset.outputSlot;
            const kind = slot.querySelector('select[name$=".kind"]').value;
            label.querySelector('span').textContent = name + (['image', 'browser-screenshot'].includes(kind) ? ' · Image' : '');
          }
          if (!enabled || !required) input.checked = false;
          available ||= required;
        }
        group.hidden = !enabled || !available;
      }
      const history = card.querySelector('[data-history-source]');
      if (!history) continue;
      const profile = savedThreadProfile(card);
      for (const option of history.options) {
        if (!option.value) continue;
        const parent = byId.get(option.value);
        option.textContent = parent.querySelector('input[name$=".title"]').value.trim() || option.value;
        option.disabled = !profile || !prerequisites.has(option.value) || savedThreadProfile(parent) !== profile;
        if (option.disabled && option.selected) history.value = '';
      }
    }
    graph?.renderSelection();
  }

  function savedThreadProfile(card) {
    return card.querySelector('select[name$=".agent"]').selectedOptions[0]?.dataset.savedThreadProfile;
  }

  function renderSkillInvocations(card, option) {
    const fieldset = card.querySelector('[data-step-skill-inputs]');
    const profile = option?.dataset.skillProfile ?? '';
    if (!fieldset || fieldset.dataset.skillProfile === profile) return;
    const choices = JSON.parse(option?.dataset.skillChoices ?? '[]');
    fieldset.querySelector('[data-step-skill-options]').replaceChildren(...choices.map(({ value, name }) => {
      const label = document.createElement('label');
      label.className = 'configuration-tool';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.name = fieldset.dataset.fieldName;
      input.value = value;
      const caption = document.createElement('span');
      caption.textContent = name;
      label.append(input, caption);
      return label;
    }));
    fieldset.dataset.skillProfile = profile;
    fieldset.hidden = choices.length === 0;
  }

  form?.addEventListener('input', event => {
    const field = event.target;
    const input = field.closest('[data-workflow-input]');
    if (input && field.name.endsWith('.title')) {
      const title = field.value.trim();
      input.querySelector('legend').textContent = title || 'New input';
      for (const label of form.querySelectorAll('[data-config-input-label]')) {
        if (label.previousElementSibling.value === input.dataset.workflowInput) label.textContent = title || input.dataset.workflowInput;
      }
    }
    const card = field.closest('[data-config-step]');
    const id = card?.dataset.configStep;
    if (!id) return;
    if (field.name === id + '.response-mode') {
      card.querySelector('[data-output-follow-up-setting]').hidden = field.value !== 'free-form';
      return;
    }
    if (field.name === id + '.dependency') { renderDependencies(); renderArtifactRoutes(); return; }
    if (field.name === id + '.agent') {
      renderSkillInvocations(card, field.selectedOptions[0]);
      if (graph) renderDependencies();
    }
    if (['.agent', '.condition-source', '.workspace-check'].some(suffix => field.name === id + suffix)) { renderArtifactRoutes(); return; }
    if (/\.(?:route|join|workspace-source|history-source)$/.test(field.name)) graph?.renderSelection();
    const slot = field.closest('[data-output-slot]');
    if (slot && /\.(?:title|id|required|kind)$/.test(field.name)) {
      slot.querySelector('legend').textContent = slot.querySelector('input[name$=".title"]').value.trim() || 'New output';
      renderArtifactRoutes();
      return;
    }
    if (field.name !== id + '.title') return;
    const title = field.value.trim();
    card.querySelector('[data-config-step-title]').textContent = title || 'New step';
    for (const label of form.querySelectorAll('[data-dependency-label]')) {
      if (label.previousElementSibling.value === id) label.textContent = title || id;
    }
    renderDependencies();
    renderArtifactRoutes();
  });
  if (preview) { renderDependencies(); renderArtifactRoutes(); }
}

for (const testResult of document.querySelectorAll('[data-workflow-test-result], [data-agent-test-result]')) {
  const form = testResult.closest('form');
  const agentDraft = testResult.hasAttribute('data-agent-test-result');
  form.addEventListener('submit', async event => {
    const button = event.submitter;
    if (button?.value !== 'test') return;
    event.preventDefault();
    if (button.hasAttribute('data-draft-pending')) return;
    const draftFields = new FormData(form, button);
    const fields = agentDraft ? draftFields : new URLSearchParams(draftFields);
    button.disabled = true;
    button.setAttribute('data-draft-pending', '');
    testResult.textContent = 'Creating draft test…';
    try {
      const response = await fetch(form.getAttribute('action'), { method: 'POST', headers: { Accept: 'application/json' }, body: fields,
        signal: AbortSignal.timeout(30_000) });
      if (!response.ok) {
        const message = response.headers.get('content-type')?.includes('application/json') ? (await response.json()).error :
          new DOMParser().parseFromString(await response.text(), 'text/html').querySelector('main [role=alert]')?.textContent;
        testResult.textContent = message || 'Could not create the draft test. Check the settings.';
        return;
      }
      const { location, nextTestRunId } = await response.json();
      form.elements.namedItem('test-run-id').value = nextTestRunId;
      const link = document.createElement('a');
      link.href = location;
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = agentDraft ? 'Open agent draft test in a new tab' : 'Open draft test in a new tab';
      testResult.replaceChildren('Draft test created. ', link);
    } catch {
      testResult.textContent = 'Could not confirm the draft test. Try again to check the same submission.';
    } finally {
      button.removeAttribute('data-draft-pending');
      button.disabled = Boolean(form.querySelector('[data-agent-skills][aria-busy="true"]'));
    }
  });
}
