import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { verifyLessons } from '../examples/music-transcribe/verify.mjs';
import { CrewError, requireField } from './contracts.mjs';
import { inspectAppImage, runNodeTests, startFeaturePreview } from './feature-app.mjs';
import { readProjectProfile } from './local-profile-file.mjs';
import { artifactDigest } from './run-store.mjs';
import { captureWorkflowWorkspace, materializeWorkspaceFiles } from './workflow-workspace.mjs';

export const musicWorkspaceCheck = 'music-transcribe-audio';
const names = ['lesson', 'held-out'];
const practiceNames = ['lesson'];
const digest = data => createHash('sha256').update(data).digest('hex');
const digestPattern = /^[0-9a-f]{64}$/;
const verifierDigest = digest(readFileSync(new URL('../examples/music-transcribe/verify.mjs', import.meta.url)));
const checkDefinitions = [
  ['author-tests', 'Node author tests'], ['app-health', 'Application health'], ['audio-acceptance', 'Music Transcribe audio acceptance'],
];

async function readFixtures(repo, selected) {
  return Promise.all(selected.map(async name => {
    const [audio, key] = await Promise.all(['.wav', '.expected.json'].map(ext => readFile(join(repo, '.crew-local', 'assets', name + ext))));
    return { name, audio, key, audioSha256: digest(audio), expectedSha256: digest(key) };
  }));
}

async function pinMusicChecks(repo, selected, label) {
  const config = await readProjectProfile(repo, 'music-transcribe');
  requireField(config.acceptance === 'carnatic-lesson' && config.image, 'Configure the local Music Transcribe audio runtime before enabling ' + label + ' checks.');
  try {
    const [image, fixtures] = await Promise.all([inspectAppImage(config.image), readFixtures(repo, selected)]);
    return { image, verifierDigest, fixtures: fixtures.map(({ name, audioSha256, expectedSha256 }) => ({ name, audioSha256, expectedSha256 })) };
  } catch { throw new CrewError('The local Music Transcribe Docker image or ' + label + ' fixtures are unavailable.'); }
}

export const pinMusicWorkspaceChecks = repo => pinMusicChecks(repo, names, 'acceptance');
export const pinMusicPracticeChecks = repo => pinMusicChecks(repo, practiceNames, 'development audio');

function isPinnedProfile(profile, selected) {
  return /^sha256:[a-f0-9]{64}$/.test(profile?.image) && digestPattern.test(profile.verifierDigest) &&
    Array.isArray(profile.fixtures) && profile.fixtures.length === selected.length && profile.fixtures.every((fixture, index) =>
      fixture?.name === selected[index] && digestPattern.test(fixture.audioSha256) && digestPattern.test(fixture.expectedSha256));
}

export function validateMusicPracticeProfile(profile) {
  requireField(isPinnedProfile(profile, practiceNames), 'Pin the Music Transcribe development recording and Docker image before enabling the tool.');
}

export function validateMusicWorkspaceChecks(project) {
  const checked = project.tasks.filter(task => task.workspaceCheck !== undefined);
  if (!checked.length) return;
  const profile = project.workspaceCheckProfile;
  requireField(project.id === 'music-transcribe' && checked.every(task => task.workspaceCheck === musicWorkspaceCheck &&
    (['baseline', 'delivery'].includes(task.workspaceSource) || task.workspaceSource?.startsWith('step:')) && !task.execution),
  'Music Transcribe checks require pinned project files, a published delivery, or an accepted workspace from a prerequisite.');
  requireField(isPinnedProfile(profile, names), 'Pin the current Music Transcribe acceptance profile before running checks.');
}

export async function checkMusicAudioSetup(repo, profile, signal, practiceOnly = false) {
  const fixtures = await readFixtures(repo, practiceOnly ? practiceNames : names);
  requireField(verifierDigest === profile.verifierDigest && isDeepStrictEqual(
    fixtures.map(({ name, audioSha256, expectedSha256 }) => ({ name, audioSha256, expectedSha256 })), profile.fixtures),
  practiceOnly ? 'The development recording or verifier changed since this agent version was saved.'
    : 'The local audio fixtures or verifier changed since this workflow version was saved.');
  const image = await inspectAppImage(profile.image, signal);
  requireField(image === profile.image, 'The local Docker image does not match the pinned image.');
  return { fixtures, image };
}

export function runMusicWorkspaceChecks(job, repo, signal) {
  const { workspaceCheckProfile: profile, workspaceFiles: files, attempt } = job;
  return runMusicChecks({ profile, files, projectId: job.projectId, repo, signal,
    workspaceArtifactId: attempt.workspaceInput.artifactId, workspaceDigest: attempt.workspaceInput.digest });
}

