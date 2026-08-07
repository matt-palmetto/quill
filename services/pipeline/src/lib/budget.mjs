/** Wall-clock run budget shared by scan and extract+index phases. */
export function createBudget(totalSeconds) {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) {
    throw new RangeError('totalSeconds must be a positive number');
  }
  const startedAt = Date.now();
  const deadline = startedAt + totalSeconds * 1000;
  return Object.freeze({
    startedAt,
    deadline,
    elapsedSeconds() {
      return (Date.now() - startedAt) / 1000;
    },
    remainingSeconds() {
      return Math.max(0, (deadline - Date.now()) / 1000);
    },
    exhausted() {
      return Date.now() >= deadline;
    },
  });
}
