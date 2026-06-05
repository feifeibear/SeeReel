import type { Asset, Shot } from "../shared/types";
import { fetchWithRetry } from "./fetchWithRetry";
import { arkMissingKeyMessage, resolveArkCredential } from "./arkCredentials";
import { seedreamWebSearchPayload } from "./seedreamOptions";

const BYTEPLUS_SEEDANCE_BASE = "https://ark.ap-southeast.bytepluses.com/api/v3";
const SEEDREAM_DEFAULT_MODEL = "seedream-4-5-251128";
const AGENT_PLAN_SEEDREAM_MODEL = "doubao-seedream-5.0-lite";

const SEEDREAM_KEY_ENVS = ["SEEDREAM_API_KEY", "BP_ARK_API_KEY", "ARK_API_KEY"];

const credential = () =>
  resolveArkCredential({
    keyEnvNames: SEEDREAM_KEY_ENVS,
    baseEnvNames: ["SEEDREAM_API_BASE", "SEEDANCE_API_BASE"],
    defaultBase: BYTEPLUS_SEEDANCE_BASE
  });

const resolveModel = (usesAgentPlan = false) =>
  usesAgentPlan
    ? process.env.SEEDREAM_AGENT_PLAN_MODEL || AGENT_PLAN_SEEDREAM_MODEL
    : process.env.SEEDREAM_45_MODEL || process.env.SEEDREAM_4_5_MODEL || process.env.SEEDREAM_MODEL || SEEDREAM_DEFAULT_MODEL;

export interface GenerateStoryboardGridOpts {
  prompt: string;
  panelCount: number;
  size?: string;
  /**
   * Optional remote https reference images. Seedream group generation accepts an `image` array as
   * conditioning input — each panel is biased toward the visual content of the references while the
   * prompt drives the variation across panels. Pass real-photo URLs here to get photorealistic
   * keyframes instead of hallucinated stock-photo aesthetic.
   */
  referenceImageUrls?: string[];
}

export interface StoryboardGridResult {
  panels: Array<{ url: string; size?: string }>;
  model: string;
  rawUsage?: unknown;
}

/**
 * Drive Seedream's group-generation mode to produce N stylistically-consistent panels in a single
 * call. Each panel is returned with a remote https URL that's directly consumable by Seedance as a
 * first/last frame anchor. This is the heart of the storyboard-to-cinematic-video workflow: by
 * having all panels born of the same call (same seed, same shared latent context), character /
 * lighting / palette consistency comes for free, and we don't need to wire up an IP-Adapter.
 */
export async function generateStoryboardGrid(opts: GenerateStoryboardGridOpts): Promise<StoryboardGridResult> {
  const ark = credential();
  if (!ark.apiKey) throw new Error(arkMissingKeyMessage("Seedream", SEEDREAM_KEY_ENVS));

  const panelCount = Math.max(2, Math.min(10, Math.floor(opts.panelCount)));
  const model = resolveModel(ark.source === "agent-plan");
  const size = opts.size || process.env.SEEDREAM_SIZE || "4K";

  const response = await fetchWithRetry(`${ark.apiBase}/images/generations`, {
    method: "POST",
    timeoutMs: 240_000,
    tag: "seedream:storyboard-grid",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${ark.apiKey}`
    },
    body: JSON.stringify({
      model,
      prompt: opts.prompt,
      sequential_image_generation: "auto",
      sequential_image_generation_options: { max_images: panelCount },
      response_format: "url",
      size,
      stream: false,
      watermark: false,
      ...seedreamWebSearchPayload(),
      ...(opts.referenceImageUrls && opts.referenceImageUrls.length > 0
        ? { image: opts.referenceImageUrls.filter((url) => /^(https?|data):/i.test(url)) }
        : {})
    })
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Seedream group generation failed: ${response.status} ${text.slice(0, 800)}`);
  }
  const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  const data = body.data;
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(`Seedream returned no panels: ${text.slice(0, 500)}`);
  }
  const panels = data
    .map((item): { url: string; size?: string } | undefined => {
      if (!item || typeof item !== "object") return undefined;
      const rec = item as Record<string, unknown>;
      const url = typeof rec.url === "string" ? rec.url : undefined;
      const sizeStr = typeof rec.size === "string" ? rec.size : undefined;
      return url ? { url, size: sizeStr } : undefined;
    })
    .filter((p): p is { url: string; size?: string } => Boolean(p));
  if (!panels.length) {
    throw new Error(`Seedream returned no usable panel URLs: ${text.slice(0, 500)}`);
  }
  return { panels, model, rawUsage: body.usage };
}

export interface AssignFramesOpts {
  /** Session shots in index order, length must equal panels.length - 1 (N panels → N-1 transitions). */
  shots: Shot[];
  /** Asset rows already created for each panel, in panel order. */
  panelAssets: Asset[];
}

/**
 * Patch each shot so shot[i].firstFrameAssetId = panelAssets[i].id and
 * shot[i].lastFrameAssetId = panelAssets[i+1].id. Returns the list of patches the caller should
 * push into the store via updateShot.
 */
export function buildShotFrameAssignments(opts: AssignFramesOpts): Array<{ shotId: string; patch: Partial<Shot> }> {
  const out: Array<{ shotId: string; patch: Partial<Shot> }> = [];
  for (let i = 0; i < opts.shots.length; i += 1) {
    const first = opts.panelAssets[i];
    const last = opts.panelAssets[i + 1];
    if (!first || !last) break;
    out.push({
      shotId: opts.shots[i].id,
      patch: {
        firstFrameAssetId: first.id,
        lastFrameAssetId: last.id,
        // Frame anchors are mutually exclusive with previous-shot continuity reference (per
        // BytePlus Seedance docs). Clear continuity so the payload builder picks first/last frame.
        usePreviousShotClip: false,
        referenceClipUrl: null,
        referenceAudioUrl: null,
        referenceClipPreviewUrl: null,
        referenceAudioPreviewUrl: null
      }
    });
  }
  return out;
}
