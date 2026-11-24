import test from 'node:test';
import assert from 'node:assert/strict';
import { featureDiffPage } from '../ui/feature-diff.mjs';

const project = { id: 'music', name: 'Music', featureOnly: true };
const request = { id: 'lesson-replay' };
function page(lines, options = {}) {
  return featureDiffPage(project, request, { collection: 'attempts', number: 2, diff: lines.join('\n'), ...options });
}

test('multiple files and hunks have independent counters, accurate totals and reachable file headers', () => {
  const html = page([
    'diff --git a/my file.txt b/my file.txt', '--- a/my file.txt\t', '+++ b/my file.txt\t',
    '@@ -2,2 +2,3 @@', ' keep this', '-old', '+new', '+  keep trailing spaces  ',
    '@@ -12 +13 @@ <function>', '---removed', '+++added', '\\ No newline at end of file',
    'diff --git a/start.js b/start.js', 'new file mode 100644', '--- /dev/null', '+++ b/start.js',
    '@@ -0,0 +1 @@', '+hello',
  ]);
  assert.match(html, /2 files changed/);
  assert.match(html, /<details class="diff-file" id="diff-file-1" open>/);
  assert.match(html, /<details class="diff-file" id="diff-file-2">/);
  assert.match(html, /href="#diff-file-2"><code>start\.js/);
  assert.match(html, /<\/details><span class="diff-totals"><span class="diff-add-count">\+4<[^]*?class="diff-remove-count">−2</);
  assert.match(html, />my file\.txt<\/code>/);
  assert.match(html, /data-kind="context"><td class="diff-old">2<\/td><td class="diff-new">2</);
  assert.match(html, /data-kind="remove"><td class="diff-old">12<\/td><td class="diff-new"><\/td><td class="diff-mark">-<\/td><td class="diff-code"><code>--removed</);
  assert.match(html, /data-kind="add"><td class="diff-old"><\/td><td class="diff-new">13<\/td><td class="diff-mark">\+<\/td><td class="diff-code"><code>\+\+added</);
  assert.match(html, /<code>  keep trailing spaces  <\/code>/);
  assert.match(html, /data-kind="note">[^]*?No newline at end of file/);
  assert.match(html, /@@ -12 \+13 @@ &lt;function&gt;/);
  assert.match(html, /href="\/projects\/music\/requests\/lesson-replay#stage-attempt-2"/);
  assert.match(html, /href="\/projects\/music\/requests\/lesson-replay\/attempts\/2\.diff" download/);
});

test('empty, binary, renamed, copied and metadata-only files are identified without inventing text edits', () => {
  const html = page([
    'diff --git a/empty b/empty', 'deleted file mode 100644', 'index e69de29..0000000',
    'diff --git a/test b/file.txt b/test b/file.txt', 'new file mode 100644', 'index 0000000..e69de29',
    'diff --git a/bin.dat b/bin.dat', 'Binary files a/bin.dat and b/bin.dat differ',
    'diff --git a/old name b/new name', 'similarity index 100%', 'rename from old name', 'rename to new name',
    'diff --git a/old name b/copy name', 'similarity index 100%', 'copy from old name', 'copy to copy name',
    'diff --git a/run b/run', 'old mode 100644', 'new mode 100755',
  ], { collection: 'events', number: '42' });
  assert.match(html, /6 files changed/);
  assert.match(html, /empty<\/code><span class="diff-file-status">Deleted/);
  assert.match(html, /test b\/file\.txt<\/code><span class="diff-file-status">Added/);
  assert.match(html, /old name → new name<\/code><span class="diff-file-status">Renamed/);
  assert.match(html, /old name → copy name<\/code><span class="diff-file-status">Copied/);
  assert.match(html, /old mode 100644 · new mode 100755/);
  assert.match(html, /Binary file changed/);
  assert.match(html, /Empty file\./);
  assert.doesNotMatch(html, /class="diff-line"/);
  assert.match(html, /href="\/projects\/music\/requests\/lesson-replay#event-42"/);
  assert.match(html, /href="\/projects\/music\/requests\/lesson-replay\/events\/42\.diff" download/);
});

test('quoted, non-ASCII, control and HTML characters in Git paths, hunk labels and code stay literal', () => {
  const path = String.raw`A\t\303\251 \"name\"<script>.txt`;
  const html = page([
    `diff --git "a/${path}" "b/${path}"`, `--- "a/${path}"`, `+++ "b/${path}"`,
    '@@ -1 +1 @@ <svg onload=bad>', '-before', '+</td><img src=x onerror=bad>',
  ]);
  assert.ok(html.includes('A\\té &quot;name&quot;&lt;script&gt;.txt'));
  assert.match(html, /&lt;svg onload=bad&gt;/);
  assert.match(html, /&lt;\/td&gt;&lt;img src=x onerror=bad&gt;/);
  assert.doesNotMatch(html, /<svg onload|<img src=x|<script>\.txt/);
  assert.throws(() => page([], { number: '2/../../secrets' }), /Invalid diff location/);
  assert.throws(() => page([], { collection: '../' }), /Invalid diff location/);
});

test('an empty diff distinguishes identical trees from an unsupported patch format', () => {
  assert.match(page([]), /identical file contents and modes/);
  const unknown = page(['non-unified custom diff']);
  assert.match(unknown, /another format/);
  assert.doesNotMatch(unknown, /identical file contents/);
});
