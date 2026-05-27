#!/usr/bin/env node
// End-to-end runner for 《追猎美洲狮·英伦乡野》(6 shots × 15s = 90s, BBC nature-doc, vertical 9:16).
//
// Assumes scripts/setup_puma.mjs has already created the session, patched all 6 shot prompts,
// and generated per-shot sketch assets (shot-scoped, ownerShotId-tagged).
//
// Behaviour:
//   1. Find session by title; bail if not found.
//   2. For each shot in order:
//      - skip if already ready + videoUrl
//      - otherwise POST /generate, poll until ready/error
//      - on error, retry once after 15s
//   3. Trigger /stitch and poll until ready/error (retry once on error).
//   4. Copy the final mp4 into ~/Downloads.
//
// No prompts, no human-in-the-loop. Sketches are NOT regenerated — the user has already reviewed
// them, and Seedream re-runs would produce different images, so we keep the reviewed sketches
// intact. The freshly-signed TOS URLs from setup are still well within their 24h validity window
// for the duration of this run.

import { setTimeout as sleep } from "node:timers/promises";
import { writeFile, mkdir, copyFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const BASE = process.env.CINEMA_BASE_URL || "http://127.0.0.1:5173";
const TITLE = "追猎美洲狮·英伦乡野";
const LOG_PREFIX = "[puma-run]";
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
  if (!session) throw new Error(`Session not found: ${TITLE} (run setup_puma.mjs first)`);
  const shots = state.shots.filter((s) => s.sessionId === session.id).sort((a, b) => a.index - b.index);
  if (!shots.length) throw new Error(`Session ${session.id} has no shots`);
  return { ...session, shots };
}

async function pollShotUntilTerminal(shotId) {
  const deadline = Date.now() + SHOT_TIMEOUT_MS;
  let lastStatus = "";
  let consecutivePollFailures = 0;
  while (Date.now() < deadline) {
    let shot;
    try {
      shot = await jfetch("POST", `/api/shots/${shotId}/poll`, {});
      consecutivePollFailures = 0;
    } catch (err) {
      // Transient errors are common when the server's own fetch to BytePlus Seedance hiccups.
      // The Seedance task is still running on their side, so we just keep polling. We only give
      // up after many consecutive failures.
      consecutivePollFailures += 1;
      const msg = err instanceof Error ? err.message : String(err);
      errlog(`    [poll] transient error (${consecutivePollFailures}): ${msg}`);
      if (consecutivePollFailures >= 10) {
        throw new Error(`Shot ${shotId} polling failed ${consecutivePollFailures} times in a row: ${msg}`);
      }
      await sleep(SHOT_POLL_INTERVAL_MS);
      continue;
    }
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

async function submitShotOnce(shotId) {
  const state = await jfetch("GET", "/api/state");
  const shot = state.shots.find((s) => s.id === shotId);
  if (!shot) throw new Error(`Shot ${shotId} disappeared`);
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
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    log(`>>> ${indexLabel}: ${shot.title}  (attempt ${attempt}/3, assets=${(shot.assetIds || []).length}, continuity=${Boolean(shot.usePreviousShotClip)}, firstFrame=${shot.firstFrameAssetId || "-"})`);
    try {
      await submitShotOnce(shot.id);
    } catch (err) {
      errlog(`    submit failed: ${err.message}`);
      if (attempt === 3) throw err;
      await sleep(15000);
      continue;
    }
    const result = await pollShotUntilTerminal(shot.id);
    if (result.status === "ready" && result.videoUrl) {
      log(`    DONE: videoUrl=${(result.videoUrl || "").slice(0, 80)}${result.videoUrl?.length > 80 ? "..." : ""}`);
      return result;
    }
    errlog(`    shot ${indexLabel} terminated with status=${result.status} error=${result.error || "-"}`);
    if (attempt === 3) throw new Error(`Shot ${indexLabel} failed after ${attempt} attempts: ${result.error || result.status}`);
    log(`    will retry in 15s...`);
    await sleep(15000);
  }
  throw new Error(`unreachable`);
}

async function generateAllSerial(session) {
  log(`generating ${session.shots.length} shots serially (continuity matters)...`);
  const finals = [];
  for (let i = 0; i < session.shots.length; i += 1) {
    const label = `shot ${i + 1}/${session.shots.length}`;
    const state = await jfetch("GET", "/api/state");
    const fresh = state.shots.find((s) => s.id === session.shots[i].id) || session.shots[i];
    const shot = await generateShotWithRetry(fresh, label);
    finals.push(shot);
  }
  return finals;
}

async function triggerStitchAndWait(sessionId) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    log(`stitching final video (attempt ${attempt}/3)...`);
    const trigger = await jfetch("POST", `/api/sessions/${sessionId}/stitch`, {});
    log(`    POST /stitch -> status=${trigger.stitchStatus} progress=${JSON.stringify(trigger.stitchProgress || "")} finalVideoUrl=${trigger.finalVideoUrl || "(none)"}`);
    if (trigger.stitchStatus === "ready" && trigger.finalVideoUrl) return trigger;
    if (trigger.stitchStatus === "error") {
      errlog(`    immediate stitch error: ${trigger.stitchError || "(unknown)"}`);
      if (attempt === 3) throw new Error(`Stitch failed: ${trigger.stitchError || "unknown"}`);
      await sleep(10000);
      continue;
    }

    const deadline = Date.now() + STITCH_TIMEOUT_MS;
    let lastProgress = "";
    let lastStatus = trigger.stitchStatus;
    while (Date.now() < deadline) {
      await sleep(STITCH_POLL_INTERVAL_MS);
      const snapshot = await jfetch("POST", `/api/sessions/${sessionId}/stitch/poll`, {});
      if ((snapshot.stitchProgress || "") !== lastProgress || snapshot.stitchStatus !== lastStatus) {
        log(`    [stitch] ${snapshot.stitchStatus}: ${snapshot.stitchProgress || "(no progress text)"}`);
        lastProgress = snapshot.stitchProgress || "";
        lastStatus = snapshot.stitchStatus;
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
    if (attempt === 3) throw new Error(`Stitch failed after retry`);
    log(`    will retry stitch in 15s...`);
    await sleep(15000);
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
  log(`base=${BASE}`);
  const session = await findSession();
  log(`session ${session.id} (${session.shots.length} shots)`);
  await generateAllSerial(session);
  const stitched = await triggerStitchAndWait(session.id);
  const target = await deliver(stitched);
  log(`ALL DONE -> ${target}`);
}

main().catch((err) => {
  errlog(`FATAL: ${err.message}`);
  process.exit(1);
});
