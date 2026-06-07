import path from "node:path";
import { rm } from "node:fs/promises";
import type { StoreSnapshot } from "../shared/types";
import { MEDIA_DIR } from "./generators";
import { deleteTosObjectKeys as defaultDeleteTosObjectKeys } from "./tos";

const mediaUrlPrefix = "/media/";

export interface DeletedSessionArtifacts {
  localMediaUrls: Set<string>;
  tosObjectKeys: Set<string>;
}

export interface TosDeleteResult {
  deletedKeys: string[];
  failed: Array<{ key: string; error: string }>;
}

export interface SessionArtifactCleanupOptions {
  mediaDir?: string;
  deleteTosObjectKeys?: (keys: string[]) => Promise<TosDeleteResult>;
}

export interface SessionArtifactCleanupResult {
  deletedLocalMedia: string[];
  skippedLocalMedia: string[];
  failedLocalMedia: Array<{ url: string; path: string; error: string }>;
  deletedTosObjectKeys: string[];
  skippedTosObjectKeys: string[];
  failedTosObjectKeys: Array<{ key: string; error: string }>;
}

export function collectDeletedSessionArtifacts(snapshot: StoreSnapshot, sessionId: string): DeletedSessionArtifacts {
  const session = snapshot.sessions.find((item) => item.id === sessionId);
  if (!session) return emptyDeletedSessionArtifacts();

  const shots = snapshot.shots.filter((shot) => shot.sessionId === sessionId);
  const shotIds = new Set(shots.map((shot) => shot.id));
  const assets = snapshot.assets.filter((asset) => {
    if (asset.ownerSessionId === sessionId) return true;
    if (asset.ownerShotId && shotIds.has(asset.ownerShotId)) return true;
    return false;
  });
  return collectReferencesFromValue({ session, shots, assets });
}

export function collectDeletedSessionsArtifacts(snapshot: StoreSnapshot, sessionIds: string[]): DeletedSessionArtifacts {
  const merged = emptyDeletedSessionArtifacts();
  Array.from(new Set(sessionIds)).forEach((sessionId) => {
    const artifacts = collectDeletedSessionArtifacts(snapshot, sessionId);
    artifacts.localMediaUrls.forEach((url) => merged.localMediaUrls.add(url));
    artifacts.tosObjectKeys.forEach((key) => merged.tosObjectKeys.add(key));
  });
  return merged;
}

export async function cleanupDeletedSessionArtifacts(
  artifacts: DeletedSessionArtifacts,
  remainingSnapshot: StoreSnapshot,
  options: SessionArtifactCleanupOptions = {}
): Promise<SessionArtifactCleanupResult> {
  const remainingRefs = collectReferencesFromValue(remainingSnapshot);
  const result: SessionArtifactCleanupResult = {
    deletedLocalMedia: [],
    skippedLocalMedia: [],
    failedLocalMedia: [],
    deletedTosObjectKeys: [],
    skippedTosObjectKeys: [],
    failedTosObjectKeys: []
  };

  const mediaDir = path.resolve(options.mediaDir || MEDIA_DIR);
  const localUrls = [...artifacts.localMediaUrls].sort();
  for (const url of localUrls) {
    if (remainingRefs.localMediaUrls.has(url)) {
      result.skippedLocalMedia.push(url);
      continue;
    }
    const filePath = localMediaPathFromUrl(url, mediaDir);
    if (!filePath) {
      result.failedLocalMedia.push({ url, path: "", error: "Unsupported local media URL" });
      continue;
    }
    try {
      await rm(filePath, { force: true });
      result.deletedLocalMedia.push(url);
    } catch (error) {
      result.failedLocalMedia.push({ url, path: filePath, error: errorMessage(error) });
    }
  }

  const tosKeys = [...artifacts.tosObjectKeys].filter((key) => !remainingRefs.tosObjectKeys.has(key)).sort();
  result.skippedTosObjectKeys.push(...[...artifacts.tosObjectKeys].filter((key) => remainingRefs.tosObjectKeys.has(key)).sort());
  if (tosKeys.length > 0) {
    const deleteTosObjectKeys = options.deleteTosObjectKeys || defaultDeleteTosObjectKeys;
    try {
      const tosResult = await deleteTosObjectKeys(tosKeys);
      result.deletedTosObjectKeys.push(...tosResult.deletedKeys);
      result.failedTosObjectKeys.push(...tosResult.failed);
    } catch (error) {
      result.failedTosObjectKeys.push(...tosKeys.map((key) => ({ key, error: errorMessage(error) })));
    }
  }

  return result;
}

function emptyDeletedSessionArtifacts(): DeletedSessionArtifacts {
  return { localMediaUrls: new Set(), tosObjectKeys: new Set() };
}

function collectReferencesFromValue(value: unknown): DeletedSessionArtifacts {
  const refs = emptyDeletedSessionArtifacts();
  visitValue(value, refs);
  return refs;
}

function visitValue(value: unknown, refs: DeletedSessionArtifacts) {
  if (typeof value === "string") {
    const localUrl = normalizeLocalMediaUrl(value);
    if (localUrl) refs.localMediaUrls.add(localUrl);
    return;
  }
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item) => visitValue(item, refs));
    return;
  }

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (isTosObjectKeyField(key) && typeof child === "string" && child.trim()) {
      refs.tosObjectKeys.add(child.trim());
    }
    visitValue(child, refs);
  }
}

function isTosObjectKeyField(key: string) {
  return key === "tosObjectKey" || key.endsWith("TosObjectKey");
}

function normalizeLocalMediaUrl(value: string) {
  if (value.startsWith(mediaUrlPrefix)) return stripQueryAndHash(value);
  try {
    const parsed = new URL(value);
    if (parsed.pathname.startsWith(mediaUrlPrefix)) return parsed.pathname;
  } catch {
    return undefined;
  }
  return undefined;
}

function stripQueryAndHash(value: string) {
  const [withoutHash] = value.split("#", 1);
  const [withoutQuery] = withoutHash.split("?", 1);
  return withoutQuery;
}

function localMediaPathFromUrl(mediaUrl: string, mediaDir: string) {
  const normalized = normalizeLocalMediaUrl(mediaUrl);
  if (!normalized) return undefined;
  const relative = decodeURIComponent(normalized.slice(mediaUrlPrefix.length));
  const resolved = path.resolve(mediaDir, relative);
  if (resolved !== mediaDir && !resolved.startsWith(`${mediaDir}${path.sep}`)) return undefined;
  return resolved;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
