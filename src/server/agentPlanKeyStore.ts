import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { Pool } from "pg";
import type { AdminUserAgentPlanCredential, AgentPlanCredentialStorageStatus } from "../shared/types";

const TABLE_NAME = "reelyai_agent_plan_keys";
const ENCRYPTION_PREFIX = "enc:v1:";

interface CachedAgentPlanCredential {
  apiKey: string;
  fingerprint: string;
  updatedAt: string;
}

interface AgentPlanCredentialMetadata {
  ipHash?: string;
  userAgentHash?: string;
}

const cache = new Map<string, CachedAgentPlanCredential>();
const knownMissingUserIds = new Set<string>();
let pool: Pool | undefined;
let poolUrl = "";
let tableReady: Promise<void> | undefined;
let lastStoreError = "";

export function getCachedAgentPlanCredential(userId: string | undefined) {
  if (!userId) return undefined;
  return cache.get(userId);
}

export async function hydrateAgentPlanCredential(userId: string | undefined) {
  if (!userId) return undefined;
  if (cache.has(userId) || knownMissingUserIds.has(userId)) return cache.get(userId);
  const db = await databasePool();
  if (!db) return undefined;
  try {
    await ensureTable(db);
    const result = await db.query(
      `SELECT api_key_ciphertext, fingerprint, updated_at
       FROM ${TABLE_NAME}
       WHERE user_id = $1`,
      [userId]
    );
    const row = result.rows[0] as { api_key_ciphertext?: string; fingerprint?: string; updated_at?: Date | string } | undefined;
    if (!row?.api_key_ciphertext) {
      knownMissingUserIds.add(userId);
      return undefined;
    }
    const apiKey = decryptApiKey(row.api_key_ciphertext);
    const credential = {
      apiKey,
      fingerprint: row.fingerprint || keyFingerprint(apiKey),
      updatedAt: dateString(row.updated_at)
    };
    cache.set(userId, credential);
    return credential;
  } catch (error) {
    lastStoreError = error instanceof Error ? error.message : String(error);
    console.warn("[agent-plan-key-store] hydrate failed:", lastStoreError);
    return undefined;
  }
}

export async function storeAgentPlanCredential(userId: string, apiKey: string, metadata: AgentPlanCredentialMetadata = {}) {
  const trimmed = apiKey.trim();
  const now = new Date().toISOString();
  const fingerprint = keyFingerprint(trimmed);

  const db = await databasePool();
  if (!db) {
    cache.set(userId, { apiKey: trimmed, fingerprint, updatedAt: now });
    knownMissingUserIds.delete(userId);
    return;
  }
  await ensureTable(db);
  const encrypted = encryptApiKey(trimmed);
  const result = await db.query(
    `INSERT INTO ${TABLE_NAME}
      (user_id, api_key_ciphertext, fingerprint, ip_hash, user_agent_hash, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, now(), now())
     ON CONFLICT (user_id)
     DO UPDATE SET
      api_key_ciphertext = EXCLUDED.api_key_ciphertext,
      fingerprint = EXCLUDED.fingerprint,
      ip_hash = EXCLUDED.ip_hash,
      user_agent_hash = EXCLUDED.user_agent_hash,
      updated_at = now()
     RETURNING updated_at`,
    [userId, encrypted, fingerprint, metadata.ipHash || null, metadata.userAgentHash || null]
  );
  const updatedAt = dateString((result.rows[0] as { updated_at?: Date | string } | undefined)?.updated_at);
  cache.set(userId, { apiKey: trimmed, fingerprint, updatedAt });
  knownMissingUserIds.delete(userId);
}

export async function deleteAgentPlanCredential(userId: string | undefined) {
  if (!userId) return;
  cache.delete(userId);
  knownMissingUserIds.add(userId);
  const db = await databasePool();
  if (!db) return;
  await ensureTable(db);
  await db.query(`DELETE FROM ${TABLE_NAME} WHERE user_id = $1`, [userId]);
}

export async function listAgentPlanCredentialsForAdmin(limit = 100) {
  const db = await databasePool();
  if (!db) {
    return {
      storage: agentPlanCredentialStorageStatus(),
      credentials: [...cache.entries()]
        .map(([userId, credential]) => ({ userId, ...credential }))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, limit)
    };
  }
  await ensureTable(db);
  const result = await db.query(
    `SELECT user_id, api_key_ciphertext, fingerprint, ip_hash, user_agent_hash, created_at, updated_at
     FROM ${TABLE_NAME}
     ORDER BY updated_at DESC
     LIMIT $1`,
    [limit]
  );
  const credentials = result.rows.map((row) => {
    const typed = row as {
      user_id: string;
      api_key_ciphertext: string;
      fingerprint?: string;
      ip_hash?: string;
      user_agent_hash?: string;
      created_at?: Date | string;
      updated_at?: Date | string;
    };
    const apiKey = decryptApiKey(typed.api_key_ciphertext);
    return {
      userId: typed.user_id,
      apiKey,
      fingerprint: typed.fingerprint || keyFingerprint(apiKey),
      ipHash: typed.ip_hash || undefined,
      userAgentHash: typed.user_agent_hash || undefined,
      createdAt: dateString(typed.created_at),
      updatedAt: dateString(typed.updated_at)
    } satisfies AdminUserAgentPlanCredential;
  });
  return { storage: agentPlanCredentialStorageStatus(), credentials };
}

