const tokenCount = value => Number.isSafeInteger(value) && value >= 0;

export function estimateAttemptUsd(usage, runtime) {
  const rates = runtime?.tokenRates;
  if (!rates || !tokenCount(usage?.input) || !tokenCount(usage?.output)) return null;
  const { input, output, cached } = usage;
  const cachedRate = rates.cachedInputUsdPerMillion ?? rates.inputUsdPerMillion;
  if (cachedRate !== rates.inputUsdPerMillion && (!tokenCount(cached) || cached > input)) return null;
  const cachedTokens = cachedRate === rates.inputUsdPerMillion ? 0 : cached;
  return ((input - cachedTokens) * rates.inputUsdPerMillion + cachedTokens * cachedRate + output * rates.outputUsdPerMillion) / 1_000_000;
}

export function taskUsage({ packet, attempts }) {
  const finished = attempts.filter(attempt => attempt.outcome !== 'running');
  const reported = finished.filter(attempt => tokenCount(attempt.usage?.total));
  const priced = finished.map(attempt => estimateAttemptUsd(attempt.usage, attempt.runtime)).filter(value => value !== null);
  const totalTokens = reported.length ? reported.reduce((sum, attempt) => sum + attempt.usage.total, 0) : null;
  const estimatedUsd = priced.length ? priced.reduce((sum, cost) => sum + cost, 0) : null;
  const { costOwner, costTargetUsd } = packet.budget;
  const unpricedAttempts = finished.length - priced.length;
  return {
    costOwner: costOwner ?? null, costTargetUsd: costTargetUsd ?? null, totalTokens, estimatedUsd, unpricedAttempts,
    attemptsMissingUsage: finished.length - reported.length,
    overCostTarget: estimatedUsd === null || costTargetUsd === undefined ? null
      : estimatedUsd > costTargetUsd ? true : unpricedAttempts ? null : false,
  };
}
