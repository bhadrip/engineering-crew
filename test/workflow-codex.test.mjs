import assert from 'node:assert/strict';
import { chmod, copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { executeWorkflowCodex } from '../lib/workflow-codex.mjs';
import { validateWorkflowSkills } from '../lib/workflow-skills.mjs';
import { workflowNativeSettings } from '../lib/workflow-native.mjs';
import { artifactDigest } from '../lib/run-store.mjs';
import { codexGeneratedImage } from '../lib/agent-images.mjs';

test('a versioned agent uses selected MCP tools and its pinned skill during one Codex turn', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'crew-workflow-codex-test-'));
  const executable = join(directory, 'codex');
  await copyFile(new URL('../test-support/workflow-codex-fixture.mjs', import.meta.url), executable);
  await chmod(executable, 0o700);
  const path = process.env.PATH;
  process.env.PATH = directory + ':' + path;
  t.after(() => { process.env.PATH = path; return rm(directory, { recursive: true, force: true }); });
  const job = {
    task: { id: 'plan', outputs: [{ id: 'result', kind: 'markdown' }], budget: { timeoutSeconds: 10 } },
    profile: { id: 'planner', name: 'Lesson planner', remit: 'Plan playback acceptance',
      codexTools: ['list_inputs', 'read_input', 'search_inputs'], skillNames: ['Timing checks'],
      codexRuntime: { workspace: 'workspace-write', webSearch: 'cached', reasoningEffort: 'high' } },
    instructions: ['Report evidence.', '---\nname: timing-checks\ndescription: Verify lesson boundaries\n---\nChoose timing evidence.'],
    skillBundles: [{ directory: 'timing-checks', files: [
      { path: 'references/notes.md', data: Buffer.from('Use a slow tāḷa sample.').toString('base64') },
      { path: 'assets/calibration.bin', data: Buffer.from([0, 1, 244, 255]).toString('base64') },
    ] }],
    inputs: [{ id: 'input-brief', title: 'Lesson brief', kind: 'text', content: 'Verify timing along the full rendition.' }],
    model: 'gpt-6-luna', signal: AbortSignal.timeout(10_000),
  };
  const observedActivity = [];
  const response = await executeWorkflowCodex({ ...job, task: { ...job.task, captureWorkspace: true },
    workspaceFiles: [{ path: 'song.txt', mode: '100644', data: Buffer.from('Committed notation').toString('base64') }],
    onAgentActivity: entry => observedActivity.push(entry) });
  assert.equal(response.outcome, 'completed', response.error);
  assert.deepEqual(response.workspaceFiles.map(file => [file.path, Buffer.from(file.data, 'base64').toString()]), [
    ['song.txt', 'Committed notation'], ['timing-notes.txt', 'Reviewed input-brief'],
  ]);
  assert.match(response.response.summary, /Timing checks/);
  assert.equal(response.receipt.usage.total, 26);
  assert.doesNotMatch(response.activity.prompt, /Verify timing along the full rendition/);
  assert.deepEqual(response.activity.toolCalls.map(call => call.tool), [
    'list_inputs', 'search_inputs', 'read_input', 'read_skill', 'read_skill_file', 'read_skill_file',
    'command_execution', 'file_change', 'web_search',
  ]);
  assert.ok(response.activity.toolCalls.every(call => call.status === 'completed'));
  assert.equal(response.activity.toolCalls.find(call => call.tool === 'command_execution').shell, undefined);
  assert.equal(response.receipt.toolPolicy.commandEvidence, undefined);
  assert.deepEqual(response.activity.timeline, observedActivity);
  assert.deepEqual(response.activity.timeline.filter(entry => entry.kind === 'message').map(entry => entry.text), [
    'I’ll inspect the <timing notes> first.', 'I found the pinned timing evidence.',
  ]);
  assert.deepEqual(response.activity.timeline.slice(0, 5).map(entry => entry.call?.tool ?? entry.kind),
    ['message', 'list_inputs', 'search_inputs', 'read_input', 'message']);
  assert.ok(response.activity.timeline.every(entry => Number.isFinite(Date.parse(entry.at))));
  assert.ok(response.activity.launch.args.some(argument => argument.startsWith('mcp_servers.crew_workflow.args=') && argument.includes('$RUN_DIR')));
  assert.ok(response.activity.launch.args.includes('model_reasoning_effort="high"'));
  assert.equal(response.receipt.toolPolicy.workspace, 'workspace-write');
  assert.equal(response.receipt.toolPolicy.writableScratch, true);
  const firstBuild = await executeWorkflowCodex({ ...job, task: { ...job.task, captureWorkspace: true }, workspaceFiles: [],
    profile: { ...job.profile, codexRuntime: { ...job.profile.codexRuntime, commandEvidence: true } },
    inputs: [{ ...job.inputs[0], provenance: { source: 'workflow-request' } }] });
  assert.equal(firstBuild.outcome, 'completed', firstBuild.error);
  assert.match(firstBuild.activity.prompt, /operator’s request brief \(input-brief\) defines the requested outcome/);
  assert.match(firstBuild.activity.prompt, /starting workspace contains no project files[\s\S]+create the source and tests/);
  assert.doesNotMatch(response.activity.prompt, /starting workspace contains no project files/);
  assert.equal(firstBuild.receipt.toolPolicy.commandEvidence, true);
  const { shell } = firstBuild.activity.toolCalls.find(call => call.tool === 'command_execution');
  assert.deepEqual(shell, { command: 'node --test $RUN_DIR/workspace/test.mjs', exitCode: 0, durationMs: 12,
    output: 'x'.repeat(3986) + '\nTests passed\n', outputTruncated: true });
  assert.deepEqual(firstBuild.activity.timeline.find(entry => entry.call?.tool === 'command_execution').call.shell, shell);
  const executeWith = mcpServers => executeWorkflowCodex({ ...job,
    profile: { ...job.profile, codexRuntime: { ...job.profile.codexRuntime, mcpServers } },
  });
  const connected = await executeWith(['lesson-timing']);
  assert.equal(connected.outcome, 'completed', connected.error);
  assert.deepEqual(connected.receipt.toolPolicy.codexMcpServers, ['lesson-timing']);
  assert.equal(connected.receipt.toolProtocol, 'crew_workflow_inputs');
  assert.deepEqual(connected.activity.toolCalls.at(-1), { server: 'lesson-timing', tool: 'inspect_tempo', status: 'completed' });
  const unavailable = await executeWith(['unused-server']);
  assert.equal(unavailable.outcome, 'execution-failed');
  assert.match(unavailable.error, /unused-server is unavailable/);
  assert.equal(unavailable.receipt, undefined);
  const plugin = await executeWorkflowCodex({ ...job, profile: { ...job.profile,
    codexRuntime: { ...job.profile.codexRuntime, plugins: ['tempo@crew-fixture'], pluginEnv: ['TIMING_PLUGIN_TOKEN'] } },
  });
  assert.equal(plugin.outcome, 'completed', plugin.error);
  assert.deepEqual(plugin.activity.codexPlugins, [{ id: 'tempo@crew-fixture', version: '1.2.0' }]);
  assert.deepEqual(plugin.receipt.toolPolicy.pluginEnvironment, ['TIMING_PLUGIN_TOKEN']);
  assert.deepEqual(plugin.activity.toolCalls.at(-1), { server: 'tempo-fixture', tool: 'tempo_tool', source: 'plugin', status: 'completed' });
  const attached = [{ id: 'connector_music_fixture', name: 'Music Notes' }];
  const app = await executeWorkflowCodex({ ...job, profile: { ...job.profile, codexRuntime: { ...job.profile.codexRuntime, apps: attached } } });
  assert.equal(app.outcome, 'completed', app.error);
  assert.deepEqual(app.receipt.toolPolicy.codexApps, attached);
  assert.deepEqual(app.activity.codexApps, attached);
  assert.deepEqual(app.activity.toolCalls.at(-1),
    { server: 'codex_apps', tool: 'music_notes.read_excerpt', source: 'app', appId: attached[0].id, status: 'completed' });
  const unavailableApp = await executeWorkflowCodex({ ...job, profile: { ...job.profile, codexRuntime: { ...job.profile.codexRuntime,
    apps: [{ id: 'connector_blocked_fixture', name: 'Blocked Notes' }] } } });
  assert.equal(unavailableApp.outcome, 'execution-failed');
  assert.match(unavailableApp.error, /Blocked Notes is unavailable/);
  const delegation = { maxConcurrent: 2, model: 'gpt-6-luna', reasoningEffort: 'low' };
  const subagentRoles = [{ name: 'rhythm_reviewer', description: 'Review the timing independently.',
    instructions: 'Use the slow tāḷa reference.\nGive feedback.', model: 'gpt-6-luna', reasoningEffort: 'medium' }];
  const native = await executeWorkflowCodex({ ...job, profile: { ...job.profile, codexRuntime: {
    ...job.profile.codexRuntime, imageInspection: true, delegation, subagentRoles,
  } } });
  assert.equal(native.outcome, 'completed', native.error);
  assert.deepEqual(native.activity.delegation, delegation);
  assert.deepEqual(native.activity.subagentRoles, ['rhythm_reviewer']);
  assert.ok(native.activity.launch.args.includes('agents.rhythm_reviewer.config_file="$RUN_DIR/subagents/rhythm_reviewer.toml"'));
  assert.equal(native.receipt.toolPolicy.imageInspection, true);
  assert.deepEqual(native.activity.toolCalls.slice(-2).map(({ tool, status, source, subagentIds }) => [tool, status, source, subagentIds]), [
    ['spawn_agent', 'completed', 'subagent', ['31c8f914-2370-45ee-8e60-a62bbf6680bd']],
    ['wait', 'incomplete', 'subagent', ['31c8f914-2370-45ee-8e60-a62bbf6680bd']],
  ]);
  assert.throws(() => workflowNativeSettings({ ...job.profile.codexRuntime, workspace: 'tools', imageInspection: true }), /requires a read-only or editable workspace/);
  assert.throws(() => workflowNativeSettings({ ...job.profile.codexRuntime, workspace: 'tools', commandEvidence: true }), /requires a read-only or editable workspace/);
  assert.throws(() => workflowNativeSettings({ ...job.profile.codexRuntime, delegation: { maxConcurrent: 0 } }), /positive concurrency/);
  assert.throws(() => workflowNativeSettings({ ...job.profile.codexRuntime, subagentRoles: [subagentRoles[0], subagentRoles[0]] }), /distinct name/);
  assert.throws(() => workflowNativeSettings({ ...job.profile.codexRuntime, subagentRoles: [{ ...subagentRoles[0], name: 'enabled' }] }), /another|other than a Codex setting/);
  await t.test('Music Transcribe uses App Server for both native conversation and structured workflow output', async () => {
    const { task, model } = job;
    const { name, remit, id } = job.profile;
    const prompt = 'Write the timing notes.';
    const steps = { task, model, projectId: 'music-transcribe', signal: AbortSignal.timeout(10_000),
      profile: { id, name, remit, codexTools: [], skillNames: [], codexRuntime: workflowNativeSettings() },
      instructions: ['Use the pinned practice notes.'],
      inputs: [{ id: 'input-brief', title: 'Message', kind: 'text', content: prompt }] };
    const updates = [];
    const direct = await executeWorkflowCodex({ ...steps, standaloneAgent: true, onAgentActivity: entry => updates.push(entry) });
    const markdown = '# Timing notes\n\nRepeat the phrase slowly.';
    assert.equal(direct.outcome, 'completed', direct.error);
    assert.equal(direct.activity.launch.args[0], 'app-server');
    assert.equal(direct.activity.prompt, prompt);
    assert.equal(direct.activity.response, markdown);
    assert.equal(direct.response, markdown);
    assert.deepEqual(updates, [{ kind: 'reply', text: markdown, itemId: 'reply', truncated: false }]);
    const workflow = await executeWorkflowCodex(steps);
    assert.equal(workflow.outcome, 'completed', workflow.error);
    assert.equal(workflow.activity.launch.args[0], 'app-server');
    assert.equal(workflow.response.outputs[0].content, 'Repeat the phrase slowly.');
    const speedTurn = serviceTier => executeWorkflowCodex({ ...steps, profile: { ...steps.profile,
      codexRuntime: workflowNativeSettings({ ...steps.profile.codexRuntime, serviceTier }) } });
    const fast = await speedTurn('priority');
    assert.equal(fast.outcome, 'completed', fast.error);
    assert.deepEqual(fast.receipt.codexSpeed, { requested: 'priority', applied: 'priority' });
    assert.equal(fast.activity.launch.thread.serviceTier, 'priority');
    assert.equal(fast.receipt.reportedModel, steps.model);
    const unavailable = await speedTurn('ultrafast');
    assert.equal(unavailable.outcome, 'execution-failed');
    assert.match(unavailable.error, /did not apply the requested Ultrafast speed/);
    assert.deepEqual(unavailable.receipt.codexSpeed, { requested: 'ultrafast', applied: null });
    assert.equal(unavailable.receipt.turnId, undefined);
    const generated = [];
    const imageTurn = await executeWorkflowCodex({ ...steps, standaloneAgent: true,
      profile: { ...steps.profile, codexRuntime: workflowNativeSettings({ ...steps.profile.codexRuntime, imageGeneration: true }) },
      onGeneratedImage: ({ itemId, encoded }) => {
        const image = codexGeneratedImage(encoded, generated.length + 1);
        const saved = { itemId, ...image };
        delete saved.data;
        generated.push(saved);
        return saved;
      },
    });
    assert.equal(imageTurn.outcome, 'completed', imageTurn.error);
    assert.equal(imageTurn.receipt.toolPolicy.imageGeneration, true);
    assert.deepEqual(imageTurn.activity.toolCalls.map(call => [call.tool, call.status]), [
      ['image_generation', 'completed'], ['image_generation', 'completed'],
    ]);
    assert.equal(generated.length, 1);
    assert.equal(generated[0].mimeType, 'image/png');
    assert.equal(generated[0].itemId, 'native-image');
    assert.deepEqual(imageTurn.activity.toolCalls[0].generatedImage, generated[0]);
    assert.match(imageTurn.activity.toolCalls[1].imageSaveError, /valid image bytes/);
    assert.doesNotMatch(JSON.stringify(imageTurn.activity), /iVBOR|not-accessed/);
    const freeFormTask = { ...task, responseMode: 'free-form', objective: 'Prepare timing evidence.',
      outputs: [{ id: 'next-route', kind: 'json', required: true }] };
    const checkpoints = [];
    const nativeWorkflow = (extra, controls) => executeWorkflowCodex({ ...steps,
      task: { ...freeFormTask, ...extra }, inputs: [{ ...steps.inputs[0], provenance: { source: 'workflow-request' } }],
      sessionControls: controls,
      onCodexCheckpoint: async event => {
        await new Promise(resolve => setImmediate(resolve));
        checkpoints.push(event);
      },
      signal: AbortSignal.timeout(10_000) });
    const submitted = await nativeWorkflow();
    assert.equal(submitted.outcome, 'completed', submitted.error);
    assert.equal(submitted.response, markdown);
    assert.deepEqual(submitted.submitted.outputs, [{ slot: 'next-route', content: '{"route":"practice"}' }]);
    assert.equal(submitted.activity.responseFormat, 'free-form');
    assert.deepEqual(submitted.activity.workflowSubmissions, submitted.submitted);
    assert.deepEqual(submitted.activity.toolCalls.map(({ tool, status }) => [tool, status]), [
      ['submit_workflow_output', 'failed'], ['submit_workflow_output', 'failed'],
      ['submit_workflow_output', 'completed'], ['submit_workflow_output', 'completed'],
    ]);
    assert.deepEqual(submitted.receipt.submittedOutputDigests, { 'next-route': artifactDigest('{"route":"practice"}') });
    assert.deepEqual(checkpoints.map(event => event.kind), ['launch', 'submission', 'submission', 'final']);
    assert.equal(checkpoints[2].output.content, '{"route":"practice"}');
    assert.equal(checkpoints[3].text, markdown);
    const blocked = await nativeWorkflow({ objective: 'Record a blocker.', outputFollowUps: 1 });
    assert.equal(blocked.outcome, 'completed', blocked.error);
    assert.deepEqual(blocked.submitted, { outputs: [], blocker: { reason: 'The timing source is missing.',
      resource: { action: 'supply-recording', target: 'lesson-sample', reason: 'The timing source is missing.' } } });
    assert.equal(blocked.receipt.outputFollowUps, undefined);

    checkpoints.length = 0;
    const turns = [];
    const completedTurns = [];
    const controls = {
      ready: identity => turns.push(identity),
      next: () => null,
      endTurn: turnId => { completedTurns.push(turnId); return false; },
    };
    const recovered = await nativeWorkflow({ objective: 'Recover a partial handoff.', outputFollowUps: 1,
      outputs: [...freeFormTask.outputs, { id: 'required-report', kind: 'json', required: true },
        { id: 'optional-report', kind: 'json', required: false }] }, controls);
    assert.equal(recovered.outcome, 'completed', recovered.error);
    assert.deepEqual(turns, [{ threadId: 'fixture-thread', turnId: 'fixture-turn' },
      { threadId: 'fixture-thread', turnId: 'fixture-turn-2' }]);
    assert.deepEqual(completedTurns, ['fixture-turn', 'fixture-turn-2']);
    assert.equal(recovered.receipt.threadId, 'fixture-thread');
    assert.equal(recovered.receipt.turnId, 'fixture-turn-2');
    const [followUp] = recovered.activity.outputFollowUps;
    assert.deepEqual(followUp.missingOutputs, ['required-report']);
    assert.equal(followUp.previousReply.text, markdown);
    assert.deepEqual(recovered.submitted.outputs, [{ slot: 'next-route', content: '{"turn":1}' },
      { slot: 'required-report', content: '{"turn":2}' }]);
    assert.deepEqual(checkpoints.map(event => event.kind), ['launch', 'submission', 'follow-up', 'submission', 'final']);
    assert.equal(checkpoints[2].prompt, followUp.prompt);

    const exhausted = await nativeWorkflow({ objective: 'Leave required outputs missing.', outputFollowUps: 2 });
    assert.equal(exhausted.outcome, 'completed', exhausted.error);
    assert.deepEqual(exhausted.submitted.outputs, []);
    assert.deepEqual(exhausted.receipt.outputFollowUps.map(turn => [turn.previousTurnId, turn.turnId]),
      [['fixture-turn', 'fixture-turn-2'], ['fixture-turn-2', 'fixture-turn-3']]);
    const stopped = await nativeWorkflow({ objective: 'Leave required outputs missing.', outputFollowUps: 1 },
      { ...controls, endTurn: () => true });
    assert.equal(stopped.outcome, 'completed', stopped.error);
    assert.equal(stopped.receipt.turnId, 'fixture-turn');
    assert.equal(stopped.receipt.outputFollowUps, undefined);
  });
});

test('skill packages reject traversal, aliased paths and invalid byte encodings before staging', () => {
  const data = Buffer.from('Timing notes').toString('base64');
  const packages = files => [{ name: 'Timing checks', content: '# Timing', bundle: { directory: 'timing', files } }];
  assert.deepEqual(validateWorkflowSkills(packages([{ path: 'references/notes.md', data }])), packages([{ path: 'references/notes.md', data }]));
  for (const files of [
    [{ path: '../notes.md', data }],
    [{ path: 'references/.git/config', data }],
    [{ path: 'skill.md', data }],
    [{ path: 'refs', data }, { path: 'refs/notes.md', data }],
    [{ path: 'Refs/north.md', data }, { path: 'refs/south.md', data }],
    [{ path: 'references/notes.md', data: data + '!' }],
  ]) assert.throws(() => validateWorkflowSkills(packages(files)), { code: 2 });
});
