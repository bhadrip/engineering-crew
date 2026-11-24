import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateWorkflowSkills, workflowSkillDirectory, workflowSkillManifestPath } from './workflow-skills.mjs';
import { listGeneratedImagesTool, workflowSubmissionTools, workspaceCheckpointTool } from './workflow-submissions.mjs';

export const workflowAgentServer = 'crew_workflow';
export const musicPracticeTool = 'check_music_sample';
export const musicBrowserTool = 'browse_music_workspace';
export const workflowAgentTools = Object.freeze({
  list_inputs: { title: 'List inputs', description: 'Inspect the inputs and accepted handoffs available to this assignment.' },
  read_input: { title: 'Read input', description: 'Read a section of a pinned input or handoff by its ID.' },
  search_inputs: { title: 'Search inputs', description: 'Find matching lines across the assignment’s pinned inputs.' },
  [musicPracticeTool]: { title: 'Check Music Transcribe sample', projectId: 'music-transcribe',
    description: 'Test the current workspace in local Docker with Node, health, and the development recording. Returns observed timings and a saved check receipt.' },
  [musicBrowserTool]: { title: 'Browse Music Transcribe workspace', projectId: 'music-transcribe',
    description: 'Open a disposable browser for the current workspace. Inspect the page, wait for UI state, click accessible controls, use the synthetic lesson, observe media playback, change viewport, and save screenshots. Restart applies workspace edits.' },
});
export const defaultWorkflowAgentTools = Object.freeze(Object.keys(workflowAgentTools).filter(name => !workflowAgentTools[name].projectId));

export const workflowSkillTools = skills => [
  ...(skills.length ? ['read_skill'] : []),
  ...(skills.some(skill => skill.bundle?.files.length) ? ['read_skill_file'] : []),
];

const skillFrontmatter = content => /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(content);

function declaredSkillName(content) {
  const name = skillFrontmatter(content)?.[1].match(/^name:[ \t]*([^\r\n]+)$/m)?.[1].trim().replace(/^(['"])(.*)\1$/, '$2');
  return name && /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(name) ? name : null;
}

export function skillDescription(skill) {
  const frontmatter = skillFrontmatter(skill.content);
  const description = frontmatter?.[1].match(/^description:[ \t]*([^\r\n]+)$/m)?.[1].trim().replace(/^(['"])(.*)\1$/, '$2');
  return { description: description?.slice(0, 400) || 'Use the operator-provided guidance for ' + skill.name + '.',
    body: frontmatter ? skill.content.slice(frontmatter[0].length) : skill.content };
}

export function nativeWorkflowSkill(skill, index) {
  const id = 'crew-skill-' + (index + 1);
  const name = declaredSkillName(skill.content) ?? (skill.bundle ? null : id);
  if (!name)
    throw new Error('The saved folder for ' + skill.name + ' needs a Codex skill name in its SKILL.md frontmatter.');
  return { id, name, title: skill.name, manifestPath: workflowSkillManifestPath(skill, index) };
}

export async function prepareWorkflowAgentTools(directory, { inputs, skills, tools, practiceConnection, browserConnection, submissions,
  serverName = workflowAgentServer }, workspace = directory) {
  const skillData = validateWorkflowSkills(skills).map((skill, index) => ({ ...skill, id: 'crew-skill-' + (index + 1) }));
  for (const [index, skill] of skillData.entries()) {
    const folder = join(workspace, '.agents', 'skills', workflowSkillDirectory(skill, index));
    const { description, body } = skillDescription(skill);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const manifest = skill.bundle || declaredSkillName(skill.content) ? skill.content :
      '---\nname: ' + skill.id + '\ndescription: ' + JSON.stringify(description) +
      '\n---\n\n# ' + skill.name + '\n\n' + body;
    await writeFile(join(folder, 'SKILL.md'), manifest, { mode: 0o600, flag: 'wx' });
    for (const file of skill.bundle?.files ?? []) {
      const path = join(folder, file.path);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, Buffer.from(file.data, 'base64'), {
        mode: file.path.startsWith('scripts/') ? 0o700 : 0o600, flag: 'wx',
      });
    }
  }
  const enabled = [...tools, ...workflowSkillTools(skillData), ...(submissions?.slots ? Object.keys(workflowSubmissionTools) : []),
    ...(submissions?.imageOutputs ? [listGeneratedImagesTool] : []),
    ...(submissions?.workspace ? [workspaceCheckpointTool] : [])];
  if (!enabled.length) return null;
  const file = 'workflow-inputs.json';
  await writeFile(join(directory, file), JSON.stringify({ inputs, skills: skillData, enabled,
    ...(practiceConnection && { practiceConnection }), ...(browserConnection && { browserConnection }), ...(submissions && { submissions }) }), { mode: 0o600 });
  return { name: serverName, program: process.execPath, script: fileURLToPath(new URL('../bin/workflow-tools.mjs', import.meta.url)), file, enabled };
}