export async function agentPlanCredentialStoreReadiness() {
  const storage = agentPlanCredentialStorageStatus();
  if (!storage.databaseConfigured) {
    return {
      ok: false,
      status: "warn" as const,
      message: "Agent Plan key database is not configured; browser-entered keys are memory-only.",
      storage
    };
  }
  if (!storage.encryptionConfigured) {
    return {
      ok: false,
      status: "error" as const,
      message: "SEEREEL_AGENT_PLAN_KEY_ENCRYPTION_SECRET is required when Agent Plan key database storage is enabled.",
      storage
    };
  }
  try {
    const db = await databasePool();
    if (!db) throw new Error("database pool is unavailable");
    await ensureTable(db);
    await db.query("SELECT 1");
    return { ok: true, status: "ok" as const, storage };
  } catch (error) {
    lastStoreError = error instanceof Error ? error.message : String(error);
    return { ok: false, status: "error" as const, message: lastStoreError, storage: agentPlanCredentialStorageStatus() };
  }
}

export function agentPlanCredentialStorageStatus(): AgentPlanCredentialStorageStatus {
  const databaseConfigured = Boolean(databaseUrl());
  return {
    mode: databaseConfigured ? "database" : "memory",
    databaseConfigured,
    encryptionConfigured: Boolean(configuredEncryptionSecret() || process.env.NODE_ENV !== "production"),
    error: lastStoreError || undefined
  };
}

export function keyFingerprint(apiKey: string) {
  return createHash("sha256").update(apiKey).digest("hex").slice(0, 10);
}

async function databasePool() {
  const url = databaseUrl();
  if (!url) return undefined;
  if (pool && poolUrl === url) return pool;
  poolUrl = url;
  pool = new Pool({
    connectionString: url,
    ssl: databaseSsl()
  });
  pool.on("error", (error) => {
    lastStoreError = error.message;
    console.warn("[agent-plan-key-store] pool error:", error.message);
  });
  return pool;
}

function databaseUrl() {
  return (
    process.env.SEEREEL_DATABASE_URL?.trim() ||
    process.env.REELYAI_DATABASE_URL?.trim() ||
    process.env.AGENT_PLAN_KEYS_DATABASE_URL?.trim() ||
    process.env.DATABASE_URL?.trim() ||
    process.env.POSTGRES_URL?.trim() ||
    ""
  );
}

function databaseSsl() {
  const raw = process.env.SEEREEL_DATABASE_SSL || process.env.REELYAI_DATABASE_SSL || process.env.DATABASE_SSL || "";
  if (/^(1|true|yes|on)$/i.test(raw)) return { rejectUnauthorized: false };
  return undefined;
}

function ensureTable(db: Pool) {
  tableReady ||= db.query(
    `CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
      user_id text PRIMARY KEY,
      api_key_ciphertext text NOT NULL,
      fingerprint text NOT NULL,
      ip_hash text,
      user_agent_hash text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`
  ).then(() => undefined);
  return tableReady;
}

function encryptApiKey(apiKey: string) {
  const secret = encryptionSecret();
  if (!secret) throw new Error("Missing SEEREEL_AGENT_PLAN_KEY_ENCRYPTION_SECRET for database credential storage");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(secret), iv);
  const encrypted = Buffer.concat([cipher.update(apiKey, "utf8"), cipher.final()]);
  return `${ENCRYPTION_PREFIX}${iv.toString("base64url")}:${cipher.getAuthTag().toString("base64url")}:${encrypted.toString("base64url")}`;
}

function decryptApiKey(value: string) {
  if (!value.startsWith(ENCRYPTION_PREFIX)) return value;
  const encoded = value.slice(ENCRYPTION_PREFIX.length);
  const [ivRaw, tagRaw, encryptedRaw] = encoded.split(":");
  if (!ivRaw || !tagRaw || !encryptedRaw) throw new Error("Invalid encrypted Agent Plan key payload");
  const secret = encryptionSecret();
  if (!secret) throw new Error("Missing SEEREEL_AGENT_PLAN_KEY_ENCRYPTION_SECRET for database credential storage");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(secret), Buffer.from(ivRaw, "base64url"));
  decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedRaw, "base64url")),
    decipher.final()
  ]).toString("utf8");
}

function encryptionSecret() {
  return configuredEncryptionSecret() || (process.env.NODE_ENV === "production" ? "" : "seereel-dev-agent-plan-key-secret");
}

function configuredEncryptionSecret() {
  return (
    process.env.SEEREEL_AGENT_PLAN_KEY_ENCRYPTION_SECRET?.trim() ||
    process.env.SEEREEL_CREDENTIAL_ENCRYPTION_SECRET?.trim() ||
    process.env.REELYAI_AGENT_PLAN_KEY_ENCRYPTION_SECRET?.trim() ||
    process.env.REELYAI_CREDENTIAL_ENCRYPTION_SECRET?.trim() ||
    ""
  );
}

function encryptionKey(secret: string) {
  return createHash("sha256").update(secret).digest();
}

function dateString(value: Date | string | undefined) {
  if (value instanceof Date) return value.toISOString();
  return value || new Date().toISOString();
}
