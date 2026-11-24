{
  const editor = document.querySelector('[data-connected-apps]');
  if (editor) {
    const list = editor.querySelector('[data-connected-app-list]');
    const status = editor.querySelector('[data-connected-app-status]');
    const retry = editor.querySelector('[data-connected-app-retry]');
    let loaded = false, reading = false;
    function report(message) {
      status.textContent = message;
      status.hidden = !message;
    }
    async function load() {
      if (!editor.open || loaded || reading) return;
      reading = true;
      retry.hidden = true;
      report('Checking the Codex worker for connected apps…');
      try {
        const response = await fetch(editor.dataset.connectedApps, { cache: 'no-store', signal: AbortSignal.timeout(12_000) });
        if (!response.ok) throw new Error('App catalog unavailable');
        const { apps } = await response.json();
        const selected = new Map([...list.querySelectorAll('input:checked')].map(input =>
          [input.value, input.closest('label').querySelector('strong').textContent]));
        const known = new Set(apps.map(app => app.id));
        const rows = [...apps, ...[...selected].filter(([id]) => !known.has(id)).map(([id, name]) => ({ id, name }))];
        list.replaceChildren(...rows.map(app => {
          const label = document.createElement('label');
          label.className = 'configuration-tool';
          const input = document.createElement('input');
          input.type = 'checkbox';
          input.name = 'codex-app';
          input.value = app.id;
          input.checked = selected.has(app.id);
          input.disabled = !(app.enabled && app.callable) && !input.checked;
          const caption = document.createElement('span');
          const title = document.createElement('strong');
          title.textContent = app.name;
          caption.append(title);
          if (!(app.enabled && app.callable)) {
            const reason = document.createElement('small');
            reason.textContent = 'Unavailable on this worker';
            caption.append(reason);
          }
          label.append(input, caption);
          return label;
        }));
        loaded = true;
        report(rows.length ? '' : 'Connect an app to the worker’s Codex account to attach it here.');
      } catch {
        report('Could not read connected apps from the Codex worker.');
        retry.hidden = false;
      } finally { reading = false; }
    }
    editor.addEventListener('toggle', load);
    retry.addEventListener('click', load);
    if (editor.open) load();
  }
}

{
  const editor = document.querySelector('[data-hook-editor]');
  if (editor) {
    const field = editor.querySelector('textarea');
    const example = editor.querySelector('[data-hook-example]');
    const approval = editor.querySelector('[name="approve-hooks"]');
    const update = () => { example.hidden = Boolean(field.value.trim()); approval.checked = false; };
    example.hidden = Boolean(field.value.trim());
    field.addEventListener('input', update);
    example.addEventListener('click', () => {
      if (field.value.trim()) return;
      const output = { hookSpecificOutput: { hookEventName: 'SessionStart',
        additionalContext: 'Check what information is missing before starting.' } };
      field.value = JSON.stringify({ hooks: { SessionStart: [{ matcher: 'startup', hooks: [{
        type: 'command', command: "printf '%s\\n' '" + JSON.stringify(output) + "'", timeout: 5,
      }] }] } }, null, 2);
      update();
      field.focus();
    });
  }
}

