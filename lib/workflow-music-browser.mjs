import { createHash, randomBytes } from 'node:crypto';
import { createServer, request } from 'node:http';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CrewError, requireField, text } from './contracts.mjs';
import { inspectAppImage, startFeaturePreview } from './feature-app.mjs';
import { readProjectProfile } from './local-profile-file.mjs';
import { captureWorkflowWorkspace, materializeWorkspaceFiles } from './workflow-workspace.mjs';

export const musicBrowserActions = Object.freeze(['open', 'restart', 'inspect', 'wait', 'click', 'fill', 'press', 'sample', 'viewport',
  'observe_media', 'screenshot']);
export const musicBrowserRoles = Object.freeze(['button', 'link', 'textbox', 'checkbox', 'radio', 'tab', 'combobox', 'option', 'slider', 'switch', 'menuitem']);
export const musicBrowserKeys = Object.freeze(['Tab', 'Shift+Tab', 'Enter', 'Space', 'Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']);
const digest = data => createHash('sha256').update(data).digest('hex');
const samplePath = repo => join(repo, '.crew-local', 'assets', 'lesson.wav');
const sampleLimit = 16 * 1024 * 1024;
const viewport = { width: 1280, height: 800 };

export async function pinMusicBrowserProfile(repo) {
  const { image } = await readProjectProfile(repo, 'music-transcribe');
  requireField(image, 'Configure the local Music Transcribe Docker image before enabling its browser.');
  try {
    const [pinned, sample] = await Promise.all([inspectAppImage(image), readFile(samplePath(repo)).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    })]);
    requireField(!sample || sample.length <= sampleLimit, 'The Music Transcribe browser sample exceeds 16 MiB.');
    return { image: pinned, ...(sample && { sampleDigest: digest(sample) }) };
  } catch (error) {
    if (error instanceof CrewError) throw error;
    throw new CrewError('The local Music Transcribe browser image or synthetic sample is unavailable.');
  }
}

export function validateMusicBrowserProfile(profile) {
  requireField(/^sha256:[a-f0-9]{64}$/.test(profile?.image) &&
    (profile.sampleDigest === undefined || /^[a-f0-9]{64}$/.test(profile.sampleDigest)),
  'Pin the Music Transcribe Docker image before enabling its browser.');
}

async function browserSample(repo, profile) {
  requireField(profile.sampleDigest, 'This agent version has no pinned synthetic lesson.');
  const sample = await readFile(samplePath(repo));
  requireField(sample.length <= sampleLimit && digest(sample) === profile.sampleDigest, 'The synthetic lesson changed since this agent version was saved.');
  return sample;
}

