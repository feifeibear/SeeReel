import "dotenv/config";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express, { type Request, type Response } from "express";
import {
  canUseBytePlusSeedance,
  cacheGeneratedVideo,
  cancelSeedanceVideoTask,
  createSeedanceVideoTask,
  createStitchSignature,
  expandAssetPrompt,
  extractTailAudioClip,
  extractTailVideoClip,
  generateAssetImage,
  generateShotVideo,
  generateStoryPlan,
  generateStoryboard,
  MEDIA_DIR,
  pollSeedanceVideoTask,
  probeMediaDurationSec,
  resolveSeedanceModel,
  runFfmpegCommand,
  seedanceTimeoutMs,
  stitchShotVideos
} from "./generators";
import { computeNarrationSignature, resolveEffectiveVoice, runNarrationPipeline } from "./narration";
import { CinemaStore } from "./store";
import { publishAssetImageToTos, publishLocalMediaToTos, hasTosConfig } from "./tos";
import { condenseForSeedanceR2V, probeVideo, type CondenseStrategy } from "./videoCondense";
import { buildShotFrameAssignments, generateStoryboardGrid } from "./storyboardGrid";
import { buildSubStoryboardAssetPayload, generateSubStoryboardGrid, generateSubStoryboardSequential, type SubStoryboardResult } from "./subStoryboard";
import { analyzeReferenceVideo } from "./videoAnalyze";
import {
  composeSeedanceVideoText,
  composeSeedreamAssetPrompt,
  composeSeedreamMultiFrameGroup,
  composeSeedreamSubStoryboardGrid,
  resolveLang
} from "./promptCompose";
import {
  clampMaxAttempts,
  reviewImage,
  reviewImageDetailed,
  reviewVideo,
  reviewVideoDetailed,
  rewritePromptWithReviewFeedback,
  shouldEnableReview,
  withImageReview,
  formatReviewNote
} from "./visionReview";
import type {
  Asset,
  NarrationStrategy,
  SeedancePhase,
  Session,
  Shot,
  ShotRender,
  StitchJob,
  StoryCharacter,
  StoryPlan,
  SubStoryboardModel,
  VideoReviewRepairPlan,
  VideoReviewVerdict
} from "../shared/types";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isProduction = process.env.NODE_ENV === "production";
const port = Number(process.env.PORT || 5173);
const mediaDir = path.resolve(process.cwd(), "data", "media");
const storyboardMediaDir = path.join(mediaDir, "codex-storyboards");

const app = express();
const store = new CinemaStore();
await store.load();
const shotGenerateSubmissions = new Map<string, Promise<{ status: number; body: unknown }>>();
// In-process singleflight registry for stitch background workers. Keyed by sessionId + stitch job id;
// value is the signature currently being processed. Survives concurrent /stitch POSTs but does NOT
// survive process restart (handled separately via resetOrphanStitchJobs() at startup).
const stitchInflight = new Map<string, string>();
// Same idea but for the narration pipeline (TTS + ffmpeg subtitle/audio mix).
const narrationInflight = new Map<string, string>();
// Vision-review lock keyed by renderId. Concurrent /poll calls for the same render must not each
// fire an independent reviewVideo + resubmit, otherwise we burn N parallel Seedance retries that
// all read reviewAttempts=0 and bump it once each. The first poll claims this lock by storing
// its in-flight Promise here; any concurrent poll awaits the same Promise and observes the
// outcome (didResubmit: true → caller skips its own resubmit and just propagates the new status;
// didResubmit: false → caller carries on to the accept path).
const reviewLocks = new Map<string, Promise<{ didResubmit: boolean }>>();

async function resetOrphanStitchJobs() {
  const snapshot = store.snapshot();
  const legacyOrphans = snapshot.sessions.filter((session) => session.stitchStatus === "running");
  const jobOrphans = snapshot.sessions.flatMap((session) =>
    (session.stitchJobs || [])
      .filter((job) => job.status === "running")
      .map((job) => ({ session, job }))
  );
  if (!legacyOrphans.length && !jobOrphans.length) return;
  console.log(`[stitch] resetting ${legacyOrphans.length + jobOrphans.length} orphan running job(s) from previous process`);
  for (const session of legacyOrphans) {
    await store.updateSession(session.id, {
      stitchStatus: "error",
      stitchError: "Server restarted while stitching; please retry.",
      stitchUpdatedAt: new Date().toISOString(),
      stitchProgress: "",
      stitchRunningSignature: undefined
    });
  }
  for (const { session, job } of jobOrphans) {
    await store.updateStitchJob(session.id, job.id, {
      status: "error",
      error: "Server restarted while stitching; please retry.",
      updatedAt: new Date().toISOString(),
      progress: "",
      runningSignature: undefined
    });
  }
}
async function resetOrphanNarrationJobs() {
  const snapshot = store.snapshot();
  const orphans = snapshot.sessions.filter((session) => session.narrationStatus === "running");
  if (!orphans.length) return;
  console.log(`[narration] resetting ${orphans.length} orphan running job(s) from previous process`);
  for (const session of orphans) {
    await store.updateSession(session.id, {
      narrationStatus: "error",
      narrationError: "Server restarted while generating narration; please retry.",
      narrationUpdatedAt: new Date().toISOString(),
      narrationProgress: "",
      narrationRunningSignature: undefined
    });
  }
}
await resetOrphanStitchJobs();
await resetOrphanNarrationJobs();

app.use(cors());
app.use(express.json({ limit: "25mb" }));
app.use("/media", express.static(path.resolve(process.cwd(), "data", "media")));

/**
 * Liveness check the client polls every ~15s to detect server restart / hang. Fast, allocation-free,
 * and never blocks on the file store. The client uses the response time to decide between "网络抖动"
 * (transient — retry silently) vs "服务端不可达" (banner — tell the user to check the dev server).
 */
app.get("/api/healthz", (_req, res) => {
  res.json({ ok: true, ts: Date.now(), pid: process.pid });
});

app.get("/api/state", (_req, res) => {
  res.json(store.snapshot());
});

function resolveAssetPromptOverride(asset: Asset, explicitOverride?: string) {
  const rawPrompt = (asset.prompt || asset.description || asset.name || "").toString().trim();
  const explicit = explicitOverride?.trim();
  if (explicit) return explicit === rawPrompt ? undefined : explicit;
  const draft = asset.composedPromptDraft?.trim();
  if (!draft) return undefined;
  return draft === rawPrompt ? undefined : draft;
}

app.post("/api/sessions", async (req, res) => {
  res.json(await store.createSession(req.body));
});

app.patch("/api/sessions/:sessionId", async (req, res) => {
  const session = await store.updateSession(req.params.sessionId, req.body);
  if (!session) return res.status(404).json({ error: "Session not found" });
  res.json(session);
});

app.post("/api/sessions/:sessionId/stitch-jobs", async (req, res) => {
  const session = await store.createStitchJob(req.params.sessionId, req.body as Partial<StitchJob>);
  if (!session) return res.status(404).json({ error: "Session not found" });
  res.json(session);
});

app.patch("/api/sessions/:sessionId/stitch-jobs/:jobId", async (req, res) => {
  const session = await store.updateStitchJob(req.params.sessionId, req.params.jobId, req.body as Partial<StitchJob>);
  if (!session) return res.status(404).json({ error: "Stitch job not found" });
  res.json(session);
});

app.delete("/api/sessions/:sessionId/stitch-jobs/:jobId", async (req, res) => {
  const session = await store.deleteStitchJob(req.params.sessionId, req.params.jobId);
  if (!session) return res.status(404).json({ error: "Session not found" });
  res.json(session);
});

app.post("/api/sessions/:sessionId/promote", async (req, res) => {
  const session = await store.promoteSession(req.params.sessionId);
  if (!session) return res.status(404).json({ error: "Session not found" });
  res.json(session);
});

app.delete("/api/sessions/:sessionId", async (req, res) => {
  const deleted = await store.deleteSession(req.params.sessionId);
  if (!deleted) return res.status(404).json({ error: "Session not found" });
  res.json({ ok: true });
});

app.post("/api/assets", async (req, res) => {
  res.json(await store.upsertAsset(req.body));
});

app.patch("/api/assets/:assetId", async (req, res) => {
  const asset = await store.upsertAsset({ ...req.body, id: req.params.assetId });
  if (!asset) return res.status(404).json({ error: "Asset not found" });
  res.json(asset);
});

app.delete("/api/assets/:assetId", async (req, res) => {
  await store.deleteAsset(req.params.assetId);
  res.json({ ok: true });
});

app.post("/api/assets/restore", async (req, res) => {
  const asset = req.body?.asset as Asset | undefined;
  if (!asset?.id) return res.status(400).json({ error: "asset is required" });
  res.json(await store.restoreAsset(asset));
});

app.get("/api/assets/:assetId/download", async (req, res) => {
  const asset = store.snapshot().assets.find((item) => item.id === req.params.assetId);
  if (!asset) return res.status(404).json({ error: "Asset not found" });

  const safeName = `${asset.name || asset.id}`.replace(/[^\w\u4e00-\u9fff.-]+/g, "-").replace(/^-+|-+$/g, "") || asset.id;
  try {
    const candidates = [asset.mediaUrl, asset.imageUrl, asset.referenceImageUrl].filter(Boolean) as string[];
    if (!candidates.length) return res.status(404).json({ error: "Asset has no downloadable media" });
    const downloaded = await downloadAssetMedia(candidates);
    res.type(downloaded.contentType);
    res.attachment(`${safeName}${downloaded.extension}`);
    res.setHeader("Content-Length", String(downloaded.bytes.length));
    return res.send(downloaded.bytes);
  } catch (error) {
    return res.status(502).json({ error: friendlyApiError(error, "Asset download failed") });
  }
});

// Promote a session-scoped asset to a global one (clears ownerSessionId). After this the asset
// is visible to every session and survives deletion of the session that originally created it.
// No-op if the asset is already global. Cannot promote a shot-scoped private sketch — that has
// stricter privacy semantics; user has to make a fresh global asset instead.
app.post("/api/assets/:assetId/review/repair-prompt", async (req, res) => {
  const asset = store.snapshot().assets.find((item) => item.id === req.params.assetId);
  if (!asset) return res.status(404).json({ error: "Asset not found" });
  const failures = parseExistingReviewFailures(asset.reviewNote);
  const reasons = failures.flatMap((failure) => failure.reasons);
  if (!reasons.length) return res.status(400).json({ error: "Asset has no VLM review failures to repair" });
  const rewrite = await rewritePromptWithReviewFeedback({
    originalPrompt: asset.prompt || asset.description || asset.name,
    reviewReasons: reasons.slice(0, 8),
    referenceUrls: [asset.referenceImageUrl, asset.mediaUrl, asset.imageUrl].filter(Boolean) as string[],
    lang: "zh"
  });
  const patch = rewrite.rewritten ? rewrite.prompt : buildFallbackRepairPatch(reasons);
  const plan: VideoReviewRepairPlan = {
    createdAt: new Date().toISOString(),
    sourceReviewScope: "asset",
    sourceNodeId: asset.id,
    targets: [{ kind: "asset", id: asset.id, reason: "图片资产 VLM 自审未通过，需要修复资产 prompt", promptPatch: patch }],
    appliedAt: new Date().toISOString()
  };
  const updated = await store.upsertAsset({
    id: asset.id,
    prompt: appendRepairBlock(asset.prompt || asset.description || asset.name, patch),
    composedPromptDraft: undefined,
    videoReviewRepairPlan: plan
  });
  res.json(updated);
});

app.post("/api/assets/:assetId/promote", async (req, res) => {
  const asset = store.snapshot().assets.find((item) => item.id === req.params.assetId);
  if (!asset) return res.status(404).json({ error: "Asset not found" });
  if (asset.ownerShotId) {
    return res.status(400).json({ error: "Shot-scoped sketch cannot be promoted directly. Create a new global asset from it instead." });
  }
  if (!asset.ownerSessionId) {
    // Already global — return as-is, the client just refreshes.
    return res.json(asset);
  }
  const updated = await store.upsertAsset({ id: asset.id, ownerSessionId: "" });
  res.json(updated);
});

app.post("/api/sessions/:sessionId/assets/:assetId/copy", async (req, res) => {
  const snapshot = store.snapshot();
  const session = snapshot.sessions.find((item) => item.id === req.params.sessionId);
  if (!session) return res.status(404).json({ error: "Session not found" });
  const asset = snapshot.assets.find((item) => item.id === req.params.assetId);
  if (!asset) return res.status(404).json({ error: "Asset not found" });
  if (asset.ownerShotId || asset.ownerSessionId) {
    return res.status(400).json({ error: "Only global assets can be copied into a session." });
  }
  res.json(await store.copyGlobalAssetToSession(asset.id, session.id));
});

/**
 * Reference-video upload + analysis pipeline.
 *
 *   POST /api/assets/upload-video?ownerSessionId=...&filename=foo.mp4
 *     body: raw video bytes (Content-Type: video/* or application/octet-stream)
 *     returns: the new Asset row (mediaKind=video, tags include "reference-video")
 *
 *   POST /api/assets/:assetId/analyze-video
 *     body: { lang?: "zh" | "en" }
 *     runs ffmpeg + vision LLM, persists asset.parsedShots, returns updated asset
 *
 * The two are decoupled so the user can drop a video first (the node appears immediately) then
 * trigger analyze when convenient (or auto-trigger from the client).
 */
const rawVideoUpload = express.raw({
  type: ["video/*", "application/octet-stream"],
  limit: process.env.VIDEO_UPLOAD_LIMIT || "300mb"
});
app.post("/api/assets/upload-video", rawVideoUpload, async (req, res) => {
  const buf = req.body as Buffer | undefined;
  if (!buf || !Buffer.isBuffer(buf) || buf.length === 0) {
    return res.status(400).json({ error: "Empty or non-binary video body. POST raw bytes with Content-Type: video/mp4." });
  }
  const ownerSessionId = typeof req.query.ownerSessionId === "string" ? req.query.ownerSessionId : undefined;
  const filenameHint = typeof req.query.filename === "string" ? req.query.filename : "uploaded-video.mp4";
  const requestedStrategy = typeof req.query.clipStrategy === "string" ? req.query.clipStrategy : undefined;
  const strategy: CondenseStrategy = requestedStrategy === "trim" || requestedStrategy === "speedup"
    ? requestedStrategy
    : "sample-concat";
  const ext = (filenameHint.match(/\.[^.]+$/)?.[0] || ".mp4").toLowerCase();
  const safeStem = `ref-video-${crypto.randomUUID().slice(0, 8)}`;
  const fileName = `${safeStem}${ext}`;
  const localPath = path.resolve(mediaDir, fileName);
  await mkdir(mediaDir, { recursive: true });
  await writeFile(localPath, buf);
  const mediaUrl = `/media/${fileName}`;

  // Best-effort push to TOS so Seedance can later fetch this video as `reference_video`
  // (BytePlus needs a public https URL — local /media won't reach them). When TOS is configured
  // we replace the canonical `mediaUrl` with the public URL and stash the local path in
  // `referenceImageUrl` for the lazy poster route + ffmpeg analyze pipeline. When TOS isn't
  // configured we fall back to local-only and the user gets a clear error if they later try to
  // wire the asset as a Seedance reference video.
  //
  // Before publishing we run condenseForSeedanceR2V — Seedance r2v rejects videos longer than
  // 15.2s OR with frames smaller than 409600 px. The condenser is a no-op when the source
  // already fits; otherwise it applies the chosen strategy (default sample-concat).
  let publishedRemoteUrl: string | undefined;
  let publishedKey: string | undefined;
  let condenseNote: string | undefined;
  let appliedStrategy: CondenseStrategy | "none" = "none";
  let originalDurationSec: number | undefined;
  let clipDurationSec: number | undefined;
  // Probe original up-front so the metadata is available even when TOS isn't configured (UI still
  // wants to show "this is 35s, will clip" guidance).
  try {
    const srcProbe = await probeVideo(localPath);
    originalDurationSec = srcProbe.durationSec;
  } catch (err) {
    console.warn(`[upload-video] probe original failed: ${err instanceof Error ? err.message : err}`);
  }
  if (hasTosConfig()) {
    try {
      let pathToPublish = mediaUrl;
      let condenseHint = safeStem;
      try {
        const condense = await condenseForSeedanceR2V(localPath, { strategy });
        condenseNote = condense.note;
        appliedStrategy = condense.strategy;
        clipDurationSec = condense.publish.durationSec;
        if (condense.condensed) {
          const condensedFile = path.basename(condense.publishPath);
          pathToPublish = `/media/${condensedFile}`;
          condenseHint = `${safeStem}-${condense.strategy}`;
          console.log(`[upload-video] ${condense.note}`);
        }
      } catch (err) {
        console.warn(`[upload-video] condense skipped: ${err instanceof Error ? err.message : err}`);
      }
      const result = await publishLocalMediaToTos(pathToPublish, { keyHint: condenseHint });
      publishedRemoteUrl = result.url;
      publishedKey = result.key;
    } catch (err) {
      console.warn(`[upload-video] TOS publish failed (will keep local-only): ${err instanceof Error ? err.message : err}`);
    }
  }

  const asset = await store.upsertAsset({
    name: filenameHint.replace(/\.[^.]+$/, "").slice(0, 80) || "参考视频",
    type: "other",
    mediaKind: "video",
    description: condenseNote
      ? `用户上传的参考视频，等待解析为分镜表。${condenseNote}`
      : "用户上传的参考视频，等待解析为分镜表",
    prompt: "",
    // Seedance-reachable URL goes into mediaUrl when TOS publish succeeded; the local path
    // is preserved in referenceImageUrl so server-side ffmpeg / poster generation can still find
    // the bytes without re-downloading.
    mediaUrl: publishedRemoteUrl || mediaUrl,
    referenceImageUrl: mediaUrl,
    imageUrl: undefined,
    tags: ["reference-video", "uploaded"],
    ownerSessionId,
    parseStatus: "idle",
    tosObjectKey: publishedKey,
    tosPublishedAt: publishedRemoteUrl ? new Date().toISOString() : undefined,
    clipStrategy: appliedStrategy,
    originalDurationSec,
    clipDurationSec
  });
  res.json(asset);
});

/**
 * Image upload + TOS publish for use as Seedream / Seedance reference image. Mirrors upload-video
 * but skips ffmpeg condensing (irrelevant for stills) and tags the asset as a generic scene
 * reference. Body: raw JPEG/PNG/WEBP bytes. Query: ownerSessionId, filename, name, tags (csv).
 */
const rawImageUpload = express.raw({
  type: ["image/*", "application/octet-stream"],
  limit: process.env.IMAGE_UPLOAD_LIMIT || "30mb"
});
app.post("/api/assets/upload-image", rawImageUpload, async (req, res) => {
  const buf = req.body as Buffer | undefined;
  if (!buf || !Buffer.isBuffer(buf) || buf.length === 0) {
    return res.status(400).json({ error: "Empty or non-binary image body. POST raw bytes with Content-Type: image/jpeg." });
  }
  const ownerSessionId = typeof req.query.ownerSessionId === "string" ? req.query.ownerSessionId : undefined;
  const filenameHint = typeof req.query.filename === "string" ? req.query.filename : "uploaded-image.jpg";
  const nameHint = typeof req.query.name === "string" ? req.query.name : filenameHint.replace(/\.[^.]+$/, "");
  const tagsCsv = typeof req.query.tags === "string" ? req.query.tags : "reference-image,uploaded";
  const tags = tagsCsv.split(",").map((s) => s.trim()).filter(Boolean);
  const ext = (filenameHint.match(/\.[^.]+$/)?.[0] || ".jpg").toLowerCase();
  const safeStem = `ref-image-${crypto.randomUUID().slice(0, 8)}`;
  const fileName = `${safeStem}${ext}`;
  const localPath = path.resolve(mediaDir, fileName);
  await mkdir(mediaDir, { recursive: true });
  await writeFile(localPath, buf);
  const localUrl = `/media/${fileName}`;

  let publishedRemoteUrl: string | undefined;
  let publishedKey: string | undefined;
  if (hasTosConfig()) {
    try {
      const result = await publishLocalMediaToTos(localUrl, { keyHint: safeStem });
      publishedRemoteUrl = result.url;
      publishedKey = result.key;
    } catch (err) {
      console.warn(`[upload-image] TOS publish failed (will keep local-only): ${err instanceof Error ? err.message : err}`);
    }
  }

  const asset = await store.upsertAsset({
    name: nameHint.slice(0, 80),
    type: "scene",
    mediaKind: "image",
    description: "用户上传的参考图片（Seedream/Seedance reference）",
    prompt: "",
    mediaUrl: publishedRemoteUrl || localUrl,
    imageUrl: publishedRemoteUrl || localUrl,
    referenceImageUrl: localUrl,
    tags,
    ownerSessionId,
    tosObjectKey: publishedKey,
    tosPublishedAt: publishedRemoteUrl ? new Date().toISOString() : undefined
  });
  res.json(asset);
});

/**
 * Re-clip an existing reference-video asset under a new condensing strategy. Re-runs ffmpeg on
 * the original local /media/ file (held on referenceImageUrl), publishes the result to TOS, and
 * swaps the asset's mediaUrl + tosObjectKey + clip metadata. The previous TOS object is left in
 * place — harmless leak; cleaning it requires more bookkeeping than it's worth.
 */
app.post("/api/assets/:assetId/reclip", async (req, res) => {
  const asset = store.snapshot().assets.find((a) => a.id === req.params.assetId);
  if (!asset) return res.status(404).json({ error: "Asset not found" });
  if (asset.mediaKind !== "video") {
    return res.status(400).json({ error: "Only reference-video assets can be reclipped." });
  }
  const localOriginal = asset.referenceImageUrl?.startsWith("/media/")
    ? asset.referenceImageUrl
    : asset.mediaUrl?.startsWith("/media/") ? asset.mediaUrl : undefined;
  if (!localOriginal) {
    return res.status(400).json({ error: "Asset has no local /media/ original to reclip from. Re-upload via /upload-video." });
  }
  const reqBody = (req.body as Record<string, unknown>) || {};
  const requested = typeof reqBody.strategy === "string" ? reqBody.strategy : undefined;
  if (requested !== "sample-concat" && requested !== "trim" && requested !== "speedup") {
    return res.status(400).json({ error: "strategy must be one of: sample-concat | trim | speedup" });
  }

  const localPath = path.resolve(mediaDir, localOriginal.slice("/media/".length));
  try {
    const condense = await condenseForSeedanceR2V(localPath, { strategy: requested });
    let publishedRemoteUrl: string | undefined;
    let publishedKey: string | undefined;
    if (hasTosConfig()) {
      const publishUrl = condense.condensed
        ? `/media/${path.basename(condense.publishPath)}`
        : localOriginal;
      const stem = path.basename(localOriginal, path.extname(localOriginal));
      const result = await publishLocalMediaToTos(publishUrl, {
        keyHint: `${stem}-${condense.strategy}`
      });
      publishedRemoteUrl = result.url;
      publishedKey = result.key;
    }
      const processedAt = new Date().toISOString();
      const updated = await store.upsertAsset({
      id: asset.id,
      mediaUrl: publishedRemoteUrl || (condense.condensed ? `/media/${path.basename(condense.publishPath)}` : localOriginal),
      generatedAt: processedAt,
      tosObjectKey: publishedKey,
      tosPublishedAt: publishedRemoteUrl ? processedAt : asset.tosPublishedAt,
      clipStrategy: condense.strategy,
      originalDurationSec: condense.source.durationSec,
      clipDurationSec: condense.publish.durationSec,
      description: condense.note ? `用户上传的参考视频。${condense.note}` : asset.description
    });
    res.json({ asset: updated, note: condense.note });
  } catch (err) {
    res.status(500).json({ error: friendlyApiError(err, "reclip failed") });
  }
});

/**
 * Create a NEW asset that is the clipped derivative of an existing reference-video asset.
 * Unlike `reclip` (which mutates the source asset's mediaUrl in place), this endpoint produces a
 * separate asset with its own id and `derivedFromAssetId` pointing back to the source. The canvas
 * renders the derivative as a `videoProcessor` node downstream of the source. Multiple derivatives
 * of the same source can coexist with different strategies, each independently bindable to shots.
 */
