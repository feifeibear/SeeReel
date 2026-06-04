import { mkdir, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { MEDIA_DIR, runFfmpegCommand, probeMediaDurationSec } from "./generators";
import { fetchWithRetry } from "./fetchWithRetry";
import type { ImageReviewScope, ImageReviewVerdict, TokenUsageBreakdown, VideoReviewCriterionScore, VideoReviewFix, VideoReviewScope, VideoReviewVerdict } from "../shared/types";
import { tokenUsageFromRaw } from "./tokenUsage";
import { hasAgentPlanKey, resolveArkCredential, type ArkCredential } from "./arkCredentials";

const BYTEPLUS_SEEDANCE_BASE = "https://ark.ap-southeast.bytepluses.com/api/v3";
const VISION_KEY_ENVS = ["VISION_REVIEW_API_KEY", "SEED_PROMPT_API_KEY", "BP_ARK_API_KEY", "ARK_API_KEY"];
const DEFAULT_AGENT_PLAN_VISION_MODEL = "doubao-seed-2.0-pro";

function useAgentPlanForVisionReview() {
  const value = (process.env.SEEREEL_VISION_REVIEW_USE_AGENT_PLAN || process.env.REELYAI_VISION_REVIEW_USE_AGENT_PLAN)?.trim();
  if (!value) return true;
  return /^(1|true|yes|on)$/i.test(value);
}

function useEnvAgentPlanForVisionReview() {
  return /^(1|true|yes|on)$/i.test(process.env.SEEREEL_VISION_REVIEW_USE_AGENT_PLAN || process.env.REELYAI_VISION_REVIEW_USE_AGENT_PLAN || "");
}

const reviewCredential = () =>
  resolveArkCredential({
    keyEnvNames: VISION_KEY_ENVS,
    baseEnvNames: ["VISION_REVIEW_API_BASE", "SEED_PROMPT_API_BASE", "SEEDANCE_API_BASE"],
    defaultBase: BYTEPLUS_SEEDANCE_BASE,
    // Browser-provided Agent/Coding Plan keys should review through /api/plan/v3 with
    // Plan model names such as doubao-seed-2.0-pro, not standard model ids like seed-2-0-pro-260328.
    preferAgentPlan: useAgentPlanForVisionReview(),
    allowRequestAgentPlan: useAgentPlanForVisionReview(),
    allowEnvAgentPlan: useEnvAgentPlanForVisionReview()
  });

export function resolveReviewModel(source: ArkCredential["source"]) {
  if (source === "agent-plan") return process.env.VISION_REVIEW_AGENT_PLAN_MODEL || DEFAULT_AGENT_PLAN_VISION_MODEL;
  return process.env.VISION_REVIEW_MODEL || "seed-2-0-pro-260328";
}

function missingAgentPlanReviewModelMessage() {
  return "[skip] no Agent/Coding Plan-compatible vision review model configured";
}

const reviewDefaultEnabled = () => (process.env.VISION_REVIEW_DEFAULT || "on").toLowerCase() !== "off";

export const VISION_REVIEW_MAX_ATTEMPTS_HARD_CAP = 5;

export interface ReviewVerdict {
  ok: boolean;
  reasons: string[];
  rawText: string;
  model: string;
}

export interface ImageReviewInput {
  prompt: string;
  productUrl: string;
  referenceUrls?: string[];
  kind: "asset" | "sketch";
}

export interface VideoReviewInput {
  prompt: string;
  videoUrl: string;
  referenceUrls?: string[];
}

export interface DetailedVideoReviewInput extends VideoReviewInput {
  scope: VideoReviewScope;
  frameCount?: number;
  context?: string;
  videoSignature?: string;
}

const SYSTEM_PROMPT_IMAGE = [
  "你是 AI 生成图片质检员。给定 prompt、（可选）参考图、待审图片，严格评估图片是否可用。",
  "评估维度：视觉质量、人物/主体结构、脸/手/肢体合理性、文字/水印清洁度、prompt 对齐、参考图身份/风格一致性、短剧资产可复用性。",
  "只输出严格 JSON：{\"ok\": boolean, \"score\": number, \"summary\": string, \"criteria\": [{\"key\": string, \"label\": string, \"score\": number, \"weight\": number, \"reason\": string}], \"fatalIssues\": string[], \"reasons\": string[], \"fixes\": [{\"action\": string}]}",
  "score 为 0-100；criteria.score 为 1-4。ok=true 必须没有 fatalIssues 且 score>=75。不要放过崩脸、畸形手脚、乱码文字、水印、主体身份明显偏离参考图、与 prompt 主要诉求不一致等问题。",
  "不要输出 Markdown，不要输出解释，不要输出任何 JSON 之外的字符。"
].join("\n");

const SYSTEM_PROMPT_VIDEO = [
  "你是 AI 生成视频质检员。给定 prompt、可选参考图、按时间顺序采样的视频帧，严格评估视频是否可用。",
  "评估维度来自 VBench / EvalCrafter / T2V-CompBench / VideoScore / VideoPhy 和短视频完播标准：视觉质量、时间一致性、人物身份一致性、场景连续性、运动质量、畸形/伪影、文字水印清洁度、prompt 对齐、叙事连贯、音频（如可判断）、开头钩子/情绪回报。",
  "只输出严格 JSON：{\"ok\": boolean, \"score\": number, \"summary\": string, \"criteria\": [{\"key\": string, \"label\": string, \"score\": number, \"weight\": number, \"reason\": string, \"evidenceFrames\": number[]}], \"fatalIssues\": string[], \"reasons\": string[], \"fixes\": [{\"shot\": number, \"frame\": number, \"action\": string}], \"hookRetention\": string, \"audio\": string, \"frameEvidence\": string[]}",
  "score 为 0-100；criteria.score 为 1-4。ok=true 必须没有 fatalIssues，且单镜头 score>=75、完整片 score>=80。不要因为故事大体能看懂就放过换脸、场景跳变、乱码文字、畸形手脚、道具穿帮或运动灾难。",
  "不要输出 Markdown，不要输出解释，不要输出任何 JSON 之外的字符。"
].join("\n");

export function shouldEnableReview(requested: boolean | undefined): boolean {
  if (requested === false) return false;
  if (requested === true) return true;
  return reviewDefaultEnabled();
}

export function clampMaxAttempts(value: number | undefined): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n <= 0) return VISION_REVIEW_MAX_ATTEMPTS_HARD_CAP;
  return Math.max(1, Math.min(VISION_REVIEW_MAX_ATTEMPTS_HARD_CAP, n));
}

