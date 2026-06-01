import path from "node:path";
import { stat } from "node:fs/promises";
import { TosClient } from "@volcengine/tos-sdk";
import type { Asset, Shot } from "../shared/types";

const mediaDir = path.resolve(process.cwd(), "data", "media");
const mediaUrlPrefix = "/media/";

export interface TosPublishResult {
  key: string;
  url: string;
  localUrl: string;
  expiresSec?: number;
}

export function hasTosConfig() {
  return Boolean(getTosConfig(false));
}

export function isRemoteUrl(url: string | undefined) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return ["http:", "https:"].includes(parsed.protocol) && !["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

export function findLocalMediaUrl(asset: Asset) {
  const candidates = [asset.referenceImageUrl, asset.mediaUrl, asset.imageUrl].filter(Boolean) as string[];
  return candidates.find((url) => url.startsWith(mediaUrlPrefix));
}

export async function publishAssetImageToTos(asset: Asset, shot: Shot): Promise<TosPublishResult> {
  const localUrl = findLocalMediaUrl(asset);
  if (!localUrl) {
    const remoteUrl = asset.mediaUrl || asset.imageUrl || "";
    if (isRemoteUrl(remoteUrl)) {
      return {
        key: asset.tosObjectKey || "",
        url: remoteUrl,
        localUrl: asset.referenceImageUrl || remoteUrl
      };
    }
    throw new Error("这个草图没有可上传的本地 /media 图片。");
  }

  const filePath = localMediaPath(localUrl);
  const info = await stat(filePath);
  if (!info.isFile() || info.size <= 0) throw new Error("本地草图文件为空或不存在。");

  const config = getTosConfig(true);
  const key = makeTosObjectKey(config.keyPrefix, shot, asset, filePath);
  const client = new TosClient({
    accessKeyId: config.accessKeyId,
    accessKeySecret: config.accessKeySecret,
    stsToken: config.stsToken,
    region: config.region,
    endpoint: config.endpoint,
    bucket: config.bucket
  });

  await client.putObjectFromFile({
    bucket: config.bucket,
    key,
    filePath,
    contentType: contentTypeFromPath(filePath),
    cacheControl: "public, max-age=604800"
  });

  if (config.publicBaseUrl) {
    return {
      key,
      url: joinPublicBase(config.publicBaseUrl, key),
      localUrl
    };
  }

  const url = client.getPreSignedUrl({
    bucket: config.bucket,
    key,
    expires: config.presignExpiresSec,
    response: {
      contentType: contentTypeFromPath(filePath)
    }
  });
  return {
    key,
    url,
    localUrl,
    expiresSec: config.presignExpiresSec
  };
}

/**
 * Generic upload helper that doesn't require a Shot — used by reference-video uploads where the
 * asset isn't tied to a specific shot. Uploads any local /media file (image OR video) to TOS,
 * returns a public URL (preferred) or a presigned URL with TTL.
 */
export async function publishLocalMediaToTos(localUrl: string, opts: { keyHint?: string } = {}): Promise<TosPublishResult> {
  if (!localUrl.startsWith(mediaUrlPrefix)) {
    throw new Error("publishLocalMediaToTos 只接受 /media/ 路径");
  }
  const filePath = localMediaPath(localUrl);
  const info = await stat(filePath);
  if (!info.isFile() || info.size <= 0) throw new Error("本地媒体文件为空或不存在。");

  const config = getTosConfig(true);
  const ext = path.extname(filePath).toLowerCase() || ".bin";
  const safeHint = sanitizeKeyPart(opts.keyHint || path.basename(filePath, ext));
  const stamp = Date.now();
  const key = [config.keyPrefix, "uploads", `${safeHint}-${stamp}${ext}`].filter(Boolean).join("/");
  const client = new TosClient({
    accessKeyId: config.accessKeyId,
    accessKeySecret: config.accessKeySecret,
    stsToken: config.stsToken,
    region: config.region,
    endpoint: config.endpoint,
    bucket: config.bucket
  });

  await client.putObjectFromFile({
    bucket: config.bucket,
    key,
    filePath,
    contentType: contentTypeFromPath(filePath),
    cacheControl: "public, max-age=604800"
  });

  if (config.publicBaseUrl) {
    return { key, url: joinPublicBase(config.publicBaseUrl, key), localUrl };
  }
  const url = client.getPreSignedUrl({
    bucket: config.bucket,
    key,
    expires: config.presignExpiresSec,
    response: { contentType: contentTypeFromPath(filePath) }
  });
  return { key, url, localUrl, expiresSec: config.presignExpiresSec };
}

function getTosConfig(throwOnMissing: true): TosConfig;
function getTosConfig(throwOnMissing: false): TosConfig | undefined;
function getTosConfig(throwOnMissing: boolean): TosConfig | undefined {
  const accessKeyId = env("TOS_ACCESS_KEY_ID", "TOS_ACCESS_KEY", "VOLCENGINE_ACCESS_KEY_ID", "VOLC_ACCESS_KEY_ID");
  const accessKeySecret = env(
    "TOS_SECRET_ACCESS_KEY",
    "TOS_ACCESS_KEY_SECRET",
    "TOS_SECRET_KEY",
    "VOLCENGINE_SECRET_ACCESS_KEY",
    "VOLCENGINE_ACCESS_KEY_SECRET",
    "VOLC_SECRET_ACCESS_KEY"
  );
  const region = env("TOS_REGION");
  const bucket = env("TOS_BUCKET");
  const endpoint = normalizeEndpoint(env("TOS_ENDPOINT"));
  const stsToken = env("TOS_STS_TOKEN", "VOLCENGINE_SESSION_TOKEN");
  const publicBaseUrl = env("TOS_PUBLIC_BASE_URL");
  const keyPrefix = (env("TOS_KEY_PREFIX") || "cinema-agent/storyboards").replace(/^\/+|\/+$/g, "");
  const presignExpiresSec = Math.max(60, Number(env("TOS_PRESIGN_EXPIRES_SEC")) || 604800);
  const missing = [
    accessKeyId ? "" : "TOS_ACCESS_KEY_ID",
    accessKeySecret ? "" : "TOS_SECRET_ACCESS_KEY",
    region ? "" : "TOS_REGION",
    bucket ? "" : "TOS_BUCKET"
  ].filter(Boolean);

  if (missing.length) {
    if (!throwOnMissing) return undefined;
    throw new Error(`TOS upload is not configured. 请设置 ${missing.join(", ")}；TOS_ENDPOINT 可选但推荐配置。`);
  }
  if (!accessKeyId || !accessKeySecret || !region || !bucket) return undefined;

  return {
    accessKeyId,
    accessKeySecret,
    region,
    bucket,
    endpoint,
    stsToken,
    publicBaseUrl,
    keyPrefix,
    presignExpiresSec
  } satisfies TosConfig;
}

interface TosConfig {
  accessKeyId: string;
  accessKeySecret: string;
  region: string;
  bucket: string;
  endpoint?: string;
  stsToken?: string;
  publicBaseUrl?: string;
  keyPrefix: string;
  presignExpiresSec: number;
}

function env(...keys: string[]) {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

function normalizeEndpoint(endpoint: string | undefined) {
  if (!endpoint) return undefined;
  return endpoint.replace(/^https?:\/\//, "").replace(/\/+$/g, "");
}

function localMediaPath(url: string) {
  if (!url.startsWith(mediaUrlPrefix)) throw new Error("只支持上传本地 /media 图片到 TOS。");
  const relative = decodeURIComponent(url.slice(mediaUrlPrefix.length));
  const target = path.resolve(mediaDir, relative);
  if (target !== mediaDir && !target.startsWith(`${mediaDir}${path.sep}`)) {
    throw new Error("非法的本地媒体路径。");
  }
  return target;
}

function makeTosObjectKey(prefix: string, shot: Shot, asset: Asset, filePath: string) {
  const ext = path.extname(filePath).toLowerCase() || ".png";
  const safeSession = sanitizeKeyPart(shot.sessionId);
  const safeShot = sanitizeKeyPart(`${String(shot.index).padStart(2, "0")}-${shot.id}`);
  const safeAsset = sanitizeKeyPart(asset.id);
  const stamp = Date.now();
  return [prefix, safeSession, safeShot, `${safeAsset}-${stamp}${ext}`].filter(Boolean).join("/");
}

function sanitizeKeyPart(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "item";
}

function joinPublicBase(baseUrl: string, key: string) {
  const base = baseUrl.replace(/\/+$/g, "");
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  return `${base}/${encodedKey}`;
}

function contentTypeFromPath(filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".mp4" || ext === ".m4v") return "video/mp4";
  if (ext === ".mov") return "video/quicktime";
  if (ext === ".webm") return "video/webm";
  if (ext === ".mp3") return "audio/mpeg";
  if (ext === ".wav") return "audio/wav";
  if (ext === ".m4a") return "audio/mp4";
  return "image/png";
}
