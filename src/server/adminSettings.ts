import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

const DATA_DIR = path.resolve(process.cwd(), "data");
const SETTINGS_FILE = path.join(DATA_DIR, "admin-settings.json");

interface AdminSettingsFile {
  adminAgentPlanKey?: string;
  adminUsername?: string;
  adminPasswordHash?: string;
  adminCredentialsUpdatedAt?: string;
  updatedAt?: string;
}

let settings: AdminSettingsFile = loadSettings();

function loadSettings(): AdminSettingsFile {
  try {
    if (!existsSync(SETTINGS_FILE)) return {};
    return JSON.parse(readFileSync(SETTINGS_FILE, "utf8")) as AdminSettingsFile;
  } catch {
    return {};
  }
}

function saveSettings() {
  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${SETTINGS_FILE}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(settings, null, 2), "utf8");
  renameSync(tmp, SETTINGS_FILE);
}

function envAdminAgentPlanKey() {
  return process.env.REELYAI_ADMIN_AGENT_PLAN_KEY?.trim() || undefined;
}

function envAdminUsername() {
  return process.env.REELYAI_ADMIN_USER?.trim() || process.env.ADMIN_USER?.trim() || undefined;
}

function envAdminPassword() {
  return process.env.REELYAI_ADMIN_PASSWORD?.trim() || process.env.ADMIN_PASSWORD?.trim() || undefined;
}

export function currentAdminUsername() {
  return settings.adminUsername?.trim() || envAdminUsername() || "admin";
}

export function verifyAdminCredentials(username: string, password: string) {
  if (!username || !password) return false;
  if (!constantTimeEqual(username, currentAdminUsername())) return false;
  if (settings.adminPasswordHash) return verifyPassword(password, settings.adminPasswordHash);
  const envPassword = envAdminPassword();
  return Boolean(envPassword && constantTimeEqual(password, envPassword));
}

export function setStoredAdminCredentials(input: { username?: string; password: string }) {
  const username = input.username?.trim() || currentAdminUsername();
  const password = input.password;
  if (username.length < 2) throw new Error("请输入有效的管理员用户名");
  if (password.length < 8) throw new Error("管理员密码至少需要 8 位");
  settings = {
    ...settings,
    adminUsername: username,
    adminPasswordHash: hashPassword(password),
    adminCredentialsUpdatedAt: new Date().toISOString()
  };
  saveSettings();
  return adminSecurityStatus();
}

export function adminSecurityStatus() {
  return {
    configured: Boolean(settings.adminPasswordHash || envAdminPassword()),
    source: settings.adminPasswordHash ? "ui" as const : envAdminPassword() ? "env" as const : "none" as const,
    updatedAt: settings.adminCredentialsUpdatedAt
  };
}

export function getAdminAgentPlanKey() {
  if (/^(1|true|yes|on)$/i.test(process.env.REELYAI_DISABLE_ADMIN_AGENT_PLAN || "")) return undefined;
  return settings.adminAgentPlanKey?.trim() || envAdminAgentPlanKey();
}

export function hasAdminAgentPlanKey() {
  return Boolean(getAdminAgentPlanKey());
}

export function setStoredAdminAgentPlanKey(apiKey: string) {
  const trimmed = apiKey.trim();
  if (!trimmed || trimmed.length < 8) throw new Error("请输入有效的 Agent Plan Key");
  settings = { ...settings, adminAgentPlanKey: trimmed, updatedAt: new Date().toISOString() };
  saveSettings();
  return adminAgentPlanStatus();
}

export function clearStoredAdminAgentPlanKey() {
  settings = { ...settings, adminAgentPlanKey: undefined, updatedAt: new Date().toISOString() };
  saveSettings();
  return adminAgentPlanStatus();
}

export function adminAgentPlanStatus() {
  if (/^(1|true|yes|on)$/i.test(process.env.REELYAI_DISABLE_ADMIN_AGENT_PLAN || "")) {
    return {
      configured: false,
      fingerprint: undefined,
      source: "none" as const,
      updatedAt: settings.updatedAt
    };
  }
  const stored = settings.adminAgentPlanKey?.trim();
  const env = envAdminAgentPlanKey();
  const effective = stored || env;
  return {
    configured: Boolean(effective),
    fingerprint: effective ? keyFingerprint(effective) : undefined,
    source: stored ? "ui" as const : env ? "env" as const : "none" as const,
    updatedAt: settings.updatedAt
  };
}

function keyFingerprint(apiKey: string) {
  return createHash("sha256").update(apiKey).digest("hex").slice(0, 10);
}

function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `scrypt:v1:${salt}:${hash}`;
}

function verifyPassword(password: string, stored: string) {
  const [scheme, version, salt, expected] = stored.split(":");
  if (scheme !== "scrypt" || version !== "v1" || !salt || !expected) return false;
  const actual = scryptSync(password, salt, 64);
  const expectedBuffer = Buffer.from(expected, "hex");
  return actual.length === expectedBuffer.length && timingSafeEqual(actual, expectedBuffer);
}

function constantTimeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