export async function runMusicPracticeChecks({ profile, workspace, inputFolder, repo, signal, capture }) {
  validateMusicPracticeProfile(profile);
  const files = await (capture ? capture(signal) : captureWorkflowWorkspace(workspace, inputFolder, signal));
  requireField(files.some(file => file.path === 'server.mjs'), 'Add server.mjs to the workspace before checking the development recording.');
  const workspaceDigest = artifactDigest(JSON.stringify({ schemaVersion: 1, files }));
  return runMusicChecks({ profile, files, projectId: 'music-transcribe', repo, signal, practiceOnly: true, workspaceDigest });
}

function practiceResult(result) {
  const clip = value => value && ({
    start: Number.isFinite(value.start) ? value.start : null, end: Number.isFinite(value.end) ? value.end : null,
    ...(typeof value.text === 'string' && { text: value.text.slice(0, 400) }),
    ...(Number.isFinite(value.phraseStart) && { phraseStart: value.phraseStart }),
    ...(Number.isFinite(value.phraseEnd) && { phraseEnd: value.phraseEnd }),
  });
  const clips = (values, limit) => Array.isArray(values) ? values.slice(0, limit).filter(Boolean).map(clip) : [];
  return { ...result, lessons: result.lessons.map(lesson => ({
    ...lesson, observedSong: clip(lesson.observedSong), corrections: clips(lesson.corrections, 12),
    transcript: clips(lesson.transcript, 20), expectedTeacherRendition: clip(lesson.expectedTeacherRendition),
    expectedCorrection: clip(lesson.expectedCorrection), expectedPhraseOptions: clips(lesson.expectedPhraseOptions, 8),
  })) };
}

async function runMusicChecks({ profile, files, projectId, repo, signal, workspaceArtifactId, workspaceDigest, practiceOnly = false }) {
  const receipt = { kind: practiceOnly ? 'workspace-development' : 'workspace-acceptance', image: profile.image, verifierDigest: profile.verifierDigest,
    fixtures: profile.fixtures, ...(workspaceArtifactId && { workspaceArtifactId }), workspaceDigest,
    ...(practiceOnly && { workspaceFiles: files.map(({ path, mode, data }) => ({ path, mode, sha256: digest(Buffer.from(data, 'base64')) })) }),
    startedAt: new Date().toISOString(), network: 'isolated loopback for the application', mount: 'read-only',
    checks: checkDefinitions.map(([id, label]) => ({
      ...(practiceOnly && id === 'audio-acceptance' ? { id: 'development-audio', label: 'Music Transcribe development recording' } : { id, label }),
      passed: false, state: 'not-run',
    })) };
  const [unit, health, audio] = receipt.checks;
  const record = (check, result) => Object.assign(check, result, { state: result.passed ? 'passed' : 'failed' });
  const reason = error => String(error?.message || error).slice(0, 1000);
  let directory, fixturesDir, live;
  try {
    signal?.throwIfAborted();
    const { fixtures, image } = await checkMusicAudioSetup(repo, profile, signal, practiceOnly);
    directory = await materializeWorkspaceFiles(files, signal);
    try { record(unit, await runNodeTests({ directory, image, signal, onEvent: () => {} })); }
    catch (error) { record(unit, { passed: false, reason: reason(error) }); }
    signal?.throwIfAborted();
    try {
      live = await startFeaturePreview({ projectId, revision: workspaceDigest, snapshotDirectory: directory,
        image, signal, durable: false });
      record(health, { passed: true, reason: 'GET /health returned a successful response.' });
    } catch (error) { record(health, { passed: false, reason: reason(error) }); }
    signal?.throwIfAborted();
    if (live) {
      fixturesDir = await mkdtemp(join(tmpdir(), 'crew-music-fixtures-'));
      for (const fixture of fixtures) {
        await writeFile(join(fixturesDir, fixture.name + '.wav'), fixture.audio, { mode: 0o600 });
        await writeFile(join(fixturesDir, fixture.name + '.expected.json'), fixture.key, { mode: 0o600 });
      }
      try {
        const result = await verifyLessons(fixturesDir, { url: live.url, signal }, { practiceOnly });
        record(audio, practiceOnly ? practiceResult(result) : result);
      }
      catch (error) { record(audio, { passed: false, reason: reason(error) }); }
    }
  } catch (error) {
    receipt.error = reason(error);
  } finally {
    try { await live?.stop(); }
    catch { receipt.error ??= 'Could not stop the local verification app.'; }
    const removed = await Promise.allSettled([directory, fixturesDir].filter(Boolean).map(path => rm(path, { recursive: true, force: true })));
    if (removed.some(result => result.status === 'rejected')) receipt.error ??= 'Could not clean up the local verification environment.';
  }
  receipt.passed = !receipt.error && receipt.checks.every(check => check.passed);
  receipt.endedAt = new Date().toISOString();
  return receipt;
}