export async function reviewImage(input: ImageReviewInput): Promise<ReviewVerdict> {
  const verdict = await reviewImageDetailed(input, { tolerant: true });
  return {
    ok: verdict.ok,
    reasons: verdict.ok ? [] : (verdict.reasons.length ? verdict.reasons : verdict.fatalIssues),
    rawText: verdict.rawText || "",
    model: verdict.model
  };
}

export async function reviewImageDetailed(
  input: ImageReviewInput,
  opts: { tolerant?: boolean } = {}
): Promise<ImageReviewVerdict> {
  const credential = reviewCredential();
  const { apiKey, apiBase } = credential;
  const model = resolveReviewModel(credential.source);
  const reviewedAt = new Date().toISOString();
  if (!apiKey) {
    if (opts.tolerant || hasAgentPlanKey() || useAgentPlanForVisionReview()) return skippedImageVerdict(input.kind, "[skip] no standard VLM API key configured", "skipped", reviewedAt);
    throw new Error("No VLM API key configured");
  }
  if (!model) {
    const message = missingAgentPlanReviewModelMessage();
    if (opts.tolerant || credential.source === "agent-plan") return skippedImageVerdict(input.kind, message, "skipped", reviewedAt);
    throw new Error(`${message}; set VISION_REVIEW_AGENT_PLAN_MODEL or configure a standard VISION_REVIEW_API_KEY`);
  }
  try {
    const productImage = await imageInputContent(input.productUrl);
    if (!productImage) {
      if (opts.tolerant) return skippedImageVerdict(input.kind, "[skip] product image unreadable", "skipped", reviewedAt);
      throw new Error("Product image unreadable");
    }
    const refContents = await collectReferenceImageContents(input.referenceUrls);

    const userContent = [
      { type: "input_text" as const, text: `任务类型：${input.kind === "asset" ? "资产参考图" : "分镜草图"}` },
      { type: "input_text" as const, text: `Prompt：${input.prompt || "(未给出)"}` },
      ...(refContents.length
        ? ([{ type: "input_text" as const, text: `以下是 ${refContents.length} 张参考图：` }, ...refContents] as Array<
            | { type: "input_text"; text: string }
            | { type: "input_image"; image_url: string }
          >)
        : []),
      { type: "input_text" as const, text: "以下是待审图片：" },
      productImage
    ];

    const vision = await callArkVisionText({
      apiBase,
      apiKey,
      model,
      systemPrompt: SYSTEM_PROMPT_IMAGE,
      userContent
    });
    const verdict = parseDetailedImageVerdict(vision.rawText, input.kind, model, reviewedAt);
    verdict.tokenUsage = vision.tokenUsage;
    return verdict;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (opts.tolerant) return skippedImageVerdict(input.kind, `[skip] review failed: ${message.slice(0, 300)}`, model, reviewedAt);
    throw error;
  }
}

export async function reviewVideo(input: VideoReviewInput): Promise<ReviewVerdict> {
  const verdict = await reviewVideoDetailed({ ...input, scope: "shot", frameCount: 8 });
  return {
    ok: verdict.ok,
    reasons: verdict.ok ? [] : (verdict.reasons.length ? verdict.reasons : verdict.fatalIssues),
    rawText: verdict.rawText || "",
    model: verdict.model
  };
}

