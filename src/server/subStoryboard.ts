import type { Asset, SessionLanguage, SubStoryboardModel } from "../shared/types";
import { composeSeedreamSubStoryboardGrid, type SubStoryboardReferenceLabel } from "./promptCompose";
import { fetchWithRetry } from "./fetchWithRetry";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { MEDIA_DIR, runFfmpegCommand } from "./generators";

const BYTEPLUS_SEEDANCE_BASE = "https://ark.ap-southeast.bytepluses.com/api/v3";
const SEEDREAM_DEFAULT_MODEL = "seedream-4-5-251128";
const SEEDREAM_4_DEFAULT_MODEL = "seedream-4-0-250828";

const apiBase = () =>
  (process.env.SEEDREAM_API_BASE || process.env.SEEDANCE_API_BASE || BYTEPLUS_SEEDANCE_BASE).replace(/\/$/, "");

const apiKey = () =>
  process.env.SEEDREAM_API_KEY || process.env.BP_ARK_API_KEY || process.env.ARK_API_KEY;

/**
 * Pick the actual model id for the requested variant. Allows ops to override per-variant via env
 * (SEEDREAM_45_MODEL / SEEDREAM_4_MODEL) without touching code.
 */
const resolveModel = (variant: SubStoryboardModel = "seedream-4-5") => {
  if (variant === "seedream-4") {
    return process.env.SEEDREAM_4_MODEL || process.env.SEEDREAM_MODEL || SEEDREAM_4_DEFAULT_MODEL;
  }
  return process.env.SEEDREAM_45_MODEL || process.env.SEEDREAM_4_5_MODEL || SEEDREAM_DEFAULT_MODEL;
};

export interface GenerateSubStoryboardOpts {
  /** Free-text scene description: subject, action arc, style, mood, character identity. */
  scenePrompt: string;
  /** Number of sub-panels to compose into one grid (Seedance reads them as a timeline). 4–12 is the sweet spot. */
  panelCount: number;
  /**
   * Optional layout hint, e.g. "3x3", "4x3", "2x4". When omitted we derive a sensible default
   * from panelCount. Seedance is permissive — what matters is that all panels are visible in a
   * single composite image.
   */
  layout?: string;
  /** Seedream size knob, default `4K` per env / project default. */
  size?: string;
  /** Output language for the auto-composed Seedream grid prompt. Default `"zh"`. */
  lang?: SessionLanguage;
  /** When set, overrides the auto-composed Seedream prompt verbatim (post user-edit). */
  promptOverride?: string;
  /**
   * Reference image URLs (https://, /media/, or data:) to anchor identity/style across panels.
   * The CRITICAL knob for cross-shot character consistency: pass the same character asset URLs
   * here for every shot's sub-storyboard, and Seedream will reproduce the same face/wardrobe in
   * every panel of every shot. Without this, the model only follows the text and re-rolls a fresh
   * "look" per call. Up to ~3 references in practice (Seedream caps total payload bytes).
   */
  referenceImageUrls?: string[];
  /**
   * Optional human labels for each reference image. Index in this array MUST line up with
   * `referenceImageUrls` — they are emitted into the prompt as `image_1: <label>` so Seedream
   * binds identity per character ("image_1 = 老板", "image_2 = 年轻员工"). Without labels the
   * model has to guess which attached image is which character, which is the leading cause of
   * face drift across panels.
   */
  referenceImageLabels?: string[];
  /**
   * Optional model variant. Defaults to "seedream-4-5". Drives the model id Seedream actually runs.
   */
  modelVariant?: SubStoryboardModel;
}

export interface SubStoryboardResult {
  url: string;
  size: string;
  panelCount: number;
  layout: string;
  model: string;
  /** The Seedream prompt actually submitted (auto-composed or override). */
  composedPrompt: string;
  /** URLs that were sent to Seedream as `image:` reference inputs (already-resolved https URLs). */
  referenceImageUrls: string[];
  rawUsage?: unknown;
}

/**
 * Drive Seedream to produce ONE composite grid image that contains all sub-panels of a single
 * shot, as a continuous storyboard. The returned image is intended to be passed to Seedance as a
 * normal `reference_image` along with the `Follow the storyboard sequence of the N reference
 * frames` magic instruction (see `buildSubShotSequenceInstruction` in generators.ts) — Seedance
 * then produces ONE video that internally cuts through the panels in order.
 *
 * Reference: EvoLink GPT-Image-2 / Seedance 2.0 community playbook (Cases 2 + 10):
 * https://github.com/EvoLinkAI/GPT-Image-2-Seedance2-Workflow
 */
