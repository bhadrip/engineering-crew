import { randomUUID } from 'node:crypto';
import { codexHostAppCatalog } from './codex-host-apps.mjs';
import { codexHostMcpCatalog } from './codex-host-mcp.mjs';
import { codexHostPluginCatalog } from './codex-host-plugins.mjs';
import { CrewError } from './contracts.mjs';
import { codexModelCatalog } from './feature-codex.mjs';
import { checkProjectMcp } from './project-mcp-check.mjs';
import { loadProject } from './project-store.mjs';
import { checkMusicBrowserSetup } from './workflow-music-browser.mjs';
import { checkMusicAudioSetup } from './workflow-music-checks.mjs';
import { codexServiceTierLabel, limitedExecution } from './workflow-native.mjs';

export function workflowSetupProfiles(snapshot) {
  const { profiles, tasks, runtime } = snapshot.project;
  const assigned = new Set(tasks.flatMap(task => [task.profileId, ...(task.alternateProfiles ?? [])]));
  return profiles.filter(profile => assigned.has(profile.id)).map(profile => ({
    id: profile.id, name: profile.name, model: profile.model ?? runtime.model,
    origin: snapshot.agentOrigins?.[profile.id],
    runtime: snapshot.agentOrigins?.[profile.id]?.codexRuntime ?? limitedExecution,
  }));
}

const row = (label, state, detail) => ({ label, state, detail });
const ready = (label, detail) => row(label, 'ready', detail);
const attention = (label, detail) => row(label, 'attention', detail);
const unverified = (label, detail) => row(label, 'unverified', detail);
const loginRequired = state => typeof state === 'string' && state.toLowerCase().replaceAll('_', '') === 'notloggedin';

async function checkConnection(connection, signal) {
  const label = connection.name + ' · v' + connection.version;
  let checked;
  try { checked = await checkProjectMcp(connection, { signal }); }
  catch { return unverified(label, 'Worker could not check this MCP connection.'); }
  if (checked.missingEnv?.length)
    return attention(label, 'Missing worker environment variables ' + checked.missingEnv.join(', '));
  if (checked.state === 'sign-in-required') return attention(label, 'Sign in to this MCP connection on the worker.');
  if (checked.state === 'name-conflict') return attention(label, 'The connection name conflicts with the worker MCP configuration.');
  if (checked.state === 'checked') {
    const count = checked.tools.length;
    return count ? ready(label, count + (count === 1 ? ' permitted tool discovered' : ' permitted tools discovered'))
      : attention(label, 'The connection reported no permitted tools.');
  }
  return attention(label, 'The worker could not discover tools for this connection.');
}

async function checkLocal(label, fn, success, failure) {
  try { await fn(); return ready(label, success); }
  catch (error) { return attention(label, error instanceof CrewError ? error.message : failure); }
}