app.post("/api/assets/:assetId/derive-clip", async (req, res) => {
  const source = store.snapshot().assets.find((a) => a.id === req.params.assetId);
  if (!source) return res.status(404).json({ error: "Source asset not found" });
  if (source.mediaKind !== "video") {
    return res.status(400).json({ error: "Only video assets can be derived as clips." });
  }
  const localOriginal = source.referenceImageUrl?.startsWith("/media/")
    ? source.referenceImageUrl
    : source.mediaUrl?.startsWith("/media/") ? source.mediaUrl : undefined;
  if (!localOriginal) {
    return res.status(400).json({ error: "Source asset has no local /media/ original to derive from. Re-upload via /upload-video." });
  }
  const reqBody = (req.body as Record<string, unknown>) || {};
  const requested = typeof reqBody.strategy === "string" ? reqBody.strategy : "trim";
  if (requested !== "sample-concat" && requested !== "trim" && requested !== "speedup") {
    return res.status(400).json({ error: "strategy must be one of: sample-concat | trim | speedup" });
  }

  const localPath = path.resolve(mediaDir, localOriginal.slice("/media/".length));
  try {
    const condense = await condenseForSeedanceR2V(localPath, { strategy: requested });
    // The derivative's "local original" is the condensed file itself — re-derivative isn't a
    // common path, but if a user later runs reclip on the derivative we want it to operate on the
    // condensed bytes, not the great-grandparent source. The derivative's own /media/ path is
    // therefore both mediaUrl (when TOS is off) and referenceImageUrl.
    const derivativeLocalUrl = condense.condensed
      ? `/media/${path.basename(condense.publishPath)}`
      : localOriginal;
    let publishedRemoteUrl: string | undefined;
    let publishedKey: string | undefined;
    if (hasTosConfig()) {
      const stem = path.basename(localOriginal, path.extname(localOriginal));
      const result = await publishLocalMediaToTos(derivativeLocalUrl, {
        keyHint: `${stem}-derived-${condense.strategy}`
      });
      publishedRemoteUrl = result.url;
      publishedKey = result.key;
    }
    const strategyLabel = condense.strategy === "trim" ? "截前 15s"
      : condense.strategy === "speedup" ? "整体加速"
      : condense.strategy === "sample-concat" ? "多段拼接"
      : "无需裁剪";
    const processedAt = new Date().toISOString();
    const derived = await store.upsertAsset({
      name: `${source.name}（${strategyLabel}）`,
      type: "other",
      mediaKind: "video",
      generatedAt: processedAt,
      description: condense.note ? `${source.name} 的衍生剪裁。${condense.note}` : `${source.name} 的衍生剪裁`,
      prompt: "",
      mediaUrl: publishedRemoteUrl || derivativeLocalUrl,
      referenceImageUrl: derivativeLocalUrl,
      imageUrl: undefined,
      tags: ["reference-video", "video-clip", "derived"],
      ownerSessionId: source.ownerSessionId,
      parseStatus: "idle",
      tosObjectKey: publishedKey,
      tosPublishedAt: publishedRemoteUrl ? processedAt : undefined,
      clipStrategy: condense.strategy,
      originalDurationSec: condense.source.durationSec,
      clipDurationSec: condense.publish.durationSec,
      derivedFromAssetId: source.id
    });
    res.json({ asset: derived, note: condense.note });
  } catch (err) {
    res.status(500).json({ error: friendlyApiError(err, "derive-clip failed") });
  }
});

app.post("/api/assets/:assetId/analyze-video", async (req, res) => {
  const asset = store.snapshot().assets.find((a) => a.id === req.params.assetId);
  if (!asset) return res.status(404).json({ error: "Asset not found" });
  // After TOS publish, mediaUrl is a remote URL and the local /media path is held on
  // referenceImageUrl. Fall back gracefully so analysis works in both pre- and post-publish states.
  const localVideoPath = asset.mediaUrl?.startsWith("/media/")
    ? asset.mediaUrl
    : asset.referenceImageUrl?.startsWith("/media/") ? asset.referenceImageUrl : undefined;
  if (!localVideoPath) {
    return res.status(400).json({ error: "Asset has no local /media/ video URL. Re-upload via /upload-video." });
  }

  // Resolve language: prefer body.lang, then owning session's language, then default.
  const reqBody = (req.body as Record<string, unknown>) || {};
  const requestedLang = typeof reqBody.lang === "string" ? reqBody.lang : undefined;
  const owningSession = asset.ownerSessionId ? store.getSession(asset.ownerSessionId) : undefined;
  const lang = requestedLang === "en" || requestedLang === "zh"
    ? requestedLang
    : owningSession?.language === "en" ? "en" : "zh";

  // Mark parsing in-flight so the UI can show a spinner. Use upsertAsset which is the same code
  // path the rest of the app uses (no schema-level write needed).
  await store.upsertAsset({ id: asset.id, parseStatus: "parsing", parseError: undefined });

  try {
    const result = await analyzeReferenceVideo({
      videoPath: localVideoPath,
      lang,
      sampleCount: Number(reqBody.sampleCount) || undefined
    });
    const updated = await store.upsertAsset({
      id: asset.id,
      parsedShots: result.shots,
      parseStatus: "ready",
      parseError: undefined
    });
    res.json({
      asset: updated,
      durationSec: result.durationSec,
      sampledFrames: result.sampledFrames,
      model: result.model
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Video analysis failed";
    const updated = await store.upsertAsset({ id: asset.id, parseStatus: "error", parseError: message });
    res.status(500).json({ error: message, asset: updated });
  }
});

app.post("/api/assets/expand-prompt", async (req, res) => {
  try {
    res.json(await expandAssetPrompt(req.body?.asset || {}));
  } catch (error) {
    res.status(500).json({ error: friendlyApiError(error, "Asset prompt expansion failed") });
  }
});

app.patch("/api/shots/:shotId", async (req, res) => {
  const savedShot = store.getShot(req.params.shotId);
  if (!savedShot) return res.status(404).json({ error: "Shot not found" });
  const patch = normalizeShotPatch(req.body);
  const shot = await store.updateShot(req.params.shotId, normalizeContinuityPatch(savedShot, patch));
  if (!shot) return res.status(404).json({ error: "Shot not found" });
  res.json(shot);
});

app.get("/api/shots/:shotId/download", async (req, res) => {
  const shot = store.getShot(req.params.shotId);
  if (!shot) return res.status(404).json({ error: "Shot not found" });
  if (!shot.videoUrl) return res.status(404).json({ error: "Shot video not ready" });

  const filename = `${sanitizeDownloadName(`${String(shot.index).padStart(2, "0")}-${shot.title || shot.id}`)}.mp4`;
  return sendVideoDownload(res, shot.videoUrl, filename);
});

// Lazy poster (first-frame JPEG) for video nodes. Generated on demand the first time the URL is
// requested, then cached on disk so subsequent renders just stat-and-serve. Cached file is named
// after the video's basename so when a render is regenerated and produces a fresh mp4, the poster
// invalidates by construction (new mp4 → new basename → new poster file).
app.get("/api/shots/:shotId/poster.jpg", async (req, res) => {
  const shot = store.getShot(req.params.shotId);
  const source = resolveShotVideoForRequest(shot, req);
  if (!source) return res.status(404).json({ error: "Shot video not ready" });
  return servePosterJpeg(res, source);
});

// Inline streaming proxy. Browsers want a same-origin URL with proper Range support to play
// `<video>` reliably; remote TOS / Seedance URLs sometimes 403 on expiry, fail CORS preflights, or
// reject Range probes. This route always works because:
//   - local `/media/*.mp4` → res.sendFile (Express handles Range natively)
//   - remote https     → forward Range header upstream and pipe bytes through with status carried
// The route serves the bytes inline (no Content-Disposition: attachment) so `<video>` plays them.
app.get("/api/shots/:shotId/stream.mp4", async (req, res) => {
  const shot = store.getShot(req.params.shotId);
  const source = resolveShotVideoForRequest(shot, req);
  if (!source) return res.status(404).json({ error: "Shot video not ready" });
  return streamVideoInline(req, res, source);
});

app.get("/api/sessions/:sessionId/stream.mp4", async (req, res) => {
  const session = store.getSession(req.params.sessionId);
  if (!session) return res.status(404).json({ error: "Session not found" });
  const jobId = typeof req.query.jobId === "string" ? req.query.jobId : "";
  const job = jobId ? (session.stitchJobs || []).find((item) => item.id === jobId) : undefined;
  const finalVideoUrl = job?.finalVideoUrl || (!jobId ? session.finalVideoUrl : undefined);
  if (!finalVideoUrl) return res.status(404).json({ error: "Final video not ready" });
  return streamVideoInline(req, res, finalVideoUrl);
});

app.get("/api/assets/:assetId/stream.mp4", async (req, res) => {
  const asset = store.snapshot().assets.find((a) => a.id === req.params.assetId);
  if (!asset) return res.status(404).json({ error: "Asset not found" });
  // Reference-video asset: media may live remotely on TOS (mediaUrl) or locally (referenceImageUrl
  // holds the /media path post-publish). Prefer local for speed.
  const source = asset.referenceImageUrl?.startsWith("/media/")
    ? asset.referenceImageUrl
    : asset.mediaUrl || asset.referenceImageUrl;
  if (!source) return res.status(404).json({ error: "Asset has no playable video" });
  return streamVideoInline(req, res, source);
});

app.get("/api/sessions/:sessionId/poster.jpg", async (req, res) => {
  const session = store.getSession(req.params.sessionId);
  if (!session) return res.status(404).json({ error: "Session not found" });
  const jobId = typeof req.query.jobId === "string" ? req.query.jobId : "";
  const job = jobId ? (session.stitchJobs || []).find((item) => item.id === jobId) : undefined;
  const finalVideoUrl = job?.finalVideoUrl || (!jobId ? session.finalVideoUrl : undefined);
  if (!finalVideoUrl) return res.status(404).json({ error: "Final video not ready" });
  return servePosterJpeg(res, finalVideoUrl);
});

// Per-asset video poster: any asset whose mediaUrl points at a video. Used by the reference
// video node thumbnail. Prefers the local /media path (held on referenceImageUrl after the TOS
// publish step) so ffmpeg avoids a network round-trip.
app.get("/api/assets/:assetId/poster.jpg", async (req, res) => {
  const asset = store.snapshot().assets.find((a) => a.id === req.params.assetId);
  if (!asset) return res.status(404).json({ error: "Asset not found" });
  const source = (asset.referenceImageUrl?.startsWith("/media/") ? asset.referenceImageUrl : undefined)
    || (asset.mediaUrl ? asset.mediaUrl : undefined)
    || asset.imageUrl;
  if (!source) return res.status(404).json({ error: "Asset has no media for poster" });
  return servePosterJpeg(res, source);
});

app.delete("/api/shots/:shotId/renders/:renderId", async (req, res) => {
  const shot = await store.deleteShotRender(req.params.shotId, req.params.renderId);
  if (!shot) return res.status(404).json({ error: "Shot not found" });
  res.json(shot);
});

// Promote a historical render back onto the shot: copies its videoUrl + prompt + asset refs
// onto Shot via shotPatchFromRender and reorders renders[] so the restored one is first
// (preserving the "newest render is current" invariant).
app.post("/api/shots/:shotId/renders/:renderId/restore", async (req, res) => {
  try {
    const shot = await store.restoreShotRender(req.params.shotId, req.params.renderId);
    if (!shot) return res.status(404).json({ error: "Shot not found" });
    res.json(shot);
  } catch (err) {
    res.status(400).json({ error: friendlyApiError(err, "Failed to restore render") });
  }
});

// Generate 1+ shot-scoped sketch assets via Seedream and attach them to the shot. The new sketches
// are private to this shot (ownerShotId = shot.id), so they DON'T show up in the global Asset
// Library and DON'T contaminate @mention scanning for other shots. They are also automatically
// cleaned up when the shot (or its session) is deleted.
//
// Body: { prompt?: string, model?: "seedream-4" | "seedream-4-5" | "gpt-image-2", count?: number, name?: string }
app.post("/api/shots/:shotId/sketches", async (req, res) => {
  const shot = store.getShot(req.params.shotId);
  if (!shot) return res.status(404).json({ error: "Shot not found" });

  try {
    const requestedModel = req.body?.model;
    const model: "gpt-image-2" | "seedream-4" | "seedream-4-5" =
      requestedModel === "gpt-image-2"
        ? "gpt-image-2"
        : requestedModel === "seedream-4-5"
          ? "seedream-4-5"
          : "seedream-4";
    const count = Math.max(1, Math.min(6, Number(req.body?.count) || 1));
    const baseName = (req.body?.name || `${shot.title || `Shot ${shot.index}`} 草图`).toString().trim();
    const promptText = (
      req.body?.prompt ||
      shot.rawPrompt ||
      shot.prompt ||
      shot.title ||
      "Storyboard sketch reference image, cinematic still frame."
    )
      .toString()
      .trim();
    const allAssets = store.snapshot().assets;
    const requestedReferenceAssetIds = Array.isArray(req.body?.referenceAssetIds)
      ? req.body.referenceAssetIds.map(String).map((value: string) => value.trim()).filter(Boolean)
      : [];
    const referenceAssetIdSet = new Set(requestedReferenceAssetIds);
    const referenceAssets = requestedReferenceAssetIds.length
      ? allAssets.filter((asset) => referenceAssetIdSet.has(asset.id))
      : allAssets.filter((asset) => (shot.assetIds || []).includes(asset.id) && asset.type === "character");
    const referenceImageUrls = (
      await Promise.all(referenceAssets.map((asset) => materializeImagegenReferenceAsset(asset)))
    ).filter(Boolean) as string[];

    const existingSketchCount = store
      .snapshot()
      .assets.filter((asset) => asset.ownerShotId === shot.id && (asset.tags || []).includes("sketch")).length;

    const session2 = store.getSession(shot.sessionId);
    const lang = resolveLang(session2?.language);

    // Dry-run: return the Seedream prompt the server would assemble for ONE sketch (the prompt is
    // identical for all `count` sketches in this batch except for the asset.name suffix).
    if (req.body?.dryRun === true) {
      const previewAsset = {
        prompt: promptText,
        description: "",
        name: baseName,
        type: "scene" as const
      };
      return res.json(composeSeedreamAssetPrompt(previewAsset, referenceImageUrls.length > 0, lang));
    }

    const userOverride = typeof req.body?.composedPrompt === "string" && req.body.composedPrompt.trim().length > 0
      ? (req.body.composedPrompt as string)
      : undefined;
    const created: Asset[] = [];
    const reviewEnabled = shouldEnableReview(req.body?.visionReview);
    const maxAttempts = clampMaxAttempts(req.body?.maxReviewAttempts);
    for (let i = 0; i < count; i += 1) {
      const ordinal = existingSketchCount + i + 1;
      const indexLabel = `${baseName} #${ordinal}`;
      const placeholder = await store.upsertAsset({
        name: indexLabel,
        type: "scene",
        mediaKind: "image",
        description: `分镜草图（私有，仅供分镜「${shot.title || `Shot ${shot.index}`}」使用，不进入全局资产库）`,
        prompt: promptText,
        tags: ["sketch", "shot-scoped"],
        ownerShotId: shot.id,
        referenceAssetIds: referenceAssets.map((asset) => asset.id),
        referenceImageUrls,
        generationModel: model
      });
      if (!placeholder) continue;
      try {
        let lastComposedPrompt = "";
        const reviewed = await withImageReview({
          enabled: reviewEnabled,
          maxAttempts,
          kind: "sketch",
          prompt: userOverride || promptText,
          referenceUrls: referenceImageUrls,
          lang,
          generate: async (_attempt, rewrittenPrompt) => {
            // On retry, the rewriter may have folded VLM reasons into a fresh prompt — use it as
            // the Seedream `promptOverride` so the regen actually addresses the failures.
            const overrideForThisAttempt = rewrittenPrompt || userOverride;
            const result = await generateAssetImage(placeholder, model, referenceImageUrls, {
              promptOverride: overrideForThisAttempt,
              lang
            });
            lastComposedPrompt = result.composedPrompt;
            return { url: result.url, payload: undefined };
          }
        });
        const generatedAt = new Date().toISOString();
        const updated = await store.upsertAsset({
          id: placeholder.id,
          imageUrl: reviewed.url,
          mediaUrl: reviewed.url,
          mediaKind: "image",
          generatedAt,
          composedPrompt: reviewed.rewrittenPrompt || lastComposedPrompt || undefined,
          reviewNote: reviewed.reviewNote,
          reviewAttempts: reviewed.reviewAttempts,
          reviewModel: reviewed.reviewModel,
          imageReviewStatus: reviewed.imageReview ? "ready" : undefined,
          imageReview: reviewed.imageReview,
          imageReviewError: undefined,
          imageReviewUpdatedAt: reviewed.imageReview?.reviewedAt
        });
        if (updated) created.push(updated);
      } catch (err) {
        // Roll back the placeholder so we don't leave broken/empty sketches around.
        await store.deleteAsset(placeholder.id);
        throw err;
      }
    }

    const refreshed = store.getShot(shot.id) || shot;
    const nextAssetIds = Array.from(new Set([...(refreshed.assetIds || []), ...created.map((a) => a.id)]));
    const finalShot = await store.updateShot(shot.id, { assetIds: nextAssetIds });
    res.json({ shot: finalShot, sketches: created });
  } catch (error) {
    res.status(500).json({ error: friendlyApiError(error, "Sketch generation failed") });
  }
});

app.post("/api/shots/:shotId/sketches/import", async (req, res) => {
  const shot = store.getShot(req.params.shotId);
  if (!shot) return res.status(404).json({ error: "Shot not found" });

  try {
    const promptText = (
      req.body?.prompt ||
      shot.rawPrompt ||
      shot.prompt ||
      shot.title ||
      "Storyboard reference image, cinematic still frame."
    )
      .toString()
      .trim();
    const name = (req.body?.name || `${shot.title || `Shot ${shot.index}`} 草图`).toString().trim();
    const importedUrl = await importStoryboardImage(req.body?.imageDataUrl, req.body?.imageUrl, shot.id, name);
    const publicUrl = toPublicMediaUrl(importedUrl) || importedUrl;
    const canSeedanceUse = isRemoteSeedanceUrl(publicUrl);
    const sketch = await store.upsertAsset({
      name,
      type: "scene",
      mediaKind: "image",
      description: canSeedanceUse
        ? `本地上传的草图（私有，仅供分镜「${shot.title || `Shot ${shot.index}`}」作为 Seedance reference_image）`
        : `本地上传的草图（私有，仅本地预览；配置 PUBLIC_MEDIA_BASE_URL 后才能作为 Seedance reference_image）`,
      prompt: promptText,
      tags: ["sketch", "shot-scoped", "storyboard", "imported"],
      ownerShotId: shot.id,
      referenceImageUrl: importedUrl,
      imageUrl: publicUrl,
      mediaUrl: publicUrl
    });
    if (!sketch) throw new Error("Failed to create imported storyboard asset");

    const refreshed = store.getShot(shot.id) || shot;
    const nextAssetIds = Array.from(new Set([...(refreshed.assetIds || []), sketch.id]));
    const finalShot = await store.updateShot(shot.id, { assetIds: nextAssetIds });
    res.json({ shot: finalShot, sketch });
  } catch (error) {
    res.status(500).json({ error: friendlyApiError(error, "Storyboard import failed") });
  }
});

app.post("/api/shots/:shotId/sketches/publish-tos", async (req, res) => {
  const shot = store.getShot(req.params.shotId);
  if (!shot) return res.status(404).json({ error: "Shot not found" });

  try {
    const sketches = getShotSketchAssets(shot).filter((asset) => !isRemoteSeedanceUrl(asset.mediaUrl || asset.imageUrl));
    const published: Asset[] = [];
    for (const sketch of sketches) {
      const updated = await publishSketchAssetToTos(shot, sketch);
      if (updated) published.push(updated);
    }
    res.json({ shot: store.getShot(shot.id), sketches: published });
  } catch (error) {
    res.status(500).json({ error: friendlyApiError(error, "TOS publish failed") });
  }
});

app.post("/api/shots/:shotId/sketches/:assetId/publish-tos", async (req, res) => {
  const shot = store.getShot(req.params.shotId);
  if (!shot) return res.status(404).json({ error: "Shot not found" });
  const asset = store.snapshot().assets.find((item) => item.id === req.params.assetId);
  if (!asset || asset.ownerShotId !== shot.id || !(asset.tags || []).includes("sketch")) {
    return res.status(404).json({ error: "Sketch asset not found for this shot" });
  }

  try {
    const sketch = await publishSketchAssetToTos(shot, asset);
    res.json({ shot: store.getShot(shot.id), sketch });
  } catch (error) {
    res.status(500).json({ error: friendlyApiError(error, "TOS publish failed") });
  }
});

app.post("/api/sessions/:sessionId/storyboards/publish-tos", async (req, res) => {
  const session = store.getSession(req.params.sessionId);
  if (!session) return res.status(404).json({ error: "Session not found" });

  try {
    const published: Asset[] = [];
    for (const shot of session.shots) {
      const sketches = getShotSketchAssets(shot)
        .filter((asset) => (asset.tags || []).includes("storyboard") || (asset.tags || []).includes("codex-imagegen"))
        .filter((asset) => !isRemoteSeedanceUrl(asset.mediaUrl || asset.imageUrl));
      for (const sketch of sketches) {
        const updated = await publishSketchAssetToTos(shot, sketch);
        if (updated) published.push(updated);
      }
    }
    res.json({ session: store.getSession(session.id), assets: published });
  } catch (error) {
    res.status(500).json({ error: friendlyApiError(error, "TOS publish failed") });
  }
});

// Delete a single shot-scoped sketch asset (validates ownership) and detach it from the shot.
app.delete("/api/shots/:shotId/sketches/:assetId", async (req, res) => {
  const shot = store.getShot(req.params.shotId);
  if (!shot) return res.status(404).json({ error: "Shot not found" });
  const asset = store.snapshot().assets.find((item) => item.id === req.params.assetId);
  if (!asset || asset.ownerShotId !== shot.id) {
    return res.status(404).json({ error: "Sketch asset not found for this shot" });
  }
  const nextAssetIds = (shot.assetIds || []).filter((id) => id !== asset.id);
  await store.updateShot(shot.id, { assetIds: nextAssetIds });
  await store.deleteAsset(asset.id);
  res.json({ ok: true, shot: store.getShot(shot.id) });
});

// Delete an entire shot (cascades to its private sketch assets via store.deleteShot).
app.delete("/api/shots/:shotId", async (req, res) => {
  const deleted = await store.deleteShot(req.params.shotId);
  if (!deleted) return res.status(404).json({ error: "Shot not found" });
  res.json({ ok: true, shotId: deleted.id });
});

app.post("/api/shots/restore", async (req, res) => {
  const shot = req.body?.shot as Shot | undefined;
  const assets = Array.isArray(req.body?.assets) ? (req.body.assets as Asset[]) : [];
  if (!shot?.id) return res.status(400).json({ error: "shot is required" });
  const restored = await store.restoreShot(shot, assets);
  if (!restored?.session) return res.status(404).json({ error: "Session not found" });
  const restoredShot = store.getShot(shot.id);
  if (!restoredShot) return res.status(500).json({ error: "Shot restore failed" });
  res.json({ shot: restoredShot, session: restored.session, assets: restored.assets });
});

// Phase 4 — extract the rendered last frame of a shot's video and persist it as a session-scoped
// image asset. Used to chain shot N+1's first-frame anchor (or sub-storyboard reference) to the
// real motion-end of shot N, eliminating the static-keyframe "freeze at the cut" pattern.
app.post("/api/shots/:shotId/tailframe", async (req, res) => {
  const shot = store.getShot(req.params.shotId);
  if (!shot) return res.status(404).json({ error: "Shot not found" });
  const videoUrl = shot.videoUrl;
  if (!videoUrl) return res.status(400).json({ error: "Shot has no rendered videoUrl" });
  const reqBody = (req.body as Record<string, unknown>) || {};
  const publishToTos = reqBody.publishToTos === true;
  const canvasNode = reqBody.canvasNode === true;
  try {
    let asset = await extractTailFrameAsAsset({
      videoUrl,
      sessionId: shot.sessionId,
      ownerShotId: canvasNode ? undefined : shot.id,
      sourceShotId: shot.id,
      label: `${shot.title || `Shot ${shot.index}`} 尾帧`
    });
    // When publishToTos is true, immediately upload the local /media tailframe to TOS so the
    // returned asset already has an https URL. The downstream caller uses this URL as the next
    // shot's first_frame anchor — Seedance can only fetch https references, not /media paths.
    if (publishToTos) {
      if (!hasTosConfig()) {
        return res.status(400).json({ error: "TOS 配置缺失，无法 publish 尾帧到远端。" });
      }
      const published = await publishAssetImageToTos(asset, shot);
      const updated = await store.upsertAsset({
        id: asset.id,
        mediaUrl: published.url,
        imageUrl: published.url,
        referenceImageUrl: published.localUrl,
        tosObjectKey: published.key,
        tosPublishedAt: new Date().toISOString(),
        generatedAt: asset.generatedAt || new Date().toISOString()
      });
      if (updated) asset = updated;
    }
    res.json({ asset });
  } catch (error) {
    res.status(500).json({ error: friendlyApiError(error, "tailframe extraction failed") });
  }
});

// Append a single shot to an existing session — drives the canvas "新建分镜镜头" flow.
// Body fields are all optional: { title?, durationSec?, rawPrompt?, prompt? }
app.post("/api/sessions/:sessionId/shots", async (req, res) => {
  const reqBody = (req.body as Record<string, unknown>) || {};
  const shot = await store.appendShot(req.params.sessionId, {
    title: typeof reqBody.title === "string" ? reqBody.title : undefined,
    durationSec: typeof reqBody.durationSec === "number" ? reqBody.durationSec : undefined,
    rawPrompt: typeof reqBody.rawPrompt === "string" ? reqBody.rawPrompt : undefined,
    prompt: typeof reqBody.prompt === "string" ? reqBody.prompt : undefined
  });
  if (!shot) return res.status(404).json({ error: "Session not found" });
  res.json({ shot, session: store.getSession(req.params.sessionId) });
});

app.get("/api/sessions/:sessionId/download", async (req, res) => {
  const session = store.getSession(req.params.sessionId);
  if (!session) return res.status(404).json({ error: "Session not found" });
  const jobId = typeof req.query.jobId === "string" ? req.query.jobId : "";
  const job = jobId ? (session.stitchJobs || []).find((item) => item.id === jobId) : undefined;
  const finalVideoUrl = job?.finalVideoUrl || (!jobId ? session.finalVideoUrl : undefined);
  if (!finalVideoUrl) return res.status(404).json({ error: "Final video not ready" });

  const filename = `${sanitizeDownloadName(`${session.title || session.id}-${job?.name || "完整视频"}`)}.mp4`;
  return sendVideoDownload(res, finalVideoUrl, filename);
});

app.post("/api/assets/:assetId/generate", async (req, res) => {
  const allAssets = store.snapshot().assets;
  const asset = allAssets.find((item) => item.id === req.params.assetId);
  if (!asset) return res.status(404).json({ error: "Asset not found" });
  const reqBody = (req.body as Record<string, unknown>) || {};

  try {
    const requestedModel = reqBody.model;
    const model: "gpt-image-2" | "seedream-4" | "seedream-4-5" =
      requestedModel === "gpt-image-2"
        ? "gpt-image-2"
        : requestedModel === "seedream-4"
          ? "seedream-4"
          : "seedream-4-5";
    // Collect explicit reference images only. A previous generated image on this same asset
    // (`imageUrl` / `mediaUrl`) must NOT be fed back as a Seedream `image` by default, otherwise
    // "重新出图" silently becomes image-to-image and can preserve stale identity from an earlier
    // bad generation. Use `referenceImageUrl` for user-uploaded source refs and `parentAssetId` for
    // deliberate derived-character identity locking.
    const referenceImageUrls: string[] = [];
    const referenceAssetIds: string[] = [];
    if (asset.referenceImageUrl) {
      referenceImageUrls.push(asset.referenceImageUrl);
      referenceAssetIds.push(asset.id);
    }
    if (asset.parentAssetId) {
      const parent = allAssets.find((item) => item.id === asset.parentAssetId);
      const parentImage = parent?.referenceImageUrl || parent?.mediaUrl || parent?.imageUrl;
      if (parentImage) {
        referenceImageUrls.push(parentImage);
        referenceAssetIds.push(parent.id);
      }
    }

    // Resolve language: prefer the asset's owning session, fall back to global default.
    const ownerSession = asset.ownerSessionId ? store.getSession(asset.ownerSessionId) : undefined;
    const lang = resolveLang(ownerSession?.language);

    // Dry-run: return the Seedream prompt the server would assemble, without calling Seedream.
    if (reqBody.dryRun === true) {
      return res.json(composeSeedreamAssetPrompt(asset, referenceImageUrls.length > 0, lang));
    }

    const reviewEnabled = shouldEnableReview(reqBody.visionReview as boolean | undefined) && asset.vlmReviewEnabled !== false;
    const maxAttempts = clampMaxAttempts(reqBody.maxReviewAttempts as number | undefined);
    const rawAssetPrompt = (asset.prompt || asset.description || asset.name || "").toString();
    const explicitOverride = typeof reqBody.composedPrompt === "string" ? reqBody.composedPrompt : undefined;
    const userOverride = resolveAssetPromptOverride(asset, explicitOverride);
    const reviewPrompt = userOverride || rawAssetPrompt;

    let lastComposedPrompt = "";
    const reviewed = await withImageReview({
      enabled: reviewEnabled,
      maxAttempts,
      kind: "asset",
      prompt: reviewPrompt,
      referenceUrls: [
        asset.referenceImageUrl,
        ...(asset.parentAssetId
          ? (() => {
              const parent = allAssets.find((item) => item.id === asset.parentAssetId);
              return [parent?.referenceImageUrl || parent?.mediaUrl || parent?.imageUrl];
            })()
          : [])
      ].filter(Boolean) as string[],
      lang,
      generate: async (_attempt, rewrittenPrompt) => {
        const overrideForThisAttempt = rewrittenPrompt || userOverride;
        const result = await generateAssetImage(asset, model, referenceImageUrls, {
          promptOverride: overrideForThisAttempt,
          lang
        });
        lastComposedPrompt = result.composedPrompt;
        return { url: result.url, payload: result };
      }
    });
    const generatedAt = new Date().toISOString();
    res.json(
      await store.upsertAsset({
        id: asset.id,
        imageUrl: reviewed.url,
        mediaUrl: reviewed.url,
        mediaKind: "image",
        generatedAt,
        composedPrompt: reviewed.rewrittenPrompt || lastComposedPrompt || undefined,
        reviewNote: reviewed.reviewNote,
        reviewAttempts: reviewed.reviewAttempts,
        reviewModel: reviewed.reviewModel,
        generationModel: reviewed.payload?.model || model,
        referenceImageUrls,
        referenceAssetIds,
        imageReviewStatus: reviewed.imageReview ? "ready" : undefined,
        imageReview: reviewed.imageReview,
        imageReviewError: undefined,
        imageReviewUpdatedAt: reviewed.imageReview?.reviewedAt
      })
    );
  } catch (error) {
    res.status(500).json({ error: friendlyApiError(error, "Asset generation failed") });
  }
});

app.post("/api/assets/:assetId/review", async (req, res) => {
  const allAssets = store.snapshot().assets;
  const asset = allAssets.find((item) => item.id === req.params.assetId);
  if (!asset) return res.status(404).json({ error: "Asset not found" });
  const productUrl = asset.mediaUrl || asset.imageUrl || asset.referenceImageUrl;
  if (!productUrl) return res.status(400).json({ error: "Asset has no image to review" });
  const runningAt = new Date().toISOString();
  await store.upsertAsset({
    id: asset.id,
    imageReviewStatus: "running",
    imageReviewError: undefined,
    imageReviewUpdatedAt: runningAt
  });
  try {
    const referenceUrls = [
      asset.referenceImageUrl,
      ...(asset.parentAssetId
        ? (() => {
            const parent = allAssets.find((item) => item.id === asset.parentAssetId);
            return [parent?.referenceImageUrl || parent?.mediaUrl || parent?.imageUrl];
          })()
        : [])
    ].filter((url): url is string => Boolean(url && url !== productUrl));
    const verdict = await reviewImageDetailed({
      kind: asset.ownerShotId ? "sketch" : "asset",
      prompt: (asset.composedPromptDraft || asset.composedPrompt || asset.prompt || asset.description || asset.name || "").toString(),
      productUrl,
      referenceUrls
    });
    return res.json(await store.upsertAsset({
      id: asset.id,
      imageReviewStatus: "ready",
      imageReview: verdict,
      imageReviewError: undefined,
      imageReviewUpdatedAt: verdict.reviewedAt,
      reviewModel: verdict.model
    }));
  } catch (error) {
    const message = friendlyApiError(error, "VLM image review failed");
    const failedAt = new Date().toISOString();
    return res.status(500).json(await store.upsertAsset({
      id: asset.id,
      imageReviewStatus: "error",
      imageReviewError: message,
      imageReviewUpdatedAt: failedAt
    }));
  }
});

app.post("/api/sessions/:sessionId/script/generate", async (req, res) => {
  const session = store.getSession(req.params.sessionId);
  if (!session) return res.status(404).json({ error: "Session not found" });

  try {
    const story = await generateStoryPlan(session, store.snapshot().assets);
    res.json(await store.updateSession(session.id, { story }));
  } catch (error) {
    res.status(500).json({ error: friendlyApiError(error, "Script generation failed") });
  }
});

app.patch("/api/sessions/:sessionId/script", async (req, res) => {
  const session = store.getSession(req.params.sessionId);
  if (!session) return res.status(404).json({ error: "Session not found" });

  res.json(await store.updateSession(session.id, { story: normalizeStoryPatch(req.body?.story || req.body) }));
});

app.post("/api/sessions/:sessionId/cast", async (req, res) => {
  const session = store.getSession(req.params.sessionId);
  if (!session) return res.status(404).json({ error: "Session not found" });

  try {
    const allAssets = store.snapshot().assets;
    const requested = parseCastRequest(req.body?.characters);
    const sourceCharacters = resolveCastSourceCharacters(session);
    const inferred = requested.length ? requested : sourceCharacters;
    const candidates = await normalizeOrInferCastCandidates(session, inferred);
    if (!candidates.length) {
      return res.status(400).json({
        error: "未检测到可用角色。请先保存剧本并在剧本角色中补充主角，或在请求 body 传入 characters。"
      });
    }

    const updatedCharacters: StoryCharacter[] = [];
    const castAssets: Asset[] = [];
    const seen = new Set<string>();
    const currentStory = session.story || {
      premise: session.logline || "",
      synopsis: "",
      theme: "",
      tone: session.style || "",
      characters: [],
      beats: [],
      locked: false
    };

    const castJobs = candidates
      .map((candidate) => {
        const normalizedName = normalizeMentionText(candidate.name);
        if (!normalizedName || seen.has(normalizedName)) return undefined;
        seen.add(normalizedName);

        const sourceCharacter = (currentStory.characters || []).find(
          (item) => normalizeMentionText(item.name) === normalizedName || normalizeMentionText(item.assetMention || "") === normalizedName
        );

        const sourceRole = sourceCharacter?.role?.trim() || candidate.role?.trim() || "";
        const sourceArc = sourceCharacter?.arc?.trim() || candidate.arc?.trim() || "";
        const sourceAssetId = sourceCharacter?.assetId?.trim() || candidate.assetId?.trim();
        const sourceAssetMention = sourceCharacter?.assetMention?.trim();
        const existingAsset = findExistingCastAsset(
          {
            name: candidate.name,
            role: sourceRole,
            arc: sourceArc,
            assetId: sourceAssetId,
            assetMention: sourceAssetMention
          },
          allAssets,
          session.id
        );

        return { candidate, existingAsset, sourceRole, sourceArc };
      })
      .filter((item): item is { candidate: CastCandidate; existingAsset: Asset | undefined; sourceRole: string; sourceArc: string } => Boolean(item));

    const generatedCast = await mapWithConcurrency(castJobs, 3, async ({ candidate, existingAsset, sourceRole, sourceArc }) => {
      const preparedAsset = existingAsset
        ? await touchCastAssetPrompt(existingAsset, candidate, session)
        : await createCastAsset(candidate.name, sourceRole, sourceArc, session.id);
      const generated = await generateCastAssetImage(preparedAsset, session, candidate);
      return { generated, character: {
        name: candidate.name,
        role: sourceRole,
        arc: sourceArc,
        assetId: generated.id,
        assetMention: `@${formatAssetMention(generated.name)}`
      } };
    });
    generatedCast.forEach(({ generated, character }) => {
      castAssets.push(generated);
      updatedCharacters.push(character);
    });

    const updatedStory = buildStoryWithCastCharacters(currentStory, updatedCharacters);
    const nextSession = await store.updateSession(session.id, { story: updatedStory });
    if (!nextSession) return res.status(500).json({ error: "Session update failed" });
    res.json({ session: nextSession, assets: castAssets });
  } catch (error) {
    res.status(500).json({ error: friendlyApiError(error, "Cast generation failed") });
  }
});

function sanitizeDownloadName(value: string) {
  return value
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .slice(0, 80) || "shot-video";
}

/**
 * Split a multi-frame storyboard-grid prompt into per-frame fragments so each panel can be
 * VLM-reviewed against its own frame description rather than the whole batch prompt. Recognizes
 * "Frame N", "帧 N", and "第 N 帧" markers (case-insensitive). When a marker is missing or the
 * fragment count doesn't match the expected panelCount, falls back to the full prompt for the
 * missing slots — that's still better than reviewing every panel against the whole text.
 */
function splitPromptByFrames(prompt: string, panelCount: number): string[] {
  const fallback = new Array<string>(panelCount).fill(prompt);
  if (panelCount <= 0 || !prompt) return fallback;
  // Match "Frame 1", "Frame 2", ... or "帧 1", or "第 1 帧" — capture the index and the body up to
  // the next marker (or end of string).
  const markerRe = /(Frame\s*(\d+)|帧\s*(\d+)|第\s*(\d+)\s*帧)\s*[:：]?\s*/gi;
  const hits: Array<{ index: number; start: number; bodyStart: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = markerRe.exec(prompt)) !== null) {
    const idx = Number(m[2] || m[3] || m[4]);
    if (Number.isFinite(idx) && idx >= 1 && idx <= panelCount) {
      hits.push({ index: idx, start: m.index, bodyStart: m.index + m[0].length });
    }
  }
  if (hits.length === 0) return fallback;
  // Sort by start, then capture each body up to the next hit's start.
  hits.sort((a, b) => a.start - b.start);
  const preface = prompt.slice(0, hits[0].start).trim();
  const result = [...fallback];
  for (let i = 0; i < hits.length; i += 1) {
    const cur = hits[i];
    const next = hits[i + 1];
    const body = prompt.slice(cur.bodyStart, next ? next.start : prompt.length).trim();
    const slot = cur.index - 1;
    if (slot < 0 || slot >= panelCount) continue;
    result[slot] = preface ? `${preface}\n\nFrame ${cur.index}: ${body}` : `Frame ${cur.index}: ${body}`;
  }
  return result;
}

/**
 * Split a single scenePrompt into per-beat fragments for sequential sub-storyboard mode.
 * Recognizes Beat A/B/C... markers, "节拍 1/2/3", and the existing Frame N markers. The preface
 * (everything before the first beat marker) is duplicated to each beat so shared scene/character
 * setup is preserved per panel.
 */
function splitScenePromptIntoBeats(prompt: string, panelCount: number): string[] {
  const result = new Array<string>(panelCount).fill(prompt);
  if (!prompt || panelCount <= 0) return result;
  // Beat A/B/C/D, beat 1/2/3, 节拍 1/2/3, Frame 1/2/3 — all valid markers.
  const markerRe = /(Beat\s*([A-Z])|[Bb]eat\s*(\d+)|beat\s*([A-Z])|节拍\s*(\d+)|Frame\s*(\d+)|帧\s*(\d+)|第\s*(\d+)\s*[帧拍])\s*[:：]?\s*/g;
  const hits: Array<{ slot: number; start: number; bodyStart: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = markerRe.exec(prompt)) !== null) {
    let slot = -1;
    if (m[2]) slot = m[2].charCodeAt(0) - "A".charCodeAt(0);
    else if (m[4]) slot = m[4].charCodeAt(0) - "A".charCodeAt(0);
    else if (m[3]) slot = Number(m[3]) - 1;
    else if (m[5]) slot = Number(m[5]) - 1;
    else if (m[6]) slot = Number(m[6]) - 1;
    else if (m[7]) slot = Number(m[7]) - 1;
    else if (m[8]) slot = Number(m[8]) - 1;
    if (slot >= 0 && slot < panelCount) {
      hits.push({ slot, start: m.index, bodyStart: m.index + m[0].length });
    }
  }
  if (hits.length === 0) return result;
  hits.sort((a, b) => a.start - b.start);
  const preface = prompt.slice(0, hits[0].start).trim();
  for (let i = 0; i < hits.length; i += 1) {
    const cur = hits[i];
    const next = hits[i + 1];
    const body = prompt.slice(cur.bodyStart, next ? next.start : prompt.length).trim();
    const composed = preface ? `${preface}\n\n${body}` : body;
    if (composed) result[cur.slot] = composed;
  }
  return result;
}

