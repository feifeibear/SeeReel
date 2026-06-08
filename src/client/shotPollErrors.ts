const TRANSIENT_POLL_FAILURE_THRESHOLD = 3;

export interface ShotPollFailure {
  shotId: string;
  message: string;
  count: number;
  transient: boolean;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error || "");
}

function isTransientShotPollError(message: string) {
  const normalized = message.trim();
  return (
    /^(500|502|503|504)(\b|$)/.test(normalized)
    || /\b(Bad Gateway|Gateway Timeout|Service Unavailable)\b/i.test(normalized)
    || /\b(Failed to fetch|Network connection lost|network interrupted)\b/i.test(normalized)
    || /上游 API 调用失败/.test(normalized)
  );
}

export function recordShotPollFailure(failures: Map<string, number>, shotId: string, error: unknown): ShotPollFailure {
  const message = errorMessage(error);
  const transient = isTransientShotPollError(message);
  const count = transient ? (failures.get(shotId) || 0) + 1 : 1;
  if (transient) failures.set(shotId, count);
  else failures.delete(shotId);
  return { shotId, message, count, transient };
}

export function clearShotPollFailure(failures: Map<string, number>, shotId: string) {
  failures.delete(shotId);
}

export function shouldSurfaceShotPollError(failure: ShotPollFailure) {
  if (!failure.transient) return true;
  return failure.count >= TRANSIENT_POLL_FAILURE_THRESHOLD;
}