async function launchWorkspaceChrome(proxy) {
  const { chromium } = await import('playwright-core');
  try {
    return await chromium.launch({ channel: 'chrome', chromiumSandbox: true, timeout: 10_000,
      args: ['--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
      proxy: { server: proxy.url, bypass: '<-loopback>' } });
  } catch { throw new CrewError('Chrome could not start on the worker. Install Google Chrome with its sandbox available.'); }
}

export async function checkMusicBrowserSetup(repo, profile, signal) {
  validateMusicBrowserProfile(profile);
  const image = await inspectAppImage(profile.image, signal).catch(() => null);
  requireField(image === profile.image, 'The pinned Docker image is unavailable on the worker.');
  if (profile.sampleDigest) await browserSample(repo, profile).catch(error => {
    if (error instanceof CrewError) throw error;
    throw new CrewError('The pinned synthetic lesson is unavailable on the worker.');
  });
  signal?.throwIfAborted();
  const proxy = await browserProxy('http://127.0.0.1:0');
  try {
    const chrome = await launchWorkspaceChrome(proxy);
    await chrome.close();
  } finally { await proxy.close(); }
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return 'http://127.0.0.1:' + server.address().port;
}

async function close(server) {
  const stopped = new Promise(resolve => server.close(resolve));
  server.closeAllConnections();
  await stopped;
}

// Chrome uses this proxy even for loopback traffic. The only upstream is the
// per-attempt Docker relay. Requests, redirects and tunnels to other origins stay local.
async function browserProxy(origin) {
  const target = new URL(origin);
  let blocked = 0;
  const server = createServer((incoming, outgoing) => {
    let url;
    try { url = new URL(incoming.url); } catch {}
    if (url?.origin !== target.origin || url.username || url.password) {
      blocked++;
      incoming.resume();
      return outgoing.writeHead(403).end('Outside the Music Transcribe browser workspace');
    }
    const { 'proxy-connection': _proxy, 'proxy-authorization': _auth, ...headers } = incoming.headers;
    const upstream = request(target, { method: incoming.method, path: url.pathname + url.search, headers: { ...headers, host: target.host } }, response => {
      outgoing.writeHead(response.statusCode, response.headers);
      response.pipe(outgoing);
    });
    outgoing.on('close', () => upstream.destroy());
    upstream.on('error', () => {
      if (!outgoing.headersSent) outgoing.writeHead(502);
      outgoing.end();
    });
    incoming.pipe(upstream);
  });
  const refuse = (_request, socket) => { blocked++; socket.destroy(); };
  server.on('connect', refuse);
  server.on('upgrade', refuse);
  return { url: await listen(server), blocked: () => blocked, close: () => close(server) };
}

async function release(session) {
  if (!session) return;
  await Promise.allSettled([session.browser?.close(), session.proxy?.close(), session.preview?.stop()]);
}

async function launchSession({ profile, files, workspaceDigest, signal, number }) {
  const session = { number, workspaceDigest, consoleErrors: [] };
  const directory = await materializeWorkspaceFiles(files, signal);
  try {
    session.preview = await startFeaturePreview({ projectId: 'music-transcribe', image: profile.image, revision: workspaceDigest,
      snapshotDirectory: directory, durable: false, signal });
    session.proxy = await browserProxy(session.preview.url);
    session.browser = await launchWorkspaceChrome(session.proxy);
    const context = await session.browser.newContext({ viewport, acceptDownloads: false, serviceWorkers: 'block' });
    session.page = await context.newPage();
    session.page.setDefaultTimeout(6_000);
    const addError = message => {
      session.consoleErrors.push(String(message).slice(0, 400).toWellFormed());
      if (session.consoleErrors.length > 10) session.consoleErrors.shift();
    };
    session.page.on('pageerror', error => addError(error.message));
    session.page.on('console', event => { if (event.type() === 'error') addError(event.text()); });
    signal.throwIfAborted();
    return session;
  } catch (error) {
    await release(session);
    await rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

function pageUrl(session, route = '/') {
  requireField(typeof route === 'string' && route.startsWith('/') && route.length <= 800, 'Choose a relative app path starting with /.');
  const url = new URL(route, session.preview.url);
  requireField(url.origin === session.preview.url, 'The browser is scoped to this app.');
  return url;
}

function pageTarget(page, { role, name, occurrence }, allowText) {
  text(name, 'accessible name or visible text', 250);
  requireField(musicBrowserRoles.includes(role) || (allowText && role === undefined), 'Choose a browser role from the tool schema.');
  return targetOccurrence(role ? page.getByRole(role, { name, exact: true }) : page.getByText(name, { exact: true }), occurrence);
}

function targetOccurrence(target, occurrence) {
  if (occurrence === undefined) return target;
  requireField(Number.isInteger(occurrence) && occurrence >= 1 && occurrence <= 100, 'Choose a one-based target occurrence.');
  return target.nth(occurrence - 1);
}

async function observeMedia(page, { media = 'audio', name, occurrence, durationMs = 4_000, click }, signal) {
  requireField(['audio', 'video'].includes(media) && Number.isInteger(durationMs) && durationMs >= 300 && durationMs <= 15_000,
    'Choose audio or video and an observation between 300 and 15,000 milliseconds.');
  const locator = page.locator(media);
  const target = targetOccurrence(name === undefined ? locator : locator.and(page.getByLabel(text(name, 'media label', 250), { exact: true })), occurrence);
  const read = () => target.evaluate(element => ({
    time: Math.round(element.currentTime * 1000) / 1000, rate: element.playbackRate,
    paused: element.paused, readyState: element.readyState, ...(element.error && { errorCode: element.error.code }),
  }));
  let trigger;
  if (click !== undefined) {
    requireField(click && typeof click === 'object', 'Choose an accessible browser control to start the media observation.');
    const control = pageTarget(page, click, false);
    const before = await read();
    signal.throwIfAborted();
    await control.click();
    trigger = { role: click.role, name: click.name, occurrence: click.occurrence, before };
  }
  const started = performance.now();
  const samples = [];
  do {
    signal.throwIfAborted();
    const sample = await read();
    const elapsedMs = Math.round(performance.now() - started);
    samples.push({ elapsedMs, ...sample });
    if (elapsedMs >= durationMs) break;
    await delay(Math.min(150, durationMs - elapsedMs), undefined, { signal });
  } while (samples.length <= 102);
  const rewinds = [];
  let advancingIntervals = 0;
  for (let i = 1; i < samples.length; i++) {
    const before = samples[i - 1], after = samples[i];
    if (before.paused || after.paused || before.errorCode || after.errorCode) continue;
    if (after.time < before.time - 0.05) rewinds.push({ from: before.time, to: after.time, elapsedMs: after.elapsedMs });
    if (after.time > before.time + 0.01) advancingIntervals++;
  }
  return { media, ...(name && { name }), ...(occurrence && { occurrence }), ...(trigger && { trigger }), durationMs, samples,
    advancingIntervals, rewinds };
}

async function usePage(session, input, { repo, profile, signal }) {
  const { page } = session;
  const action = input.action;
  if (['open', 'restart'].includes(action)) {
    const response = await page.goto(pageUrl(session, input.path).href, { waitUntil: 'domcontentloaded' });
    return { httpStatus: response?.status() };
  }
  requireField(new URL(page.url()).origin === session.preview.url, 'Open an app page before interacting with it.');
  if (action === 'click' || action === 'fill') {
    const target = pageTarget(page, input, false);
    if (action === 'click') await target.click();
    else {
      requireField(typeof input.value === 'string' && input.value.length <= 1_000 && !input.value.includes('\0'),
        'Enter a browser field value of up to 1,000 characters.');
      await target.fill(input.value);
    }
  } else if (action === 'wait') {
    const { state = 'visible', timeoutSeconds = 18 } = input;
    requireField(['visible', 'hidden'].includes(state) && Number.isInteger(timeoutSeconds) && timeoutSeconds >= 1 && timeoutSeconds <= 45,
      'Choose visible or hidden and a wait of up to 45 seconds.');
    await pageTarget(page, input, true).waitFor({ state, timeout: timeoutSeconds * 1000 });
  } else if (action === 'press') {
    requireField(musicBrowserKeys.includes(input.key), 'Choose a keyboard key from the tool schema.');
    await page.keyboard.press(input.key);
  } else if (action === 'sample') {
    const sample = await browserSample(repo, profile);
    await page.locator('input[type="file"]').setInputFiles({ name: 'lesson.wav', mimeType: 'audio/wav', buffer: sample });
    return { sampleDigest: profile.sampleDigest };
  } else if (action === 'viewport') {
    const { width, height } = input;
    requireField(Number.isInteger(width) && width >= 320 && width <= 1920 && Number.isInteger(height) && height >= 300 && height <= 1200,
      'Choose a viewport between 320×300 and 1920×1200.');
    await page.setViewportSize({ width, height });
  } else if (action === 'observe_media') {
    return observeMedia(page, input, signal);
  } else if (action === 'screenshot') {
    const screenshot = await page.screenshot({ type: 'jpeg', quality: 75, timeout: 6_000 });
    requireField(screenshot.length <= 1_000_000, 'This screenshot exceeds 1 MB. Use a smaller viewport.');
    return { screenshot };
  }
  return {};
}

export async function openMusicBrowserBridge({ profile, workspace, inputFolder, repo, signal, capture, onResult }) {
  validateMusicBrowserProfile(profile);
  const token = randomBytes(32).toString('hex');
  const closed = new AbortController();
  const activeSignal = signal ? AbortSignal.any([signal, closed.signal]) : closed.signal;
  let active, session, number = 0;
  const cancelBrowser = () => session?.browser?.close().catch(() => {});
  activeSignal.addEventListener('abort', cancelBrowser, { once: true });

  async function run(input) {
    requireField(musicBrowserActions.includes(input?.action), 'Choose a Music Transcribe browser action.');
    const startedAt = new Date().toISOString();
    const report = { kind: 'workspace-browser', action: input.action, startedAt, image: profile.image };
    let screenshot;
    try {
      activeSignal.throwIfAborted();
      if ((input.action === 'open' && !session) || input.action === 'restart') {
        await release(session);
        session = undefined;
        const files = await (capture ? capture(activeSignal) : captureWorkflowWorkspace(workspace, inputFolder, activeSignal));
        requireField(files.some(file => file.path === 'server.mjs'), 'Add server.mjs to the workspace before opening its browser.');
        report.workspaceDigest = digest(JSON.stringify({ schemaVersion: 1, files }));
        session = await launchSession({ profile, files, workspaceDigest: report.workspaceDigest, signal: activeSignal, number: ++number });
      }
      requireField(session, 'Open the workspace browser first.');
      const { screenshot: captured, ...result } = await usePage(session, input, { repo, profile, signal: activeSignal });
      screenshot = captured;
      report.result = result;
      if (['click', 'fill', 'wait'].includes(input.action))
        report.target = { role: input.role, name: input.name, occurrence: input.occurrence,
          ...(input.action === 'wait' && { state: input.state ?? 'visible' }) };
      if (input.action === 'press') report.key = input.key;
      const current = new URL(session.page.url());
      requireField(current.origin === session.preview.url, 'The app navigated outside its workspace. Open a local path to continue.');
      report.path = (current.pathname + current.search + current.hash).slice(0, 800).toWellFormed();
      report.title = (await session.page.title()).slice(0, 250).toWellFormed();
      const snapshot = await session.page.locator('body').ariaSnapshot();
      report.snapshot = snapshot.length <= 9_000 ? snapshot : snapshot.slice(0, 9_000).toWellFormed() + '\n…';
    } catch (error) {
      report.error = error instanceof CrewError ? error.message : String(error.message).split('\n')[0].slice(0, 400).toWellFormed();
    }
    if (session) Object.assign(report, { session: session.number, workspaceDigest: session.workspaceDigest,
      viewport: session.page.viewportSize(), consoleErrors: [...session.consoleErrors], blockedRequests: session.proxy.blocked() });
    report.endedAt = new Date().toISOString();
    activeSignal.throwIfAborted();
    const saved = await onResult(report, screenshot);
    return { ...report, ...saved, ...(screenshot && { screenshot: { data: screenshot.toString('base64'), mimeType: 'image/jpeg' } }) };
  }

  const server = createServer(async (req, res) => {
    const reply = (status, value) => {
      if (!res.destroyed) res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(value));
    };
    if (req.method !== 'POST' || req.url !== '/browser' || req.headers.authorization !== 'Bearer ' + token) {
      req.resume();
      return reply(404, { error: 'Workspace browser is unavailable.' });
    }
    if (active || activeSignal.aborted) {
      req.resume();
      return reply(409, { error: 'The workspace browser is busy or has ended.' });
    }
    active = (async () => {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        requireField(bytes <= 8_000, 'The browser action is too large.');
        chunks.push(chunk);
      }
      const input = JSON.parse(Buffer.concat(chunks));
      return run(input);
    })();
    try { reply(200, await active); }
    catch (error) { reply(400, { error: error instanceof CrewError ? error.message : 'Crew could not complete the browser action.' }); }
    finally { active = undefined; }
  });
  return { connection: { url: await listen(server) + '/browser', token }, async close() {
    closed.abort();
    activeSignal.removeEventListener('abort', cancelBrowser);
    await Promise.allSettled([close(server), active]);
    await release(session);
  } };
}
