import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./hello.mjs', import.meta.url));

function runGreeting(...args) {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}

for (const [args, expected] of [
  [[], 'Hello, World!\n'],
  [['Ada'], 'Hello, Ada!\n'],
  [['Ada Lovelace'], 'Hello, Ada Lovelace!\n'],
  [[''], 'Hello, !\n'],
  [['Grace'], 'Hello, Grace!\n'],
  [['--LIST-PETS'], 'Hello, --LIST-PETS!\n'],
  [['--list-pets=all'], 'Hello, --list-pets=all!\n'],
  [[' --list-pets '], 'Hello,  --list-pets !\n'],
]) {
  test(`greets with ${args.length ? JSON.stringify(args[0]) : 'no name'}`, () => {
    const { status, stdout, stderr } = runGreeting(...args);
    assert.equal(status, 0);
    assert.equal(stdout, expected);
    assert.equal(stderr, '');
  });
}

test('lists the ordered fictional pet catalog as JSON with a final newline', () => {
  const { status, stdout, stderr } = runGreeting('--list-pets');
  assert.equal(status, 0);
  assert.equal(stderr, '');
  assert.ok(stdout.endsWith('\n'), 'catalog stdout must end with a newline');
  assert.deepEqual(JSON.parse(stdout), [
    { name: 'Mochi', species: 'cat' },
    { name: 'Pip', species: 'dog' },
  ]);
});

for (const args of [
  ['Ada', 'Lovelace'],
  ['--list-pets', 'extra'],
  ['Ada', '--list-pets'],
  ['Ada', 'Lovelace', 'extra'],
  ['--list-pets', '--list-pets'],
]) {
  test(`rejects extra arguments ${JSON.stringify(args)} and writes usage to stderr`, () => {
    const { status, stdout, stderr } = runGreeting(...args);
    assert.equal(status, 1);
    assert.equal(stdout, '');
    assert.equal(stderr, 'Usage: node hello.mjs [name]\n');
  });
}
