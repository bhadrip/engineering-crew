import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { codexHostEnvironment, codexHostMcpCatalog, referencedMcpEnvironment } from './codex-host-mcp.mjs';
import { projectMcpArgs } from './feature-codex-command.mjs';

const timeoutSeconds = 300;
const startError = 'Codex could not start OAuth sign-in. Check the saved endpoint and its OAuth configuration.';
const finishError = 'OAuth sign-in did not complete. Start a new sign-in to try again.';

async function oauthConfiguration(connection, signal) {
  const env = codexHostEnvironment();
  const host = await codexHostMcpCatalog({ env, signal });
  signal?.throwIfAborted();
  if (!host || host.has(connection.server)) return null;
  for (const name of referencedMcpEnvironment(connection.settings)) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  const overrides = [...[...host.keys()].flatMap(name => ['-c', 'mcp_servers.' + name + '.enabled=false']),
    ...projectMcpArgs([connection])];
  return { env, overrides };
}

export async function projectMcpOAuthStatus(connection) {
  const configuration = await oauthConfiguration(connection);
  if (!configuration) return 'unknown';
  const catalog = await codexHostMcpCatalog(configuration);
  return catalog?.get(connection.server)?.authStatus ?? 'unknown';
}

function authorizationUrl(value) {
  if (typeof value !== 'string' || !URL.canParse(value)) return null;
  const url = new URL(value);
  return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
}

export function startProjectMcpOAuth(connection) {
  const flow = { state: 'starting', cancel: () => finish('cancelled') };
  const controller = new AbortController();
  const group = process.platform !== 'win32';
  let child, killTimer, loginId;
  const running = () => flow.state === 'starting' || flow.state === 'waiting';
  const timer = setTimeout(() => finish('expired'), timeoutSeconds * 1000);
  timer.unref();

  function kill(signal) {
    if (child?.pid) try { process.kill(group ? -child.pid : child.pid, signal); } catch {}
  }
  function finish(state, message) {
    if (!running()) return;
    flow.state = state;
    flow.message = message;
    flow.finishedAt = Date.now();
    delete flow.authorizationUrl;
    clearTimeout(timer);
    controller.abort();
    if (child?.exitCode === null && child.signalCode === null) {
      child.stdin.end();
      kill('SIGTERM');
      killTimer = setTimeout(() => kill('SIGKILL'), 500);
      killTimer.unref();
    }
  }

  async function launch() {
    const configuration = await oauthConfiguration(connection, controller.signal);
    if (!running()) return;
    if (!configuration) return finish('failed', startError);
    child = spawn('codex', ['app-server', '--listen', 'stdio://', '--disable', 'plugins', '--disable', 'apps', '--disable', 'hooks',
      ...configuration.overrides], {
      cwd: tmpdir(), env: configuration.env, detached: group, stdio: ['pipe', 'pipe', 'ignore'],
    });
    const send = message => child.stdin.write(JSON.stringify(message) + '\n');
    const failed = () => finish('failed', flow.state === 'starting' ? startError : finishError);
    let pending = '';
    function consume(raw) {
      if (!running()) return;
      let message;
      try { message = JSON.parse(raw); } catch { return; }
      if (message.id === 1) {
        if (message.error || !message.result) return failed();
        send({ method: 'initialized', params: {} });
        send({ id: 2, method: 'mcpServer/oauth/login', params: { name: connection.server, timeoutSecs: timeoutSeconds } });
      } else if (message.id === 2) {
        const url = authorizationUrl(message.result?.authorizationUrl);
        if (message.error || !url) return failed();
        loginId = message.result.loginId;
        flow.authorizationUrl = url;
        flow.state = 'waiting';
      } else if (message.method === 'mcpServer/oauthLogin/completed') {
        const result = message.params;
        if (flow.state !== 'waiting' || result?.name !== connection.server || result.threadId != null ||
            (loginId != null && result.loginId !== loginId)) return;
        if (result.success === true) finish('connected');
        else failed();
      }
    }
    child.stdout.setEncoding('utf8').on('data', chunk => {
      const lines = (pending + chunk).split('\n');
      pending = lines.pop();
      if (pending.length > 1_000_000) return failed();
      for (const line of lines) if (line.trim()) consume(line);
    });
    child.stdin.on('error', failed);
    child.on('error', failed);
    child.on('close', () => {
      clearTimeout(killTimer);
      failed();
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'engineering_crew_mcp_oauth', title: 'Engineering Crew', version: '1' } } });
  }
  launch().catch(() => finish('failed', startError));
  return flow;
}
