import { CrewError, requireField } from './contracts.mjs';
import { artifact, artifactDigest } from './run-store.mjs';

export const agentImageLimits = Object.freeze({ count: 4, fileBytes: 4 * 1024 * 1024, totalBytes: 6 * 1024 * 1024 });
export const imageBase64Limit = Math.ceil(agentImageLimits.fileBytes / 3) * 4;
export const agentImagesEnabled = projectId => projectId === 'music-transcribe';

const pngSignature = Buffer.from('89504e470d0a1a0a', 'hex');
const jpegFrames = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function jpegSize(bytes) {
  for (let offset = 2; offset + 3 < bytes.length && bytes[offset] === 0xff;) {
    while (bytes[offset + 1] === 0xff) offset++;
    const marker = bytes[offset + 1];
    if (marker === 0xda || marker === 0xd9 || offset + 3 >= bytes.length) return;
    const length = bytes.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > bytes.length) return;
    if (jpegFrames.has(marker)) {
      if (length < 8) return;
      return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) };
    }
    offset += 2 + length;
  }
}

function imageFormat(bytes) {
  if (bytes.length >= 45 && bytes.subarray(0, 8).equals(pngSignature) &&
      bytes.readUInt32BE(8) === 13 && bytes.toString('ascii', 12, 16) === 'IHDR')
    return { mimeType: 'image/png', extension: 'png', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  if (bytes.length >= 12 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    const dimensions = jpegSize(bytes);
    if (dimensions) return { mimeType: 'image/jpeg', extension: 'jpg', ...dimensions };
  }
}

function checkedImage(data) {
  requireField(Buffer.isBuffer(data) && data.length <= agentImageLimits.fileBytes, 'Each image can be up to 4 MiB.');
  const format = imageFormat(data);
  requireField(format, 'Choose a PNG or JPEG image.');
  requireField(format.width > 0 && format.height > 0 && format.width <= 8192 && format.height <= 8192 &&
    format.width * format.height <= 24_000_000, 'Use images up to 8192 pixels per side and 24 megapixels.');
  return format;
}

export function normalizeAgentImages(images) {
  requireField(Array.isArray(images) && images.length <= agentImageLimits.count, 'Attach up to four images.');
  let bytes = 0;
  return images.map((image, index) => {
    const { name, data } = image ?? {};
    const { mimeType } = checkedImage(data);
    bytes += data.length;
    requireField(bytes <= agentImageLimits.totalBytes, 'Images can total up to 6 MiB.');
    const label = typeof name === 'string' ? name.trim().replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, '').split(/[\\/]/).at(-1).slice(0, 160) : '';
    return { name: label || 'Image ' + (index + 1), mimeType, data, sha256: artifactDigest(data) };
  });
}

function imageArtifact(id, { name, data, mimeType, sha256 }, origin) {
  return artifact(id, name, 'agent-image', data.toString('base64'), { ...origin, mimeType, bytes: data.length, sha256 });
}

function imageArtifacts(images, prefix, origin) {
  return images.map((image, index) => imageArtifact(prefix + (index + 1), image, origin));
}

export function agentImageArtifacts(images, turn) {
  return imageArtifacts(images, 'agent-image-' + turn + '-', { source: 'agent-image', turn });
}

export function workflowRequestImageArtifacts(images, runId) {
  return imageArtifacts(images, 'request-image-', { source: 'workflow-request-image', runId });
}

export function codexGeneratedImage(encoded, number) {
  requireField(typeof encoded === 'string' && encoded.length <= imageBase64Limit + 32,
    'The Codex image exceeds the 4 MiB limit or has no image data.');
  const base64 = encoded.replace(/^data:image\/(?:png|jpeg);base64,/, '');
  const data = Buffer.from(base64, 'base64');
  requireField(data.toString('base64') === base64, 'Codex did not return valid image bytes.');
  return normalizeAgentImages([{ name: 'Generated image ' + number, data }])[0];
}

export function codexGeneratedImageArtifact(image, attemptId, itemId, number) {
  return imageArtifact('generated-image-' + attemptId + '-' + number, image, { source: 'codex-generated-image', attemptId, itemId });
}

export function browserScreenshotArtifact(image, attemptId, number) {
  return imageArtifact('browser-screenshot-' + attemptId + '-' + number, image, { source: 'codex-browser-screenshot', attemptId });
}

export function imageArtifactReferences(records) {
  return records.map(({ id, title, digest }) => ({ artifactId: id, name: title, digest }));
}

export function readAgentImage(record) {
  requireField(record?.kind === 'agent-image' &&
    ['agent-image', 'workflow-request-image', 'codex-generated-image', 'codex-browser-screenshot'].includes(record.provenance?.source),
    'This artifact is not a saved image.');
  const { bytes, sha256, mimeType } = record.provenance;
  const data = Buffer.from(record.content, 'base64');
  const format = checkedImage(data);
  if (data.length !== bytes || format.mimeType !== mimeType || artifactDigest(data) !== sha256)
    throw new CrewError('The saved image does not match its recorded digest.', 3);
  return { artifactId: record.id, name: record.title, mimeType, extension: format.extension, bytes, sha256, data };
}
