import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { incCounter } from "./metrics";

/**
 * Minimal shared-secret access gate for sensitive routes.
 *
 * Rationale: the backend has no real authentication — any client that can reach the server can call
 * every paid generation API and read the full app state. This guard is the smallest viable mitigation
 * for money/compliance risk on a public deployment: a single shared `REELYAI_ACCESS_TOKEN`.
 *
 * Behaviour:
 *  - Token env unset  -> gate disabled (local dev keeps zero friction; fully back-compatible).
 *  - Token env set    -> sensitive routes require a matching `x-reelyai-access` header (or cookie),
 *                        otherwise respond 401. Probes (`/api/healthz`, `/api/readyz`) stay open so
 *                        load balancers and uptime checks are unaffected.
 *
 * "Sensitive" = any mutating method (POST/PATCH/PUT/DELETE) plus a small set of read endpoints that
 * leak data or internals (`/api/state`, `/api/diagnostics`).
 */

const ACCESS_HEADER = "x-reelyai-access";
const ACCESS_COOKIE = "reelyai_access";

const SENSITIVE_READ_PATHS = new Set(["/api/state", "/api/diagnostics"]);
const ALWAYS_OPEN_PATHS = new Set(["/api/healthz", "/api/readyz"]);

function configuredToken() {
  const raw = process.env.REELYAI_ACCESS_TOKEN;
  const token = typeof raw === "string" ? raw.trim() : "";
  return token.length > 0 ? token : undefined;
}

function isMutating(method: string) {
  return method === "POST" || method === "PATCH" || method === "PUT" || method === "DELETE";
}

function isSensitive(req: Request) {
  if (ALWAYS_OPEN_PATHS.has(req.path)) return false;
  if (isMutating(req.method)) return true;
  return SENSITIVE_READ_PATHS.has(req.path);
}

function presentedToken(req: Request) {
  const header = req.header(ACCESS_HEADER);
  if (typeof header === "string" && header.trim()) return header.trim();
  const cookie = parseCookies(req.headers.cookie || "")[ACCESS_COOKIE];
  if (typeof cookie === "string" && cookie.trim()) return cookie.trim();
  return undefined;
}

function tokensMatch(expected: string, presented: string) {
  const a = Buffer.from(expected);
  const b = Buffer.from(presented);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function accessGuardMiddleware(req: Request, res: Response, next: NextFunction) {
  const expected = configuredToken();
  if (!expected) return next();
  if (!isSensitive(req)) return next();

  const presented = presentedToken(req);
  if (presented && tokensMatch(expected, presented)) return next();

  incCounter("reelyai_access_denied_total", "Total requests rejected by the access token guard.", {
    method: req.method,
    route: normalizeGuardRoute(req)
  });
  res.status(401).json({ error: "需要访问令牌（access token）才能调用该接口", code: "access_token_required" });
}

/** True when the gate is active so callers can surface it (e.g. smoke tests, readiness). */
export function accessGuardEnabled() {
  return Boolean(configuredToken());
}

function normalizeGuardRoute(req: Request) {
  const routePath = typeof req.route?.path === "string" ? req.route.path : req.path;
  return routePath
    .replace(/\/api\/sessions\/[^/]+/g, "/api/sessions/:sessionId")
    .replace(/\/api\/shots\/[^/]+/g, "/api/shots/:shotId")
    .replace(/\/api\/assets\/[^/]+/g, "/api/assets/:assetId");
}

function parseCookies(header: string) {
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        if (index < 0) return [part, ""];
        return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
      })
  ) as Record<string, string>;
}
