#!/usr/bin/env node
// End-to-end driver for 《末代皇帝·阿美莉卡使节》(72s, 6 shots, Bertolucci homage).
//
// Assumes scripts/setup_last_emperor.mjs has already created the session and patched all
// shot prompts (this script is idempotent and will just reuse the existing session).
//
// Behaviour:
//   1. Find the session by title; bail if not found (user must run setup first).
//   2. For each shot in order:
//      - skip if already ready+videoUrl
//      - otherwise POST /generate, poll until ready/error
//      - on error, do ONE automatic retry (clears generation state, re-submits)
//   3. Trigger the (new async) stitch flow and poll /stitch/poll until ready or error.
//      - On error, retry stitch once.
//   4. Copy the final mp4 into ~/Downloads.
//
// No prompts, no human-in-the-loop. Logs everything so the next morning's review is easy.

import { setTimeout as sleep } from "node:timers/promises";
import { writeFile, mkdir, copyFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const BASE = process.env.CINEMA_BASE_URL || "http://127.0.0.1:5173";
const TITLE = "末代皇帝·阿美莉卡使节";
const LOG_PREFIX = "[last-emperor]";
const SHOT_POLL_INTERVAL_MS = 8000;
const SHOT_TIMEOUT_MS = 25 * 60 * 1000;
const STITCH_POLL_INTERVAL_MS = 5000;
const STITCH_TIMEOUT_MS = 45 * 60 * 1000;

const log = (...args) => console.log(LOG_PREFIX, ...args);
const errlog = (...args) => console.error(LOG_PREFIX, ...args);

async function jfetch(method, url, body) {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body == null ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : undefined; } catch { data = text; }
  if (!res.ok) {
    const detail = typeof data === "string" ? data : JSON.stringify(data);
    throw new Error(`${method} ${url} -> ${res.status}: ${detail}`);
  }
  return data;
}

async function findSession() {
  const state = await jfetch("GET", "/api/state");
  const session = state.sessions.find((s) => s.title === TITLE);
  if (!session) throw new Error(`Session not found: ${TITLE} (run setup_last_emperor.mjs first)`);
  const shots = state.shots.filter((s) => s.sessionId === session.id).sort((a, b) => a.index - b.index);
  if (!shots.length) throw new Error(`Session ${session.id} has no shots`);
  return { ...session, shots };
}

async function pollShotUntilTerminal(shotId) {
  const deadline = Date.now() + SHOT_TIMEOUT_MS;
  let lastStatus = "";
  while (Date.now() < deadline) {
    const shot = await jfetch("POST", `/api/shots/${shotId}/poll`, {});
    if (shot.status !== lastStatus) {
      log(`    [poll] status=${shot.status}${shot.error ? ` error=${shot.error}` : ""}`);
      lastStatus = shot.status;
    }
    if (shot.status === "ready" && shot.videoUrl) return shot;
    if (shot.status === "error" || shot.status === "cancelled") return shot;
    await sleep(SHOT_POLL_INTERVAL_MS);
  }
  throw new Error(`Shot ${shotId} polling timed out after ${(SHOT_TIMEOUT_MS / 60000).toFixed(0)}min`);
}

async function submitShotOnce(shot) {
  const submission = await jfetch("POST", `/api/shots/${shot.id}/generate`, {
    rawPrompt: shot.rawPrompt,
    prompt: shot.rawPrompt,
    seedanceVariant: shot.seedanceVariant,
    usePreviousShotClip: shot.usePreviousShotClip,
    previousShotClipSec: shot.previousShotClipSec,
    assetIds: shot.assetIds,
    durationSec: shot.durationSec,
    firstFrameAssetId: shot.firstFrameAssetId
  });
  log(`    submitted, status=${submission.status}, task=${submission.generationTaskId || "-"}`);
}

async function generateShotWithRetry(shot, indexLabel) {
  if (shot.status === "ready" && shot.videoUrl) {
    log(`>>> ${indexLabel}: ${shot.title}  (already ready, skip)`);
    return shot;
  }
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    log(`>>> ${indexLabel}: ${shot.title}  (attempt ${attempt}/2)`);
    try {
      await submitShotOnce(shot);
    } catch (err) {
      errlog(`    submit failed: ${err.message}`);
      if (attempt === 2) throw err;
      await sleep(5000);
      continue;
    }
    const result = await pollShotUntilTerminal(shot.id);
    if (result.status === "ready" && result.videoUrl) {
      log(`    DONE: videoUrl=${(result.videoUrl || "").slice(0, 80)}${result.videoUrl?.length > 80 ? "..." : ""}`);
      return result;
    }
    errlog(`    shot ${indexLabel} terminated with status=${result.status} error=${result.error || "-"}`);
    if (attempt === 2) throw new Error(`Shot ${indexLabel} failed after retry: ${result.error || result.status}`);
    log(`    will retry in 10s...`);
    await sleep(10000);
  }
  throw new Error(`unreachable`);
}

