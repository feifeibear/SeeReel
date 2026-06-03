import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import ffmpeg from "@ffmpeg-installer/ffmpeg";
import type { Asset, AssetImageModel, SessionWithShots, Shot, StoryBeat, StoryPlan } from "../shared/types";
import { composeSeedanceVideoText, composeSeedreamAssetPrompt, type Lang } from "./promptCompose";
import { fetchWithRetry } from "./fetchWithRetry";
import { arkMissingKeyMessage, resolveArkCredential, type ArkCredential } from "./arkCredentials";
import { seedreamWebSearchPayload } from "./seedreamOptions";

export interface BuildSeedancePayloadOpts {
  /** Override the assembled text content. Used when the user audited & edited the dryRun preview. */
  prebuiltText?: string;
  /** Output language for the auto-composed text. Default `"zh"`. Ignored when `prebuiltText` is set. */
  lang?: Lang;
  /**
   * Per-shot override for Seedance's `generate_audio` flag. `true` forces audio on, `false`
   * forces audio off, `undefined` falls through to env `SEEDANCE_GENERATE_AUDIO` (default true
   * unless that env equals "false"). Used when the caller wants a clean silent video — Seedance's
   * auto-generated dialogue is often gibberish and cleaner to suppress than to direct via prompt.
   */
  generateAudio?: boolean;
  /** Request-scoped credential captured before handing work to background tasks. */
  credential?: ArkCredential;
}

export const MEDIA_DIR = path.resolve(process.cwd(), "data", "media");
const BYTEPLUS_SEEDANCE_BASE = "https://ark.ap-southeast.bytepluses.com/api/v3";
const BYTEPLUS_SEEDANCE_MODEL = "dreamina-seedance-2-0-260128";
const BYTEPLUS_SEEDANCE_FAST_MODEL = "dreamina-seedance-2-0-fast-260128";
const AGENT_PLAN_SEEDANCE_MODEL = "doubao-seedance-2-0-260128";
const AGENT_PLAN_SEEDANCE_FAST_MODEL = "doubao-seedance-2-0-fast-260128";
const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled", "canceled"]);
const STITCH_SIGNATURE_VERSION = "stitch-v3-crf18-high";
const openAIKey = () => process.env.OAI_KEY || process.env.OPENAI_API_KEY;
export const seedanceTimeoutMs = () => Number(process.env.SEEDANCE_TIMEOUT_MS || 30 * 60 * 1000);
const stitchDownloadConcurrency = () => Math.max(1, Number(process.env.STITCH_DOWNLOAD_CONCURRENCY || 2));
const ffmpegLogBytes = () => Math.max(1024, Number(process.env.STITCH_FFMPEG_LOG_BYTES || 4096));

const jsonHeaders = (apiKey?: string) => ({
  "Content-Type": "application/json",
  ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
});

const SEED_PROMPT_KEY_ENVS = ["SEED_PROMPT_API_KEY", "BP_ARK_API_KEY", "ARK_API_KEY"];
const SEEDREAM_KEY_ENVS = ["SEEDREAM_API_KEY", "BP_ARK_API_KEY", "ARK_API_KEY"];
const SEEDANCE_KEY_ENVS = ["BP_ARK_API_KEY", "SEEDANCE_API_KEY", "ARK_API_KEY"];

/**
 * Guard against "silent fake success": when a paid model key is missing the dev paths return a
 * placeholder image/video URL so the canvas still renders something. In production that would make a
 * misconfigured deployment look like it is generating real media. Refuse explicitly instead.
 */
function refuseFakeSuccessInProduction(label: string, keyEnvs: string[]): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error(arkMissingKeyMessage(label, keyEnvs));
  }
}

function seedPromptCredential() {
  return resolveArkCredential({
    keyEnvNames: SEED_PROMPT_KEY_ENVS,
    baseEnvNames: ["SEED_PROMPT_API_BASE", "SEEDANCE_API_BASE"],
    defaultBase: BYTEPLUS_SEEDANCE_BASE
  });
}

function seedreamCredential() {
  return resolveArkCredential({
    keyEnvNames: SEEDREAM_KEY_ENVS,
    baseEnvNames: ["SEEDREAM_API_BASE", "SEEDANCE_API_BASE"],
    defaultBase: BYTEPLUS_SEEDANCE_BASE
  });
}

export function seedreamCredentialSource() {
  return seedreamCredential().source;
}

export function defaultSeedreamAssetImageModel(): AssetImageModel {
  return seedreamCredentialSource() === "agent-plan" ? "seedream-5-lite" : "seedream-4-5";
}

function seedanceCredential() {
  return resolveArkCredential({
    keyEnvNames: SEEDANCE_KEY_ENVS,
    baseEnvNames: ["SEEDANCE_API_BASE"],
    defaultBase: BYTEPLUS_SEEDANCE_BASE
  });
}

export function resolveSeedanceCredential() {
  return seedanceCredential();
}

export interface StoryboardPlanResult {
  shots: Array<Partial<Shot> & { index?: number }>;
  model?: string;
  rawUsage?: unknown;
}

export interface StoryPlanResult {
  story: StoryPlan;
  model?: string;
  rawUsage?: unknown;
}

export async function generateStoryboard(session: SessionWithShots, assets: Asset[]): Promise<Array<Partial<Shot> & { index?: number }>> {
  return (await generateStoryboardDetailed(session, assets)).shots;
}

export async function generateStoryboardDetailed(session: SessionWithShots, assets: Asset[]): Promise<StoryboardPlanResult> {
  if (session.story?.beats?.length) {
    const shots = session.shots.map((shot, index) => {
      const beat = session.story?.beats.find((item) => item.index === shot.index) || session.story?.beats[index % session.story.beats.length];
      return beat ? shotFromStoryBeat(session, beat, shot, assets) : undefined;
    }).filter(Boolean) as Array<Partial<Shot>>;
    return { shots, model: session.story.model };
  }

  const apiKey = openAIKey();
  if (apiKey) {
    try {
      const model = process.env.OPENAI_TEXT_MODEL || "gpt-4.1-mini";
      const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: jsonHeaders(apiKey),
        body: JSON.stringify({
          model,
          input: [
            {
              role: "system",
              content:
                "You are a short-film storyboard director. Return strict JSON only. Create concise cinematic shot plans in Chinese."
            },
            {
              role: "user",
              content: JSON.stringify({
                title: session.title,
                logline: session.logline,
                style: session.style,
                targetDurationSec: session.targetDurationSec,
                shotCount: session.shots.length,
                assets: assets.map((asset) => ({
                  name: asset.name,
                  type: asset.type,
                  description: asset.description
                })),
                schema: {
                  shots: [
                    {
                      index: 1,
                      title: "short title",
                      script: "what happens on screen",
                      camera: "camera, light, movement",
                      prompt: "video generation prompt"
                    }
                  ]
                }
              })
            }
          ],
          text: { format: { type: "json_object" } }
        })
      });

      if (response.ok) {
        const data = (await response.json()) as { output_text?: string; output?: Array<{ content?: Array<{ text?: string }> }>; usage?: unknown };
        const text = data.output_text || data.output?.flatMap((item) => item.content ?? []).map((item) => item.text).join("");
        if (text) {
          const parsed = JSON.parse(text) as { shots?: Array<Partial<Shot>> };
          if (Array.isArray(parsed.shots) && parsed.shots.length) return { shots: parsed.shots, model, rawUsage: data.usage };
        }
      }
    } catch {
      // Fall through to the local planner so the product workflow remains usable offline.
    }
  }

  const beats = [
    "建立世界和主角当前状态",
    "出现扰动，主角被迫行动",
    "发现关键线索或异常规则",
    "第一次尝试失败，情绪压力上升",
    "资产或场景中的关键细节被重新理解",
    "主角做出不可逆选择",
    "高潮镜头，核心冲突被视觉化",
    "余韵收束，留下短片的最后情绪"
  ];

  const shots = session.shots.map((shot, index) => {
    const beat = beats[index % beats.length];
    const title = `${String(index + 1).padStart(2, "0")} ${beat}`;
    const script = `${session.logline}\n本分镜承担“${beat}”：让画面清晰推进一个叙事动作，并保持人物、场景和道具连续。`;
    const camera =
      index % 3 === 0
        ? "wide establishing shot, slow dolly movement, practical motivated light"
        : index % 3 === 1
          ? "medium close shot, handheld tension, shallow depth of field"
          : "detail insert and reaction shot, precise focus pull, restrained movement";
    const prompt = [
      `Short film: ${session.title}`,
      `Style: ${session.style}`,
      `Shot ${index + 1}: ${title}`,
      `Script: ${script}`,
      `Camera: ${camera}`,
      "Generate a coherent cinematic video shot for Seedance 2.0. Preserve continuity across shots."
    ].join("\n");

    return { index: index + 1, title, script, camera, prompt };
  });
  return { shots, model: "local-template" };
}

export async function generateStoryPlan(session: SessionWithShots, assets: Asset[]): Promise<StoryPlan> {
  return (await generateStoryPlanDetailed(session, assets)).story;
}

export async function generateStoryPlanDetailed(session: SessionWithShots, assets: Asset[]): Promise<StoryPlanResult> {
  if (session.story?.locked) return { story: normalizeStoryPlan(session.story, session, assets, session.story.model || "locked"), model: session.story.model || "locked" };

  const fallback = buildLocalStoryPlan(session, assets);
  const apiKey = openAIKey();
  if (!apiKey) return { story: fallback, model: "local-template" };

  try {
    const model = process.env.OPENAI_TEXT_MODEL || "gpt-4.1-mini";
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: jsonHeaders(apiKey),
      body: JSON.stringify({
        model,
        input: [
          {
            role: "system",
            content:
              "你是电影短篇编剧和导演。只返回严格 JSON，不要 Markdown。生成短片大纲、人物弧线和节拍表，后续会直接派生分镜。"
          },
          {
            role: "user",
            content: JSON.stringify({
              title: session.title,
              logline: session.logline,
              style: session.style,
              targetDurationSec: session.targetDurationSec,
              shotCount: session.shots.length,
              assets: assets.map((asset) => ({
                id: asset.id,
                name: asset.name,
                type: asset.type,
                description: asset.description,
                tags: asset.tags
              })),
              requirements: [
                "synopsis 使用 300-800 中文字",
                "beats 数量必须等于 shotCount",
                "每个 beat 的 durationSec 必须在 1-15 秒之间",
                "assetMentions 使用 @资产名 格式，例如 @男主角/顾沉",
                "不要新增不可拍摄的大段内心独白"
              ],
              schema: {
                premise: "一句话故事",
                synopsis: "300-800字短片大纲",
                theme: "主题",
                tone: "风格/情绪",
                characters: [
                  {
                    name: "角色名",
                    role: "故事功能",
                    arc: "角色变化",
                    assetId: "可选资产id",
                    assetMention: "@资产名"
                  }
                ],
                beats: [
                  {
                    index: 1,
                    title: "节拍标题",
                    purpose: "戏剧功能",
                    plot: "发生什么",
                    emotion: "情绪变化",
                    visual: "画面执行",
                    assetMentions: ["@资产名"],
                    durationSec: 15
                  }
                ],
                locked: false
              }
            })
          }
        ],
        text: { format: { type: "json_object" } }
      })
    });

    if (!response.ok) return { story: fallback, model: "local-template" };
    const data = (await response.json()) as { output_text?: string; output?: Array<{ content?: Array<{ text?: string }> }>; usage?: unknown };
    const text = data.output_text || data.output?.flatMap((item) => item.content ?? []).map((item) => item.text).join("");
    if (!text) return { story: fallback, model: "local-template" };
    return { story: normalizeStoryPlan(JSON.parse(text), session, assets, model), model, rawUsage: data.usage };
  } catch {
    return { story: fallback, model: "local-template" };
  }
}

function shotFromStoryBeat(session: SessionWithShots, beat: StoryBeat, shot: Shot, assets: Asset[]): Partial<Shot> {
  const assetMentions = normalizeAssetMentions(beat.assetMentions);
  const assetText = assetMentions.length ? `\n资产引用：${assetMentions.join(" ")}` : "";
  const script = [`节拍目的：${beat.purpose}`, `剧情动作：${beat.plot}`, `情绪变化：${beat.emotion}`].join("\n");
  const camera = `画面执行：${beat.visual}\n风格基调：${session.story?.tone || session.style}`;
  const prompt = [
    `${assetMentions.join(" ")} ${beat.plot}`.trim(),
    `短片：${session.title}`,
    `剧本节拍 ${beat.index}：${beat.title}`,
    script,
    camera,
    assetText,
    "严格按照本节拍推进，不新增节拍外的反转、人物或对白。"
  ]
    .filter(Boolean)
    .join("\n");

  return {
    index: shot.index,
    storyBeatIndex: beat.index,
    title: beat.title || shot.title,
    script,
    camera,
    rawPrompt: prompt,
    prompt,
    durationSec: Math.min(Math.max(Number(beat.durationSec) || shot.durationSec || 1, 1), 15)
  };
}

