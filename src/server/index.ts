import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express, { type Response } from "express";
import { createServer as createViteServer } from "vite";
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
  pollSeedanceVideoTask,
  resolveSeedanceModel,
  seedanceTimeoutMs,
  stitchShotVideos
} from "./generators";
import { computeNarrationSignature, resolveEffectiveVoice, runNarrationPipeline } from "./narration";
import { CinemaStore } from "./store";
import { publishAssetImageToTos } from "./tos";
import type { Asset, NarrationStrategy, Shot, ShotRender, StoryPlan } from "../shared/types";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isProduction = process.env.NODE_ENV === "production";
const port = Number(process.env.PORT || 5173);
const mediaDir = path.resolve(process.cwd(), "data", "media");
const storyboardMediaDir = path.join(mediaDir, "codex-storyboards");

const app = express();
const store = new CinemaStore();
await store.load();
const shotGenerateSubmissions = new Map<string, Promise<{ status: number; body: unknown }>>();
// In-process singleflight registry for stitch background workers. Keyed by sessionId; value is
// the signature currently being processed. Survives concurrent /stitch POSTs but does NOT survive
// process restart (handled separately via resetOrphanStitchJobs() at startup).
const stitchInflight = new Map<string, string>();
// Same idea but for the narration pipeline (TTS + ffmpeg subtitle/audio mix).
const narrationInflight = new Map<string, string>();

