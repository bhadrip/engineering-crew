import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, promisify } from 'node:util';
import { CrewError, id } from '../lib/contracts.mjs';
import { artifactPage, epicPage, errorPage, escape, layout, projectAgentsHref as libraryHref, projectPage, projectSkillHref, runPage, workflowRunHref,
  workflowSetupHref } from './views.mjs';
import { featurePreviewPage, featureRequestPage, featureRequestsPage } from './feature-views.mjs';
import { featureDiffPage } from './feature-diff.mjs';
import { featureAgentHref, featureAgentsPage, featureInputPage } from './feature-agents.mjs';
import { codexModelCatalog } from '../lib/feature-codex.mjs';
import { codexHostMcpCatalog, enabledCodexServers } from '../lib/codex-host-mcp.mjs';
import { codexHostPluginCatalog, enabledCodexPlugins } from '../lib/codex-host-plugins.mjs';
import { codexHostAppCatalog, enabledCodexApps } from '../lib/codex-host-apps.mjs';
import { activateNamedAgent, createNamedAgent, profilesForFeature, updateFeatureProfile } from '../lib/local-feature.mjs';
import { featureRoleIds, skillLimits } from '../lib/feature-profiles.mjs';
import { openDatabase } from '../lib/database.mjs';
import { listReusableAgents, listReusableAgentVersions, loadReusableAgent, prepareReusableAgent, saveReusableAgent } from '../lib/agent-library.mjs';
import { agentRunTask, canStageAgentDelivery, createAgentDraftRun, createAgentRun, listAgentRuns } from '../lib/agent-run.mjs';
import { musicBrowserTool, musicPracticeTool } from '../lib/workflow-agent-tools.mjs';
import { pinMusicBrowserProfile } from '../lib/workflow-music-browser.mjs';
import { featureAgentCopy, featureAgentSources } from '../lib/feature-agent-copy.mjs';
import { reviewWorkflowHooks } from '../lib/workflow-hooks.mjs';
import { queueWorkflowSessionAction } from '../lib/workflow-session.mjs';
import { artifactDigest, findPublishedWorkspaceRun, findWorkflowRequest, listWorkflowRequests, runStore } from '../lib/run-store.mjs';
import { allowAdditionalAttempt, prepareWorkflowRun, publishedWorkspace, queueAgentFollowUp, requestWorkspaceRepair, setWorkflowAutomation, summarize, triageRun } from '../lib/workflow.mjs';
import { workflowRequestBrief } from '../lib/workflow-intake.mjs';
import { createWorkflowTest, listWorkflowTests, loadWorkflowTestSnapshot, saveWorkflowTest, workflowTestRunId } from '../lib/workflow-tests.mjs';
import { compareRevisions } from '../lib/revision-comparison.mjs';
import { revisionComparisonPage } from './revision-comparison.mjs';
import { reportWorkflowDispatchError, startWorkflowScheduler, workflowWorkerConnected } from '../lib/workflow-scheduler.mjs';
import { readWorkflowSetup, requestWorkflowSetup } from '../lib/workflow-setup.mjs';
import { workflowSetupPage } from './workflow-setup.mjs';
import { listProjectVersions, listRegisteredWorkflows, listWorkflowAgentAssignments, loadProject, registerProject } from '../lib/project-store.mjs';
import { captureGitRepositoryInstructions, captureGitWorkspace, gitControl, resolveCommit } from '../lib/git-control.mjs';
import { readWorkspaceArtifact, workspaceRepositoryInstruction } from '../lib/workflow-workspace.mjs';
import { musicWorkspaceCheck, pinMusicPracticeChecks, pinMusicWorkspaceChecks } from '../lib/workflow-music-checks.mjs';
import { buildWorkflowSnapshot, newWorkflowOutput, newWorkflowStep, nextWorkflowRow, stepOutputLimit, workflowDraft,
  workflowInputChoices, workflowInputLimit } from '../lib/workflow-editor.mjs';
import { listProjectMcp, listProjectMcpVersions, loadProjectMcp, pinnedProjectMcp, saveProjectMcp, validConnectionId } from '../lib/project-mcp.mjs';
import { projectMcpOAuthStatus, startProjectMcpOAuth } from '../lib/project-mcp-oauth.mjs';
import { checkProjectMcp } from '../lib/project-mcp-check.mjs';
import { projectMcpHref, projectMcpInput, projectMcpOAuthHref, projectMcpOAuthPage, projectMcpOAuthView, projectMcpPage,
  readProjectMcpDraft } from './project-mcp.mjs';
import { listProjectSkills, loadProjectSkill, projectSkillsEnabled, saveProjectSkill, validProjectSkillId } from '../lib/project-skills.mjs';
import { readWorkflowSkillAttachments } from '../lib/workflow-skills.mjs';
import { projectSkillsPage } from './project-skills.mjs';
import { projectRunFilters, projectRuns } from '../lib/project-runs.mjs';
import { projectRunsPage } from './project-runs.mjs';
import { agentImageLimits, agentImagesEnabled, imageArtifactReferences, normalizeAgentImages, readAgentImage, workflowRequestImageArtifacts } from '../lib/agent-images.mjs';
import { agentLibraryPage, agentRunPage, readLibraryDraft, readWorkflowDraft, versionNumber,
  workflowConfigurationPage, workflowHref } from './workflow-configuration.mjs';

const agentRoles = new Set(featureRoleIds);

const executeFile = promisify(execFile);
const command = fileURLToPath(new URL('../bin/crew.mjs', import.meta.url));
const stylesheet = readFileSync(new URL('crew.css', import.meta.url));
const browserScript = ['workflow-graph.js', 'workflow-inspector.js', 'agent-editor.js', 'workflow-dependency-editor.js', 'workflow-editor.js', 'crew.js']
  .map(name => readFileSync(new URL(name, import.meta.url), 'utf8')).join('\n');

function cliError(stderr, code) {
  try {
    const { error } = JSON.parse(stderr);
    return new CrewError(error, Number.isInteger(code) ? code : 1);
  } catch { return new CrewError('The crew command did not return a readable response'); }
}

async function call(repo, args) {
  let stdout;
  try {
    ({ stdout } = await executeFile(process.execPath, [command, '--repo', repo, ...args], { maxBuffer: 16_000_000 }));
  } catch (error) { throw cliError(error.stderr, error.code); }
  return JSON.parse(stdout);
}

function beginCommand(repo, args, startEvent) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [command, '--repo', repo, ...args, '--events'],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let started = false;
    child.stdout.setEncoding('utf8').on('data', chunk => {
      if (started) return;
      stdout += chunk;
      const boundary = stdout.indexOf('\n');
      if (boundary < 0) return;
      try {
        const event = JSON.parse(stdout.slice(0, boundary));
        if (event.event === startEvent) {
          started = true;
          resolve(event);
        }
      } catch { reject(new CrewError('The attempt could not be confirmed')); }
    });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr = (stderr + chunk).slice(0, 4096); });
    child.once('error', () => reject(new CrewError('Could not launch the crew CLI')));
    child.once('close', code => { if (!started) reject(cliError(stderr, code)); });
  });
}

async function readForm(request, limit = 12_000, { allowAgentImages = false } = {}) {
  const type = request.headers['content-type'];
  const multipart = allowAgentImages && type?.startsWith('multipart/form-data');
  if (!multipart && !type?.startsWith('application/x-www-form-urlencoded')) {
    throw new CrewError('Expected a form submission');
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > limit + (multipart ? agentImageLimits.totalBytes : 0)) throw new CrewError('Form is too large');
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);
  if (!multipart) return new URLSearchParams(body.toString());
  let fields;
  try { fields = await new Response(body, { headers: { 'Content-Type': type } }).formData(); }
  catch { throw new CrewError('The image upload could not be read. Select the files again.'); }
  if ([...fields].some(([name, entry]) => typeof entry !== 'string' && name !== 'turn-image'))
    throw new CrewError('Unexpected file field.');
  return fields;
}

async function readTurnImages(form) {
  const files = form.getAll('turn-image').filter(value => value !== '' && !(value instanceof File && !value.size && !value.name));
  if (files.length > agentImageLimits.count) throw new CrewError('Attach up to four images.');
  if (files.some(file => !(file instanceof File) || file.size > agentImageLimits.fileBytes) ||
    files.reduce((sum, file) => sum + file.size, 0) > agentImageLimits.totalBytes)
    throw new CrewError('Attach PNG or JPEG images up to 4 MiB each and 6 MiB total.');
  return Promise.all(files.map(async file => ({ name: file.name, data: Buffer.from(await file.arrayBuffer()) })));
}

function agentDraft(form) {
  const required = ['model', 'instructions', 'version'];
  const settings = ['worker-image', 'reasoning-effort', 'attachments', 'agent-name'];
  const attachments = ['skill-name', 'skill-content', 'extra-tool'];
  if (required.some(name => form.getAll(name).length !== 1) || settings.some(name => form.getAll(name).length > 1) ||
    [...form.keys()].some(name => ![...required, ...settings, ...attachments].includes(name))) return null;
  const cleanText = value => value.replace(/\r\n?/g, '\n');
  const draft = { model: form.get('model').trim(), instructions: cleanText(form.get('instructions')), version: form.get('version') };
  if (form.has('worker-image')) draft.workerImage = form.get('worker-image').trim();
  if (form.has('reasoning-effort')) draft.reasoningEffort = form.get('reasoning-effort');
  if (form.has('agent-name')) draft.name = form.get('agent-name').trim();
  if (!form.has('attachments')) return attachments.some(name => form.has(name)) ? null : draft;
  const names = form.getAll('skill-name');
  const contents = form.getAll('skill-content');
  if (form.get('attachments') !== '1' || names.length !== contents.length || names.length > skillLimits.count) return null;
  draft.skills = names.map((name, index) => ({ name: name.trim(), content: cleanText(contents[index]) }));
  draft.extraTools = form.getAll('extra-tool');
  return draft;
}

function send(response, status, body, type = 'text/html', headers = {}) {
  response.writeHead(status, {
    'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', ...headers,
  });
  response.end(body);
}

