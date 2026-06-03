import { access, mkdir, readdir, stat, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import type { StoreSnapshot } from "../shared/types";
import { DATA_DIR, STORE_FILE } from "./store";

export interface ComponentStatus {
  ok: boolean;
  status: "ok" | "warn" | "error";
  message?: string;
}

let mediaCache: { at: number; value: { bytes: number; files: number } } | undefined;

interface DirectoryEntry {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

export async function directoryStats(dir: string, ttlMs = 60_000) {
  const now = Date.now();
  if (mediaCache && now - mediaCache.at < ttlMs) return mediaCache.value;
  let bytes = 0;
  let files = 0;
  async function walk(current: string) {
    let entries: DirectoryEntry[];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(entries.map(async (entry) => {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) return walk(fullPath);
      if (!entry.isFile()) return;
      try {
        const info = await stat(fullPath);
        bytes += info.size;
        files += 1;
      } catch {
        // Best-effort diagnostics; files may disappear while scanning.
      }
    }));
  }
  await walk(dir);
  const value = { bytes, files };
  mediaCache = { at: now, value };
  return value;
}

export async function fileSize(filePath: string) {
  try {
    return (await stat(filePath)).size;
  } catch {
    return 0;
  }
}

export async function writableDirectoryStatus(dir: string): Promise<ComponentStatus> {
  try {
    await mkdir(dir, { recursive: true });
    const probe = path.join(dir, `.reelyai-ready-${process.pid}-${Date.now()}`);
    await writeFile(probe, "ok", "utf8");
    await unlink(probe);
    return { ok: true, status: "ok" };
  } catch (error) {
    return { ok: false, status: "error", message: error instanceof Error ? error.message : String(error) };
  }
}

export async function readableFileStatus(filePath: string): Promise<ComponentStatus> {
  try {
    await access(filePath);
    return { ok: true, status: "ok" };
  } catch (error) {
    return { ok: false, status: "error", message: error instanceof Error ? error.message : String(error) };
  }
}

export function snapshotCounts(snapshot: StoreSnapshot) {
  const tokenUsageEvents = snapshot.sessions.reduce((sum, session) => sum + (session.tokenUsageEvents?.length || 0), 0);
  const renders = snapshot.shots.reduce((sum, shot) => sum + (shot.renders?.length || 0), 0);
  return {
    sessions: snapshot.sessions.length,
    shots: snapshot.shots.length,
    assets: snapshot.assets.length,
    renders,
    tokenUsageEvents
  };
}

export function tokenUsageSummary(snapshot: StoreSnapshot) {
  const summary = new Map<string, { provider: string; model: string; operation: string; totalTokens: number; events: number }>();
  for (const session of snapshot.sessions) {
    for (const event of session.tokenUsageEvents || []) {
      const provider = event.provider || "unknown";
      const model = event.model || event.modelFamily || "unknown";
      const operation = event.operation || "unknown";
      const key = `${provider}\t${model}\t${operation}`;
      const row = summary.get(key) || { provider, model, operation, totalTokens: 0, events: 0 };
      row.totalTokens += event.totalTokens || 0;
      row.events += 1;
      summary.set(key, row);
    }
  }
  return Array.from(summary.values()).sort((a, b) => b.totalTokens - a.totalTokens).slice(0, 20);
}

export function productionPaths() {
  return { dataDir: DATA_DIR, storeFile: STORE_FILE };
}