async function resetOrphanStitchJobs() {
  const snapshot = store.snapshot();
  const orphans = snapshot.sessions.filter((session) => session.stitchStatus === "running");
  if (!orphans.length) return;
  console.log(`[stitch] resetting ${orphans.length} orphan running job(s) from previous process`);
  for (const session of orphans) {
    await store.updateSession(session.id, {
      stitchStatus: "error",
      stitchError: "Server restarted while stitching; please retry.",
      stitchUpdatedAt: new Date().toISOString(),
      stitchProgress: "",
      stitchRunningSignature: undefined
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

app.get("/api/state", (_req, res) => {
  res.json(store.snapshot());
});

app.post("/api/sessions", async (req, res) => {
  res.json(await store.createSession(req.body));
});

app.patch("/api/sessions/:sessionId", async (req, res) => {
  const session = await store.updateSession(req.params.sessionId, req.body);
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

// Promote a session-scoped asset to a global one (clears ownerSessionId). After this the asset
// is visible to every session and survives deletion of the session that originally created it.
// No-op if the asset is already global. Cannot promote a shot-scoped private sketch — that has
// stricter privacy semantics; user has to make a fresh global asset instead.
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

app.post("/api/assets/expand-prompt", async (req, res) => {
  try {
    res.json(await expandAssetPrompt(req.body?.asset || {}));
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Asset prompt expansion failed" });
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

app.delete("/api/shots/:shotId/renders/:renderId", async (req, res) => {
  const shot = await store.deleteShotRender(req.params.shotId, req.params.renderId);
  if (!shot) return res.status(404).json({ error: "Shot not found" });
  res.json(shot);
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

    const existingSketchCount = store
      .snapshot()
      .assets.filter((asset) => asset.ownerShotId === shot.id && (asset.tags || []).includes("sketch")).length;

    const created: Asset[] = [];
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
        ownerShotId: shot.id
      });
      if (!placeholder) continue;
      try {
        const imageUrl = await generateAssetImage(placeholder, model, []);
        const updated = await store.upsertAsset({
          id: placeholder.id,
          imageUrl,
          mediaUrl: imageUrl,
          mediaKind: "image"
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
    res.status(500).json({ error: error instanceof Error ? error.message : "Sketch generation failed" });
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
      "Codex imagegen storyboard reference image."
    )
      .toString()
      .trim();
    const name = (req.body?.name || `${shot.title || `Shot ${shot.index}`} Codex 故事板`).toString().trim();
    const importedUrl = await importStoryboardImage(req.body?.imageDataUrl, req.body?.imageUrl, shot.id, name);
    const publicUrl = toPublicMediaUrl(importedUrl) || importedUrl;
    const canSeedanceUse = isRemoteSeedanceUrl(publicUrl);
    const sketch = await store.upsertAsset({
      name,
      type: "scene",
      mediaKind: "image",
      description: canSeedanceUse
        ? `Codex imagegen 故事板（私有，仅供分镜「${shot.title || `Shot ${shot.index}`}」作为 Seedance reference_image）`
        : `Codex imagegen 故事板（私有，仅本地预览；配置 PUBLIC_MEDIA_BASE_URL 后才能作为 Seedance reference_image）`,
      prompt: promptText,
      tags: ["sketch", "shot-scoped", "codex-imagegen", "storyboard"],
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
    res.status(500).json({ error: error instanceof Error ? error.message : "Storyboard import failed" });
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
    res.status(500).json({ error: error instanceof Error ? error.message : "TOS publish failed" });
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
    res.status(500).json({ error: error instanceof Error ? error.message : "TOS publish failed" });
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
    res.status(500).json({ error: error instanceof Error ? error.message : "TOS publish failed" });
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

app.get("/api/sessions/:sessionId/download", async (req, res) => {
  const session = store.getSession(req.params.sessionId);
  if (!session) return res.status(404).json({ error: "Session not found" });
  if (!session.finalVideoUrl) return res.status(404).json({ error: "Final video not ready" });

  const filename = `${sanitizeDownloadName(`${session.title || session.id}-完整视频`)}.mp4`;
  return sendVideoDownload(res, session.finalVideoUrl, filename);
});

app.post("/api/assets/:assetId/generate", async (req, res) => {
  const allAssets = store.snapshot().assets;
  const asset = allAssets.find((item) => item.id === req.params.assetId);
  if (!asset) return res.status(404).json({ error: "Asset not found" });

  try {
    const requestedModel = req.body?.model;
    const model: "gpt-image-2" | "seedream-4" | "seedream-4-5" =
      requestedModel === "gpt-image-2"
        ? "gpt-image-2"
        : requestedModel === "seedream-4"
          ? "seedream-4"
          : "seedream-4-5";
    // Collect parent reference images so derived variants (e.g. "young 曹操" with parentAssetId=曹操)
    // keep the parent character's facial identity. Multiple parents could be wired in later.
    const referenceImageUrls: string[] = [];
    const ownReferenceImage = asset.referenceImageUrl || asset.mediaUrl || asset.imageUrl;
    if (ownReferenceImage) referenceImageUrls.push(ownReferenceImage);
    if (asset.parentAssetId) {
      const parent = allAssets.find((item) => item.id === asset.parentAssetId);
      const parentImage = parent?.referenceImageUrl || parent?.mediaUrl || parent?.imageUrl;
      if (parentImage) referenceImageUrls.push(parentImage);
    }
    const imageUrl = await generateAssetImage(asset, model, referenceImageUrls);
    res.json(await store.upsertAsset({ id: asset.id, imageUrl, mediaUrl: imageUrl, mediaKind: "image" }));
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Asset generation failed" });
  }
});

app.post("/api/sessions/:sessionId/script/generate", async (req, res) => {
  const session = store.getSession(req.params.sessionId);
  if (!session) return res.status(404).json({ error: "Session not found" });

  try {
    const story = await generateStoryPlan(session, store.snapshot().assets);
    res.json(await store.updateSession(session.id, { story }));
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Script generation failed" });
  }
});

app.patch("/api/sessions/:sessionId/script", async (req, res) => {
  const session = store.getSession(req.params.sessionId);
  if (!session) return res.status(404).json({ error: "Session not found" });

  res.json(await store.updateSession(session.id, { story: normalizeStoryPatch(req.body?.story || req.body) }));
});

function sanitizeDownloadName(value: string) {
  return value
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .slice(0, 80) || "shot-video";
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
    "firstFrameAssetId"
  ];
  clearable.forEach((field) => {
    if (patch[field] === null) {
      patch[field] = undefined as never;
    }
  });
  if (patch.error === "") patch.error = undefined;
  // Allow the UI to clear the first-frame asset by sending "".
  if (patch.firstFrameAssetId === "") patch.firstFrameAssetId = undefined;
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

function isRemoteWebUrl(url?: string | null) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return ["http:", "https:"].includes(parsed.protocol) && !["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
  } catch {
    return false;
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
    return res.status(500).json({ error: error instanceof Error ? error.message : "Video download failed" });
  }
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

  for (const shot of session.shots) {
    const planned = plannedShots.find((item) => item.index === shot.index) || plannedShots[shot.index - 1];
    if (!planned) continue;
    const updatedShot = await store.updateShot(shot.id, {
      title: planned.title || shot.title,
      storyBeatIndex: planned.storyBeatIndex ?? shot.storyBeatIndex,
      script: planned.script || shot.script,
      camera: planned.camera || shot.camera,
      durationSec: planned.durationSec || shot.durationSec,
      rawPrompt: planned.rawPrompt || planned.prompt || shot.rawPrompt,
      prompt: planned.prompt || shot.prompt,
      status: "scripted"
    });
    if (updatedShot) updated.push(updatedShot);
  }

  res.json({ session: store.getSession(session.id), shots: updated });
});

app.post("/api/shots/:shotId/generate", async (req, res) => {
  const shotId = req.params.shotId;
  const existingSubmission = shotGenerateSubmissions.get(shotId);
  if (existingSubmission) {
    const result = await existingSubmission;
    return res.status(result.status).json(result.body);
  }

  const submission = submitShotGeneration(shotId, req.body as Partial<Shot>);
  shotGenerateSubmissions.set(shotId, submission);
  try {
    const result = await submission;
    return res.status(result.status).json(result.body);
  } finally {
    if (shotGenerateSubmissions.get(shotId) === submission) shotGenerateSubmissions.delete(shotId);
  }
});

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

    // First-frame mode is mutually exclusive with continuity reference (per BytePlus docs and the
    // seedance-api-programming skill). When the shot has a first-frame asset we drop continuity,
    // and we also drop @ asset reference media from the Seedance payload (the generators layer
    // already enforces this; here we just keep bookkeeping consistent).
    const firstFrameAsset = shot.firstFrameAssetId
      ? allAssets.find((asset) => asset.id === shot.firstFrameAssetId)
      : undefined;
    const firstFrameUrl = firstFrameAsset ? firstFrameAsset.mediaUrl || firstFrameAsset.imageUrl : undefined;
    const useFirstFrameMode = Boolean(firstFrameUrl && /^https?:\/\//.test(firstFrameUrl));
    const firstFrameAssetId = useFirstFrameMode ? shot.firstFrameAssetId : undefined;
    // In first-frame mode the only asset we pass to Seedance is the first-frame asset itself, so
    // its description/usage gets the dedicated `Image 1 (first_frame)` slot in the prompt.
    const assets = useFirstFrameMode && firstFrameAsset ? [firstFrameAsset] : mentionedAssets;

    let referenceClipUrl = shot.referenceClipUrl;
    let referenceAudioUrl = shot.referenceAudioUrl;
    let referenceClipPreviewUrl = shot.referenceClipPreviewUrl;
    let referenceAudioPreviewUrl = shot.referenceAudioPreviewUrl;
    let previousShotClipSec = Math.min(Math.max(Number(shot.previousShotClipSec) || 1, 1), 15);
    let previewSource: { videoUrl: string; sourceShotId: string } | undefined;
    if (!useFirstFrameMode && shot.usePreviousShotClip) {
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
    const nextUsePreviousShotClip = useFirstFrameMode ? false : Boolean(referenceClipUrl);
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
      assetIds: assets.map((asset) => asset.id)
    };
    const pendingRender = createPendingShotRender(shot, assets);
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
        assetIds: shot.assetIds,
        renders: nextRenders,
        status: "generating",
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
    if (canUseBytePlusSeedance()) {
      void startSeedanceVideoTask(shot, pendingRender.id, generationAssets);
      return { status: 200, body: shot };
    }

    const videoUrl = await generateShotVideo(shot, generationAssets);
    const cachedVideo = await cacheVideoOrKeepRemote(videoUrl, pendingRender.id);
    const render: ShotRender = {
      ...pendingRender,
      videoUrl: cachedVideo.videoUrl,
      remoteVideoUrl: cachedVideo.remoteVideoUrl,
      status: "ready",
      error: undefined,
      note: appendCacheWarning(pendingRender.note, cachedVideo.warning)
    };
    return {
      status: 200,
      body: await store.updateShot(shot.id, {
        videoUrl: cachedVideo.videoUrl,
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
    note: shot.debugNote,
    generationStartedAt: new Date().toISOString(),
    createdAt: new Date().toISOString()
  };
}

async function startSeedanceVideoTask(shot: Shot, renderId: string, assets: Asset[]) {
  try {
    const task = await createSeedanceVideoTask(shot, assets);
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
      error: undefined
    });
  } catch (error) {
    const current = store.getShot(shot.id);
    await store.updateShotRender(shot.id, renderId, {
      status: "error",
      generationTaskId: undefined,
      generationStartedAt: undefined,
      error: error instanceof Error ? error.message : "Seedance task creation failed"
    });
    if (current?.status === "generating") {
      await store.updateShot(shot.id, {
        status: current.videoUrl ? "ready" : "error",
        error: error instanceof Error ? error.message : "Seedance task creation failed"
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
      const cachedVideo = await cacheVideoOrKeepRemote(result.videoUrl, pendingRender?.id || `shot-${shot.id}`);
      if (pendingRender) {
        nextShot =
          (await store.updateShotRender(shot.id, pendingRender.id, {
            status: "ready",
            videoUrl: cachedVideo.videoUrl,
            remoteVideoUrl: cachedVideo.remoteVideoUrl,
            generationTaskId: undefined,
            generationStartedAt: undefined,
            error: undefined,
            note: appendCacheWarning(pendingRender.note, cachedVideo.warning)
          })) || shot;
      }
      const shouldSelectCompletedRender = shot.status === "generating" || !shot.videoUrl;
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
    return res.json(await store.updateShot(shot.id, { error: undefined }));
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
    res.status(500).json({ error: error instanceof Error ? error.message : "Seedance polling failed" });
  }
});

function findPendingRender(shot: Shot) {
  return (shot.renders || []).find((render) => render.status === "generating" || Boolean(render.generationTaskId));
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
    usePreviousShotClip: render.usePreviousShotClip,
    previousShotClipSec: render.previousShotClipSec,
    previousShotClipSecOverride: render.previousShotClipSecOverride,
    referenceClipUrl: render.referenceClipUrl,
    referenceAudioUrl: render.referenceAudioUrl,
    referenceClipPreviewUrl: render.referenceClipPreviewUrl,
    referenceAudioPreviewUrl: render.referenceAudioPreviewUrl,
    firstFrameAssetId: render.firstFrameAssetId
  };
}

app.post("/api/sessions/:sessionId/stitch", async (req, res) => {
  const result = await triggerStitchJob(req.params.sessionId);
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
  sessionId: string
): Promise<{ session: ReturnType<CinemaStore["getSession"]> } | { status: number; error: string }> {
  const session = store.getSession(sessionId);
  if (!session) return { status: 404, error: "Session not found" };
  const readyShots = session.shots
    .filter((shot) => shot.videoUrl)
    .sort((a, b) => a.index - b.index);
  if (!readyShots.length) return { status: 400, error: "No generated shots to stitch" };

  const signature = computeStitchSignaturePreview(readyShots);

  if (session.finalVideoUrl && session.finalVideoSignature === signature && session.stitchStatus !== "running") {
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

  const inflightSignature = stitchInflight.get(sessionId);
  if (inflightSignature === signature) {
    return { session };
  }
  if (inflightSignature && inflightSignature !== signature) {
    console.warn(
      `[stitch ${sessionId}] new request signature=${signature} arrived while signature=${inflightSignature} still running; rejecting to avoid double work`
    );
    return { status: 409, error: "A stitch job for an earlier version is still running. Please wait for it to finish." };
  }

  stitchInflight.set(sessionId, signature);
  const startedAt = new Date().toISOString();
  const queued = await store.updateSession(sessionId, {
    stitchStatus: "running",
    stitchStartedAt: startedAt,
    stitchUpdatedAt: startedAt,
    stitchError: undefined,
    stitchProgress: "queued",
    stitchRunningSignature: signature
  });

  setImmediate(() => {
    void runStitchJobInBackground(sessionId, readyShots, signature);
  });

  return { session: queued };
}

async function runStitchJobInBackground(sessionId: string, readyShots: Shot[], signature: string) {
  const startedAt = Date.now();
  try {
    const result = await stitchShotVideos(sessionId, readyShots, {
      onProgress: async (phase) => {
        await store.updateSession(sessionId, {
          stitchProgress: phase,
          stitchUpdatedAt: new Date().toISOString()
        });
      }
    });
    await store.updateSession(sessionId, {
      finalVideoUrl: result.finalVideoUrl,
      finalVideoSignature: result.signature,
      stitchStatus: "ready",
      stitchUpdatedAt: new Date().toISOString(),
      stitchError: undefined,
      stitchProgress: "",
      stitchRunningSignature: undefined
    });
    console.log(
      `[stitch ${sessionId}] DONE in ${((Date.now() - startedAt) / 1000).toFixed(1)}s -> ${result.finalVideoUrl}`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[stitch ${sessionId}] FAILED in ${((Date.now() - startedAt) / 1000).toFixed(1)}s: ${message}`);
    await store.updateSession(sessionId, {
      stitchStatus: "error",
      stitchError: message,
      stitchUpdatedAt: new Date().toISOString(),
      stitchProgress: "",
      stitchRunningSignature: undefined
    });
  } finally {
    if (stitchInflight.get(sessionId) === signature) {
      stitchInflight.delete(sessionId);
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
  const vite = await createViteServer({
    server: { middlewareMode: true },
    appType: "spa"
  });
  app.use(vite.middlewares);
}

app.listen(port, () => {
  console.log(`reelyai-agent is running at http://localhost:${port}`);
});