function buildLocalStoryPlan(session: SessionWithShots, assets: Asset[]): StoryPlan {
  const beatTitles = [
    "建立处境",
    "扰动出现",
    "发现线索",
    "压力升级",
    "重新理解",
    "不可逆选择",
    "冲突高潮",
    "余韵收束"
  ];
  const perBeat = Math.min(15, Math.max(1, Math.round(session.targetDurationSec / Math.max(session.shots.length, 1))));
  const mentions = assets.slice(0, 4).map((asset) => `@${formatAssetMention(asset.name)}`);
  return normalizeStoryPlan(
    {
      premise: session.logline || `${session.title} 的短片故事`,
      synopsis:
        session.logline ||
        `${session.title} 围绕一个清晰的视觉冲突展开：主角在有限时间内被迫面对一个改变关系和命运的选择。故事以具体动作推进，强调人物状态、场景压力和结尾余韵。`,
      theme: "人在压力下选择诚实面对自己",
      tone: session.style || "电影感、克制、真实、情绪逐步升高",
      characters: assets
        .filter((asset) => asset.type === "character")
        .slice(0, 4)
        .map((asset) => ({
          name: asset.name,
          role: "推动故事的关键人物",
          arc: "从被动反应走向主动选择",
          assetId: asset.id,
          assetMention: `@${formatAssetMention(asset.name)}`
        })),
      beats: session.shots.map((shot, index) => ({
        index: shot.index,
        title: `${String(shot.index).padStart(2, "0")} ${beatTitles[index % beatTitles.length]}`,
        purpose: beatTitles[index % beatTitles.length],
        plot: `${session.logline || session.title}。本节拍让人物通过一个可见动作推进故事。`,
        emotion: index === 0 ? "压抑、观察" : index === session.shots.length - 1 ? "释放、余韵" : "紧张升级",
        visual:
          index % 2 === 0
            ? "用环境建立空间关系，角色动作清晰，光线和道具保持连续。"
            : "用中近景和细节反应推进情绪，保留前一镜的运动和节奏。",
        assetMentions: mentions,
        durationSec: perBeat
      })),
      locked: false
    },
    session,
    assets,
    "local-template"
  );
}

function normalizeStoryPlan(value: unknown, session: SessionWithShots, assets: Asset[], model?: string): StoryPlan {
  const body = isRecord(value) ? value : {};
  const beatsValue = Array.isArray(body.beats) ? body.beats : [];
  const perBeat = Math.min(15, Math.max(1, Math.round(session.targetDurationSec / Math.max(session.shots.length, 1))));
  const beats = session.shots.map((shot, index) => {
    const source = beatsValue.find((item) => isRecord(item) && Number(item.index) === shot.index) || beatsValue[index];
    const beat = isRecord(source) ? source : {};
    return {
      index: shot.index,
      title: String(beat.title || `Shot ${shot.index}`),
      purpose: String(beat.purpose || "推进剧情"),
      plot: String(beat.plot || session.logline || session.title),
      emotion: String(beat.emotion || "情绪递进"),
      visual: String(beat.visual || "电影感画面，动作清晰，保持连续性"),
      assetMentions: normalizeAssetMentions(Array.isArray(beat.assetMentions) ? beat.assetMentions.map(String) : inferAssetMentions(String(beat.plot || ""), assets)),
      durationSec: Math.min(Math.max(Number(beat.durationSec) || shot.durationSec || perBeat, 1), 15)
    };
  });
  const charactersValue = Array.isArray(body.characters) ? body.characters : [];
  const characters = charactersValue
    .map((item) => (isRecord(item) ? item : {}))
    .map((item) => ({
      name: String(item.name || ""),
      role: String(item.role || ""),
      arc: String(item.arc || ""),
      assetId: typeof item.assetId === "string" ? item.assetId : undefined,
      assetMention: typeof item.assetMention === "string" ? item.assetMention : undefined
    }))
    .filter((item) => item.name || item.assetMention);

  return {
    premise: String(body.premise || session.logline || session.title),
    synopsis: String(body.synopsis || session.logline || ""),
    theme: String(body.theme || "选择与自我面对"),
    tone: String(body.tone || session.style || "cinematic, emotionally grounded"),
    characters,
    beats,
    locked: Boolean(body.locked),
    updatedAt: new Date().toISOString(),
    model
  };
}

function inferAssetMentions(text: string, assets: Asset[]) {
  const normalized = normalizeMentionText(text);
  return assets
    .filter((asset) => [asset.name, ...(asset.tags || [])].some((name) => normalized.includes(normalizeMentionText(name))))
    .map((asset) => `@${formatAssetMention(asset.name)}`);
}

function normalizeAssetMentions(values: string[] = []) {
  return Array.from(
    new Set(
      values
        .map((value) => value.trim())
        .filter(Boolean)
        .map((value) => (value.startsWith("@") ? value : `@${value}`))
        .map((value) => value.replace(/\s*\/\s*/g, "/").replace(/\s+/g, ""))
    )
  );
}

function normalizeMentionText(value: string) {
  return value.toLowerCase().replace(/\s+/g, "").replace(/／/g, "/").trim();
}

function formatAssetMention(name: string) {
  return name.replace(/\s*\/\s*/g, "/").replace(/\s+/g, "");
}

export interface SeedreamGenerateOpts {
  /** Override the assembled Seedream prompt verbatim (post user-edit from dryRun preview). */
  promptOverride?: string;
  /** Output language for the auto-composed prompt. Default `"zh"`. Ignored when promptOverride is set. */
  lang?: Lang;
}

export interface AssetImageResult {
  url: string;
  /** The Seedream prompt actually submitted (audit trail). Empty for placeholder / OpenAI paths. */
  composedPrompt: string;
  /** The model variant that actually produced the image. Can differ from the request after fallback. */
  model: AssetImageModel;
  /** The concrete provider model id sent to the image API. */
  actualModelId?: string;
  /** Which credential route was used for the generation. */
  credentialSource?: ArkCredential["source"];
  rawUsage?: unknown;
}

export async function generateAssetImage(
  asset: Asset,
  model: AssetImageModel = "seedream-4-5",
  referenceImageUrls: string[] = [],
  opts: SeedreamGenerateOpts = {}
): Promise<AssetImageResult> {
  if (model === "seedream-4-5") {
    try {
      return await generateAssetImageViaSeedream(asset, referenceImageUrls, "seedream-4-5", opts);
    } catch (error) {
      // Some Ark / BytePlus accounts or regions have Seedream 4.0 enabled but not the newer 4.5
      // model. The canvas picker defaults to 4.5, so without this fallback "出图" hard-fails with
      // InvalidEndpointOrModel.NotFound even though a working Seedream model is configured.
      if (!isMissingSeedreamModelError(error)) throw error;
      console.warn(`[seedream] ${asset.id} requested seedream-4-5 but model is unavailable; falling back to seedream-4`);
      return await generateAssetImageViaSeedream(asset, referenceImageUrls, "seedream-4", opts);
    }
  }
  if (model === "seedream-4") return generateAssetImageViaSeedream(asset, referenceImageUrls, "seedream-4", opts);
  if (model === "seedream-5-lite") return generateAssetImageViaSeedream(asset, referenceImageUrls, "seedream-5-lite", opts);
  const url = await generateAssetImageViaOpenAI(asset, referenceImageUrls);
  return { url, composedPrompt: "", model: "gpt-image-2" };
}

function isMissingSeedreamModelError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /InvalidEndpointOrModel\.NotFound|model or endpoint .* does not exist|does not have access/i.test(message);
}

function resolveSeedPromptModel(source: "standard" | "agent-plan" | "missing") {
  if (source === "agent-plan") {
    return process.env.SEED_PROMPT_AGENT_PLAN_MODEL || process.env.AGENT_PLAN_TEXT_MODEL || "";
  }
  return process.env.SEED_PROMPT_MODEL || "seed-2-0-pro-260328";
}

function isAgentPlanUnsupportedModelError(status: number, text: string) {
  return status === 404 && /UnsupportedModel|does not support the agent plan feature/i.test(text);
}

export async function expandAssetPrompt(asset: Partial<Asset>) {
  const fallback = buildLocalExpandedAssetPrompt(asset);
  const credential = seedPromptCredential();
  const model = resolveSeedPromptModel(credential.source);
  if (!credential.apiKey) return { prompt: fallback, model: "local-template" };
  if (!model) return { prompt: fallback, model: "local-template-agent-plan" };

  // Wrapped in fetchWithRetry — when BytePlus throws a transient "fetch failed" / 5xx, we
  // silently retry with backoff instead of bubbling the network blip up to the user. The user's
  // prompt-expansion request is read-only on BytePlus's side (no content created) so retry-on-
  // timeout is safe.
  const response = await fetchWithRetry(`${credential.apiBase}/responses`, {
    method: "POST",
    timeoutMs: 60_000,
    idempotent: true,
    tag: "doubao:expand-prompt",
    headers: {
      ...jsonHeaders(credential.apiKey),
      "ark-beta-mcp": "true"
    },
    body: JSON.stringify({
      model,
      stream: false,
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text:
                "你是电影短片资产设定 prompt 扩写师。只输出可直接用于文生图的最终中文 prompt，不要解释，不要 Markdown。"
            }
          ]
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: buildAssetPromptExpansionInstruction(asset)
            }
          ]
        }
      ]
    })
  });

  const text = await response.text();
  if (!response.ok) {
    if (credential.source === "agent-plan" && isAgentPlanUnsupportedModelError(response.status, text)) {
      console.warn(`[seed-prompt] ${model} is not supported by Agent Plan; falling back to local template expansion`);
      return { prompt: fallback, model: "local-template-agent-plan" };
    }
    throw new Error(`Seed prompt API failed: ${response.status} ${text.slice(0, 1000)}`);
  }
  const body = text ? JSON.parse(text) : {};
  const expanded = (extractResponseText(body) || "").trim();
  return { prompt: isNoOpPromptExpansion(expanded, asset) ? fallback : expanded, model, rawUsage: body.usage };
}

function isNoOpPromptExpansion(expanded: string, asset: Partial<Asset>) {
  if (!expanded) return true;
  const rawPrompt = [asset.name, asset.description || asset.prompt].filter(Boolean).join("，").trim();
  if (!rawPrompt) return false;
  return normalizePromptForNoOpCheck(expanded) === normalizePromptForNoOpCheck(rawPrompt);
}

function normalizePromptForNoOpCheck(value: string) {
  return value.replace(/[\s，。,.；;：:、|/\\*_`"'“”‘’（）()【】\[\]{}<>《》-]+/g, "").toLowerCase();
}

async function generateAssetImageViaOpenAI(asset: Asset, referenceImageUrls: string[] = []) {
  const apiKey = openAIKey();
  if (!apiKey) {
    return `https://placehold.co/1024x1024/1f2937/f8fafc?text=${encodeURIComponent(asset.name)}`;
  }
  const usableRefs = await prepareOpenAIReferenceImages(referenceImageUrls);
  const prompt = `${asset.prompt || asset.description || asset.name}
Asset type: ${asset.type}. Clean production reference image, no text overlay.
${usableRefs.length ? "Use the attached input images as strict visual references for the main subjects. Preserve their faces, styling, wardrobe, silhouette, age, and identity. Do not invent replacement protagonists." : ""}`;
  const endpoint = usableRefs.length ? "edits" : "generations";
  const response = await fetch(`https://api.openai.com/v1/images/${endpoint}`, {
    method: "POST",
    headers: jsonHeaders(apiKey),
    body: JSON.stringify({
      model: process.env.OPENAI_IMAGE_MODEL || "gpt-image-2",
      prompt,
      ...(usableRefs.length ? { images: usableRefs.map((url) => ({ image_url: url })) } : {}),
      size: process.env.OPENAI_IMAGE_SIZE || "1536x1024"
    })
  });

  if (!response.ok) {
    throw new Error(`OpenAI image API failed: ${response.status} ${await response.text()}`);
  }

  const data = (await response.json()) as { data?: Array<{ url?: string; b64_json?: string }> };
  const first = data.data?.[0];
  if (first?.url) return first.url;
  if (first?.b64_json) {
    await mkdir(MEDIA_DIR, { recursive: true });
    const fileName = `${asset.id}-asset.png`;
    await writeFile(path.join(MEDIA_DIR, fileName), Buffer.from(first.b64_json, "base64"));
    return `/media/${fileName}`;
  }
  throw new Error("OpenAI image API returned no image");
}

async function prepareOpenAIReferenceImages(urls: string[]) {
  const results: string[] = [];
  for (const url of urls) {
    if (!url) continue;
    if (url.startsWith("data:image/")) {
      results.push(url);
      continue;
    }
    if (url.startsWith("/media/")) {
      const dataUrl = await readLocalMediaAsDataUrl(url);
      if (dataUrl) results.push(dataUrl);
      continue;
    }
    if (/^https?:\/\//.test(url)) {
      results.push(await downloadImageAsDataUrl(url));
    }
  }
  return results;
}

async function downloadImageAsDataUrl(url: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45_000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const contentType = response.headers.get("content-type") || "image/jpeg";
    const bytes = Buffer.from(await response.arrayBuffer());
    return `data:${contentType};base64,${bytes.toString("base64")}`;
  } finally {
    clearTimeout(timer);
  }
}

