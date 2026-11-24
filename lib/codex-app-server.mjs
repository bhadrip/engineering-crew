import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { codexHostEnvironment } from './codex-host-mcp.mjs';

export function readCodexAppServer(requests, { cwd = tmpdir(), env = codexHostEnvironment(), signal, overrides = [],
  clientName = 'engineering_crew_apps' } = {}) {
  if (signal?.aborted) return Promise.resolve(null);
  return new Promise(resolve => {
    const group = process.platform !== 'win32';
    const child = spawn('codex', ['app-server', '--listen', 'stdio://', '--disable', 'plugins', '--disable', 'hooks', ...overrides],
      { cwd, env, detached: group, stdio: ['pipe', 'pipe', 'ignore'] });
    const results = new Map();
    let buffer = '', done = false, answer, killTimer;
    const send = message => child.stdin.write(JSON.stringify(message) + '\n');
    const kill = sig => {
      if (!child.pid) return;
      try { process.kill(group ? -child.pid : child.pid, sig); } catch {}
    };
    function stop(value = null) {
      if (done) return;
      done = true;
      answer = value;
      child.stdin.end();
      kill('SIGTERM');
      killTimer = setTimeout(() => kill('SIGKILL'), 250);
      killTimer.unref();
    }
    const abort = () => stop();
    const timer = setTimeout(abort, 10_000);
    timer.unref();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) stop();
    child.stdin.on('error', abort);
    child.on('error', abort);
    child.on('close', () => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', abort);
      resolve(answer ?? null);
    });
    function consume(line) {
      if (done || !line.trim()) return;
      if (line.length > 8_000_000) return stop();
      let message;
      try { message = JSON.parse(line); } catch { return stop(); }
      if (message.id === 1) {
        if (message.error || !message.result) return stop();
        send({ method: 'initialized', params: {} });
        requests.forEach(([method, params], index) => send({ id: index + 2, method, params }));
      } else if (Number.isInteger(message.id) && message.id >= 2 && message.id <= requests.length + 1) {
        if (message.error || !message.result) return stop();
        results.set(message.id, message.result);
        if (results.size === requests.length) stop(requests.map((_, index) => results.get(index + 2)));
      }
    }
    child.stdout.setEncoding('utf8').on('data', chunk => {
      const lines = (buffer + chunk).split('\n');
      buffer = lines.pop();
      if (buffer.length > 8_000_000) return stop();
      for (const line of lines) consume(line);
    });
    if (!done) send({ id: 1, method: 'initialize', params: {
      clientInfo: { name: clientName, version: '1', title: 'Engineering Crew' },
      capabilities: { experimentalApi: true },
    } });
  });
}
