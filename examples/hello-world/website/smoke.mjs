import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('catalog source contains its page landmarks, species control, and initial pets', async () => {
  const source = await readFile(new URL('./index.html', import.meta.url), 'utf8');
  assert.match(source, /<main\b/i);
  assert.match(source, /<h1\b[^>]*>Pet catalog<\/h1>/i);
  assert.match(source, /<select\b/i);
  assert.match(source, /\bMochi\b/);
  assert.match(source, /\bPip\b/);
});
