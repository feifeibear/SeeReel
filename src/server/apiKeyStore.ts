import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { Pool } from "pg";
import type { AgentPlanCredentialStorageStatus, StandardApiKeyRoute } from "../shared/types";
import { keyFingerprint } from "./agentPlanKeyStore";

const TABLE_NAME = "seereel_user_api_keys";
const ENCRYPTION_PREFIX = "enc:v1:";

interface CachedApiKeyCredential {
  apiKey: string;
  fingerprint: string;
  route: StandardApiKeyRoute;
  updatedAt: string;
}

interface ApiKeyCredentialMetadata {
  ipHash?: string;
  userAgentHash?: string;
}

const cache = new Map<string, CachedApiKeyCredential>();
const knownMissingUserIds = new Set<string>();
let pool: Pool | undefined;
let poolUrl = "";
let tableReady: Promise<void> | undefined;
let lastStoreError = "";

export function getCachedApiKeyCredential(userId: string | undefined) {
  if (!userId) return undefined;
  return cache.get(userId);
}

export async function hydrateApiKeyCredential(userId: string | undefined) {
  if (!userId) return undefined;
  if (cache.has(userId) || knownMissingUserIds.has(userId)) return cache.get(userId);
  const db = await databasePool();
  if (!db) return undefined;
  try {
    await ensureTable(db);
    const result = await db.query(
      `SELECT api_key_ciphertext, fingerprint, standard_route, updated_at
       FROM ${TABLE_NAME}
       WHERE user_id = $1`,
      [userId]
    );
    const row = result.rows[0] as { api_key_ciphertext?: string; fingerprint?: string; standard_route?: string; updated_at?: Date | string } | undefined;
    if (!row?.api_key_ciphertext) {
      knownMissingUserIds.add(userId);
      return undefined;
    }
    const apiKey = decryptApiKey(row.api_key_ciphertext);
    const credential = {
      apiKey,
      fingerprint: row.fingerprint || keyFingerprint(apiKey),
      route: normalizeRoute(row.standard_route),
      updatedAt: dateString(row.updated_at)
    };
    cache.set(userId, credential);
    return credential;
  } catch (error) {
    lastStoreError = error instanceof Error ? error.message : String(error);
    console.warn("[api-key-store] hydrate failed:", lastStoreError);
    return undefined;
  }
}

export async function storeApiKeyCredential(userId: string, apiKey: string, route: StandardApiKeyRoute = "byteplus", metadata: ApiKeyCredentialMetadata = {}) {
  const trimmed = apiKey.trim();
  const normalizedRoute = normalizeRoute(route);
  const now = new Date().toISOString();
  const fingerprint = keyFingerprint(trimmed);

  const db = await databasePool();
  if (!db) {
    cache.set(userId, { apiKey: trimmed, fingerprint, route: normalizedRoute, updatedAt: now });
    knownMissingUserIds.delete(userId);
    return;
  }
  await ensureTable(db);
  const encrypted = encryptApiKey(trimmed);
  const result = await db.query(
    `INSERT INTO ${TABLE_NAME}
      (user_id, api_key_ciphertext, fingerprint, standard_route, ip_hash, user_agent_hash, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, now(), now())
     ON CONFLICT (user_id)
     DO UPDATE SET
      api_key_ciphertext = EXCLUDED.api_key_ciphertext,
      fingerprint = EXCLUDED.fingerprint,
      standard_route = EXCLUDED.standard_route,
      ip_hash = EXCLUDED.ip_hash,
      user_agent_hash = EXCLUDED.user_agent_hash,
      updated_at = now()
     RETURNING updated_at`,
    [userId, encrypted, fingerprint, normalizedRoute, metadata.ipHash || null, metadata.userAgentHash || null]
  );
  const updatedAt = dateString((result.rows[0] as { updated_at?: Date | string } | undefined)?.updated_at);
  cache.set(userId, { apiKey: trimmed, fingerprint, route: normalizedRoute, updatedAt });
  knownMissingUserIds.delete(userId);
}

export async function deleteApiKeyCredential(userId: string | undefined) {
  if (!userId) return;
  cache.delete(userId);
  knownMissingUserIds.add(userId);
  const db = await databasePool();
  if (!db) return;
  await ensureTable(db);
  await db.query(`DELETE FROM ${TABLE_NAME} WHERE user_id = $1`, [userId]);
}

export function apiKeyCredentialStorageStatus(): AgentPlanCredentialStorageStatus {
  const databaseConfigured = Boolean(databaseUrl());
  return {
    mode: databaseConfigured ? "database" : "memory",
    databaseConfigured,
    encryptionConfigured: Boolean(configuredEncryptionSecret() || process.env.NODE_ENV !== "production"),
    error: lastStoreError || undefined
  };
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
    console.warn("[api-key-store] pool error:", error.message);
  });
  return pool;
}

function databaseUrl() {
  return (
    process.env.SEEREEL_DATABASE_URL?.trim() ||
    process.env.REELYAI_DATABASE_URL?.trim() ||
    process.env.USER_API_KEYS_DATABASE_URL?.trim() ||
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
      standard_route text NOT NULL DEFAULT 'byteplus',
      ip_hash text,
      user_agent_hash text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`
  )
    .then(() => db.query(`ALTER TABLE ${TABLE_NAME} ADD COLUMN IF NOT EXISTS standard_route text NOT NULL DEFAULT 'byteplus'`))
    .then(() => undefined);
  return tableReady;
}

function normalizeRoute(value: unknown): StandardApiKeyRoute {
  return value === "volcengine-cn" ? "volcengine-cn" : "byteplus";
}

function encryptApiKey(apiKey: string) {
  const secret = encryptionSecret();
  if (!secret) throw new Error("Missing SEEREEL_CREDENTIAL_ENCRYPTION_SECRET for database API key storage");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(secret), iv);
  const encrypted = Buffer.concat([cipher.update(apiKey, "utf8"), cipher.final()]);
  return `${ENCRYPTION_PREFIX}${iv.toString("base64url")}:${cipher.getAuthTag().toString("base64url")}:${encrypted.toString("base64url")}`;
}

function decryptApiKey(value: string) {
  if (!value.startsWith(ENCRYPTION_PREFIX)) return value;
  const encoded = value.slice(ENCRYPTION_PREFIX.length);
  const [ivRaw, tagRaw, encryptedRaw] = encoded.split(":");
  if (!ivRaw || !tagRaw || !encryptedRaw) throw new Error("Invalid encrypted API key payload");
  const secret = encryptionSecret();
  if (!secret) throw new Error("Missing SEEREEL_CREDENTIAL_ENCRYPTION_SECRET for database API key storage");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(secret), Buffer.from(ivRaw, "base64url"));
  decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedRaw, "base64url")),
    decipher.final()
  ]).toString("utf8");
}

function encryptionSecret() {
  return configuredEncryptionSecret() || (process.env.NODE_ENV === "production" ? "" : "seereel-dev-api-key-secret");
}

function configuredEncryptionSecret() {
  return (
    process.env.SEEREEL_API_KEY_ENCRYPTION_SECRET?.trim() ||
    process.env.SEEREEL_CREDENTIAL_ENCRYPTION_SECRET?.trim() ||
    process.env.SEEREEL_AGENT_PLAN_KEY_ENCRYPTION_SECRET?.trim() ||
    process.env.REELYAI_API_KEY_ENCRYPTION_SECRET?.trim() ||
    process.env.REELYAI_CREDENTIAL_ENCRYPTION_SECRET?.trim() ||
    process.env.REELYAI_AGENT_PLAN_KEY_ENCRYPTION_SECRET?.trim() ||
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