export async function reviewVideoDetailed(input: DetailedVideoReviewInput): Promise<VideoReviewVerdict> {
  const credential = reviewCredential();
  const { apiKey, apiBase } = credential;
  const model = resolveReviewModel(credential.source);
  const reviewedAt = new Date().toISOString();
  if (!apiKey) {
    if (hasAgentPlanKey() || useAgentPlanForVisionReview()) {
      return skippedVideoVerdict(input, "[skip] no standard VLM API key configured", "skipped", reviewedAt);
    }
    throw new Error("No VLM API key configured");
  }
  if (!model) {
    return skippedVideoVerdict(input, missingAgentPlanReviewModelMessage(), "skipped", reviewedAt);
  }

  let extracted: { dataUrls: string[]; tempPaths: string[]; timestamps: number[]; durationSec: number } | undefined;
  try {
    extracted = await extractVideoFrames(input.videoUrl, input.frameCount || (input.scope === "session_final" ? 10 : 8));
    if (!extracted.dataUrls.length) throw new Error("No frames extracted");
    const frames = extracted.dataUrls.map((image_url) => ({ type: "input_image" as const, image_url }));
    const refContents = await collectReferenceImageContents(input.referenceUrls);
    const userContent = [
      { type: "input_text" as const, text: `审核范围：${input.scope === "session_final" ? "完整成片" : "单个镜头"}` },
      { type: "input_text" as const, text: `原始创作要求 / Prompt：\n${input.prompt || "(未给出)"}` },
      ...(input.context ? [{ type: "input_text" as const, text: `上下文：\n${input.context}` }] : []),
      ...(refContents.length
        ? ([{ type: "input_text" as const, text: `以下是 ${refContents.length} 张角色/场景/道具参考图：` }, ...refContents] as Array<
            | { type: "input_text"; text: string }
            | { type: "input_image"; image_url: string }
          >)
        : []),
      { type: "input_text" as const, text: `以下是视频按时间顺序采样的 ${frames.length} 帧；帧序号从 1 开始，对应时间秒：${extracted.timestamps.map((t) => t.toFixed(1)).join(", ")}` },
      ...frames
    ];
    const vision = await callArkVisionText({ apiBase, apiKey, model, systemPrompt: SYSTEM_PROMPT_VIDEO, userContent });
    const parsed = parseDetailedVideoVerdict(vision.rawText, input.scope, model, reviewedAt, extracted, input.videoSignature);
    parsed.tokenUsage = vision.tokenUsage;
    return parsed;
  } finally {
    await Promise.all((extracted?.tempPaths || []).map((p) => unlink(p).catch(() => undefined)));
  }
}

interface CallVisionParams {
  apiBase: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  userContent: Array<
    | { type: "input_text"; text: string }
    | { type: "input_image"; image_url: string }
  >;
}

async function callArkVisionText({ apiBase, apiKey, model, systemPrompt, userContent }: CallVisionParams): Promise<{ rawText: string; tokenUsage?: TokenUsageBreakdown }> {
  const first = await postArkVisionResponse({ apiBase, apiKey, model, systemPrompt, userContent, imageContentShape: "input_image", tag: "ark:video-audit" });
  let response = first.response;
  let text = first.text;
  if (!response.ok && shouldRetryWithImageUrlContent(text)) {
    const retry = await postArkVisionResponse({ apiBase, apiKey, model, systemPrompt, userContent, imageContentShape: "image_url", tag: "ark:video-audit:image_url" });
    response = retry.response;
    text = retry.text;
  }
  if (!response.ok) throw new Error(`vision API ${response.status}: ${text.slice(0, 500)}`);
  const body = text ? safeJson(text) : undefined;
  return { rawText: extractResponseText(body) || "", tokenUsage: tokenUsageFromRaw(body) };
}

type ArkImageContentShape = "input_image" | "image_url";

async function postArkVisionResponse({
  apiBase,
  apiKey,
  model,
  systemPrompt,
  userContent,
  imageContentShape,
  tag
}: CallVisionParams & { imageContentShape: ArkImageContentShape; tag: string }): Promise<{ response: Response; text: string }> {
  const response = await fetchWithRetry(`${apiBase}/responses`, {
    method: "POST",
    timeoutMs: tag.includes("video-audit") ? 120_000 : 90_000,
    tag,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      stream: false,
      input: [
        { role: "system", content: [{ type: "input_text", text: systemPrompt }] },
        { role: "user", content: serializeVisionContent(userContent, imageContentShape) }
      ]
    })
  });
  return { response, text: await response.text() };
}

function serializeVisionContent(userContent: CallVisionParams["userContent"], imageContentShape: ArkImageContentShape) {
  return userContent.map((item) => {
    if (item.type !== "input_image" || imageContentShape === "input_image") return item;
    return { type: "image_url", image_url: { url: item.image_url } };
  });
}

function shouldRetryWithImageUrlContent(text: string) {
  return /content\s*type|unsupported|invalid/i.test(text) && /image|input_image|image_url/i.test(text);
}