export async function generateSubStoryboardGrid(opts: GenerateSubStoryboardOpts): Promise<SubStoryboardResult> {
  const key = apiKey();
  if (!key) throw new Error("Missing Seedream API key (SEEDREAM_API_KEY / BP_ARK_API_KEY / ARK_API_KEY)");

  const panelCount = Math.max(2, Math.min(16, Math.floor(opts.panelCount)));
  const layout = (opts.layout || pickLayout(panelCount)).trim();
  const model = resolveModel(opts.modelVariant);
  // Aspect-ratio-aware size: if the user is making vertical shots (9:16) the storyboard grid
  // panels should also be 9:16, so the composite size matches. We sniff a "vertical" signal from
  // the scene prompt; otherwise stick with the env-default 4K. Caller can still
  // override via opts.size to force any explicit "WxH" string.
  const verticalHint = /(?:9\s*[:×x]\s*16|竖屏|竖构图|portrait\s+orientation)/i.test(opts.scenePrompt);
  const defaultSize = process.env.SEEDREAM_SIZE
    || (verticalHint ? "2304x4096" : "4K");
  const size = opts.size || defaultSize;
  const lang: SessionLanguage = opts.lang === "en" ? "en" : "zh";

  // Compose Seedream grid prompt: caller override > centralized composer (zh by default).
  const refLabels: SubStoryboardReferenceLabel[] = [];
  // Reference images: only keep direct https URLs (Seedream's `image` field doesn't accept
  // /media/ or data: URLs from the inline composer path — those need a separate pre-upload).
  // Cap at 3 to keep payload size predictable; first ones win (caller orders by importance).
  const refUrls = (opts.referenceImageUrls || [])
    .filter((url) => typeof url === "string" && /^https?:\/\//.test(url))
    .slice(0, 3);
  // Build refLabels parallel to refUrls so the prompt's `image_N: <label>` lines line up with
  // the actual `image` array sent to Seedream. We re-derive imageNumber after the URL filter so
  // a dropped (non-https) URL doesn't shift the numbering.
  refUrls.forEach((url, i) => {
    const sourceIndex = (opts.referenceImageUrls || []).indexOf(url);
    const label = (opts.referenceImageLabels && sourceIndex >= 0 ? opts.referenceImageLabels[sourceIndex] : "")
      || `参考角色 ${i + 1}`;
    refLabels.push({ imageNumber: i + 1, label });
  });

  const composedPrompt = opts.promptOverride && opts.promptOverride.trim().length > 0
    ? opts.promptOverride
    : composeSeedreamSubStoryboardGrid(opts.scenePrompt, panelCount, layout, lang, refLabels).composedPrompt;

  const response = await fetchWithRetry(`${apiBase()}/images/generations`, {
    method: "POST",
    timeoutMs: 90_000,
    tag: "seedream:sub-storyboard",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${key}`
    },
    body: JSON.stringify({
      model,
      prompt: composedPrompt,
      // Single composite image — NOT group mode. We want ONE grid not N separate panels.
      sequential_image_generation: "disabled",
      ...(refUrls.length ? { image: refUrls.length === 1 ? refUrls[0] : refUrls } : {}),
      response_format: "url",
      size,
      stream: false,
      watermark: false
    })
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Seedream sub-storyboard grid failed: ${response.status} ${text.slice(0, 800)}`);
  }
  const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  const data = body.data;
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(`Seedream returned no grid: ${text.slice(0, 500)}`);
  }
  const first = data[0] as Record<string, unknown> | undefined;
  const url = typeof first?.url === "string" ? first.url : undefined;
  const sizeStr = typeof first?.size === "string" ? first.size : size;
  if (!url) throw new Error(`Seedream grid response missing url: ${text.slice(0, 500)}`);

  return { url, size: sizeStr, panelCount, layout, model, composedPrompt, referenceImageUrls: refUrls, rawUsage: body.usage };
}

function pickLayout(panelCount: number): string {
  // Prefer balanced near-square grids — Seedance handles square composites best.
  if (panelCount <= 4) return "2x2";
  if (panelCount <= 6) return "3x2";
  if (panelCount === 7 || panelCount === 8) return "4x2";
  if (panelCount === 9) return "3x3";
  if (panelCount <= 12) return "4x3";
  if (panelCount <= 16) return "4x4";
  return `${Math.ceil(Math.sqrt(panelCount))}x${Math.ceil(panelCount / Math.ceil(Math.sqrt(panelCount)))}`;
}

// Note: the local composeGridPrompt was retired in favor of `composeSeedreamSubStoryboardGrid`
// in promptCompose.ts (centralized, language-aware).

