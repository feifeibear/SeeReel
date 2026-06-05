import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import {
  agentPlanCredentialStorageStatus,
  deleteAgentPlanCredential,
  getCachedAgentPlanCredential,
  hydrateAgentPlanCredential,
  keyFingerprint,
  storeAgentPlanCredential
} from "./agentPlanKeyStore";

const COOKIE_NAME = "seereel_user_id";
const LEGACY_COOKIE_NAME = "reelyai_user_id";
const MAX_AGE_MS = 1000 * 60 * 60 * 24 * 30;

interface RequestCredentialContext {
  userId: string;
  ipHash: string;
  userAgentHash: string;
}

const requestContext = new AsyncLocalStorage<RequestCredentialContext>();

export function userCredentialMiddleware(req: Request, res: Response, next: NextFunction) {
  const existingUserId = readUserId(req);
  const userId = existingUserId || randomUUID();
  if (!existingUserId) {
    res.cookie(COOKIE_NAME, userId, {
      httpOnly: true,
      sameSite: "lax",
      secure: shouldUseSecureCookie(),
      maxAge: MAX_AGE_MS,
      path: "/"
    });
  }
  const context = { userId, ipHash: requestIpHash(req), userAgentHash: requestUserAgentHash(req) };
  void hydrateAgentPlanCredential(userId)
    .catch((error) => {
      console.warn("[user-credentials] hydrate failed:", error instanceof Error ? error.message : error);
    })
    .finally(() => {
      requestContext.run(context, next);
    });
}

export async function setRequestAgentPlanKey(apiKey: string) {
  const userId = currentUserId();
  if (!userId) throw new Error("Missing browser session");
  await storeAgentPlanCredential(userId, apiKey, {
    ipHash: currentIpHash(),
    userAgentHash: currentUserAgentHash()
  });
}

export async function clearRequestAgentPlanKey() {
  const userId = currentUserId();
  if (!userId) return;
  await deleteAgentPlanCredential(userId);
}

export function getRequestAgentPlanKey() {
  const userId = currentUserId();
  if (!userId) return undefined;
  return getCachedAgentPlanCredential(userId)?.apiKey;
}

export function requestAgentPlanStatus() {
  const userId = currentUserId();
  const credential = getCachedAgentPlanCredential(userId);
  const apiKey = credential?.apiKey;
  return {
    configured: Boolean(apiKey),
    fingerprint: apiKey ? credential?.fingerprint || keyFingerprint(apiKey) : undefined,
    updatedAt: credential?.updatedAt,
    storage: agentPlanCredentialStorageStatus()
  };
}

export function currentUserId() {
  return requestContext.getStore()?.userId;
}

export function currentIpHash() {
  return requestContext.getStore()?.ipHash;
}

export function currentUserAgentHash() {
  return requestContext.getStore()?.userAgentHash;
}

export function hasRequestAgentPlanKey() {
  return Boolean(getRequestAgentPlanKey());
}

function readUserId(req: Request) {
  const cookies = parseCookies(req.headers.cookie || "");
  const value = cookies[COOKIE_NAME] || cookies[LEGACY_COOKIE_NAME];
  return typeof value === "string" && /^[A-Za-z0-9_-]{16,}$/.test(value) ? value : undefined;
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

function requestIpHash(req: Request) {
  const forwarded = (req.headers["x-forwarded-for"] || "").toString().split(",")[0]?.trim();
  const rawIp = forwarded || req.ip || req.socket.remoteAddress || "unknown";
  const salt = process.env.SEEREEL_RATE_LIMIT_SALT || process.env.REELYAI_RATE_LIMIT_SALT || "seereel-demo";
  return createHash("sha256").update(`${salt}|${rawIp}`).digest("hex").slice(0, 20);
}

function requestUserAgentHash(req: Request) {
  const rawUserAgent = (req.headers["user-agent"] || "unknown").toString();
  const salt = process.env.SEEREEL_RATE_LIMIT_SALT || process.env.REELYAI_RATE_LIMIT_SALT || "seereel-demo";
  return createHash("sha256").update(`${salt}|${rawUserAgent}`).digest("hex").slice(0, 20);
}

function shouldUseSecureCookie() {
  const setting = process.env.SEEREEL_COOKIE_SECURE || process.env.REELYAI_COOKIE_SECURE;
  if (setting === "0") return false;
  if (setting === "1") return true;
  return process.env.NODE_ENV === "production";
}