/**
 * Phase 4 helper — extract the last frame of a video and persist it as a session-scoped image
 * asset so it can be wired as the next shot's first-frame anchor (or as a sub-storyboard
 * reference image). Avoids the static-keyframe "freeze at the cut" problem by treating the
 * actual rendered tail as the next shot's starting state.
 *
 * Returns the persisted Asset on success.
 */
async function extractTailFrameAsAsset(opts: {
  videoUrl: string;
  sessionId: string;
  ownerShotId?: string;
  sourceShotId?: string;
  label: string;
}): Promise<Asset> {
  const { videoUrl, sessionId, ownerShotId, sourceShotId, label } = opts;
  if (!videoUrl) throw new Error("extractTailFrameAsAsset: videoUrl required");
  await mkdir(MEDIA_DIR, { recursive: true });

  // Resolve a local file path: /media/foo.mp4 → MEDIA_DIR/foo.mp4; http(s) → let ffmpeg fetch
  // it directly (it speaks HTTP/HTTPS natively). The previous Node-side fetch+writeFile path
  // had a silent-failure mode where the buffer wrote 0 bytes for some Seedance TOS URLs and
  // ffmpeg then "succeeded" producing nothing, leaving an asset row with a missing file.
  let inputPath: string;
  if (videoUrl.startsWith("/media/")) {
    inputPath = path.join(MEDIA_DIR, videoUrl.replace(/^\/media\//, ""));
  } else if (/^https?:\/\//.test(videoUrl)) {
    inputPath = videoUrl;
  } else {
    throw new Error(`tailframe: unsupported videoUrl scheme: ${videoUrl}`);
  }

  const outName = `tailframe-${sanitizeFilePart(ownerShotId || sessionId)}-${Date.now()}.jpg`;
  const outPath = path.join(MEDIA_DIR, outName);
  // The bundled @ffmpeg-installer/ffmpeg (v4.x) does not support negative `-sseof` on remote
  // HTTP(S) inputs — it silently produces a 0-byte output. Probe the duration with ffprobe and
  // use a positive `-ss` near-end seek instead (ffmpeg HTTP supports forward Range requests
  // reliably). For local /media/* inputs we can keep `-sseof` (it's cheaper) but the duration-
  // based path also works there, so we use a single code path for simplicity.
  const probedDuration = await probeMediaDurationSec(inputPath).catch(() => undefined);
  const seekSec = Math.max(0, (Number(probedDuration) || 0) - 0.1);
  await runFfmpegCommand([
    "-y",
    "-ss",
    seekSec.toFixed(3),
    "-i",
    inputPath,
    "-frames:v",
    "1",
    "-q:v",
    "2",
    "-update",
    "1",
    outPath
  ]);
  // Sanity check: prior implementation could leave a stale asset row pointing to a missing
  // file when ffmpeg "succeeded" against a 0-byte download. Verify the output before persisting.
  const fsPromises = await import("node:fs/promises");
  const outInfo = await fsPromises.stat(outPath).catch(() => undefined);
  if (!outInfo || !outInfo.isFile() || outInfo.size <= 0) {
    throw new Error(`tailframe: ffmpeg produced no output for ${videoUrl}`);
  }
  const localUrl = `/media/${outName}`;
  const asset = await store.upsertAsset({
    name: label,
    type: "scene",
    mediaKind: "image",
    description: `自动从 ${sourceShotId || ownerShotId || sessionId} 的渲染产物抽取的尾帧，用于下一镜首帧/参考。`,
    tags: ["tailframe", "frame-anchor", ...(sourceShotId ? [`source-shot:${sourceShotId}`] : [])],
    ownerSessionId: sessionId,
    ownerShotId,
    mediaUrl: localUrl,
    imageUrl: localUrl,
    generatedAt: new Date().toISOString()
  });
  if (!asset) throw new Error("tailframe: failed to persist asset");
  return asset;
}


function getShotSketchAssets(shot: Shot) {
  return store
    .snapshot()
    .assets.filter((asset) => asset.ownerShotId === shot.id && (asset.tags || []).includes("sketch") && (asset.mediaKind || "image") === "image");
}

async function publishSketchAssetToTos(shot: Shot, asset: Asset) {
  const published = await publishAssetImageToTos(asset, shot);
  const tags = Array.from(new Set([...(asset.tags || []), "tos-published"]));
  const description = asset.description?.includes("TOS")
    ? asset.description
    : `${asset.description || "分镜草图"}（已发布到 TOS，可作为 Seedance reference_image）`;
  const updated = await store.upsertAsset({
    id: asset.id,
    mediaKind: "image",
    mediaUrl: published.url,
    imageUrl: published.url,
    referenceImageUrl: published.localUrl,
    tosObjectKey: published.key || asset.tosObjectKey,
    tosPublishedAt: new Date().toISOString(),
    tags,
    description
  });
  if (!updated) throw new Error("Failed to update TOS-published sketch asset");
  return updated;
}

async function importStoryboardImage(imageDataUrl: unknown, imageUrl: unknown, shotId: string, name: string) {
  const urlValue = typeof imageUrl === "string" ? imageUrl.trim() : "";
  if (urlValue) {
    if (/^https?:\/\//.test(urlValue) || urlValue.startsWith("/media/")) return urlValue;
    throw new Error("imageUrl must be http(s) or /media/ URL");
  }

  const dataUrl = typeof imageDataUrl === "string" ? imageDataUrl.trim() : "";
  const match = dataUrl.match(/^data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=]+)$/);
  if (!match) throw new Error("imageDataUrl must be a png, jpeg, or webp data URL");
  const ext = match[1] === "jpeg" || match[1] === "jpg" ? "jpg" : match[1];
  const bytes = Buffer.from(match[2], "base64");
  if (!bytes.length) throw new Error("imageDataUrl is empty");
  await mkdir(storyboardMediaDir, { recursive: true });
  const fileName = `${sanitizeFilePart(`${shotId}-${name}`)}-${Date.now()}.${ext}`;
  await writeFile(path.join(storyboardMediaDir, fileName), bytes);
  return `/media/codex-storyboards/${fileName}`;
}

function toPublicMediaUrl(url: string) {
  if (!url.startsWith("/media/")) return url;
  const publicBase = process.env.PUBLIC_MEDIA_BASE_URL || process.env.MEDIA_PUBLIC_BASE_URL || process.env.APP_PUBLIC_URL;
  if (!publicBase) return undefined;
  const base = publicBase.replace(/\/$/, "");
  return `${base}${url}`;
}

function isRemoteSeedanceUrl(url: string | undefined) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return ["http:", "https:"].includes(parsed.protocol) && !["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * Resolve the source shot's video URL for cross-shot `reference_video` wiring (the
 * `referenceVideoFromShotId` field). Walks the shot's renders for the latest one with a
 * `remoteVideoUrl` (the TOS https url Seedance can fetch directly), and falls back to the shot's
 * own `videoUrl` only when that's a public https. Returns `undefined` when no usable https URL
 * exists — caller should surface an error so the user re-renders or publishes the source.
 */
function resolveShotReferenceVideoUrl(sourceShot: Shot | undefined): string | undefined {
  if (!sourceShot) return undefined;
  const renderRemote = (sourceShot.renders || [])
    .find((r) => r.remoteVideoUrl && isRemoteSeedanceUrl(r.remoteVideoUrl))?.remoteVideoUrl;
  if (renderRemote) return renderRemote;
  if (isRemoteSeedanceUrl(sourceShot.videoUrl)) return sourceShot.videoUrl;
  return undefined;
}

function sanitizeFilePart(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 80) || "storyboard";
}

function normalizeShotPatch(body: Partial<Shot>) {
  const patch = { ...body };
  const clearable: Array<keyof Shot> = [
    "error",
    "generationTaskId",
    "generationStartedAt",
    "referenceClipUrl",
    "referenceAudioUrl",
    "referenceClipPreviewUrl",
    "referenceAudioPreviewUrl",
    "firstFrameAssetId",
    "lastFrameAssetId",
    "subShotStoryboardAssetId",
    "referenceVideoAssetId",
    "referenceVideoFromShotId"
  ];
  clearable.forEach((field) => {
    if (patch[field] === null) {
      patch[field] = undefined as never;
    }
  });
  if (patch.error === "") patch.error = undefined;
  // Allow the UI to clear first/last-frame asset by sending "".
  if (patch.firstFrameAssetId === "") patch.firstFrameAssetId = undefined;
  if (patch.lastFrameAssetId === "") patch.lastFrameAssetId = undefined;
  if (patch.subShotStoryboardAssetId === "") patch.subShotStoryboardAssetId = undefined;
  if (patch.referenceVideoAssetId === "") patch.referenceVideoAssetId = undefined;
  if (patch.referenceVideoFromShotId === "") patch.referenceVideoFromShotId = undefined;
  return patch;
}

function normalizeContinuityPatch(savedShot: Shot, patch: Partial<Shot>) {
  const usePreviousShotClip = patch.usePreviousShotClip ?? savedShot.usePreviousShotClip;
  const firstFrameAssetId = patch.firstFrameAssetId ?? savedShot.firstFrameAssetId;
  if (!usePreviousShotClip || firstFrameAssetId) return patch;

  const session = store.getSession(savedShot.sessionId);
  const previousShot = session?.shots.find((item) => item.index === savedShot.index - 1);
  const selectedPreviousRender = previousShot ? findSelectedRender(previousShot) : undefined;
  const maxDurationSec = getReferenceDurationSec(previousShot, selectedPreviousRender);
  return {
    ...patch,
    previousShotClipSec: clampPreviousShotClipSec(
      (patch.previousShotClipSecOverride ?? (patch.usePreviousShotClip === true ? false : savedShot.previousShotClipSecOverride))
        ? patch.previousShotClipSec ?? savedShot.previousShotClipSec
        : undefined,
      maxDurationSec
    ),
    previousShotClipSecOverride: Boolean(
      patch.previousShotClipSecOverride ?? (patch.usePreviousShotClip === true ? false : savedShot.previousShotClipSecOverride)
    )
  };
}

function normalizeStoryPatch(story: Partial<StoryPlan>): StoryPlan {
  return {
    premise: story.premise?.trim() || "",
    synopsis: story.synopsis?.trim() || "",
    theme: story.theme?.trim() || "",
    tone: story.tone?.trim() || "",
    characters: Array.isArray(story.characters)
      ? story.characters.map((character) => ({
          name: character.name?.trim() || "",
          role: character.role?.trim() || "",
          arc: character.arc?.trim() || "",
          assetId: character.assetId?.trim() || undefined,
          assetMention: character.assetMention?.trim() || undefined
        }))
      : [],
    beats: Array.isArray(story.beats)
      ? story.beats.map((beat, index) => ({
          index: Number(beat.index) || index + 1,
          title: beat.title?.trim() || `Beat ${index + 1}`,
          purpose: beat.purpose?.trim() || "",
          plot: beat.plot?.trim() || "",
          emotion: beat.emotion?.trim() || "",
          visual: beat.visual?.trim() || "",
          assetMentions: Array.isArray(beat.assetMentions)
            ? beat.assetMentions.map(String).map((value) => value.trim()).filter(Boolean)
            : [],
          durationSec: Math.min(Math.max(Number(beat.durationSec) || 1, 1), 15)
        }))
      : [],
  locked: Boolean(story.locked),
  updatedAt: new Date().toISOString(),
  model: story.model
  };
}

type CastCandidate = {
  name: string;
  role?: string;
  arc?: string;
  assetId?: string;
  assetMention?: string;
};