function parseDetailedImageVerdict(
  rawText: string,
  scope: ImageReviewScope,
  model: string,
  reviewedAt: string
): ImageReviewVerdict {
  const parsed = parseFirstJsonObject(rawText);
  const record = isRecord(parsed) ? parsed : {};
  const criteriaRaw = Array.isArray(record.criteria) ? record.criteria : [];
  const criteria: VideoReviewCriterionScore[] = criteriaRaw
    .map((item): VideoReviewCriterionScore | undefined => {
      if (!isRecord(item)) return undefined;
      return {
        key: stringOr(item.key, "unknown"),
        label: stringOr(item.label, stringOr(item.key, "未命名指标")),
        score: clampNumber(item.score, 1, 4, 1),
        weight: clampNumber(item.weight, 0.1, 5, 1),
        reason: stringOr(item.reason, ""),
        evidenceFrames: undefined
      };
    })
    .filter((item): item is VideoReviewCriterionScore => Boolean(item));
  const fatalIssues = stringArray(record.fatalIssues);
  const reasons = stringArray(record.reasons);
  const fixes: VideoReviewFix[] = Array.isArray(record.fixes)
    ? record.fixes.map((item): VideoReviewFix | undefined => {
        if (!isRecord(item)) return undefined;
        const action = stringOr(item.action, "");
        return action ? { action } : undefined;
      }).filter((item): item is VideoReviewFix => Boolean(item))
    : [];
  const score = clampNumber(record.score, 0, 100, estimateScore(criteria, fatalIssues));
  const ok = typeof record.ok === "boolean" ? record.ok && score >= 75 && fatalIssues.length === 0 : score >= 75 && fatalIssues.length === 0;
  return {
    scope,
    ok,
    score,
    summary: stringOr(record.summary, ok ? "VLM 审图通过" : "VLM 审图未通过"),
    criteria,
    fatalIssues,
    reasons: reasons.length ? reasons : (ok ? [] : fatalIssues),
    fixes,
    model,
    rawText: rawText.slice(0, 8000),
    reviewedAt
  };
}

function isSkippedImageVerdict(verdict: ImageReviewVerdict) {
  return verdict.model === "skipped" || verdict.summary.startsWith("[skip]");
}

function skippedImageVerdict(scope: ImageReviewScope, reason: string, model: string, reviewedAt: string): ImageReviewVerdict {
  return {
    scope,
    ok: true,
    score: 100,
    summary: reason,
    criteria: [],
    fatalIssues: [],
    reasons: [],
    fixes: [],
    model,
    rawText: "",
    reviewedAt
  };
}

function skippedVideoVerdict(input: DetailedVideoReviewInput, reason: string, model: string, reviewedAt: string): VideoReviewVerdict {
  return {
    scope: input.scope,
    ok: true,
    score: 100,
    summary: reason,
    criteria: [],
    fatalIssues: [],
    reasons: [],
    fixes: [],
    hookRetention: "",
    audio: "not_evaluated",
    frameEvidence: [],
    model,
    rawText: "",
    reviewedAt,
    frameCount: 0,
    videoSignature: input.videoSignature
  };
}

function parseDetailedVideoVerdict(
  rawText: string,
  scope: VideoReviewScope,
  model: string,
  reviewedAt: string,
  extracted: { dataUrls: string[]; timestamps: number[]; durationSec: number },
  videoSignature?: string
): VideoReviewVerdict {
  const parsed = parseFirstJsonObject(rawText);
  const record = isRecord(parsed) ? parsed : {};
  const criteriaRaw = Array.isArray(record.criteria) ? record.criteria : [];
  const criteria: VideoReviewCriterionScore[] = criteriaRaw
    .map((item): VideoReviewCriterionScore | undefined => {
      if (!isRecord(item)) return undefined;
      return {
        key: stringOr(item.key, "unknown"),
        label: stringOr(item.label, stringOr(item.key, "未命名指标")),
        score: clampNumber(item.score, 1, 4, 1),
        weight: clampNumber(item.weight, 0.1, 5, 1),
        reason: stringOr(item.reason, ""),
        evidenceFrames: Array.isArray(item.evidenceFrames)
          ? item.evidenceFrames.map((n) => Number(n)).filter((n) => Number.isFinite(n))
          : undefined
      };
    })
    .filter((item): item is VideoReviewCriterionScore => Boolean(item));
  const fatalIssues = stringArray(record.fatalIssues);
  const reasons = stringArray(record.reasons);
  const fixes: VideoReviewFix[] = Array.isArray(record.fixes)
    ? record.fixes.map((item): VideoReviewFix | undefined => {
        if (!isRecord(item)) return undefined;
        const action = stringOr(item.action, "");
        if (!action) return undefined;
        const fix: VideoReviewFix = { action };
        const shot = numberOrUndefined(item.shot);
        const frame = numberOrUndefined(item.frame);
        if (shot !== undefined) fix.shot = shot;
        if (frame !== undefined) fix.frame = frame;
        return fix;
      }).filter((item): item is VideoReviewFix => Boolean(item))
    : [];
  const score = clampNumber(record.score, 0, 100, estimateScore(criteria, fatalIssues));
  const threshold = scope === "session_final" ? 80 : 75;
  const ok = typeof record.ok === "boolean" ? record.ok && score >= threshold && fatalIssues.length === 0 : score >= threshold && fatalIssues.length === 0;
  return {
    scope,
    ok,
    score,
    summary: stringOr(record.summary, ok ? "VLM 审核通过" : "VLM 审核未通过"),
    criteria,
    fatalIssues,
    reasons: reasons.length ? reasons : (ok ? [] : fatalIssues),
    fixes,
    hookRetention: stringOr(record.hookRetention, ""),
    audio: stringOr(record.audio, "not_evaluated"),
    frameEvidence: stringArray(record.frameEvidence),
    model,
    rawText: rawText.slice(0, 8000),
    reviewedAt,
    frameCount: extracted.dataUrls.length,
    durationSec: extracted.durationSec,
    videoSignature
  };
}

