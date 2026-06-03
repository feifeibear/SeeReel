import { mkdir, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import type { ParsedShotEntry, SessionLanguage } from "../shared/types";
import { MEDIA_DIR, probeMediaDurationSec, runFfmpegCommand } from "./generators";
import { fetchWithRetry } from "./fetchWithRetry";
import { arkMissingKeyMessage, resolveArkCredential } from "./arkCredentials";

const BYTEPLUS_SEEDANCE_BASE = "https://ark.ap-southeast.bytepluses.com/api/v3";
const VISION_KEY_ENVS = ["VISION_REVIEW_API_KEY", "SEED_PROMPT_API_KEY", "BP_ARK_API_KEY", "ARK_API_KEY"];
const DEFAULT_AGENT_PLAN_VISION_MODEL = "doubao-seed-2.0-pro";

function useAgentPlanForVisionReview() {
  const value = process.env.REELYAI_VISION_REVIEW_USE_AGENT_PLAN?.trim();
  if (!value) return true;
  return /^(1|true|yes|on)$/i.test(value);
}

function useEnvAgentPlanForVisionReview() {
  return /^(1|true|yes|on)$/i.test(process.env.REELYAI_VISION_REVIEW_USE_AGENT_PLAN || "");
}

const credential = () =>
  resolveArkCredential({
    keyEnvNames: VISION_KEY_ENVS,
    baseEnvNames: ["VISION_REVIEW_API_BASE", "SEED_PROMPT_API_BASE", "SEEDANCE_API_BASE"],
    defaultBase: BYTEPLUS_SEEDANCE_BASE,
    preferAgentPlan: useAgentPlanForVisionReview(),
    allowRequestAgentPlan: useAgentPlanForVisionReview(),
    allowEnvAgentPlan: useEnvAgentPlanForVisionReview()
  });

const visionModel = (source: "standard" | "agent-plan" | "missing") => {
  if (source === "agent-plan") return process.env.VIDEO_ANALYZE_AGENT_PLAN_MODEL || process.env.VISION_REVIEW_AGENT_PLAN_MODEL || DEFAULT_AGENT_PLAN_VISION_MODEL;
  return process.env.VIDEO_ANALYZE_MODEL || process.env.VISION_REVIEW_MODEL || "seed-2-0-pro-260328";
};

const SYSTEM_PROMPT_ZH = `你是一名电影分镜解析师。给定从同一段参考视频按时序均匀采样的 N 帧（每帧标注了时间戳，单位秒），请把这段视频拆解成一个有序的镜头（shot）列表。镜头切分依据：构图明显变化、机位明显变化、动作节奏断点、场景切换。

每个镜头输出一行 JSON 对象，字段：
- "index": 1 起的整数序号
- "timeStart": 起始时间（秒，浮点数）
- "timeEnd": 结束时间（秒，浮点数）
- "shotType": 景别，从 "远景"/"全景"/"中景"/"中近景"/"特写"/"极特写" 中选一个
- "sceneContent": 1-2 句中文描述这一镜画面发生了什么（主体、动作、地点）
- "imagePrompt": 一段可直接喂给 Seedream 重新生成"这一镜的首帧"的中文图像提示词，包含主体、构图、光线、风格关键词
- "cameraPrompt": 这一镜的运镜中文描述（推/拉/摇/移/跟/旋转/手持/固定 + 速度）
- "styleNotes": 适用于全片的光影/色调/胶片质感关键词（多镜可重复）

最终只输出一个严格 JSON：{"shots": [...]}。**不要**输出 Markdown，**不要**解释，**不要**任何 JSON 之外的字符。如果只能解析出 1 个镜头也要按上述结构输出。`;

const SYSTEM_PROMPT_EN = `You are a film shot-list analyst. Given N frames sampled in temporal order from one reference video (each frame is labeled with a timestamp in seconds), break the video into an ordered list of shots. Cut on: composition changes, camera-position changes, action beat boundaries, or scene changes.

Each shot is one JSON object with fields:
- "index": 1-based integer
- "timeStart": start time in seconds (float)
- "timeEnd": end time in seconds (float)
- "shotType": one of "wide"/"establishing"/"medium"/"medium close-up"/"close-up"/"extreme close-up"
- "sceneContent": 1–2 sentences describing what's on screen (subject, action, place)
- "imagePrompt": an English prompt that can be fed to Seedream to regenerate this shot's first frame (subject, composition, lighting, style)
- "cameraPrompt": camera movement (push/pull/pan/track/follow/rotate/handheld/static + speed)
- "styleNotes": reusable lighting/palette/film-stock keywords that apply across shots

Output strict JSON only: {"shots": [...]}. NO Markdown, NO explanation, NO text outside JSON.`;

export interface AnalyzeVideoOpts {
  /** Local /media/... or filesystem path. */
  videoPath: string;
  sampleCount?: number;
  lang?: SessionLanguage;
}

export interface AnalyzeVideoResult {
  shots: ParsedShotEntry[];
  durationSec: number;
  sampledFrames: number;
  rawText: string;
  model: string;
}

/**
 * Extract N timestamps evenly from a video duration. We avoid the very first / last 0.3s to skip
 * potential black frames or fades, and ensure we always sample at least 2 distinct points so the
 * LLM has temporal motion to reason about.
 */
function pickSampleTimestamps(durationSec: number, count: number): number[] {
  if (durationSec <= 0) return [0];
  const safe = Math.max(0.05, durationSec - 0.4);
  const n = Math.max(2, Math.min(count, 16));
  return Array.from({ length: n }, (_, i) => 0.3 + (safe - 0.3) * (i / Math.max(1, n - 1)));
}

/**
 * Drive ffmpeg to extract one JPEG per timestamp into MEDIA_DIR. Returns the data URLs (base64)
 * along with the timestamps so we can include them in the vision LLM prompt as anchors.
 */
async function extractTimedFrames(absVideoPath: string, timestamps: number[]) {
  await mkdir(MEDIA_DIR, { recursive: true });
  const stem = `analyze-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const frames: { ts: number; dataUrl: string; tempPath: string }[] = [];
  for (let i = 0; i < timestamps.length; i += 1) {
    const ts = timestamps[i];
    const outPath = path.join(MEDIA_DIR, `${stem}-${i + 1}.jpg`);
    try {
      await runFfmpegCommand([
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-ss",
        ts.toFixed(2),
        "-i",
        absVideoPath,
        "-frames:v",
        "1",
        "-q:v",
        "4",
        "-vf",
        "scale='min(720,iw)':-2",
        outPath
      ]);
      const bytes = await readFile(outPath);
      frames.push({
        ts,
        dataUrl: `data:image/jpeg;base64,${bytes.toString("base64")}`,
        tempPath: outPath
      });
    } catch {
      /* skip the frame; keep going */
    }
  }
  return frames;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
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

function parseShotsResponse(rawText: string): ParsedShotEntry[] {
  const stripped = rawText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const parsed = safeJson(stripped);
  const shotsArr = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray((parsed as Record<string, unknown>).shots)
      ? ((parsed as Record<string, unknown>).shots as unknown[])
      : [];
  return shotsArr.map((entry, i) => {
    const r = isRecord(entry) ? entry : ({} as Record<string, unknown>);
    const num = (key: string, fallback = 0): number => {
      const v = r[key];
      if (typeof v === "number" && Number.isFinite(v)) return v;
      const parsed = typeof v === "string" ? Number(v) : NaN;
      return Number.isFinite(parsed) ? parsed : fallback;
    };
    const str = (key: string, fallback = ""): string => {
      const v = r[key];
      return typeof v === "string" ? v.trim() : fallback;
    };
    return {
      index: num("index", i + 1),
      timeStart: num("timeStart"),
      timeEnd: num("timeEnd"),
      shotType: str("shotType"),
      sceneContent: str("sceneContent"),
      imagePrompt: str("imagePrompt"),
      cameraPrompt: str("cameraPrompt"),
      styleNotes: str("styleNotes")
    };
  });
}

/**
 * Public entry: ingest a local video file → ffmpeg-sample frames → vision LLM → ParsedShotEntry[].
 * Throws on unrecoverable errors (no API key, ffmpeg failure, LLM HTTP error). Caller is responsible
 * for cleaning up temp frame files via the returned cleanup paths if it cares about disk usage.
 */
export async function analyzeReferenceVideo(opts: AnalyzeVideoOpts): Promise<AnalyzeVideoResult> {
  const ark = credential();
  if (!ark.apiKey) {
    throw new Error(`${arkMissingKeyMessage("video analyze", VISION_KEY_ENVS)}. Paste a browser Agent/Coding Plan key, or configure a standard VLM key. Set REELYAI_VISION_REVIEW_USE_AGENT_PLAN=0 only when video analysis must ignore browser Plan keys.`);
  }

  // Resolve local file path: either a /media/X mapping or a real fs path.
  const localPath = opts.videoPath.startsWith("/media/")
    ? path.resolve(MEDIA_DIR, decodeURIComponent(opts.videoPath).replace(/^\/media\/?/, ""))
    : opts.videoPath;

  const durationSec = await probeMediaDurationSec(localPath);
  const stamps = pickSampleTimestamps(durationSec, opts.sampleCount ?? 10);
  const frames = await extractTimedFrames(localPath, stamps);

  if (!frames.length) throw new Error("Failed to extract any sample frames");

  const lang: SessionLanguage = opts.lang === "en" ? "en" : "zh";
  const systemPrompt = lang === "zh" ? SYSTEM_PROMPT_ZH : SYSTEM_PROMPT_EN;
  const model = visionModel(ark.source);
  if (!model) {
    throw new Error("Video analyze through Agent/Coding Plan requires a Plan model such as doubao-seed-2.0-pro. Do not send seed-2-0-pro-260328 to /api/plan/v3.");
  }

  const userContent: Array<
    | { type: "input_text"; text: string }
    | { type: "input_image"; image_url: string }
  > = [
    {
      type: "input_text",
      text: lang === "zh"
        ? `视频总时长 ${durationSec.toFixed(2)} 秒，按时序采样了 ${frames.length} 帧。`
        : `Reference video total duration ${durationSec.toFixed(2)}s, sampled ${frames.length} frames in order.`
    }
  ];
  for (const frame of frames) {
    userContent.push({
      type: "input_text",
      text: lang === "zh" ? `时间戳 ${frame.ts.toFixed(2)} 秒：` : `Timestamp ${frame.ts.toFixed(2)}s:`
    });
    userContent.push({ type: "input_image", image_url: frame.dataUrl });
  }

  const response = await fetchWithRetry(`${ark.apiBase}/responses`, {
    method: "POST",
    timeoutMs: 120_000,
    tag: "ark:video-analyze",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${ark.apiKey}`
    },
    body: JSON.stringify({
      model,
      stream: false,
      input: [
        { role: "system", content: [{ type: "input_text", text: systemPrompt }] },
        { role: "user", content: userContent }
      ]
    })
  });
  const text = await response.text();

  // Best-effort cleanup of temp frame files. Don't block the caller on these.
  void Promise.all(frames.map((f) => unlink(f.tempPath).catch(() => undefined)));

  if (!response.ok) throw new Error(`Vision API ${response.status}: ${text.slice(0, 500)}`);
  const body = text ? safeJson(text) : undefined;
  const rawText = extractResponseText(body) || "";
  const shots = parseShotsResponse(rawText);
  if (!shots.length) throw new Error(`Vision response did not contain a usable shots[] array. Raw: ${rawText.slice(0, 300)}`);

  return { shots, durationSec, sampledFrames: frames.length, rawText, model };
}