/**
 * Convenience: turn a SubStoryboardResult into the partial Asset payload that should be persisted
 * into the store as a shot-scoped reference asset. Caller wires the returned object through
 * `store.upsertAsset` and then sets `shot.subShotStoryboardAssetId` to the resulting asset id.
 */
export function buildSubStoryboardAssetPayload(
  shotId: string,
  shotTitle: string,
  scenePrompt: string,
  result: SubStoryboardResult
): Partial<Asset> {
  return {
    name: `${shotTitle} 子分镜板 (${result.layout}, ${result.panelCount} panels)`,
    type: "scene",
    mediaKind: "image",
    description: `Sub-shot storyboard grid for shot, ${result.panelCount} panels in ${result.layout} layout. Driven by Seedance with the storyboard-sequence instruction.`,
    prompt: scenePrompt,
    tags: ["sub-storyboard", "shot-scoped"],
    ownerShotId: shotId,
    mediaUrl: result.url,
    imageUrl: result.url,
    generationModel: "seedream-4-5"
  };
}

// ============================================================================
// Sequential mode — one Seedream call per panel, then ffmpeg-composite into a single grid.
// ============================================================================

export interface SequentialPanelSpec {
  /**
   * Per-panel beat prompt. The caller writes one description per panel; this helper handles all
   * the cross-panel style/identity wording itself by using shared `referenceImageUrls` plus the
   * previously-generated panel as a reference image on every subsequent call.
   */
  prompt: string;
}

export interface GenerateSubStoryboardSequentialOpts {
  /** Per-panel beat prompts in time order. The grid is composed in this order, no shuffling. */
  panels: SequentialPanelSpec[];
  /**
   * Layout for the composite output: "Nx1" (horizontal strip), "1xN" (vertical strip), "2x2",
   * "3x3", etc. Default picks based on panels.length. The composite is built by ffmpeg locally
   * — Seedream never sees the layout, only the per-panel prompt.
   */
  layout?: string;
  /** Per-panel Seedream size, default `2304x4096` (vertical 9:16 4K). */
  panelSize?: string;
  /**
   * Cross-panel reference images (https URLs) for character/scene identity continuity. Same set
   * is passed to every Seedream call, in addition to the previously-generated panel image (which
   * is auto-injected as the last reference for panels 2..N).
   */
  referenceImageUrls?: string[];
  /** Output language for the per-panel auto-composer. Default "zh". */
  lang?: SessionLanguage;
  /** Model variant. Default "seedream-4-5". */
  modelVariant?: SubStoryboardModel;
  /**
   * Caller-provided file slug for the local composite output. Helps debugging when many sub-
   * storyboards are generated in parallel for a session.
   */
  outputLabel?: string;
}

export interface SubStoryboardSequentialResult {
  /** Local /media/... URL of the composite grid image (the asset's mediaUrl). */
  compositeUrl: string;
  /** Each panel's Seedream-returned remote URL, in order. Useful for re-stitching or audit. */
  panelUrls: string[];
  layout: string;
  panelCount: number;
  panelSize: string;
  model: string;
  /** The per-panel Seedream prompts actually submitted (auto-composed; no override path). */
  panelPrompts: string[];
}

/**
 * Generate N panels via N separate Seedream single-image calls (each conditioning on the
 * previous panel + shared reference images for identity), download them, and ffmpeg-tile them
 * into ONE composite grid image. The composite is what gets bound to the shot as
 * `subShotStoryboardAssetId` so Seedance reads it as `image1` per the existing
 * `composeSubShotSequenceInstruction` contract.
 *
 * Why this exists: Seedream's group-call (sub-storyboard composite) mode lays out N beats in a
 * grid but order is a soft constraint — the model often shuffles which cell holds which beat,
 * so Seedance reads them out-of-order and the rendered video has time-jumps ("boss is striking
 * → boss is calmly reading → boss is dead → boss is reading again"). This helper guarantees
 * panel order matches the caller's `panels[i]` index.
 */