export async function serve({ repo, projectId, port, externalWorker = false }) {
  const configurationsDb = await openDatabase();
  const [{ projects }, { requests }, workflows] = await Promise.all([
    call(repo, ['workspace', 'show']), call(repo, ['feature', 'list']), listRegisteredWorkflows(configurationsDb),
  ]);
  const featureProjects = new Set(requests.map(request => request.projectId));
  const ids = new Set(projects.map(project => project.id));
  for (const workflow of workflows) {
    if (ids.has(workflow.projectId)) continue;
    ids.add(workflow.projectId);
    projects.push({ id: workflow.projectId, name: workflow.projectName, crewName: workflow.crewName, profiles: [], epics: [],
      featureOnly: featureProjects.has(workflow.projectId) });
  }
  for (const key of new Set([...featureProjects, ...(projectId ? [projectId] : [])])) {
    if (!ids.has(key)) projects.push({ id: key, name: key, epics: [], featureOnly: true });
  }
  const selectedProject = projectId ? projects.find(project => project.id === projectId)
    : projects.length === 1 ? projects[0] : undefined;
  if (!selectedProject) {
    throw new CrewError(projectId ? `Project ${projectId} has no runs in this database`
      : projects.length ? 'Choose the project with --project-id or provide a run ID'
        : 'Start a project run before opening its browser UI');
  }

  const dispatchWorkerState = () => externalWorker ? workflowWorkerConnected(configurationsDb, selectedProject.id) : undefined;

  async function readProjectRun(runId) {
    const { run } = await call(repo, ['run', 'show', runId]);
    if (run.project.id !== selectedProject.id) throw new CrewError('Run does not belong to this project');
    return run;
  }

  async function readProjectFeature(featureId) {
    try {
      const { request } = await call(repo, ['feature', 'show', featureId]);
      return request.id === featureId && request.projectId === selectedProject.id ? request : null;
    } catch (error) {
      if (error instanceof CrewError && /does not exist|Invalid feature ID/.test(error.message)) return null;
      throw error;
    }
  }

  let catalogLookup, catalogExpiresAt = 0;
  function workerModelCatalog() {
    if (!catalogLookup || Date.now() >= catalogExpiresAt) {
      catalogLookup = codexModelCatalog().catch(() => null);
      catalogExpiresAt = Date.now() + 60_000;
    }
    return catalogLookup;
  }
  async function currentAgentsPage(role, options = {}) {
    const [current, catalog] = await Promise.all([profilesForFeature(repo, selectedProject.id), workerModelCatalog()]);
    if (options.agent && options.agent !== 'default' && (!Object.hasOwn(current.agents, options.agent) || current.agents[options.agent].profile.role !== role)) return null;
    return featureAgentsPage(selectedProject, { ...current, role, catalog, ...options });
  }

  async function workflowRepository(projectId) {
    const { rows: [feature] } = await configurationsDb.query('SELECT repo_path FROM engineering_crew.feature_projects WHERE id=$1', [projectId]);
    if (feature) {
      const directory = feature.repo_path ?? resolve(repo, '.crew-local', 'projects', projectId);
      const path = await realpath(directory).catch(() => null);
      const control = path && gitControl(path, { optional: true });
      if (control?.gitDir && control.root === path) return control;
    }
    return null;
  }

  async function workflowBaseline(projectId) {
    return resolveCommit(await workflowRepository(projectId) ?? gitControl(repo));
  }

  async function committedInstructions(projectId, commit) {
    const control = await workflowRepository(projectId);
    if (!control) {
      if (commit) throw new CrewError('The project checkout is unavailable. Reopen the run form.');
      return;
    }
    return captureGitRepositoryInstructions(control, resolveCommit(control, commit));
  }

  const newAgentRunId = () => 'agent-run-' + randomUUID().replaceAll('-', '');
  async function agentRunLocation(runId, { needsDispatch }) {
    let location = `/runs/${runId}/tasks/${agentRunTask}`;
    if (needsDispatch) {
      try { await beginCommand(repo, ['task', 'dispatch', runId, agentRunTask], 'attempt.started'); }
      catch (error) {
        if (!(error instanceof CrewError)) throw error;
        if (!(await runStore(db, runId).read()).tasks[0].attempts.length) location += '?dispatch=retry';
      }
    }
    return location;
  }

  const oauthAttempts = new Map();
  async function oauthPage(request, response, url, origin) {
    const writing = request.method === 'POST';
    const fail = (status, error) => send(response, status, errorPage(error));
    if (!writing && request.method !== 'GET') return send(response, 405, errorPage('Use the OAuth connection page.'), 'text/html', { Allow: 'GET, POST' });
    if (writing && request.headers.origin !== origin) return fail(403, 'Use the local connection page.');
    const project = selectedProject;
    const connectionId = url.searchParams.get('connection');
    const version = versionNumber(url.searchParams.get('version'));
    if (!validConnectionId(connectionId) || !(version > 0 && version <= 10_000)) return fail(404, 'Choose a saved MCP connection version.');
    let connection;
    try { connection = await loadProjectMcp(configurationsDb, project.id, connectionId, version); }
    catch (error) { if (error instanceof CrewError && error.code === 4) return fail(404, error.message); throw error; }
    if (!connection.definition.oauth) return fail(404, 'Enable OAuth on the saved HTTP connection first.');
    const pinned = pinnedProjectMcp(project.id, connection);
    const attemptId = url.searchParams.get('attempt');
    if (attemptId !== null && !/^[0-9a-f-]{36}$/.test(attemptId)) return fail(404, 'Unknown OAuth sign-in.');
    const record = oauthAttempts.get(pinned.server);
    const matched = record && record.flow.id === attemptId && record.connection.version === version;
    if (!writing) {
      if (!matched) return fail(404, 'This OAuth sign-in is unavailable. Open the saved connection to start another.');
      const headers = { 'Referrer-Policy': 'no-referrer' };
      return url.searchParams.get('status') === '1' ?
        send(response, 200, JSON.stringify(projectMcpOAuthView(record.flow)), 'application/json', headers) :
        send(response, 200, projectMcpOAuthPage(project, connection, record.flow), 'text/html', headers);
    }
    const form = await readForm(request, 4000);
    const action = form.get('action');
    const redirectTo = ({ connection, flow }) => send(response, 303, '', 'text/plain', { Location: projectMcpOAuthHref(project, connection, flow.id) });
    if (action === 'cancel') {
      if (!matched) return fail(404, 'Unknown OAuth sign-in.');
      record.flow.cancel();
      return redirectTo(record);
    }
    if (action !== null || attemptId !== null) return fail(400, 'Unknown OAuth action.');
    for (const [name, previous] of oauthAttempts) {
      if (previous.flow.finishedAt && Date.now() - previous.flow.finishedAt > 600_000) oauthAttempts.delete(name);
    }
    if (record && ['starting', 'waiting'].includes(record.flow.state)) return redirectTo(record);
    const flow = startProjectMcpOAuth(pinned);
    flow.id = randomUUID();
    const next = { connection, flow };
    oauthAttempts.set(pinned.server, next);
    return redirectTo(next);
  }

  async function comparisonPage(request, response, url, kind) {
    const project = selectedProject;
    const db = configurationsDb;
    const fail = (status, message) => send(response, status, errorPage(message));
    if (request.method !== 'GET') return send(response, 405, errorPage('Open the revision comparison.'), 'text/html', { Allow: 'GET' });
    try {
      if (url.searchParams.has('test')) {
        const runId = url.searchParams.get('test');
        if (kind !== 'workflow' || !workflowTestRunId.test(runId) || url.searchParams.size !== 1)
          return fail(404, 'Choose a draft test to compare.');
        const { snapshot, workflowId, baseVersion } = await loadWorkflowTestSnapshot(db, runId, project.id);
        const base = baseVersion ? await loadProject(db, project.id, workflowId, baseVersion) : undefined;
        const back = workflowRunHref(project, workflowId, runId);
        return send(response, 200, revisionComparisonPage(project, { kind, name: snapshot.project.epic.title, back, test: true,
          before: base ? { label: 'Version ' + baseVersion, href: workflowHref(project, workflowId, baseVersion) } : { label: 'New workflow' },
          after: { label: 'Draft test', href: back }, groups: compareRevisions(kind, base, snapshot) }));
      }
      const reference = url.searchParams.get(kind);
      const agent = kind === 'agent';
      if (!(agent ? /^agent-[a-f0-9]{32}$/ : /^[a-z0-9][a-z0-9-]{0,63}$/).test(reference))
        return fail(404, 'Choose a saved ' + kind + ' to compare.');
      const versions = agent ? await listReusableAgentVersions(db, reference, project.id) :
        (await listProjectVersions(db, project.id, reference)).map(row => row.version);
      const target = url.searchParams.get('to');
      const original = url.searchParams.get('from');
      const to = target === null ? versions[0] : versionNumber(target);
      const from = original === null ? versions.find(value => value < to) ?? versions.find(value => value !== to) ?? to : versionNumber(original);
      if (!versions.includes(from) || !versions.includes(to)) return fail(404, 'The chosen revision is unavailable in this project.');
      const href = version => agent ? libraryHref(project, reference, false, version) : workflowHref(project, reference, version);
      const load = version => agent ? loadReusableAgent(db, reference, project.id, version) : loadProject(db, project.id, reference, version);
      const [before, after] = await Promise.all([load(from), load(to)]);
      return send(response, 200, revisionComparisonPage(project, { kind, id: reference, name: agent ? after.definition.name : after.project.epic.title,
        back: href(to), versions, from, to, before: { label: 'Version ' + from, href: href(from) },
        after: { label: 'Version ' + to, href: href(to) }, groups: compareRevisions(kind, before, after) }));
    } catch (error) {
      if (!(error instanceof CrewError)) throw error;
      return fail(error.code === 4 ? 404 : 400, error.message);
    }
  }

  async function configurationPage(request, response, url, origin, area) {
    const editing = request.method === 'POST';
    if (!editing && request.method !== 'GET') return send(response, 405, errorPage('Use the configuration editor.'), 'text/html', { Allow: 'GET, POST' });
    if (editing && request.headers.origin !== origin) return send(response, 403, errorPage('Use the local configuration editor.'));
    const adding = url.searchParams.get('new') === '1';
    const project = selectedProject;
    const db = configurationsDb;
    const fail = (status, message) => send(response, status, errorPage(message));
    if (area === 'skills') {
      if (!projectSkillsEnabled(project.id)) return fail(404, 'This page does not exist.');
      const skillId = url.searchParams.get('skill');
      const picked = url.searchParams.get('version');
      const version = picked === null ? undefined : versionNumber(picked);
      if ((skillId !== null && (adding || !validProjectSkillId(skillId))) ||
        (picked !== null && (!skillId || !(version > 0 && version <= 10_000)))) return fail(404, 'Unknown skill or version.');
      if (editing && version !== undefined) return fail(405, 'Edit the latest skill version.');
      let skill, catalog;
      try {
        [skill, catalog] = await Promise.all([skillId ? loadProjectSkill(db, project.id, skillId, version) : undefined, listProjectSkills(db, project.id)]);
      } catch (error) { if (error.code === 4) return fail(404, error.message); throw error; }
      const page = (status, options) => send(response, status, projectSkillsPage(project, { catalog, skill, adding, ...options }));
      if (!editing) return page(200, { pinned: version !== undefined, saved: url.searchParams.get('saved') === '1' });
      if (!skill && !adding) return fail(405, 'Choose a skill to edit or add a skill.');
      let draft;
      try {
        const form = await readForm(request, 2_000_000);
        draft = { expectedVersion: versionNumber(form.get('version')), skills: readWorkflowSkillAttachments(form) };
        if (!skill && draft.expectedVersion !== 0) return fail(400, 'Invalid new skill version.');
        if (draft.skills.length !== 1) throw new CrewError('Add one skill to save this version.', 2);
        const saved = await saveProjectSkill(db, project.id, { id: skill?.id, expectedVersion: draft.expectedVersion, skill: draft.skills[0] });
        return send(response, 303, '', 'text/plain', { Location: projectSkillHref(project, saved.id) + '&saved=1' });
      } catch (error) {
        if (!(error instanceof CrewError)) throw error;
        return page(error.code === 3 ? 409 : 400, { draft, error: error.message });
      }
    }
    if (area === 'tools' || area === 'tool-check') {
      const checking = area === 'tool-check';
      const connectionId = url.searchParams.get('connection');
      const versionParam = url.searchParams.get('version');
      const version = versionParam === null ? undefined : versionNumber(versionParam);
      if (checking && !editing) return send(response, 405, errorPage('Open the saved connection to check its tools.'), 'text/html', { Allow: 'POST' });
      if (checking && (!connectionId || version === undefined)) return fail(404, 'Choose a saved MCP connection version.');
      if ((connectionId !== null && (adding || !validConnectionId(connectionId))) ||
          (versionParam !== null && (!connectionId || !(version > 0 && version <= 10_000))))
        return fail(404, 'Unknown MCP connection or version.');
      if (editing && !checking && version !== undefined) return fail(405, 'Edit the latest MCP connection version.');
      let connection, versions;
      try {
        if (connectionId) [connection, versions] = await Promise.all([
          loadProjectMcp(db, project.id, connectionId, version), listProjectMcpVersions(db, project.id, connectionId),
        ]);
      }
      catch (error) { if (error.code === 4) return fail(404, error.message); throw error; }
      if (checking) {
        const form = await readForm(request, 4000);
        if (form.size) return fail(400, 'Check the saved connection from its version page.');
        const cancel = new AbortController();
        response.once('close', () => cancel.abort());
        const check = await checkProjectMcp(pinnedProjectMcp(project.id, connection), { signal: cancel.signal });
        if (cancel.signal.aborted) return;
        const oauthStatus = check.authStatus === 'oAuth' ? 'o_auth' : check.state === 'sign-in-required' ? 'not_logged_in' : undefined;
        return send(response, 200, projectMcpPage(project, { connection, versions, check, oauthStatus }));
      }
      if (!editing) return send(response, 200, projectMcpPage(project, {
        connection, versions, adding, saved: url.searchParams.get('saved') === '1',
        connections: !connection && !adding ? await listProjectMcp(db, project.id) : [],
        oauthStatus: connection?.definition.oauth ? await projectMcpOAuthStatus(pinnedProjectMcp(project.id, connection)) : undefined,
      }));
      if (!connection && !adding) return fail(405, 'Choose a connection to edit or add a connection.');
      const form = await readForm(request, 100_000);
      const draft = { ...readProjectMcpDraft(form), expectedVersion: versionNumber(form.get('version')) };
      try {
        if (!connection && draft.expectedVersion !== 0) return fail(400, 'Invalid new connection version.');
        const saved = await saveProjectMcp(db, project.id, connectionId ?? draft.id, draft.expectedVersion, projectMcpInput(draft));
        return send(response, 303, '', 'text/plain', { Location: projectMcpHref(project, saved.id) + '&saved=1' });
      } catch (error) {
        if (!(error instanceof CrewError)) throw error;
        return send(response, error.code === 3 ? 409 : 400, projectMcpPage(project, { connection, versions, adding, draft, error: error.message }));
      }
    }
    if (area === 'agent-library') {
      const agentId = url.searchParams.get('agent');
      const standalone = url.searchParams.get('run') === '1';
      const projectAgents = project.id === 'music-transcribe';
      const versionParam = url.searchParams.get('version');
      const pinned = projectAgents && versionParam !== null;
      const selectedVersion = pinned ? versionNumber(versionParam) : undefined;
      const legacyRole = projectAgents ? url.searchParams.get('role') : null;
      const fromRole = url.searchParams.get('from-role');
      const fromAgent = url.searchParams.get('from-agent');
      if ((agentId && (adding || !/^agent-[a-f0-9]{32}$/.test(agentId))) ||
        (pinned && (!agentId || standalone || !(selectedVersion > 0 && selectedVersion <= 10_000)))) return fail(404, 'Unknown agent or version.');
      if (legacyRole !== null && (!agentRoles.has(legacyRole) || agentId || adding || standalone)) return fail(404, 'Unknown agent role.');
      if (editing && pinned) return fail(405, 'Edit the current agent version.');
      if ((fromRole !== null || fromAgent !== null) && (!adding || standalone || !agentRoles.has(fromRole) ||
        !/^(?:default|agent-[a-f0-9]{32})$/.test(fromAgent ?? ''))) return fail(404, 'Unknown Feature agent source.');
      const featureSettings = () => profilesForFeature(repo, project.id, { includeDefaults: featureProjects.has(project.id) });
      let copy;
      if (fromRole) {
        try { copy = featureAgentCopy(await featureSettings(), fromRole, fromAgent); }
        catch (error) { if (error.code === 4) return fail(404, error.message); throw error; }
      }
      let agent;
      try { if (agentId) agent = await loadReusableAgent(db, agentId, project.id, selectedVersion); }
      catch (error) { if (error.code === 4) return fail(404, error.message); throw error; }
      if (standalone) {
        if (!agent) return fail(404, 'Choose a saved agent to run.');
        const render = async (status, options = {}) => {
          const [runs, delivery, projectConnections, repositoryBaseline] = await Promise.all([listAgentRuns(db, project.id, agentId),
            canStageAgentDelivery(project, agent) ? findPublishedWorkspaceRun(db, project.id) : undefined,
            projectAgents ? Promise.all((agent.definition.projectMcp ?? []).map(({ id, version }) => loadProjectMcp(db, project.id, id, version))) : [],
            projectAgents && agent.definition.runtime?.repositoryInstructions ? committedInstructions(project.id).catch(error => {
              if (!(error instanceof CrewError)) throw error;
              return { error: error.message };
            }) : undefined]);
          let publishedBase;
          if (delivery) {
            try {
              const { candidate, files } = publishedWorkspace(delivery);
              publishedBase = { runId: delivery.id, digest: candidate.workspace.digest,
                ...(agent.definition.runtime?.repositoryInstructions && { instructions: workspaceRepositoryInstruction(files) }) };
            } catch (error) { if (!(error instanceof CrewError)) throw error; }
          }
          return send(response, status, agentRunPage(project, agent, { runs, runId: newAgentRunId(), publishedBase, projectConnections,
            ...(repositoryBaseline?.files && { repositoryCommit: repositoryBaseline.commit, repositoryInstructions: workspaceRepositoryInstruction(repositoryBaseline.files) }),
            repositoryInstructionError: repositoryBaseline?.error,
            ...options }));
        };
        if (!editing) return render(200);
        const form = await readForm(request, 225_000, { allowAgentImages: agentImagesEnabled(project.id) });
        const runId = form.get('run-id');
        const prompt = (form.get('prompt') ?? '').replace(/\r\n?/g, '\n');
        const reference = (form.get('reference') ?? '').replace(/\r\n?/g, '\n');
        const deliveryRunId = form.get('delivery-run-id') || undefined;
        const repositoryCommit = form.get('repository-commit') || undefined;
        const invokeSkills = form.getAll('invoke-skill').map(Number);
        let prepared;
        try {
          const version = versionNumber(form.get('version'));
          agent = await loadReusableAgent(db, agentId, project.id, version);
          if (repositoryCommit && (!projectAgents || !agent.definition.runtime?.repositoryInstructions || !/^[a-f0-9]{40,64}$/.test(repositoryCommit)))
            throw new CrewError('Reopen the run form to choose valid repository instructions.', 2);
          const repositoryBaseline = repositoryCommit && !deliveryRunId ? await committedInstructions(project.id, repositoryCommit) : undefined;
          if (repositoryCommit && !deliveryRunId && !repositoryBaseline) throw new CrewError('No committed repository instructions exist at that revision.', 2);
          const images = await readTurnImages(form);
          prepared = await createAgentRun(db, { project, agent, runId, sourceCommit: repositoryBaseline?.commit ?? await workflowBaseline(project.id),
            prompt, reference, deliveryRunId, repositoryBaseline, invokeSkills, images });
        } catch (error) {
          if (!(error instanceof CrewError)) throw error;
          return render(error.code === 3 ? 409 : error.code === 4 ? 404 : 400, { prompt, reference, deliveryRunId, invokeSkills, error: error.message });
        }
        return send(response, 303, '', 'text/plain', { Location: await agentRunLocation(runId, prepared) });
      }
      let revisionContext;
      if (projectAgents && agent) {
        const [versions, assignments] = await Promise.all([
          listReusableAgentVersions(db, agentId, project.id), listWorkflowAgentAssignments(db, project.id, agentId),
        ]);
        revisionContext = { versions, assignments: assignments.filter(assignment => !pinned || assignment.agentVersion === selectedVersion), pinned };
      }
      const canTestAgent = projectAgents && !pinned && (!agent?.definition.projectId || agent.definition.projectId === project.id);
      const draftDelivery = async () => canTestAgent ? (await findPublishedWorkspaceRun(db, project.id))?.id : undefined;
      if (!editing) {
        if (!agent && !adding) {
          const [agents, settings] = await Promise.all([listReusableAgents(db, project.id), featureSettings().catch(() => undefined)]);
          const featureSources = featureAgentSources(settings);
          if (legacyRole) {
            const source = featureSources.find(entry => entry.role === legacyRole && entry.active);
            const own = agents.filter(({ definition }) => definition.projectId === project.id);
            const copies = own.filter(({ definition }) => definition.featureSource?.role === legacyRole &&
              (!source || definition.featureSource.key === source.key));
            const names = source ? own.filter(({ definition }) => definition.name === source.name) : [];
            const match = (source && copies.find(({ definition }) => definition.featureSource.digest === source.profile.digest)) ??
              (copies.length === 1 ? copies[0] : undefined) ?? (copies.length === 0 && names.length === 1 ? names[0] : undefined);
            if (match) return send(response, 303, '', 'text/plain', { Location: libraryHref(project, match.id) });
          }
          return send(response, 200, agentLibraryPage(project, { agents, featureSources, legacyRole,
            featureSettingsUnavailable: settings === undefined }));
        }
        if (copy) {
          const existing = await loadReusableAgent(db, copy.id, project.id).catch(error => {
            if (error.code === 4) return null;
            throw error;
          });
          if (existing?.definition.projectId === project.id && existing.definition.featureSource?.digest === copy.origin.digest)
            return send(response, 303, '', 'text/plain', { Location: libraryHref(project, existing.id) });
        }
        const [mcpCatalog, projectConnections, pluginCatalog, skillCatalog, draftDeliveryId, modelCatalog] = await Promise.all([
          codexHostMcpCatalog(), listProjectMcp(db, project.id), codexHostPluginCatalog(),
          projectSkillsEnabled(project.id) ? listProjectSkills(db, project.id) : [], draftDelivery(), projectAgents && workerModelCatalog(),
        ]);
        return send(response, 200, agentLibraryPage(project, {
          agent, adding, mcpCatalog, projectConnections, pluginCatalog, skillCatalog, modelCatalog, featureCopy: copy, ...revisionContext,
          saved: url.searchParams.get('saved') === '1', draftDeliveryId, ...(canTestAgent && { testRunId: newAgentRunId() }),
        }));
      }
      if (!agent && !adding) return fail(405, 'Choose an agent to edit or add an agent.');
      if (agent?.definition.projectId && agent.definition.projectId !== project.id) return fail(403, 'Edit this shared agent in its owning project.');
      let draft, mcpCatalog, pluginCatalog, testDraft, testFields;
      try {
        const form = await readForm(request, 6_000_000, { allowAgentImages: canTestAgent });
        testDraft = form.get('action') === 'test';
        if (testDraft && !canTestAgent) return fail(405, 'Agent draft tests are available in Music Transcribe.');
        if (testDraft) testFields = {
          prompt: (form.get('test-prompt') ?? '').replace(/\r\n?/g, '\n'),
          reference: (form.get('test-reference') ?? '').replace(/\r\n?/g, '\n'),
          deliveryRunId: form.get('test-delivery') || undefined,
        };
        if (copy && form.get('feature-source') !== copy.origin.digest) {
          draft = copy.draft;
          throw new CrewError('The Feature agent changed. Review the refreshed settings before creating the copy.', 3);
        }
        draft = readLibraryDraft(form);
        if (testDraft && !testFields.prompt.trim()) throw new CrewError('Enter a test prompt.', 2);
        if (!agent && draft.expectedVersion !== 0) return fail(400, 'Invalid new agent version.');
        if (testDraft && draft.expectedVersion !== (agent?.version ?? 0))
          throw new CrewError('The saved agent changed. Reopen the editor before testing this draft.', 3);
        const previousServers = agent?.definition.runtime?.mcpServers ?? [];
        const previousPlugins = agent?.definition.runtime?.plugins ?? [];
        const pinnedApps = new Map((agent?.definition.runtime?.apps ?? []).map(app => [app.id, app]));
        const added = draft.runtime.mcpServers.filter(name => !previousServers.includes(name));
        const plugins = draft.runtime.plugins.filter(id => !previousPlugins.includes(id));
        const apps = draft.appIds.filter(id => !pinnedApps.has(id));
        let appCatalog;
        [mcpCatalog, pluginCatalog, appCatalog] = await Promise.all([
          added.length ? codexHostMcpCatalog() : undefined, plugins.length ? codexHostPluginCatalog() : undefined,
          apps.length ? codexHostAppCatalog() : undefined,
        ]);
        try {
          if (added.length) enabledCodexServers(mcpCatalog, added);
          if (plugins.length) enabledCodexPlugins(pluginCatalog, plugins);
          if (apps.length) for (const app of enabledCodexApps(appCatalog, apps)) pinnedApps.set(app.id, app);
        } catch (error) {
          throw new CrewError(error.message, 2);
        }
        const hooks = await reviewWorkflowHooks(draft.hookConfig, agent?.definition.runtime?.hooks, draft.approveHooks);
        const [musicPracticeProfile, musicBrowserProfile] = await Promise.all([
          project.id === 'music-transcribe' && draft.tools.includes(musicPracticeTool) ? pinMusicPracticeChecks(repo) : undefined,
          project.id === 'music-transcribe' && draft.tools.includes(musicBrowserTool) ? pinMusicBrowserProfile(repo) : undefined,
        ]);
        const input = { ...draft, id: agentId ?? copy?.id, projectId: project.id, featureSource: copy?.origin,
          musicPracticeProfile, musicBrowserProfile, runtime: { ...draft.runtime, hooks, apps: draft.appIds.map(id => pinnedApps.get(id)) } };
        if (testDraft) {
          const fields = await prepareReusableAgent(db, input);
          const featureSource = agent?.definition.featureSource ?? copy?.origin;
          const definition = { ...fields, ...(featureSource && { featureSource }) };
          const { deliveryRunId } = testFields;
          const repositoryBaseline = fields.runtime.repositoryInstructions && !deliveryRunId ? await committedInstructions(project.id) : undefined;
          const runId = form.get('test-run-id');
          const prepared = await createAgentDraftRun(db, { project, baseAgent: agent, definition, runId,
            sourceCommit: repositoryBaseline?.commit ?? await workflowBaseline(project.id), repositoryBaseline,
            ...testFields, images: await readTurnImages(form) });
          const location = await agentRunLocation(runId, prepared);
          if (request.headers.accept === 'application/json')
            return send(response, 201, JSON.stringify({ location, nextTestRunId: newAgentRunId() }), 'application/json');
          return send(response, 303, '', 'text/plain', { Location: location });
        }
        const saved = await saveReusableAgent(db, input);
        return send(response, 303, '', 'text/plain', { Location: libraryHref(project, saved.id) + '&saved=1' });
      } catch (error) {
        if (!(error instanceof CrewError)) throw error;
        if (testDraft && request.headers.accept === 'application/json')
          return send(response, error.code === 3 ? 409 : 400, JSON.stringify({ error: error.message }), 'application/json');
        const [catalog, projectConnections, hostPlugins, skillCatalog, draftDeliveryId, modelCatalog] = await Promise.all([
          mcpCatalog === undefined ? codexHostMcpCatalog() : mcpCatalog, listProjectMcp(db, project.id),
          pluginCatalog === undefined ? codexHostPluginCatalog() : pluginCatalog,
          projectSkillsEnabled(project.id) ? listProjectSkills(db, project.id) : [], draftDelivery(), projectAgents && workerModelCatalog(),
        ]);
        return send(response, error.code === 3 ? 409 : 400, agentLibraryPage(project, {
          agent, adding, draft, error: error.message, mcpCatalog: catalog, projectConnections, pluginCatalog: hostPlugins, skillCatalog,
          featureCopy: copy, modelCatalog, ...revisionContext, draftDeliveryId, testFields, ...(canTestAgent && { testRunId: newAgentRunId() }),
        }));
      }
    }

    const workflowId = url.searchParams.get('workflow');
    const canTestWorkflow = project.id === 'music-transcribe';
    const setup = url.searchParams.get('setup') === '1';
    const newTestId = () => 'workflow-test-' + randomUUID().replaceAll('-', '');
    let draftWorkflowId = adding ? 'workflow-' + randomUUID().replaceAll('-', '') : undefined;
    const versionParam = url.searchParams.get('version');
    const selectedVersion = versionParam === null ? undefined : versionNumber(versionParam);
    if (setup && (!canTestWorkflow || !workflowId || !selectedVersion || adding))
      return fail(404, 'Choose a saved Music Transcribe workflow revision.');
    if ((workflowId && (adding || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(workflowId))) ||
      (versionParam !== null && (!workflowId || !(selectedVersion > 0 && selectedVersion <= 2147483647)))) return fail(404, 'Unknown workflow or version.');
    if (!workflowId && !adding) {
      return editing ? fail(405, 'Choose a workflow to edit or create a workflow.') :
        send(response, 200, workflowConfigurationPage(project, { workflows: await listRegisteredWorkflows(db, project.id),
          workflowTests: canTestWorkflow ? await listWorkflowTests(db, project.id) : [] }));
    }
    let snapshot, versions = [];
    try {
      if (workflowId) [snapshot, versions] = await Promise.all([loadProject(db, project.id, workflowId, selectedVersion),
        listProjectVersions(db, project.id, workflowId)]);
    } catch (error) { if (error.code === 4) return fail(404, error.message); throw error; }
    if (setup) {
      if (editing) {
        await requestWorkflowSetup(db, project.id, workflowId, snapshot.version);
        return send(response, 303, '', 'text/plain', { Location: workflowSetupHref(project, workflowId, snapshot.version) });
      }
      const [check, connected] = await Promise.all([readWorkflowSetup(db, project.id, workflowId, snapshot.version), dispatchWorkerState()]);
      return send(response, 200, workflowSetupPage(project, snapshot, check, connected));
    }
    const agents = await listReusableAgents(db, project.id);
    const render = async (status, options = {}) => send(response, status, workflowConfigurationPage(project, {
      snapshot, versions, agents, adding, draft: workflowDraft(snapshot), draftWorkflowId,
      testRunId: canTestWorkflow ? newTestId() : undefined,
      workflowTests: canTestWorkflow ? await listWorkflowTests(db, project.id, workflowId ?? draftWorkflowId) : [], ...options,
    }));
    if (!editing) return render(200, { saved: url.searchParams.get('saved') === '1' });
    const form = await readForm(request, 650_000);
    const expectedVersion = versionNumber(form.get('version'));
    const action = form.get('action');
    if (adding && canTestWorkflow && form.has('draft-workflow-id')) {
      const key = form.get('draft-workflow-id');
      if (!/^workflow-[a-f0-9]{32}$/.test(key)) return fail(400, 'Reopen the workflow editor to create a new workflow.');
      draftWorkflowId = key;
    }
    if (action === 'run') {
      if (!snapshot || expectedVersion !== snapshot.version || selectedVersion !== expectedVersion) return fail(400, 'Choose a saved workflow version.');
      const runId = 'run-' + randomUUID().replaceAll('-', '');
      const run = await prepareWorkflowRun(db, snapshot, runId);
      await runStore(db, runId).create(run);
      const view = run.automation?.enabled && run.triage.status === 'assigned' ? '&view=workflow' : '';
      return send(response, 303, '', 'text/plain', { Location: '/projects/' + project.id + '/epics/' + workflowId + '?run=' + runId + view });
    }
    let draft;
    try { draft = readWorkflowDraft(form, snapshot); }
    catch (error) {
      if (!(error instanceof CrewError)) throw error;
      return render(400, { error: error.message });
    }
    if (expectedVersion !== (versions[0]?.version ?? 0))
      return render(409, { draft, expectedVersion, error: 'The workflow version changed. Reload the editor before saving.' });
    if (form.has('remove') && draft.steps.length > 1) {
      const stepId = form.get('remove');
      draft.steps = draft.steps.filter(step => step.id !== stepId);
      for (const step of draft.steps) {
        step.prerequisites = step.prerequisites.filter(id => id !== stepId);
        if (step.routes) step.routes = step.routes.filter(route => route.step !== stepId);
        if (step.joinPrerequisites) step.joinPrerequisites = step.joinPrerequisites.filter(id => id !== stepId);
        if (step.historyFrom === stepId) step.historyFrom = '';
      }
      return render(200, { draft });
    }
    const inputs = workflowInputChoices(snapshot, draft.inputRows);
    if (action === 'add-input' && draft.inputRows && inputs.length < workflowInputLimit) {
      const ref = nextWorkflowRow(inputs, 'input');
      draft.inputRows.push({ ref, id: ref, title: '', content: '' });
      return render(200, { draft });
    }
    if (form.has('remove-input') && draft.inputRows) {
      const ref = form.get('remove-input');
      if (!draft.inputRows.some(input => input.ref === ref)) return fail(400, 'Choose a workflow input to remove.');
      draft.inputRows = draft.inputRows.filter(input => input.ref !== ref);
      for (const step of draft.steps) step.inputs = step.inputs.filter(input => input !== ref);
      return render(200, { draft });
    }
    if (form.has('add-output')) {
      const step = draft.steps.find(step => step.id === form.get('add-output'));
      if (!step?.outputs || step.outputs.length >= stepOutputLimit) return fail(400, 'This step cannot add another output.');
      step.outputs.push(newWorkflowOutput(step.outputs));
      return render(200, { draft });
    }
    if (form.has('remove-output')) {
      const [producer, ref] = form.get('remove-output').split('/');
      const step = draft.steps.find(step => step.id === producer);
      if (!(step?.outputs?.length > 1) || !step.outputs.some(slot => slot.ref === ref && !slot.locked))
        return fail(400, 'Choose a configurable output to remove.');
      step.outputs = step.outputs.filter(slot => slot.ref !== ref);
      for (const consumer of draft.steps) {
        consumer.routes = consumer.routes.filter(route => route.step !== producer || route.output !== ref);
      }
      return render(200, { draft });
    }
    if (action === 'add' && draft.steps.length < 20) {
      draft.steps.push(newWorkflowStep(draft.steps, inputs.map(input => input.ref), snapshot?.project.tasks));
      return render(200, { draft });
    }
    if (action !== 'save' && !(canTestWorkflow && action === 'test')) return fail(400, 'Unknown workflow edit.');
    try {
      const targetWorkflowId = workflowId ?? draftWorkflowId;
      const build = async () => {
        let workspaceBaseline = snapshot?.workspaceBaseline ?? null;
        if (draft.workspacePaths !== undefined) {
          const paths = draft.workspacePaths.split(/\r?\n/).map(path => path.trim()).filter(Boolean);
          const control = paths.length ? await workflowRepository(project.id) : null;
          if (paths.length && !control) throw new CrewError('Connect a local Git checkout to the project before pinning workspace files.');
          workspaceBaseline = control ? captureGitWorkspace(control, resolveCommit(control), paths) : null;
        }
        return buildWorkflowSnapshot(db, { project, workflowId: targetWorkflowId, baseline: snapshot,
          sourceCommit: snapshot?.sourceCommit ?? workspaceBaseline?.commit ?? await workflowBaseline(project.id),
          draft, workspaceBaseline, workspaceCheckProfile: canTestWorkflow && draft.steps.some(step => step.workspaceCheck === musicWorkspaceCheck)
            ? await pinMusicWorkspaceChecks(repo) : snapshot?.project.workspaceCheckProfile });
      };
      if (action === 'test') {
        const runId = form.get('test-run-id');
        await createWorkflowTest(db, { runId, projectId: project.id, workflowId: targetWorkflowId, baseVersion: expectedVersion, draft, build });
        const location = workflowRunHref(project, targetWorkflowId, runId);
        if (request.headers.accept === 'application/json')
          return send(response, 201, JSON.stringify({ location, nextTestRunId: newTestId() }), 'application/json');
        return send(response, 303, '', 'text/plain', { Location: location });
      }
      const next = await build();
      await registerProject(db, next, { expectedVersion });
      return send(response, 303, '', 'text/plain', { Location: workflowHref(project, next.project.epic.id) + '&saved=1' });
    } catch (error) {
      if (!(error instanceof CrewError)) throw error;
      const cycle = /^Handoff cycle involving (.+)$/.exec(error.message);
      const title = cycle && draft.steps.find(step => step.id === cycle[1])?.title;
      const message = title ? 'Prerequisites form a cycle involving “' + title + '”. Remove a dependency to break the cycle.' : error.message;
      return render(error.code === 3 ? 409 : 400, { draft, expectedVersion, error: message });
    }
  }

  let host;
  const server = createServer(async (request, response) => {
    if (request.headers.host !== host) return send(response, 403, errorPage('Use the local crew address.'));
    const origin = `http://${host}`;
    try {
      const url = new URL(request.url, origin);
      const projectAgents = selectedProject.id === 'music-transcribe';
      if (projectAgents && url.pathname === '/projects/music-transcribe/runs') {
        if (request.method !== 'GET') return send(response, 405, errorPage('Run history is read-only.'), 'text/html', { Allow: 'GET' });
        const filters = projectRunFilters(url.searchParams);
        const history = await projectRuns(configurationsDb, selectedProject.id, filters);
        return send(response, 200, projectRunsPage(selectedProject, filters, history));
      }
      const comparison = /^\/projects\/music-transcribe\/(agents|workflows)\/compare$/.exec(url.pathname);
      if (projectAgents && comparison) return await comparisonPage(request, response, url, comparison[1] === 'agents' ? 'agent' : 'workflow');
      const appRoute = /^\/projects\/([a-z0-9-]+)\/(agent-library|agents)\/apps$/.exec(url.pathname);
      if (appRoute && (appRoute[2] === 'agent-library' || projectAgents)) {
        if (appRoute[1] !== selectedProject.id) return send(response, 404, errorPage('This project is not selected.'));
        if (request.method !== 'GET') return send(response, 405, errorPage('Use the agent editor.'), 'text/html', { Allow: 'GET' });
        const catalog = await codexHostAppCatalog();
        const apps = catalog ? [...catalog.apps.values()].sort((a, b) => a.name.localeCompare(b.name)) : [];
        return send(response, catalog ? 200 : 503, JSON.stringify({ apps }), 'application/json');
      }
      const oauthRoute = /^\/projects\/([a-z0-9-]+)\/tools\/oauth$/.exec(url.pathname);
      if (oauthRoute) {
        if (oauthRoute[1] !== selectedProject.id) return send(response, 404, errorPage('This project is not selected.'));
        return await oauthPage(request, response, url, origin);
      }
      if (url.pathname === '/projects/music-transcribe/tools/check' && projectAgents)
        return await configurationPage(request, response, url, origin, 'tool-check');
      const editorRoute = /^\/projects\/([a-z0-9-]+)\/(workflows|agent-library|agents|tools|skills)$/.exec(url.pathname);
      const legacyAgentAddress = projectAgents && editorRoute?.[2] === 'agents' &&
        (url.searchParams.has('add') || (url.searchParams.has('role') && (url.searchParams.has('agent') || request.method === 'POST')));
      if (editorRoute && (editorRoute[2] !== 'agents' || projectAgents)) {
        if (editorRoute[1] !== selectedProject.id) return send(response, 404, errorPage('This project is not selected.'));
        if (projectAgents && editorRoute[2] === 'agent-library' && request.method === 'GET')
          return send(response, 303, '', 'text/plain', { Location: libraryHref(selectedProject) + url.search });
        if (legacyAgentAddress && request.method === 'GET')
          return send(response, 303, '', 'text/plain', { Location: featureAgentHref(selectedProject) + url.search });
        if (!legacyAgentAddress) return await configurationPage(request, response, url, origin,
          editorRoute[2] === 'agents' ? 'agent-library' : editorRoute[2]);
      }
      const agentsRoute = /^\/projects\/([a-z0-9-]+)(?:\/requests\/([a-z0-9-]+))?\/(agents|feature-agents|events\/([1-9]\d*)\/input(?:\/(prompt\.txt))?)$/.exec(url.pathname);
      const featureRoleLink = featureProjects.has(selectedProject.id) && ['role', 'agent', 'add'].some(key => url.searchParams.has(key));
      if (agentsRoute && (agentsRoute[2] || agentsRoute[3] !== 'agents' || selectedProject.featureOnly || featureRoleLink || legacyAgentAddress)) {
        const [, project, featureId, page, seq, promptFile] = agentsRoute;
        if (project !== selectedProject.id) return send(response, 404, errorPage('This project is not selected.'));
        const role = url.searchParams.get('role');
        const agent = url.searchParams.get('agent');
        const adding = url.searchParams.get('add') === '1';
        const value = url.searchParams.get('attempt');
        const attempt = value === null ? null : Number(value);
        if ((role !== null && !agentRoles.has(role)) || (value !== null && (!featureId || !/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(attempt))))
          return send(response, 404, errorPage('Unknown agent or attempt.'));
        if ((agent !== null && (!role || adding || !/^(?:default|agent-[a-f0-9]{32})$/.test(agent))) || ((adding || agent) && featureId))
          return send(response, 404, errorPage('Unknown agent page.'));
        async function replyWithEditor(status, options) {
          const html = await currentAgentsPage(role, { agent, adding, ...options });
          return html ? send(response, status, html) : send(response, 404, errorPage('This agent is unavailable for the selected role.'));
        }
        if (request.method === 'POST' && !featureId && !seq && (role || adding)) {
          if (request.headers.origin !== origin) return send(response, 403, errorPage('Use the local agent editor.'));
          const form = await readForm(request, 480_000);
          if (adding) {
            if (form.size !== 2 || !form.has('name') || !form.has('role')) return send(response, 400, errorPage('Enter an agent name and role.'));
            const draft = { name: form.get('name').trim(), role: form.get('role') };
            try {
              const created = await createNamedAgent(repo, project, draft);
              return send(response, 303, '', 'text/plain', { Location: featureAgentHref(selectedProject, draft.role, { agent: created }) + '&created=1' });
            } catch (error) {
              if (!(error instanceof CrewError) || ![2, 3].includes(error.code)) throw error;
              return replyWithEditor(error.code === 3 ? 409 : 400, { draft, editorError: error.message });
            }
          }
          if (form.has('activate')) {
            if (form.size !== 2 || form.get('activate') !== agent || !form.has('expected')) return send(response, 400, errorPage('Choose an agent to use for this role.'));
            try { await activateNamedAgent(repo, project, role, { agent, expected: form.get('expected') }); }
            catch (error) {
              if (!(error instanceof CrewError) || ![2, 3].includes(error.code)) throw error;
              return replyWithEditor(error.code === 3 ? 409 : 400, { assignmentError: error.message });
            }
            return send(response, 303, '', 'text/plain', { Location: featureAgentHref(selectedProject, role) + '&assigned=1' });
          }
          const draft = agentDraft(form);
          if (!draft) return send(response, 400, errorPage('The agent form contains missing or invalid fields.'));
          try {
            await updateFeatureProfile(repo, project, role, { ...draft, revision: draft.version, agent: agent === 'default' ? null : agent });
          } catch (error) {
            if (!(error instanceof CrewError) || ![2, 3].includes(error.code)) throw error;
            return replyWithEditor(error.code === 3 ? 409 : 400, { draft, editorError: error.message, agent: agent ?? 'default' });
          }
          return send(response, 303, '', 'text/plain', { Location: featureAgentHref(selectedProject, role, { agent }) + '&saved=1' });
        }
        if (request.method !== 'GET') return send(response, 405, errorPage('This agent record is read-only.'), 'text/html', { Allow: 'GET' });
        if (!featureId && !seq) {
          return replyWithEditor(200, { saved: !!role && url.searchParams.get('saved') === '1',
            created: !!agent && url.searchParams.get('created') === '1', assigned: !!role && url.searchParams.get('assigned') === '1' });
        }
        const record = featureId && page !== 'feature-agents' && await readProjectFeature(featureId);
        if (!record) return send(response, 404, errorPage('Feature request unavailable in this project.'));
        if (seq) {
          const event = record.events.find(e => e.seq === Number(seq) && agentRoles.has(e.role) &&
            (e.type === 'agent.started' || e.type === 'agent.completed' || (e.type === 'task.completed' && e.evidence?.receipt)));
          if (!event) return send(response, 404, errorPage('No agent call was recorded at this event.'));
          const { input, output } = await call(repo, ['feature', 'input', featureId, seq]);
          if (promptFile) {
            if (typeof input?.prompt !== 'string') return send(response, 404, errorPage('No exact prompt was saved for this call.'));
            return send(response, 200, input.prompt, 'text/plain', { 'Content-Disposition': 'attachment; filename="crew-prompt-event-' + seq + '.txt"' });
          }
          return send(response, 200, featureInputPage(selectedProject, record, event, input, output));
        }
        if (attempt !== null && !record.events.some(e => e.attempt === attempt && (!role || e.role === role)))
          return send(response, 404, errorPage('No matching agent activity was recorded in this attempt.'));
        return send(response, 200, featureAgentsPage(selectedProject, { request: record, role, attempt }));
      }
      const evidenceRoute = /^\/projects\/([a-z0-9-]+)\/requests\/([a-z0-9-]+)\/(trace\.json|(attempts|events)\/(\d+)(\.diff|\/changes))$/.exec(url.pathname);
      if (evidenceRoute && request.method === 'GET') {
        const [, project, featureId, kind, collection, index, format] = evidenceRoute;
        if (project !== selectedProject.id) return send(response, 404, errorPage('This project is not selected.'));
        const number = Number(index);
        if (collection && !(Number.isSafeInteger(number) && number > 0)) return send(response, 404, errorPage('Invalid change number.'));
        const record = await readProjectFeature(featureId);
        if (!record) return send(response, 404, errorPage('Feature request unavailable in this project.'));
        if (kind === 'trace.json') return send(response, 200, JSON.stringify(record, null, 2), 'application/json');
        const edit = collection === 'events';
        const entry = record.events.find(event => event.role === 'engineer' && (edit
          ? event.seq === number && event.type === 'tool.completed' && event.evidence?.action === 'edit'
          : event.attempt === number && event.type === 'task.completed'));
        if (!entry?.evidence?.revision || (!edit && !entry.evidence.base)) {
          return send(response, 404, errorPage(edit ? 'This event has no recorded edit.' : 'This attempt has no submitted build.'));
        }
        const { diff, base, revision } = await call(repo, ['feature', edit ? 'changes' : 'diff', featureId, String(number)]);
        if (revision !== entry.evidence.revision || (!edit && base !== entry.evidence.base)) {
          throw new CrewError('The changes do not match this recorded revision.');
        }
        if (format === '.diff') return send(response, 200, diff + '\n', 'text/plain');
        return send(response, 200, featureDiffPage(selectedProject, record, { collection, number, diff, base, revision }));
      }
      const featureRoute = /^\/projects\/([a-z0-9-]+)\/requests(?:\/([a-z0-9-]+)(?:\/(run|preview|langfuse))?)?$/.exec(url.pathname);
      const requestIndex = '/projects/' + selectedProject.id + '/requests';
      const workflowRequestRoute = /^\/projects\/(music-transcribe)\/requests\/workflow\/([a-z0-9-]+)$/.exec(url.pathname);
      if (workflowRequestRoute && request.method === 'GET') {
        const [, project, runId] = workflowRequestRoute;
        const workflowRun = project === selectedProject.id && await findWorkflowRequest(configurationsDb, project, runId);
        if (!workflowRun) return send(response, 404, errorPage('Workflow request unavailable in this project.'));
        const view = workflowRun.triage === 'pending' ? 'triage' : 'workflow';
        const location = `/projects/${project}/epics/${encodeURIComponent(workflowRun.workflowId)}?run=${encodeURIComponent(runId)}&view=${view}`;
        return send(response, 303, '', 'text/plain', { Location: location });
      }
      if (featureRoute) {
        const [, project, featureId, action] = featureRoute;
        if (project !== selectedProject.id) return send(response, 404, errorPage('This project is not selected.'));
        const fromWorkflow = project === 'music-transcribe';
        const renderRequests = async (status = 200, options = {}) => {
          const deliveryRunId = options.draft?.deliveryRunId ?? url.searchParams.get('from-delivery') ?? undefined;
          const [list, workflows, runs, delivery, workerConnected] = await Promise.all([call(repo, ['feature', 'list', '--project', project]),
            fromWorkflow ? listRegisteredWorkflows(configurationsDb, project, { allVersions: true }) : [],
            fromWorkflow ? listWorkflowRequests(configurationsDb, project) : [],
            fromWorkflow && deliveryRunId ? findPublishedWorkspaceRun(configurationsDb, project, deliveryRunId) : undefined,
            fromWorkflow ? dispatchWorkerState() : undefined]);
          let fromDelivery;
          if (delivery) {
            try {
              const { candidate } = publishedWorkspace(delivery);
              fromDelivery = { runId: delivery.id, workflowId: delivery.epic.id,
                digest: candidate.workspace.digest, publishedAt: delivery.workspaceDelivery.publishedAt };
            } catch (error) { if (!(error instanceof CrewError)) throw error; }
          }
          if (fromWorkflow && deliveryRunId && !fromDelivery && status === 200)
            return send(response, 404, errorPage('Published delivery unavailable in this project.'));
          return send(response, status, featureRequestsPage(selectedProject, list.requests, fromWorkflow ? {
            workflows: workflows.filter(workflow => workflow.acceptsRequests && (!deliveryRunId || workflow.usesPublishedWorkspace)),
            runs: runs.map(summarize), formId: 'run-' + randomUUID().replaceAll('-', ''), fromDelivery, workerConnected, ...options,
          } : undefined));
        };
        let entry;
        if (featureId) {
          entry = await readProjectFeature(featureId);
          if (!entry) return send(response, 404, errorPage('Feature request unavailable in this project.'));
        }
        if (request.method === 'GET' && !action) {
          if (entry) return send(response, 200, featureRequestPage(selectedProject, entry, {
            langfuseConfigured: Boolean(process.env.CREW_LANGFUSE_URL && process.env.CREW_LANGFUSE_PROJECT_ID && process.env.CREW_LANGFUSE_CREDENTIALS_FILE),
          }));
          return await renderRequests();
        }
        if (request.method === 'POST' && (!entry || action)) {
          if (request.headers.origin !== origin) return send(response, 403, errorPage('Use the local request form.'));
          const form = await readForm(request, 64_000, { allowAgentImages: fromWorkflow && !entry });
          if (!entry) {
            if (fromWorkflow) {
              const runId = form.get('request-id') ?? '';
              const choice = form.get('workflow-version') ?? '';
              const goal = form.get('goal') ?? '';
              const deliveryRunId = form.get('delivery-run-id') || undefined;
              const draft = { choice, goal, deliveryRunId };
              const selection = /^([a-z0-9][a-z0-9-]{0,63})\/([1-9][0-9]{0,9})$/.exec(choice);
              if (!selection || !/^run-[a-f0-9]{32}$/.test(runId))
                return await renderRequests(400, { draft, error: 'Choose a saved workflow version and enter a request brief.' });
              const version = Number(selection[2]);
              const runRecord = runStore(configurationsDb, runId);
              try {
                const briefDigest = artifactDigest(workflowRequestBrief(goal));
                const images = workflowRequestImageArtifacts(normalizeAgentImages(await readTurnImages(form)), runId);
                const assertSameRequest = prior => {
                  if (prior.project.id !== project || prior.epic.id !== selection[1] || prior.project.configurationVersion !== version ||
                      prior.workflowRequest?.briefDigest !== briefDigest || prior.requestedDeliveryRunId !== deliveryRunId ||
                      !isDeepStrictEqual(prior.workflowRequest?.imageInputs ?? [], imageArtifactReferences(images)))
                    throw new CrewError('This request was already submitted. Open a new form to submit a different request.', 3);
                };
                let prior;
                try { prior = await runRecord.read(); }
                catch (error) {
                  if (!(error instanceof CrewError) || error.code !== 4) throw error;
                }
                if (prior) assertSameRequest(prior);
                else {
                  const snapshot = await loadProject(configurationsDb, project, selection[1], version);
                  const run = await prepareWorkflowRun(configurationsDb, snapshot, runId, { requestBrief: goal, deliveryRunId, requestImages: images });
                  try { await runRecord.create(run); }
                  catch (error) {
                    if (!(error instanceof CrewError) || error.code !== 3) throw error;
                    assertSameRequest(await runRecord.read());
                  }
                }
              } catch (error) {
                if (!(error instanceof CrewError)) throw error;
                return await renderRequests(error.code === 3 ? 409 : 400, { draft, error: error.message });
              }
              return send(response, 303, '', 'text/plain', { Location: requestIndex + '/workflow/' + runId });
            }
            const result = await call(repo, ['feature', 'submit', '--project', project, '--goal=' + (form.get('goal') ?? '')]);
            return send(response, 303, '', 'text/plain', { Location: result.path });
          }
          if (action === 'langfuse') {
            try { await call(repo, ['feature', 'publish-trace', featureId]); }
            catch (error) {
              const refreshed = (await call(repo, ['feature', 'show', featureId])).request;
              if (refreshed.langfuseExport?.status !== 'failed') throw error;
            }
            return send(response, 303, '', 'text/plain', { Location: requestIndex + '/' + featureId + '#usage' });
          }
          if (action === 'preview') {
            const { preview } = await call(repo, ['feature', 'preview', featureId]);
            if (!/^http:\/\/127\.0\.0\.1:\d+\/?$/.test(preview.url)) throw new CrewError('Invalid local preview address');
            // Navigate through a link so form-action stays restricted to the Crew origin.
            return send(response, 200, featurePreviewPage(preview.url));
          }
          if (entry.canResume) {
            const worker = spawn(process.execPath, [command, '--repo', repo, 'feature', 'run', featureId], { detached: true, stdio: 'ignore' });
            await new Promise((ready, fail) => { worker.once('spawn', ready); worker.once('error', fail); });
            worker.unref();
          }
          return send(response, 303, '', 'text/plain', { Location: requestIndex + '/' + featureId });
        }
      }
      const projectRoute = /^\/projects\/([a-z0-9-]+)(?:\/(agents|attention)|\/epics\/([a-z0-9-]+))?$/.exec(url.pathname);
      const runRoute = /^\/runs\/([a-z0-9-]+)(?:\/(tasks|artifacts)\/([a-z0-9-]+)|\/(fix|triage|resolve-resource|automation|publish-workspace|preview-workspace|stop-workspace|save-workflow-test))?$/.exec(url.pathname);
      const [, selectedRun, section, item, runAction] = runRoute ?? [];
      if (request.method === 'GET') {
        if (url.pathname === '/crew.css') return send(response, 200, stylesheet, 'text/css');
        if (url.pathname === '/crew.js') return send(response, 200, browserScript, 'text/javascript');
        const query = url.searchParams.get('q')?.trim().slice(0, 160) ?? '';
        if (selectedProject.featureOnly && (url.pathname === '/' || url.pathname === '/projects/' + selectedProject.id))
          return send(response, 302, '', 'text/plain', { Location: requestIndex });
        if (url.pathname === '/' || projectRoute) {
          const { projects } = await call(repo, ['workspace', 'show']);
          const [, routeProject, projectView, epicId] = projectRoute ?? [];
          const project = (!routeProject || routeProject === selectedProject.id) &&
            (projects.find(project => project.id === selectedProject.id) ?? selectedProject);
          if (project && !epicId) {
            const configurations = projectView === 'agents' ? await Promise.all(project.epics.map(async epic => {
              try {
                const config = await call(repo, ['project', 'show', '--project', project.id, '--epic', epic.id]);
                if (config.project.id !== project.id || config.project.epic.id !== epic.id) throw new CrewError('Configuration belongs to another epic');
                return { epic, ...config };
              } catch (error) {
                if (!(error instanceof CrewError)) throw error;
                return { epic, error: error.message };
              }
            })) : [];
            return send(response, 200, projectPage(project, projectView, { query, status: url.searchParams.get('status'), configurations }));
          }
          const testId = url.searchParams.get('run');
          const test = project?.id === 'music-transcribe' && epicId && workflowTestRunId.test(testId) ? await readProjectRun(testId) : undefined;
          if (test && (!test.workflowTest || test.epic.id !== epicId)) return send(response, 404, errorPage('Draft test does not belong to this workflow.'));
          const epic = test ? { ...test.epic, runs: [{ id: test.id }] } : project?.epics.find(epic => epic.id === epicId);
          if (epic) {
            const activeRun = url.searchParams.get('run') ?? epic.runs[0].id;
            if (!epic.runs.some(run => run.id === activeRun)) return send(response, 404, errorPage('Run does not belong to this epic.'));
            const run = test ?? await readProjectRun(activeRun);
            const step = url.searchParams.get('step');
            if (step && !run.tasks.some(task => task.packet.id === step)) {
              return send(response, 404, errorPage('Handoff does not belong to this run.'));
            }
            return send(response, 200, epicPage(project, epic, run, {
              step, view: url.searchParams.get('view'), query, type: url.searchParams.get('type'),
              workerConnected: run.automation ? await dispatchWorkerState() : undefined,
            }));
          }
        }
        if (section === 'artifacts') {
          const run = await readProjectRun(selectedRun);
          const { artifact } = await call(repo, ['artifact', 'read', selectedRun, item]);
          if (artifact.kind === 'agent-image' && url.searchParams.get('image') === '1') {
            const image = readAgentImage(artifact);
            return send(response, 200, image.data, image.mimeType, { 'Content-Type': image.mimeType, 'Content-Length': image.bytes });
          }
          if (artifact.kind === 'workspace' && url.searchParams.has('file')) {
            const file = readWorkspaceArtifact(artifact.content).files.find(file => file.path === url.searchParams.get('file'));
            if (!file) return send(response, 404, errorPage('This file is missing from the captured workspace.'));
            const filename = encodeURIComponent(file.path.split('/').at(-1));
            response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store',
              'X-Content-Type-Options': 'nosniff', 'Content-Disposition': "attachment; filename*=UTF-8''" + filename });
            return response.end(Buffer.from(file.data, 'base64'));
          }
          if (url.searchParams.get('download') === '1' && artifact.kind === 'skill-resource') {
            const bytes = Buffer.from(artifact.content, 'base64');
            if (createHash('sha256').update(bytes).digest('hex') !== artifact.provenance.sha256)
              return send(response, 409, errorPage('The skill file does not match its pinned digest.'));
            const filename = encodeURIComponent(artifact.provenance.path.split('/').at(-1)).replace(/['()*]/g,
              character => '%' + character.charCodeAt(0).toString(16).toUpperCase());
            response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store',
              'X-Content-Type-Options': 'nosniff', 'Content-Disposition': "attachment; filename*=UTF-8''" + filename });
            return response.end(bytes);
          }
          const fromTask = url.searchParams.get('task');
          const task = run.tasks.find(value => value.packet.id === fromTask);
          return send(response, 200, artifactPage(artifact, run, task?.packet.id, url.searchParams.get('view')));
        }
        if (selectedRun && !runAction) {
          const run = await readProjectRun(selectedRun);
          const selection = item ? run.tasks.find(value => value.packet.id === item) : run.tasks[0];
          if (selection) return send(response, 200, runPage(run, selection, { dispatchRetry: url.searchParams.get('dispatch') === 'retry',
            workerConnected: selection.packet.agentFollowUp && run.automation?.pending ? await dispatchWorkerState() : undefined }));
        }
      }
      if (request.method === 'POST' && (section === 'tasks' || runAction)) {
        if (request.headers.origin !== origin) return send(response, 403, errorPage('Open the crew UI before submitting a decision.'));
        const run = await readProjectRun(selectedRun);
        const form = await readForm(request, 64_000, { allowAgentImages: run.agentRun && !runAction && agentImagesEnabled(run.project.id) });
        if (runAction === 'save-workflow-test') {
          if (form.size || !run.workflowTest) return send(response, 400, errorPage('Choose a draft test to save.'));
          try {
            const { workflowId, version } = await saveWorkflowTest(configurationsDb, run.id, run.project.id);
            return send(response, 303, '', 'text/plain', { Location: workflowHref(selectedProject, workflowId, version) + '&saved=1' });
          } catch (error) {
            if (!(error instanceof CrewError)) throw error;
            return send(response, error.code === 3 ? 409 : 400, errorPage(error.message, workflowRunHref(run.project, run.epic.id, run.id)));
          }
        }
        if (['publish-workspace', 'preview-workspace', 'stop-workspace'].includes(runAction)) {
          const view = new URLSearchParams({ run: run.id, view: 'delivery' });
          const location = `/projects/${run.project.id}/epics/${run.epic.id}?${view}`;
          try {
            if (runAction === 'preview-workspace') {
              const { preview } = await call(repo, ['run', 'preview', selectedRun]);
              return send(response, 200, featurePreviewPage(preview.url));
            }
            if (runAction === 'publish-workspace') await call(repo, ['run', 'publish', selectedRun, `--attempt=${form.get('attempt') ?? ''}`]);
            else await call(repo, ['run', 'stop-preview', selectedRun]);
            return send(response, 303, '', 'text/plain', { Location: location });
          } catch (error) {
            if (error instanceof CrewError) return send(response, error.code === 3 ? 409 : 400, errorPage(error.message, location));
            throw error;
          }
        }
        if (runAction === 'automation') {
          const move = form.get('automation');
          if (!['pause', 'resume'].includes(move)) throw new CrewError('Choose whether to pause or resume automatic dispatch.');
          await setWorkflowAutomation(runStore(configurationsDb, selectedRun), move === 'resume');
          const view = new URLSearchParams({ run: run.id, view: 'workflow' });
          return send(response, 303, '', 'text/plain', { Location: `/projects/${run.project.id}/epics/${run.epic.id}?${view}` });
        }
        if (runAction === 'triage') {
          const overrides = [...form].filter(([key]) => key.startsWith('assignment-'))
            .map(([key, profileId]) => ({ taskId: key.slice('assignment-'.length), profileId }));
          const kickoff = run.automation ? await triageRun(runStore(configurationsDb, selectedRun), form.get('owner'), form.get('note'),
            overrides) :
            await beginCommand(repo, ['run', 'triage', selectedRun, `--owner=${form.get('owner') ?? ''}`,
            `--note=${form.get('note') ?? ''}`, ...overrides.map(({ taskId, profileId }) => `--assign=${taskId}=${profileId}`)], 'run.kickoff');
          const view = new URLSearchParams({ run: run.id, view: 'workflow' });
          if (kickoff.attempts?.length) view.set('step', kickoff.attempts[0].taskId);
          const location = `/projects/${run.project.id}/epics/${run.epic.id}?${view}`;
          return send(response, 303, '', 'text/plain', { Location: location });
        }
        if (runAction === 'fix') {
          const attempt = form.get('attempt');
          if (!/^[a-f0-9-]{36}$/.test(attempt ?? '')) throw new CrewError('Invalid build attempt');
          await call(repo, ['run', 'fix', selectedRun, attempt, `--note=${form.get('note') ?? ''}`]);
          const location = `/projects/${run.project.id}/epics/${run.epic.id}?run=${run.id}&view=reviews`;
          return send(response, 303, '', 'text/plain', { Location: location });
        }
        if (runAction === 'resolve-resource') {
          const resource = form.get('resource');
          if (!/^[a-f0-9-]{36}$/.test(resource ?? '')) throw new CrewError('Invalid resource request');
          await beginCommand(repo, ['resource', 'resolve', selectedRun, resource, `--note=${form.get('note') ?? ''}`], 'resource.resolved');
          const location = `/projects/${run.project.id}/epics/${run.epic.id}?run=${run.id}&view=attention#resource-${resource}`;
          return send(response, 303, '', 'text/plain', { Location: location });
        }
        const action = form.get('action');
        if (action === 'agent-continue' || action === 'agent-fork') {
          const message = form.get('message');
          const invokeSkills = form.getAll('invoke-skill').map(Number);
          try {
            const images = await readTurnImages(form);
            await queueAgentFollowUp(runStore(configurationsDb, selectedRun), id(item, 'task ID'), {
              kind: action === 'agent-fork' ? 'fork' : 'resume', attemptId: form.get('attempt'), message, invokeSkills, images,
            });
          } catch (error) {
            if (!(error instanceof CrewError)) throw error;
            const fresh = await readProjectRun(selectedRun);
            const task = fresh.tasks.find(task => task.packet.id === item);
            if (!task?.conversation) return send(response, 409, errorPage(error.message, url.pathname));
            return send(response, error.code === 3 ? 409 : 400, runPage(fresh, task, { followUpError: error.message, message, invokeSkills }));
          }
        } else if (action === 'workspace-repair') {
          const attempt = form.get('attempt');
          if (!/^[a-f0-9-]{36}$/.test(attempt ?? '')) throw new CrewError('Choose the failed verification attempt.');
          try {
            const repair = await requestWorkspaceRepair(runStore(configurationsDb, selectedRun), item, attempt, form.get('note'));
            return send(response, 303, '', 'text/plain', { Location: `/runs/${selectedRun}/tasks/${encodeURIComponent(repair.targetTaskId)}` });
          } catch (error) {
            if (error instanceof CrewError && error.code === 3) return send(response, 409, errorPage(error.message, url.pathname));
            throw error;
          }
        } else if (['steer', 'interrupt', 'answer', 'approval', 'elicitation'].includes(action)) {
          try {
            const destination = await queueWorkflowSessionAction(runStore(configurationsDb, selectedRun), id(item, 'task ID'), form.get('attempt'), {
              kind: action, turnId: form.get('turn'), message: form.get('guidance'), requestId: form.get('request'), form,
            });
            // Start navigation after the same-origin form submission completes.
            if (destination) return send(response, 200, layout('Opening tool site',
              `<main><h1>Opening tool site</h1><p><a href="${escape(destination)}" rel="noreferrer">Continue to the site</a></p></main>`),
            'text/html', { Refresh: '0; url=' + destination, 'Referrer-Policy': 'no-referrer' });
          } catch (error) {
            if (error instanceof CrewError && error.code === 3) return send(response, 409, errorPage(error.message, url.pathname));
            throw error;
          }
        } else if (action === 'allow-attempt') {
          const attempt = form.get('attempt');
          if (!/^[a-f0-9-]{36}$/.test(attempt ?? '')) throw new CrewError('Choose a workflow attempt for this approval.');
          try { await allowAdditionalAttempt(runStore(configurationsDb, selectedRun), id(item, 'task ID'), attempt, form.get('note')); }
          catch (error) {
            if (error instanceof CrewError && error.code === 3) return send(response, 409, errorPage(error.message, url.pathname));
            throw error;
          }
        } else if (action === 'recover') {
          const attempt = form.get('attempt');
          if (!/^[a-f0-9-]{36}$/.test(attempt ?? '')) throw new CrewError('Choose a workflow attempt to recover.');
          try { await call(repo, ['task', 'recover', selectedRun, id(item, 'task ID'), attempt]); }
          catch (error) {
            if (error instanceof CrewError && error.code === 3) return send(response, 409, errorPage(error.message, url.pathname));
            throw error;
          }
        } else if (action === 'dispatch' || action === 'continue-codex') {
          const attempt = form.get('attempt');
          if (action === 'continue-codex' && !/^[a-f0-9-]{36}$/.test(attempt ?? '')) throw new CrewError('Choose a saved Codex attempt.');
          await beginCommand(repo, ['task', 'dispatch', selectedRun, id(item, 'task ID'),
            ...(action === 'continue-codex' ? ['--resume-attempt', attempt] : [])], 'attempt.started');
        } else if (form.get('action') === 'attach-diff') {
          await call(repo, ['task', 'attach-diff', selectedRun, item, id(form.get('build'), 'build task ID')]);
        } else if (form.get('action') === 'decide') {
          const attempt = form.get('attempt');
          const disposition = form.get('disposition');
          if (!/^[a-f0-9-]{36}$/.test(attempt ?? '') || !['accepted', 'rework'].includes(disposition)) {
            throw new CrewError('Invalid decision target or outcome');
          }
          await call(repo, ['task', 'decide', selectedRun, item, attempt, disposition, `--note=${form.get('note') ?? ''}`]);
        } else throw new CrewError('Unknown action');
        return send(response, 303, '', 'text/plain', { Location: url.pathname });
      }
      return send(response, 404, errorPage('This page does not exist.'));
    } catch (error) {
      return send(response, error instanceof CrewError ? 400 : 500,
        errorPage(error instanceof CrewError ? error.message : 'The local UI could not load the crew record.'));
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const stopScheduler = externalWorker ? undefined : startWorkflowScheduler(configurationsDb, selectedProject.id,
    { repo, onError: reportWorkflowDispatchError });
  server.on('close', () => {
    for (const { flow } of oauthAttempts.values()) flow.cancel();
    Promise.resolve(stopScheduler?.()).finally(() => configurationsDb.end()).catch(() => {});
  });
  host = `127.0.0.1:${server.address().port}`;
  process.stdout.write(`${selectedProject.name} at http://${host}/\n`);
}