type SeedreamVariant = "seedream-4" | "seedream-4-5" | "seedream-5-lite";

const SEEDREAM_DEFAULT_MODEL: Record<Exclude<SeedreamVariant, "seedream-5-lite">, string> = {
  "seedream-4": "doubao-seedream-4-0-250828",
  "seedream-4-5": "doubao-seedream-4-5-251128"
};
const AGENT_PLAN_SEEDREAM_MODEL = "doubao-seedream-5.0-lite";

// The 4.5 model accepts the same OpenAI-compatible image-generation request shape as 4.0
// (model + prompt + size + optional image references). We keep a per-variant model id and a shared
// SEEDREAM_SIZE so callers can override either independently.
// Keep operator-provided model ids authoritative. BytePlus ModelArk commonly uses the short ids
// (`seedream-4-5-251128` / `seedream-4-0-250828`), while Volcengine Ark may expose the
// `doubao-...` ids. Do NOT normalize unconditionally; instead try alternates only after the first
// id returns InvalidEndpointOrModel.NotFound.
function seedreamModelAlternates(modelId: string) {
  const ids = [modelId];
  if (modelId.startsWith("seedream-")) ids.push(`doubao-${modelId}`);
  if (modelId.startsWith("doubao-seedream-")) ids.push(modelId.replace(/^doubao-/, ""));
  return [...new Set(ids)];
}

function resolveSeedreamModelIds(variant: SeedreamVariant, usesAgentPlan = false) {
  if (usesAgentPlan) {
    return [process.env.SEEDREAM_AGENT_PLAN_MODEL || AGENT_PLAN_SEEDREAM_MODEL];
  }
  if (variant === "seedream-5-lite") {
    return [process.env.SEEDREAM_AGENT_PLAN_MODEL || AGENT_PLAN_SEEDREAM_MODEL];
  }
  const model = variant === "seedream-4-5"
    ? process.env.SEEDREAM_45_MODEL || process.env.SEEDREAM_4_5_MODEL || SEEDREAM_DEFAULT_MODEL["seedream-4-5"]
    : process.env.SEEDREAM_MODEL || SEEDREAM_DEFAULT_MODEL["seedream-4"];
  return seedreamModelAlternates(model);
}

async function generateAssetImageViaSeedream(
  asset: Asset,
  referenceImageUrls: string[] = [],
  variant: SeedreamVariant = "seedream-4-5",
  opts: SeedreamGenerateOpts = {}
) {
  const credential = seedreamCredential();
  if (!credential.apiKey) {
    refuseFakeSuccessInProduction("Seedream image generation", SEEDREAM_KEY_ENVS);
    return {
      url: `https://placehold.co/2048x2048/1f2937/f8fafc?text=${encodeURIComponent(asset.name)}`,
      composedPrompt: "",
      model: variant,
      credentialSource: credential.source
    };
  }

  const usableRefs = await prepareSeedreamReferenceImages(referenceImageUrls, asset.id);

  // Compose prompt: caller override > centralized composer (zh by default).
  const lang: Lang = opts.lang === "en" ? "en" : "zh";
  const composedPrompt = opts.promptOverride && opts.promptOverride.trim().length > 0
    ? opts.promptOverride
    : composeSeedreamAssetPrompt(asset, usableRefs.length > 0, lang).composedPrompt;

  // Default to Seedream 4K for higher-fidelity role/scene anchors. Env override still wins so ops
  // can temporarily lower cost/latency without touching code.
  const size = process.env.SEEDREAM_SIZE || "4K";
  // Seedream image generation: a POST that creates a result, not a side-effecting "create task"
  // — Seedream's API is request/response (the response body IS the image URL), so retry-on-
  // timeout is safe (no orphaned task to clean up). Wrap in fetchWithRetry so transient
  // "fetch failed" / 5xx don't kill the user's gen.
  const modelIds = resolveSeedreamModelIds(variant, credential.source === "agent-plan");
  let lastMissingModelError: unknown;
  for (const modelId of modelIds) {
    const response = await fetchWithRetry(`${credential.apiBase}/images/generations`, {
      method: "POST",
      timeoutMs: 240_000,
      idempotent: true,
      tag: `seedream:asset:${asset.id}`,
      headers: jsonHeaders(credential.apiKey),
      body: JSON.stringify({
        model: modelId,
        prompt: composedPrompt,
        ...(usableRefs.length ? { image: usableRefs.length === 1 ? usableRefs[0] : usableRefs } : {}),
        response_format: "url",
        size,
        stream: false,
        watermark: false,
        ...seedreamWebSearchPayload()
      })
    });

    const text = await response.text();
    const body = text ? JSON.parse(text) : {};
    if (!response.ok) {
      const error = new Error(`Seedream image API failed: ${response.status} ${text.slice(0, 1000)}`);
      if (isMissingSeedreamModelError(error) && modelId !== modelIds[modelIds.length - 1]) {
        lastMissingModelError = error;
        continue;
      }
      throw error;
    }

    const imageUrl = findUrl(body, ["url", "image_url"]);
    if (imageUrl) {
      return {
        url: imageUrl,
        composedPrompt,
        model: variant,
        actualModelId: modelId,
        credentialSource: credential.source,
        rawUsage: body.usage
      };
    }
    throw new Error(`Seedream image API returned no image url: ${JSON.stringify(body).slice(0, 1000)}`);
  }
  throw lastMissingModelError instanceof Error ? lastMissingModelError : new Error(`Seedream model unavailable: ${modelIds.join(" / ")}`);
}

async function prepareSeedreamReferenceImages(urls: string[], assetId: string) {
  const results: string[] = [];
  for (const [index, url] of urls.entries()) {
    if (!url) continue;
    if (/^https?:\/\//.test(url)) {
      results.push(url);
      continue;
    }
    const dataUrl = url.startsWith("data:image/") ? url : url.startsWith("/media/") ? await readLocalMediaAsDataUrl(url) : undefined;
    if (!dataUrl) continue;
    results.push(await upscaleReferenceImageDataUrl(dataUrl, assetId, index));
  }
  return results;
}

async function upscaleReferenceImageDataUrl(dataUrl: string, assetId: string, index: number) {
  const match = dataUrl.match(/^data:(image\/(?:png|jpeg|jpg|webp));base64,(.+)$/);
  if (!match) return dataUrl;

  await mkdir(MEDIA_DIR, { recursive: true });
  const ext = match[1].includes("png") ? ".png" : match[1].includes("webp") ? ".webp" : ".jpg";
  const safeId = sanitizeFilePart(assetId || "asset");
  const inputPath = path.join(MEDIA_DIR, `${safeId}-reference-input-${index}-${Date.now()}${ext}`);
  const outputName = `${safeId}-reference-enhanced-${index}-${Date.now()}.png`;
  const outputPath = path.join(MEDIA_DIR, outputName);
  await writeFile(inputPath, Buffer.from(match[2], "base64"));

  try {
    await runFfmpeg([
      "-y",
      "-i",
      inputPath,
      "-vf",
      "scale='if(lt(iw,ih),768,-2)':'if(gte(iw,ih),768,-2)':flags=lanczos,unsharp=5:5:0.8:3:3:0.35",
      "-frames:v",
      "1",
      outputPath
    ]);
    return await readLocalMediaAsDataUrl(`/media/${outputName}`) || dataUrl;
  } finally {
    await unlink(inputPath).catch(() => undefined);
  }
}

export function canUseBytePlusSeedance(credential: ArkCredential = seedanceCredential()) {
  return Boolean(!process.env.SEEDANCE_API_URL && credential.apiKey);
}

export async function createSeedanceVideoTask(shot: Shot, assets: Asset[], opts: BuildSeedancePayloadOpts = {}) {
  const credential = opts.credential || seedanceCredential();
  if (!credential.apiKey) throw new Error(arkMissingKeyMessage("Seedance generation", SEEDANCE_KEY_ENVS));
  const payload = await buildBytePlusSeedancePayload(shot, assets, opts);
  const submittedReferenceImageUrls = payload.content
    .filter((item) => item.role === "reference_image")
    .map((item) => item.image_url?.url)
    .filter((url): url is string => Boolean(url));
  const createBody = await requestSeedanceJson(`${credential.apiBase}/contents/generations/tasks`, credential.apiKey, {
    method: "POST",
    body: JSON.stringify(payload)
  });
  return {
    taskId: extractTaskId(createBody),
    model: payload.model,
    composedText: payload.composedText,
    submittedReferenceImageUrls,
    createResponse: createBody
  };
}

export async function pollSeedanceVideoTask(taskId: string) {
  const credential = seedanceCredential();
  if (!credential.apiKey) throw new Error(arkMissingKeyMessage("Seedance polling", SEEDANCE_KEY_ENVS));
  const body = await requestSeedanceJson(`${credential.apiBase}/contents/generations/tasks/${taskId}`, credential.apiKey);
  const status = extractStatus(body);
  return {
    taskId,
    status,
    videoUrl: findUrl(body, ["video_url", "output_url", "url"]),
    error: extractGenerationError(body),
    response: body
  };
}

export async function cancelSeedanceVideoTask(taskId: string) {
  const credential = seedanceCredential();
  if (!credential.apiKey) throw new Error(arkMissingKeyMessage("Seedance cancellation", SEEDANCE_KEY_ENVS));
  const body = await requestSeedanceJson(`${credential.apiBase}/contents/generations/tasks/${taskId}`, credential.apiKey, {
    method: "DELETE"
  });
  return {
    taskId,
    response: body
  };
}

export async function generateShotVideo(shot: Shot, assets: Asset[], opts: BuildSeedancePayloadOpts = {}) {
  if (process.env.SEEDANCE_API_URL && process.env.SEEDANCE_API_KEY) {
    return generateShotVideoViaCustomEndpoint(shot, assets, opts);
  }

  const credential = opts.credential || seedanceCredential();
  if (!credential.apiKey) {
    refuseFakeSuccessInProduction("Seedance video generation", SEEDANCE_KEY_ENVS);
    return `https://placehold.co/1280x720/111827/f8fafc?text=${encodeURIComponent(`Video ${shot.index}`)}`;
  }
  return generateShotVideoViaBytePlusArk(shot, assets, credential, opts);
}

export async function extractTailVideoClip(videoUrl: string, shotId: string, sourceShotId: string, seconds?: number) {
  await mkdir(MEDIA_DIR, { recursive: true });
  const duration = Math.min(Math.max(Number(seconds) || 15, 1), 15);
  const inputPath = await materializeVideo(videoUrl, sourceShotId, 0);
  const outputName = `${shotId}-reference-tail-from-${sourceShotId}-${duration}s-${Date.now()}.mp4`;
  const outputPath = path.join(MEDIA_DIR, outputName);
  await runFfmpeg([
    "-y",
    "-sseof",
    `-${duration}`,
    "-i",
    inputPath,
    "-t",
    String(duration),
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-movflags",
    "+faststart",
    outputPath
  ]);
  return `/media/${outputName}`;
}

export async function extractTailAudioClip(videoUrl: string, shotId: string, sourceShotId: string, seconds?: number) {
  await mkdir(MEDIA_DIR, { recursive: true });
  const duration = Math.min(Math.max(Number(seconds) || 15, 1), 15);
  const inputPath = await materializeVideo(videoUrl, sourceShotId, 0);
  const outputName = `${shotId}-reference-audio-from-${sourceShotId}-${duration}s-${Date.now()}.mp3`;
  const outputPath = path.join(MEDIA_DIR, outputName);
  try {
    await runFfmpeg([
      "-y",
      "-sseof",
      `-${duration}`,
      "-i",
      inputPath,
      "-t",
      String(duration),
      "-vn",
      "-c:a",
      "libmp3lame",
      "-b:a",
      "128k",
      outputPath
    ]);
  } catch {
    return undefined;
  }
  return `/media/${outputName}`;
}

