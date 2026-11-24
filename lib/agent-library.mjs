import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { CrewError, requireField } from './contracts.mjs';
import { transaction } from './database.mjs';
import { agentNameLimit, validAgentName } from './feature-profiles.mjs';
import { musicBrowserTool, musicPracticeTool, workflowAgentTools } from './workflow-agent-tools.mjs';
import { validateMusicPracticeProfile } from './workflow-music-checks.mjs';
import { validateMusicBrowserProfile } from './workflow-music-browser.mjs';
import { workflowNativeSettings } from './workflow-native.mjs';
import { validateWorkflowSkills } from './workflow-skills.mjs';
import { loadProjectMcp } from './project-mcp.mjs';
import { attachProjectSkills, projectSkillsEnabled } from './project-skills.mjs';

const agentIdPattern = /^agent-[a-f0-9]{32}$/;
const columns = 'agent_id AS id, version, definition';

const visibleTo = (agent, projectId) => agent && (!agent.definition.projectId || agent.definition.projectId === projectId || agent.definition.shared === true);
export const agentSkillAttachments = definition =>
  [...(definition.skills ?? []), ...(definition.projectSkills ?? []).map(({ definition }) => definition)];

export async function listReusableAgents(db, projectId) {
  const { rows } = await db.query('SELECT DISTINCT ON (agent_id) ' + columns + ' FROM engineering_crew.agent_versions ORDER BY agent_id, version DESC');
  return rows.filter(agent => visibleTo(agent, projectId)).sort((a, b) => a.definition.name.localeCompare(b.definition.name));
}

export async function loadReusableAgent(db, id, projectId, version) {
  requireField(agentIdPattern.test(id), 'Invalid library agent ID');
  requireField(version === undefined || (Number.isSafeInteger(version) && version >= 1 && version <= 10_000), 'Invalid agent version');
  const { rows: [latest, older] } = await db.query('SELECT ' + columns +
    ' FROM engineering_crew.agent_versions WHERE agent_id=$1 AND (version=$2 OR version=' +
    '(SELECT max(version) FROM engineering_crew.agent_versions WHERE agent_id=$1)) ORDER BY version DESC', [id, version]);
  const agent = version === undefined || latest?.version === version ? latest : older;
  if (!visibleTo(latest, projectId) || !visibleTo(agent, projectId)) throw new CrewError('This agent version could not be found in this project.', 4);
  return agent;
}

export async function listReusableAgentVersions(db, id, projectId) {
  const { rows } = await db.query(`SELECT version, jsonb_build_object('projectId', definition->'projectId',
    'shared', definition->'shared') AS definition FROM engineering_crew.agent_versions WHERE agent_id=$1 ORDER BY version DESC`, [id]);
  if (!visibleTo(rows[0], projectId)) throw new CrewError('This agent could not be found in this project.', 4);
  return rows.filter(row => visibleTo(row, projectId)).map(row => row.version);
}