async function generateAllSerial(session) {
  log(`generating ${session.shots.length} shots serially (continuity)...`);
  const finals = [];
  for (let i = 0; i < session.shots.length; i += 1) {
    const label = `shot ${i + 1}/${session.shots.length}`;
    const shot = await generateShotWithRetry(session.shots[i], label);
    finals.push(shot);
  }
  return finals;
}

async function triggerStitchAndWait() {
  // New stitch is fire-and-forget. POST /stitch returns immediately with the latest snapshot;
  // we then poll /stitch/poll until ready/error. The server runs ffmpeg in the background and
  // survives any client disconnection, so even if this script dies mid-poll the work continues
  // and a later poll will pick up the final result.
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    log(`stitching final video (attempt ${attempt}/2)...`);
    const trigger = await jfetch("POST", `/api/sessions/${(await findSession()).id}/stitch`, {});
    log(`    POST /stitch -> status=${trigger.stitchStatus} progress=${JSON.stringify(trigger.stitchProgress || "")} finalVideoUrl=${trigger.finalVideoUrl || "(none)"}`);
    if (trigger.stitchStatus === "ready" && trigger.finalVideoUrl) return trigger;
    if (trigger.stitchStatus === "error") {
      errlog(`    immediate stitch error: ${trigger.stitchError || "(unknown)"}`);
      if (attempt === 2) throw new Error(`Stitch failed: ${trigger.stitchError || "unknown"}`);
      await sleep(5000);
      continue;
    }

    const deadline = Date.now() + STITCH_TIMEOUT_MS;
    let lastProgress = "";
    while (Date.now() < deadline) {
      await sleep(STITCH_POLL_INTERVAL_MS);
      const snapshot = await jfetch("POST", `/api/sessions/${trigger.id}/stitch/poll`, {});
      if ((snapshot.stitchProgress || "") !== lastProgress) {
        log(`    [stitch] ${snapshot.stitchStatus}: ${snapshot.stitchProgress || "(no progress text)"}`);
        lastProgress = snapshot.stitchProgress || "";
      }
      if (snapshot.stitchStatus === "ready" && snapshot.finalVideoUrl) {
        log(`    stitching done: ${snapshot.finalVideoUrl}`);
        return snapshot;
      }
      if (snapshot.stitchStatus === "error") {
        errlog(`    stitch worker reported error: ${snapshot.stitchError || "(unknown)"}`);
        break;
      }
    }
    if (attempt === 2) throw new Error(`Stitch failed after retry`);
    log(`    will retry stitch in 10s...`);
    await sleep(10000);
  }
  throw new Error("unreachable stitch retry loop");
}

async function deliver(session) {
  if (!session.finalVideoUrl) throw new Error("Session did not produce a final video");
  let localPath;
  if (session.finalVideoUrl.startsWith("/media/")) {
    localPath = path.resolve(process.cwd(), "data", "media", path.basename(session.finalVideoUrl));
  } else if (session.finalVideoUrl.startsWith("http")) {
    localPath = path.resolve(os.tmpdir(), `${session.id}-final.mp4`);
    const res = await fetch(session.finalVideoUrl);
    const buf = Buffer.from(await res.arrayBuffer());
    await mkdir(path.dirname(localPath), { recursive: true });
    await writeFile(localPath, buf);
  }
  if (!localPath) throw new Error(`Cannot resolve final video path from ${session.finalVideoUrl}`);
  const downloads = path.join(os.homedir(), "Downloads");
  await mkdir(downloads, { recursive: true });
  const target = path.join(downloads, `${TITLE}-cinema_agent-${session.id}.mp4`);
  await copyFile(localPath, target);
  log(`delivered: ${target}`);
  return target;
}

async function main() {
  const session = await findSession();
  log(`session ${session.id} (${session.shots.length} shots)`);
  await generateAllSerial(session);
  const stitched = await triggerStitchAndWait();
  const target = await deliver(stitched);
  log(`ALL DONE -> ${target}`);
}

main().catch((err) => {
  errlog(`FATAL: ${err.message}`);
  process.exit(1);
});
