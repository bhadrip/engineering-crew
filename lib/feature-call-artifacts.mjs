import { createHash } from 'node:crypto';

const sha = text => createHash('sha256').update(text, 'utf8').digest('hex');

export function callInput(prompt, config) {
  const promptSha256 = sha(prompt);
  const digest = sha(JSON.stringify(['crew-codex-input-v1', promptSha256, config]));
  return { digest, promptSha256, prompt, config };
}

export function callOutput(raw) {
  return { digest: sha(raw), raw };
}
