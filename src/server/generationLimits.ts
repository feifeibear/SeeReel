import { incCounter } from "./metrics";

/**
 * Per-session daily hard cap on paid generation submissions.
 *
 * Rationale: a single user action can fan out into many paid model calls (poll auto-resubmit + vision
 * review retries + parallel shots). There is no server-side quota, so a deployment key can be drained.
 * This in-process counter (single-replica architecture is the deployment model) caps how many paid
 * submissions a session may trigger per UTC day and returns 429 once exceeded.
 *
 * Disabled when `REELYAI_SESSION_GENERATION_DAILY_CAP <= 0`.
 */

const DEFAULT_DAILY_CAP = 1000;

let currentDay = utcDay();
const counters = new Map<string, number>();

function utcDay() {
  return new Date().toISOString().slice(0, 10);
}

function dailyCap() {
  const raw = process.env.REELYAI_SESSION_GENERATION_DAILY_CAP;
  if (raw === undefined || raw.trim() === "") return DEFAULT_DAILY_CAP;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_DAILY_CAP;
  return parsed;
}

function rolloverIfNeeded() {
  const today = utcDay();
  if (today !== currentDay) {
    currentDay = today;
    counters.clear();
  }
}

export interface GenerationLimitResult {
  ok: boolean;
  count: number;
  cap: number;
}

/**
 * Try to consume one generation slot for a session. When allowed, increments the per-session counter
 * and the submissions metric. When blocked, increments the blocked metric and leaves the counter as-is.
 */
export function tryConsumeGeneration(sessionId: string | undefined, operation: string): GenerationLimitResult {
  const cap = dailyCap();
  if (cap <= 0 || !sessionId) {
    incCounter("reelyai_generation_submissions_total", "Total paid generation submissions accepted by the server.", { operation });
    return { ok: true, count: 0, cap };
  }
  rolloverIfNeeded();
  const key = `${currentDay}|${sessionId}`;
  const used = counters.get(key) || 0;
  if (used >= cap) {
    incCounter("reelyai_generation_blocked_total", "Total paid generation submissions blocked by the daily cap.", { operation, reason: "daily_cap" });
    return { ok: false, count: used, cap };
  }
  const next = used + 1;
  counters.set(key, next);
  incCounter("reelyai_generation_submissions_total", "Total paid generation submissions accepted by the server.", { operation });
  return { ok: true, count: next, cap };
}

/** Human-readable 429 message for a blocked submission. */
export function generationCapMessage(result: GenerationLimitResult) {
  return `本会话今日生成次数已达上限（${result.cap} 次/日），请明日再试或调高 REELYAI_SESSION_GENERATION_DAILY_CAP。`;
}

/** Snapshot used by diagnostics/metrics. Returns total submissions counted today across sessions. */
export function generationLimitSnapshot() {
  rolloverIfNeeded();
  let totalToday = 0;
  for (const value of counters.values()) totalToday += value;
  return { cap: dailyCap(), day: currentDay, sessionsTracked: counters.size, totalToday };
}