export async function probeWorkflowSetup(snapshot, repo, signal) {
  const profiles = workflowSetupProfiles(snapshot);
  const configured = profiles.flatMap(({ origin }) => origin?.projectMcp ?? []);
  const connections = new Map(configured.map(connection => [connection.id + '/' + connection.version, connection]));
  const [models, hostMcp, plugins, apps] = await Promise.all([
    codexModelCatalog({ signal }),
    profiles.some(({ runtime }) => runtime.mcpServers?.length) ? codexHostMcpCatalog({ signal }) : null,
    profiles.some(({ runtime }) => runtime.plugins?.length) ? codexHostPluginCatalog({ signal }) : null,
    profiles.some(({ runtime }) => runtime.apps?.length) ? codexHostAppCatalog({ signal }) : null,
  ]);
  signal.throwIfAborted();
  const connectionChecks = new Map();
  const entries = [...connections];
  for (let index = 0; index < entries.length; index += 4) {
    await Promise.all(entries.slice(index, index + 4).map(async ([key, connection]) => {
      connectionChecks.set(key, await checkConnection(connection, signal));
    }));
    signal.throwIfAborted();
  }

  const checkedProfiles = [];
  for (const { id, model, origin, runtime } of profiles) {
    const selectedModel = model || models?.defaultModel;
    const label = selectedModel || 'Worker default model';
    const checks = [!models ? unverified(label, 'The worker model catalog was unavailable.')
      : !selectedModel ? unverified(label, 'Codex did not identify a default model in its catalog.')
        : models.models.includes(selectedModel) ? ready(label, 'Listed by Codex on the worker.')
          : attention(label, 'The saved model is absent from the worker catalog.')];
    if (runtime.serviceTier && runtime.serviceTier !== 'default') {
      const speed = codexServiceTierLabel(runtime.serviceTier);
      checks.push(!models || !selectedModel ? unverified(speed, 'The worker could not verify this model’s speed.')
        : models.serviceTiers?.[selectedModel]?.some(tier => tier.id === runtime.serviceTier) ? ready(speed, 'Listed for ' + selectedModel)
          : attention(speed, 'The worker does not list this speed for ' + selectedModel));
    }
    for (const name of runtime.mcpServers ?? []) {
      const server = hostMcp?.get(name);
      const missing = server?.envNames.filter(key => process.env[key] === undefined);
      checks.push(!hostMcp ? unverified(name, 'The worker MCP catalog was unavailable.')
        : !server?.enabled ? attention(name, 'The worker MCP server is missing or disabled.')
          : loginRequired(server.authStatus) ? attention(name, 'The worker MCP server needs sign-in.')
              : missing.length ? attention(name, 'Missing worker environment variables ' + missing.join(', '))
              : ready(name, 'Enabled in the worker MCP configuration.'));
    }
    for (const pluginId of runtime.plugins ?? []) {
      const plugin = plugins?.get(pluginId);
      checks.push(!plugins ? unverified(pluginId, 'The worker plugin catalog was unavailable.')
        : !plugin?.enabled || !plugin.supported ? attention(pluginId, 'The plugin is missing, disabled, or unavailable to this worker.')
          : ready(pluginId, plugin.version ? 'Installed version ' + plugin.version : 'Installed and enabled.'));
    }
    const missingPluginEnv = (runtime.pluginEnv ?? []).filter(name => process.env[name] === undefined);
    if (missingPluginEnv.length)
      checks.push(attention('Plugin environment', 'Missing worker environment variables ' + missingPluginEnv.join(', ')));
    for (const { id: appId, name } of runtime.apps ?? []) {
      const app = apps?.apps.get(appId);
      checks.push(!apps ? unverified(name, 'The worker connected-app catalog was unavailable.')
        : app?.enabled && app.callable ? ready(name, 'Listed as callable on the worker.')
          : attention(name, 'The app is missing, disabled, or needs to be reconnected on the worker.'));
    }
    checks.push(...(origin?.projectMcp ?? []).map(connection => connectionChecks.get(connection.id + '/' + connection.version)));
    if (origin?.musicBrowserProfile) checks.push(await checkLocal('Workspace browser',
      () => checkMusicBrowserSetup(repo, origin.musicBrowserProfile, signal), 'Chrome launched. The pinned image and any configured sample matched.',
      'Check the pinned Docker image, synthetic lesson, and sandboxed Chrome installation on the worker.'));
    if (origin?.musicPracticeProfile) checks.push(await checkLocal('Development audio check',
      () => checkMusicAudioSetup(repo, origin.musicPracticeProfile, signal, true), 'The pinned image, fixture, and verifier matched.',
      'The pinned image, fixture, or verifier is unavailable or changed on the worker.'));
    signal.throwIfAborted();
    checkedProfiles.push({ id, checks });
  }
  const profile = snapshot.project.workspaceCheckProfile;
  return { profiles: checkedProfiles, ...(profile && { workflow: [await checkLocal('Music Transcribe audio acceptance',
    () => checkMusicAudioSetup(repo, profile, signal), 'The pinned image, two fixtures, and verifier matched.',
    'The pinned image, fixtures, or verifier are unavailable or changed on the worker.')] }) };
}

export async function readWorkflowSetup(db, projectId, workflowId, version) {
  const { rows: [check] } = await db.query(`
    SELECT requested_at AS "requestedAt", started_at AS "startedAt", completed_at AS "completedAt", result
    FROM engineering_crew.workflow_setup_checks
    WHERE project_id=$1 AND epic_id=$2 AND version=$3`, [projectId, workflowId, version]);
  return check;
}

export async function requestWorkflowSetup(db, projectId, workflowId, version) {
  await db.query(`
    INSERT INTO engineering_crew.workflow_setup_checks (project_id, epic_id, version) VALUES ($1,$2,$3)
    ON CONFLICT (project_id, epic_id, version) DO UPDATE SET
      requested_at=now(), lease_id=NULL, started_at=NULL, completed_at=NULL, result=NULL
    WHERE workflow_setup_checks.completed_at IS NOT NULL
      OR workflow_setup_checks.requested_at < now() - interval '5 minutes'`, [projectId, workflowId, version]);
}

export async function runWorkflowSetupCheck(db, projectId, repo, signal) {
  const lease = randomUUID();
  const { rows: [job] } = await db.query(`
    WITH next AS (
      SELECT project_id, epic_id, version FROM engineering_crew.workflow_setup_checks
      WHERE project_id=$1 AND completed_at IS NULL
        AND requested_at >= now() - interval '5 minutes'
        AND (started_at IS NULL OR started_at < now() - interval '90 seconds')
      ORDER BY requested_at FOR UPDATE SKIP LOCKED LIMIT 1
    )
    UPDATE engineering_crew.workflow_setup_checks AS pending
    SET lease_id=$2, started_at=now()
    FROM next WHERE (pending.project_id, pending.epic_id, pending.version)=(next.project_id, next.epic_id, next.version)
    RETURNING pending.epic_id AS "workflowId", pending.version`, [projectId, lease]);
  if (!job) return;
  let result;
  const deadline = AbortSignal.timeout(35_000);
  const active = AbortSignal.any([signal, deadline]);
  try {
    const snapshot = await loadProject(db, projectId, job.workflowId, job.version);
    result = await probeWorkflowSetup(snapshot, repo, active);
    active.throwIfAborted();
  } catch {
    result = { error: deadline.aborted ? 'The worker setup check timed out.' : 'The worker could not complete this setup check.' };
  }
  await db.query(`
    UPDATE engineering_crew.workflow_setup_checks
    SET lease_id=NULL, started_at=CASE WHEN $2 THEN NULL ELSE started_at END,
      completed_at=CASE WHEN $2 THEN NULL ELSE now() END, result=$3::jsonb
    WHERE lease_id=$1`, [lease, signal.aborted, signal.aborted ? null : JSON.stringify(result)]);
}
