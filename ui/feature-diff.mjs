import { escape, layout, projectHeader, projectHref } from './views.mjs';
import { featureAction } from './feature-language.mjs';

const quotedEscapes = { a: '\x07', b: '\b', t: '\t', n: '\n', v: '\v', f: '\f', r: '\r', '"': '"', '\\': '\\' };
const escapedControls = Object.fromEntries(Object.entries(quotedEscapes).map(([name, char]) => [char, '\\' + name]));
const utf8 = new TextDecoder('utf-8', { fatal: true });

// Git C-quotes control characters and, by default, non-ASCII path bytes.
function gitPath(token, removePrefix = false) {
  let path = token.replace(/\t$/, '');
  if (path.startsWith('"') && path.endsWith('"')) {
    path = path.slice(1, -1).replace(/(?:\\[0-7]{3})+|\\(["\\abtnvfr])/g, (match, char) => {
      if (char) return quotedEscapes[char];
      const bytes = Uint8Array.from(match.match(/[0-7]{3}/g), octet => parseInt(octet, 8));
      try { return utf8.decode(bytes); } catch { return match; }
    });
  }
  if (removePrefix) path = path.replace(/^[ab]\//, '');
  return path.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, char =>
    escapedControls[char] ?? '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'));
}

function headerPaths(header) {
  const quoted = /^("(?:\\.|[^"\\])*") (.+)$/.exec(header) ?? /^(.+) ("(?:\\.|[^"\\])*")$/.exec(header);
  if (quoted) return quoted.slice(1).map(token => gitPath(token, true));
  // Unquoted Git paths may themselves contain " b/". For an unchanged
  // filename both header operands have identical lengths, even then.
  let split = Math.floor(header.length / 2);
  if (header[split] !== ' ' || header.slice(2, split) !== header.slice(split + 3)) split = header.indexOf(' b/');
  return split < 0 ? [gitPath(header, true), ''] : [gitPath(header.slice(0, split), true), gitPath(header.slice(split + 1), true)];
}

function parseDiff(diff) {
  const files = [];
  let file, hunk;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const [from, to] = headerPaths(line.slice(11));
      file = { from, to, status: 'Modified', added: 0, removed: 0, hunks: [], modes: [] };
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) continue;
    const range = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (range) {
      hunk = { header: line, old: Number(range[1]), next: Number(range[2]), lines: [] };
      file.hunks.push(hunk);
    } else if (hunk) {
      if (line[0] === '+') file.added++;
      if (line[0] === '-') file.removed++;
      if (/^[+\- \\]/.test(line)) hunk.lines.push(line);
    } else if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      const source = line[0] === '-';
      const path = gitPath(line.slice(4), true);
      if (path === '/dev/null') file.status = source ? 'Added' : 'Deleted';
      else file[source ? 'from' : 'to'] = path;
    } else if (/^(?:rename|copy) (?:from|to) /.test(line)) {
      const [, action, side, path] = /^(rename|copy) (from|to) (.*)$/.exec(line);
      file[side] = gitPath(path);
      file.status = action === 'rename' ? 'Renamed' : 'Copied';
    } else if (line.startsWith('new file mode ')) file.status = 'Added';
    else if (line.startsWith('deleted file mode ')) file.status = 'Deleted';
    else if (/^(old|new) mode /.test(line)) file.modes.push(line);
    else if (line.startsWith('Binary files ') || line === 'GIT binary patch') file.binary = true;
  }
  return files;
}

function counts(added, removed) {
  return `<span class="diff-totals"><span class="diff-add-count">+${added}<span class="visually-hidden"> added lines</span></span> <span class="diff-remove-count">−${removed}<span class="visually-hidden"> removed lines</span></span></span>`;
}

function filePath(file) {
  if (file.status === 'Renamed' || file.status === 'Copied') return file.from + ' → ' + file.to;
  return (file.status === 'Deleted' ? file.from : file.to) || file.from;
}

