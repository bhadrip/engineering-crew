import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { CrewError } from './contracts.mjs';
import { listFeatures, recordFeaturePreview, recordFeaturePreviewFailure } from './feature-controller.mjs';
import { createFeatureRuntime, startFeaturePreview, stopFeaturePreview } from './feature-runtime.mjs';
import { editProjectProfile, readProjectProfile } from './local-profile-file.mjs';
import { agentNameLimit, featureRoleIds, validAgentName } from './feature-profiles.mjs';

const exec = promisify(execFile);
const stateDir = repo => resolve(repo, '.crew-local');

async function readOptional(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
}

async function runtimeFromConfig(repo, config) {
  const state = stateDir(repo);
  let verifyApp, probeApp;
  if (config?.acceptance === 'carnatic-lesson') {
    const { verifyLessons } = await import('../examples/music-transcribe/verify.mjs');
    verifyApp = context => verifyLessons(join(state, 'assets'), context);
    probeApp = context => verifyLessons(join(state, 'assets'), context, { practiceOnly: true });
  }
  if (config?.acceptance && !verifyApp) throw new CrewError('Unknown local acceptance profile');
  return createFeatureRuntime({ rootDir: join(state, 'projects'), image: config.image, roles: config.roles,
    agents: config.agents, activeAgents: config.activeAgents, verifyApp, probeApp });
}

export async function runtimeForFeature(repo, request) {
  return runtimeFromConfig(repo, await readProjectProfile(repo, request.projectId));
}

function roleDefinition(raw = {}, name) {
  const sorted = Object.fromEntries(Object.keys(raw).sort().map(key => [key, raw[key]]));
  const revision = createHash('sha256').update(JSON.stringify(name === undefined ? sorted : [name, sorted])).digest('hex');
  return { revision, model: raw.model ?? '', instructions: raw.instructions ?? '', workerImage: raw.workerImage ?? '',
    reasoningEffort: raw.reasoningEffort ?? '', skills: raw.skills ?? [], extraTools: raw.extraTools ?? [] };
}

async function describeProfiles(repo, projectId, config) {
  const { profiles, baseProfiles, namedProfiles, developmentProbe } = await runtimeFromConfig(repo, config);
  const definitions = Object.fromEntries(featureRoleIds.map(role => [role, roleDefinition(config.roles?.[role])]));
  const agents = Object.fromEntries(Object.entries(namedProfiles).map(([id, profile]) =>
    [id, { profile, definition: roleDefinition(config.agents[id].settings ?? {}, config.agents[id].name) }]));
  return { projectId, profiles, baseProfiles, agents, activeAgents: config.activeAgents ?? {}, developmentProbe, definitions,
    defaultModel: process.env.CREW_CODEX_MODEL ?? null };
}

export async function profilesForFeature(repo, projectId, { includeDefaults = true } = {}) {
  const config = await readProjectProfile(repo, projectId);
  return includeDefaults || Object.keys(config).length ? describeProfiles(repo, projectId, config) : null;
}

function checkAgentName(config, name, except) {
  if (!validAgentName(name)) throw new CrewError(`Enter an agent name of up to ${agentNameLimit} characters on one line.`, 2);
  const cleaned = name.trim();
  if (Object.entries(config.agents ?? {}).some(([id, agent]) => id !== except && agent.name.trim().toLowerCase() === cleaned.toLowerCase()))
    throw new CrewError('An agent already uses that name in this project.', 2);
  return cleaned;
}

export async function createNamedAgent(repo, projectId, { role, name }) {
  if (!featureRoleIds.includes(role)) throw new CrewError('Choose a workflow role for the new agent.', 2);
  const id = 'agent-' + randomUUID().replaceAll('-', '');
  await editProjectProfile(repo, projectId, config => {
    const agent = { role, name: checkAgentName(config, name), settings: {} };
    return { ...config, agents: { ...config.agents, [id]: agent } };
  });
  return id;
}

export async function activateNamedAgent(repo, projectId, role, { agent, expected }) {
  if (!featureRoleIds.includes(role)) throw new CrewError('Unknown feature role.', 2);
  await editProjectProfile(repo, projectId, config => {
    if (agent !== 'default' && (!Object.hasOwn(config.agents ?? {}, agent) || config.agents[agent].role !== role))
      throw new CrewError('This agent is unavailable for the selected role.', 2);
    const current = config.activeAgents?.[role] ?? 'default';
    if (expected !== current) throw new CrewError('The active agent changed. Reload before selecting an agent.', 3);
    if (agent === current) return config;
    const activeAgents = { ...config.activeAgents };
    if (agent === 'default') delete activeAgents[role];
    else activeAgents[role] = agent;
    return { ...config, activeAgents };
  });
}

