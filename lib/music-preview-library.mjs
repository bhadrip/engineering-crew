import { createHash } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import { link, lstat, mkdir, mkdtemp, open, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';

const missing = error => error.code === 'ENOENT';
const lessonFile = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.json$/i;

async function entry(path) {
  try { return await lstat(path); }
  catch (error) { if (!missing(error)) throw error; }
}

async function regularFile(path) {
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (!missing(error) && error.code !== 'ELOOP') throw error; return; }
  if ((await file.stat()).isFile()) return file;
  await file.close();
}

async function metadata(path) {
  const file = await regularFile(path);
  if (!file) return;
  try {
    if ((await file.stat()).size <= 2 * 1024 * 1024) return await file.readFile('utf8');
  } finally { await file.close(); }
}

async function contentDigest(path) {
  const file = await regularFile(path);
  if (!file) return;
  const digest = createHash('sha256');
  for await (const chunk of file.createReadStream()) digest.update(chunk);
  return digest.digest('hex');
}

async function linkIfMissing(staged, destination) {
  try { await link(staged, destination); return true; }
  catch (error) { if (error.code !== 'EEXIST') throw error; return false; }
}

// Only completed Music Transcribe lessons are copied. The original volume is
// mounted read-only, and each new lesson becomes visible after its audio exists.
export async function inheritMusicLessonLibrary(source, target, sourceRunId) {
  const marker = join(target, '.crew-inherited-lessons.json');
  const existing = await metadata(marker);
  if (existing) {
    const recorded = JSON.parse(existing);
    if (recorded.sourceRunId !== sourceRunId || !Number.isSafeInteger(recorded.copiedLessons) || recorded.copiedLessons < 0)
      throw new Error('The saved lesson library came from a different delivery.');
    return recorded;
  }
  if (await entry(marker)) throw new Error('The saved lesson import record is invalid.');
  const receipt = { sourceRunId, copiedLessons: 0 };
  const stage = await mkdtemp(join(target, '.crew-library-copy-'));
  try {
    if (source && (await entry(join(source, 'audio')))?.isDirectory() && (await entry(join(source, 'lessons')))?.isDirectory()) {
      const targetAudio = join(target, 'audio');
      const targetLessons = join(target, 'lessons');
      for (const directory of [targetAudio, targetLessons]) {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        if (!(await lstat(directory)).isDirectory()) throw new Error('The delivered app has an invalid lesson directory.');
      }
      for (const name of (await readdir(join(source, 'lessons'))).filter(name => lessonFile.test(name))) {
        const id = name.slice(0, -5);
        const destination = join(targetLessons, name);
        const json = await metadata(join(source, 'lessons', name));
        let lesson;
        try { lesson = JSON.parse(json); } catch { continue; }
        if (lesson?.id !== id) continue;
        const sourceWav = join(source, 'audio', id + '.wav');
        const wav = join(targetAudio, id + '.wav');
        if (await entry(destination)) {
          if (await metadata(destination) === json) {
            const digest = await contentDigest(sourceWav);
            if (digest && digest === await contentDigest(wav)) receipt.copiedLessons++;
          }
          continue;
        }
        const audio = await regularFile(sourceWav);
        if (!audio) continue;
        const stagedWav = join(stage, id + '.wav');
        await pipeline(audio.createReadStream(), createWriteStream(stagedWav, { flags: 'wx', mode: 0o600 }));
        const copied = await linkIfMissing(stagedWav, wav);
        const matches = copied || (await contentDigest(wav)) === (await contentDigest(stagedWav));
        await rm(stagedWav);
        if (!matches) continue;
        const stagedLesson = join(stage, name);
        await writeFile(stagedLesson, json, { flag: 'wx', mode: 0o600 });
        if (await linkIfMissing(stagedLesson, destination)) receipt.copiedLessons++;
        await rm(stagedLesson);
      }
    }
    const stagedMarker = join(stage, 'receipt.json');
    await writeFile(stagedMarker, JSON.stringify(receipt), { flag: 'wx', mode: 0o600 });
    if (!await linkIfMissing(stagedMarker, marker)) throw new Error('The lesson library was initialized concurrently.');
    return receipt;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [, , source, sourceRunId] = process.argv;
  console.log(JSON.stringify(await inheritMusicLessonLibrary(source === '-' ? null : source, '/data', sourceRunId)));
}
