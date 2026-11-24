import { requireField } from './contracts.mjs';
import { artifact, artifactDigest } from './run-store.mjs';
import { readWorkspaceArtifact, workspaceFiles } from './workflow-workspace.mjs';

export function readCodexCheckpoint(run, taskId, attempt) {
  if (!attempt.codexCheckpoint) return;
  const { artifactId, digest } = attempt.codexCheckpoint;
  const record = run.artifacts.find(record => record.id === artifactId);
  requireField(record?.provenance?.source === 'codex-checkpoint' && record.provenance.attemptId === attempt.id &&
    typeof record.content === 'string' && record.digest === digest && artifactDigest(record.content) === digest,
  'The saved Codex progress cannot be verified.');
  const checkpoint = JSON.parse(record.content);
  requireField(checkpoint.runId === run.id && checkpoint.taskId === taskId && checkpoint.attemptId === attempt.id &&
    checkpoint.sourceCommit === attempt.sourceCommit, 'The saved Codex progress belongs to another attempt.');
  return checkpoint;
}

export function recordCodexCheckpoint(run, taskId, attempt, event) {
  const prior = readCodexCheckpoint(run, taskId, attempt);
  const checkpoint = prior ?? { schemaVersion: 1, runId: run.id, taskId, attemptId: attempt.id,
    sourceCommit: attempt.sourceCommit, outputs: [] };
  if (event.kind === 'launch') {
    requireField(!prior, 'This attempt already has a Codex launch record.');
    checkpoint.launch = event.launch;
    checkpoint.prompt = event.prompt;
    checkpoint.responseFormat = event.responseFormat;
    checkpoint.startedAt = event.startedAt;
  } else {
    requireField(prior, 'The Codex launch record is unavailable.');
    if (event.kind === 'final') {
      checkpoint.finalReply = { text: event.text, digest: artifactDigest(event.text), at: event.at };
    } else if (event.kind === 'follow-up') {
      const { kind: _kind, ...followUp } = event;
      (checkpoint.outputFollowUps ??= []).push(followUp);
    } else if (event.kind === 'submission') {
      if (event.output) {
        const index = checkpoint.outputs.findIndex(output => output.slot === event.output.slot);
        const output = { ...event.output, digest: event.output.evidence?.digest ?? event.output.image?.digest ??
          artifactDigest(event.output.content), at: event.at };
        if (index < 0) checkpoint.outputs.push(output);
        else checkpoint.outputs[index] = output;
      } else checkpoint.blocker = { ...event.blocker, at: event.at };
    }
  }
  const record = artifact('codex-checkpoint-' + attempt.id, 'Saved Codex progress', 'json', JSON.stringify(checkpoint),
    { source: 'codex-checkpoint', attemptId: attempt.id });
  const existing = run.artifacts.findIndex(value => value.id === record.id);
  if (existing < 0) run.artifacts.push(record);
  else run.artifacts[existing] = record;
  attempt.codexCheckpoint = { artifactId: record.id, digest: record.digest,
    outputCount: checkpoint.outputs.length, hasFinalReply: Boolean(checkpoint.finalReply) };
}

export function discardCodexCheckpoint(run, attempt) {
  if (!attempt.codexCheckpoint) return;
  run.artifacts = run.artifacts.filter(record => record.id !== attempt.codexCheckpoint.artifactId);
  delete attempt.codexCheckpoint;
}

export function recordWorkspaceCheckpoint(run, taskId, attempt, { files, note }) {
  const saved = workspaceFiles(files);
  const capturedAt = new Date().toISOString();
  const record = artifact('workspace-checkpoint-' + attempt.id, 'Workspace checkpoint', 'workspace',
    JSON.stringify({ schemaVersion: 1, files: saved.files }),
    { source: 'workspace-checkpoint', taskId, attemptId: attempt.id, note, capturedAt });
  const existing = run.artifacts.findIndex(value => value.id === record.id);
  if (existing < 0) run.artifacts.push(record);
  else run.artifacts[existing] = record;
  attempt.workspaceCheckpoint = { artifactId: record.id, digest: record.digest, fileCount: saved.files.length,
    bytes: saved.bytes, note, capturedAt };
  return attempt.workspaceCheckpoint;
}

export function workspaceCheckpointReference(attempt) {
  if (!attempt?.workspaceCheckpoint) return attempt?.workspaceCheckpointFrom;
  const { artifactId, digest } = attempt.workspaceCheckpoint;
  return { attemptId: attempt.id, artifactId, digest };
}

export function readWorkspaceCheckpoint(run, task, reference) {
  if (!reference) return;
  const { attemptId, artifactId, digest } = reference;
  const saved = task.attempts.find(attempt => attempt.id === attemptId)?.workspaceCheckpoint;
  const record = run.artifacts.find(artifact => artifact.id === artifactId);
  requireField(saved?.artifactId === artifactId && saved?.digest === digest && record?.kind === 'workspace' &&
    record.provenance?.source === 'workspace-checkpoint' && record.provenance.taskId === task.packet.id &&
    record.provenance.attemptId === attemptId && typeof record.content === 'string' &&
    record.digest === digest && artifactDigest(record.content) === digest,
  'The saved workspace checkpoint cannot be verified.');
  const { files, bytes } = readWorkspaceArtifact(record.content);
  requireField(files.length === saved.fileCount && bytes === saved.bytes, 'The saved workspace checkpoint does not match its file summary.');
  return { files, checkpoint: saved };
}
