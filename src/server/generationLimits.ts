import { incCounter } from "./metrics";
import { isUsingAdminTrialAgentPlan } from "./arkCredentials";
import { hasAdminAgentPlanKey } from "./adminSettings";
import { currentIpHash, currentUserId } from "./userCredentials";

/**
 * Per-session daily hard cap on paid generation submissions.
 *
 * Rationale: a single user action can fan out into many paid model calls (poll auto-resubmit + vision
 * review retries + parallel shots). There is no server-side quota, so a deployment key can be drained.
 * This in-process counter (single-replica architecture is the deployment model) caps how many paid
 * submissions a session may trigger per UTC day and returns 429 once exceeded.
 *
 * Disabled when `SEEREEL_SESSION_GENERATION_DAILY_CAP <= 0`.
 */

const DEFAULT_DAILY_CAP = 1000;
const DEFAULT_FREE_TRIAL_LIMIT = 10;
const DEFAULT_FREE_TRIAL_IP_DAILY_CAP = 30;
const DEFAULT_FREE_TRIAL_GLOBAL_DAILY_CAP = 300;

let currentDay = utcDay();
const counters = new Map<string, number>();
const freeTrialByUser = new Map<string, number>();
const freeTrialByIp = new Map<string, number>();
let freeTrialGlobal = 0;

function utcDay() {
  return new Date().toISOString().slice(0, 10);
}

function dailyCap() {
  const raw = process.env.SEEREEL_SESSION_GENERATION_DAILY_CAP || process.env.REELYAI_SESSION_GENERATION_DAILY_CAP;
  if (raw === undefined || raw.trim() === "") return DEFAULT_DAILY_CAP;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_DAILY_CAP;
  return parsed;
}

function envInt(name: string, fallback: number) {
  const legacyName = name.startsWith("SEEREEL_") ? name.replace(/^SEEREEL_/, "REELYAI_") : "";
  const raw = process.env[name] || (legacyName ? process.env[legacyName] : undefined);
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function freeTrialLimit() {
  return envInt("SEEREEL_FREE_TRIAL_LIMIT", DEFAULT_FREE_TRIAL_LIMIT);
}

function freeTrialIpDailyCap() {
  return envInt("SEEREEL_FREE_TRIAL_IP_DAILY_CAP", DEFAULT_FREE_TRIAL_IP_DAILY_CAP);
}

function freeTrialGlobalDailyCap() {
  return envInt("SEEREEL_FREE_TRIAL_GLOBAL_DAILY_CAP", DEFAULT_FREE_TRIAL_GLOBAL_DAILY_CAP);
}

function rolloverIfNeeded() {
  const today = utcDay();
  if (today !== currentDay) {
    currentDay = today;
    counters.clear();
    freeTrialByUser.clear();
    freeTrialByIp.clear();
    freeTrialGlobal = 0;
  }
}

export interface GenerationLimitResult {
  ok: boolean;
  count: number;
  cap: number;
  reason?: "session_daily_cap" | "free_trial_user" | "free_trial_ip" | "free_trial_global";
  freeTrial?: boolean;
}

function tryConsumeAdminFreeTrial(operation: string): GenerationLimitResult {
  if (!isUsingAdminTrialAgentPlan()) return { ok: true, count: 0, cap: 0 };
  rolloverIfNeeded();
  const userLimit = freeTrialLimit();
  const ipCap = freeTrialIpDailyCap();
  const globalCap = freeTrialGlobalDailyCap();
  if (userLimit <= 0) {
    incCounter("reelyai_generation_blocked_total", "Total paid generation submissions blocked by the daily cap.", { operation, reason: "free_trial_disabled" });
    return { ok: false, count: 0, cap: 0, reason: "free_trial_user", freeTrial: true };
  }

  const userId = currentUserId() || "anonymous";
  const ipHash = currentIpHash() || "unknown";
  const userKey = `${currentDay}|${userId}`;
  const ipKey = `${currentDay}|${ipHash}`;
  const userUsed = freeTrialByUser.get(userKey) || 0;
  const ipUsed = freeTrialByIp.get(ipKey) || 0;

  if (userUsed >= userLimit) {
    incCounter("reelyai_generation_blocked_total", "Total paid generation submissions blocked by the daily cap.", { operation, reason: "free_trial_user" });
    return { ok: false, count: userUsed, cap: userLimit, reason: "free_trial_user", freeTrial: true };
  }
  if (ipCap > 0 && ipUsed >= ipCap) {
    incCounter("reelyai_generation_blocked_total", "Total paid generation submissions blocked by the daily cap.", { operation, reason: "free_trial_ip" });
    return { ok: false, count: ipUsed, cap: ipCap, reason: "free_trial_ip", freeTrial: true };
  }
  if (globalCap > 0 && freeTrialGlobal >= globalCap) {
    incCounter("reelyai_generation_blocked_total", "Total paid generation submissions blocked by the daily cap.", { operation, reason: "free_trial_global" });
    return { ok: false, count: freeTrialGlobal, cap: globalCap, reason: "free_trial_global", freeTrial: true };
  }

  freeTrialByUser.set(userKey, userUsed + 1);
  freeTrialByIp.set(ipKey, ipUsed + 1);
  freeTrialGlobal += 1;
  incCounter("reelyai_free_trial_submissions_total", "Total submissions accepted through the admin free-trial Agent Plan key.", { operation });
  return { ok: true, count: userUsed + 1, cap: userLimit, freeTrial: true };
}

/**
 * Try to consume one generation slot for a session. When allowed, increments the per-session counter
 * and the submissions metric. When blocked, increments the blocked metric and leaves the counter as-is.
 */
export function tryConsumeGeneration(sessionId: string | undefined, operation: string): GenerationLimitResult {
  const freeTrial = tryConsumeAdminFreeTrial(operation);
  if (!freeTrial.ok) return freeTrial;

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
    return { ok: false, count: used, cap, reason: "session_daily_cap" };
  }
  const next = used + 1;
  counters.set(key, next);
  incCounter("reelyai_generation_submissions_total", "Total paid generation submissions accepted by the server.", { operation });
  return { ok: true, count: next, cap, freeTrial: freeTrial.freeTrial };
}