export async function updateFeatureProfile(repo, projectId, role, { revision, model, instructions, workerImage, reasoningEffort, skills, extraTools, agent, name }) {
  if (typeof revision !== 'string' || !/^[0-9a-f]{64}$/.test(revision))
    throw new CrewError('A valid agent definition revision is required.', 2);
  if (typeof model !== 'string' || typeof instructions !== 'string')
    throw new CrewError('Specify the role model and project instructions. An empty value clears the override.', 2);
  let result;
  await editProjectProfile(repo, projectId, async config => {
    const current = await describeProfiles(repo, projectId, config);
    if (!Object.hasOwn(current.definitions, role)) throw new CrewError('Unknown feature role.', 2);
    const named = agent && Object.hasOwn(current.agents, agent) ? config.agents[agent] : null;
    if (agent && named?.role !== role) throw new CrewError('This agent is unavailable for the selected role.', 2);
    const definition = named ? current.agents[agent].definition : current.definitions[role];
    if (revision !== definition.revision) throw new CrewError('Agent definition changed. Reload the page before saving.', 3);
    const nextName = named && name !== undefined ? checkAgentName(config, name, agent) : named?.name;
    const changes = { model, instructions, workerImage, reasoningEffort, skills, extraTools };
    const previous = (named ? named.settings : config.roles?.[role]) ?? {};
    const raw = { ...previous };
    for (const [key, value] of Object.entries(changes)) {
      if (value === undefined || isDeepStrictEqual(value, definition[key])) continue;
      if (value === '' || (Array.isArray(value) && !value.length)) delete raw[key];
      else raw[key] = value;
    }
    if (isDeepStrictEqual(raw, previous) && nextName === named?.name) { result = current; return config; }
    const next = { ...config };
    if (named) next.agents = { ...config.agents, [agent]: { ...named, name: nextName, settings: raw } };
    else {
      next.roles = { ...config.roles };
      if (Object.keys(raw).length) next.roles[role] = raw;
      else delete next.roles[role];
    }
    result = await describeProfiles(repo, projectId, next);
    return next;
  });
  return result;
}

export async function openFeaturePreview(db, repo, request) {
  if (request.status !== 'completed') throw new CrewError('The feature has no completed delivery');
  const client = await db.connect();
  const project = request.projectId;
  let locked = false;
  let target = request;
  try {
    await client.query('SELECT pg_advisory_lock(710923816, hashtext($1))', [project]);
    locked = true;
    const completed = (await listFeatures(client, project)).filter(r => r.status === 'completed')
      .sort((a, b) => b.endedAt.localeCompare(a.endedAt));
    const latest = completed[0];
    if (!latest?.delivery?.revision) throw new CrewError('No delivered revision is available');
    if (latest.id !== request.id && request.previewStatus === 'pending') {
      await recordFeaturePreviewFailure(client, request.id, 'A newer project revision was delivered before this preview started');
    }
    target = latest;
    const recordServing = async manifest => {
      await recordFeaturePreview(client, latest.id, {
        url: manifest.url, revision: manifest.revision, image: manifest.image, container: manifest.container,
      });
      return manifest;
    };
    const dir = join(stateDir(repo), 'previews');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, project + '.json');
    const old = await readOptional(path);
    if (old?.revision === latest.delivery.revision && /^crew-app-[a-f0-9]{32}$/.test(old.container)) {
      const inspection = await exec('docker', ['inspect', '--format', '{{.State.Running}} {{index .Config.Labels "crew.revision"}}', old.container]).catch(() => null);
      if (inspection?.stdout.trim() === 'true ' + old.revision && /^http:\/\/127\.0\.0\.1:\d+$/.test(old.url)) {
        const health = await fetch(old.url + '/health', { redirect: 'error', signal: AbortSignal.timeout(2000) }).catch(() => null);
        await health?.body?.cancel();
        if (health?.ok) return await recordServing(old);
      }
    }
    const live = await startFeaturePreview({ projectId: project, repoPath: latest.delivery.repoPath,
      revision: latest.delivery.revision, image: latest.candidate.image });
    const { stop, ...manifest } = live;
    const temp = path + '.' + randomUUID();
    try { await writeFile(temp, JSON.stringify(manifest), { mode: 0o600 }); await rename(temp, path); }
    catch (error) { await stop(); throw error; }
    if (old) await stopFeaturePreview(old);
    return await recordServing(manifest);
  } catch (error) {
    if (locked && target.delivery?.revision) await recordFeaturePreviewFailure(client, target.id, String(error.message).slice(0, 500));
    throw error;
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock(710923816, hashtext($1))', [project]).finally(() => client.release());
    else client.release();
  }
}
