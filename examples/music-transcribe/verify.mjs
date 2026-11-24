import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const overlap = (a, b) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
const duration = clip => clip.end - clip.start;
const validClip = clip => clip && Number.isFinite(clip.start) && Number.isFinite(clip.end) && clip.start >= 0 && clip.end > clip.start;

// Answer keys stay in the operator's fixture directory; the candidate receives only PCM audio.
export async function verifyLessons(assets, { url, signal }, { practiceOnly = false } = {}) {
  const lessons = [];
  for (const name of (practiceOnly ? ['lesson'] : ['lesson', 'held-out'])) {
    const audio = await readFile(join(assets, name + '.wav'));
    const expected = JSON.parse(await readFile(join(assets, name + '.expected.json'), 'utf8'));
    const opts = { signal, redirect: 'error' };
    const upload = await fetch(url + '/api/lessons', { ...opts, method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: audio });
    if (!upload.ok) return { passed: false, lessons, error: 'Fixture ' + name + ' upload returned HTTP ' + upload.status + ': ' + (await upload.text()).slice(0, 400) };
    const record = await upload.json();
    const target = url + '/api/lessons/' + encodeURIComponent(record.id);
    const stored = await fetch(target, opts);
    const replay = await fetch(target + '/audio', opts);
    const sameAudio = replay.ok && Buffer.from(await replay.arrayBuffer()).equals(audio);
    const song = record.song;
    const matchedSong = validClip(song) && overlap(song, expected.song) / duration(expected.song) >= .7 &&
      overlap(song, expected.song) / duration(song) >= .55;
    const corrections = Array.isArray(record.corrections) ? record.corrections : [];
    const cue = /breath/i.test(expected.correction.text) ? /breath|breathe|breathing/i : /hold|longer|counts?|sustain|stretch/i;
    const match = corrections.find(c => validClip(c) && overlap(c, expected.correction) > 0 && cue.test(c.text));
    const phrase = match && { start: match.phraseStart, end: match.phraseEnd };
    const paired = validClip(phrase) && expected.phrases.some(clip => overlap(phrase, clip) / duration(phrase) >= .4) &&
      duration(phrase) < duration(expected.song);
    const saved = stored.ok && (await stored.json()).id === record.id;
    const passed = Boolean(matchedSong && match && paired && saved && sameAudio && record.transcript?.some(item => validClip(item) && item.text));
    lessons.push({ fixture: name, audioSha256: createHash('sha256').update(audio).digest('hex'), passed,
      fullRenditionMatched: Boolean(matchedSong), correctionMatched: Boolean(match),
      phrasePaired: Boolean(paired), saved, sameAudio,
      ...(practiceOnly ? { observedSong: song, corrections, transcript: record.transcript?.slice(0, 20),
        expectedTeacherRendition: expected.song, expectedCorrection: expected.correction,
        expectedPhraseOptions: expected.phrases.map(({ start, end }) => ({ start, end })) } : {}) });
  }
  return { passed: lessons.every(lesson => lesson.passed), lessons };
}
