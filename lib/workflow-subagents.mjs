import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CrewError } from './contracts.mjs';
import { reasoningEfforts } from './feature-profiles.mjs';

export const subagentRoleLimits = Object.freeze({ name: 40, description: 1000, instructions: 16_384, total: 65_536 });
const reservedNames = new Set(['enabled', 'max_threads', 'max_depth', 'max_concurrent_threads_per_session',
  'default_subagent_model', 'default_subagent_reasoning_effort', 'interrupt_message']);
const roleName = /^[a-z][a-z0-9_-]{0,39}$/;
const optionalModel = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/;
const fail = message => { throw new CrewError(message, 2); };
const validText = (value, bytes) => typeof value === 'string' && value.isWellFormed() && value.trim().length > 0 &&
  !value.includes('\0') && Buffer.byteLength(value) <= bytes;

export function validateSubagentRoles(roles = []) {
  if (!Array.isArray(roles)) fail('Enter valid Codex specialist definitions.');
  const names = new Set();
  const validated = roles.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Enter a valid Codex specialist.');
    const { name, description, instructions, model = '', reasoningEffort = '' } = value;
    if (typeof name !== 'string' || !roleName.test(name) || reservedNames.has(name))
      fail('Use a specialist name starting with a lowercase letter, followed by up to 39 lowercase letters, numbers, hyphens, or underscores. Choose a name other than a Codex setting.');
    if (names.has(name)) fail('Each specialist needs a distinct name.');
    if (!validText(description, subagentRoleLimits.description) || !validText(instructions, subagentRoleLimits.instructions))
      fail('Give each specialist a description of up to 1,000 bytes and instructions of up to 16 KiB.');
    if (typeof model !== 'string' || (model && !optionalModel.test(model)) ||
        (reasoningEffort !== '' && !reasoningEfforts.includes(reasoningEffort)))
      fail('Choose a valid specialist model and reasoning effort.');
    names.add(name);
    return { name, description: description.trim(), instructions, ...(model && { model }), ...(reasoningEffort && { reasoningEffort }) };
  });
  if (Buffer.byteLength(JSON.stringify(validated)) > subagentRoleLimits.total)
    fail('Specialist definitions can total up to 64 KiB per agent.');
  return validated;
}

export const subagentRolePath = (directory, name) => join(directory, 'subagents', name + '.toml');

export function subagentRoleToml({ name, description, instructions, model, reasoningEffort }) {
  return Object.entries({ name, description, developer_instructions: instructions,
    ...(model && { model }), ...(reasoningEffort && { model_reasoning_effort: reasoningEffort }),
  }).map(([key, value]) => key + ' = ' + JSON.stringify(value).replaceAll('\u007f', '\\u007f')).join('\n') + '\n';
}

export async function stageSubagentRoles(directory, roles) {
  if (!roles.length) return;
  await mkdir(join(directory, 'subagents'), { mode: 0o700 });
  await Promise.all(roles.map(role => writeFile(subagentRolePath(directory, role.name), subagentRoleToml(role),
    { mode: 0o600, flag: 'wx' })));
}