async function generateShotVideoViaCustomEndpoint(shot: Shot, assets: Asset[], opts: BuildSeedancePayloadOpts = {}) {
  const apiKey = process.env.SEEDANCE_API_KEY;
  if (!apiKey || !process.env.SEEDANCE_API_URL) throw new Error("Missing SEEDANCE_API_KEY or SEEDANCE_API_URL");
  // Mirror BytePlus behavior: first-frame mode is mutually exclusive with reference media.
  const firstFrameAsset = resolveFirstFrameAsset(shot, assets);
  const firstFrameUrl = firstFrameAsset ? getAssetMediaUrl(firstFrameAsset, "image") : undefined;
  const useFirstFrameMode = Boolean(firstFrameUrl && /^https?:\/\//.test(firstFrameUrl) && !firstFrameUrl.includes("placehold.co"));

  const referenceClipUrl = useFirstFrameMode ? undefined : getSeedanceWebUrl(shot.referenceClipUrl);
  const referenceAudioUrl = useFirstFrameMode ? undefined : getSeedanceWebUrl(shot.referenceAudioUrl);
  const referenceAssets = useFirstFrameMode && firstFrameAsset ? [firstFrameAsset] : assets;
  const prompt = opts.prebuiltText && opts.prebuiltText.trim().length > 0
    ? opts.prebuiltText.trim()
    : [
        buildVideoPrompt(shot, referenceAssets, {
          continuityVideoFirst: Boolean(referenceClipUrl),
          firstFrameAsset: useFirstFrameMode ? firstFrameAsset : undefined
        }),
        referenceClipUrl || referenceAudioUrl ? buildContinuityInstruction() : "",
        useFirstFrameMode ? buildFirstFrameInstruction(firstFrameAsset) : ""
      ]
        .filter(Boolean)
        .join("\n");

  // Custom Seedance HTTP endpoint — wrapped in fetchWithRetry with idempotent=false so we only
  // retry pre-flight network errors (not server-confirmed timeouts that may have created a task).
  const response = await fetchWithRetry(process.env.SEEDANCE_API_URL, {
    method: "POST",
    timeoutMs: 240_000,
    idempotent: false,
    tag: `seedance:custom-server:${shot.id}`,
    headers: jsonHeaders(apiKey),
    body: JSON.stringify({
      model: resolveSeedanceModel(shot),
      prompt,
      duration: getShotDurationSec(shot),
      ...(typeof opts.generateAudio === "boolean" ? { generate_audio: opts.generateAudio } : {}),
      references: [
        ...(useFirstFrameMode && firstFrameAsset && firstFrameUrl
          ? [
              {
                id: `first-frame-${firstFrameAsset.id}`,
                type: "first_frame",
                media_kind: "image",
                image_url: firstFrameUrl,
                description: `First frame image from asset "${firstFrameAsset.name}"`
              }
            ]
          : []),
        ...(referenceClipUrl
          ? [
              {
                id: "previous-shot-tail",
                type: "continuity",
                media_kind: "video",
                video_url: referenceClipUrl,
                description: "Tail clip from the previous shot for shot-to-shot continuity"
              }
            ]
          : []),
        ...(referenceAudioUrl
          ? [
              {
                id: "previous-shot-audio",
                type: "continuity",
                media_kind: "audio",
                audio_url: referenceAudioUrl,
                description: "Tail audio from the previous shot for music continuity"
              }
            ]
          : []),
        ...(useFirstFrameMode
          ? []
          : assets.map((asset) => ({
              id: asset.id,
              type: asset.type,
              media_kind: asset.mediaKind,
              image_url: getAssetMediaUrl(asset, "image"),
              video_url: getAssetMediaUrl(asset, "video"),
              description: asset.description
            })))
      ]
    })
  });

  if (!response.ok) {
    throw new Error(decorateSeedanceError(response.status, await response.text()));
  }

  const data = (await response.json()) as { video_url?: string; url?: string; data?: { url?: string } };
  const videoUrl = data.video_url || data.url || data.data?.url;
  if (!videoUrl) throw new Error("Seedance API returned no video_url/url");
  return videoUrl;
}

/**
 * Tag known recoverable Seedance error shapes with a sentinel prefix the client can detect.
 * Currently handles the r2v reference-video duration ceiling (15.2s) — the client surfaces this
 * with a one-click "派生 15s 剪裁版并切换" button instead of dumping the raw API error to the UI.
 *
 * The decoration is purely additive: the original message is preserved verbatim after the
 * sentinel so debugging / logs stay informative. Other 400s pass through unchanged.
 */
export const REFERENCE_VIDEO_TOO_LONG_PREFIX = "[REFERENCE_VIDEO_TOO_LONG]";
function decorateSeedanceError(status: number, text: string): string {
  const base = `Seedance API failed: ${status} ${text.slice(0, 1000)}`;
  if (status === 400 && /video duration[^]*?must be less than or equal to 15\.\d/i.test(text)) {
    return `${REFERENCE_VIDEO_TOO_LONG_PREFIX} ${base}`;
  }
  return base;
}

async function generateShotVideoViaBytePlusArk(shot: Shot, assets: Asset[], credential: ArkCredential, opts: BuildSeedancePayloadOpts = {}) {
  const payload = await buildBytePlusSeedancePayload(shot, assets, opts);
  if (!credential.apiKey) throw new Error(arkMissingKeyMessage("Seedance generation", SEEDANCE_KEY_ENVS));
  const createBody = await requestSeedanceJson(`${credential.apiBase}/contents/generations/tasks`, credential.apiKey, {
    method: "POST",
    body: JSON.stringify(payload)
  });
  const taskId = extractTaskId(createBody);
  const deadline = Date.now() + seedanceTimeoutMs();
  const pollMs = Number(process.env.SEEDANCE_POLL_MS || 5000);
  let lastBody: unknown = createBody;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    lastBody = await requestSeedanceJson(`${credential.apiBase}/contents/generations/tasks/${taskId}`, credential.apiKey);
    const status = extractStatus(lastBody);
    if (TERMINAL_STATUSES.has(status)) {
      const videoUrl = findUrl(lastBody, ["video_url", "output_url", "url"]);
      if (status === "succeeded" && videoUrl) return videoUrl;
      throw new Error(`Seedance task ${taskId} ${status}: ${JSON.stringify(extractGenerationError(lastBody)).slice(0, 500)}`);
    }
  }

  const videoUrl = findUrl(lastBody, ["video_url", "output_url", "url"]);
  if (videoUrl) return videoUrl;
  throw new Error(`Seedance task ${taskId} timed out before video_url was ready`);
}

