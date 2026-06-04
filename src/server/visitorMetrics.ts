import { createHash, randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { incCounter, setGauge } from "./metrics";

const VISITOR_COOKIE = "reelyai_vid";
const VISITOR_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;
const visitorsByDay = new Map<string, Set<string>>();
const lastSeenByVisitor = new Map<string, number>();

function utcDay(ts = Date.now()) {
  return new Date(ts).toISOString().slice(0, 10);
}

function parseCookies(header: string | undefined) {
  const result = new Map<string, string>();
  if (!header) return result;
  for (const part of header.split(";")) {
    const [rawKey, ...rawValue] = part.trim().split("=");
    if (!rawKey || rawValue.length === 0) continue;
    try {
      result.set(rawKey, decodeURIComponent(rawValue.join("=")));
    } catch {
      result.set(rawKey, rawValue.join("="));
    }
  }
  return result;
}

function isValidVisitorId(value: string | undefined) {
  return Boolean(value && /^[a-zA-Z0-9_-]{16,80}$/.test(value));
}

function fallbackVisitorId(req: Request) {
  const forwardedFor = (req.headers["x-forwarded-for"] || req.ip || "").toString().split(",")[0]?.trim();
  const ua = req.get("user-agent") || "";
  return `fp_${createHash("sha256").update(`${forwardedFor}|${ua}`).digest("hex").slice(0, 32)}`;
}

function shouldTrackPageView(req: Request) {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  const path = req.path || "/";
  if (path.startsWith("/api/") || path.startsWith("/metrics") || path.startsWith("/media/")) return false;
  if (/\.[a-zA-Z0-9]{2,8}$/.test(path)) return false;
  const accept = req.get("accept") || "";
  return path === "/" || accept.includes("text/html");
}

function setVisitorCookie(res: Response, visitorId: string, secure: boolean) {
  const parts = [
    `${VISITOR_COOKIE}=${encodeURIComponent(visitorId)}`,
    "Path=/",
    `Max-Age=${VISITOR_COOKIE_MAX_AGE_SECONDS}`,
    "SameSite=Lax",
    "HttpOnly"
  ];
  if (secure) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

export function visitorMetricsMiddleware(req: Request, res: Response, next: () => void) {
  if (!shouldTrackPageView(req)) return next();

  const cookies = parseCookies(req.headers.cookie);
  let visitorId = cookies.get(VISITOR_COOKIE);
  if (!isValidVisitorId(visitorId)) {
    visitorId = `v_${randomUUID().replace(/-/g, "")}`;
    setVisitorCookie(res, visitorId, req.secure || req.get("x-forwarded-proto") === "https");
  }
  if (!visitorId) visitorId = fallbackVisitorId(req);

  const now = Date.now();
  const day = utcDay(now);
  const daySet = visitorsByDay.get(day) || new Set<string>();
  daySet.add(visitorId);
  visitorsByDay.set(day, daySet);
  lastSeenByVisitor.set(visitorId, now);

  incCounter("reelyai_page_views_total", "Total SeeReel app page views.", { route: "app" });
  collectVisitorMetrics();
  next();
}

export function collectVisitorMetrics(now = Date.now()) {
  const today = utcDay(now);
  const cutoff24h = now - 24 * 60 * 60 * 1000;
  for (const [visitorId, lastSeen] of lastSeenByVisitor) {
    if (lastSeen < cutoff24h) lastSeenByVisitor.delete(visitorId);
  }
  for (const day of Array.from(visitorsByDay.keys())) {
    if (day < utcDay(cutoff24h)) visitorsByDay.delete(day);
  }
  setGauge("reelyai_visitors_unique_today", "Unique anonymous app visitors for the current UTC day.", { day: today }, visitorsByDay.get(today)?.size || 0);
  setGauge("reelyai_visitors_unique_24h", "Unique anonymous app visitors seen in the last 24 hours.", undefined, lastSeenByVisitor.size);
}