function parseFirstJsonObject(text: string): unknown {
  const stripped = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const direct = safeJson(stripped);
  if (direct) return direct;
  for (let start = 0; start < stripped.length; start += 1) {
    if (stripped[start] !== "{") continue;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = start; i < stripped.length; i += 1) {
      const ch = stripped[i];
      if (escape) { escape = false; continue; }
      if (ch === "\\") { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === "{") depth += 1;
      if (ch === "}") depth -= 1;
      if (depth === 0) {
        const parsed = safeJson(stripped.slice(start, i + 1));
        if (parsed) return parsed;
        break;
      }
    }
  }
  return undefined;
}

function stringOr(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.map((item) => String(item || "").trim()).filter(Boolean) : [];
}

function numberOrUndefined(value: unknown) {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function estimateScore(criteria: VideoReviewCriterionScore[], fatalIssues: string[]) {
  if (fatalIssues.length) return 50;
  if (!criteria.length) return 0;
  const totalWeight = criteria.reduce((sum, item) => sum + (item.weight || 1), 0) || 1;
  const weighted = criteria.reduce((sum, item) => sum + item.score * (item.weight || 1), 0) / totalWeight;
  return Math.round((weighted / 4) * 100);
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

async function imageInputContent(
  url: string
): Promise<{ type: "input_image"; image_url: string } | undefined> {
  if (!url) return undefined;
  if (url.startsWith("data:image/")) return { type: "input_image", image_url: url };
  if (url.startsWith("/media/")) {
    const dataUrl = await tryReadLocalMediaAsDataUrl(url);
    return dataUrl ? { type: "input_image", image_url: dataUrl } : undefined;
  }
  if (/^https?:\/\//.test(url)) return { type: "input_image", image_url: url };
  return undefined;
}

async function collectReferenceImageContents(
  refs?: string[]
): Promise<Array<{ type: "input_image"; image_url: string }>> {
  if (!refs?.length) return [];
  const trimmed = refs.slice(0, 3);
  const results: Array<{ type: "input_image"; image_url: string }> = [];
  for (const ref of trimmed) {
    const content = await imageInputContent(ref);
    if (content) results.push(content);
  }
  return results;
}

async function tryReadLocalMediaAsDataUrl(url: string): Promise<string | undefined> {
  const mediaPath = resolveLocalMediaPath(url);
  if (!mediaPath) return undefined;
  try {
    const bytes = await readFile(mediaPath);
    const ext = path.extname(mediaPath).toLowerCase();
    const mime =
      ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : ext === ".gif" ? "image/gif" : "image/jpeg";
    return `data:${mime};base64,${bytes.toString("base64")}`;
  } catch {
    return undefined;
  }
}

function resolveLocalMediaPath(url: string): string | undefined {
  if (!url.startsWith("/media/")) return undefined;
  const mediaFile = decodeURIComponent(url).replace(/^\/media\/?/, "");
  const candidate = path.resolve(MEDIA_DIR, mediaFile);
  return candidate.startsWith(`${MEDIA_DIR}${path.sep}`) ? candidate : undefined;
}

async function extractVideoFrames(
  videoUrl: string,
  count: number
): Promise<{ dataUrls: string[]; tempPaths: string[]; timestamps: number[]; durationSec: number }> {
  await mkdir(MEDIA_DIR, { recursive: true });
  const inputArg = await resolveFfmpegInputArg(videoUrl);
  if (!inputArg) throw new Error(`Unsupported video URL for review: ${videoUrl.slice(0, 120)}`);

  let durationSec = 0;
  try {
    durationSec = await probeMediaDurationSec(inputArg);
  } catch {
    durationSec = 0;
  }
  const safeDuration = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 6;
  const stamps = pickFrameTimestamps(safeDuration, count);

  const tempPaths: string[] = [];
  const dataUrls: string[] = [];
  const stem = `review-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  for (let i = 0; i < stamps.length; i += 1) {
    const outName = `${stem}-frame-${i + 1}.jpg`;
    const outPath = path.join(MEDIA_DIR, outName);
    try {
      await runFfmpegCommand([
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-ss",
        stamps[i].toFixed(2),
        "-i",
        inputArg,
        "-frames:v",
        "1",
        "-q:v",
        "3",
        "-vf",
        "scale='min(1024,iw)':-2",
        outPath
      ]);
      tempPaths.push(outPath);
      const bytes = await readFile(outPath);
      dataUrls.push(`data:image/jpeg;base64,${bytes.toString("base64")}`);
    } catch {
      // best-effort: skip the frame, keep going
    }
  }

  return { dataUrls, tempPaths, timestamps: stamps, durationSec: safeDuration };
}

function pickFrameTimestamps(durationSec: number, count: number): number[] {
  if (count <= 0) return [];
  const safeCount = Math.max(1, Math.min(16, Math.floor(count)));
  if (safeCount === 1) return [Math.max(0, Math.min(durationSec - 0.05, durationSec * 0.5))];
  const start = 0.05;
  const end = 0.95;
  return Array.from({ length: safeCount }, (_, index) => {
    const ratio = start + ((end - start) * index) / Math.max(1, safeCount - 1);
    return Math.max(0, Math.min(durationSec - 0.05, durationSec * ratio));
  });
}

async function resolveFfmpegInputArg(url: string): Promise<string | undefined> {
  if (!url) return undefined;
  if (url.startsWith("/media/")) return resolveLocalMediaPath(url);
  if (/^https?:\/\//.test(url)) return url;
  return undefined;
}

// ============================================================================
// Wrappers used by the three generation routes.
// ============================================================================

export interface WithImageReviewOpts<T> {
  enabled: boolean;
  maxAttempts: number;
  prompt: string;
  referenceUrls: string[];
  kind: "asset" | "sketch";
  /**
   * Produce one image. The wrapper passes the attempt number (1-based) and, on retries, a
   * `rewrittenPrompt` that the rewriter has folded the prior failure reasons into. Callers should
   * use `rewrittenPrompt` (when non-empty) instead of the original prompt for that attempt's
   * generation. On attempt 1 (and whenever the rewriter declined) `rewrittenPrompt` is undefined.
   */
  generate: (attempt: number, rewrittenPrompt: string | undefined) => Promise<{ url: string; payload: T }>;
  /**
   * Disable the rewriter even when `enabled: true`. Useful for tests or for callers that want to
   * keep the original prompt verbatim across retries (the legacy behavior).
   */
  rewritePrompt?: boolean;
  /** Output language for the rewriter ("zh" / "en"). Default `"zh"`. */
  lang?: "zh" | "en";
}

export interface ReviewWrapResult<T> {
  url: string;
  payload: T;
  reviewNote?: string;
  reviewAttempts: number;
  reviewModel?: string;
  imageReview?: ImageReviewVerdict;
  /** When the rewriter rewrote the prompt for at least one retry, this is the last rewritten prompt. */
  rewrittenPrompt?: string;
}

export async function withImageReview<T>(opts: WithImageReviewOpts<T>): Promise<ReviewWrapResult<T>> {
  const maxAttempts = clampMaxAttempts(opts.maxAttempts);
  if (!opts.enabled) {
    const result = await opts.generate(1, undefined);
    return { url: result.url, payload: result.payload, reviewAttempts: 0 };
  }

  const rewriteEnabled = opts.rewritePrompt !== false;
  const lang: "zh" | "en" = opts.lang === "en" ? "en" : "zh";
  let last: { url: string; payload: T } | undefined;
  let lastRewrittenPrompt: string | undefined;
  let nextAttemptPrompt: string | undefined; // rewritten prompt to feed to the NEXT generate() call
  const failures: Array<{ attempt: number; reasons: string[] }> = [];
  let model: string | undefined;
  let lastImageReview: ImageReviewVerdict | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    last = await opts.generate(attempt, nextAttemptPrompt);
    const verdict = await reviewImageDetailed({
      prompt: nextAttemptPrompt || opts.prompt,
      productUrl: last.url,
      referenceUrls: opts.referenceUrls,
      kind: opts.kind
    }, { tolerant: true });
    lastImageReview = isSkippedImageVerdict(verdict) ? undefined : verdict;
    model = verdict.model;
    const reasons = verdict.reasons.length ? verdict.reasons : verdict.fatalIssues;
    if (verdict.ok) {
      return {
        url: last.url,
        payload: last.payload,
        reviewAttempts: attempt - 1,
        reviewModel: isSkippedImageVerdict(verdict) ? undefined : model,
        reviewNote: attempt > 1 ? formatReviewNote(failures, true) : undefined,
        imageReview: isSkippedImageVerdict(verdict) ? undefined : verdict,
        rewrittenPrompt: lastRewrittenPrompt
      };
    }
    failures.push({ attempt, reasons: reasons.length ? reasons : ["(no reasons returned)"] });
    console.warn(
      `[vision-review] ${opts.kind} attempt ${attempt}/${maxAttempts} failed: ${reasons.join("; ")}`
    );
    // Build the rewritten prompt for the NEXT attempt (not the one that just failed).
    if (rewriteEnabled && attempt < maxAttempts) {
      const rewrite = await rewritePromptWithReviewFeedback({
        originalPrompt: nextAttemptPrompt || opts.prompt,
        reviewReasons: reasons,
        referenceUrls: opts.referenceUrls,
        failedProductUrl: last.url,
        lang
      });
      if (rewrite.rewritten) {
        nextAttemptPrompt = rewrite.prompt;
        lastRewrittenPrompt = rewrite.prompt;
        console.warn(
          `[vision-review] ${opts.kind} rewriter produced a new prompt (model=${rewrite.model}); retry attempt ${attempt + 1} will use it`
        );
      } else if (rewrite.note) {
        console.warn(`[vision-review] ${opts.kind} rewriter skipped: ${rewrite.note}`);
      }
    }
  }
  return {
    url: last!.url,
    payload: last!.payload,
    reviewAttempts: maxAttempts,
    reviewModel: model,
    reviewNote: formatReviewNote(failures, false),
    imageReview: lastImageReview,
    rewrittenPrompt: lastRewrittenPrompt
  };
}

export function formatReviewNote(
  failures: Array<{ attempt: number; reasons: string[] }>,
  passedFinally: boolean
): string {
  const lines = failures.map((f) => `attempt ${f.attempt}: ${f.reasons.join("; ")}`);
  const head = passedFinally
    ? `自审通过（前 ${failures.length} 次重试）`
    : `自审 ${failures.length} 次重试后仍未通过，已保留最后一次产物`;
  return [head, ...lines].join("\n");
}

// ============================================================================
// Prompt rewriter — turn VLM verdict reasons into a fresh prompt for resubmission.
// ============================================================================

const SYSTEM_PROMPT_REWRITE_ZH =
  "你是 AI 图像/视频 prompt 修复师。给定 (a) 上一版被打回的原始 prompt 和 (b) 一组来自视觉模型质检员的具体失败原因，" +
  "请把 prompt 改写成能避免这些失败的新版本，同时保留原 prompt 中没有被指出有问题的部分（人物设定、场景、镜头、光线、风格、负面约束等）。" +
  "重点在于：把每条失败原因变成 prompt 里更明确、更可执行的指令；删除/替换与失败原因冲突的描述；不要堆叠重复约束；保持中文。" +
  "只输出改写后的 prompt 本身，不要解释，不要 Markdown，不要任何前后缀，不要写 \"以下是改写后的 prompt:\" 之类的话。" +
  "保持与原始 prompt 相近的长度与结构。";

const SYSTEM_PROMPT_REWRITE_EN =
  "You are an AI image/video prompt fixer. Given (a) the original prompt that produced a flawed output and (b) a list of specific failure " +
  "reasons from a vision-language reviewer, rewrite the prompt so that the next generation addresses those failures while preserving " +
  "everything that wasn't called out as wrong (character spec, scene, camera, lighting, style, negative constraints). Turn each failure " +
  "reason into a more explicit, actionable instruction in the prompt; remove/replace any description that conflicts with the reasons; " +
  "do not pile up duplicate constraints; keep English. Output the rewritten prompt only, no explanation, no Markdown, no preamble. " +
  "Keep the rewritten length and structure close to the original.";

export interface RewritePromptInput {
  originalPrompt: string;
  reviewReasons: string[];
  /** Optional reference image URLs to attach so the rewriter sees what should have been preserved. */
  referenceUrls?: string[];
  /** Optional product image URL (the rejected output) to attach so the rewriter sees what went wrong visually. */
  failedProductUrl?: string;
  lang?: "zh" | "en";
  /** Force a specific Ark text-model id; defaults to PROMPT_REWRITE_MODEL → SEED_PROMPT_MODEL on standard Ark, or PROMPT_REWRITE_AGENT_PLAN_MODEL / SEED_PROMPT_AGENT_PLAN_MODEL on Agent Plan. */
  model?: string;
}

export interface RewritePromptResult {
  /** The rewritten prompt, or the original if rewriting was skipped/failed. */
  prompt: string;
  /** Did the rewriter actually run and produce a different prompt? */
  rewritten: boolean;
  /** Model id used (for audit). Empty when skipped. */
  model: string;
  /** Short note for audit when rewriter was skipped or failed (no key, API error, empty output). */
  note?: string;
  tokenUsage?: TokenUsageBreakdown;
}

function resolvePromptRewriteModel(explicitModel: string | undefined, source: "standard" | "agent-plan" | "missing") {
  if (explicitModel) return explicitModel;
  if (source === "agent-plan") {
    return process.env.PROMPT_REWRITE_AGENT_PLAN_MODEL || process.env.SEED_PROMPT_AGENT_PLAN_MODEL || process.env.AGENT_PLAN_TEXT_MODEL || "";
  }
  return process.env.PROMPT_REWRITE_MODEL || process.env.SEED_PROMPT_MODEL || "seed-2-0-pro-260328";
}

/**
 * Take an original prompt + the VLM's failure reasons and rewrite the prompt so the next
 * generation has a real chance of passing review. Falls through to the original prompt on any
 * failure (no API key, transport error, empty output, malformed response) — never throws.
 *
 * Used by:
 *   - withImageReview (asset / sketch / storyboard panel regen)
 *   - the video review-driven retry branch in submitShotGeneration
 */
export async function rewritePromptWithReviewFeedback(input: RewritePromptInput): Promise<RewritePromptResult> {
  const credential = reviewCredential();
  const { apiKey } = credential;
  const model = resolvePromptRewriteModel(input.model, credential.source);
  const lang: "zh" | "en" = input.lang === "en" ? "en" : "zh";
  const original = (input.originalPrompt || "").trim();
  const reasons = (input.reviewReasons || []).map((r) => (r || "").trim()).filter(Boolean);

  if (!apiKey) {
    return { prompt: original, rewritten: false, model: "", note: "[skip] no API key" };
  }
  if (!model) {
    return { prompt: original, rewritten: false, model: "", note: "[skip] no Agent Plan-compatible rewrite model configured" };
  }
  if (!original) {
    return { prompt: original, rewritten: false, model: "", note: "[skip] empty original prompt" };
  }
  if (!reasons.length) {
    return { prompt: original, rewritten: false, model: "", note: "[skip] no review reasons" };
  }

  const systemPrompt = lang === "en" ? SYSTEM_PROMPT_REWRITE_EN : SYSTEM_PROMPT_REWRITE_ZH;
  const userText = lang === "en"
    ? [
        "Original prompt:",
        original,
        "",
        "Reviewer reasons (each is a concrete failure to fix):",
        ...reasons.map((r, i) => `${i + 1}. ${r}`),
        "",
        "Rewrite the prompt now. Output the rewritten prompt only — no explanation, no preamble, no markdown."
      ].join("\n")
    : [
        "原始 prompt：",
        original,
        "",
        "质检反馈（每条都是要修的具体问题）：",
        ...reasons.map((r, i) => `${i + 1}. ${r}`),
        "",
        "现在改写 prompt。只输出改写后的 prompt——不要解释，不要前后缀，不要 Markdown。"
      ].join("\n");

  // Optionally attach the failed product image + reference images so the rewriter can see what
  // went wrong visually rather than relying purely on textual reasons. Cheap when models support
  // it; falls through silently when attachments fail.
  const attachments: Array<{ type: "input_image"; image_url: string }> = [];
  if (input.failedProductUrl) {
    const c = await imageInputContent(input.failedProductUrl);
    if (c) attachments.push(c);
  }
  if (input.referenceUrls?.length) {
    const refs = await collectReferenceImageContents(input.referenceUrls);
    attachments.push(...refs);
  }
  const userContent: CallVisionParams["userContent"] = [
    { type: "input_text", text: userText },
    ...(attachments.length
      ? ([
          {
            type: "input_text" as const,
            text: lang === "en"
              ? `Attachments below: first the rejected output${input.referenceUrls?.length ? ", then up to 3 reference images that should be respected" : ""}.`
              : `下方附件：先是被打回的产物${input.referenceUrls?.length ? "，然后是最多 3 张应当遵循的参考图" : ""}。`
          },
          ...attachments
        ])
      : [])
  ];

  try {
    const apiBase = credential.apiBase;
    const response = await fetchWithRetry(`${apiBase}/responses`, {
      method: "POST",
      timeoutMs: 60_000,
      tag: "ark:prompt-rewrite",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`
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
    if (!response.ok) {
      console.warn(`[prompt-rewrite] API ${response.status}: ${text.slice(0, 300)}`);
      return { prompt: original, rewritten: false, model, note: `[skip] API ${response.status}` };
    }
    const body = text ? safeJson(text) : undefined;
    const tokenUsage = tokenUsageFromRaw(body);
    const rawText = (extractResponseText(body) || "").trim();
    // Strip any accidental markdown fences the rewriter might still emit despite the system prompt.
    const cleaned = rawText.replace(/^```(?:[a-z]+)?\s*/i, "").replace(/\s*```$/i, "").trim();
    if (!cleaned || cleaned === original) {
      return { prompt: original, rewritten: false, model, note: "[skip] rewriter returned empty or identical", tokenUsage };
    }
    return { prompt: cleaned, rewritten: true, model, tokenUsage };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[prompt-rewrite] threw: ${message.slice(0, 300)}`);
    return { prompt: original, rewritten: false, model, note: `[skip] ${message.slice(0, 200)}` };
  }
}
