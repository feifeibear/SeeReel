import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

const DATA_DIR = path.resolve(process.cwd(), "data");
const SETTINGS_FILE = path.join(DATA_DIR, "admin-settings.json");

interface AdminSettingsFile {
  adminAgentPlanKey?: string;
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