export async function generateSubStoryboardSequential(
  opts: GenerateSubStoryboardSequentialOpts
): Promise<SubStoryboardSequentialResult> {
  const key = apiKey();
  if (!key) throw new Error("Missing Seedream API key (SEEDREAM_API_KEY / BP_ARK_API_KEY / ARK_API_KEY)");
  if (!opts.panels?.length) throw new Error("generateSubStoryboardSequential: panels required");

  const panelCount = opts.panels.length;
  const layout = (opts.layout || pickLayout(panelCount)).trim();
  const model = resolveModel(opts.modelVariant);
  // Sequential mode does ffmpeg-tiling, which needs an explicit WxH for each panel. The Seedream
  // size token ("1K"/"2K"/"4K") is fine for the Seedream call itself but ffmpeg can't parse it,
  // so any non-WxH value gets normalized to a vertical 9:16 4K default here.
  const panelSizeRaw = opts.panelSize || process.env.SEEDREAM_SIZE || "2304x4096";
  const panelSize = /^\d+x\d+$/.test(panelSizeRaw) ? panelSizeRaw : "2304x4096";
  const lang: SessionLanguage = opts.lang === "en" ? "en" : "zh";

  const sharedRefs = (opts.referenceImageUrls || [])
    .filter((u) => typeof u === "string" && /^https?:\/\//.test(u))
    .slice(0, 2);

  // Generate panel by panel. Each panel sees: shared character/scene refs + previous panel.
  const panelUrls: string[] = [];
  const panelPrompts: string[] = [];
  for (let i = 0; i < panelCount; i += 1) {
    const beat = opts.panels[i].prompt.trim();
    const panelPrompt = buildSequentialPanelPrompt({
      beatIndex: i,
      totalBeats: panelCount,
      beatBody: beat,
      isFirst: i === 0,
      lang
    });
    panelPrompts.push(panelPrompt);
    const refs: string[] = [...sharedRefs];
    if (i > 0) {
      // Inject previous panel as the last reference so Seedream carries forward composition,
      // lighting, and character/wardrobe details into the next beat.
      refs.push(panelUrls[i - 1]);
    }
    const refsCapped = refs.slice(0, 3);

    const response = await fetchWithRetry(`${apiBase()}/images/generations`, {
      method: "POST",
      timeoutMs: 90_000,
      tag: `seedream:sub-storyboard-seq[${i + 1}/${panelCount}]`,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${key}`
      },
      body: JSON.stringify({
        model,
        prompt: panelPrompt,
        sequential_image_generation: "disabled",
        ...(refsCapped.length ? { image: refsCapped.length === 1 ? refsCapped[0] : refsCapped } : {}),
        response_format: "url",
        size: panelSize,
        stream: false,
        watermark: false
      })
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Seedream sub-storyboard sequential panel ${i + 1} failed: ${response.status} ${text.slice(0, 500)}`);
    }
    const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    const data = Array.isArray(body.data) ? body.data : [];
    const first = data[0] as Record<string, unknown> | undefined;
    const url = typeof first?.url === "string" ? first.url : undefined;
    if (!url) throw new Error(`Seedream sequential panel ${i + 1} missing url: ${text.slice(0, 300)}`);
    panelUrls.push(url);
  }

  // Composite via ffmpeg into ONE image with the requested layout.
  const compositeUrl = await ffmpegCompositePanels({
    panelUrls,
    layout,
    panelSize,
    outputLabel: opts.outputLabel || "sub-storyboard-seq"
  });

  return {
    compositeUrl,
    panelUrls,
    layout,
    panelCount,
    panelSize,
    model,
    panelPrompts
  };
}

/**
 * Auto-compose a per-panel Seedream prompt that wraps the caller's beat description with the
 * cross-panel rules (do not redraw the grid, follow the previous panel for identity, vertical
 * 9:16 framing). The first panel skips the "follow previous panel" wording since none exists.
 */
function buildSequentialPanelPrompt(args: {
  beatIndex: number;
  totalBeats: number;
  beatBody: string;
  isFirst: boolean;
  lang: SessionLanguage;
}): string {
  const { beatIndex, totalBeats, beatBody, isFirst, lang } = args;
  if (lang === "en") {
    const lines = [
      `One realistic vertical 9:16 still frame depicting beat ${beatIndex + 1} of ${totalBeats} in a continuous timeline.`,
      "Output a single full-frame still — no grid, no panel borders, no text overlays, no captions.",
      isFirst
        ? "This is the opening beat. Establish the scene cleanly."
        : `Maintain perfect continuity with the previous panel that is provided as the last reference image: keep the same characters' face/wardrobe, same camera framing, same lighting and color palette. Only the action changes from the prior beat to this one.`,
      "",
      beatBody.trim()
    ];
    return lines.join("\n");
  }
  const lines = [
    `生成单张写实竖屏 9:16 静帧，对应一个连续故事板时间线中的第 ${beatIndex + 1} 个节拍（共 ${totalBeats} 个节拍）。`,
    "输出整张全画幅静帧——不要画网格，不要面板边框，不要文字字幕，不要标号。",
    isFirst
      ? "这是开场节拍。把场景与人物干净建立起来。"
      : "严格延续上一节拍：上一节拍图作为最后一张参考附在底部，请保持相同人物面孔/服装、相同机位构图、相同光线与色调；仅动作从上一节拍演化到本节拍。",
    "",
    beatBody.trim()
  ];
  return lines.join("\n");
}

interface CompositeOpts {
  panelUrls: string[];
  layout: string;
  panelSize: string;
  outputLabel: string;
}

/**
 * Download each panel locally, then ffmpeg-tile into a single composite image. Layout strings
 * like "2x2" / "3x2" / "1x4" / "4x1" are parsed as `colsXrows`. Panels read left-to-right,
 * top-to-bottom (which is what the existing Seedance sub-shot-sequence instruction expects).
 */
async function ffmpegCompositePanels(opts: CompositeOpts): Promise<string> {
  await mkdir(MEDIA_DIR, { recursive: true });
  const layoutMatch = opts.layout.match(/^(\d+)x(\d+)$/);
  if (!layoutMatch) throw new Error(`ffmpegCompositePanels: invalid layout ${opts.layout}`);
  const cols = Math.max(1, Number(layoutMatch[1]));
  const rows = Math.max(1, Number(layoutMatch[2]));
  if (cols * rows < opts.panelUrls.length) {
    throw new Error(
      `ffmpegCompositePanels: layout ${opts.layout} has ${cols * rows} cells but ${opts.panelUrls.length} panels`
    );
  }

  const sizeMatch = opts.panelSize.match(/^(\d+)x(\d+)$/);
  if (!sizeMatch) throw new Error(`ffmpegCompositePanels: panelSize must be WxH, got ${opts.panelSize}`);
  const panelW = Math.max(64, Number(sizeMatch[1]));
  const panelH = Math.max(64, Number(sizeMatch[2]));

  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const safeLabel = opts.outputLabel.replace(/[^a-z0-9-]+/gi, "-").slice(0, 40) || "panel";
  const tempPaths: string[] = [];
  try {
    // Download each panel to a local file.
    for (let i = 0; i < opts.panelUrls.length; i += 1) {
      const tempPath = path.join(MEDIA_DIR, `${safeLabel}-${stamp}-${i}.jpg`);
      const res = await fetch(opts.panelUrls[i]);
      if (!res.ok) throw new Error(`download panel ${i + 1} failed: ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      await writeFile(tempPath, buf);
      tempPaths.push(tempPath);
    }

    // Build ffmpeg xstack args. Each panel is scaled to panelSize first, then placed by xstack.
    // We use the simpler "tile" filter when the layout is a single row OR single column; for
    // arbitrary CxR we use xstack with explicit positions.
    const outName = `${safeLabel}-${stamp}-composite.jpg`;
    const outPath = path.join(MEDIA_DIR, outName);
    const inputArgs: string[] = [];
    for (const p of tempPaths) {
      inputArgs.push("-i", p);
    }

    // Pad panels to all-equal dimensions with scale, then tile.
    const filterPieces: string[] = [];
    for (let i = 0; i < tempPaths.length; i += 1) {
      filterPieces.push(`[${i}:v]scale=${panelW}:${panelH}:force_original_aspect_ratio=decrease,pad=${panelW}:${panelH}:(ow-iw)/2:(oh-ih)/2:color=black[p${i}]`);
    }
    const xstackInputs = tempPaths.map((_, i) => `[p${i}]`).join("");
    // Build explicit layout positions for xstack: "0_0|w0_0|0_h0|w0_h0" etc. xstack requires a
    // layout string of "x_y" pairs separated by "|", one per input.
    const positions: string[] = [];
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        const idx = r * cols + c;
        if (idx >= tempPaths.length) break;
        const xExpr = c === 0 ? "0" : Array.from({ length: c }, (_, k) => `w${k}`).join("+");
        const yExpr = r === 0 ? "0" : Array.from({ length: r }, (_, k) => `h${k * cols}`).join("+");
        positions.push(`${xExpr}_${yExpr}`);
      }
    }
    const filter = `${filterPieces.join(";")};${xstackInputs}xstack=inputs=${tempPaths.length}:layout=${positions.join("|")}:fill=black[v]`;

    await runFfmpegCommand([
      "-y",
      ...inputArgs,
      "-filter_complex",
      filter,
      "-map",
      "[v]",
      "-q:v",
      "2",
      outPath
    ]);

    return `/media/${outName}`;
  } finally {
    await Promise.all(tempPaths.map((p) => unlink(p).catch(() => undefined)));
  }
}
