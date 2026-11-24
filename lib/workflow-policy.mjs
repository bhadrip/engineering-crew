import { requireField } from './contracts.mjs';

export const workflowResponseModes = Object.freeze({ structured: 'Structured response', 'free-form': 'Free-form reply and output tools' });
export const maxOutputFollowUps = 3;

export function validateWorkflowPolicies(project, hasCodexAgent = () => false) {
  requireField(project.dispatchMode === undefined || ['manual', 'automatic'].includes(project.dispatchMode), 'Choose a workflow dispatch mode');
  for (const task of project.tasks) {
    requireField(task.reviewMode === undefined || ['human', 'automatic'].includes(task.reviewMode), 'Choose a handoff review mode');
    requireField(task.responseMode === undefined || Object.hasOwn(workflowResponseModes, task.responseMode), 'Choose a Codex response mode');
    if (task.responseMode === 'free-form') {
      requireField(project.id === 'music-transcribe' &&
        [task.profileId, ...(task.alternateProfiles ?? [])].every(hasCodexAgent),
      'Free-form replies require a saved Music Transcribe Codex agent for every assignment on this step.');
    }
    if (task.outputFollowUps !== undefined) {
      requireField(task.responseMode === 'free-form' && !task.execution && task.outputs.some(slot => slot.required) &&
        Number.isInteger(task.outputFollowUps) && task.outputFollowUps >= 1 && task.outputFollowUps <= maxOutputFollowUps,
      'Output follow-ups require a free-form Codex step with a required output. Choose 1 to ' + maxOutputFollowUps + ' follow-up turns.');
    }
  }
}