/** Human-readable 429 message for a blocked submission. */
export function generationCapMessage(result: GenerationLimitResult) {
  if (result.freeTrial) {
    if (result.reason === "free_trial_ip") {
      return `这个网络今天的免费试用次数已达上限（${result.cap} 次/日）。请配置你自己的火山 Agent Plan Key 后继续生成。`;
    }
    if (result.reason === "free_trial_global") {
      return `今天的全站免费试用额度已用完。请配置你自己的火山 Agent Plan Key 后继续生成。`;
    }
    return `免费试用已用完（${result.cap} 次）。请配置你自己的火山 Agent Plan Key 后继续生成，避免继续消耗站点演示额度。`;
  }
  return `本会话今日生成次数已达上限（${result.cap} 次/日），请明日再试或调高 SEEREEL_SESSION_GENERATION_DAILY_CAP。`;
}

/** Snapshot used by diagnostics/metrics. Returns total submissions counted today across sessions. */
export function generationLimitSnapshot() {
  rolloverIfNeeded();
  let totalToday = 0;
  for (const value of counters.values()) totalToday += value;
  return {
    cap: dailyCap(),
    day: currentDay,
    sessionsTracked: counters.size,
    totalToday,
    freeTrial: freeTrialStatus()
  };
}

export function freeTrialStatus() {
  rolloverIfNeeded();
  const userId = currentUserId() || "anonymous";
  const userKey = `${currentDay}|${userId}`;
  const limit = freeTrialLimit();
  const used = freeTrialByUser.get(userKey) || 0;
  return {
    enabled: hasAdminAgentPlanKey(),
    active: isUsingAdminTrialAgentPlan(),
    used,
    limit,
    remaining: limit > 0 ? Math.max(0, limit - used) : 0,
    day: currentDay,
    ipDailyCap: freeTrialIpDailyCap(),
    globalDailyCap: freeTrialGlobalDailyCap(),
    globalUsed: freeTrialGlobal
  };
}
