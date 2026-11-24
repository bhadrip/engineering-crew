import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { runMusicPracticeChecks } from './workflow-music-checks.mjs';

// Keep Docker and the pinned fixture in the Crew worker. The stdio MCP process
// can ask for a check, but cannot pass a command, fixture name, or filesystem path.
export async function openMusicPracticeBridge({ profile, workspace, inputFolder, repo, signal, onResult, capture }) {
  const token = randomBytes(32).toString('hex');
  const closed = new AbortController();
  const checkSignal = signal ? AbortSignal.any([signal, closed.signal]) : closed.signal;
  let active;
  const reply = (res, status, value) => {
    if (res.destroyed) return;
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(value));
  };
  const server = createServer((req, res) => {
    req.resume();
    if (req.method !== 'POST' || req.url !== '/check' || req.headers.authorization !== 'Bearer ' + token)
      return reply(res, 404, { error: 'Development check is unavailable.' });
    if (active) return reply(res, 409, { error: 'A development check is already running for this assignment.' });
    if (checkSignal.aborted) return reply(res, 409, { error: 'This assignment has ended.' });
    const request = new AbortController();
    res.once('close', () => request.abort());
    const deadline = AbortSignal.any([checkSignal, request.signal]);
    active = (async () => {
      try {
        const receipt = await runMusicPracticeChecks({ profile, workspace, inputFolder, repo, signal: deadline, capture });
        const evidenceId = await onResult(receipt);
        const { workspaceFiles, ...summary } = receipt;
        reply(res, 200, { ...summary, evidenceId });
      } catch (error) {
        reply(res, 400, { error: String(error.message).slice(0, 500) });
      }
    })().finally(() => { active = undefined; });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    connection: { url: 'http://127.0.0.1:' + server.address().port + '/check', token },
    async close() {
      closed.abort();
      const stopped = new Promise(resolve => server.close(resolve));
      server.closeAllConnections();
      await Promise.allSettled([stopped, active]);
    },
  };
}