function renderHunk(hunk) {
  let oldLine = hunk.old, newLine = hunk.next;
  const rows = hunk.lines.map(line => {
    const mark = line[0];
    if (mark === '\\') return `<tr class="diff-line" data-kind="note"><td colspan="4">${escape(line.slice(1).trimStart())}</td></tr>`;
    const kind = mark === '+' ? 'add' : mark === '-' ? 'remove' : 'context';
    const old = mark === '+' ? '' : oldLine++;
    const next = mark === '-' ? '' : newLine++;
    return `<tr class="diff-line" data-kind="${kind}"><td class="diff-old">${old}</td><td class="diff-new">${next}</td><td class="diff-mark">${mark}</td><td class="diff-code"><code>${escape(line.slice(1))}</code></td></tr>`;
  }).join('');
  return `<tbody><tr class="diff-hunk"><th colspan="4" scope="rowgroup"><code>${escape(hunk.header)}</code></th></tr>${rows}</tbody>`;
}

function renderFile(file, index) {
  const path = filePath(file);
  let summary;
  if (file.binary) summary = 'Binary file changed.';
  else if (!file.hunks.length && !file.modes.length) {
    if (file.status === 'Added' || file.status === 'Deleted') summary = 'Empty file.';
    else if (file.status === 'Renamed' || file.status === 'Copied') summary = 'File content is identical.';
    else summary = 'Only file metadata changed.';
  }
  const lines = file.hunks.length ? `<div class="diff-scroll" role="region" aria-label="Code changes in ${escape(path)}" tabindex="0"><table class="diff-table"><thead class="visually-hidden"><tr><th scope="col">Old line</th><th scope="col">New line</th><th scope="col">Change</th><th scope="col">Code</th></tr></thead>${file.hunks.map(renderHunk).join('')}</table></div>` : '';
  return `<details class="diff-file" id="diff-file-${index + 1}"${index === 0 ? ' open' : ''}><summary class="diff-file-header"><code class="diff-file-path">${escape(path)}</code><span class="diff-file-status">${file.status}</span>${counts(file.added, file.removed)}</summary>
${summary ? `<p class="diff-metadata">${summary}</p>` : ''}${file.modes.length ? `<p class="diff-metadata">${file.modes.map(escape).join(' · ')}</p>` : ''}${lines}</details>`;
}

export function featureDiffPage(project, request, { collection, number, diff, base, revision }) {
  if (!['attempts', 'events'].includes(collection) || !/^[1-9]\d*$/.test(String(number))) throw new Error('Invalid diff location');
  const files = parseDiff(diff);
  const path = projectHref(project) + '/requests/' + encodeURIComponent(request.id);
  const attempt = collection === 'attempts';
  const back = path + (attempt ? '#stage-attempt-' : '#event-') + number;
  const raw = path + '/' + collection + '/' + number + '.diff';
  const source = attempt ? featureAction('build', Number(number)) : 'Edit #' + number;
  const title = attempt ? 'Build changes' : 'Code edit';
  const totals = counts(files.reduce((n, f) => n + f.added, 0), files.reduce((n, f) => n + f.removed, 0));
  const index = `<details class="diff-index" id="diff-index"><summary>${files.length} ${files.length === 1 ? 'file' : 'files'} changed</summary>
<ul>${files.map((f, i) => `<li><a href="#diff-file-${i + 1}"><code>${escape(filePath(f))}</code></a>${counts(f.added, f.removed)}</li>`).join('')}</ul></details>`;
  const empty = diff.trim() ? 'Git returned a patch in another format. Open the raw diff to inspect it.' : 'These two revisions have identical file contents and modes.';
  return layout(title + ' · ' + source, `${projectHeader(project, 'requests')}<main class="feature-page diff-page">
<nav class="breadcrumbs" aria-label="Location"><a href="${path}">Feature request</a><a href="${back}">${source}</a></nav>
<header class="diff-heading"><h1>${title}</h1></header>
${files.length ? `<div class="diff-overview">${index}${totals}</div><div class="diff-files">${files.map(renderFile).join('')}</div>` : `<p class="diff-empty">${empty}</p>`}
<details class="diff-source"><summary>Revisions and raw diff</summary>${base && revision ? `<p><code>${escape(base)}</code> → <code>${escape(revision)}</code></p>` : ''}<a href="${raw}" download>Download raw diff</a></details></main>`);
}
