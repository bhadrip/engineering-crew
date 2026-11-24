import { createHash } from 'node:crypto';
import { CrewError, requireField } from './contracts.mjs';
import { skillLimits, validateSkillAttachments } from './feature-profiles.mjs';

export const skillBundleLimits = Object.freeze({ files: 80, bytes: 512 * 1024, agentBytes: 1024 * 1024, workflowBytes: 2 * 1024 * 1024 });

const invalidBundle = message => new CrewError(message, 2);
const portableSegment = segment => segment && segment.isWellFormed() && segment !== '.' && segment !== '..' &&
  !/[\p{Cc}\p{Zl}\p{Zp}\\/:*?"<>|]|^[ ]|[. ]$/u.test(segment) &&
  !/^(?:\.git|\.codex|\.agents|\.aws|con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment);
const canonicalPath = path => path.normalize('NFC').toLowerCase();

function decodeFile(file) {
  if (typeof file?.data !== 'string' || file.data.length > Math.ceil(skillBundleLimits.bytes / 3) * 4)
    throw invalidBundle('A skill file is larger than the folder upload limit.');
  const bytes = Buffer.from(file.data, 'base64');
  if (bytes.toString('base64') !== file.data)
    throw invalidBundle('A skill file could not be decoded. Upload the skill folder again.');
  return bytes;
}

function validateBundle(bundle) {
  if (!bundle || typeof bundle.directory !== 'string' || bundle.directory.length > 80 || !portableSegment(bundle.directory) ||
    !Array.isArray(bundle.files) || bundle.files.length > skillBundleLimits.files)
    throw invalidBundle('Choose a skill folder with a portable name and up to ' + skillBundleLimits.files + ' supporting files.');
  const entries = new Map([['skill.md', { path: 'SKILL.md', file: true }]]);
  let totalBytes = 0;
  const files = bundle.files.map(file => {
    const path = file?.path;
    if (typeof path !== 'string' || path.length > 260 || !path.split('/').every(portableSegment))
      throw invalidBundle('A skill file has an unsupported relative path.');
    const segments = path.split('/');
    for (let n = 1; n <= segments.length; n++) {
      const part = segments.slice(0, n).join('/');
      const key = canonicalPath(part);
      const previous = entries.get(key);
      const leaf = n === segments.length;
      if (previous && (leaf || previous.file || previous.path !== part))
        throw invalidBundle('A skill folder has conflicting file or directory names.');
      entries.set(key, { path: part, file: leaf });
    }
    const bytes = decodeFile(file);
    totalBytes += bytes.length;
    if (totalBytes > skillBundleLimits.bytes)
      throw invalidBundle('A skill folder can contain up to ' + skillBundleLimits.bytes / 1024 + ' KiB of supporting files.');
    return { path, data: file.data };
  });
  return { directory: bundle.directory, files: files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0), totalBytes };
}

export const workflowSkillDirectory = (skill, index) => skill.bundle?.directory ?? 'crew-skill-' + (index + 1);
export const workflowSkillManifestPath = (skill, index) => '.agents/skills/' + workflowSkillDirectory(skill, index) + '/SKILL.md';

export function nativeSkillChoices(workspace, names = []) {
  return ['read-only', 'workspace-write'].includes(workspace)
    ? names.map((name, index) => ({ number: index + 1, name })) : [];
}

export function validateSkillInvocations(numbers, choices) {
  requireField(Array.isArray(numbers) && new Set(numbers).size === numbers.length &&
    numbers.every(number => choices.some(choice => choice.number === number)), 'Choose skills attached to this agent version.');
  return numbers.toSorted((a, b) => a - b);
}

export function readWorkflowSkillAttachments(form) {
  const names = form.getAll('skill-name');
  const contents = form.getAll('skill-content');
  const bundles = form.getAll('skill-bundle');
  if (names.length !== contents.length || names.length > skillLimits.count || (bundles.length && bundles.length !== names.length))
    throw invalidBundle('Invalid skill attachments.');
  return names.map((name, index) => {
    const skill = { name: name.trim(), content: contents[index].replace(/\r\n?/g, '\n') };
    if (!bundles[index]) return skill;
    try { return { ...skill, bundle: JSON.parse(bundles[index]) }; }
    catch { throw invalidBundle('A skill folder attachment could not be read. Upload it again.'); }
  });
}

export function validateWorkflowSkills(skills) {
  if (!Array.isArray(skills)) return validateSkillAttachments(skills);
  const validated = validateSkillAttachments(skills.map(skill => {
    if (!skill || typeof skill !== 'object') return skill;
    const { bundle, ...attachment } = skill;
    return attachment;
  }));
  const directories = new Set();
  let totalBytes = 0;
  return validated.map((skill, index) => {
    const bundle = Object.hasOwn(skills[index], 'bundle') ? validateBundle(skills[index].bundle) : null;
    const directory = canonicalPath(workflowSkillDirectory({ bundle }, index));
    if (directories.has(directory)) throw invalidBundle('Each skill needs a distinct folder name.');
    directories.add(directory);
    if (!bundle) return skill;
    totalBytes += bundle.totalBytes;
    if (totalBytes > skillBundleLimits.agentBytes)
      throw invalidBundle('An agent can attach up to ' + skillBundleLimits.agentBytes / (1024 * 1024) + ' MiB of skill resources.');
    return { ...skill, bundle: { directory: bundle.directory, files: bundle.files } };
  });
}

export function skillAssetDetails(file) {
  const bytes = decodeFile(file);
  return { path: file.path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}
