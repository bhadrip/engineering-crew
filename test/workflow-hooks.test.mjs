import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import test from 'node:test';
import { codexHostEnvironment } from '../lib/codex-host-mcp.mjs';
import { codexLaunch } from '../lib/feature-codex-command.mjs';
import { prepareWorkflowHooks, reviewWorkflowHooks, workflowHooksJson } from '../lib/workflow-hooks.mjs';

const definition = command => ({ description: 'Timing review', hooks: {
  SessionStart: [{ matcher: '^startup$', hooks: [{ type: 'command', command, timeout: 5 }] }],
  PostToolUse: [{ matcher: '^Bash$', hooks: [{ type: 'mcp_tool', server: 'timing', tool: 'inspect',
    input: { command: '${tool_input.command}' } }] }],
} });

test('a new or edited hook definition requires review before invoking native validation', async () => {
  const config = definition('printf original');
  await assert.rejects(reviewWorkflowHooks(JSON.stringify(config), null, false), /Review and trust/);
  await assert.rejects(reviewWorkflowHooks('{"state":{}}', null, true), /hooks.json object/);
  await assert.rejects(reviewWorkflowHooks(JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'prompt' }] }] } }),
    null, true), /command or MCP tool/);
});

const cli = process.env.CREW_TEST_NATIVE_CODEX;
test('native Codex verifies saved hook hashes and scopes unselected host hooks', { skip: !cli }, async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'crew-native-hooks-test-'));
  const path = process.env.PATH;
  process.env.PATH = dirname(cli) + delimiter + path;
  t.after(() => { process.env.PATH = path; return rm(cwd, { recursive: true, force: true }); });
  const config = definition('printf original');
  const hooks = await reviewWorkflowHooks(JSON.stringify(config), null, true);
  assert.deepEqual(JSON.parse(workflowHooksJson(hooks)), config);
  assert.deepEqual(await reviewWorkflowHooks(workflowHooksJson(hooks), hooks, false), hooks);
  const edited = definition('printf edited');
  await assert.rejects(reviewWorkflowHooks(JSON.stringify(edited), hooks, false), /Review and trust/);
  await assert.rejects(reviewWorkflowHooks(JSON.stringify({ hooks: { FutureEvent: config.hooks.SessionStart } }), null, true),
    /could not load every hook|Could not read hooks/);
  const options = { cwd, env: { ...codexHostEnvironment(), CODEX_HOME: cwd }, pluginOverrides: ['--disable', 'plugins'] };
  const host = { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'printf host' }] }] } };
  await writeFile(join(cwd, 'hooks.json'), JSON.stringify(host));
  await assert.rejects(prepareWorkflowHooks({ hooks: { ...hooks, events: edited.hooks } }, options), /could not verify the pinned hook/);
  const hookSetup = await prepareWorkflowHooks({ hooks }, options);
  assert.equal(hookSetup.disabledHooks.length, 1);
  assert.match(hookSetup.disabledHooks[0], /hooks\.json:session_start:0:0$/);
  assert.deepEqual((await prepareWorkflowHooks({ hooks, hostHooks: true }, options)).disabledHooks, []);
  const launch = codexLaunch({ nativeCapabilities: { hookSetup }, approval: 'never', sandbox: 'read-only', enabledFeatures: ['hooks'],
    disabledFeatures: [], webSearch: 'disabled', projectDocMaxBytes: 0, reasoningEffort: 'medium' }, '$RUN_DIR');
  assert.ok(launch.args.some(arg => arg.startsWith('hooks.SessionStart=') && arg.includes('printf original')));
  assert.ok(launch.args.some(arg => arg.startsWith('hooks.state=') && arg.includes('"enabled"=false') &&
    hooks.trust.every(({ hash }) => arg.includes(hash))));
  assert.ok(!launch.args.includes('--dangerously-bypass-hook-trust'));
});
