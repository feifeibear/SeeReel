import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

const COOKIE_NAME = "reelyai_user_id";
const MAX_AGE_MS = 1000 * 60 * 60 * 24 * 30;

interface RequestCredentialContext {
  userId: string;
}

interface StoredCredential {
  apiKey: string;
  updatedAt: string;
}

const requestContext = new AsyncLocalStorage<RequestCredentialContext>();
const agentPlanCredentials = new Map<string, StoredCredential>();

export function userCredentialMiddleware(req: Request, res: Response, next: NextFunction) {
  const userId = readUserId(req) || randomUUID();
  if (!readUserId(req)) {
    res.cookie(COOKIE_NAME, userId, {
      httpOnly: true,
      sameSite: "lax",
      secure: shouldUseSecureCookie(),
      maxAge: MAX_AGE_MS,
      path: "/"
    });
  }
  requestContext.run({ userId }, next);
}

export function setRequestAgentPlanKey(apiKey: string) {
  const userId = currentUserId();
  if (!userId) throw new Error("Missing browser session");
  agentPlanCredentials.set(userId, { apiKey, updatedAt: new Date().toISOString() });
}

export function clearRequestAgentPlanKey() {
  const userId = currentUserId();
  if (!userId) return;
  agentPlanCredentials.delete(userId);
}

export function getRequestAgentPlanKey() {
  const userId = currentUserId();
  if (!userId) return undefined;
  return agentPlanCredentials.get(userId)?.apiKey;
}

export function requestAgentPlanStatus() {
  const apiKey = getRequestAgentPlanKey();
  return {
    configured: Boolean(apiKey),
    fingerprint: apiKey ? keyFingerprint(apiKey) : undefined
  };
}

function currentUserId() {
  return requestContext.getStore()?.userId;
}

function readUserId(req: Request) {
  const cookies = parseCookies(req.headers.cookie || "");
  const value = cookies[COOKIE_NAME];
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

function keyFingerprint(apiKey: string) {
  return createHash("sha256").update(apiKey).digest("hex").slice(0, 10);
}

function shouldUseSecureCookie() {
  if (process.env.REELYAI_COOKIE_SECURE === "0") return false;
  if (process.env.REELYAI_COOKIE_SECURE === "1") return true;
  return process.env.NODE_ENV === "production";
}