function parseCastRequest(value: unknown): CastCandidate[] {
  if (!value) return [];
  const items = Array.isArray(value) ? value : [value];
  return items
    .map((item): CastCandidate[] => {
      if (typeof item === "string") {
        return String(item)
          .split(/[，,、\n;；]/)
          .map((name) => ({ name: name.trim() }))
          .filter((item) => item.name);
      }
      if (typeof item !== "object" || item === null) return [];
      const typed = item as {
        name?: string;
        role?: string;
        arc?: string;
        assetId?: string;
        assetMention?: string;
      };
      return typed.name ? [
        {
          name: typed.name,
          role: typed.role?.trim(),
          arc: typed.arc?.trim(),
          assetId: typed.assetId?.trim(),
          assetMention: typed.assetMention?.trim()
        }
      ] : [];
    })
    .flat()
    .map((item) => ({
      name: item.name.trim(),
      role: item.role?.trim(),
      arc: item.arc?.trim(),
      assetId: item.assetId?.trim(),
      assetMention: normalizeCastAlias(item.assetMention)
    }))
    .filter((item) => item.name);
}

function resolveCastSourceCharacters(session: Session): CastCandidate[] {
  if (!session.story?.characters?.length) return [];
  return session.story.characters
    .map((item) => ({
      name: item.name?.trim() || "",
      role: item.role?.trim(),
      arc: item.arc?.trim(),
      assetId: item.assetId?.trim(),
      assetMention: normalizeCastAlias(item.assetMention)
    }))
    .filter((item) => item.name);
}

function normalizeCastAlias(value?: string) {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.replace(/^@/, "") : undefined;
}

function dedupeCastCandidates(values: CastCandidate[]) {
  const seen = new Set<string>();
  return values.filter((item) => {
    const key = normalizeMentionText(item.name);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function normalizeOrInferCastCandidates(session: Session, source: CastCandidate[]) {
  const fromRequest = dedupeCastCandidates(source);
  if (fromRequest.length) return fromRequest.slice(0, 6);

  const inferred = await inferCastCandidatesFromSession(session);
  return dedupeCastCandidates(inferred).slice(0, 6);
}

async function inferCastCandidatesFromSession(session: Session): Promise<CastCandidate[]> {
  const apiKey = process.env.OAI_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) return [];

  const model = process.env.OPENAI_TEXT_MODEL || "gpt-4.1-mini";
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      input: [
        {
          role: "system",
          content:
            "你是短片拍摄选角助手。请只返回 JSON，不要 Markdown。只识别故事的核心主角/主要人物，不要超过 6 个。"
        },
        {
          role: "user",
          content: JSON.stringify({
            title: session.title,
            logline: session.logline,
            style: session.style,
            story: session.story || {},
            notes: "优先输出清晰唯一的人名。角色名建议保持中文名。"
          })
        }
      ],
      text: { format: { type: "json_object" } },
      max_output_tokens: 1200
    })
  });

  if (!response.ok) return [];
  const data = (await response.json()) as { output_text?: string; output?: Array<{ content?: Array<{ text?: string }> }> };
  const text = data.output_text || data.output?.flatMap((item) => item.content ?? []).map((item) => item.text).join("");
  if (!text) return [];

  try {
    const parsed = JSON.parse(text) as { characters?: Array<{ name?: string; role?: string; arc?: string }> };
    if (!Array.isArray(parsed.characters)) return [];
    return dedupeCastCandidates(
      parsed.characters
        .map((item) => ({
          name: String(item.name || "").trim(),
          role: String(item.role || "").trim(),
          arc: String(item.arc || "").trim()
        }))
        .filter((item) => item.name)
    );
  } catch {
    return [];
  }
}

function isCastAssetVisibleToSession(asset: Asset, sessionId: string) {
  if (asset.ownerShotId) return false;
  if (asset.ownerSessionId && asset.ownerSessionId !== sessionId) return false;
  return true;
}

function findExistingCastAsset(candidate: CastCandidate, allAssets: Asset[], sessionId: string): Asset | undefined {
  const byId = candidate.assetId ? allAssets.find((asset) => asset.id === candidate.assetId) : undefined;
  if (byId && isCastAssetVisibleToSession(byId, sessionId) && byId.type === "character") return byId;

  const canMatch = (asset: Asset) => {
    const explicit = Boolean(candidate.assetId) && asset.id === candidate.assetId;
    const sessionScoped = Boolean(asset.ownerSessionId) && asset.ownerSessionId === sessionId;
    const castTagged = (asset.tags || []).includes("cast");
    return asset.type === "character" && (explicit || sessionScoped || castTagged);
  };

  const name = normalizeMentionText(candidate.name);
  const mention = normalizeMentionText(candidate.assetMention || candidate.name);
  return (
    allAssets.find(
      (asset) =>
        isCastAssetVisibleToSession(asset, sessionId) &&
        canMatch(asset) &&
        (normalizeMentionText(asset.name) === mention ||
          normalizeMentionText(asset.name) === name)
    ) ||
    allAssets.find(
      (asset) =>
        isCastAssetVisibleToSession(asset, sessionId) &&
        canMatch(asset) &&
        normalizeMentionText(asset.name) === mention
    )
  );
}

function buildCastPrompt(name: string, role = "", arc = "", session?: Session) {
  return [
    `角色名：${name}`,
    role ? `角色身份：${role}` : "",
    arc ? `角色弧光：${arc}` : "",
    session?.style ? `场景风格：${session.style}` : "",
    "电影级角色一致性设定图，适用于多镜头连续参考。",
    "要求保持稳定的人脸轮廓、五官比例、发色与肤色，风格统一，禁用夸张滤镜。",
    "画面干净、无文字，无水印，无附加角色。"
  ]
    .filter(Boolean)
    .join("\n");
}

async function createCastAsset(
  name: string,
  role: string,
  arc: string,
  sessionId: string
): Promise<Asset> {
  const prompt = buildCastPrompt(name, role, arc);
  const description = `【选角资产】${name}，用于跨分镜人物一致性。
${role ? `角色身份：${role}` : ""}
${arc ? `角色弧光：${arc}` : ""}`.trim();
  return (
    (await store.upsertAsset({
      name,
      type: "character",
      mediaKind: "image",
      description,
      prompt,
      tags: ["cast", "auto-cast", "gpt-image-2"],
      ownerSessionId: sessionId
    })) as Asset
  );
}

async function touchCastAssetPrompt(asset: Asset, candidate: CastCandidate, session: Session): Promise<Asset> {
  const prompt = buildCastPrompt(candidate.name, candidate.role || "", candidate.arc || "", session);
  const description = `【选角资产】${candidate.name}，用于跨分镜人物一致性。`;
  return (
    (await store.upsertAsset({
      id: asset.id,
      name: candidate.name,
      type: "character",
      prompt,
      description,
      tags: Array.from(new Set([...(asset.tags || []), "cast", "auto-cast", "gpt-image-2"])),
      ownerSessionId: session.id
    })) as Asset
  );
}

async function generateCastAssetImage(asset: Asset, session: Session, candidate: CastCandidate): Promise<Asset> {
  const preparedAsset = await touchCastAssetPrompt(
    asset,
    {
      name: candidate.name || asset.name,
      role: candidate.role || "",
      arc: candidate.arc || "",
      assetMention: candidate.assetMention
    },
    session
  );
  const generated = await generateAssetImage(preparedAsset, "gpt-image-2", []);
  return (
    (await store.upsertAsset({
      id: preparedAsset.id,
      imageUrl: generated.url,
      mediaUrl: generated.url,
      mediaKind: "image",
      generatedAt: new Date().toISOString()
    })) as Asset
  );
}

function buildStoryWithCastCharacters(currentStory: StoryPlan, cast: StoryCharacter[]) {
  const castSet = new Set<string>();
  const merged: StoryCharacter[] = [];
  for (const candidate of cast) {
    const normalized = normalizeMentionText(candidate.name);
    if (!normalized) continue;
    castSet.add(normalized);
    merged.push(candidate);
  }
  for (const character of currentStory.characters) {
    if (castSet.has(normalizeMentionText(character.name))) continue;
    merged.push(character);
  }
  return {
    ...currentStory,
    characters: merged,
    updatedAt: new Date().toISOString()
  };
}

function getSessionCastAssets(session: Session | undefined, allAssets: Asset[]) {
  if (!session?.story?.characters?.length) return [];
  const assets: Asset[] = [];
  const seen = new Set<string>();
  for (const character of session.story.characters) {
    if (!character.name) continue;
    if (!character.assetId && !character.assetMention) continue;
    const match = findExistingCastAsset(
      {
        name: character.name,
        role: character.role,
        arc: character.arc,
        assetId: character.assetId,
        assetMention: normalizeCastAlias(character.assetMention)
      },
      allAssets,
      session.id
    );
    if (!match || seen.has(match.id)) continue;
    if (!isCastAssetVisibleToSession(match, session.id)) continue;
    seen.add(match.id);
    assets.push(match);
  }
  return assets;
}

function mergeAssetsById(lists: Asset[][]) {
  const merged: Asset[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    for (const asset of list) {
      if (seen.has(asset.id)) continue;
      seen.add(asset.id);
      merged.push(asset);
    }
  }
  return merged;
}

function orderedSubStoryboardAssetIds(shot: Pick<Shot, "subShotStoryboardAssetId" | "subShotStoryboardAssetIds">) {
  const ids = shot.subShotStoryboardAssetIds?.length
    ? shot.subShotStoryboardAssetIds
    : (shot.subShotStoryboardAssetId ? [shot.subShotStoryboardAssetId] : []);
  return Array.from(new Set(ids.filter(Boolean)));
}

function resolveSubStoryboardAssets(shot: Pick<Shot, "subShotStoryboardAssetId" | "subShotStoryboardAssetIds">, allAssets: Asset[]) {
  return orderedSubStoryboardAssetIds(shot)
    .map((id) => allAssets.find((asset) => asset.id === id))
    .filter((asset): asset is Asset => Boolean(asset));
}

function getSessionCastMentions(session: Session | undefined) {
  if (!session?.story?.characters?.length) return [];
  const mentions: string[] = [];
  const seen = new Set<string>();
  for (const character of session.story.characters) {
    const raw = character.assetMention || character.name;
    const mention = normalizeCastAlias(raw);
    if (!mention) continue;
    const formatted = formatAssetMention(mention);
    const key = normalizeMentionText(formatted);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    mentions.push(`@${formatted}`);
  }
  return mentions;
}

function appendMissingCastMentions(prompt: string | undefined, mentions: string[]) {
  const text = (prompt || "").trim();
  if (!mentions.length) return text;
  const normalizedPrompt = normalizeMentionText(text);
  const missing = mentions.filter((mention) => !normalizedPrompt.includes(normalizeMentionText(mention)));
  if (!missing.length) return text;
  const suffix = `\n连续角色参考：${missing.join("、")}。每个出现的镜头都必须保持同一张脸、体型、发型、服装主色和标志性表情，不得换人。`;
  return text ? `${text}${suffix}` : suffix.trim();
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<R>) {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, Math.floor(concurrency)), items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await worker(items[index], index);
      }
    })
  );
  return results;
}

function mergeIds(base: string[] = [], extra: string[] = []) {
  const seen = new Set<string>(base.filter(Boolean));
  const ids = [...base.filter(Boolean)];
  for (const item of extra) {
    if (!item || seen.has(item)) continue;
    seen.add(item);
    ids.push(item);
  }
  return ids;
}

function normalizeMentionText(value: string) {
  return value.toLowerCase().replace(/\s+/g, "").replace(/／/g, "/").replace(/^@/, "").trim();
}

function formatAssetMention(value: string) {
  return value.replace(/\s*\/\s*/g, "/").replace(/\s+/g, "");
}

function assetMentionAliases(asset: Asset) {
  return [asset.name, ...(asset.tags ?? [])]
    .map((value) => normalizeMentionText(value))
    .filter(Boolean);
}

function storyboardReferenceUrl(asset: Asset) {
  return asset.mediaUrl || asset.imageUrl || asset.referenceImageUrl;
}

function storyboardReferenceLabel(asset: Asset) {
  const typeZh: Record<string, string> = { character: "角色", scene: "场景", prop: "道具", style: "风格" };
  const type = typeZh[asset.type] || asset.type;
  return asset.name ? `${asset.name}（${type}）` : `${type}`;
}

function resolveSubStoryboardReferenceAssets({
  shot,
  allAssets,
  explicitIds,
  textSources
}: {
  shot: Shot;
  allAssets: Asset[];
  explicitIds: string[];
  textSources: string[];
}) {
  const isVisible = (asset: Asset) => {
    if (asset.ownerShotId && asset.ownerShotId !== shot.id) return false;
    if (asset.ownerSessionId && asset.ownerSessionId !== shot.sessionId) return false;
    return true;
  };
  const visibleAssetsAll = allAssets.filter(isVisible);
  const byId = new Map(visibleAssetsAll.map((asset) => [asset.id, asset]));
  const sessionAliases = new Set(
    visibleAssetsAll
      .filter((asset) => asset.ownerSessionId === shot.sessionId)
      .flatMap((asset) => assetMentionAliases(asset))
  );
  const mentionAssets = sessionAliases.size
    ? visibleAssetsAll.filter((asset) => asset.ownerSessionId || !assetMentionAliases(asset).some((alias) => sessionAliases.has(alias)))
    : visibleAssetsAll;
  const ordered: Asset[] = [];
  const seen = new Set<string>();
  const add = (asset: Asset | undefined) => {
    if (!asset || seen.has(asset.id)) return;
    seen.add(asset.id);
    ordered.push(asset);
  };

  explicitIds.forEach((id) => add(byId.get(id)));

  const normalizedText = normalizeMentionText(textSources.filter(Boolean).join("\n"));
  if (normalizedText) {
    mentionAssets.forEach((asset) => {
      if (seen.has(asset.id)) return;
      const aliases = assetMentionAliases(asset);
      if (aliases.some((alias) => normalizedText.includes(`@${alias}`))) add(asset);
    });
  }

  if (ordered.length === 0) {
    (shot.assetIds || []).forEach((id) => {
      const asset = byId.get(id);
      if (asset?.type === "character") add(asset);
    });
  }

  const referenceImageUrls: string[] = [];
  const referenceImageLabels: string[] = [];
  const skippedReferences: Array<{ assetId: string; name: string; reason: string; url?: string }> = [];

  ordered.forEach((asset) => {
    const url = storyboardReferenceUrl(asset);
    if (typeof url === "string" && /^https?:\/\//.test(url)) {
      referenceImageUrls.push(url);
      referenceImageLabels.push(storyboardReferenceLabel(asset));
      return;
    }
    skippedReferences.push({
      assetId: asset.id,
      name: asset.name,
      reason: url ? "local_or_non_http_reference_not_sent_to_seedream" : "missing_image_url",
      url
    });
  });

  return {
    referenceAssetIds: ordered.map((asset) => asset.id),
    referenceImageUrls,
    referenceImageLabels,
    skippedReferences
  };
}

function isRemoteWebUrl(url?: string | null) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return ["http:", "https:"].includes(parsed.protocol) && !["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

function resolveShotVideoForRequest(shot: Shot | undefined, req: Request) {
  if (!shot) return undefined;
  const version = typeof req.query.v === "string" ? req.query.v : undefined;
  if (version) {
    const render = (shot.renders || []).find((item) => item.id === version);
    if (render?.videoUrl) return render.videoUrl;
    if (render?.remoteVideoUrl) return render.remoteVideoUrl;
  }
  return shot.videoUrl;
}

/**
 * Inline streaming for `<video>` elements. Same idea as sendVideoDownload but no `attachment` —
 * the browser plays inline. Forwards the client's `Range` header upstream so seeking works on
 * remote sources. Local /media paths short-circuit to res.sendFile (Express does Range natively).
 *
 * Increases robustness vs. plain `<video src=remoteTosUrl>`:
 *   - Same-origin URL → no CORS preflight surprises, no third-party cookie issues
 *   - We can re-resolve / refresh upstream URL server-side later if it expires
 *   - 4xx/5xx from upstream propagates as the user sees, not as a silent black box
 */
async function streamVideoInline(req: Request, res: Response, videoUrl: string) {
  const localMediaPath = resolveLocalMediaPath(videoUrl);
  if (localMediaPath) {
    res.type("video/mp4");
    res.setHeader("Cache-Control", "no-cache");
    return res.sendFile(localMediaPath);
  }
  if (!/^https?:\/\//.test(videoUrl)) {
    return res.status(404).json({ error: "Unsupported video URL" });
  }

  const upstreamHeaders: Record<string, string> = {};
  const range = req.headers.range;
  if (typeof range === "string" && range.length) upstreamHeaders.Range = range;

  try {
    const upstream = await fetch(videoUrl, { headers: upstreamHeaders });
    if (!upstream.ok && upstream.status !== 206 && upstream.status !== 200) {
      const body = await upstream.text().catch(() => "");
      return res.status(upstream.status === 0 ? 502 : upstream.status).json({
        error: `Upstream video fetch failed: ${upstream.status} ${upstream.statusText}${body ? ` — ${body.slice(0, 200)}` : ""}`
      });
    }
    if (!upstream.body) return res.status(502).json({ error: "Upstream returned no body" });

    res.status(upstream.status);
    res.type(upstream.headers.get("content-type") || "video/mp4");
    res.setHeader("Accept-Ranges", "bytes");
    const length = upstream.headers.get("content-length");
    if (length) res.setHeader("Content-Length", length);
    const contentRange = upstream.headers.get("content-range");
    if (contentRange) res.setHeader("Content-Range", contentRange);
    res.setHeader("Cache-Control", "no-cache");
    return Readable.fromWeb(upstream.body as unknown as WebReadableStream<Uint8Array>).pipe(res);
  } catch (error) {
    return res.status(502).json({ error: friendlyApiError(error, "Upstream stream error") });
  }
}

async function sendVideoDownload(res: Response, videoUrl: string, filename: string) {
  const localMediaPath = resolveLocalMediaPath(videoUrl);
  if (localMediaPath) return res.download(localMediaPath, filename);

  try {
    const upstream = await fetch(videoUrl);
    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: `Video download failed: ${upstream.statusText}` });
    }
    if (!upstream.body) return res.status(502).json({ error: "Video download returned no body" });

    res.type(upstream.headers.get("content-type") || "video/mp4");
    res.attachment(filename);
    const length = upstream.headers.get("content-length");
    if (length) res.setHeader("Content-Length", length);
    return Readable.fromWeb(upstream.body as unknown as WebReadableStream<Uint8Array>).pipe(res);
  } catch (error) {
    if (res.headersSent) return res.destroy(error instanceof Error ? error : undefined);
    return res.status(500).json({ error: friendlyApiError(error, "Video download failed") });
  }
}

/**
 * Lazy poster image: extracts a single first-frame JPEG from a video and serves it. Cached to
 * disk after the first generation; subsequent calls stat-and-serve. The cache key is derived
 * from the video URL's basename (e.g. `shot-render-render_xyz.mp4` → `poster-render_xyz.jpg`),
 * so a fresh render automatically produces a fresh cache entry without needing manual eviction.
 */
function posterCacheStem(videoUrl: string) {
  const localPath = resolveLocalMediaPath(videoUrl);
  if (localPath) {
    return path.basename(localPath).replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9._-]/g, "_");
  }
  if (/^https?:\/\//.test(videoUrl)) {
    const parsed = new URL(videoUrl);
    const basename = path.basename(parsed.pathname).replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9._-]/g, "_") || "remote-video";
    const digest = createHash("sha1").update(videoUrl).digest("hex").slice(0, 12);
    return `${basename}-${digest}`;
  }
  return `poster-${createHash("sha1").update(videoUrl).digest("hex").slice(0, 12)}`;
}

async function servePosterJpeg(res: Response, videoUrl: string) {
  const stem = posterCacheStem(videoUrl);
  const cachePath = path.resolve(mediaDir, `poster-${stem}.jpg`);

  // Fast path: cached on disk.
  try {
    const stat = await import("node:fs/promises").then((fs) => fs.stat(cachePath));
    if (stat.isFile() && stat.size > 0) {
      res.type("image/jpeg");
      res.setHeader("Cache-Control", "public, max-age=86400");
      return res.sendFile(cachePath);
    }
  } catch {
    /* fall through to generate */
  }

  // Slow path: run ffmpeg. Source can be a local /media/ path or a remote https URL — ffmpeg
  // handles both. Seek 0.5s to skip a potential black first frame; cap output at 480px wide.
  const inputArg = resolveLocalMediaPath(videoUrl) || (/^https?:\/\//.test(videoUrl) ? videoUrl : "");
  if (!inputArg) return res.status(404).json({ error: "Unsupported video URL for poster" });

  await mkdir(mediaDir, { recursive: true });
  try {
    const { runFfmpegCommand } = await import("./generators");
    await runFfmpegCommand([
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-ss",
      "0.5",
      "-i",
      inputArg,
      "-frames:v",
      "1",
      "-q:v",
      "4",
      "-vf",
      "scale='min(480,iw)':-2",
      cachePath
    ]);
    res.type("image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=86400");
    return res.sendFile(cachePath);
  } catch (error) {
    return res.status(500).json({ error: friendlyApiError(error, "Poster generation failed") });
  }
}

async function materializeImagegenReferenceAsset(asset: Asset) {
  const sourceUrl = asset.mediaUrl || asset.imageUrl || asset.referenceImageUrl;
  if (!sourceUrl) return undefined;
  if (sourceUrl.startsWith("/media/") || sourceUrl.startsWith("data:image/")) return sourceUrl;
  if (!/^https?:\/\//.test(sourceUrl)) return undefined;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45_000);
  try {
    const response = await fetch(sourceUrl, { signal: controller.signal });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get("content-type") || "";
    const ext = contentType.includes("png") ? ".png" : contentType.includes("webp") ? ".webp" : ".jpg";
    const safeAssetId = asset.id.replace(/[^\w.-]+/g, "-");
    const dir = path.join(MEDIA_DIR, "imagegen-ref-cache");
    await mkdir(dir, { recursive: true });
    const fileName = `${safeAssetId}-${Date.now()}${ext}`;
    await writeFile(path.join(dir, fileName), bytes);
    return `/media/imagegen-ref-cache/${fileName}`;
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown error";
    throw new Error(`Failed to download imagegen reference asset "${asset.name}" (${asset.id}): ${reason}`);
  } finally {
    clearTimeout(timer);
  }
}

async function downloadAssetMedia(urls: string[]) {
  const errors: string[] = [];
  for (const url of urls) {
    try {
      if (url.startsWith("/media/")) {
        const localPath = resolveLocalMediaPath(url);
        if (!localPath) throw new Error("Invalid local media path");
        const bytes = await readFile(localPath);
        if (!bytes.length) throw new Error("Downloaded file is empty");
        return {
          bytes,
          contentType: contentTypeFromPath(localPath),
          extension: extensionFromContentType(contentTypeFromPath(localPath))
        };
      }
      if (!/^https?:\/\//.test(url)) throw new Error("Unsupported media URL");

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 90_000);
      try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        const bytes = Buffer.from(await response.arrayBuffer());
        if (!bytes.length) throw new Error("Downloaded file is empty");
        const contentType = normalizeDownloadContentType(response.headers.get("content-type") || "", url);
        return { bytes, contentType, extension: extensionFromContentType(contentType) };
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown error";
      errors.push(`${url.slice(0, 120)}: ${reason}`);
    }
  }
  throw new Error(`Asset download failed. Tried ${urls.length} source(s): ${errors.join("; ")}`);
}

function normalizeDownloadContentType(contentType: string, url: string) {
  const clean = contentType.split(";")[0].trim().toLowerCase();
  if (clean.startsWith("image/") || clean.startsWith("video/")) return clean;
  return contentTypeFromPath(url);
}

function contentTypeFromPath(value: string) {
  const lower = value.split("?")[0].toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".mp4")) return "video/mp4";
  if (lower.endsWith(".mov")) return "video/quicktime";
  if (lower.endsWith(".webm")) return "video/webm";
  return "image/jpeg";
}

function extensionFromContentType(contentType: string) {
  if (contentType.includes("png")) return ".png";
  if (contentType.includes("webp")) return ".webp";
  if (contentType.includes("gif")) return ".gif";
  if (contentType.includes("mp4")) return ".mp4";
  if (contentType.includes("quicktime")) return ".mov";
  if (contentType.includes("webm")) return ".webm";
  return ".jpg";
}

function resolveLocalMediaPath(videoUrl: string) {
  let pathname = "";
  if (videoUrl.startsWith("/media/")) {
    pathname = videoUrl;
  } else {
    try {
      const parsed = new URL(videoUrl);
      if (["localhost", "127.0.0.1"].includes(parsed.hostname) && parsed.pathname.startsWith("/media/")) {
        pathname = parsed.pathname;
      }
    } catch {
      return null;
    }
  }

  const mediaRoot = path.resolve(process.cwd(), "data", "media");
  const mediaFile = decodeURIComponent(pathname).replace(/^\/media\/?/, "");
  const candidate = path.resolve(mediaRoot, mediaFile);
  return candidate.startsWith(`${mediaRoot}${path.sep}`) ? candidate : null;
}

