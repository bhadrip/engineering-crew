function workflowDependencyRanks(steps) {
  const remaining = new Set(steps.keys());
  const ranks = [];
  while (remaining.size) {
    const ready = [...remaining].filter(id => steps.get(id).parents.every(parent => !remaining.has(parent)));
    if (!ready.length) break;
    ranks.push(ready);
    for (const id of ready) remaining.delete(id);
  }
  return { ranks, remaining: [...remaining] };
}

function closesWorkflowCycle(steps, prerequisite, dependent) {
  const pending = [prerequisite];
  const visited = new Set();
  while (pending.length) {
    const id = pending.pop();
    if (id === dependent) return true;
    if (visited.has(id)) continue;
    visited.add(id);
    pending.push(...(steps.get(id)?.parents ?? []));
  }
  return false;
}

function workflowDependencyEditor(panel, cards) {
  const form = panel.closest('form');
  const editable = panel.hasAttribute('data-editable-graph');
  const canvas = panel.querySelector('[data-dependency-canvas]');
  const levels = panel.querySelector('[data-dependency-levels]');
  const title = panel.querySelector('[data-selected-dependency-step]');
  const list = panel.querySelector('[data-selected-prerequisites]');
  const link = panel.querySelector('[data-edit-dependency-step]');
  const feedback = panel.querySelector('[data-dependency-feedback]');
  const connect = panel.querySelector('[data-connect-dependency]');
  const undoButton = panel.querySelector('[data-undo-dependency]');
  const status = panel.querySelector('[data-config-status]');
  let steps, selected, connecting = false, editing = false, undo, dispose;
  const buttons = new Map();

  function canConnect(id) {
    return id !== selected && !steps.get(selected).parents.includes(id) && !closesWorkflowCycle(steps, id, selected);
  }

  function dependencySettings(parent) {
    const card = cards.get(selected);
    const matches = (suffix, value) => [...card.querySelectorAll('input[name$="' + suffix + '"]:checked')].filter(input => value(input.value));
    const routes = matches('.route', value => value.startsWith(parent + '/'));
    const joins = matches('.join', value => value === parent);
    const history = card.querySelector('[data-history-source]');
    const workspace = card.querySelector('select[name$=".workspace-source"]');
    const condition = card.querySelector('[data-condition-source]');
    return [
      ...(routes.length ? [{ description: routes.length === 1 ? 'artifact route' : routes.length + ' artifact routes', fields: routes }] : []),
      ...(joins.length ? [{ description: 'branch join', fields: joins }] : []),
      ...(history?.value === parent ? [{ description: 'Codex thread history', fields: [history] }] : []),
      ...(workspace?.value === 'step:' + parent ? [{ description: 'workspace source', fields: [workspace] }] : []),
      ...(condition?.selectedOptions[0]?.dataset.conditionStep === parent ? [{ description: 'run condition', fields: [condition] }] : []),
    ];
  }

  function renderSelection() {
    const step = steps.get(selected);
    const available = [...buttons.keys()].filter(canConnect);
    if (!available.length) connecting = false;
    for (const [id, button] of buttons) {
      button.setAttribute('aria-pressed', String(id === selected));
      button.toggleAttribute('data-prerequisite-node', step.parents.includes(id));
      button.toggleAttribute('data-connectable-node', connecting && available.includes(id));
      if (connecting && !available.includes(id)) button.setAttribute('aria-disabled', 'true');
      else button.removeAttribute('aria-disabled');
    }
    title.textContent = step.title;
    link.href = '#config-' + selected;
    if (connect) {
      connect.disabled = !available.length;
      connect.title = available.length ? '' : 'No eligible prerequisite for this step';
      connect.setAttribute('aria-pressed', String(connecting));
      connect.textContent = connecting ? 'Cancel connection' : 'Add prerequisite';
      undoButton.hidden = !undo;
    }
    const parents = step.parents.map(parent => {
      const name = steps.get(parent)?.title ?? parent;
      const item = document.createElement('li');
      const text = document.createElement('span');
      text.textContent = name;
      item.append(text);
      if (editable) {
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'secondary';
        remove.dataset.removeDependency = parent;
        remove.textContent = 'Remove';
        remove.setAttribute('aria-label', 'Remove ' + name + ' as a prerequisite for ' + step.title);
        item.append(remove);
        const effects = dependencySettings(parent);
        if (effects.length) {
          const hint = document.createElement('small');
          hint.textContent = 'Also clears ' + effects.map(effect => effect.description).join(', ') + '.';
          item.append(hint);
        }
      }
      return item;
    });
    if (!parents.length) {
      const empty = document.createElement('li');
      empty.textContent = 'No prerequisites';
      parents.push(empty);
    }
    list.replaceChildren(...parents);
    return available;
  }

  function focusSelected() {
    buttons.get(selected)?.focus();
  }

  function changeDependency(parent, add) {
    const dependent = selected;
    const target = [...cards.get(dependent).querySelectorAll('input[name$=".dependency"]')].find(input => input.value === parent);
    if (!target || target.matches(':disabled') || target.checked === add) return;
    const effects = add ? [] : dependencySettings(parent);
    const before = effects.flatMap(effect => effect.fields.map(field => [field, field.type === 'checkbox' ? field.checked : field.value]));
    undo = { target, selected, before, parent, add };
    connecting = false;
    editing = true;
    for (const [field] of before) {
      if (field.type === 'checkbox') field.checked = false;
      else field.value = '';
    }
    target.click();
    editing = false;
    feedback.textContent = steps.get(parent).title + (add ? ' is now a prerequisite for ' : ' was removed as a prerequisite for ') + steps.get(dependent).title + '.';
    if (add) focusSelected();
    else connect.focus();
  }

  panel.addEventListener('click', event => {
    const node = event.target.closest('[data-select-dependency-step]');
    const remove = event.target.closest('[data-remove-dependency]');
    if (node) {
      const id = node.dataset.selectDependencyStep;
      if (connecting) {
        if (canConnect(id)) changeDependency(id, true);
        return;
      }
      selected = id;
      feedback.textContent = '';
      renderSelection();
    } else if (remove && editable) changeDependency(remove.dataset.removeDependency, false);
  });
  connect?.addEventListener('click', () => {
    connecting = !connecting;
    const available = renderSelection();
    feedback.textContent = connecting ? 'Choose a prerequisite for ' + steps.get(selected).title + ' in the graph.' : '';
    if (connecting) buttons.get(available[0]).focus();
  });
  panel.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !connecting) return;
    event.preventDefault();
    connecting = false;
    feedback.textContent = 'Connection canceled.';
    renderSelection();
    connect.focus();
  });
  undoButton?.addEventListener('click', () => {
    if (!undo) return;
    const { target, before, selected: original, parent, add } = undo;
    undo = undefined;
    selected = original;
    if (!add && closesWorkflowCycle(steps, parent, selected)) {
      feedback.textContent = 'The prerequisite cannot be restored because it would create a dependency cycle.';
      renderSelection();
      focusSelected();
      return;
    }
    editing = true;
    target.click();
    for (const [field, value] of before) {
      if (field.type === 'checkbox') field.checked = value;
      else field.value = value;
    }
    target.dispatchEvent(new Event('input', { bubbles: true }));
    editing = false;
    feedback.textContent = 'Dependency change undone.';
    focusSelected();
  });
  form.addEventListener('input', event => {
    if (editing || !undo || !cards.get(undo.selected).contains(event.target)) return;
    undo = undefined;
    undoButton.hidden = true;
    feedback.textContent = '';
  });

  function render(next) {
    steps = next;
    selected ??= steps.keys().next().value;
    const { ranks, remaining } = workflowDependencyRanks(steps);
    panel.hidden = steps.size < 2;
    status.textContent = remaining.length ? 'A dependency cycle prevents some steps from starting.' : '';
    dispose?.();
    buttons.clear();
    const graphRanks = [...ranks, ...(remaining.length ? [remaining] : [])];
    canvas.style.setProperty('--graph-lanes', Math.max(1, ...graphRanks.map(rank => rank.length)));
    const rows = graphRanks.map(rank => {
      const row = document.createElement('div');
      row.className = 'workflow-level';
      for (const id of rank) {
        const card = document.createElement('div');
        card.dataset.key = id;
        card.dataset.dependencyNode = '';
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.selectDependencyStep = id;
        const name = document.createElement('strong');
        name.textContent = steps.get(id).title;
        button.append(name);
        if (steps.get(id).agent) {
          const agent = document.createElement('small');
          agent.textContent = steps.get(id).agent;
          button.append(agent);
        }
        buttons.set(id, button);
        card.append(button);
        row.append(card);
      }
      return row;
    });
    levels.replaceChildren(...rows);
    renderSelection();
    const edges = document.createDocumentFragment();
    for (const [to, step] of steps) for (const from of step.parents) {
      const edge = document.createElement('span');
      edge.className = 'workflow-dependency';
      Object.assign(edge.dataset, { from, to });
      edges.append(edge);
    }
    dispose = connectWorkflowGraph(canvas, edges, {
      nodeSelector: '[data-dependency-node]', portSelector: ':scope > button', markerId: 'workflow-editor-arrow',
    });
  }
  return { render, renderSelection };
}