async function buildBytePlusSeedancePayload(shot: Shot, assets: Asset[], opts: BuildSeedancePayloadOpts = {}) {
  const model = resolveSeedanceModel(shot);
  const lang: Lang = opts.lang === "en" ? "en" : "zh";
  // The shot can drive Seedance in three mutually exclusive anchor modes (anchored from strongest
  // to weakest):
  //   1. SubShot mode (subShotPanelCount > 0)  — a single grid image acts as a TIMELINE of N
  //      sub-panels and Seedance is told to read panel positions as cuts. Disables first/last
  //      frame mode; the grid image is sent as a normal reference_image plus a magic sequencing
  //      instruction in the text. (EvoLink GPT-Image-2 / Seedance 2.0 community technique.)
  //   2. First-and-last frame I2V (firstFrameAssetId + lastFrameAssetId) — anchors the start and
  //      end frames; the model interpolates motion. Disables continuity reference media.
  //   3. First-frame I2V (firstFrameAssetId only) — anchors the start frame.
  // When none of the three are set the shot falls back to plain prompt + reference media.
  const useSubShotMode = Boolean(
    shot.subShotPanelCount && shot.subShotPanelCount > 1 && (
      shot.subShotStoryboardAssetId ||
      (shot.subShotStoryboardAssetIds && shot.subShotStoryboardAssetIds.length > 0)
    )
  );
  const subShotPanelCount = useSubShotMode ? Math.max(2, Math.min(16, Math.floor(shot.subShotPanelCount as number))) : 0;
  // Resolve the FULL list of storyboard assets feeding this shot. The plural field
  // `subShotStoryboardAssetIds` is the source of truth for N-to-1 wiring (set by canvas
  // drag-to-connect); the legacy singular `subShotStoryboardAssetId` is kept as a fallback for
  // older data. Order matters: the primary (own-shot) grid leads — its panel sequence drives the
  // "Follow the storyboard sequence of N reference frames in image1" magic instruction.
  const subShotAssetIds = (() => {
    const list = (shot.subShotStoryboardAssetIds && shot.subShotStoryboardAssetIds.length > 0)
      ? shot.subShotStoryboardAssetIds
      : (shot.subShotStoryboardAssetId ? [shot.subShotStoryboardAssetId] : []);
    return Array.from(new Set(list));
  })();
  const subShotAssets = useSubShotMode
    ? subShotAssetIds
        .map((id) => assets.find((asset) => asset.id === id))
        .filter((a): a is Asset => Boolean(a))
    : [];
  const subShotAsset = subShotAssets[0]; // primary grid (drives the sequencing instruction)
  const subShotUrl = subShotAsset ? getAssetMediaUrl(subShotAsset, "image") : undefined;
  const useSubShotResolved = Boolean(subShotUrl && /^https?:\/\//.test(subShotUrl) && !subShotUrl.includes("placehold.co"));
  // Extra (non-primary) storyboard URLs the user wired in via canvas. Passed to Seedance as
  // additional reference images alongside the primary grid; helpful for cross-shot continuity
  // (e.g. "follow the timeline of grid A but borrow the lighting from grid B").
  const subShotExtraReferences = useSubShotResolved
    ? subShotAssets
        .slice(1)
        .map((asset) => ({ asset, url: getAssetMediaUrl(asset, "image") }))
        .filter((item): item is { asset: Asset; url: string } => Boolean(item.url && /^https?:\/\//.test(item.url) && !item.url.includes("placehold.co")))
    : [];

  // Seedance 2.0 rejects payloads that mix `first_frame` / `last_frame` content with any
  // `reference_image` or `reference_video` content (`InvalidParameter: first/last frame content
  // cannot be mixed with reference media content`). So a shot can run sub-shot mode (grid as
  // reference_image) OR first/last-frame I2V — not both simultaneously.
  //
  // Priority is INVERTED from the previous default: when a user wires firstFrameAssetId onto
  // a shot that already has a sub-shot grid, first-frame wins. This is the cross-shot
  // continuity ergonomic — wiring `last-tail of shot N → first-frame of shot N+1` should "just
  // work" without forcing the caller to also clear sub-shot fields.
  const firstFrameAsset = resolveFirstFrameAsset(shot, assets);
  const firstFrameUrl = firstFrameAsset ? getAssetMediaUrl(firstFrameAsset, "image") : undefined;
  const useFirstFrameMode = Boolean(firstFrameUrl && /^https?:\/\//.test(firstFrameUrl) && !firstFrameUrl.includes("placehold.co"));

  const lastFrameAsset = useFirstFrameMode ? resolveLastFrameAsset(shot, assets) : undefined;
  const lastFrameUrl = lastFrameAsset ? getAssetMediaUrl(lastFrameAsset, "image") : undefined;
  const useLastFrameMode = Boolean(lastFrameUrl && /^https?:\/\//.test(lastFrameUrl) && !lastFrameUrl.includes("placehold.co"));

  // Demote sub-shot when first-frame is active. Field stays on the shot record (so re-clearing
  // first-frame restores the grid), but the payload sees first-frame mode only.
  const subShotActive = useSubShotResolved && !useFirstFrameMode;

  // Reference video is allowed in two cases:
  //   1) asset-backed reference_video: the wired refvideo asset is present in `assets` (normally
  //      because the prompt @-mentioned it / the caller explicitly included it);
  //   2) URL-backed continuity: previous-shot or shot-to-shot wiring resolved a remote clip URL
  //      without an asset id. In both cases first-frame and sub-shot modes still win the mutex.
  const resolvedContinuityVideoUrl = getSeedanceWebUrl(shot.referenceClipUrl);
  const resolvedContinuityAudioUrl = getSeedanceWebUrl(shot.referenceAudioUrl);
  const hasAssetBackedReferenceVideo = Boolean(
    shot.referenceVideoAssetId && assets.some((a) => a.id === shot.referenceVideoAssetId)
  );
  const hasUrlBackedContinuityVideo = Boolean(!shot.referenceVideoAssetId && resolvedContinuityVideoUrl);
  const useContinuityReference = hasAssetBackedReferenceVideo || hasUrlBackedContinuityVideo;
  const continuityVideoUrl = (useFirstFrameMode || subShotActive || !useContinuityReference)
    ? undefined
    : resolvedContinuityVideoUrl;
  const continuityAudioUrl = (useFirstFrameMode || subShotActive || !useContinuityReference)
    ? undefined
    : resolvedContinuityAudioUrl;
  // In sub-shot mode pass the primary grid first (Seedance's image1 — owns the sequencing) plus
  // any extra storyboards the user wired in. In first-frame mode we drop all other reference
  // imagery (Seedance API rejects mixing first_frame with reference_image). Otherwise keep
  // @-mentioned assets as references.
  const referenceImages = subShotActive
    ? (subShotAsset && subShotUrl
        ? [{ asset: subShotAsset, url: subShotUrl as string }, ...subShotExtraReferences]
        : [])
    : useFirstFrameMode
      ? []
      : assets
          .map((asset) => ({ asset, url: getAssetMediaUrl(asset, "image") }))
          .filter((item): item is { asset: Asset; url: string } => Boolean(item.url && /^https?:\/\//.test(item.url) && !item.url.includes("placehold.co")));
  const rawReferenceVideos = subShotActive || useFirstFrameMode
    ? []
    : assets
        .map((asset) => ({ asset, url: getAssetMediaUrl(asset, "video") }))
        .filter((item): item is { asset: Asset; url: string } => Boolean(item.url && /^https?:\/\//.test(item.url) && !item.url.includes("placehold.co")));
  // Dedupe reference videos by URL (the user may have uploaded the same file twice and produced
  // two assets sharing one TOS URL) AND drop any that collide with continuityVideoUrl (the wired
  // refvideo doesn't need to be sent as both `continuity` and `@-mention` ref). Then cap at the
  // Seedance hard limit (3 video contents per request) so the upstream doesn't 400 us.
  const SEEDANCE_VIDEO_LIMIT = 3;
  const continuityUrlNorm = continuityVideoUrl;
  const seenVideoUrls = new Set<string>();
  if (continuityUrlNorm) seenVideoUrls.add(continuityUrlNorm);
  const dedupedReferenceVideos: typeof rawReferenceVideos = [];
  for (const item of rawReferenceVideos) {
    if (seenVideoUrls.has(item.url)) continue;
    seenVideoUrls.add(item.url);
    dedupedReferenceVideos.push(item);
  }
  // Reserve 1 slot for continuityVideoUrl when it's set, then take up to (LIMIT - reserved).
  const continuitySlots = continuityUrlNorm ? 1 : 0;
  const referenceVideos = dedupedReferenceVideos.slice(0, Math.max(0, SEEDANCE_VIDEO_LIMIT - continuitySlots));

  const promptAssetsForText = useFirstFrameMode && firstFrameAsset
    ? [firstFrameAsset]
    : subShotActive && subShotAsset
      ? [subShotAsset, ...subShotExtraReferences.map((r) => r.asset)]
      : [...referenceImages, ...referenceVideos].map((item) => item.asset);

  // Compose the text content. Two paths:
  //   - opts.prebuiltText: caller has the user-edited final prompt (post audit), use it verbatim.
  //   - else: run promptCompose.composeSeedanceVideoText with the resolved context + lang.
  // The composer is the single source of truth for the assembled text — same code path drives
  // dryRun preview returned by /api/shots/:id/generate?dryRun=true.
  const textContent = opts.prebuiltText && opts.prebuiltText.trim().length > 0
    ? opts.prebuiltText
    : composeSeedanceVideoText(
        {
          shot,
          referencedAssets: promptAssetsForText,
          firstFrameAsset: useFirstFrameMode ? firstFrameAsset : undefined,
          lastFrameAsset: useLastFrameMode ? lastFrameAsset : undefined,
          subShotAsset: subShotActive ? subShotAsset : undefined,
          subShotPanelCount: subShotActive ? subShotPanelCount : undefined,
          hasContinuityVideo: Boolean(continuityVideoUrl),
          hasContinuityAudio: Boolean(continuityAudioUrl),
          resolution: process.env.SEEDANCE_RATIO || "16:9"
        },
        lang
      ).composedPrompt;

  return {
    model,
    composedText: textContent,
    content: [
      {
        type: "text",
        text: textContent
      },
      ...(useFirstFrameMode
        ? [
            {
              type: "image_url",
              image_url: { url: firstFrameUrl as string },
              role: "first_frame"
            }
          ]
        : []),
      ...(useLastFrameMode
        ? [
            {
              type: "image_url",
              image_url: { url: lastFrameUrl as string },
              role: "last_frame"
            }
          ]
        : []),
      ...(continuityVideoUrl
        ? [
            {
              type: "video_url",
              video_url: { url: continuityVideoUrl },
              role: "reference_video"
            }
          ]
        : []),
      ...(continuityAudioUrl
        ? [
            {
              type: "audio_url",
              audio_url: { url: continuityAudioUrl },
              role: "reference_audio"
            }
          ]
        : []),
      ...referenceImages.map(({ url }) => ({
        type: "image_url",
        image_url: { url },
        role: "reference_image"
      })),
      ...referenceVideos.map(({ url }) => ({
        type: "video_url",
        video_url: { url },
        role: "reference_video"
      }))
    ],
    generate_audio: opts.generateAudio !== undefined ? opts.generateAudio : (process.env.SEEDANCE_GENERATE_AUDIO !== "false"),
    ratio: process.env.SEEDANCE_RATIO || "16:9",
    duration: getShotDurationSec(shot),
    watermark: process.env.SEEDANCE_WATERMARK === "true",
    ...(process.env.SEEDANCE_RESOLUTION ? { resolution: process.env.SEEDANCE_RESOLUTION } : {})
  };
}

function resolveFirstFrameAsset(shot: Shot, assets: Asset[]): Asset | undefined {
  if (!shot.firstFrameAssetId) return undefined;
  return assets.find((asset) => asset.id === shot.firstFrameAssetId);
}

function resolveLastFrameAsset(shot: Shot, assets: Asset[]): Asset | undefined {
  if (!shot.lastFrameAssetId) return undefined;
  return assets.find((asset) => asset.id === shot.lastFrameAssetId);
}

function buildFirstFrameInstruction(asset?: Asset) {
  const label = asset?.name ? `@${asset.name.replace(/\s*\/\s*/g, "/").replace(/\s+/g, "")}` : "the attached first-frame image";
  return [
    `First-frame mode: the attached image is the literal first frame of the video.`,
    `Animate FROM that exact frame (composition, character, lighting, framing match ${label}).`,
    `Do not treat it as a generic style reference; do not cut away from it at t=0.`
  ].join(" ");
}

function buildFirstLastFrameInstruction(firstAsset?: Asset, lastAsset?: Asset) {
  const firstLabel = firstAsset?.name ? `@${firstAsset.name.replace(/\s+/g, "")}` : "the first attached image";
  const lastLabel = lastAsset?.name ? `@${lastAsset.name.replace(/\s+/g, "")}` : "the second attached image";
  return [
    `First-and-last frame mode: the two attached images are the literal start and end frames of the video.`,
    `Frame 1 (${firstLabel}) is the very first frame; Frame 2 (${lastLabel}) is the very last frame.`,
    `Interpolate motion smoothly between the two: composition, character identity, lighting and framing must match the start and resolve onto the end.`,
    `Do not cut, do not reset, do not introduce content that contradicts either anchor frame.`
  ].join(" ");
}

function buildSubShotSequenceInstruction(panelCount: number) {
  // The exact sequencing phrase used in the EvoLink GPT-Image-2 / Seedance 2.0 community
  // workflow (Cases 2 + 10). Seedance reads panel positions left→right, top→bottom as a TIMELINE
  // and produces ONE video that internally cuts between those N moments.
  return [
    `Storyboard-sequence mode: the attached image1 is a single composite of ${panelCount} reference panels arranged as a storyboard grid (read left-to-right, top-to-bottom).`,
    `Follow the storyboard sequence of the ${panelCount} reference frames in image1, edited as a fast-cut cinematic sequence.`,
    `Each panel is one beat of the timeline; output a single continuous video that cuts through all ${panelCount} beats in order.`,
    `Distribute panel beats roughly evenly across the duration. Keep transitions smooth, preserve character identity, lighting and palette across cuts. Do NOT compose the output as a grid; do NOT show panel borders or labels in the output video.`
  ].join(" ");
}

async function getSeedanceMediaUrl(url?: string | null) {
  if (!url) return undefined;
  if (/^https?:\/\//.test(url)) return url;
  if (url.startsWith("/media/")) {
    const dataUrl = await readLocalMediaAsDataUrl(url);
    if (dataUrl) return dataUrl;
    const publicBase = process.env.PUBLIC_MEDIA_BASE_URL || process.env.MEDIA_PUBLIC_BASE_URL || process.env.APP_PUBLIC_URL;
    const base = (publicBase || `http://127.0.0.1:${process.env.PORT || 5173}`).replace(/\/$/, "");
    return `${base}${url}`;
  }
  return undefined;
}

function getSeedanceWebUrl(url?: string | null) {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) return undefined;
    if (["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)) return undefined;
    return url;
  } catch {
    return undefined;
  }
}

type BuildVideoPromptOptions = {
  continuityVideoFirst?: boolean;
  firstFrameAsset?: Asset;
};

function buildContinuityInstruction() {
  return [
    "Shot-to-shot continuity reference:",
    "Video 1 is the immediate previous shot, especially its final seconds. Use it as temporal continuity context, not as a generic style sample.",
    "The user's original prompt defines what happens next. Add only the missing connective tissue needed to make the new shot feel like the next beat after Video 1.",
    "Begin after the final moment of Video 1. Do not replay the same frames, do not restart the same action, and do not make the character return to an earlier pose unless the user explicitly asks for it.",
    "Carry forward concrete continuity cues from Video 1: character emotion, eyeline, body direction, blocking, spatial relationship, prop state, scene geography, weather, practical light sources, color temperature, exposure, texture, lens feel, framing center, camera height, camera movement direction, movement speed, rhythm, and pacing.",
    "For audio continuity, keep the ambience, room tone, music energy, rhythm, BPM feel, instrumentation, and sound texture consistent with Video 1. Let sound evolve naturally with the new action instead of abruptly switching style.",
    "If @ asset images are present, they control identity, costume, props, and scene design. Video 1 controls the handoff, motion, camera continuity, and audio/tempo continuity. If these references conflict, prioritize the user's prompt first, then @ asset identity/design, then Video 1 continuity.",
    "If the user's prompt explicitly asks for a jump cut, scene change, time skip, silence, or new music, follow the user's prompt over this continuity instruction."
  ].join("\n");
}

async function readLocalMediaAsDataUrl(url: string) {
  const mediaPath = resolveMediaPath(url);
  if (!mediaPath) return undefined;
  const bytes = await readFile(mediaPath);
  const ext = path.extname(mediaPath).toLowerCase();
  const mime =
    ext === ".mp4"
      ? "video/mp4"
      : ext === ".mov"
        ? "video/quicktime"
        : ext === ".webm"
          ? "video/webm"
          : ext === ".mp3"
            ? "audio/mpeg"
            : ext === ".wav"
              ? "audio/wav"
              : ext === ".png"
                ? "image/png"
                : ext === ".webp"
                  ? "image/webp"
                  : "image/jpeg";
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

function resolveMediaPath(url: string) {
  if (!url.startsWith("/media/")) return undefined;
  const mediaFile = decodeURIComponent(url).replace(/^\/media\/?/, "");
  const candidate = path.resolve(MEDIA_DIR, mediaFile);
  return candidate.startsWith(`${MEDIA_DIR}${path.sep}`) ? candidate : undefined;
}

function getAssetMediaUrl(asset: Asset, kind: "image" | "video") {
  const mediaKind = asset.mediaKind || (asset.imageUrl ? "image" : "none");
  if (kind === "image" && mediaKind === "image") return toPublicMediaUrl(asset.mediaUrl || asset.imageUrl);
  if (kind === "video" && mediaKind === "video") return toPublicMediaUrl(asset.mediaUrl || asset.imageUrl);
  return undefined;
}

function toPublicMediaUrl(url?: string) {
  if (!url?.startsWith("/media/")) return url;
  const publicBase = process.env.PUBLIC_MEDIA_BASE_URL || process.env.MEDIA_PUBLIC_BASE_URL || process.env.APP_PUBLIC_URL;
  if (!publicBase) return url;
  return `${publicBase.replace(/\/$/, "")}${url}`;
}

function getShotDurationSec(shot: Pick<Shot, "durationSec">) {
  return Math.min(Math.max(Number(shot.durationSec) || 1, 1), 15);
}

// Hard ban on any on-screen text/captions/HUD/watermarks/logos in generated clips. Subtitles are
// added in post (NarrationPanel hard-burns SRT via ffmpeg) and editors often want a clean plate.
// Allowed: text that is naturally part of the physical world being filmed (e.g. a store sign,
// a poster, content on a laptop screen the character is showing).
const NO_TEXT_OVERLAY_INSTRUCTION =
  "STRICT NO-TEXT-OVERLAY RULE: do NOT render any on-screen subtitles, captions, lower-thirds, " +
  "title cards, opening/closing credits, on-screen typography, lyric lines, kinetic text, " +
  "watermarks, logos, channel bugs, timestamps, or HUD readouts of any kind. The final cut must " +
  "be a clean text-free plate so the editor can add subtitles in post. Physical-world text that " +
  "naturally lives in the scene (e.g. a Starbucks shop sign in the background, content visible " +
  "on a laptop screen the character is showing) is allowed — but DO NOT add any overlay text on " +
  "top of the footage.";

function buildVideoPrompt(shot: Pick<Shot, "rawPrompt" | "prompt" | "durationSec">, assets: Asset[] = [], options: BuildVideoPromptOptions = {}) {
  const duration = getShotDurationSec(shot);
  const resolution = process.env.SEEDANCE_RATIO || "16:9";
  const referenceText = buildAssetReferenceText(assets, options);
  return [
    (shot.rawPrompt || shot.prompt || "").trim(),
    referenceText,
    NO_TEXT_OVERLAY_INSTRUCTION,
    `Generation duration: ${duration}s.`,
    `Resolution / aspect ratio: ${resolution}.`,
    "The duration and resolution values above come from the UI/system settings and are authoritative. If any earlier text mentions conflicting duration or resolution, ignore it."
  ]
    .filter(Boolean)
    .join("\n");
}

function buildAssetReferenceText(assets: Asset[], options: BuildVideoPromptOptions) {
  if (!assets.length) return "";
  const lines = ["Referenced assets from @ mentions. Use these references only for the named asset roles; do not invent extra story beats from them."];
  // In first-frame mode the very first image_url attachment IS the first frame, so we annotate it
  // explicitly and start indexing other images at 2.
  let imageIndex = options.firstFrameAsset ? 2 : 1;
  let videoIndex = options.continuityVideoFirst ? 2 : 1;
  let otherIndex = 1;

  for (const asset of assets) {
    const name = asset.name.replace(/\s*\/\s*/g, "/");
    const description = asset.description || asset.prompt || "";
    const usage = getAssetReferenceUsage(asset);
    const isFirstFrame = options.firstFrameAsset && asset.id === options.firstFrameAsset.id;
    if (isFirstFrame) {
      lines.push(`Image 1 (first_frame): @${name} = ${asset.type} asset "${asset.name}". This is the literal first frame of the generated video; animate forward from this exact composition. ${description}`.trim());
      continue;
    }
    if (asset.mediaKind === "image") {
      lines.push(`Image ${imageIndex}: @${name} = ${asset.type} asset "${asset.name}". ${usage} ${description}`.trim());
      imageIndex += 1;
    } else if (asset.mediaKind === "video") {
      lines.push(`Video ${videoIndex}: @${name} = ${asset.type} asset "${asset.name}". Use this asset video only for its named motion, layout, or visual behavior; do not confuse it with Video 1 previous-shot continuity. ${description}`.trim());
      videoIndex += 1;
    } else {
      lines.push(`Asset ${otherIndex}: @${name} = ${asset.type} asset "${asset.name}". ${usage} ${description}`.trim());
      otherIndex += 1;
    }
  }

  return lines.join("\n");
}

function getAssetReferenceUsage(asset: Asset) {
  if (asset.type === "character") return "Maintain the character identity, face, body type, costume, and recognizable expression details from this reference.";
  if (asset.type === "scene") return "Maintain the scene layout, key objects, lighting logic, palette, weather, and spatial geography from this reference.";
  if (asset.type === "prop") return "Maintain the prop shape, material, scale, state, and how it is held or used from this reference.";
  if (asset.type === "style") return "Maintain the visual style only when it does not override character identity, scene continuity, or the user's prompt.";
  return "Use this reference for its explicitly named visual details while keeping the user's prompt authoritative.";
}

export function resolveSeedanceModel(shot: Pick<Shot, "seedanceVariant">) {
  const usesAgentPlan = seedanceCredential().source === "agent-plan";
  if (shot.seedanceVariant === "fast") {
    return usesAgentPlan
      ? process.env.SEEDANCE_AGENT_PLAN_FAST_MODEL || AGENT_PLAN_SEEDANCE_FAST_MODEL
      : process.env.SEEDANCE_FAST_MODEL || BYTEPLUS_SEEDANCE_FAST_MODEL;
  }
  return usesAgentPlan
    ? process.env.SEEDANCE_AGENT_PLAN_MODEL || AGENT_PLAN_SEEDANCE_MODEL
    : process.env.SEEDANCE_MODEL || BYTEPLUS_SEEDANCE_MODEL;
}

async function requestSeedanceJson(
  url: string,
  apiKey: string,
  init?: RequestInit & { idempotent?: boolean; tag?: string }
) {
  // Default idempotency from HTTP method: GET is safe to retry on timeout/5xx, POST isn't unless
  // the caller explicitly opts in (cancel-task is idempotent by Seedance contract).
  const method = (init?.method || "GET").toUpperCase();
  const idempotent = init?.idempotent ?? method === "GET";
  const response = await fetchWithRetry(url, {
    ...init,
    headers: {
      ...jsonHeaders(apiKey),
      ...(init?.headers ?? {})
    },
    idempotent,
    tag: init?.tag || `seedance:${method.toLowerCase()}`
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(decorateSeedanceError(response.status, text.slice(0, 1000)));
  return body;
}

function extractTaskId(body: unknown) {
  if (!isRecord(body)) throw new Error("Seedance create response is not an object");
  const data = isRecord(body.data) ? body.data : undefined;
  const taskId = body.id || body.task_id || data?.id || data?.task_id;
  if (!taskId) throw new Error(`Seedance task id not found: ${JSON.stringify(body).slice(0, 1000)}`);
  return String(taskId);
}

function extractStatus(body: unknown) {
  const data = isRecord(body) && isRecord(body.data) ? body.data : body;
  if (!isRecord(data)) return "";
  return String(data.status || "").toLowerCase();
}

function extractGenerationError(body: unknown): unknown {
  const data = isRecord(body) && isRecord(body.data) ? body.data : body;
  if (!isRecord(data)) return body;
  return data.error || data.message || data.reason || body;
}

function buildAssetPromptExpansionInstruction(asset: Partial<Asset>) {
  const rawPrompt = [asset.name, asset.prompt || asset.description].filter(Boolean).join("，").trim() || "未命名电影资产";
  if (asset.type === "character") {
    return [
      "请把用户原始角色描述扩写成 Seedream 4.5 文生图最终 prompt。语言：中文。最长不超过 800 字。结构必须按下面骨架填充。",
      "**用途声明（写到 prompt 前部）**：这张图是下游 Seedance 视频生成的**角色参考底板**，会被反复读取以保持角色身份。因此扩写必须强制五项中性原则：**中性表情**（嘴自然闭合，眼平视镜头，无笑无怒无嘟嘴无瞪眼）、**中性手势**（双手自然下垂或微贴大腿，不抱胸不插兜不指向不持物，除非用户原文显式列出随身道具）、**中性身姿**（站直自然，无奔跑无下蹲无跳跃）、**均匀中性光**（避免硬阴影、单方向强光、彩色 gel）、**中性调色**（不要 push 情绪 grade）。即便用户原文出现情绪词（如「好欺负」「自信」「凶狠」），也只能转化为五官与气质（眉眼造型、下颌线、姿态比例），**不能转化为表演动作或夸张表情**。",
      "硬性输出：**一张** 16:9 横构图，**真实真人照片级 photoreal live-action** 角色参考图，画面内只能出现一个真实成年人角色；**横向并排**展示同一角色三个全身视图——左：正面 / 中：三分之四侧面 / 右：背面。每视图全身从头到脚完整入画，**不要裁切头顶或鞋底**，三视图脚踝水平线对齐。",
      "一致性约束：三个视图必须是同一个角色——人物比例、五官、肤色、发型与发色、瞳色、表情、服装款式与配色、配饰、随身道具、鞋款必须**像素级一致**。",
      "姿态：自然克制 A-pose；正面视图直面镜头与观众平视，三分之四侧面视图微转身体露出侧脸轮廓与服装侧缝，背面视图展示后背结构、发型轮廓、服装背面构造。",
      "摄影规格：**ARRI Alexa Mini LF + Zeiss Supreme Prime 50mm T1.5 + Kodak Vision3 250D 数字模拟胶片质感**；f/5.6 中等景深，三个视图的面部、眼睛、头发边缘、服装轮廓全部清晰锐利；禁止虚焦、散焦、motion blur、低清噪点。",
      "光线：影棚四点布光——**主光（key）**右上 45° 大尺寸柔光箱（Skypanel 类）；**辅光（fill）**正面环形 LED 1/2 强度填阴；**轮廓光（rim）**后侧轻微钨丝勾边分离；**发光（hair light）**顶部柔光勾发丝。色温 5500K 日光平衡，CRI 95+，无硬阴影。",
      "材质：真实真人皮肤纹理（自然毛孔、法令纹、眼周细纹、胡茬或剃须痕迹、微小油光，subsurface scattering 自然，**无塑料感**）；布料纤维清晰可辨；金属、皮革、丝绸按物性如实表现。",
      "背景：纯净影棚——**light grey to mid grey seamless paper backdrop**（浅灰到中灰 seamless 影棚纸），脚下 ~0.5m 极淡接触阴影；不要杂物、家具、地砖、纹理、装饰。",
      "调色：胶片级——低饱和、低对比、温和肤色，highlight 软卷曲，shadow 保留细节，**Kodak Vision3 颗粒**；不要数码 HDR、不要广告片 ACES 看法。",
      "结尾负面（必须放在 prompt 最后）：**STRICT NEGATIVE**——不要任何屏幕文字 / 字幕 / 对白气泡 / 品牌 LOGO / UI / 水印 / 签名 / 二维码；不要第二个人；不要 anime / cartoon / illustration / painting / game CG / 3D 渲染感 / 蜡像感；不要塑料皮肤；不要脸部模糊 / 低分辨率 / 虚焦 / motion blur / 眼睛糊；不要变形或多余手指；不要饱和度过高；不要 HDR halo；不要现代乱入元素。",
      `用户原始描述：${rawPrompt}`
    ].join("\n");
  }
  if (asset.type === "scene") {
    return [
      "请把用户原始场景描述扩写成 Seedream 4.5 文生图最终 prompt。语言：中文。最长不超过 800 字。结构必须按下面骨架填充。",
      "**用途声明（写到 prompt 前部）**：这张图是下游 Seedance 视频生成的**场景参考底板**，Seedance 会在不同分镜把演员置入这个场景。因此扩写必须强制：**画面绝对干净无人物**（包括玻璃倒影、远处剪影、镜面反射、屏幕里、橱窗内均不可有人）；**前景下半部 1/3 留白**（仅干净地面/桌面/走廊地板，不堆放主体），便于演员置入；**光线默认明亮中性、曝光充足、干净通透**（避免逆光剪影、彩色霓虹主导、极端 god ray、低照度脏暗氛围），让 Seedance 在该底板上自由演员置入与打光；**中性调色**（不要 push 极端情绪 grade）。必须尊重用户原文的清洁度与明暗：普通办公室、家居、学校、医院、商场等现代室内默认干净、维护良好、专业明亮；只有用户原文明确要求老旧、破败、肮脏、潮湿、恐怖、夜晚、犯罪现场等，才加入脏污、霉斑、烟雾或低调光。",
      "硬性输出：16:9 横构图电影级**全景空镜 establishing plate**，**画面内不出现任何人物**（除非用户原文显式要求），重点是环境、光线、氛围。",
      "摄影规格：**ARRI Alexa 35 + Cooke S7/i 32mm T2.0**（场景需要时改 Master Anamorphic 40mm T1.9 加水平蓝色 lens flare）；f/5.6-8 大景深保证全景纵深；轻微 anamorphic 横向 oval bokeh；2.39:1 cinemascope feel 在 16:9 内构图。",
      "光线：**干净可读的 motivated practical lighting**——优先使用与场景匹配的自然窗光、天窗漫射、办公/商业空间 overhead softbox / fluorescent practicals、墙面反弹光、柔和环境补光；默认高键、明亮、通透、曝光充足，主光方向明确，前景留白区域明亮干净。仅当用户原文明确要求夜晚、霓虹、烛火、废墟、恐怖、潮湿、烟雾等氛围时，才加入街灯 / 霓虹 / 烛火 / god ray / atmospheric haze；时间设定与原文一致（daylight / golden hour / blue hour / night / overcast / 黎明）。",
      "构图：**foreground / mid-ground / background 三层景深**清晰可读；三分法或对称中心；leading lines 与 vanishing point 明确。",
      "材质：真实但整洁——地面 / 墙面 / 织物 / 玻璃 / 木材 / 金属各有质感差别；默认维护良好、干净清爽、无脏污破败，可有少量生活化使用痕迹；只有用户原文明确要求老旧、破败、肮脏、潮湿、废墟、贫民窟、犯罪现场等，才加入表面老化、积尘、油渍、霉斑、湿漉反光。",
      "调色：cinema 调色——默认**中性日光 / clean commercial cinema grade**，白平衡准确，色彩自然，低到中等对比，highlight 软卷曲，shadow 保留细节，细腻 35mm 胶片颗粒；办公室、家居、商场、医院、学校等现代室内优先明亮温和、干净专业。只有用户原文明确要求阴郁、黑色电影、战争、80s、赛博朋克等风格时，才使用 teal-orange / ENR / bleach bypass / 暖色 push。",
      "结尾负面（必须放在 prompt 最后）：**STRICT NEGATIVE**——不要任何屏幕文字 / 字幕 / 可读招牌字 / UI / 水印；**不要任何人物**（除非原文显式要求）；不要变形物体；不要饱和度爆表；不要 HDR halo / 锐化过度；不要 anime / cartoon。",
      `用户原始描述：${rawPrompt}`
    ].join("\n");
  }
  if (asset.type === "prop") {
    return [
      "请把用户原始道具描述扩写成 Seedream 4.5 文生图最终 prompt。语言：中文。最长不超过 600 字。",
      "硬性输出：1:1 方画幅产品级 hero shot，**单一主体居中**，全部入画。",
      "摄影规格：**Phase One IQ4 + Schneider 90mm T/S Macro**（或 90mm-equivalent macro），f/8 全幅锐利，主体占画面 60-70%，干净三分构图。",
      "光线：三点布光——柔和顶部主光（diffused top key）+ 后侧 rim light 勾轮廓与背景分离 + 正面填充。色温 5000K，无杂乱反射。",
      "材质：金属（specular + 各向异性反射）、皮革（毛孔 + 磨损 + 染色不均）、玻璃（透射 + 折射 + 高光）、布料（weave + drape）、木材（年轮 + 抛光）按物性如实。",
      "背景：中性渐变背景纸（light-grey to dark-grey seamless），脚下极淡接触阴影；不要桌面纹理、装饰、第二物体。",
      "结尾负面（必须放在 prompt 最后）：**STRICT NEGATIVE**——不要文字 / 品牌 LOGO（除非原文包含）/ 价格标签 / 水印；不要第二个物体；不要塑料合成感；不要 HDR halo；不要广角畸变。",
      `用户原始描述：${rawPrompt}`
    ].join("\n");
  }
  if (asset.type === "style") {
    return [
      "请把用户原始风格描述扩写成 Seedream 4.5 文生图最终 prompt。语言：中文。最长不超过 600 字。",
      "硬性输出：16:9 横构图风格 mood board——用一张有代表性的电影画面承载该风格的所有视觉特征。",
      "摄影规格：**ARRI Alexa Mini LF + Master Anamorphic 50mm T1.9**，f/2.8 浅景深，35mm 胶片质感，2.39:1 cinemascope。",
      "光线：遵循该风格核心特征（noir = 高对比硬光 + Venetian blind / impressionist = 柔光散射 / cyberpunk = 霓虹 practicals + 雨夜湿地反光 / Wes Anderson = 平面正面光 + 严格 hue keys）。",
      "调色：作为该风格的灵魂——色温倾向、饱和度、对比度、highlight rolloff、shadow detail、film grain 都需精准还原（noir = ENR / 50s = 高饱和泡沫粉 / 现代独立 = teal-orange / 战争 = bleach bypass）。",
      "构图：能代表该风格的镜头语言（noir = 低角度斜线 / new wave = 中景跳切感 / Wes Anderson = 严格中心对称 / Tarkovsky = 缓慢推进对称）。",
      "结尾负面（必须放在 prompt 最后）：**STRICT NEGATIVE**——不要文字 / 字幕 / UI；不要风格混搭；不要漫画 / 3D 渲染（除非风格本身要求）；不要 HDR halo。",
      `用户原始描述：${rawPrompt}`
    ].join("\n");
  }
  return [
    "请把用户原始资产描述扩写成 Seedream 4.5 文生图最终 prompt。",
    "要求：ARRI Alexa Mini LF + 50mm prime + 35mm 胶片质感；主体清晰，材质细节明确；干净高级。",
    "结尾负面：**STRICT NEGATIVE**——不要文字 / 字幕 / 水印 / UI / HDR halo / 现代乱入元素。",
    `资产类型：${asset.type || "other"}`,
    `用户原始描述：${rawPrompt}`
  ].join("\n");
}

function buildLocalExpandedAssetPrompt(asset: Partial<Asset>) {
  const rawPrompt = [asset.name, asset.prompt || asset.description].filter(Boolean).join("，").trim() || "一个电影短片资产";
  if (asset.type === "character") {
    return [
      `电影角色设定参考表（character lookbook turnaround）：${rawPrompt}。`,
      "**一张** 16:9 横构图，**真实真人照片级 photoreal live-action** 角色参考图，画面内只能出现一个真实成年人角色；**横向并排**展示同一角色三个全身视图——左：正面 / 中：三分之四侧面 / 右：背面。每视图全身从头到脚完整入画，不要裁切头顶或鞋底。三视图脚踝水平线对齐。",
      "三个视图必须是同一个角色：人物比例、五官、肤色、发型与发色、瞳色、表情、服装款式与配色、配饰、随身道具、鞋款**像素级一致**。",
      "姿态：自然克制 A-pose。正面直面镜头平视；三分之四侧面微转身体露出侧脸与服装侧缝；背面展示后背结构、发型轮廓、服装背面。",
      "**ARRI Alexa Mini LF + Zeiss Supreme Prime 50mm T1.5 + Kodak Vision3 250D 数字胶片质感**，f/5.6 中等景深，三个视图的面部、眼睛、头发边缘、服装轮廓全部清晰锐利；禁止虚焦、散焦、motion blur、低清噪点。",
      "影棚四点布光：主光右上 45° 大柔光箱（Skypanel 类）+ 正面环形 LED 1/2 强度 fill + 后侧钨丝 rim + 顶部 hair light。5500K 日光平衡，CRI 95+，无硬阴影。",
      "真实真人皮肤纹理（自然毛孔、法令纹、眼周细纹、胡茬或剃须痕迹、微小油光，subsurface scattering 自然，**无塑料感**）；布料纤维与编织清晰；金属、皮革、丝绸按物性如实表现。",
      "纯净影棚：light-grey to mid-grey seamless paper backdrop，脚下 ~0.5m 极淡接触阴影，无杂物。",
      "Kodak Vision3 调色：低饱和、低对比、温和肤色，highlight 软卷曲，shadow 保留细节，胶片颗粒，**不要 HDR halo**。",
      "**STRICT NEGATIVE**：不要任何屏幕文字 / 字幕 / 对白气泡 / 品牌 LOGO / UI / 水印 / 签名；不要第二人；不要 anime / cartoon / illustration / painting / game CG / 3D 渲染 / 蜡像感；不要塑料皮肤；不要脸部模糊 / 低分辨率 / 虚焦 / motion blur / 眼睛糊；不要变形或多余手指；不要饱和度过高；不要 HDR halo；不要现代乱入元素。"
    ].join(" ");
  }
  if (asset.type === "scene") {
    return [
      `电影场景 establishing plate：${rawPrompt}。`,
      "16:9 横构图电影级**全景空镜**，**画面内不出现任何人物**（除非描述显式要求）。",
      "**ARRI Alexa 35 + Cooke S7/i 32mm T2.0**（或 Master Anamorphic 40mm T1.9 加水平蓝色 lens flare），f/5.6-8 大景深，轻微 anamorphic 横向 oval bokeh，2.39:1 cinemascope feel 在 16:9 内构图。",
      "干净可读的 motivated practical lighting：优先自然窗光、天窗漫射、办公/商业空间 overhead softbox / fluorescent practicals、墙面反弹光、柔和环境补光；默认高键、明亮、通透、曝光充足。仅当描述明确要求夜晚、霓虹、烛火、废墟、恐怖、潮湿、烟雾等氛围时，才加入街灯 / 霓虹 / 烛火 / god ray / atmospheric haze；时间设定与描述一致。",
      "**foreground / mid-ground / background 三层景深**清晰可读；三分法或对称中心；leading lines 与 vanishing point 明确。",
      "材质真实但整洁：地面 / 墙面 / 织物 / 玻璃 / 木材 / 金属质感各有差别；默认维护良好、干净清爽、无脏污破败，可有少量生活化使用痕迹；只有描述明确要求老旧、破败、肮脏、潮湿、废墟、贫民窟、犯罪现场等，才加入积尘、油渍、霉斑、湿漉反光。",
      "cinema 调色：默认中性日光 / clean commercial cinema grade，白平衡准确，色彩自然，低到中等对比，highlight 软卷曲，shadow 保留细节，细腻 35mm 胶片颗粒；办公室、家居、商场、医院、学校等现代室内优先明亮温和、干净专业；只有描述明确要求阴郁、黑色电影、战争、80s、赛博朋克等风格时，才使用 teal-orange / ENR / bleach bypass / 暖色 push。",
      "**STRICT NEGATIVE**：不要任何屏幕文字 / 字幕 / 可读招牌字 / UI / 水印；**不要任何人物**（除非描述显式要求）；不要变形物体；不要饱和度爆表；不要 HDR halo；不要 anime / cartoon。"
    ].join(" ");
  }
  if (asset.type === "prop") {
    return [
      `电影道具参考图：${rawPrompt}。`,
      "1:1 方画幅产品级 hero shot，单一主体居中，全部入画。",
      "**Phase One IQ4 + Schneider 90mm T/S Macro**（或 90mm 微距），f/8 全幅锐利，主体占 60-70%。",
      "三点布光：柔和顶部主光 + 后侧 rim + 正面 fill；5000K，无杂乱反射。",
      "材质如实：金属（specular + 各向异性）、皮革（毛孔 + 磨损 + 染色不均）、玻璃（透射 + 折射）、布料（weave + drape）、木材（年轮 + 抛光）。",
      "中性渐变背景纸（light-grey to dark-grey seamless），淡接触阴影，无杂物。",
      "**STRICT NEGATIVE**：不要文字 / LOGO（除非描述包含）/ 价格标签 / 水印 / 第二物体 / 塑料合成感 / HDR halo / 广角畸变。"
    ].join(" ");
  }
  if (asset.type === "style") {
    return [
      `电影风格 mood-board reference：${rawPrompt}。`,
      "16:9 横构图风格 mood board，用一张有代表性的电影画面承载所有视觉特征。",
      "**ARRI Alexa Mini LF + Master Anamorphic 50mm T1.9**，f/2.8 浅景深，35mm 胶片质感，2.39:1 cinemascope。",
      "光线 / 调色 / 构图按该风格核心特征精准还原（noir = 高对比硬光 + ENR / cyberpunk = 霓虹 practicals + 湿地反光 / Wes Anderson = 平面正面 + 严格中心对称）。",
      "**STRICT NEGATIVE**：不要文字 / 字幕 / UI；不要风格混搭；不要漫画 / 3D 渲染（除非风格要求）；不要 HDR halo。"
    ].join(" ");
  }
  return `${rawPrompt}。电影资产参考图，ARRI Alexa Mini LF + 50mm prime + 35mm 胶片质感；主体清晰，材质细节明确，构图干净高级。**STRICT NEGATIVE**：不要文字 / 字幕 / 水印 / UI / 现代乱入元素 / HDR halo。`;
}

function extractResponseText(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  if (typeof body.output_text === "string") return body.output_text.trim();
  const output = body.output;
  if (Array.isArray(output)) {
    const parts = output.flatMap((item) => {
      if (!isRecord(item) || !Array.isArray(item.content)) return [];
      return item.content.flatMap((content) => {
        if (!isRecord(content)) return [];
        if (typeof content.text === "string") return [content.text];
        if (typeof content.output_text === "string") return [content.output_text];
        return [];
      });
    });
    const text = parts.join("").trim();
    if (text) return text;
  }
  return undefined;
}

function findUrl(value: unknown, keys: string[]): string | undefined {
  if (isRecord(value)) {
    for (const key of keys) {
      const found = value[key];
      if (typeof found === "string" && found.startsWith("http")) return found;
      if (isRecord(found) && typeof found.url === "string" && found.url.startsWith("http")) return found.url;
    }
    for (const nested of Object.values(value)) {
      const found = findUrl(nested, keys);
      if (found) return found;
    }
  }
  if (Array.isArray(value)) {
    for (const nested of value) {
      const found = findUrl(nested, keys);
      if (found) return found;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export async function cacheGeneratedVideo(videoUrl: string, renderId: string) {
  if (isLocalReusableVideoUrl(videoUrl) || videoUrl.includes("placehold.co")) {
    return { videoUrl };
  }
  if (!isHttpUrl(videoUrl)) return { videoUrl };

  await mkdir(MEDIA_DIR, { recursive: true });
  const extension = videoExtensionFromUrl(videoUrl);
  const outputName = `shot-render-${sanitizeFilePart(renderId)}${extension}`;
  const outputPath = path.join(MEDIA_DIR, outputName);
  await downloadVideoToFile(videoUrl, outputPath, `render ${renderId}`);
  // Re-mux with `+faststart` so the moov atom lives at the front of the file. Without this, every
  // browser playing the cached mp4 has to download the full file before the player can start
  // (since moov holds the keyframe index). With faststart, the player streams from the first byte
  // and starts within ~100 ms. This is the single biggest UX win for canvas video playback.
  await remuxFaststartIfMp4(outputPath).catch((err) => {
    console.warn(`[cacheGeneratedVideo] faststart remux failed for ${outputName}: ${err instanceof Error ? err.message : err}`);
  });
  return { videoUrl: `/media/${outputName}`, remoteVideoUrl: videoUrl };
}

/**
 * If `filePath` is an mp4/m4v, run a fast `-c copy -movflags +faststart` remux so the moov atom
 * is moved to the front. Atomic — writes to a sibling tmp file then renames over the original.
 * No-op for non-mp4 containers and for files where moov is already at the head.
 */
export async function remuxFaststartIfMp4(filePath: string): Promise<void> {
  const ext = path.extname(filePath).toLowerCase();
  if (ext !== ".mp4" && ext !== ".m4v") return;
  // Probe: cheaply check whether faststart is already applied. Use ffmpeg's `-v trace` and inspect
  // the offsets of the first top-level moov / mdat boxes; if moov is before mdat, we're done.
  const probe = await new Promise<string>((resolve) => {
    const child = spawn(ffmpeg.path, ["-v", "trace", "-i", filePath, "-f", "null", "-"], {
      stdio: ["ignore", "ignore", "pipe"]
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); if (stderr.length > 64_000) child.kill(); });
    child.on("close", () => resolve(stderr));
    child.on("error", () => resolve(stderr));
  });
  const mdatLine = probe.match(/type:'mdat'\s+parent:'root'\s+sz:\s*\d+\s+(\d+)/);
  const moovLine = probe.match(/type:'moov'\s+parent:'root'\s+sz:\s*\d+\s+(\d+)/);
  if (mdatLine && moovLine) {
    const mdatOff = Number(mdatLine[1]);
    const moovOff = Number(moovLine[1]);
    if (moovOff < mdatOff) return; // already faststart
  }

  const tmpPath = `${filePath}.faststart.tmp.mp4`;
  try {
    await runFfmpegCommand([
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      filePath,
      "-c",
      "copy",
      "-movflags",
      "+faststart",
      tmpPath
    ]);
    await rename(tmpPath, filePath);
  } catch (err) {
    try { await unlink(tmpPath); } catch { /* ignore */ }
    throw err;
  }
}

export type StitchProgressCallback = (phase: string) => void | Promise<void>;

export interface StitchOptions {
  /** Called with a short human-readable phase string as the job progresses. */
  onProgress?: StitchProgressCallback;
  /** Force a fresh final artifact even when the input signature matches an existing file. */
  force?: boolean;
}

export async function stitchShotVideos(sessionId: string, shots: Shot[], options: StitchOptions = {}) {
  const urls = shots.map((shot) => shot.videoUrl).filter(Boolean) as string[];
  if (!urls.length) throw new Error("No generated shots to stitch");
  const logTag = `[stitch ${sessionId}]`;
  const report = async (phase: string) => {
    console.log(`${logTag} ${phase}`);
    try {
      await options.onProgress?.(phase);
    } catch (err) {
      console.warn(`${logTag} progress callback threw: ${(err as Error).message}`);
    }
  };

  if (urls.every((url) => url.includes("placehold.co"))) {
    await report("mock final video (placehold inputs)");
    return {
      finalVideoUrl: `https://placehold.co/1280x720/0b0d10/f4c95d?text=${encodeURIComponent("Mock final video")}`,
      signature: createStitchSignature(shots)
    };
  }

  await mkdir(MEDIA_DIR, { recursive: true });
  const signature = createStitchSignature(shots);
  const runSuffix = options.force ? `-${Date.now()}` : "";
  const outputName = `final-${sessionId}-${signature}${runSuffix}.mp4`;
  const outputPath = path.join(MEDIA_DIR, outputName);
  await report(`signature=${signature} target=${outputName} (${urls.length} shot inputs)`);
  if (!options.force && await hasUsableFinalVideo(outputPath, shots)) {
    await report("reused cached final video (signature unchanged)");
    return { finalVideoUrl: `/media/${outputName}`, signature };
  }

  const total = urls.length;
  const inputs = await mapWithConcurrency(urls, stitchDownloadConcurrency(), async (url, index) => {
    const isHttp = isHttpUrl(url);
    if (isHttp) await report(`downloading shot ${index + 1}/${total}`);
    const localPath = await materializeVideo(url, sessionId, index, signature);
    if (isHttp) await report(`downloaded shot ${index + 1}/${total} -> ${path.basename(localPath)}`);
    return localPath;
  });

  const listPath = path.join(MEDIA_DIR, `${sessionId}-${signature}-concat.txt`);
  await writeFile(listPath, inputs.map((input) => `file '${input.replaceAll("'", "'\\''")}'`).join("\n"), "utf8");

  await report(`ffmpeg concat (libx264 preset=medium crf=18) -> ${outputName}`);
  const concatStart = Date.now();
  await runFfmpeg([
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listPath,
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "18",
    "-pix_fmt",
    "yuv420p",
    "-profile:v",
    "high",
    "-level",
    "4.0",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-movflags",
    "+faststart",
    outputPath
  ]);
  await report(`ffmpeg concat done in ${((Date.now() - concatStart) / 1000).toFixed(1)}s`);
  return { finalVideoUrl: `/media/${outputName}`, signature };
}

async function materializeVideo(url: string, sessionId: string, index: number, signature = "single") {
  const localMediaPath = localMediaPathFromUrl(url);
  if (localMediaPath) {
    if (await hasUsableMediaFile(localMediaPath)) return localMediaPath;
    throw new Error(`Local media is not a readable video: ${localMediaPath}`);
  }
  if (url.startsWith("file://")) return new URL(url).pathname;
  if (!isHttpUrl(url)) return url;

  await mkdir(MEDIA_DIR, { recursive: true });
  const outputPath = path.join(MEDIA_DIR, `stitch-${sessionId}-${signature}-shot-${index + 1}${videoExtensionFromUrl(url)}`);
  if (await hasUsableMediaFile(outputPath)) return outputPath;
  await unlink(outputPath).catch(() => undefined);
  await downloadVideoToFile(url, outputPath, `shot ${index + 1}`);
  return outputPath;
}

async function downloadVideoToFile(url: string, outputPath: string, label: string) {
  // Stream into a sibling .partial file so a torn-down connection can never leave behind a
  // half-written file that later passes the size>0 check in hasUsableMediaFile and gets reused as
  // if it were complete. Only after content-length / etag validation succeeds do we atomically
  // rename it into place.
  const partialPath = `${outputPath}.partial`;
  await unlink(partialPath).catch(() => undefined);

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download ${label}: ${response.status}`);
  if (!response.body) throw new Error(`Failed to download ${label}: empty response body`);

  try {
    await pipeline(
      Readable.fromWeb(response.body as unknown as WebReadableStream<Uint8Array>),
      createWriteStream(partialPath)
    );
    await validateDownloadedVideo(partialPath, response, label);
    await rename(partialPath, outputPath);
  } catch (error) {
    await unlink(partialPath).catch(() => undefined);
    throw error;
  }
}

async function validateDownloadedVideo(outputPath: string, response: Response, label: string) {
  const fileStat = await stat(outputPath).catch(() => undefined);
  if (!fileStat?.size) throw new Error(`Downloaded ${label} is empty`);

  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > 0 && fileStat.size !== contentLength) {
    throw new Error(`Downloaded ${label} is incomplete: ${fileStat.size}/${contentLength} bytes`);
  }

  const etag = (response.headers.get("etag") || "").replaceAll('"', "").toLowerCase();
  if (/^[a-f0-9]{32}$/.test(etag)) {
    const md5 = createHash("md5").update(await readFile(outputPath)).digest("hex");
    if (md5 !== etag) {
      throw new Error(`Downloaded ${label} checksum mismatch: ${md5} != ${etag}`);
    }
  }
}

function isHttpUrl(url: string) {
  return url.startsWith("http://") || url.startsWith("https://");
}

function isLocalReusableVideoUrl(url: string) {
  return Boolean(localMediaPathFromUrl(url)) || url.startsWith("file://");
}

function localMediaPathFromUrl(url: string) {
  if (url.startsWith("/media/")) return path.join(MEDIA_DIR, path.basename(url));
  try {
    const parsed = new URL(url);
    if (["localhost", "127.0.0.1"].includes(parsed.hostname) && parsed.pathname.startsWith("/media/")) {
      return path.join(MEDIA_DIR, path.basename(parsed.pathname));
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function videoExtensionFromUrl(url: string) {
  try {
    return path.extname(new URL(url).pathname) || ".mp4";
  } catch {
    return path.extname(url) || ".mp4";
  }
}

function sanitizeFilePart(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 80) || "video";
}

async function hasUsableFile(filePath: string) {
  try {
    const info = await stat(filePath);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

async function hasUsableMediaFile(filePath: string) {
  if (!(await hasUsableFile(filePath))) return false;
  try {
    await runFfmpeg(["-v", "error", "-i", filePath, "-f", "null", "-"], 2048);
    return true;
  } catch {
    await unlink(filePath).catch(() => undefined);
    return false;
  }
}

async function hasUsableFinalVideo(filePath: string, shots: Shot[]) {
  if (!(await hasUsableMediaFile(filePath))) return false;
  const expectedDurationSec = shots.reduce((sum, shot) => sum + (Number(shot.durationSec) || 0), 0);
  if (!expectedDurationSec) return true;

  const actualDurationSec = await probeVideoDurationSec(filePath).catch(() => 0);
  const minDurationSec = Math.max(1, expectedDurationSec * 0.92);
  if (actualDurationSec >= minDurationSec) return true;

  await unlink(filePath).catch(() => undefined);
  return false;
}

export function probeMediaDurationSec(filePath: string) {
  return probeVideoDurationSec(filePath);
}

function probeVideoDurationSec(filePath: string) {
  return new Promise<number>((resolve, reject) => {
    const child = spawn(ffmpeg.path, ["-hide_banner", "-i", filePath], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-8192);
    });
    child.on("error", reject);
    child.on("close", () => {
      const match = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (!match) return reject(new Error(`Could not probe video duration: ${filePath}`));
      const [, hours, minutes, seconds] = match;
      resolve(Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds));
    });
  });
}

export function createStitchSignature(shots: Shot[]) {
  const selectedVersions = shots.map((shot) => {
    const render = (shot.renders || []).find(
      (item) => item.videoUrl === shot.videoUrl || item.remoteVideoUrl === shot.videoUrl
    );
    return {
      shotId: shot.id,
      index: shot.index,
      renderId: render?.id,
      videoUrl: shot.videoUrl
    };
  });
  return createHash("sha1").update(JSON.stringify({ version: STITCH_SIGNATURE_VERSION, selectedVersions })).digest("hex").slice(0, 12);
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
) {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

export function localMediaPathFromMediaUrl(url: string) {
  return localMediaPathFromUrl(url);
}

export function runFfmpegCommand(args: string[], logBytes?: number) {
  return runFfmpeg(args, logBytes ?? ffmpegLogBytes());
}

function runFfmpeg(args: string[], logBytes = ffmpegLogBytes()) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpeg.path, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderrTail = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderrTail = `${stderrTail}${chunk}`.slice(-logBytes);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolve();
      reject(
        new Error(
          [
            `ffmpeg failed with exit code ${code}.`,
            "请确认输入视频可读取，且没有下载损坏或过期。",
            stderrTail.trim()
          ]
            .filter(Boolean)
            .join("\n")
        )
      );
    });
  });
}