export async function prepareReusableAgent(db, { projectId, shared = false, name, remit, model,
  instructions, skills, tools = [], runtime, projectMcp = [], projectSkills = [], musicPracticeProfile, musicBrowserProfile }) {
  if (!validAgentName(name)) throw new CrewError('Enter an agent name of up to ' + agentNameLimit + ' characters on one line.', 2);
  if (typeof remit !== 'string' || !remit.trim() || remit.length > 1000 || remit.includes('\0'))
    throw new CrewError('Describe the agent’s responsibilities in up to 1,000 characters.', 2);
  if (typeof model !== 'string' || (model && !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/.test(model)))
    throw new CrewError('Use a valid Codex model ID or leave the model empty.', 2);
  if (typeof instructions !== 'string' || !instructions.trim() || instructions.includes('\0') || Buffer.byteLength(instructions) > 16_384)
    throw new CrewError('Add agent instructions of up to 16 KiB.', 2);
  requireField(typeof projectId === 'string' && projectId.length && typeof shared === 'boolean', 'Invalid agent project or sharing choice');
  if (!Array.isArray(tools) || tools.some(tool => !Object.hasOwn(workflowAgentTools, tool)) || new Set(tools).size !== tools.length)
    throw new CrewError('Choose available Codex tools once per agent.', 2);
  const usesMusicPractice = tools.includes(musicPracticeTool);
  const usesMusicBrowser = tools.includes(musicBrowserTool);
  const execution = workflowNativeSettings(runtime);
  if (execution.repositoryInstructions && projectId !== 'music-transcribe')
    throw new CrewError('Repository instructions are available on Music Transcribe agents.', 2);
  if (execution.imageGeneration && projectId !== 'music-transcribe')
    throw new CrewError('Image generation is available on Music Transcribe agents.', 2);
  if (execution.serviceTier && projectId !== 'music-transcribe')
    throw new CrewError('Codex speed selection is available on Music Transcribe agents.', 2);
  if (usesMusicPractice) {
    if (projectId !== workflowAgentTools[musicPracticeTool].projectId || shared || execution.workspace === 'tools')
      throw new CrewError('The Music Transcribe sample check requires a project-owned agent with a native workspace.', 2);
    validateMusicPracticeProfile(musicPracticeProfile);
  }
  if (usesMusicBrowser) {
    if (projectId !== 'music-transcribe' || shared || execution.workspace === 'tools')
      throw new CrewError('The Music Transcribe browser requires a project-owned agent with a native workspace.', 2);
    validateMusicBrowserProfile(musicBrowserProfile);
  }
  if (!Array.isArray(projectMcp) || new Set(projectMcp.map(ref => ref?.id)).size !== projectMcp.length)
    throw new CrewError('Choose one version per project MCP connection.', 2);
  if (shared && projectMcp.length)
    throw new CrewError('Project MCP connections are private to this project. Remove them before sharing this agent.', 2);
  requireField(Array.isArray(skills) && Array.isArray(projectSkills), 'Choose valid skill attachments.');
  if (projectSkills.length && (shared || !projectSkillsEnabled(projectId)))
    throw new CrewError('Project skills can be attached to agents owned by this project.', 2);
  const attachments = await attachProjectSkills(db, projectId, projectSkills);
  const allSkills = validateWorkflowSkills([...skills, ...attachments.map(({ definition }) => definition)]);
  const connections = await Promise.all(projectMcp.map(async ref => {
    try {
      const { id, version } = await loadProjectMcp(db, projectId, ref?.id, ref?.version);
      return { id, version };
    } catch (error) {
      if (error instanceof CrewError) throw new CrewError(error.message, 2);
      throw error;
    }
  }));
  return { projectId, shared, name: name.trim(), remit: remit.trim(), model, instructions,
    skills: allSkills.slice(0, skills.length), tools, runtime: execution, ...(usesMusicPractice && { musicPracticeProfile }),
    ...(usesMusicBrowser && { musicBrowserProfile }),
    ...(attachments.length && { projectSkills: attachments }),
    ...(connections.length && { projectMcp: connections.sort((a, b) => a.id.localeCompare(b.id)) }) };
}

export async function saveReusableAgent(db, { id, expectedVersion = 0, featureSource, ...input }) {
  const fields = await prepareReusableAgent(db, input);
  const { projectId } = fields;
  if (!id) id = 'agent-' + randomUUID().replaceAll('-', '');
  requireField(agentIdPattern.test(id) && Number.isSafeInteger(expectedVersion) && expectedVersion >= 0, 'Invalid agent version');
  return transaction(db, async client => {
    await client.query('SELECT pg_advisory_xact_lock(710923818, hashtext($1))', [id]);
    const { rows: [latest] } = await client.query('SELECT version, definition FROM engineering_crew.agent_versions WHERE agent_id=$1 ORDER BY version DESC LIMIT 1', [id]);
    if (latest?.definition.projectId && latest.definition.projectId !== projectId)
      throw new CrewError('Edit this shared agent in its owning project.', 4);
    const current = latest?.version ?? 0;
    const origin = latest?.definition.featureSource ?? featureSource;
    const definition = { ...fields, ...(origin && { featureSource: origin }) };
    if (current !== expectedVersion && !(expectedVersion === 0 && featureSource && isDeepStrictEqual(definition, latest?.definition)))
      throw new CrewError('The agent changed. Reload the editor before saving.', 3);
    if (isDeepStrictEqual(definition, latest?.definition)) return { id, version: current, definition };
    if (current >= 10_000) throw new CrewError('This agent has reached its revision limit.', 2);
    const version = current + 1;
    await client.query('INSERT INTO engineering_crew.agent_versions (agent_id,version,definition) VALUES ($1,$2,$3)', [id, version, definition]);
    return { id, version, definition };
  });
}
