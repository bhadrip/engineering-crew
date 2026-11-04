export function currentAttempts(task) {
  return task.attempts.slice(task.activeFrom ?? 0);
}

export function currentAttempt(task) {
  return task && task.attempts.length > (task.activeFrom ?? 0) ? task.attempts.at(-1) : undefined;
}
