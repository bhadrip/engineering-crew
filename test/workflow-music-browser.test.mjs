import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { inspectAppImage } from '../lib/feature-app.mjs';
import { openMusicBrowserBridge } from '../lib/workflow-music-browser.mjs';

test('the workspace browser uses a fresh candidate, records a screenshot and blocks other origins', {
  skip: process.env.CREW_RUNTIME_BROWSER_TEST !== '1', timeout: 45_000,
}, async t => {
  let unrelatedRequests = 0;
  const unrelated = createServer((_req, res) => { unrelatedRequests++; res.end('outside the assignment'); });
  await new Promise(resolve => unrelated.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => unrelated.close(resolve)));
  const outside = 'http://127.0.0.1:' + unrelated.address().port;
  const workspace = await mkdtemp(join(tmpdir(), 'crew-browser-test-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const pcmBytes = 16_000 * 2 * 0.6;
  const wav = Buffer.alloc(44 + pcmBytes);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16_000, 24);
  wav.writeUInt32LE(32_000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(pcmBytes, 40);
  const app = label => `import { createServer } from 'node:http';
    createServer((req, res) => {
      if (req.url === '/health') return res.end('ok');
      if (req.url === '/outside') return res.writeHead(302, {Location:${JSON.stringify(outside)}}).end();
      if (req.url === '/practice.wav') return res.writeHead(200, {'Content-Type':'audio/wav'}).end(Buffer.from('${wav.toString('base64')}', 'base64'));
      res.setHeader('Content-Type','text/html');
      res.end(${JSON.stringify('<title>Practice fixture</title><h1>' + label + '</h1><button>Loop</button>' +
        '<button onclick="setTimeout(()=>this.textContent=\'Loop on\',250)">Loop</button>' +
        '<input type="file" onchange="document.getElementById(\'status\').textContent=this.files[0].name"><p id="status"></p>' +
        '<audio id="practice" src="/practice.wav" aria-label="Practice recording" loop></audio>' +
        '<button onclick="document.querySelector(\'audio\').playbackRate=.75;document.querySelector(\'audio\').play()">Play recording</button>' +
        '<button onclick="document.querySelector(\'audio\').pause()">Pause recording</button>' +
        '<img src="' + outside + '/request" alt="">')});
    }).listen(3000, '0.0.0.0');`;
  const source = join(workspace, 'server.mjs');
  await writeFile(source, app('First workspace'));
  const fixtures = join(workspace, '.crew-local', 'assets');
  await mkdir(fixtures, { recursive: true });
  const sample = Buffer.from('synthetic browser upload fixture');
  await writeFile(join(fixtures, 'lesson.wav'), sample);
  const image = await inspectAppImage('node:22-alpine');
  const sampleDigest = createHash('sha256').update(sample).digest('hex');
  const saved = [];
  const bridge = await openMusicBrowserBridge({ profile: { image, sampleDigest }, workspace, inputFolder: '.crew-local',
    repo: workspace, signal: AbortSignal.timeout(40_000), onResult(report, screenshot) {
      saved.push({ report, screenshot });
      return { evidenceId: 'evidence-' + saved.length };
    } });
  const { url, token } = bridge.connection;
  const invoke = async (action, rest) => {
    const response = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + token },
      body: JSON.stringify({ action, ...rest }) });
    assert.equal(response.status, 200);
    return response.json();
  };
  try {
    assert.equal((await fetch(url, { method: 'POST' })).status, 404);
    const opened = await invoke('open');
    assert.equal(opened.error, undefined);
    assert.match(opened.snapshot, /heading "First workspace"/);
    assert.equal(opened.result.httpStatus, 200);
    await invoke('click', { role: 'button', name: 'Loop', occurrence: 2 });
    assert.match((await invoke('wait', { role: 'button', name: 'Loop on' })).snapshot, /button "Loop on"/);
    await invoke('sample');
    assert.match((await invoke('inspect')).snapshot, /lesson.wav/);
    assert.deepEqual((await invoke('viewport', { width: 390, height: 800 })).viewport, { width: 390, height: 800 });
    const media = await invoke('observe_media', { name: 'Practice recording', durationMs: 1_500,
      click: { role: 'button', name: 'Play recording' } });
    assert.equal(media.error, undefined);
    assert.equal(media.result.trigger.name, 'Play recording');
    assert.equal(media.result.trigger.before.paused, true);
    assert.ok(media.result.advancingIntervals > 2);
    assert.ok(media.result.rewinds.length >= 1, 'Observe a real loop in the media clock');
    assert.ok(media.result.samples.filter(sample => !sample.paused).every(sample => sample.rate === 0.75));
    await invoke('click', { role: 'button', name: 'Pause recording' });
    const paused = await invoke('observe_media', { durationMs: 300 });
    assert.equal(paused.result.advancingIntervals, 0);
    assert.ok(paused.result.samples.every(sample => sample.paused));
    const screenshot = await invoke('screenshot');
    assert.equal(screenshot.screenshot.mimeType, 'image/jpeg');
    assert.deepEqual(Buffer.from(screenshot.screenshot.data, 'base64'), saved.at(-1).screenshot);
    assert.equal(screenshot.workspaceDigest, opened.workspaceDigest);
    assert.match((await invoke('open', { path: '/outside' })).error, /outside its workspace/);
    assert.equal(unrelatedRequests, 0);
    await writeFile(source, app('Updated workspace'));
    assert.match((await invoke('open')).snapshot, /heading "First workspace"/);
    const restarted = await invoke('restart');
    assert.match(restarted.snapshot, /heading "Updated workspace"/);
    assert.notEqual(restarted.workspaceDigest, opened.workspaceDigest);
    assert.equal(restarted.session, 2);
  } finally { await bridge.close(); }
});