app.post("/api/sessions/:sessionId/storyboard", async (req, res) => {
  const session = store.getSession(req.params.sessionId);
  if (!session) return res.status(404).json({ error: "Session not found" });

  const assets = store.snapshot().assets;
  const plannedShots = await generateStoryboard(session, assets);
  const updated = [];

  const castMentions = getSessionCastMentions(session);

  for (const shot of session.shots) {
    const planned = plannedShots.find((item) => item.index === shot.index) || plannedShots[shot.index - 1];
    if (!planned) continue;
    const rawPrompt = appendMissingCastMentions(planned.rawPrompt || planned.prompt || shot.rawPrompt, castMentions);
    const prompt = appendMissingCastMentions(planned.prompt || shot.prompt || rawPrompt, castMentions);
    const updatedShot = await store.updateShot(shot.id, {
      title: planned.title || shot.title,
      storyBeatIndex: planned.storyBeatIndex ?? shot.storyBeatIndex,
      script: planned.script || shot.script,
      camera: planned.camera || shot.camera,
      durationSec: planned.durationSec || shot.durationSec,
      rawPrompt,
      prompt,
      status: "scripted"
    });
    if (updatedShot) updated.push(updatedShot);
  }

  res.json({ session: store.getSession(session.id), shots: updated });
});

