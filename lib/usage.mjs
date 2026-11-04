const tokenCount = value => Number.isSafeInteger(value) && value >= 0;

export function elapsedMs(start, end) {
  const ms = Date.parse(end) - Date.parse(start);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

export function estimateAttemptUsd(usage, runtime) {
  const rates = runtime?.tokenRates;
  if (!rates || !tokenCount(usage?.input) || !tokenCount(usage?.output)) return null;
  const { input, output, cached } = usage;
  const cachedRate = rates.cachedInputUsdPerMillion ?? rates.inputUsdPerMillion;
  if (cachedRate !== rates.inputUsdPerMillion && (!tokenCount(cached) || cached > input)) return null;
  const cachedTokens = cachedRate === rates.inputUsdPerMillion ? 0 : cached;
  return ((input - cachedTokens) * rates.inputUsdPerMillion + cachedTokens * cachedRate + output * rates.outputUsdPerMillion) / 1_000_000;
}

function attemptUsage(attempts) {
  const finished = attempts.filter(attempt => attempt.outcome !== 'running');
  const reported = finished.filter(attempt => tokenCount(attempt.usage?.total));
  const priced = finished.filter(attempt => attempt.estimatedUsd !== null);
  const timed = finished.filter(attempt => attempt.durationMs !== null);
  return {
    attempts: attempts.length, runningAttempts: attempts.length - finished.length,
    totalTokens: reported.length ? reported.reduce((sum, attempt) => sum + attempt.usage.total, 0) : null,
    estimatedUsd: priced.length ? priced.reduce((sum, attempt) => sum + attempt.estimatedUsd, 0) : null,
    durationMs: timed.length ? timed.reduce((sum, attempt) => sum + attempt.durationMs, 0) : null,
    unpricedAttempts: finished.length - priced.length,
    attemptsMissingUsage: finished.length - reported.length,
    attemptsMissingDuration: finished.length - timed.length,
  };
}

export function taskUsage({ packet, attempts }) {
  const usage = attemptUsage(attempts);
  const { costOwner, costTargetUsd } = packet.budget;
  const { estimatedUsd, unpricedAttempts } = usage;
  return {
    ...usage, costOwner: costOwner ?? null, costTargetUsd: costTargetUsd ?? null,
    overCostTarget: estimatedUsd === null || costTargetUsd === undefined ? null
      : estimatedUsd > costTargetUsd ? true : unpricedAttempts ? null : false,
  };
}

export function runUsage(tasks, profiles) {
  const attempts = tasks.flatMap(task => task.attempts);
  let first = Infinity;
  let last = -Infinity;
  for (const attempt of attempts) {
    if (attempt.durationMs === null) continue;
    first = Math.min(first, Date.parse(attempt.startedAt));
    last = Math.max(last, Date.parse(attempt.endedAt));
  }
  return {
    ...attemptUsage(attempts),
    attemptWindowMs: last >= first ? last - first : null,
    byProfile: profiles.filter(profile => tasks.some(task => task.packet.profileId === profile.id)).map(profile => ({
      profileId: profile.id, name: profile.name,
      ...attemptUsage(tasks.filter(task => task.packet.profileId === profile.id).flatMap(task => task.attempts)),
    })),
  };
}
