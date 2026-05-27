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

export const MEDIA_DIR = path.resolve(process.cwd(), "data", "media");
const BYTEPLUS_SEEDANCE_BASE = "https://ark.ap-southeast.bytepluses.com/api/v3";
const BYTEPLUS_SEEDANCE_MODEL = "dreamina-seedance-2-0-260128";
const BYTEPLUS_SEEDANCE_FAST_MODEL = "dreamina-seedance-2-0-fast-260128";
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

export async function generateStoryboard(session: SessionWithShots, assets: Asset[]): Promise<Array<Partial<Shot> & { index?: number }>> {
  if (session.story?.beats?.length) {
    return session.shots.map((shot, index) => {
      const beat = session.story?.beats.find((item) => item.index === shot.index) || session.story?.beats[index % session.story.beats.length];
      return beat ? shotFromStoryBeat(session, beat, shot, assets) : undefined;
    }).filter(Boolean) as Array<Partial<Shot>>;
  }

  const apiKey = openAIKey();
  if (apiKey) {
    try {
      const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: jsonHeaders(apiKey),
        body: JSON.stringify({
          model: process.env.OPENAI_TEXT_MODEL || "gpt-4.1-mini",
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
        const data = (await response.json()) as { output_text?: string; output?: Array<{ content?: Array<{ text?: string }> }> };
        const text = data.output_text || data.output?.flatMap((item) => item.content ?? []).map((item) => item.text).join("");
        if (text) {
          const parsed = JSON.parse(text) as { shots?: Array<Partial<Shot>> };
          if (Array.isArray(parsed.shots) && parsed.shots.length) return parsed.shots;
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

  return session.shots.map((shot, index) => {
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
}

export async function generateStoryPlan(session: SessionWithShots, assets: Asset[]): Promise<StoryPlan> {
  if (session.story?.locked) return normalizeStoryPlan(session.story, session, assets, session.story.model || "locked");

  const fallback = buildLocalStoryPlan(session, assets);
  const apiKey = openAIKey();
  if (!apiKey) return fallback;

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

    if (!response.ok) return fallback;
    const data = (await response.json()) as { output_text?: string; output?: Array<{ content?: Array<{ text?: string }> }> };
    const text = data.output_text || data.output?.flatMap((item) => item.content ?? []).map((item) => item.text).join("");
    if (!text) return fallback;
    return normalizeStoryPlan(JSON.parse(text), session, assets, model);
  } catch {
    return fallback;
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

export async function generateAssetImage(
  asset: Asset,
  model: AssetImageModel = "seedream-4-5",
  referenceImageUrls: string[] = []
) {
  if (model === "seedream-4-5") return generateAssetImageViaSeedream(asset, referenceImageUrls, "seedream-4-5");
  if (model === "seedream-4") return generateAssetImageViaSeedream(asset, referenceImageUrls, "seedream-4");
  return generateAssetImageViaOpenAI(asset, referenceImageUrls);
}

export async function expandAssetPrompt(asset: Partial<Asset>) {
  const model = process.env.SEED_PROMPT_MODEL || "seed-2-0-pro-260328";
  const fallback = buildLocalExpandedAssetPrompt(asset);
  const apiKey = process.env.SEED_PROMPT_API_KEY || process.env.BP_ARK_API_KEY || process.env.ARK_API_KEY;
  if (!apiKey) return { prompt: fallback, model: "local-template" };

  const apiBase = (process.env.SEED_PROMPT_API_BASE || process.env.SEEDANCE_API_BASE || BYTEPLUS_SEEDANCE_BASE).replace(/\/$/, "");
  const response = await fetch(`${apiBase}/responses`, {
    method: "POST",
    headers: {
      ...jsonHeaders(apiKey),
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
  if (!response.ok) throw new Error(`Seed prompt API failed: ${response.status} ${text.slice(0, 1000)}`);
  const body = text ? JSON.parse(text) : {};
  return { prompt: extractResponseText(body) || fallback, model };
}

async function generateAssetImageViaOpenAI(asset: Asset, referenceImageUrls: string[] = []) {
  const apiKey = openAIKey();
  if (!apiKey) {
    return `https://placehold.co/1024x1024/1f2937/f8fafc?text=${encodeURIComponent(asset.name)}`;
  }
  // gpt-image-2 does not accept reference URLs through this endpoint; we only attach a textual hint.
  const referenceHint = referenceImageUrls.length
    ? "\nReference: keep the source image identity, pose, expression, silhouette, color pattern, texture, and composition. If the source is low resolution or blurry, enhance clarity without changing the subject."
    : "";

  const response = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: jsonHeaders(apiKey),
    body: JSON.stringify({
      model: process.env.OPENAI_IMAGE_MODEL || "gpt-image-2",
      prompt: `${asset.prompt || asset.description || asset.name}\nAsset type: ${asset.type}. Clean production reference image, no text overlay.${referenceHint}`,
      size: "1024x1024"
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

type SeedreamVariant = "seedream-4" | "seedream-4-5";

const SEEDREAM_DEFAULT_MODEL: Record<SeedreamVariant, string> = {
  "seedream-4": "seedream-4-0-250828",
  "seedream-4-5": "seedream-4-5-251128"
};

// The 4.5 model accepts the same OpenAI-compatible image-generation request shape as 4.0
// (model + prompt + size + optional image references). We keep a per-variant model id and a shared
// SEEDREAM_SIZE so callers can override either independently.
function resolveSeedreamModelId(variant: SeedreamVariant) {
  if (variant === "seedream-4-5") {
    return process.env.SEEDREAM_45_MODEL || process.env.SEEDREAM_4_5_MODEL || SEEDREAM_DEFAULT_MODEL["seedream-4-5"];
  }
  return process.env.SEEDREAM_MODEL || SEEDREAM_DEFAULT_MODEL["seedream-4"];
}

async function generateAssetImageViaSeedream(
  asset: Asset,
  referenceImageUrls: string[] = [],
  variant: SeedreamVariant = "seedream-4-5"
) {
  const apiKey = process.env.SEEDREAM_API_KEY || process.env.BP_ARK_API_KEY || process.env.ARK_API_KEY;
  if (!apiKey) {
    return `https://placehold.co/2048x2048/1f2937/f8fafc?text=${encodeURIComponent(asset.name)}`;
  }

  const usableRefs = await prepareSeedreamReferenceImages(referenceImageUrls, asset.id);
  const referenceHint = usableRefs.length
    ? "\nReference image attached: preserve the original subject as much as possible: same animal/person/object identity, silhouette, pose, expression, gaze direction, head angle, color pattern, texture, and composition. If the reference is low resolution or blurry, enhance clarity, recover detail, upscale cleanly, and remove compression artifacts without changing the subject."
    : "";

  const apiBase = (process.env.SEEDREAM_API_BASE || process.env.SEEDANCE_API_BASE || BYTEPLUS_SEEDANCE_BASE).replace(/\/$/, "");
  const response = await fetch(`${apiBase}/images/generations`, {
    method: "POST",
    headers: jsonHeaders(apiKey),
    body: JSON.stringify({
      model: resolveSeedreamModelId(variant),
      prompt: `${asset.prompt || asset.description || asset.name}\nAsset type: ${asset.type}. Clean production reference image, no text overlay.${referenceHint}`,
      ...(usableRefs.length ? { image: usableRefs.length === 1 ? usableRefs[0] : usableRefs } : {}),
      sequential_image_generation: "disabled",
      response_format: "url",
      size: process.env.SEEDREAM_SIZE || "2K",
      stream: false,
      watermark: false
    })
  });

  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(`Seedream image API failed: ${response.status} ${text.slice(0, 1000)}`);

  const imageUrl = findUrl(body, ["url", "image_url"]);
  if (imageUrl) return imageUrl;
  throw new Error(`Seedream image API returned no image url: ${JSON.stringify(body).slice(0, 1000)}`);
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

export function canUseBytePlusSeedance() {
  return Boolean(!process.env.SEEDANCE_API_URL && (process.env.BP_ARK_API_KEY || process.env.SEEDANCE_API_KEY || process.env.ARK_API_KEY));
}

export async function createSeedanceVideoTask(shot: Shot, assets: Asset[]) {
  const apiKey = process.env.BP_ARK_API_KEY || process.env.SEEDANCE_API_KEY || process.env.ARK_API_KEY;
  if (!apiKey) throw new Error("Missing BP_ARK_API_KEY for Seedance generation");
  const apiBase = (process.env.SEEDANCE_API_BASE || BYTEPLUS_SEEDANCE_BASE).replace(/\/$/, "");
  const payload = await buildBytePlusSeedancePayload(shot, assets);
  const createBody = await requestSeedanceJson(`${apiBase}/contents/generations/tasks`, apiKey, {
    method: "POST",
    body: JSON.stringify(payload)
  });
  return {
    taskId: extractTaskId(createBody),
    model: payload.model,
    createResponse: createBody
  };
}

export async function pollSeedanceVideoTask(taskId: string) {
  const apiKey = process.env.BP_ARK_API_KEY || process.env.SEEDANCE_API_KEY || process.env.ARK_API_KEY;
  if (!apiKey) throw new Error("Missing BP_ARK_API_KEY for Seedance polling");
  const apiBase = (process.env.SEEDANCE_API_BASE || BYTEPLUS_SEEDANCE_BASE).replace(/\/$/, "");
  const body = await requestSeedanceJson(`${apiBase}/contents/generations/tasks/${taskId}`, apiKey);
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
  const apiKey = process.env.BP_ARK_API_KEY || process.env.SEEDANCE_API_KEY || process.env.ARK_API_KEY;
  if (!apiKey) throw new Error("Missing BP_ARK_API_KEY for Seedance cancellation");
  const apiBase = (process.env.SEEDANCE_API_BASE || BYTEPLUS_SEEDANCE_BASE).replace(/\/$/, "");
  const body = await requestSeedanceJson(`${apiBase}/contents/generations/tasks/${taskId}`, apiKey, {
    method: "DELETE"
  });
  return {
    taskId,
    response: body
  };
}

export async function generateShotVideo(shot: Shot, assets: Asset[]) {
  if (process.env.SEEDANCE_API_URL && process.env.SEEDANCE_API_KEY) {
    return generateShotVideoViaCustomEndpoint(shot, assets);
  }

  const apiKey = process.env.BP_ARK_API_KEY || process.env.SEEDANCE_API_KEY || process.env.ARK_API_KEY;
  if (!apiKey) return `https://placehold.co/1280x720/111827/f8fafc?text=${encodeURIComponent(`Video ${shot.index}`)}`;

  return generateShotVideoViaBytePlusArk(shot, assets, apiKey);
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

async function generateShotVideoViaCustomEndpoint(shot: Shot, assets: Asset[]) {
  const apiKey = process.env.SEEDANCE_API_KEY;
  if (!apiKey || !process.env.SEEDANCE_API_URL) throw new Error("Missing SEEDANCE_API_KEY or SEEDANCE_API_URL");
  // Mirror BytePlus behavior: first-frame mode is mutually exclusive with reference media.
  const firstFrameAsset = resolveFirstFrameAsset(shot, assets);
  const firstFrameUrl = firstFrameAsset ? getAssetMediaUrl(firstFrameAsset, "image") : undefined;
  const useFirstFrameMode = Boolean(firstFrameUrl && /^https?:\/\//.test(firstFrameUrl) && !firstFrameUrl.includes("placehold.co"));

  const referenceClipUrl = useFirstFrameMode ? undefined : getSeedanceWebUrl(shot.referenceClipUrl);
  const referenceAudioUrl = useFirstFrameMode ? undefined : getSeedanceWebUrl(shot.referenceAudioUrl);
  const referenceAssets = useFirstFrameMode && firstFrameAsset ? [firstFrameAsset] : assets;
  const prompt = [
    buildVideoPrompt(shot, referenceAssets, {
      continuityVideoFirst: Boolean(referenceClipUrl),
      firstFrameAsset: useFirstFrameMode ? firstFrameAsset : undefined
    }),
    referenceClipUrl || referenceAudioUrl ? buildContinuityInstruction() : "",
    useFirstFrameMode ? buildFirstFrameInstruction(firstFrameAsset) : ""
  ]
    .filter(Boolean)
    .join("\n");

  const response = await fetch(process.env.SEEDANCE_API_URL, {
    method: "POST",
    headers: jsonHeaders(apiKey),
    body: JSON.stringify({
      model: resolveSeedanceModel(shot),
      prompt,
      duration: getShotDurationSec(shot),
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
    throw new Error(`Seedance API failed: ${response.status} ${await response.text()}`);
  }

  const data = (await response.json()) as { video_url?: string; url?: string; data?: { url?: string } };
  const videoUrl = data.video_url || data.url || data.data?.url;
  if (!videoUrl) throw new Error("Seedance API returned no video_url/url");
  return videoUrl;
}

async function generateShotVideoViaBytePlusArk(shot: Shot, assets: Asset[], apiKey: string) {
  const apiBase = (process.env.SEEDANCE_API_BASE || BYTEPLUS_SEEDANCE_BASE).replace(/\/$/, "");
  const payload = await buildBytePlusSeedancePayload(shot, assets);
  const createBody = await requestSeedanceJson(`${apiBase}/contents/generations/tasks`, apiKey, {
    method: "POST",
    body: JSON.stringify(payload)
  });
  const taskId = extractTaskId(createBody);
  const deadline = Date.now() + seedanceTimeoutMs();
  const pollMs = Number(process.env.SEEDANCE_POLL_MS || 5000);
  let lastBody: unknown = createBody;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    lastBody = await requestSeedanceJson(`${apiBase}/contents/generations/tasks/${taskId}`, apiKey);
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

async function buildBytePlusSeedancePayload(shot: Shot, assets: Asset[]) {
  const model = resolveSeedanceModel(shot);
  // First-frame mode is mutually exclusive with reference_image/video/audio per BytePlus ModelArk
  // Seedance docs. If the shot picks a first-frame asset, we drop all other reference media and
  // emit only `text` + `first_frame`.
  const firstFrameAsset = resolveFirstFrameAsset(shot, assets);
  const firstFrameUrl = firstFrameAsset ? getAssetMediaUrl(firstFrameAsset, "image") : undefined;
  const useFirstFrameMode = Boolean(firstFrameUrl && /^https?:\/\//.test(firstFrameUrl) && !firstFrameUrl.includes("placehold.co"));

  const continuityVideoUrl = useFirstFrameMode ? undefined : getSeedanceWebUrl(shot.referenceClipUrl);
  const continuityAudioUrl = useFirstFrameMode ? undefined : getSeedanceWebUrl(shot.referenceAudioUrl);
  const referenceImages = useFirstFrameMode
    ? []
    : assets
        .map((asset) => ({ asset, url: getAssetMediaUrl(asset, "image") }))
        .filter((item): item is { asset: Asset; url: string } => Boolean(item.url && /^https?:\/\//.test(item.url) && !item.url.includes("placehold.co")));
  const referenceVideos = useFirstFrameMode
    ? []
    : assets
        .map((asset) => ({ asset, url: getAssetMediaUrl(asset, "video") }))
        .filter((item): item is { asset: Asset; url: string } => Boolean(item.url && /^https?:\/\//.test(item.url) && !item.url.includes("placehold.co")));

  const promptAssetsForText = useFirstFrameMode && firstFrameAsset ? [firstFrameAsset] : [...referenceImages, ...referenceVideos].map((item) => item.asset);

  return {
    model,
    content: [
      {
        type: "text",
        text: [
          buildVideoPrompt(shot, promptAssetsForText, {
            continuityVideoFirst: Boolean(continuityVideoUrl),
            firstFrameAsset: useFirstFrameMode ? firstFrameAsset : undefined
          }),
          continuityVideoUrl || continuityAudioUrl ? buildContinuityInstruction() : "",
          useFirstFrameMode ? buildFirstFrameInstruction(firstFrameAsset) : ""
        ]
          .filter(Boolean)
          .join("\n")
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
    generate_audio: process.env.SEEDANCE_GENERATE_AUDIO !== "false",
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

function buildFirstFrameInstruction(asset?: Asset) {
  const label = asset?.name ? `@${asset.name.replace(/\s*\/\s*/g, "/").replace(/\s+/g, "")}` : "the attached first-frame image";
  return [
    `First-frame mode: the attached image is the literal first frame of the video.`,
    `Animate FROM that exact frame (composition, character, lighting, framing match ${label}).`,
    `Do not treat it as a generic style reference; do not cut away from it at t=0.`
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
  if (shot.seedanceVariant === "fast") return process.env.SEEDANCE_FAST_MODEL || BYTEPLUS_SEEDANCE_FAST_MODEL;
  return process.env.SEEDANCE_MODEL || BYTEPLUS_SEEDANCE_MODEL;
}

async function requestSeedanceJson(url: string, apiKey: string, init?: RequestInit) {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...jsonHeaders(apiKey),
      ...(init?.headers ?? {})
    }
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(`Seedance API failed: ${response.status} ${text.slice(0, 1000)}`);
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
  const rawPrompt = [asset.name, asset.description || asset.prompt].filter(Boolean).join("，").trim() || "未命名电影资产";
  if (asset.type === "character") {
    return [
      "请把用户原始角色描述扩写成文生图最终 prompt。",
      "硬性要求：横画幅16:9角色三视图设定资产；一张图内展示同一角色的正面、侧面、背面全身三视图；正面、侧面、背面必须是同一个角色，人物比例、五官、发型、服装、配饰、随身道具完全统一；全身从头到脚完整入画。",
      "风格要求：35mm胶片摄影质感，电影级角色设定图，柔和低对比度，细腻胶片颗粒，高级真实材质，服饰考据准确，光线干净均匀。",
      "负面要求：纯角色设定资产背景，干净高级，无文字，无字幕，无对白气泡，无现代元素，无裁切，无多余人物。",
      `用户原始描述：${rawPrompt}`
    ].join("\n");
  }
  return [
    "请把用户原始资产描述扩写成文生图最终 prompt。",
    "要求画面信息具体、材质清晰、可作为电影短片资产参考图；保持干净高级，无文字、无字幕、无水印。",
    `资产类型：${asset.type || "other"}`,
    `用户原始描述：${rawPrompt}`
  ].join("\n");
}

function buildLocalExpandedAssetPrompt(asset: Partial<Asset>) {
  const rawPrompt = [asset.name, asset.description || asset.prompt].filter(Boolean).join("，").trim() || "一个电影短片资产";
  if (asset.type === "character") {
    return [
      "横画幅16:9角色三视图设定资产，一张图内展示同一角色的正面、侧面、背面全身三视图。",
      `角色：${rawPrompt}。`,
      "三视图必须为同一角色，正面、侧面、背面的人物比例、五官、发型、服装、配饰、随身道具细节完全统一，全身完整入画，从头到脚清晰可见。",
      "角色站姿自然克制，正面视图面向镜头，侧面视图展示完整侧身轮廓，背面视图展示后背服装结构和发型轮廓。",
      "35mm胶片摄影质感，电影级角色设定图，柔和低对比度，细腻胶片颗粒，高级真实材质，服饰考据准确，光线干净均匀。",
      "纯角色设定资产背景，干净高级，无文字，无字幕，无对白气泡，无现代元素，无裁切，无多余人物。"
    ].join("");
  }
  return `${rawPrompt}，电影短片资产参考图，主体清晰，材质细节明确，构图干净高级，35mm胶片摄影质感，柔和低对比度，细腻胶片颗粒，无文字，无字幕，无水印。`;
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
  return { videoUrl: `/media/${outputName}`, remoteVideoUrl: videoUrl };
}

export type StitchProgressCallback = (phase: string) => void | Promise<void>;

export interface StitchOptions {
  /** Called with a short human-readable phase string as the job progresses. */
  onProgress?: StitchProgressCallback;
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
  const outputName = `final-${sessionId}-${signature}.mp4`;
  const outputPath = path.join(MEDIA_DIR, outputName);
  await report(`signature=${signature} target=${outputName} (${urls.length} shot inputs)`);
  if (await hasUsableFinalVideo(outputPath, shots)) {
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