// Storyboard-grid workflow (ai-flow.net pattern): generate N stylistically-consistent panels in
// one Seedream group call, materialize them as session-scoped assets, and (optionally) bind them
// as first/last frame anchors to the session's shots so each shot becomes a Seedance first/last
// frame I2V (frame i → frame i+1 = shot i).
//
// Body: {
//   prompt: string,                 // shared style + per-frame description, see ai-flow 6-field per-shot prompt
//   panelCount?: number,            // default = session.shots.length + 1
//   size?: string,                  // Seedream size, default env SEEDREAM_SIZE or "4K"
//   assignToShots?: boolean         // default true; binds frame[i]/frame[i+1] to shot[i] first/last
// }
app.post("/api/sessions/:sessionId/storyboard-grid", async (req, res) => {
  const session = store.getSession(req.params.sessionId);
  if (!session) return res.status(404).json({ error: "Session not found" });

  const sortedShots = (session.shots || []).slice().sort((a, b) => a.index - b.index);
  const requestedCount = Number((req.body as Record<string, unknown>)?.panelCount);
  const panelCount = Number.isFinite(requestedCount) && requestedCount > 0
    ? Math.max(2, Math.min(10, Math.floor(requestedCount)))
    : sortedShots.length + 1;
  const promptText = String((req.body as Record<string, unknown>)?.prompt || "").trim();
  if (!promptText) return res.status(400).json({ error: "prompt is required" });
  const assignToShots = (req.body as Record<string, unknown>)?.assignToShots !== false;
  const size = (req.body as Record<string, unknown>)?.size as string | undefined;
  const refsRaw = (req.body as Record<string, unknown>)?.referenceImageUrls;
  const referenceImageUrls = Array.isArray(refsRaw)
    ? (refsRaw as unknown[]).map(String).filter((s) => /^https?:\/\//.test(s))
    : [];

  try {
    const result = await generateStoryboardGrid({ prompt: promptText, panelCount, size, referenceImageUrls });
    const created: Asset[] = [];
    for (let i = 0; i < result.panels.length; i += 1) {
      const panel = result.panels[i];
      const placeholder = await store.upsertAsset({
        name: `${session.title || session.id} 故事板 #${i + 1}`,
        type: "scene",
        mediaKind: "image",
        description: `Storyboard grid panel ${i + 1}/${result.panels.length} (${result.model})`,
        prompt: promptText,
        tags: ["storyboard-grid", "frame-anchor"],
        ownerSessionId: session.id,
        mediaUrl: panel.url,
        imageUrl: panel.url,
        generatedAt: new Date().toISOString(),
        generationModel: "seedream-4-5"
      });
      if (placeholder) created.push(placeholder);
    }

    // Phase 1 — VLM closed-loop review of each generated panel against its per-frame prompt.
    // Storyboard grids routinely violate spatial constraints ("missile must be outside the
    // window") because Seedream group generation has no per-panel grounding. We re-review each
    // panel with the centralized image VLM and, on failure, regenerate that single panel via
    // single-image Seedream with the other panels as style/character references and the failure
    // reasons appended to the prompt. Capped at 3 attempts/panel.
    const reviewEnabled = shouldEnableReview(
      ((req.body as Record<string, unknown>)?.visionReview as boolean | undefined)
    );
    const perPanelMaxAttempts = clampMaxAttempts(
      Number((req.body as Record<string, unknown>)?.reviewMaxAttempts) || 3
    );
    const perPanelPrompts = splitPromptByFrames(promptText, created.length);
    if (reviewEnabled && created.length > 0) {
      for (let i = 0; i < created.length; i += 1) {
        const panel = created[i];
        const panelPrompt = perPanelPrompts[i] || promptText;
        const otherUrls = created
          .filter((p, j) => j !== i)
          .map((p) => p.mediaUrl || p.imageUrl)
          .filter((u): u is string => typeof u === "string" && /^https?:\/\//.test(u))
          .slice(0, 2);
        const failures: Array<{ attempt: number; reasons: string[] }> = [];
        let model: string | undefined;
        for (let attempt = 1; attempt <= perPanelMaxAttempts; attempt += 1) {
          const productUrl = panel.mediaUrl || panel.imageUrl;
          if (!productUrl) break;
          const verdict = await reviewImage({
            kind: "asset",
            prompt: panelPrompt,
            productUrl,
            referenceUrls: otherUrls
          });
          model = verdict.model;
          if (verdict.ok) {
            if (failures.length) {
              await store.upsertAsset({
                id: panel.id,
                description: `${panel.description || ""}（VLM 通过 ${attempt}/${perPanelMaxAttempts}，前 ${failures.length} 轮被打回）`
              });
            }
            break;
          }
          failures.push({ attempt, reasons: verdict.reasons.length ? verdict.reasons : ["(no reasons returned)"] });
          console.warn(
            `[storyboard-grid:review] panel ${i + 1}/${created.length} attempt ${attempt}/${perPanelMaxAttempts} failed: ${verdict.reasons.join("; ")}`
          );
          if (attempt >= perPanelMaxAttempts) break;
          // Ask the rewriter LLM to fold the VLM reasons into a fresh prompt, rather than blindly
          // appending them. The rewriter knows to delete/replace the original phrasing that
          // produced the failure (instead of leaving the broken text in place under a "but fix
          // these" footer that Seedream then half-honors).
          const rewrite = await rewritePromptWithReviewFeedback({
            originalPrompt: panelPrompt,
            reviewReasons: verdict.reasons,
            referenceUrls: otherUrls,
            failedProductUrl: panel.mediaUrl || panel.imageUrl,
            lang: "zh"
          });
          const refinedPrompt = rewrite.rewritten ? rewrite.prompt : [
            panelPrompt.trim(),
            "",
            "上一版生成被 VLM 判定不通过，原因：",
            ...verdict.reasons.map((r) => `- ${r}`),
            "",
            "请按以上反馈修正这一帧；保持与参考图相同的人物面孔/服装/办公室场景/机位构图，仅修正不一致点。"
          ].join("\n");
          if (rewrite.rewritten) {
            console.warn(
              `[storyboard-grid:review] rewriter produced a new prompt (model=${rewrite.model}); panel ${i + 1} retry will use it`
            );
          } else if (rewrite.note) {
            console.warn(`[storyboard-grid:review] rewriter skipped: ${rewrite.note}`);
          }
          try {
            const fresh = await generateAssetImage(panel, "seedream-4-5", otherUrls, {
              promptOverride: refinedPrompt,
              lang: "zh"
            });
            const updated = await store.upsertAsset({
              id: panel.id,
              mediaUrl: fresh.url,
              imageUrl: fresh.url,
              generatedAt: new Date().toISOString()
            });
            if (updated) {
              panel.mediaUrl = updated.mediaUrl;
              panel.imageUrl = updated.imageUrl;
            }
          } catch (regenError) {
            console.warn(
              `[storyboard-grid:review] regen failed for panel ${i + 1}: ${
                regenError instanceof Error ? regenError.message : regenError
              }`
            );
            break;
          }
        }
        if (failures.length) {
          // Persist the review trail on the panel asset so the user can audit in the web UI.
          await store.upsertAsset({
            id: panel.id,
            description: [panel.description || "", `VLM 复检：${formatReviewNote(failures, false)}`]
              .filter(Boolean)
              .join("\n")
          });
        }
        if (model) {
          // touch generationModel field — leave existing, just note review model in description above
        }
      }
    }

    let assignments: Array<{ shotId: string; patch: Partial<Shot> }> = [];
    if (assignToShots && created.length >= 2) {
      assignments = buildShotFrameAssignments({ shots: sortedShots, panelAssets: created });
      for (const { shotId, patch } of assignments) {
        await store.updateShot(shotId, patch);
      }
    }

    res.json({
      session: store.getSession(session.id),
      panels: created,
      model: result.model,
      usage: result.rawUsage,
      assignments: assignments.map(({ shotId, patch }) => ({
        shotId,
        firstFrameAssetId: patch.firstFrameAssetId,
        lastFrameAssetId: patch.lastFrameAssetId
      }))
    });
  } catch (error) {
    res.status(500).json({ error: friendlyApiError(error, "Storyboard grid generation failed") });
  }
});

// Sub-shot storyboard mode (EvoLink GPT-Image-2 / Seedance 2.0 community technique). Generates a
// single composite grid image of N keyframe panels for a single shot, persists it as a
// shot-scoped reference asset, and binds it to the shot so the next /shots/:id/generate call
// drives Seedance with the storyboard-sequence instruction (one Seedance call → one video that
// internally cuts through the N panels in order).
//
// Body: {
//   scenePrompt: string,         // free-text scene description (subject, arc, style, character)
//   panelCount?: number,         // default 6, clamped 2-16
//   layout?: string              // e.g. "3x3", "4x3"; auto-picked from panelCount when omitted
//   size?: string                // Seedream size, default env SEEDREAM_SIZE or "4K"
// }
app.post("/api/shots/:shotId/sub-storyboard", async (req, res) => {
  const shot = store.getShot(req.params.shotId);
  if (!shot) return res.status(404).json({ error: "Shot not found" });
  const reqBody = (req.body as Record<string, unknown>) || {};

  const requestedPanels = Number(reqBody.panelCount);
  const panelCount = Number.isFinite(requestedPanels) && requestedPanels > 0
    ? Math.max(2, Math.min(16, Math.floor(requestedPanels)))
    : 6;
  const scenePrompt = String(reqBody.scenePrompt || "").trim();
  if (!scenePrompt) return res.status(400).json({ error: "scenePrompt is required" });
  const layout = reqBody.layout as string | undefined;
  const size = (typeof reqBody.panelSize === "string" ? reqBody.panelSize : reqBody.size) as string | undefined;
  const composedPromptOverride = typeof reqBody.composedPrompt === "string"
    ? (reqBody.composedPrompt as string).trim()
    : "";

  const panelPromptTexts = Array.isArray(reqBody.panels)
    ? (reqBody.panels as unknown[]).map((p) => {
        if (typeof p === "string") return p;
        if (typeof p === "object" && p !== null && typeof (p as Record<string, unknown>).prompt === "string") {
          return (p as Record<string, unknown>).prompt as string;
        }
        return "";
      }).filter((text) => text.trim().length > 0)
    : [];

  // Resolve reference asset IDs → image URLs + labels for cross-shot character consistency.
  // Sources, in priority order:
  //   1. body.referenceAssetIds: explicit pins from the checkbox UI
  //   2. @mentions in scenePrompt / composedPrompt / sequential panel prompts
  //   3. legacy fallback: shot.assetIds intersected with character assets
  // The materialized URLs go into Seedream's `image:` field; labels get baked into the prompt as
  // `image_1: <name>` so the model can bind identity per character.
  const allAssets = store.snapshot().assets;
  const resolvedStoryboardRefs = resolveSubStoryboardReferenceAssets({
    shot,
    allAssets,
    explicitIds: Array.isArray(reqBody.referenceAssetIds)
      ? (reqBody.referenceAssetIds as unknown[]).map((v) => String(v).trim()).filter(Boolean)
      : [],
    textSources: [scenePrompt, composedPromptOverride, ...panelPromptTexts]
  });
  const requestedRefIds = resolvedStoryboardRefs.referenceAssetIds;
  const referenceImageUrls = resolvedStoryboardRefs.referenceImageUrls;
  const referenceImageLabels = resolvedStoryboardRefs.referenceImageLabels;
  const skippedReferences = resolvedStoryboardRefs.skippedReferences;

  try {
    const session = store.getSession(shot.sessionId);
    const lang = resolveLang(session?.language);

    // Dry-run: return the Seedream prompt the server would assemble, without calling Seedream.
    // This is the audit hook — the user can read every word the auto-composer added, edit if
    // needed, and then re-POST with `composedPrompt` body.
    if (reqBody.dryRun === true) {
      const layoutResolved = (layout || "").trim();
      const layoutFinal = layoutResolved || (panelCount <= 4 ? "2x2" : panelCount <= 6 ? "3x2" : panelCount <= 8 ? "4x2" : panelCount === 9 ? "3x3" : panelCount <= 12 ? "4x3" : "4x4");
      const preview = composeSeedreamSubStoryboardGrid(
        scenePrompt,
        panelCount,
        layoutFinal,
        lang,
        referenceImageLabels.map((label, i) => ({ imageNumber: i + 1, label }))
      );
      return res.json({
        ...preview,
        referenceImageUrls,
        referenceAssetIds: requestedRefIds,
        skippedReferences
      });
    }

    // Pull the requested model variant out of the body. We only accept the two known seedream
    // variants here; gpt-image-2 lives in a separate code path and is not legal for storyboards.
    const requestedModel = reqBody.model;
    const modelVariant: SubStoryboardModel | undefined =
      requestedModel === "seedream-4" ? "seedream-4"
      : requestedModel === "seedream-4-5" ? "seedream-4-5"
      : (shot.subStoryboardModel as SubStoryboardModel | undefined);

    // ----- Mode dispatch -----
    // "composite" (default) — single Seedream group call returns ONE composite image with N
    //   panels laid out in a grid. Fast, cheaper, but Seedream chooses which cell holds which
    //   beat → time order is a soft constraint and panels often shuffle.
    // "sequential" — one Seedream call per panel, each conditioning on the previous panel,
    //   then ffmpeg-tiles the panels into a single composite. Time order is guaranteed by the
    //   caller's panels[i] index. Costs N× more Seedream calls; required when sequence fidelity
    //   matters (e.g. a falling object whose vertical position must monotonically decrease).
    const requestedMode = (typeof reqBody.mode === "string" ? reqBody.mode : "composite").toLowerCase();
    if (requestedMode === "sequential") {
      // Per-panel beat prompts: caller passes `panels: [{prompt: "..."}]` OR we split the single
      // scenePrompt by Beat A/B/C/D markers (and Frame N markers).
      const panelsBody = Array.isArray(reqBody.panels) ? (reqBody.panels as unknown[]) : [];
      const panelSpecs = panelsBody
        .map((p) => {
          if (typeof p === "string") return { prompt: p.trim() };
          if (typeof p === "object" && p !== null && typeof (p as Record<string, unknown>).prompt === "string") {
            return { prompt: ((p as Record<string, unknown>).prompt as string).trim() };
          }
          return undefined;
        })
        .filter((x): x is { prompt: string } => Boolean(x && x.prompt));
      const fallbackPanels = panelSpecs.length === 0
        ? splitScenePromptIntoBeats(scenePrompt, panelCount).map((prompt) => ({ prompt }))
        : panelSpecs;
      if (fallbackPanels.length < 2) {
        return res.status(400).json({
          error: "sequential mode requires at least 2 panels (pass `panels: [{prompt}]` or include Beat A/B/C... markers in scenePrompt)"
        });
      }
      const sequential = await generateSubStoryboardSequential({
        panels: fallbackPanels,
        layout,
        panelSize: size,
        referenceImageUrls,
        lang,
        modelVariant,
        outputLabel: shot.id
      });
      let sequentialUrl = sequential.compositeUrl;
      let sequentialTosObjectKey: string | undefined;
      let sequentialTosPublishedAt: string | undefined;
      if (sequentialUrl.startsWith("/media/") && hasTosConfig()) {
        try {
          const published = await publishLocalMediaToTos(sequentialUrl, { keyHint: `sub-storyboard-${shot.id}` });
          sequentialUrl = published.url;
          sequentialTosObjectKey = published.key;
          sequentialTosPublishedAt = new Date().toISOString();
        } catch (err) {
          console.warn(`[sub-storyboard:sequential] TOS publish failed (will keep local-only): ${err instanceof Error ? err.message : err}`);
        }
      }
      const sequentialResult: SubStoryboardResult = {
        url: sequentialUrl,
        size: sequential.panelSize,
        panelCount: sequential.panelCount,
        layout: sequential.layout,
        model: sequential.model,
        composedPrompt: sequential.panelPrompts.join("\n\n---\n\n"),
        referenceImageUrls,
        rawUsage: undefined
      };
      const seqPayload = {
        ...buildSubStoryboardAssetPayload(shot.id, shot.title || `Shot ${shot.index}`, scenePrompt, sequentialResult),
        composedPrompt: sequentialResult.composedPrompt,
        referenceAssetIds: requestedRefIds,
        referenceImageUrls,
        // Audit: store individual panel URLs so the UI can show "see panels in order"
        description: `Sub-shot storyboard grid (sequential mode), ${sequential.panelCount} panels in ${sequential.layout}. Panels generated one-by-one in time order; ffmpeg-composited locally.`,
        generatedAt: new Date().toISOString(),
        tags: ["sub-storyboard", "shot-scoped", "sequential"],
        tosObjectKey: sequentialTosObjectKey,
        tosPublishedAt: sequentialTosPublishedAt,
        referenceImageUrl: sequential.compositeUrl
      };
      const seqAsset = await store.upsertAsset(seqPayload);
      if (!seqAsset) throw new Error("Failed to persist sequential sub-storyboard asset");
      const updatedSeqShot = await store.updateShot(shot.id, {
        subShotPanelCount: sequential.panelCount,
        subShotStoryboardAssetId: seqAsset.id,
        subShotStoryboardAssetIds: Array.from(new Set([
          seqAsset.id,
          ...((shot.subShotStoryboardAssetIds || []).filter((id) => id !== seqAsset.id))
        ])),
        subStoryboardModel: modelVariant ?? shot.subStoryboardModel,
        firstFrameAssetId: undefined,
        lastFrameAssetId: undefined,
        usePreviousShotClip: false,
        composedSeedreamPromptDraft: undefined,
        assetIds: Array.from(new Set([...(shot.assetIds || []), seqAsset.id]))
      });
      return res.json({
        shot: updatedSeqShot,
        asset: seqAsset,
        grid: {
          panelCount: sequential.panelCount,
          layout: sequential.layout,
          size: sequential.panelSize,
          model: sequential.model,
          mode: "sequential",
          panelUrls: sequential.panelUrls
        },
        referenceImageUrls,
        referenceAssetIds: requestedRefIds,
        skippedReferences
      });
    }

    const grid = await generateSubStoryboardGrid({
      scenePrompt,
      panelCount,
      layout,
      size,
      lang,
      promptOverride: composedPromptOverride || undefined,
      referenceImageUrls,
      referenceImageLabels,
      modelVariant
    });
    const payload = {
      ...buildSubStoryboardAssetPayload(shot.id, shot.title || `Shot ${shot.index}`, scenePrompt, grid),
      composedPrompt: grid.composedPrompt,
      generatedAt: new Date().toISOString(),
      // Audit trail: which character/scene assets actually steered this grid generation.
      referenceAssetIds: requestedRefIds,
      referenceImageUrls: grid.referenceImageUrls
    };
    const asset = await store.upsertAsset(payload);
    if (!asset) throw new Error("Failed to persist sub-storyboard asset");
    const updatedShot = await store.updateShot(shot.id, {
      subShotPanelCount: panelCount,
      subShotStoryboardAssetId: asset.id,
      // Plural list mirrors the primary asset id at the head, then keeps any extra storyboards the
      // user has wired in via canvas drag-to-connect. We rebuild it as `[primary, ...extras]` and
      // dedupe so re-generating doesn't shuffle order or drop user-added extras.
      subShotStoryboardAssetIds: Array.from(new Set([
        asset.id,
        ...((shot.subShotStoryboardAssetIds || []).filter((id) => id !== asset.id))
      ])),
      // Persist the model variant the user just ran with, so the in-canvas picker stays sticky and
      // Inspector "重新出图" defaults to the same model unless the user changes it again.
      subStoryboardModel: modelVariant ?? shot.subStoryboardModel,
      firstFrameAssetId: undefined,
      lastFrameAssetId: undefined,
      usePreviousShotClip: false,
      // Persist the user-edited composedPrompt as the next-time draft so re-running this shot
      // (e.g. "重生这一段") starts from the same audited prompt rather than re-auto-composing.
      composedSeedreamPromptDraft: composedPromptOverride || undefined,
      assetIds: Array.from(new Set([...(shot.assetIds || []), asset.id]))
    });
    res.json({
      shot: updatedShot,
      asset,
      grid: {
        panelCount: grid.panelCount,
        layout: grid.layout,
        size: grid.size,
        model: grid.model,
        usage: grid.rawUsage
      },
      composedPrompt: grid.composedPrompt,
      referenceImageUrls: grid.referenceImageUrls,
      referenceAssetIds: requestedRefIds,
      skippedReferences
    });
  } catch (error) {
    res.status(500).json({ error: friendlyApiError(error, "Sub-storyboard generation failed") });
  }
});

app.post("/api/shots/:shotId/generate", async (req, res) => {
  const shotId = req.params.shotId;
  const reqBody = (req.body as Record<string, unknown>) || {};

  // Dry-run: compose the Seedance text content the way submitShotGeneration would, but DO NOT
  // submit anything. The user will inspect / edit the result and then re-POST without dryRun.
  if (reqBody.dryRun === true) {
    const composition = await dryRunSeedanceComposition(shotId);
    if (!composition) return res.status(404).json({ error: "Shot not found" });
    return res.json(composition);
  }

  const existingSubmission = shotGenerateSubmissions.get(shotId);
  if (existingSubmission) {
    const result = await existingSubmission;
    return res.status(result.status).json(result.body);
  }

  const submission = submitShotGeneration(shotId, reqBody as Partial<Shot> & Record<string, unknown>);
  shotGenerateSubmissions.set(shotId, submission);
  try {
    const result = await submission;
    return res.status(result.status).json(result.body);
  } finally {
    if (shotGenerateSubmissions.get(shotId) === submission) shotGenerateSubmissions.delete(shotId);
  }
});

/**
 * Mirror submitShotGeneration's mode resolution but do NOT mutate the shot or call Seedance.
 * Returns the same `PromptComposition` shape every dryRun route uses, so the client can render
 * an "audit & edit" textarea seeded with what the server would actually have submitted.
 */
async function dryRunSeedanceComposition(shotId: string) {
  const shot = store.getShot(shotId);
  if (!shot) return undefined;
  const allAssets = store.snapshot().assets;
  const session = store.getSession(shot.sessionId);
  const lang = session?.language === "en" ? "en" : "zh";
  const promptText = (shot.rawPrompt || shot.prompt || "").trim();
  const shotForCompose = { ...shot, rawPrompt: promptText, prompt: promptText };

  const mentionedAssets = store.getAssetsForShot({ ...shot, rawPrompt: promptText, prompt: promptText });
  const castAssets = getSessionCastAssets(session, allAssets);
  // Same @-mention gating as the actual /generate path: wired refvideo doesn't fire reference_video
  // until the user @-mentions it. Dry-run preview should reflect the same payload reality.
  const referencedAssets = mergeAssetsById([
    mentionedAssets,
    castAssets
  ]);

  const useSubShotMode = Boolean(
    shot.subShotPanelCount && shot.subShotPanelCount > 1 && (
      shot.subShotStoryboardAssetId ||
      (shot.subShotStoryboardAssetIds && shot.subShotStoryboardAssetIds.length > 0)
    )
  );
  const subShotPanelCount = useSubShotMode ? Math.max(2, Math.min(16, Math.floor(shot.subShotPanelCount as number))) : 0;
  // Resolve storyboard assets in the same order as the real /generate path: plural list first,
  // singular legacy field as fallback. The first resolved asset is primary; extras stay available
  // for prompt/payload previews.
  const subShotAssets = useSubShotMode ? resolveSubStoryboardAssets(shot, allAssets) : [];
  const subShotAsset = subShotAssets[0];
  const subShotAssetUrl = subShotAsset ? toPublicMediaUrl(subShotAsset.mediaUrl || subShotAsset.imageUrl || "") : undefined;
  const useSubShotResolved = Boolean(subShotAssetUrl);

  const firstFrameAsset = shot.firstFrameAssetId
    ? allAssets.find((asset) => asset.id === shot.firstFrameAssetId)
    : undefined;
  const firstFrameUrl = firstFrameAsset ? toPublicMediaUrl(firstFrameAsset.mediaUrl || firstFrameAsset.imageUrl || "") : undefined;
  const useFirstFrameMode = Boolean(firstFrameUrl && isRemoteSeedanceUrl(firstFrameUrl));
  // Mirror generators.ts: first-frame wins over sub-shot when both are wired (Seedance API
  // rejects mixing first/last frame with reference media).
  const subShotActive = useSubShotResolved && !useFirstFrameMode;
  const lastFrameAsset = useFirstFrameMode && shot.lastFrameAssetId
    ? allAssets.find((asset) => asset.id === shot.lastFrameAssetId)
    : undefined;
  const lastFrameUrl = lastFrameAsset ? toPublicMediaUrl(lastFrameAsset.mediaUrl || lastFrameAsset.imageUrl || "") : undefined;
  const useLastFrameMode = Boolean(lastFrameUrl && isRemoteSeedanceUrl(lastFrameUrl));

  // Continuity is implied if usePreviousShotClip is on AND there's a previous shot with a render.
  // Reference-video remake mode also activates the continuity instruction (Seedance reads it from
  // a `reference_video` content slot the same way).
  const referenceVideoAsset = !useFirstFrameMode && !subShotActive && shot.referenceVideoAssetId
    ? allAssets.find((a) => a.id === shot.referenceVideoAssetId)
    : undefined;
  // Cross-shot reference: another shot in the same session whose rendered video is used here.
  // Resolved at dry-run time the same way the real generate path does at line 2749 — by reading
  // the source shot's https video URL. We treat it as an additional path to "useReferenceVideoMode".
  const referenceVideoFromShot = !useFirstFrameMode && !subShotActive && shot.referenceVideoFromShotId
    ? store.getShot(shot.referenceVideoFromShotId)
    : undefined;
  const referenceVideoFromShotUrl = referenceVideoFromShot
    ? resolveShotReferenceVideoUrl(referenceVideoFromShot)
    : undefined;
  const useReferenceVideoMode = Boolean(
    (referenceVideoAsset?.mediaUrl && /^https?:\/\//.test(referenceVideoAsset.mediaUrl))
    || referenceVideoFromShotUrl
  );
  const continuityActive = !useFirstFrameMode && !subShotActive && (Boolean(shot.usePreviousShotClip) || useReferenceVideoMode);

  // Mirror generators.ts: pick exactly one anchor mode's assets for the prompt subset.
  const referencedSubset = useFirstFrameMode && firstFrameAsset
    ? (lastFrameAsset ? [firstFrameAsset, lastFrameAsset] : [firstFrameAsset])
    : subShotActive && subShotAsset
      ? subShotAssets
      : referencedAssets;

  return composeSeedanceVideoText(
    {
      shot: shotForCompose,
      referencedAssets: referencedSubset,
      firstFrameAsset: useFirstFrameMode ? firstFrameAsset : undefined,
      lastFrameAsset: useLastFrameMode ? lastFrameAsset : undefined,
      subShotAsset: subShotActive ? subShotAsset : undefined,
      subShotPanelCount: subShotActive ? subShotPanelCount : undefined,
      hasContinuityVideo: continuityActive,
      hasContinuityAudio: continuityActive,
      resolution: process.env.SEEDANCE_RATIO || "16:9"
    },
    lang
  );
}

async function submitShotGeneration(shotId: string, body: Partial<Shot>): Promise<{ status: number; body: unknown }> {
  const savedShot = store.getShot(shotId);
  if (!savedShot) return { status: 404, body: { error: "Shot not found" } };

  if (findPendingRender(savedShot) || savedShot.generationTaskId) {
    return { status: 200, body: savedShot };
  }

  let shot: Shot = { ...savedShot, ...body };
  const promptText = (shot.rawPrompt || shot.prompt || "").trim();
  if (!promptText) {
    const emptyShot = await store.updateShot(shot.id, { status: "error", error: "请输入 Prompt 后再运行" });
    return { status: 400, body: emptyShot || { error: "请输入 Prompt 后再运行" } };
  }

  try {
    const allAssets = store.snapshot().assets;
    const mentionedAssets = store.getAssetsForShot({ ...shot, rawPrompt: promptText, prompt: promptText });
    const session = store.getSession(shot.sessionId);
    const castAssets = getSessionCastAssets(session, allAssets);
    // Reference videos are only passed to Seedance when the user explicitly @-mentions them in
    // the prompt. Wiring a RefVideo node to a Shot via canvas registers the relationship
    // (referenceVideoAssetId / referenceClipUrl) but doesn't auto-fire the reference_video field;
    // that activation is the user's @-mention. mentionedAssets is the source of truth.
    const referencedAssets = mergeAssetsById([
      mentionedAssets,
      castAssets
    ]);

    // First-frame mode is mutually exclusive with continuity reference (per BytePlus docs and the
    // seedance-api-programming skill). When the shot has a first-frame asset we drop continuity,
    // and we also drop @ asset reference media from the Seedance payload (the generators layer
    // already enforces this; here we just keep bookkeeping consistent).
    const firstFrameAsset = shot.firstFrameAssetId
      ? allAssets.find((asset) => asset.id === shot.firstFrameAssetId)
      : undefined;
    const firstFrameUrl = firstFrameAsset ? toPublicMediaUrl(firstFrameAsset.mediaUrl || firstFrameAsset.imageUrl || "") : undefined;
    // Seedance 2.0 enforces a payload-level mutex: first/last_frame content cannot be mixed
    // with reference_image / reference_video content. So a shot runs either sub-shot mode
    // (grid as reference_image) OR first/last-frame I2V — not both.
    //
    // Priority is INVERTED from the previous default: when a user wires firstFrameAssetId
    // onto a shot that already has a sub-shot grid, first-frame wins (the grid demotes for
    // this run). This is the cross-shot continuity ergonomic — wiring `tail of shot N →
    // first-frame of shot N+1` works without forcing the caller to also clear sub-shot.
    const subShotPanelCount = shot.subShotPanelCount && shot.subShotPanelCount > 1 ? Math.floor(shot.subShotPanelCount) : 0;
    const subShotAssets = subShotPanelCount ? resolveSubStoryboardAssets(shot, allAssets) : [];
    const subShotAsset = subShotAssets[0];
    const subShotUrl = subShotAsset ? toPublicMediaUrl(subShotAsset.mediaUrl || subShotAsset.imageUrl || "") : undefined;
    const subShotResolved = Boolean(subShotPanelCount && subShotUrl && isRemoteSeedanceUrl(subShotUrl));
    const useFirstFrameMode = Boolean(firstFrameUrl && isRemoteSeedanceUrl(firstFrameUrl));
    const useSubShotMode = subShotResolved && !useFirstFrameMode;
    const firstFrameAssetId = useFirstFrameMode ? shot.firstFrameAssetId : undefined;
    // Last-frame is meaningful only when first-frame is also set (Seedance first/last frame I2V).
    const lastFrameAsset = useFirstFrameMode && shot.lastFrameAssetId
      ? allAssets.find((asset) => asset.id === shot.lastFrameAssetId)
      : undefined;
    const lastFrameUrl = lastFrameAsset ? toPublicMediaUrl(lastFrameAsset.mediaUrl || lastFrameAsset.imageUrl || "") : undefined;
    const useLastFrameMode = Boolean(lastFrameUrl && isRemoteSeedanceUrl(lastFrameUrl));
    const lastFrameAssetId = useLastFrameMode ? shot.lastFrameAssetId : undefined;
    const subShotStoryboardAssetId = useSubShotMode ? subShotAsset?.id : undefined;
    // Asset list per active mode: first-frame mode keeps first/last frames; sub-shot mode keeps
    // the grid; otherwise pass all @-mention reference assets through.
    let assets = useFirstFrameMode && firstFrameAsset
      ? (lastFrameAsset ? [firstFrameAsset, lastFrameAsset] : [firstFrameAsset])
      : useSubShotMode && subShotAsset
        ? subShotAssets
        : referencedAssets;

    let referenceClipUrl = shot.referenceClipUrl;
    let referenceAudioUrl = shot.referenceAudioUrl;
    let referenceClipPreviewUrl = shot.referenceClipPreviewUrl;
    let referenceAudioPreviewUrl = shot.referenceAudioPreviewUrl;
    let previousShotClipSec = Math.min(Math.max(Number(shot.previousShotClipSec) || 1, 1), 15);
    let previewSource: { videoUrl: string; sourceShotId: string } | undefined;

    // Reference-video mode: user-uploaded reference video → Seedance reference_video. This is
    // mutually exclusive with first/last-frame and sub-shot modes — they
    // also use the content slot. We resolve here so subsequent code branches can short-circuit.
    const referenceVideoAsset = !useFirstFrameMode && !useSubShotMode && shot.referenceVideoAssetId
      ? allAssets.find((a) => a.id === shot.referenceVideoAssetId)
      : undefined;
    const referenceVideoUrl = referenceVideoAsset?.mediaUrl;
    // Cross-shot reference: another shot's rendered video as this shot's reference_video. Same
    // content slot, takes precedence in the same way as the asset path. Source shot's https URL
    // (remoteVideoUrl preferred so it survives our local /media/ caching) is what Seedance fetches.
    const referenceVideoFromShot = !useFirstFrameMode && !useSubShotMode && !referenceVideoAsset && shot.referenceVideoFromShotId
      ? store.getShot(shot.referenceVideoFromShotId)
      : undefined;
    const referenceVideoFromShotUrl = referenceVideoFromShot
      ? resolveShotReferenceVideoUrl(referenceVideoFromShot)
      : undefined;
    const useReferenceVideoMode = Boolean(
      (referenceVideoUrl && /^https?:\/\//.test(referenceVideoUrl))
      || referenceVideoFromShotUrl
    );
    const referenceVideoAssetId = useReferenceVideoMode && referenceVideoAsset ? shot.referenceVideoAssetId : undefined;

    if (useReferenceVideoMode && referenceVideoUrl && referenceVideoAsset) {
      // Take precedence over previous-shot continuity. The user explicitly wired a remake.
      referenceClipUrl = referenceVideoUrl;
      referenceAudioUrl = undefined;
      referenceClipPreviewUrl = undefined;
      referenceAudioPreviewUrl = undefined;
      assets = mergeAssetsById([assets, [referenceVideoAsset]]);
    } else if (useReferenceVideoMode && referenceVideoFromShotUrl) {
      // Cross-shot wiring path. We don't have an Asset row to merge, so just set referenceClipUrl
      // — the Seedance payload builder reads this field directly via getSeedanceWebUrl().
      referenceClipUrl = referenceVideoFromShotUrl;
      referenceAudioUrl = undefined;
      referenceClipPreviewUrl = undefined;
      referenceAudioPreviewUrl = undefined;
    } else if (!useFirstFrameMode && !useSubShotMode && shot.usePreviousShotClip) {
      const session = store.getSession(shot.sessionId);
      const previousShot = session?.shots.find((item) => item.index === shot.index - 1);
      const selectedPreviousRender = previousShot ? findSelectedRender(previousShot) : undefined;
      const seedanceReferenceUrl = getContinuityReferenceUrl(previousShot, selectedPreviousRender);
      const maxDurationSec = getReferenceDurationSec(previousShot, selectedPreviousRender);
      const requestedDurationSec = shot.previousShotClipSecOverride ? shot.previousShotClipSec : undefined;
      previousShotClipSec = clampPreviousShotClipSec(requestedDurationSec, maxDurationSec);
      if (previousShot?.videoUrl) {
        previewSource = { videoUrl: previousShot.videoUrl, sourceShotId: previousShot.id };
      }
      if (seedanceReferenceUrl) {
        referenceClipUrl = seedanceReferenceUrl;
      } else {
        referenceClipUrl = undefined;
      }
      referenceAudioUrl = undefined;
      referenceClipPreviewUrl = undefined;
      referenceAudioPreviewUrl = undefined;
    } else {
      referenceClipUrl = undefined;
      referenceAudioUrl = undefined;
      referenceClipPreviewUrl = undefined;
      referenceAudioPreviewUrl = undefined;
    }
    const nextUsePreviousShotClip = useFirstFrameMode || useSubShotMode || useReferenceVideoMode ? false : Boolean(referenceClipUrl);
    shot = {
      ...shot,
      rawPrompt: promptText,
      prompt: promptText,
      usePreviousShotClip: nextUsePreviousShotClip,
      previousShotClipSec,
      previousShotClipSecOverride: nextUsePreviousShotClip ? Boolean(shot.previousShotClipSecOverride) : shot.previousShotClipSecOverride,
      referenceClipUrl,
      referenceAudioUrl,
      referenceClipPreviewUrl,
      referenceAudioPreviewUrl,
      firstFrameAssetId,
      lastFrameAssetId,
      subShotPanelCount: useSubShotMode ? subShotPanelCount : undefined,
      subShotStoryboardAssetId,
      referenceVideoAssetId,
      assetIds: mergeIds(shot.assetIds, assets.map((asset) => asset.id))
    };
    const pendingRender = createPendingShotRender(shot, assets);
    pendingRender.reviewEnabled = shouldEnableReview((body as Record<string, unknown>)?.visionReview as boolean | undefined);
    pendingRender.reviewMaxAttempts = clampMaxAttempts((body as Record<string, unknown>)?.maxReviewAttempts as number | undefined);
    pendingRender.reviewAttempts = 0;
    // Snapshot the audio choice so review-driven retries inherit it.
    const requestedGenerateAudioForRender = (body as Record<string, unknown>)?.generateAudio;
    if (typeof requestedGenerateAudioForRender === "boolean") {
      pendingRender.generateAudio = requestedGenerateAudioForRender;
    }
    // Snapshot the user-edited or auto-composed Seedance text so subsequent vision-review
    // resubmissions and the audit log all see the same prompt that was actually submitted.
    const userComposedPrompt = (body as Record<string, unknown>)?.composedPrompt;
    const draftPrompt = shot.composedSeedancePromptDraft;
    const finalComposedPrompt = typeof userComposedPrompt === "string" && userComposedPrompt.trim().length > 0
      ? userComposedPrompt.trim()
      : (typeof draftPrompt === "string" && draftPrompt.trim().length > 0 ? draftPrompt.trim() : undefined);
    if (finalComposedPrompt) pendingRender.composedPrompt = finalComposedPrompt;
    const nextRenders = [pendingRender, ...(shot.renders || [])];
    shot =
      (await store.updateShot(shot.id, {
        ...body,
        rawPrompt: shot.rawPrompt,
        prompt: shot.prompt,
        usePreviousShotClip: shot.usePreviousShotClip,
        previousShotClipSec: shot.previousShotClipSec,
        previousShotClipSecOverride: shot.previousShotClipSecOverride,
        referenceClipUrl: shot.referenceClipUrl,
        referenceAudioUrl: shot.referenceAudioUrl,
        referenceClipPreviewUrl: shot.referenceClipPreviewUrl,
        referenceAudioPreviewUrl: shot.referenceAudioPreviewUrl,
        firstFrameAssetId: shot.firstFrameAssetId,
        lastFrameAssetId: shot.lastFrameAssetId,
        subShotPanelCount: shot.subShotPanelCount,
        subShotStoryboardAssetId: shot.subShotStoryboardAssetId,
        referenceVideoAssetId: shot.referenceVideoAssetId,
        assetIds: shot.assetIds,
        renders: nextRenders,
        status: "generating",
        seedancePhase: "queued",
        error: undefined
      })) || shot;
    const generationAssets = assets;
    if (previewSource) {
      void extractContinuityPreviewsInBackground({
        shotId: shot.id,
        renderId: pendingRender.id,
        sourceShotId: previewSource.sourceShotId,
        sourceVideoUrl: previewSource.videoUrl,
        durationSec: previousShotClipSec
      });
    }
    const session2 = store.getSession(shot.sessionId);
    const sessionLang = resolveLang(session2?.language);
    // Per-request audio override: callers pass `generateAudio: false` to suppress Seedance's
    // auto-generated dialogue/music (which is often gibberish for short dramas). `undefined`
    // falls through to the env default.
    const requestedGenerateAudio = (body as Record<string, unknown>)?.generateAudio;
    const seedanceOpts = {
      prebuiltText: finalComposedPrompt,
      lang: sessionLang,
      ...(typeof requestedGenerateAudio === "boolean" ? { generateAudio: requestedGenerateAudio } : {})
    };
    if (canUseBytePlusSeedance()) {
      void startSeedanceVideoTask(shot, pendingRender.id, generationAssets, seedanceOpts);
      return { status: 200, body: shot };
    }

    const videoUrl = await generateShotVideo(shot, generationAssets, seedanceOpts);
    const cachedVideo = await cacheVideoOrKeepRemote(videoUrl, pendingRender.id);
    const completedAt = new Date().toISOString();
    const render: ShotRender = {
      ...pendingRender,
      videoUrl: cachedVideo.videoUrl,
      remoteVideoUrl: cachedVideo.remoteVideoUrl,
      status: "ready",
      videoGeneratedAt: completedAt,
      error: undefined,
      note: appendCacheWarning(pendingRender.note, cachedVideo.warning)
    };
    return {
      status: 200,
      body: await store.updateShot(shot.id, {
        videoUrl: cachedVideo.videoUrl,
        videoGeneratedAt: completedAt,
        renders: [render, ...(shot.renders || []).filter((item) => item.id !== pendingRender.id)],
        status: "ready",
        error: undefined
      })
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Shot generation failed";
    return { status: 500, body: await store.updateShot(shot.id, { status: "error", error: message }) };
  }
}

function extractContinuityPreviewsInBackground({
  shotId,
  renderId,
  sourceShotId,
  sourceVideoUrl,
  durationSec
}: {
  shotId: string;
  renderId: string;
  sourceShotId: string;
  sourceVideoUrl: string;
  durationSec: number;
}) {
  void (async () => {
    const referenceClipPreviewUrl = await extractTailVideoClip(sourceVideoUrl, shotId, sourceShotId, durationSec).catch(
      () => undefined
    );
    const referenceAudioPreviewUrl = await extractTailAudioClip(sourceVideoUrl, shotId, sourceShotId, durationSec).catch(
      () => undefined
    );
    if (!referenceClipPreviewUrl && !referenceAudioPreviewUrl) return;

    const patch = { referenceClipPreviewUrl, referenceAudioPreviewUrl };
    await store.updateShotRender(shotId, renderId, patch);
    const latest = store.getShot(shotId);
    const selectedRender = latest ? findSelectedRender(latest) : undefined;
    if (latest?.status === "generating" || selectedRender?.id === renderId) {
      await store.updateShot(shotId, patch);
    }
  })();
}

function createPendingShotRender(shot: Shot, assets: Asset[]): ShotRender {
  return {
    id: `render_${crypto.randomUUID().slice(0, 8)}`,
    model: resolveSeedanceModel(shot),
    status: "generating",
    // New tasks start in Seedance's queue; the first /poll call will flip this to "running"
    // (or to a terminal status). Setting a value upfront avoids the UI flashing a generic
    // "generating…" until the first poll lands.
    seedancePhase: "queued",
    rawPrompt: shot.rawPrompt,
    prompt: shot.prompt,
    title: shot.title,
    durationSec: shot.durationSec,
    seedanceVariant: shot.seedanceVariant,
    assetIds: assets.map((asset) => asset.id),
    usePreviousShotClip: shot.usePreviousShotClip,
    previousShotClipSec: shot.previousShotClipSec,
    previousShotClipSecOverride: shot.previousShotClipSecOverride,
    referenceClipUrl: shot.referenceClipUrl || undefined,
    referenceAudioUrl: shot.referenceAudioUrl || undefined,
    referenceClipPreviewUrl: shot.referenceClipPreviewUrl || undefined,
    referenceAudioPreviewUrl: shot.referenceAudioPreviewUrl || undefined,
    firstFrameAssetId: shot.firstFrameAssetId,
    lastFrameAssetId: shot.lastFrameAssetId,
    subShotPanelCount: shot.subShotPanelCount,
    subShotStoryboardAssetId: shot.subShotStoryboardAssetId,
    subShotStoryboardAssetIds: shot.subShotStoryboardAssetIds ? [...shot.subShotStoryboardAssetIds] : undefined,
    referenceVideoAssetId: shot.referenceVideoAssetId,
    referenceVideoFromShotId: shot.referenceVideoFromShotId,
    note: shot.debugNote,
    generationStartedAt: new Date().toISOString(),
    createdAt: new Date().toISOString()
  };
}

async function startSeedanceVideoTask(
  shot: Shot,
  renderId: string,
  assets: Asset[],
  opts: { prebuiltText?: string; lang?: "zh" | "en" } = {}
) {
  try {
    const task = await createSeedanceVideoTask(shot, assets, opts);
    const current = store.getShot(shot.id);
    const currentRender = current?.renders?.find((render) => render.id === renderId);
    if (!currentRender || currentRender.status !== "generating") {
      await cancelSeedanceVideoTask(task.taskId).catch(() => undefined);
      return;
    }
    await store.updateShotRender(shot.id, renderId, {
      model: task.model,
      status: "generating",
      generationTaskId: task.taskId,
      generationStartedAt: new Date().toISOString(),
      // Persist the actually-submitted Seedance text content for audit trail. If the upstream
      // call had a user override, this is that override; otherwise it's the auto-composed text.
      composedPrompt: task.composedText,
      error: undefined
    });
  } catch (error) {
    const current = store.getShot(shot.id);
    await store.updateShotRender(shot.id, renderId, {
      status: "error",
      generationTaskId: undefined,
      generationStartedAt: undefined,
      error: friendlyApiError(error, "Seedance task creation failed")
    });
    if (current?.status === "generating") {
      await store.updateShot(shot.id, {
        status: current.videoUrl ? "ready" : "error",
        error: friendlyApiError(error, "Seedance task creation failed")
      });
    }
  }
}

app.post("/api/shots/:shotId/cancel", async (req, res) => {
  const shot = store.getShot(req.params.shotId);
  if (!shot) return res.status(404).json({ error: "Shot not found" });

  const pendingRender = findPendingRender(shot);
  const taskId = pendingRender?.generationTaskId || shot.generationTaskId;
  if (!pendingRender && !taskId) return res.json(shot);

  const cancelledMessage = taskId
    ? `已请求取消 Seedance 任务 ${taskId}`
    : "已取消本地等待；Seedance 任务尚未提交完成";

  try {
    if (taskId) await cancelSeedanceVideoTask(taskId);
    let nextShot = shot;
    if (pendingRender) {
      nextShot =
        (await store.updateShotRender(shot.id, pendingRender.id, {
          status: "cancelled",
          error: cancelledMessage,
          generationTaskId: undefined,
          generationStartedAt: undefined
        })) || shot;
    }
    res.json(
      await store.updateShot(shot.id, {
        status: shot.videoUrl ? "ready" : shot.prompt ? "scripted" : "draft",
        error: undefined,
        generationTaskId: undefined,
        generationStartedAt: undefined
      }) || nextShot
    );
  } catch (error) {
    const message =
      error instanceof Error
        ? `${error.message}。如果任务已经进入 running，ModelArk 可能不允许取消，当前将继续轮询以保留生成结果。`
        : "Seedance cancellation failed";
    if (pendingRender) {
      await store.updateShotRender(shot.id, pendingRender.id, { error: message });
    }
    res.json(
      await store.updateShot(shot.id, {
        status: "generating",
        error: message
      }) || { error: message }
    );
  }
});

app.post("/api/shots/:shotId/review", async (req, res) => {
  const shot = store.getShot(req.params.shotId);
  if (!shot) return res.status(404).json({ error: "Shot not found" });
  if (!shot.videoUrl) return res.status(400).json({ error: "Shot has no video to review" });
  const selectedRender = findSelectedRender(shot) || (shot.renders || []).find((render) => render.videoUrl);
  if (!selectedRender?.id) return res.status(400).json({ error: "No selected render to review" });
  const nowIso = new Date().toISOString();
  await store.updateShotRender(shot.id, selectedRender.id, {
    videoReviewStatus: "running",
    videoReviewError: undefined,
    videoReviewUpdatedAt: nowIso
  });
  await store.updateShot(shot.id, {
    videoReviewStatus: "running",
    videoReviewError: undefined,
    videoReviewUpdatedAt: nowIso
  });
  try {
    const session = store.getSession(shot.sessionId);
    const context = composeShotReviewContext(shot, session);
    const verdict = await reviewVideoDetailed({
      scope: "shot",
      prompt: (selectedRender.composedPrompt || selectedRender.rawPrompt || selectedRender.prompt || shot.rawPrompt || shot.prompt || "").toString(),
      videoUrl: selectedRender.videoUrl || shot.videoUrl,
      referenceUrls: collectVideoReviewReferences(shot, selectedRender),
      frameCount: Number(req.body?.frameCount) || 8,
      context
    });
    const updatedShot = await store.updateShotRender(shot.id, selectedRender.id, {
      videoReviewStatus: "ready",
      videoReview: verdict,
      videoReviewError: undefined,
      videoReviewUpdatedAt: verdict.reviewedAt
    });
    const latest = store.getShot(shot.id);
    const stillSelected = latest && findSelectedRender(latest)?.id === selectedRender.id;
    if (stillSelected) {
      return res.json(await store.updateShot(shot.id, {
        videoReviewStatus: "ready",
        videoReview: verdict,
        videoReviewError: undefined,
        videoReviewUpdatedAt: verdict.reviewedAt
      }));
    }
    return res.json(updatedShot || store.getShot(shot.id));
  } catch (error) {
    const message = friendlyApiError(error, "VLM video review failed");
    const failedAt = new Date().toISOString();
    await store.updateShotRender(shot.id, selectedRender.id, {
      videoReviewStatus: "error",
      videoReviewError: message,
      videoReviewUpdatedAt: failedAt
    });
    return res.status(500).json(await store.updateShot(shot.id, {
      videoReviewStatus: "error",
      videoReviewError: message,
      videoReviewUpdatedAt: failedAt
    }));
  }
});

app.post("/api/shots/:shotId/review/repair-prompts", async (req, res) => {
  const shot = store.getShot(req.params.shotId);
  if (!shot) return res.status(404).json({ error: "Shot not found" });
  const verdict = shot.videoReview || findSelectedRender(shot)?.videoReview;
  if (!verdict) return res.status(400).json({ error: "Run VLM review before repairing prompts" });
  const plan = await buildShotReviewRepairPlan(shot, verdict);
  for (const target of plan.targets) {
    if (target.kind === "shot") {
      const targetShot = store.getShot(target.id);
      if (!targetShot) continue;
      const base = (targetShot.rawPrompt || targetShot.prompt || "").trim();
      const nextPrompt = appendRepairBlock(base, target.promptPatch);
      await store.updateShot(target.id, {
        rawPrompt: nextPrompt,
        prompt: nextPrompt,
        status: targetShot.videoUrl ? targetShot.status : "scripted"
      });
    } else if (target.kind === "asset") {
      const asset = store.snapshot().assets.find((item) => item.id === target.id);
      if (!asset) continue;
      await store.upsertAsset({ id: asset.id, prompt: appendRepairBlock(asset.prompt || asset.description || asset.name, target.promptPatch) });
    }
  }
  const updated = await store.updateShot(shot.id, { videoReviewRepairPlan: { ...plan, appliedAt: new Date().toISOString() } });
  res.json({ shot: updated, plan });
});

app.post("/api/shots/:shotId/poll", async (req, res) => {
  const shot = store.getShot(req.params.shotId);
  if (!shot) return res.status(404).json({ error: "Shot not found" });
  const pendingRender = findPendingRender(shot);
  const taskId = pendingRender?.generationTaskId || shot.generationTaskId;
  if (!pendingRender && !taskId) return res.json(shot);
  if (!taskId) return res.json(shot);

  const generationStartedAt = pendingRender?.generationStartedAt || shot.generationStartedAt;
  const isPastDeadline = Boolean(
    generationStartedAt && Date.now() - new Date(generationStartedAt).getTime() > seedanceTimeoutMs()
  );

  // IMPORTANT: do NOT short-circuit to "timed out" before asking ARK one last time.
  // The Seedance task is asynchronous and durable on ARK's side, so it may have already finished
  // (succeeded OR failed) even if our local server was offline / paused / never got a polling
  // tick. Only declare timeout when ARK itself confirms the task is still in a non-terminal
  // state (in_queue/generating/etc.) past our deadline.
  try {
    const result = await pollSeedanceVideoTask(taskId);

    // === ARK still working past our deadline → real timeout ===
    if (isPastDeadline && !["succeeded", "failed", "expired", "cancelled", "canceled"].includes(result.status)) {
      const message = `Seedance task ${taskId} timed out after ${Math.round(
        seedanceTimeoutMs() / 60000
      )}min (ARK status: ${result.status})`;
      if (pendingRender) {
        await store.updateShotRender(shot.id, pendingRender.id, {
          status: "error",
          error: message,
          generationTaskId: undefined,
          generationStartedAt: undefined
        });
      }
      return res.json(
        await store.updateShot(shot.id, {
          status: shot.videoUrl ? "ready" : "error",
          error: message,
          generationTaskId: undefined
        })
      );
    }

    if (result.status === "succeeded" && result.videoUrl) {
      let nextShot = shot;
      const completedAt = new Date().toISOString();
      const cachedVideo = await cacheVideoOrKeepRemote(result.videoUrl, pendingRender?.id || `shot-${shot.id}`);

      // === Vision self-review on the freshly produced video ===
      // If the render was submitted with reviewEnabled=true and it still has retries left, run a
      // vision verdict against the prompt + reference assets. Failed verdicts trigger a fresh
      // Seedance task on the SAME render row (we keep the render id but flip generationTaskId so
      // the next /poll waits on the new task). When we run out of retries we accept the last
      // product and stamp reviewNote on the render so the user can see the review trail.
      const reviewEnabled = pendingRender?.reviewEnabled ?? false;
      const maxAttempts = clampMaxAttempts(pendingRender?.reviewMaxAttempts);
      const attemptIndex = (pendingRender?.reviewAttempts ?? 0) + 1;
      let reviewVerdictNote: string | undefined;
      let reviewVerdictModel: string | undefined;
      let didResubmit = false;

      if (pendingRender && reviewEnabled) {
        // Phase 3 — single-flight lock keyed by renderId. Concurrent /poll calls for the same
        // render race the review block: each one reads pendingRender.reviewAttempts before any
        // of them write it back, so all of them fire a resubmit "attempt 1/5". Each resubmit
        // is a real Seedance task that costs money. Lock at the renderId so only the first
        // poll runs reviewVideo+resubmit; everyone else awaits and observes the outcome.
        const renderId = pendingRender.id;
        const existingLock = reviewLocks.get(renderId);
        if (existingLock) {
          try {
            const outcome = await existingLock;
            if (outcome.didResubmit) {
              // Lock-holder already fired a resubmit. Shot status is now "generating" again with
              // a new generationTaskId. Return the latest persisted state.
              return res.json(store.getShot(shot.id) || shot);
            }
            // Lock-holder accepted the product (or its resubmit failed). Latest state should be
            // "ready" already; just return it.
            const latest = store.getShot(shot.id);
            if (latest && latest.status !== "generating") return res.json(latest);
            // else fall through and the accept path below will harmlessly write the same state.
          } catch (lockError) {
            console.warn(
              `[vision-review] shot ${shot.id} render ${renderId} concurrent poll lock observed error, continuing: ${
                lockError instanceof Error ? lockError.message : lockError
              }`
            );
          }
        } else {
          let resolveOutcome!: (v: { didResubmit: boolean }) => void;
          let rejectOutcome!: (e: unknown) => void;
          const lock = new Promise<{ didResubmit: boolean }>((resolve, reject) => {
            resolveOutcome = resolve;
            rejectOutcome = reject;
          });
          reviewLocks.set(renderId, lock);
          try {
            const referenceUrls = collectVideoReviewReferences(shot, pendingRender);
            const verdict = await reviewVideo({
              prompt: (pendingRender.rawPrompt || pendingRender.prompt || shot.prompt || "").toString(),
              videoUrl: cachedVideo.videoUrl,
              referenceUrls
            });
            reviewVerdictModel = verdict.model;
            if (!verdict.ok) {
              const failures = parseExistingReviewFailures(pendingRender.reviewNote);
              failures.push({
                attempt: attemptIndex,
                reasons: verdict.reasons.length ? verdict.reasons : ["(no reasons returned)"]
              });

              if (attemptIndex < maxAttempts) {
                try {
                  const retryAssets = store.getAssets(pendingRender.assetIds || []);
                  const shotForRetry: Shot = {
                    ...shot,
                    rawPrompt: pendingRender.rawPrompt || shot.rawPrompt,
                    prompt: pendingRender.prompt || shot.prompt,
                    durationSec: pendingRender.durationSec || shot.durationSec,
                    seedanceVariant: pendingRender.seedanceVariant || shot.seedanceVariant,
                    usePreviousShotClip: pendingRender.usePreviousShotClip,
                    previousShotClipSec: pendingRender.previousShotClipSec,
                    previousShotClipSecOverride: pendingRender.previousShotClipSecOverride,
                    referenceClipUrl: pendingRender.referenceClipUrl,
                    referenceAudioUrl: pendingRender.referenceAudioUrl,
                    firstFrameAssetId: pendingRender.firstFrameAssetId,
                    lastFrameAssetId: pendingRender.lastFrameAssetId,
                    subShotPanelCount: pendingRender.subShotPanelCount,
                    subShotStoryboardAssetId: pendingRender.subShotStoryboardAssetId,
                    subShotStoryboardAssetIds: pendingRender.subShotStoryboardAssetIds,
                    referenceVideoAssetId: pendingRender.referenceVideoAssetId,
                    referenceVideoFromShotId: pendingRender.referenceVideoFromShotId,
                    assetIds: pendingRender.assetIds || shot.assetIds
                  };
                  // Run the prompt rewriter: turn the VLM's verdict reasons into a fresh prompt
                  // that explicitly addresses what was wrong, instead of resubmitting the same text
                  // verbatim. The rewriter falls through to the original prompt on any failure
                  // (no API key, transport error, empty rewrite), so this is always at-least-as-good
                  // as the legacy verbatim path.
                  const baseSeedanceText = pendingRender.composedPrompt || (pendingRender.rawPrompt || pendingRender.prompt || shot.prompt || "").toString();
                  const retrySession = store.getSession(shot.sessionId);
                  const retryLang = resolveLang(retrySession?.language);
                  const rewrite = await rewritePromptWithReviewFeedback({
                    originalPrompt: baseSeedanceText,
                    reviewReasons: verdict.reasons,
                    referenceUrls: collectVideoReviewReferences(shot, pendingRender).slice(0, 2),
                    lang: retryLang
                  });
                  const rewrittenSeedanceText = rewrite.rewritten ? rewrite.prompt : baseSeedanceText;
                  if (rewrite.rewritten) {
                    console.warn(
                      `[vision-review] shot ${shot.id} render ${pendingRender.id} rewriter produced a new prompt (model=${rewrite.model}); attempt ${attemptIndex + 1} will use it`
                    );
                  } else if (rewrite.note) {
                    console.warn(`[vision-review] shot ${shot.id} rewriter skipped: ${rewrite.note}`);
                  }
                  const task = await createSeedanceVideoTask(shotForRetry, retryAssets, {
                    prebuiltText: rewrittenSeedanceText,
                    lang: retryLang,
                    ...(typeof pendingRender.generateAudio === "boolean" ? { generateAudio: pendingRender.generateAudio } : {})
                  });
                  await store.updateShotRender(shot.id, pendingRender.id, {
                    status: "generating",
                    videoUrl: undefined,
                    remoteVideoUrl: undefined,
                    generationTaskId: task.taskId,
                    generationStartedAt: new Date().toISOString(),
                    error: undefined,
                    reviewAttempts: attemptIndex,
                    reviewModel: verdict.model,
                    reviewNote: formatReviewNote(failures, false),
                    composedPrompt: rewrittenSeedanceText
                  });
                  console.warn(
                    `[vision-review] shot ${shot.id} render ${pendingRender.id} attempt ${attemptIndex}/${maxAttempts} failed; resubmitted as task ${task.taskId}: ${verdict.reasons.join("; ")}`
                  );
                  didResubmit = true;
                  resolveOutcome({ didResubmit: true });
                  return res.json(
                    await store.updateShot(shot.id, {
                      status: "generating",
                      error: undefined,
                      generationTaskId: task.taskId,
                      generationStartedAt: new Date().toISOString()
                    })
                  );
                } catch (retryError) {
                  const message = retryError instanceof Error ? retryError.message : String(retryError);
                  failures.push({ attempt: attemptIndex, reasons: [`resubmit failed: ${message.slice(0, 200)}`] });
                  console.warn(`[vision-review] resubmit failed for shot ${shot.id}: ${message}`);
                }
              }

              // Out of retries (or resubmit failed) → keep last product, record note.
              reviewVerdictNote = formatReviewNote(failures, false);
            } else if (attemptIndex > 1) {
              // Passed on a retry — record the trail of earlier failures.
              const failures = parseExistingReviewFailures(pendingRender.reviewNote);
              reviewVerdictNote = formatReviewNote(failures, true);
            }
            // Review path completed without a resubmit (verdict.ok=true OR out of retries OR
            // resubmit threw). Signal to any waiting concurrent polls that they can fall through
            // to the accept path.
            resolveOutcome({ didResubmit: false });
          } catch (reviewError) {
            // Never let the review path block a successful generation.
            console.warn(
              `[vision-review] shot ${shot.id} review threw, accepting product: ${reviewError instanceof Error ? reviewError.message : reviewError}`
            );
            resolveOutcome({ didResubmit: false });
            void rejectOutcome; // unused but needed to satisfy the const reject above
          } finally {
            if (reviewLocks.get(renderId) === lock) reviewLocks.delete(renderId);
          }
        }
      }

      if (didResubmit) {
        // already returned above
        return;
      }

      if (pendingRender) {
        nextShot =
          (await store.updateShotRender(shot.id, pendingRender.id, {
            status: "ready",
            videoUrl: cachedVideo.videoUrl,
            remoteVideoUrl: cachedVideo.remoteVideoUrl,
            videoGeneratedAt: completedAt,
            generationTaskId: undefined,
            generationStartedAt: undefined,
            error: undefined,
            note: appendCacheWarning(pendingRender.note, cachedVideo.warning),
            reviewAttempts: reviewEnabled ? attemptIndex - 1 : pendingRender.reviewAttempts,
            reviewNote: reviewVerdictNote ?? pendingRender.reviewNote,
            reviewModel: reviewVerdictModel ?? pendingRender.reviewModel
          })) || shot;
      }
      // Auto-select the completed render from the active pending render. This matches the product
      // expectation that a user-triggered regeneration becomes the current canvas video as soon as
      // it finishes; history/restore can still switch versions afterwards.
      const completedRenderStillCurrent = Boolean(pendingRender?.id) && (nextShot.renders || [])[0]?.id === pendingRender?.id;
      const shouldSelectCompletedRender = Boolean(pendingRender) || !shot.videoUrl || completedRenderStillCurrent;
      return res.json(
        await store.updateShot(shot.id, {
          ...(shouldSelectCompletedRender ? shotPatchFromCompletedRender(nextShot, pendingRender?.id, cachedVideo.videoUrl) : {}),
          status: shouldSelectCompletedRender ? "ready" : shot.status,
          generationTaskId: undefined,
          generationStartedAt: undefined,
          error: undefined
        })
      );
    }

    if (["failed", "expired"].includes(result.status)) {
      const message = `Seedance task ${result.taskId} ${result.status}: ${JSON.stringify(result.error).slice(0, 500)}`;
      if (pendingRender) {
        await store.updateShotRender(shot.id, pendingRender.id, {
          status: "error",
          error: message,
          generationTaskId: undefined,
          generationStartedAt: undefined
        });
      }
      return res.json(
        await store.updateShot(shot.id, {
          status: shot.videoUrl ? "ready" : "error",
          error: message,
          generationTaskId: undefined,
          generationStartedAt: undefined
        })
      );
    }

    if (["cancelled", "canceled"].includes(result.status)) {
      const message = `Seedance task ${result.taskId} ${result.status}`;
      if (pendingRender) {
        await store.updateShotRender(shot.id, pendingRender.id, {
          status: "cancelled",
          error: message,
          generationTaskId: undefined,
          generationStartedAt: undefined
        });
      }
      return res.json(
        await store.updateShot(shot.id, {
          status: shot.videoUrl ? "ready" : shot.prompt ? "scripted" : "draft",
          error: undefined,
          generationTaskId: undefined,
          generationStartedAt: undefined
        })
      );
    }

    if (pendingRender && pendingRender.status !== "generating") {
      await store.updateShotRender(shot.id, pendingRender.id, { status: "generating", error: undefined });
    }
    // Derive sub-phase (queued vs running) from the raw Seedance status so the UI can show
    // "排队中" vs "渲染中". Anything we don't recognize falls through as "running" (better to
    // assume work-in-progress than to leave the UI showing "queued" forever for a status string
    // we hadn't seen before).
    const phase = mapSeedancePhase(result.status);
    if (pendingRender && pendingRender.seedancePhase !== phase) {
      await store.updateShotRender(shot.id, pendingRender.id, { seedancePhase: phase });
    }
    return res.json(await store.updateShot(shot.id, { error: undefined, seedancePhase: phase }));
  } catch (error) {
    // If we can't reach ARK at all AND we're already past the local deadline, surface a real
    // timeout so the UI stops spinning. Otherwise it's a transient network error — let the UI
    // retry on its next poll tick.
    if (isPastDeadline) {
      const reason = error instanceof Error ? error.message : "ARK unreachable";
      const message = `Seedance task ${taskId} timed out after ${Math.round(
        seedanceTimeoutMs() / 60000
      )}min (last poll error: ${reason.slice(0, 200)})`;
      if (pendingRender) {
        await store.updateShotRender(shot.id, pendingRender.id, {
          status: "error",
          error: message,
          generationTaskId: undefined,
          generationStartedAt: undefined
        });
      }
      return res.json(
        await store.updateShot(shot.id, {
          status: shot.videoUrl ? "ready" : "error",
          error: message,
          generationTaskId: undefined
        })
      );
    }
    res.status(500).json({ error: friendlyApiError(error, "Seedance polling failed") });
  }
});

/**
 * Translate any error into a user-readable string. Specifically rewrites Node 18 / undici's
 * generic `fetch failed` into a more actionable message — that exact string had been bubbling
 * up to the UI from local route catches and confusing users into restarting their dev server,
 * when in reality only an upstream API (BytePlus / TOS / OpenAI) had a transient blip.
 *
 * Use this in every `catch (err)` block that returns `{ error: err.message }` to the client.
 */
function friendlyApiError(err: unknown, fallback = "请求失败"): string {
  if (!err) return fallback;
  const message = err instanceof Error ? err.message : String(err);
  if (/^fetch failed$/i.test(message)) {
    const cause = (err as { cause?: { code?: string; message?: string } } | undefined)?.cause;
    const detail = cause?.code || cause?.message || "网络层错误";
    return `上游 API 调用失败（${detail}）— BytePlus / TOS 一类的外部服务暂时不通，等几秒重试一次通常能恢复。和 dev server 本身无关。`;
  }
  return message || fallback;
}

function findPendingRender(shot: Shot) {
  return (shot.renders || []).find((render) => render.status === "generating" || Boolean(render.generationTaskId));
}

/**
 * Translate the raw Seedance task status string into our two UI sub-phases.
 *
 *   queued  ← "queued" / "in_queue" / "pending" / "submitted" / "waiting"
 *   running ← everything else non-terminal (the "running" / "processing" / "generating" family
 *             plus any unknown future status — assuming work-in-progress is safer than letting
 *             the UI sit on "queued" forever for an unrecognized string).
 *
 * Caller is expected to have already filtered out terminal statuses (succeeded/failed/etc.); we
 * still return "running" for those as a defensive default but it shouldn't be observed in the UI
 * because the polling code clears the phase on terminal transitions.
 */
function mapSeedancePhase(status: string): SeedancePhase {
  const s = (status || "").toLowerCase();
  if (s === "queued" || s === "in_queue" || s === "pending" || s === "submitted" || s === "waiting") {
    return "queued";
  }
  return "running";
}

function findSelectedRender(shot: Shot) {
  return (shot.renders || []).find((render) => render.videoUrl === shot.videoUrl || render.remoteVideoUrl === shot.videoUrl);
}

function getReferenceDurationSec(previousShot: Shot | undefined, selectedRender: ShotRender | undefined) {
  const duration = Number(selectedRender?.durationSec ?? previousShot?.durationSec);
  if (!Number.isFinite(duration)) return 1;
  return Math.min(Math.max(Math.round(duration), 1), 15);
}

function clampPreviousShotClipSec(seconds: unknown, maxSeconds: number) {
  const max = Math.min(Math.max(Math.round(Number(maxSeconds)) || 1, 1), 15);
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return max;
  return Math.min(Math.max(Math.round(value), 1), max);
}

function getContinuityReferenceUrl(previousShot: Shot | undefined, selectedRender: ShotRender | undefined) {
  const candidates = [selectedRender?.remoteVideoUrl, selectedRender?.videoUrl, previousShot?.videoUrl];
  return candidates.find((url) => isRemoteWebUrl(url));
}

async function cacheVideoOrKeepRemote(
  videoUrl: string,
  renderId: string
): Promise<{ videoUrl: string; remoteVideoUrl?: string; warning?: string }> {
  try {
    return { ...(await cacheGeneratedVideo(videoUrl, renderId)), warning: undefined };
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    return {
      videoUrl,
      warning: `本地缓存失败，当前保留远程视频 URL：${message}`
    };
  }
}

function appendCacheWarning(note: string | undefined, warning: string | undefined) {
  return [note, warning].filter(Boolean).join("\n") || undefined;
}

function collectVideoReviewReferences(shot: Shot, render: ShotRender): string[] {
  const out: string[] = [];
  // First/last-frame assets (if any) are the strongest constraints — push them first in order.
  if (render.firstFrameAssetId) {
    const firstFrameAsset = store.snapshot().assets.find((asset) => asset.id === render.firstFrameAssetId);
    const url = firstFrameAsset?.referenceImageUrl || firstFrameAsset?.mediaUrl || firstFrameAsset?.imageUrl;
    if (url) out.push(url);
  }
  if (render.lastFrameAssetId) {
    const lastFrameAsset = store.snapshot().assets.find((asset) => asset.id === render.lastFrameAssetId);
    const url = lastFrameAsset?.referenceImageUrl || lastFrameAsset?.mediaUrl || lastFrameAsset?.imageUrl;
    if (url) out.push(url);
  }
  // Then the assets the render snapshot bound (character / scene refs the user @-mentioned).
  const assetIds = render.assetIds || shot.assetIds || [];
  for (const id of assetIds) {
    if (id === render.firstFrameAssetId) continue;
    if (id === render.lastFrameAssetId) continue;
    const asset = store.snapshot().assets.find((item) => item.id === id);
    const url = asset?.referenceImageUrl || asset?.mediaUrl || asset?.imageUrl;
    if (url) out.push(url);
  }
  return out;
}

function composeShotReviewContext(shot: Shot, session: ReturnType<CinemaStore["getSession"]>) {
  const beat = session?.story?.beats?.find((item) => item.index === shot.storyBeatIndex || item.index === shot.index);
  return [
    `Session: ${session?.title || shot.sessionId}`,
    session?.logline ? `Logline: ${session.logline}` : "",
    session?.style ? `Style: ${session.style}` : "",
    `Shot ${shot.index}: ${shot.title}`,
    shot.script ? `Script: ${shot.script}` : "",
    shot.camera ? `Camera: ${shot.camera}` : "",
    beat ? `Story beat: ${beat.title} / ${beat.purpose} / ${beat.plot} / emotion=${beat.emotion}` : ""
  ].filter(Boolean).join("\n");
}

function composeFinalReviewPrompt(session: ReturnType<CinemaStore["getSession"]>) {
  return [
    `短剧标题：${session?.title || ""}`,
    `Logline：${session?.logline || ""}`,
    `风格：${session?.style || ""}`,
    session?.story?.synopsis ? `Synopsis：${session.story.synopsis}` : "",
    "请评估这条最终拼接的完整短视频是否满足短剧发布质量，尤其关注人物、场景、节奏连续性和前三秒钩子。"
  ].filter(Boolean).join("\n");
}

function composeFinalReviewContext(session: ReturnType<CinemaStore["getSession"]>) {
  const shots = (session?.shots || []).slice().sort((a, b) => a.index - b.index);
  return [
    `Target duration: ${session?.targetDurationSec || 0}s`,
    `Shot list:`,
    ...shots.map((shot) => `${shot.index}. ${shot.title} (${shot.durationSec}s) — ${shot.script || shot.rawPrompt || shot.prompt || ""}`)
  ].join("\n");
}

async function buildShotReviewRepairPlan(shot: Shot, verdict: VideoReviewVerdict): Promise<VideoReviewRepairPlan> {
  const allAssets = store.snapshot().assets;
  const reasons = [...verdict.fatalIssues, ...verdict.reasons, ...verdict.fixes.map((fix) => fix.action)].filter(Boolean);
  const reasonText = reasons.join("；");
  const targets: VideoReviewRepairPlan["targets"] = [];
  const referencedAssets = store.getAssets(shot.assetIds || []);
  const wantsIdentity = /人物|角色|身份|脸|face|identity|换人|服装|character/i.test(reasonText);
  const wantsScene = /场景|背景|空间|医院|街道|光线|scene|background|lighting|continuity/i.test(reasonText);
  const wantsProp = /道具|蛋糕|手机|头盔|prop|object/i.test(reasonText);

  for (const asset of referencedAssets) {
    if ((asset.type === "character" && wantsIdentity) || (asset.type === "scene" && wantsScene) || (asset.type === "prop" && wantsProp)) {
      const rewrite = await rewritePromptWithReviewFeedback({
        originalPrompt: asset.prompt || asset.description || asset.name,
        reviewReasons: reasons.slice(0, 6),
        referenceUrls: [asset.referenceImageUrl || asset.mediaUrl || asset.imageUrl].filter(Boolean) as string[],
        lang: "zh"
      });
      targets.push({
        kind: "asset",
        id: asset.id,
        reason: `VLM 指出与 ${asset.type} 相关的问题`,
        promptPatch: rewrite.rewritten ? rewrite.prompt : buildFallbackRepairPatch(reasons)
      });
    }
  }

  const rewrite = await rewritePromptWithReviewFeedback({
    originalPrompt: shot.rawPrompt || shot.prompt || "",
    reviewReasons: reasons.slice(0, 8),
    referenceUrls: referencedAssets.map((asset) => asset.referenceImageUrl || asset.mediaUrl || asset.imageUrl).filter(Boolean).slice(0, 3) as string[],
    lang: "zh"
  });
  targets.push({
    kind: "shot",
    id: shot.id,
    reason: "当前视频节点未达标，需要加强本镜头 prompt",
    promptPatch: rewrite.rewritten ? rewrite.prompt : buildFallbackRepairPatch(reasons)
  });

  if (/上一镜|前序|接续|连贯|continuity|previous/i.test(reasonText) && shot.index > 1) {
    const previous = store.getSession(shot.sessionId)?.shots.find((item) => item.index === shot.index - 1);
    if (previous) {
      targets.push({
        kind: "shot",
        id: previous.id,
        reason: "当前镜头的失败与前序连续性有关，需要修前序镜头的交接描述",
        promptPatch: appendRepairBlock(previous.rawPrompt || previous.prompt || "", `为后续 Shot ${shot.index} 提供明确尾帧/节奏/空间交接：${reasons.slice(0, 3).join("；")}`)
      });
    }
  }

  return {
    createdAt: new Date().toISOString(),
    sourceReviewScope: verdict.scope,
    sourceNodeId: shot.id,
    targets
  };
}

function buildFallbackRepairPatch(reasons: string[]) {
  return [
    "VLM 审核修复要求：",
    ...reasons.slice(0, 8).map((reason) => `- ${reason}`),
    "请优先修复以上问题；保持原有剧情意图，但明确人物身份、场景连续、动作物理合理、无乱码文字/水印/畸形。"
  ].join("\n");
}

function appendRepairBlock(base: string, patch: string) {
  const cleanBase = (base || "").trim();
  const cleanPatch = (patch || "").trim();
  if (!cleanPatch) return cleanBase;
  return [cleanBase, "", "【VLM 审核反馈修复】", cleanPatch].filter(Boolean).join("\n");
}

function parseExistingReviewFailures(reviewNote: string | undefined): Array<{ attempt: number; reasons: string[] }> {
  if (!reviewNote) return [];
  // formatReviewNote shapes notes as "<header>\nattempt N: reason1; reason2\n..."
  const lines = reviewNote.split("\n").slice(1);
  const failures: Array<{ attempt: number; reasons: string[] }> = [];
  for (const line of lines) {
    const match = line.match(/^attempt\s+(\d+):\s*(.*)$/i);
    if (!match) continue;
    const attempt = Number(match[1]);
    const reasons = match[2].split(";").map((s) => s.trim()).filter(Boolean);
    failures.push({ attempt, reasons });
  }
  return failures;
}

function shotPatchFromCompletedRender(shot: Shot, renderId: string | undefined, videoUrl: string): Partial<Shot> {
  const render = renderId ? (shot.renders || []).find((item) => item.id === renderId) : undefined;
  if (!render) return { videoUrl };
  return {
    title: render.title,
    durationSec: render.durationSec,
    seedanceVariant: render.seedanceVariant,
    assetIds: render.assetIds,
    rawPrompt: render.rawPrompt,
    prompt: render.prompt,
    debugNote: render.note || "",
    videoUrl,
    videoGeneratedAt: render.videoGeneratedAt || render.createdAt,
    usePreviousShotClip: render.usePreviousShotClip,
    previousShotClipSec: render.previousShotClipSec,
    previousShotClipSecOverride: render.previousShotClipSecOverride,
    referenceClipUrl: render.referenceClipUrl,
    referenceAudioUrl: render.referenceAudioUrl,
    referenceClipPreviewUrl: render.referenceClipPreviewUrl,
    referenceAudioPreviewUrl: render.referenceAudioPreviewUrl,
    firstFrameAssetId: render.firstFrameAssetId,
    lastFrameAssetId: render.lastFrameAssetId,
    subShotPanelCount: render.subShotPanelCount,
    subShotStoryboardAssetId: render.subShotStoryboardAssetId,
    subShotStoryboardAssetIds: render.subShotStoryboardAssetIds,
    referenceVideoFromShotId: render.referenceVideoFromShotId,
    referenceVideoAssetId: render.referenceVideoAssetId,
    videoReviewStatus: render.videoReviewStatus,
    videoReview: render.videoReview,
    videoReviewError: render.videoReviewError,
    videoReviewUpdatedAt: render.videoReviewUpdatedAt
  };
}

app.post("/api/sessions/:sessionId/final-review", async (req, res) => {
  const session = store.getSession(req.params.sessionId);
  if (!session) return res.status(404).json({ error: "Session not found" });
  const jobId = typeof req.body?.jobId === "string" ? req.body.jobId : undefined;
  const job = jobId ? (session.stitchJobs || []).find((item) => item.id === jobId) : undefined;
  if (jobId && !job) return res.status(404).json({ error: "Stitch job not found" });
  const finalVideoUrl = job?.finalVideoUrl || session.finalVideoUrl;
  const finalVideoSignature = job?.finalVideoSignature || session.finalVideoSignature;
  if (!finalVideoUrl) return res.status(400).json({ error: "Final video not ready" });
  const startedAt = new Date().toISOString();
  if (job) {
    await store.updateStitchJob(session.id, job.id, {
      finalVideoReviewStatus: "running",
      finalVideoReviewError: undefined,
      finalVideoReviewUpdatedAt: startedAt,
      finalVideoReviewRunningSignature: finalVideoSignature
    });
  } else {
    await store.updateSession(session.id, {
      finalVideoReviewStatus: "running",
      finalVideoReviewError: undefined,
      finalVideoReviewUpdatedAt: startedAt,
      finalVideoReviewRunningSignature: finalVideoSignature
    });
  }
  try {
    const verdict = await reviewVideoDetailed({
      scope: "session_final",
      prompt: composeFinalReviewPrompt(session),
      videoUrl: finalVideoUrl,
      frameCount: Number(req.body?.frameCount) || 10,
      context: composeFinalReviewContext(session),
      videoSignature: finalVideoSignature
    });
    if (job) {
      return res.json(await store.updateStitchJob(session.id, job.id, {
        finalVideoReviewStatus: "ready",
        finalVideoReview: verdict,
        finalVideoReviewError: undefined,
        finalVideoReviewUpdatedAt: verdict.reviewedAt,
        finalVideoReviewRunningSignature: undefined,
        finalVideoReviewBuiltForSignature: finalVideoSignature
      }));
    }
    return res.json(await store.updateSession(session.id, {
      finalVideoReviewStatus: "ready",
      finalVideoReview: verdict,
      finalVideoReviewError: undefined,
      finalVideoReviewUpdatedAt: verdict.reviewedAt,
      finalVideoReviewRunningSignature: undefined,
      finalVideoReviewBuiltForSignature: finalVideoSignature
    }));
  } catch (error) {
    const message = friendlyApiError(error, "Final VLM review failed");
    if (job) {
      return res.status(500).json(await store.updateStitchJob(session.id, job.id, {
        finalVideoReviewStatus: "error",
        finalVideoReviewError: message,
        finalVideoReviewUpdatedAt: new Date().toISOString(),
        finalVideoReviewRunningSignature: undefined
      }));
    }
    return res.status(500).json(await store.updateSession(session.id, {
      finalVideoReviewStatus: "error",
      finalVideoReviewError: message,
      finalVideoReviewUpdatedAt: new Date().toISOString(),
      finalVideoReviewRunningSignature: undefined
    }));
  }
});

app.post("/api/sessions/:sessionId/final-review/repair-prompts", async (req, res) => {
  const session = store.getSession(req.params.sessionId);
  if (!session) return res.status(404).json({ error: "Session not found" });
  const jobId = typeof req.body?.jobId === "string" ? req.body.jobId : undefined;
  const job = jobId ? (session.stitchJobs || []).find((item) => item.id === jobId) : undefined;
  if (jobId && !job) return res.status(404).json({ error: "Stitch job not found" });
  const verdict = job?.finalVideoReview || session.finalVideoReview;
  if (!verdict) return res.status(400).json({ error: "Run final VLM review before repairing prompts" });
  const reasons = [...verdict.fatalIssues, ...verdict.reasons, ...verdict.fixes.map((fix) => fix.action)].filter(Boolean);
  const targets: VideoReviewRepairPlan["targets"] = [];
  const shots = (session.shots || []).slice().sort((a, b) => a.index - b.index);
  const fixShotNumbers = new Set(verdict.fixes.map((fix) => fix.shot).filter((n): n is number => Number.isFinite(n)));
  const selected = shots.filter((shot) => fixShotNumbers.size ? fixShotNumbers.has(shot.index) : Boolean(shot.videoUrl));
  for (const shot of selected.slice(0, 6)) {
    const localReasons = verdict.fixes.filter((fix) => !fix.shot || fix.shot === shot.index).map((fix) => fix.action);
    const repairReasons = localReasons.length ? localReasons : reasons;
    const rewrite = await rewritePromptWithReviewFeedback({
      originalPrompt: shot.rawPrompt || shot.prompt || "",
      reviewReasons: repairReasons.slice(0, 8),
      lang: "zh"
    });
    const promptPatch = rewrite.rewritten ? rewrite.prompt : buildFallbackRepairPatch(repairReasons);
    targets.push({ kind: "shot", id: shot.id, reason: `完整片终审指出 Shot ${shot.index} 需要修复`, promptPatch });
    await store.updateShot(shot.id, {
      rawPrompt: appendRepairBlock(shot.rawPrompt || shot.prompt || "", promptPatch),
      prompt: appendRepairBlock(shot.rawPrompt || shot.prompt || "", promptPatch),
      status: shot.videoUrl ? shot.status : "scripted"
    });
  }
  const plan: VideoReviewRepairPlan = {
    createdAt: new Date().toISOString(),
    sourceReviewScope: verdict.scope,
    sourceNodeId: session.id,
    targets,
    appliedAt: new Date().toISOString()
  };
  if (job) return res.json(await store.updateStitchJob(session.id, job.id, { finalVideoReviewRepairPlan: plan }));
  res.json(await store.updateSession(session.id, { finalVideoReviewRepairPlan: plan }));
});

app.post("/api/sessions/:sessionId/stitch", async (req, res) => {
  const jobId = typeof req.body?.jobId === "string" ? req.body.jobId : undefined;
  const result = await triggerStitchJob(req.params.sessionId, { force: req.body?.force === true, jobId });
  if ("status" in result) return res.status(result.status).json({ error: result.error });
  res.json(result.session);
});

app.post("/api/sessions/:sessionId/stitch/poll", (req, res) => {
  const session = store.getSession(req.params.sessionId);
  if (!session) return res.status(404).json({ error: "Session not found" });
  res.json(session);
});

/**
 * Decides what to do for a /stitch request. Never blocks on ffmpeg or downloads:
 *   - 404 if the session does not exist
 *   - 400 if no shots are ready
 *   - reuse if `finalVideoUrl` already matches the current input signature
 *   - reuse if another worker is already running on this exact signature (singleflight)
 *   - otherwise: mark the session as `running`, launch a background worker, and return immediately
 *
 * The background worker writes terminal status (`ready` with `finalVideoUrl`, or `error` with
 * `stitchError`) back into the persistent store, so any later client GET /api/state or POST
 * /stitch/poll observes the outcome regardless of whether the original /stitch caller is still
 * connected.
 */
async function triggerStitchJob(
  sessionId: string,
  options: { force?: boolean; jobId?: string } = {}
): Promise<{ session: ReturnType<CinemaStore["getSession"]> } | { status: number; error: string }> {
  const session = store.getSession(sessionId);
  if (!session) return { status: 404, error: "Session not found" };
  const job = options.jobId ? (session.stitchJobs || []).find((item) => item.id === options.jobId) : undefined;
  if (options.jobId && !job) return { status: 404, error: "Stitch job not found" };
  const resolved = resolveStitchShots(session, job);
  if (resolved.error) return { status: 400, error: resolved.error };
  const readyShots = resolved.shots;

  const signature = computeStitchSignaturePreview(readyShots);
  const inflightKey = options.jobId ? `${sessionId}:${options.jobId}` : sessionId;

  if (job) {
    if (!options.force && job.finalVideoUrl && job.finalVideoSignature === signature && job.status !== "running") {
      if (job.status !== "ready") {
        const updated = await store.updateStitchJob(sessionId, job.id, {
          status: "ready",
          updatedAt: new Date().toISOString(),
          error: undefined,
          progress: "",
          runningSignature: undefined
        });
        return { session: updated };
      }
      return { session };
    }
  } else if (!options.force && session.finalVideoUrl && session.finalVideoSignature === signature && session.stitchStatus !== "running") {
    if (session.stitchStatus !== "ready") {
      const updated = await store.updateSession(sessionId, {
        stitchStatus: "ready",
        stitchUpdatedAt: new Date().toISOString(),
        stitchError: undefined,
        stitchProgress: "",
        stitchRunningSignature: undefined
      });
      return { session: updated };
    }
    return { session };
  }

  const inflightSignature = stitchInflight.get(inflightKey);
  if (inflightSignature === signature) {
    return { session };
  }
  if (inflightSignature && inflightSignature !== signature) {
    console.warn(
      `[stitch ${inflightKey}] new request signature=${signature} arrived while signature=${inflightSignature} still running; rejecting to avoid double work`
    );
    return { status: 409, error: "A stitch job for an earlier version is still running. Please wait for it to finish." };
  }

  stitchInflight.set(inflightKey, signature);
  const startedAt = new Date().toISOString();
  const queued = job
    ? await store.updateStitchJob(sessionId, job.id, {
        status: "running",
        startedAt,
        updatedAt: startedAt,
        error: undefined,
        progress: "queued",
        runningSignature: signature
      })
    : await store.updateSession(sessionId, {
        stitchStatus: "running",
        stitchStartedAt: startedAt,
        stitchUpdatedAt: startedAt,
        stitchError: undefined,
        stitchProgress: "queued",
        stitchRunningSignature: signature
      });

  setImmediate(() => {
    void runStitchJobInBackground(sessionId, readyShots, signature, { force: options.force === true, jobId: job?.id });
  });

  return { session: queued };
}

function resolveStitchShots(session: NonNullable<ReturnType<CinemaStore["getSession"]>>, job?: StitchJob): { shots: Shot[]; error?: string } {
  const explicitIds = ((job ? job.shotIds : session.stitchShotIds) || []).filter(Boolean);
  if (!explicitIds.length) {
    const shots = session.shots
      .filter((shot) => shot.videoUrl)
      .sort((a, b) => a.index - b.index);
    return shots.length ? { shots } : { shots: [], error: "No generated shots to stitch" };
  }

  const byId = new Map(session.shots.map((shot) => [shot.id, shot]));
  const seen = new Set<string>();
  const shots: Shot[] = [];
  for (const shotId of explicitIds) {
    if (seen.has(shotId)) continue;
    seen.add(shotId);
    const shot = byId.get(shotId);
    if (!shot) continue;
    if (!shot.videoUrl) {
      return { shots: [], error: `Connected shot "${shot.title || `Shot ${shot.index}`}" has no generated video` };
    }
    shots.push(shot);
  }
  if (!shots.length) return { shots: [], error: "No connected generated shots to stitch" };
  return { shots };
}

async function runStitchJobInBackground(
  sessionId: string,
  readyShots: Shot[],
  signature: string,
  options: { force?: boolean; jobId?: string } = {}
) {
  const startedAt = Date.now();
  const inflightKey = options.jobId ? `${sessionId}:${options.jobId}` : sessionId;
  try {
    const result = await stitchShotVideos(options.jobId ? `${sessionId}-${options.jobId}` : sessionId, readyShots, {
      force: options.force === true,
      onProgress: async (phase) => {
        if (options.jobId) {
          await store.updateStitchJob(sessionId, options.jobId, {
            progress: phase,
            updatedAt: new Date().toISOString()
          });
        } else {
          await store.updateSession(sessionId, {
            stitchProgress: phase,
            stitchUpdatedAt: new Date().toISOString()
          });
        }
      }
    });
    const completedAt = new Date().toISOString();
    if (options.jobId) {
      await store.updateStitchJob(sessionId, options.jobId, {
        finalVideoUrl: result.finalVideoUrl,
        finalVideoGeneratedAt: completedAt,
        finalVideoSignature: result.signature,
        status: "ready",
        updatedAt: completedAt,
        error: undefined,
        progress: "",
        runningSignature: undefined
      });
    } else {
      await store.updateSession(sessionId, {
        finalVideoUrl: result.finalVideoUrl,
        finalVideoGeneratedAt: completedAt,
        finalVideoSignature: result.signature,
        stitchStatus: "ready",
        stitchUpdatedAt: completedAt,
        stitchError: undefined,
        stitchProgress: "",
        stitchRunningSignature: undefined
      });
    }
    console.log(
      `[stitch ${inflightKey}] DONE in ${((Date.now() - startedAt) / 1000).toFixed(1)}s -> ${result.finalVideoUrl}`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[stitch ${inflightKey}] FAILED in ${((Date.now() - startedAt) / 1000).toFixed(1)}s: ${message}`);
    if (options.jobId) {
      await store.updateStitchJob(sessionId, options.jobId, {
        status: "error",
        error: message,
        updatedAt: new Date().toISOString(),
        progress: "",
        runningSignature: undefined
      });
    } else {
      await store.updateSession(sessionId, {
        stitchStatus: "error",
        stitchError: message,
        stitchUpdatedAt: new Date().toISOString(),
        stitchProgress: "",
        stitchRunningSignature: undefined
      });
    }
  } finally {
    if (stitchInflight.get(inflightKey) === signature) {
      stitchInflight.delete(inflightKey);
    }
  }
}

/**
 * Pre-computes the same signature that `stitchShotVideos` will use, so that the HTTP route can
 * make singleflight / cache-reuse decisions BEFORE launching the background worker. We delegate
 * to the same function used inside generators.ts to guarantee the values match.
 */
function computeStitchSignaturePreview(shots: Shot[]): string {
  return createStitchSignature(shots);
}

// ---------- Narration (auto subtitle + voiceover) routes ----------

const DEFAULT_NARRATION_STRATEGY: NarrationStrategy = "natural";
const DEFAULT_NARRATION_VOICE = process.env.VOLC_TTS_VOICE_TYPE || "zh_male_M392_conversation_wvae_bigtts";

app.post("/api/sessions/:sessionId/narration", async (req, res) => {
  const sessionId = req.params.sessionId;
  const script: string = typeof req.body?.script === "string" ? req.body.script : "";
  const voice: string = typeof req.body?.voice === "string" && req.body.voice.trim() ? req.body.voice.trim() : DEFAULT_NARRATION_VOICE;
  const strategy: NarrationStrategy = req.body?.strategy === "natural" ? "natural" : DEFAULT_NARRATION_STRATEGY;
  if (!script.trim()) return res.status(400).json({ error: "Script is required" });

  const result = await triggerNarrationJob(sessionId, { script, voice, strategy });
  if ("status" in result) return res.status(result.status).json({ error: result.error });
  res.json(result.session);
});

app.post("/api/sessions/:sessionId/narration/poll", (req, res) => {
  const session = store.getSession(req.params.sessionId);
  if (!session) return res.status(404).json({ error: "Session not found" });
  res.json(session);
});

app.get("/api/sessions/:sessionId/narration/download", async (req, res) => {
  const session = store.getSession(req.params.sessionId);
  if (!session) return res.status(404).json({ error: "Session not found" });

  const kind = req.query.kind === "srt" ? "srt" : "video";
  if (kind === "srt") {
    if (!session.narrationSubtitleUrl) return res.status(404).json({ error: "Narration subtitle not ready" });
    return sendNarrationDownload(res, session.narrationSubtitleUrl, `${sanitizeDownloadName(`${session.title || session.id}-字幕`)}.srt`);
  }
  if (!session.narrationVideoUrl) return res.status(404).json({ error: "Narration video not ready" });
  return sendVideoDownload(
    res,
    session.narrationVideoUrl,
    `${sanitizeDownloadName(`${session.title || session.id}-含字幕`)}.mp4`
  );
});

/**
 * Same fire-and-forget shape as /stitch:
 *   - 404 if the session does not exist
 *   - 400 if no finalVideoUrl yet (must stitch first) or script is empty
 *   - 409 if a narration job for a DIFFERENT signature is still running on this session
 *   - reuse if the current signature already produced a ready artifact
 *   - otherwise mark `running` + spawn background worker + return current snapshot immediately
 */
async function triggerNarrationJob(
  sessionId: string,
  input: { script: string; voice: string; strategy: NarrationStrategy }
): Promise<{ session: ReturnType<CinemaStore["getSession"]> } | { status: number; error: string }> {
  const session = store.getSession(sessionId);
  if (!session) return { status: 404, error: "Session not found" };
  if (!session.finalVideoUrl || !session.finalVideoSignature) {
    return { status: 400, error: "Final video not ready — please run stitch first." };
  }

  // Pre-apply the same language-mismatch safety net the pipeline uses so the signature we compute
  // here (used for inflight dedup + reuse) matches the signature the pipeline will compute. Without
  // this, an EN script with a stale ZH voice request would always cache-miss after the swap.
  const effectiveVoice = resolveEffectiveVoice(input.script, input.voice);
  const signature = computeNarrationSignature({
    script: input.script,
    voice: effectiveVoice,
    strategy: input.strategy,
    finalVideoSignature: session.finalVideoSignature
  });

  // Reuse already-ready artifacts.
  if (
    session.narrationVideoUrl &&
    session.narrationSubtitleUrl &&
    session.narrationSignature === signature &&
    session.narrationStatus !== "running"
  ) {
    if (session.narrationStatus !== "ready") {
      const updated = await store.updateSession(sessionId, {
        narrationStatus: "ready",
        narrationUpdatedAt: new Date().toISOString(),
        narrationError: undefined,
        narrationProgress: "",
        narrationRunningSignature: undefined
      });
      return { session: updated };
    }
    return { session };
  }

  const inflightSignature = narrationInflight.get(sessionId);
  if (inflightSignature === signature) return { session };
  if (inflightSignature && inflightSignature !== signature) {
    console.warn(
      `[narration ${sessionId}] new request signature=${signature} arrived while signature=${inflightSignature} still running; rejecting`
    );
    return { status: 409, error: "A narration job for an earlier version is still running. Please wait." };
  }

  narrationInflight.set(sessionId, signature);
  const startedAt = new Date().toISOString();
  const queued = await store.updateSession(sessionId, {
    narrationScript: input.script,
    narrationVoice: effectiveVoice,
    narrationStrategy: input.strategy,
    narrationStatus: "running",
    narrationStartedAt: startedAt,
    narrationUpdatedAt: startedAt,
    narrationError: undefined,
    narrationProgress: "queued",
    narrationRunningSignature: signature
  });

  setImmediate(() => {
    void runNarrationJobInBackground(sessionId, { ...input, voice: effectiveVoice }, signature);
  });

  return { session: queued };
}

async function runNarrationJobInBackground(
  sessionId: string,
  input: { script: string; voice: string; strategy: NarrationStrategy },
  signature: string
) {
  const startedAt = Date.now();
  try {
    const sessionSnapshot = store.getSession(sessionId);
    if (!sessionSnapshot) throw new Error("Session disappeared mid-flight");
    const result = await runNarrationPipeline(
      {
        id: sessionSnapshot.id,
        finalVideoUrl: sessionSnapshot.finalVideoUrl,
        finalVideoSignature: sessionSnapshot.finalVideoSignature
      },
      input,
      {
        onProgress: async (phase) => {
          await store.updateSession(sessionId, {
            narrationProgress: phase,
            narrationUpdatedAt: new Date().toISOString()
          });
        }
      }
    );
    await store.updateSession(sessionId, {
      narrationVideoUrl: result.narrationVideoUrl,
      narrationSubtitleUrl: result.narrationSubtitleUrl,
      narrationSignature: result.narrationSignature,
      // Reflect the voice the pipeline actually used (may have language-swapped from input.voice).
      narrationVoice: result.effectiveVoice,
      narrationBuiltForFinalVideoSignature: sessionSnapshot.finalVideoSignature,
      narrationStatus: "ready",
      narrationUpdatedAt: new Date().toISOString(),
      narrationError: undefined,
      narrationProgress: "",
      narrationRunningSignature: undefined
    });
    console.log(
      `[narration ${sessionId}] DONE in ${((Date.now() - startedAt) / 1000).toFixed(1)}s -> ${result.narrationVideoUrl}`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[narration ${sessionId}] FAILED in ${((Date.now() - startedAt) / 1000).toFixed(1)}s: ${message}`);
    await store.updateSession(sessionId, {
      narrationStatus: "error",
      narrationError: message,
      narrationUpdatedAt: new Date().toISOString(),
      narrationProgress: "",
      narrationRunningSignature: undefined
    });
  } finally {
    if (narrationInflight.get(sessionId) === signature) {
      narrationInflight.delete(sessionId);
    }
  }
}

async function sendNarrationDownload(res: Response, mediaUrl: string, filename: string) {
  const localPath = resolveLocalMediaPath(mediaUrl);
  if (localPath) return res.download(localPath, filename);
  return res.status(500).json({ error: "Narration artifact missing locally" });
}

if (isProduction) {
  app.use(express.static(path.resolve(__dirname, "../../dist/client")));
  app.use((_req, res) => res.sendFile(path.resolve(__dirname, "../../dist/client/index.html")));
} else {
  const { createServer: createViteServer } = await import("vite");
  const vite = await createViteServer({
    server: { middlewareMode: true },
    appType: "spa"
  });
  app.use(vite.middlewares);
}

/**
 * Catch-all Express error handler. Routes that throw / reject without their own try-catch end up
 * here instead of either crashing the worker or hanging until the client times out. Returns a JSON
 * error payload the client can surface as a toast; logs the full stack to the server console for
 * the developer.
 *
 * Express only invokes 4-arg middlewares on errors, so the unused `_next` parameter is required.
 */
app.use((err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const rawMessage = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  console.error(`[express-error] ${req.method} ${req.url}: ${stack || rawMessage}`);
  if (res.headersSent) return;
  // "fetch failed" is the generic Node 18 / undici error for any low-level network error when the
  // SERVER is making an outbound fetch (Seedream / Seedance / TOS / etc). Bubbled up to the
  // browser as just "fetch failed" it looks like the dev server itself crashed, which confuses
  // users into restarting Node. Tag it explicitly so the UI can show the right hint.
  let message = rawMessage || "Internal server error";
  if (/^fetch failed$/i.test(rawMessage)) {
    const cause = (err as { cause?: { code?: string; message?: string } } | undefined)?.cause;
    const detail = cause?.code || cause?.message || "网络层错误";
    message = `上游 API 调用失败（${detail}）— BytePlus / TOS 一类的外部服务暂时不通，等几秒重试一次通常能恢复。和 dev server 本身无关。`;
  }
  res.status(500).json({ error: message });
});

app.listen(port, () => {
  console.log(`reelyai-agent is running at http://localhost:${port}`);
});

/**
 * Last-resort safety nets so a single bad request / background promise can't kill the dev server
 * and force a restart. Express handles its own per-request errors but anything thrown from a
 * background task (Seedance polling worker, ffmpeg child, vision-review fetch) bubbles up here.
 *
 * We log loudly instead of `process.exit()` — a crashed prompt-compose call should not take down
 * the whole canvas. If something is genuinely unrecoverable the user can still kill the process
 * manually; this just stops accidental crashes from spurious rejections.
 */
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err?.stack || err);
});
process.on("unhandledRejection", (reason) => {
  const stack = reason instanceof Error ? reason.stack : undefined;
  console.error("[unhandledRejection]", stack || reason);
});
