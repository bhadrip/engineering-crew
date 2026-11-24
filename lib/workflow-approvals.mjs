import { requireField } from './contracts.mjs';

const commandMethod = 'item/commandExecution/requestApproval';
const fileMethod = 'item/fileChange/requestApproval';
const permissionMethod = 'item/permissions/requestApproval';
export const codexApprovalMethods = new Set([commandMethod, fileMethod, permissionMethod]);

const decisions = {
  accept: 'Allow once', acceptForSession: 'Allow for this session', decline: 'Decline', cancel: 'Cancel turn',
};

function decisionLabel(value) {
  if (typeof value === 'string' && Object.hasOwn(decisions, value)) return decisions[value];
  const rule = value?.acceptWithExecpolicyAmendment?.execpolicy_amendment;
  if (Array.isArray(rule) && rule.every(part => typeof part === 'string')) return 'Allow and save command rule ' + JSON.stringify(rule);
  const network = value?.applyNetworkPolicyAmendment?.network_policy_amendment;
  if (typeof network?.host === 'string' && ['allow', 'deny'].includes(network.action))
    return (network.action === 'allow' ? 'Save network allow rule for ' : 'Save network deny rule for ') + network.host;
}

function requestedPermissions(profile) {
  const grants = [];
  if (profile?.network?.enabled === true) grants.push({ label: 'Network access', kind: 'network' });
  const files = profile?.fileSystem;
  if (Array.isArray(files?.entries) && files.entries.length) {
    for (const entry of files.entries) {
      if (!['read', 'write'].includes(entry?.access) || !entry.path) continue;
      const target = entry.path.path ?? entry.path.pattern ?? JSON.stringify(entry.path.value);
      if (target) grants.push({ label: `${entry.access === 'read' ? 'Read' : 'Write'} ${target}`, kind: 'entry', value: entry });
    }
  } else {
    for (const kind of ['read', 'write']) {
      for (const path of files?.[kind] ?? []) grants.push({ label: `${kind === 'read' ? 'Read' : 'Write'} ${path}`, kind, value: path });
    }
  }
  return grants;
}

function grantResponse(grants, review, globScanMaxDepth) {
  if (review.choice === 'decline') return { permissions: {}, scope: 'turn' };
  const selected = review.grants.map(index => grants[index]);
  if (!['turn', 'session'].includes(review.choice) || !selected.length || selected.some(grant => !grant)) return null;
  const network = selected.some(grant => grant.kind === 'network');
  const read = selected.filter(grant => grant.kind === 'read').map(grant => grant.value);
  const write = selected.filter(grant => grant.kind === 'write').map(grant => grant.value);
  const entries = selected.filter(grant => grant.kind === 'entry').map(grant => grant.value);
  return { scope: review.choice, permissions: {
    ...(network && { network: { enabled: true } }),
    ...((read.length || write.length || entries.length) && { fileSystem: { read: read.length ? read : null, write: write.length ? write : null,
      ...(entries.length && { entries, ...(Number.isInteger(globScanMaxDepth) && { globScanMaxDepth }) }) } }),
  } };
}

export function codexApproval(method, params, item) {
  const context = { reason: params.reason, cwd: params.cwd ?? item?.cwd };
  if (method === permissionMethod) {
    const grants = requestedPermissions(params.permissions);
    return { approval: { type: 'permissions', ...context, grants: grants.map(grant => grant.label) },
      respond: review => grantResponse(grants, review, params.permissions?.fileSystem?.globScanMaxDepth) };
  }
  const network = params.networkApprovalContext;
  const command = params.command ?? item?.command;
  const changes = method === fileMethod ? item?.changes : undefined;
  const visible = Boolean(command || network?.host || changes?.length || params.grantRoot);
  const offered = method === commandMethod && Array.isArray(params.availableDecisions) ? params.availableDecisions : Object.keys(decisions);
  const choices = offered.flatMap(value => {
    const label = decisionLabel(value);
    return label && (visible || value === 'decline' || value === 'cancel') ? [{ label, value }] : [];
  });
  if (!choices.length) return null;
  return { approval: { type: method === fileMethod ? 'file' : network?.host ? 'network' : params.kind === 'writeStdin' ? 'stdin' : 'command',
    ...context, command, network, changes, grantRoot: params.grantRoot,
    additionalPermissions: requestedPermissions(params.additionalPermissions).map(grant => grant.label),
    choices: choices.map(choice => choice.label), visible },
    respond({ choice }) { return choices[choice] ? { decision: choices[choice].value } : null; } };
}

function optionIndex(value, options) {
  const index = /^(0|[1-9][0-9]*)$/.test(value ?? '') ? Number(value) : -1;
  requireField(index >= 0 && index < options.length, 'Choose a decision offered by Codex.');
  return index;
}

export function approvalReview(approval, form) {
  const choice = form.get('choice');
  if (approval.type !== 'permissions') return { choice: optionIndex(choice, approval.choices) };
  if (choice === 'decline') return { choice, grants: [] };
  requireField(choice === 'turn' || choice === 'session', 'Choose the permission grant duration.');
  const grants = [...new Set(form.getAll('grant').map(value => optionIndex(value, approval.grants)))];
  requireField(grants.length, 'Select at least one requested permission.');
  return { choice, grants };
}

export function approvalReviewLabel(approval, review) {
  if (!review) return '';
  if (approval.type !== 'permissions') return approval.choices[review.choice];
  if (review.choice === 'decline') return 'Decline';
  return (review.choice === 'session' ? 'Allow for this session' : 'Allow for this turn') + ' · ' +
    review.grants.map(index => approval.grants[index]).join(', ');
}