{
  const editor = document.querySelector('[data-agent-skills]');
  if (editor) {
    const list = editor.querySelector('[data-skill-list]');
    const empty = editor.querySelector('[data-no-skills]');
    const add = editor.querySelector('[data-add-skill]');
    const upload = editor.querySelector('[data-upload-skill]');
    const files = editor.querySelector('[data-skill-files]');
    const uploadFolder = editor.querySelector('[data-upload-skill-folder]');
    const folderFiles = editor.querySelector('[data-skill-folder]');
    const alert = editor.querySelector('[data-skill-alert]');
    const submit = editor.closest('form').querySelectorAll('button[type="submit"]');
    const template = editor.querySelector('template').content.firstElementChild;
    const limit = Number(editor.dataset.skillLimit);
    const maxBytes = Number(editor.dataset.skillBytes);
    const maxName = template.querySelector('input').maxLength;
    let reading = false;

    function update() {
      editor.setAttribute('aria-busy', String(reading));
      empty.hidden = list.children.length > 0;
      add.disabled = upload.disabled = reading || list.children.length >= limit;
      if (uploadFolder) uploadFolder.disabled = add.disabled;
      for (const button of submit) button.disabled = reading || button.hasAttribute('data-draft-pending');
    }

    function report(messages = []) {
      alert.textContent = messages.join(' ');
      alert.hidden = messages.length === 0;
    }

    function append(name = '', content = '', bundle = null) {
      const row = template.cloneNode(true);
      const input = row.querySelector('input');
      input.value = name;
      row.querySelector('summary').textContent = name || 'New skill';
      row.querySelector('textarea').value = content;
      if (bundle) {
        row.querySelector('[name="skill-bundle"]').value = JSON.stringify(bundle);
        row.querySelector('[data-skill-resources]').hidden = false;
        row.querySelector('[data-skill-resource-summary]').textContent = bundle.directory + ' · ' + bundle.files.length + ' supporting files';
        const resources = row.querySelector('[data-skill-resource-list]');
        for (const file of bundle.files) {
          const item = document.createElement('li');
          const code = document.createElement('code');
          code.textContent = file.path;
          item.append(code);
          resources.append(item);
        }
      }
      row.querySelector('[data-remove-skill]').hidden = false;
      row.open = true;
      list.append(row);
      return input;
    }

    async function readManifest(file, fallback) {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
      if (!text.trim() || text.includes('\0')) throw new Error('Expected Markdown text');
      const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
      const name = frontmatter?.match(/^name:[ \t]*([^\r\n]+)$/m)?.[1].trim().replace(/^(['"])(.*)\1$/, '$2') || fallback;
      return { text, name: name.slice(0, maxName) };
    }

    function encodeBytes(bytes) {
      let binary = '';
      for (let index = 0; index < bytes.length; index += 8192) binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
      return btoa(binary);
    }

    editor.querySelector('[data-skill-actions]').hidden = false;
    for (const button of list.querySelectorAll('[data-remove-skill]')) button.hidden = false;
    update();
    add.addEventListener('click', () => {
      report();
      append().focus();
      update();
    });
    upload.addEventListener('click', () => files.click());
    files.addEventListener('change', async () => {
      const selected = Array.from(files.files);
      files.value = '';
      if (!selected.length) return;
      reading = true;
      update();
      const errors = [];
      let first;
      for (const file of selected) {
        if (list.children.length >= limit) {
          errors.push(`Attach up to ${limit} skills.`);
          break;
        }
        if (!/\.(?:md|markdown)$/i.test(file.name) || file.size > maxBytes) {
          errors.push(`Choose a Markdown file up to ${maxBytes / 1024} KiB for ${file.name}.`);
          continue;
        }
        try {
          const { text, name } = await readManifest(file, file.name.replace(/\.(?:md|markdown)$/i, ''));
          const field = append(name, text);
          first ??= field;
        } catch {
          errors.push(`Could not read ${file.name} as UTF-8 Markdown.`);
        }
      }
      reading = false;
      report(errors);
      update();
      (first ?? upload).focus();
    });
    uploadFolder?.addEventListener('click', () => folderFiles.click());
    folderFiles?.addEventListener('change', async () => {
      const selected = Array.from(folderFiles.files, file => ({ file, parts: file.webkitRelativePath.split('/') }))
        .filter(({ file }) => file.name !== '.DS_Store');
      folderFiles.value = '';
      if (!selected.length || list.children.length >= limit) return;
      const directory = selected[0].parts[0];
      const manifest = selected.find(({ parts }) => parts.length === 2 && parts[1] === 'SKILL.md')?.file;
      if (!manifest || selected.some(({ parts }) => parts.length < 2 || parts[0] !== directory)) {
        report(['Choose a folder with a SKILL.md at its top level.']);
        return;
      }
      const assets = selected.filter(({ file }) => file !== manifest);
      const total = assets.reduce((size, { file }) => size + file.size, 0);
      const folderBytes = Number(editor.dataset.folderBytes);
      const attachedBytes = Array.from(list.querySelectorAll('[name="skill-bundle"]'), field =>
        (JSON.parse(field.value || 'null')?.files ?? []).reduce((size, file) => size + Math.floor(file.data.replace(/=+$/, '').length * 3 / 4), 0))
        .reduce((sum, size) => sum + size, 0);
      if (manifest.size > maxBytes || total > folderBytes || assets.length > Number(editor.dataset.folderFiles) ||
        total + attachedBytes > Number(editor.dataset.agentFolderBytes)) {
        report(['This folder exceeds the skill upload limits. A folder can include up to ' +
          editor.dataset.folderFiles + ' supporting files and ' + folderBytes / 1024 + ' KiB of resources.']);
        return;
      }
      reading = true;
      update();
      let field;
      try {
        const { text, name } = await readManifest(manifest, directory);
        const resources = await Promise.all(assets.map(async ({ file, parts }) => ({
          path: parts.slice(1).join('/'), data: encodeBytes(new Uint8Array(await file.arrayBuffer())),
        })));
        field = append(name, text, { directory, files: resources });
        report();
      } catch {
        report(['The skill folder could not be read. Check that SKILL.md contains UTF-8 Markdown.']);
      } finally {
        reading = false;
        update();
        (field ?? uploadFolder).focus();
      }
    });
    list.addEventListener('input', event => {
      if (event.target.name === 'skill-name') event.target.closest('details').querySelector('summary').textContent = event.target.value || 'New skill';
    });
    list.addEventListener('click', event => {
      const button = event.target.closest('[data-remove-skill]');
      if (!button) return;
      const row = button.closest('details');
      const neighbor = row.nextElementSibling ?? row.previousElementSibling;
      row.remove();
      report();
      update();
      (neighbor?.querySelector('summary') ?? add).focus();
    });
    list.addEventListener('invalid', event => { event.target.closest('details').open = true; }, true);
  }
}
{
  const editor = document.querySelector('[data-project-mcp-editor]');
  if (editor) {
    const transport = editor.elements.transport;
    const fields = editor.querySelectorAll('[data-mcp-transport]');
    const showTransport = () => {
      for (const group of fields) {
        const hidden = group.dataset.mcpTransport !== transport.value;
        group.hidden = hidden;
        group.disabled = hidden;
      }
    };
    transport.addEventListener('change', showTransport);
    showTransport();
  }
}

{
  const editor = document.querySelector('[data-subagent-editor]');
  if (editor) {
    const list = editor.querySelector('[data-subagents]');
    const add = editor.querySelector('[data-add-subagent]');
    const template = editor.querySelector('template').content.firstElementChild;
    add.hidden = false;
    for (const button of list.querySelectorAll('[data-remove-subagent]')) button.hidden = false;
    add.addEventListener('click', () => {
      const role = template.cloneNode(true);
      role.querySelector('[data-remove-subagent]').hidden = false;
      role.open = true;
      list.append(role);
      editor.closest('form').elements.delegation.checked = true;
      role.querySelector('[name=specialist-name]').focus();
    });
    list.addEventListener('input', event => {
      if (event.target.name === 'specialist-name') {
        const role = event.target.closest('[data-subagent-role]');
        role.querySelector('[data-subagent-summary]').textContent = event.target.value || 'New specialist';
      }
    });
    list.addEventListener('invalid', event => { event.target.closest('[data-subagent-role]').open = true; }, true);
    list.addEventListener('click', event => {
      const remove = event.target.closest('[data-remove-subagent]');
      if (!remove) return;
      remove.closest('[data-subagent-role]').remove();
      add.focus();
    });
  }
}

{
  const panel = document.querySelector('[data-mcp-discovery]');
  if (panel) {
    const form = panel.querySelector('form');
    const button = form.querySelector('button');
    const status = panel.querySelector('[role=status]');
    const results = panel.querySelector('[data-mcp-discovery-results]');
    form.addEventListener('submit', async event => {
      event.preventDefault();
      button.disabled = true;
      status.textContent = 'Checking saved connection…';
      results.replaceChildren();
      try {
        const response = await fetch(form.action, { method: 'POST', body: new URLSearchParams(new FormData(form)),
          signal: AbortSignal.timeout(20_000) });
        if (!response.ok) throw new Error();
        const page = new DOMParser().parseFromString(await response.text(), 'text/html');
        const checked = page.querySelector('[data-mcp-discovery]');
        status.textContent = checked.querySelector('[role=status]').textContent;
        results.replaceChildren(...checked.querySelector('[data-mcp-discovery-results]').children);
      } catch {
        status.textContent = 'Could not check the saved connection. Try again.';
      } finally {
        button.disabled = false;
      }
    });
  }
}

{
  const panel = document.querySelector('[data-oauth-status]');
  if (panel) {
    const status = panel.querySelector('[role=status]');
    const provider = panel.querySelector('[data-oauth-provider]');
    const cancel = panel.querySelector('[data-oauth-cancel]');
    const providerLink = provider.querySelector('a');
    const interval = 1000;
    async function observe() {
      try {
        const response = await fetch(panel.dataset.oauthStatus, { cache: 'no-store' });
        const view = response.status === 404 ? {
          state: 'expired', message: 'This sign-in is unavailable. Open the saved connection to start another.',
        } : response.ok ? await response.json() : null;
        if (view) {
          if (status.textContent !== view.message) status.textContent = view.message;
          provider.hidden = view.state !== 'waiting';
          if (view.authorizationUrl) providerLink.href = view.authorizationUrl;
          else providerLink.removeAttribute('href');
          if (!['starting', 'waiting'].includes(view.state)) {
            cancel.hidden = true;
            return;
          }
        }
      } catch {}
      setTimeout(observe, interval);
    }
    setTimeout(observe, interval);
  }
}
{
  const fields = document.querySelector('[data-codex-speed-options]');
  if (fields) {
    const { defaultModel, advertised, savedName } = JSON.parse(fields.dataset.codexSpeedOptions);
    const model = fields.querySelector('[name="model"]');
    const speed = fields.querySelector('[name="service-tier"]');
    const names = new Map(Object.values(advertised).flat().map(({ id, name }) => [id, name]));
    if (speed.value && !names.has(speed.value)) names.set(speed.value, savedName);
    const defaults = [...speed.options].slice(0, 2);
    function update() {
      const selected = speed.value;
      const id = model.value.trim() || defaultModel;
      const choices = Object.hasOwn(advertised, id) ? advertised[id] : [];
      speed.replaceChildren(...defaults, ...choices.map(({ id, name }) => new Option(name, id)));
      if (selected && ![...speed.options].some(option => option.value === selected))
        speed.add(new Option((names.get(selected) ?? selected) + ' (not listed for this model)', selected));
      speed.value = selected;
    }
    model.addEventListener('input', update);
    model.addEventListener('change', update);
  }
}
