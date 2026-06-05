#!/usr/bin/env node
// Re-generate shot 2 (the 闪回 flashback) of session 白门楼 with the new derived assets
// (青年曹操 / 青年陈宫), wait until ready, then re-stitch the final video and copy it to Downloads.

import { setTimeout as sleep } from "node:timers/promises";
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const BASE = process.env.CINEMA_BASE_URL || "http://127.0.0.1:5173";
const log = (...args) => console.log("[shot2]", ...args);

async function j(method, url, body) {
  const r = await fetch(`${BASE}${url}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body && JSON.stringify(body)
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`${method} ${url} -> ${r.status}: ${t}`);
  return t ? JSON.parse(t) : undefined;
}

async function pollUntilReady(shotId, maxMs = 30 * 60 * 1000) {
  const deadline = Date.now() + maxMs;
  let lastStatus = "";
  while (Date.now() < deadline) {
    const shot = await j("POST", `/api/shots/${shotId}/poll`, {});
    if (shot.status !== lastStatus) {
      log(`  [poll] status=${shot.status}${shot.error ? ` err=${shot.error}` : ""}`);
      lastStatus = shot.status;
    }
    if (shot.status === "ready" && shot.videoUrl) return shot;
    if (shot.status === "error") throw new Error(`Shot ${shotId} failed: ${shot.error || "unknown"}`);
    if (shot.status === "cancelled") throw new Error(`Shot ${shotId} was cancelled`);
    await sleep(10_000);
  }
  throw new Error(`Shot ${shotId} timed out`);
}

const state = await j("GET", "/api/state");
const sess = state.sessions.find((s) => s.title === "白门楼");
if (!sess) throw new Error("白门楼 session not found");
const shot2 = state.shots.find((s) => s.sessionId === sess.id && s.index === 2);
if (!shot2) throw new Error("shot 2 not found");

log(`shot 2 id=${shot2.id} variant=${shot2.seedanceVariant} assets=${shot2.assetIds.length}`);
log(`submitting generate...`);
await j("POST", `/api/shots/${shot2.id}/generate`, {});

const ready = await pollUntilReady(shot2.id);
log(`shot 2 DONE -> ${ready.videoUrl}`);

log(`stitching final video...`);
const stitched = await j("POST", `/api/sessions/${sess.id}/stitch`);
log(`final -> ${stitched.finalVideoUrl}`);

if (stitched.finalVideoUrl?.startsWith("/media/")) {
  const local = path.resolve(process.cwd(), "data", "media", path.basename(stitched.finalVideoUrl));
  const target = path.join(os.homedir(), "Downloads", `白门楼-cinema_agent-${sess.id}.mp4`);
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(local, target);
  log(`delivered: ${target}`);
}
log("ALL DONE");
