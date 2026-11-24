import { CrewError, id } from './contracts.mjs';

export const browserActivitySlot = 'browser-activity';
export const isRuntimeEvidenceSlot = (source, slot) =>
  (slot === browserActivitySlot && !source?.outputs?.some(output => output.id === slot)) ||
  (slot === 'check-receipt' && Boolean(source?.workspaceCheck));

export const artifactOutputKinds = Object.freeze({ markdown: 'Markdown', json: 'JSON', text: 'Plain text', image: 'Generated image',
  'browser-screenshot': 'Browser screenshot', 'browser-report': 'Browser observation' });
export const isBrowserOutput = kind => kind === 'browser-screenshot' || kind === 'browser-report';
export const isImageOutput = kind => kind === 'image' || kind === 'browser-screenshot';
export const isEvidenceOutput = kind => kind === 'image' || isBrowserOutput(kind);

// Configured workflows extend the legacy authored-output slot with a format.
// Run packets expose the effective format as the output kind Codex receives.
export function workflowOutputSlot(slot) {
  if (slot.kind !== 'markdown' || slot.format === 'markdown' || !Object.hasOwn(artifactOutputKinds, slot.format)) return slot;
  const { format, ...rest } = slot;
  return { ...rest, kind: format };
}

export function validateWorkflowOutputFormat(slot, content) {
  if (slot?.kind === 'json') {
    try { JSON.parse(content); } catch { throw new CrewError('Output ' + slot.id + ' must contain valid JSON'); }
  }
  if (isEvidenceOutput(slot?.kind)) id(content, 'evidence artifact ID');
}

export function validateWorkflowArtifacts(response, packet) {
  for (const { slot, content } of response.outputs)
    validateWorkflowOutputFormat(packet.outputs.find(output => output.id === slot), content);
}
