import { execFileSync } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { editProjectProfile } from '../../lib/local-profile-file.mjs';
import { musicProfile } from './profile.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const local = join(root, '.crew-local');
const build = join(local, 'audio-image');
await mkdir(build, { recursive: true, mode: 0o700 });

async function cached(name, url, algorithm, expected) {
  const path = join(build, name);
  const valid = async () => {
    try { return createHash(algorithm).update(await readFile(path)).digest('hex') === expected; }
    catch (err) { if (err.code === 'ENOENT') return false; throw err; }
  };
  if (await valid()) return;
  execFileSync('curl', ['--fail', '--location', '--silent', '--show-error', '--retry', '2', '--output', path, url], { stdio: 'inherit' });
  if (!await valid()) throw new Error('Checksum mismatch for ' + name);
}
await cached('whisper.tar.gz', 'https://codeload.github.com/ggml-org/whisper.cpp/tar.gz/4979e04f5dcaccb36057e059bbaed8a2f5288315',
  'sha256', 'ec8e33f4c838ed459ad0a23da255c0262f150a6f54839a17e504ddf1495305d5');
await cached('ggml-base.bin', 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin',
  'sha1', '465707469ff3a37a2b9b8d8f89f2f99de7299dac');
execFileSync('docker', ['build', '-t', 'engineering-crew-music:local', '-f', join(root, 'examples/music-transcribe/Dockerfile.audio'), build], { stdio: 'inherit' });
execFileSync('python3', [join(root, 'examples/music-transcribe/generate-class.py'), '--out', join(local, 'assets')], { stdio: 'inherit' });
await editProjectProfile(root, 'music-transcribe', musicProfile);
