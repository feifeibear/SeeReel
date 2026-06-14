import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { MEDIA_DIR, runFfmpegCommand } from "./generators";

const VOLC_ASR_DEFAULT_BASE = "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash";
const VOLC_ASR_DEFAULT_SUBMIT_BASE = "https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit";
const VOLC_ASR_DEFAULT_QUERY_BASE = "https://openspeech.bytedance.com/api/v3/auc/bigmodel/query";
const VOLC_ASR_DEFAULT_FLASH_RESOURCE_ID = "volc.bigasr.auc_turbo";
const VOLC_ASR_DEFAULT_STANDARD_RESOURCE_ID = "volc.seedasr.auc";
const VOLC_ASR_DEFAULT_POLL_MS = 5000;
const VOLC_ASR_DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export type PostProductionAsrProvider = "volc" | "hyperframes";
type VolcAsrMode = "standard" | "flash";

export interface VolcAsrRequestInput {
  audioBase64: string;
  apiKey?: string;
  appid?: string;
  token?: string;
  resourceId?: string;
  requestId?: string;
  uid?: string;
  base?: string;
}

export interface VolcAsrRequest {
  url: string;
  headers: Record<string, string>;
  body: {
    user: { uid: string };
    audio: { data: string };
    request: { model_name: "bigmodel" };
  };
}

export interface VolcAsrTaskRequest {
  url: string;
  headers: Record<string, string>;
  body: {
    user: { uid: string };
    audio: { data: string; format: "wav"; codec: "raw" };
    request: {
      model_name: "bigmodel";
      enable_itn: boolean;
      enable_punc: boolean;
      show_utterances: boolean;
    };
  };
}

interface VolcAsrConfig {
  mode: VolcAsrMode;
  apiKey?: string;
  appid?: string;
  token?: string;
  secretKey?: string;
  resourceId: string;
  base: string;
  submitBase: string;
  queryBase: string;
  uid: string;
  pollMs: number;
  timeoutMs: number;
}

type EnvLike = Record<string, string | undefined>;

export function resolvePostProductionAsrProvider(): PostProductionAsrProvider {
  return process.env.POST_PRODUCTION_ASR_PROVIDER === "hyperframes" ? "hyperframes" : "volc";
}

export function buildVolcAsrRequest(input: VolcAsrRequestInput): VolcAsrRequest {
  const resourceId = input.resourceId || VOLC_ASR_DEFAULT_FLASH_RESOURCE_ID;
  const requestId = input.requestId || randomUUID();
  const apiKey = input.apiKey?.trim();
  const appid = input.appid?.trim();
  const token = input.token?.trim();
  const uid = input.uid?.trim() || apiKey || appid || "seereel-asr";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Api-Resource-Id": resourceId,
    "X-Api-Request-Id": requestId,
    "X-Api-Sequence": "-1"
  };
  if (apiKey) {
    headers["X-Api-Key"] = apiKey;
  } else if (appid && token) {
    headers["X-Api-App-Key"] = appid;
    headers["X-Api-Access-Key"] = token;
  } else {
    throw new Error("火山 ASR 凭证未配置。请设置 VOLC_ASR_API_KEY 或 VOLC_ACCESS_KEY；旧版控制台可设置 VOLC_ASR_APPID 与 VOLC_ASR_TOKEN。");
  }
  return {
    url: input.base || VOLC_ASR_DEFAULT_BASE,
    headers,
    body: {
      user: { uid },
      audio: { data: input.audioBase64 },
      request: { model_name: "bigmodel" }
    }
  };
}

export function buildVolcAsrSubmitRequest(input: VolcAsrRequestInput): VolcAsrTaskRequest {
  const resourceId = input.resourceId || VOLC_ASR_DEFAULT_STANDARD_RESOURCE_ID;
  const requestId = input.requestId || randomUUID();
  const apiKey = input.apiKey?.trim();
  const appid = input.appid?.trim();
  const token = input.token?.trim();
  const uid = input.uid?.trim() || apiKey || appid || "seereel-asr";
  if (!apiKey && (!appid || !token)) {
    throw new Error("火山 ASR 标准版凭证未配置。请设置新版 VOLC_ASR_API_KEY，或设置 VOLC_ASR_APPID/VOLC_APP_ID 与 VOLC_ACCESS_KEY。");
  }
  return {
    url: input.base || VOLC_ASR_DEFAULT_SUBMIT_BASE,
    headers: apiKey
      ? apiKeyVolcAsrHeaders({ apiKey, resourceId, requestId, sequence: "-1" })
      : legacyVolcAsrHeaders({ appid: appid!, token: token!, resourceId, requestId, sequence: "-1" }),
    body: {
      user: { uid },
      audio: { data: input.audioBase64, format: "wav", codec: "raw" },
      request: {
        model_name: "bigmodel",
        enable_itn: true,
        enable_punc: true,
        show_utterances: true
      }
    }
  };
}

export function buildVolcAsrQueryRequest(input: {
  apiKey?: string;
  appid?: string;
  token?: string;
  resourceId?: string;
  requestId: string;
  base?: string;
}) {
  const apiKey = input.apiKey?.trim();
  const appid = input.appid?.trim();
  const token = input.token?.trim();
  if (!apiKey && (!appid || !token)) {
    throw new Error("火山 ASR 标准版凭证未配置。请设置新版 VOLC_ASR_API_KEY，或设置 VOLC_ASR_APPID/VOLC_APP_ID 与 VOLC_ACCESS_KEY。");
  }
  const resourceId = input.resourceId || VOLC_ASR_DEFAULT_STANDARD_RESOURCE_ID;
  return {
    url: input.base || VOLC_ASR_DEFAULT_QUERY_BASE,
    headers: apiKey
      ? apiKeyVolcAsrHeaders({ apiKey, resourceId, requestId: input.requestId })
      : legacyVolcAsrHeaders({ appid: appid!, token: token!, resourceId, requestId: input.requestId }),
    body: {}
  };
}

export async function transcribeMediaToSrtWithVolcAsr(mediaPath: string) {
  const cfg = readVolcAsrConfig();
  const audioPath = await extractVolcAsrAudio(mediaPath);
  const audioBase64 = (await readFile(audioPath)).toString("base64");
  if (cfg.mode === "standard") {
    return await transcribeVolcAsrStandard({ ...cfg, audioBase64 });
  }
  const request = buildVolcAsrRequest({ ...cfg, audioBase64 });
  const response = await fetch(request.url, {
    method: "POST",
    headers: request.headers,
    body: JSON.stringify(request.body)
  });
  const statusCode = response.headers.get("X-Api-Status-Code") || "";
  const statusMessage = response.headers.get("X-Api-Message") || response.statusText;
  const logId = response.headers.get("X-Tt-Logid") || "";
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`火山 ASR 请求失败：HTTP ${response.status} ${statusMessage}${logId ? ` logid=${logId}` : ""}`);
  }
  if (statusCode && statusCode !== "20000000") {
    throw new Error(`火山 ASR 识别失败：${statusCode} ${statusMessage}${logId ? ` logid=${logId}` : ""}`);
  }
  const parsed = safeJsonParse(raw);
  if (!parsed) throw new Error(`火山 ASR 返回非 JSON 内容：${raw.slice(0, 300)}`);
  const srt = normalizeVolcAsrResponseToSrt(parsed);
  if (!srt.trim()) throw new Error("火山 ASR 未返回可用的带时间轴字幕。");
  return srt;
}

async function transcribeVolcAsrStandard(cfg: VolcAsrConfig & { audioBase64: string }) {
  const requestId = randomUUID();
  const submit = buildVolcAsrSubmitRequest({
    ...cfg,
    requestId,
    audioBase64: cfg.audioBase64,
    base: cfg.submitBase
  });
  const submitResponse = await fetch(submit.url, {
    method: "POST",
    headers: submit.headers,
    body: JSON.stringify(submit.body)
  });
  await assertVolcAsrAccepted(submitResponse, "提交");
  const startedAt = Date.now();
  for (;;) {
    if (Date.now() - startedAt > cfg.timeoutMs) {
      throw new Error(`火山 ASR 查询超时：requestId=${requestId}`);
    }
    await delay(cfg.pollMs);
    const query = buildVolcAsrQueryRequest({
      ...cfg,
      requestId,
      base: cfg.queryBase
    });
    const response = await fetch(query.url, {
      method: "POST",
      headers: query.headers,
      body: JSON.stringify(query.body)
    });
    const statusCode = response.headers.get("X-Api-Status-Code") || "";
    const statusMessage = response.headers.get("X-Api-Message") || response.statusText;
    const logId = response.headers.get("X-Tt-Logid") || "";
    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`火山 ASR 查询失败：HTTP ${response.status} ${statusMessage}${logId ? ` logid=${logId}` : ""}`);
    }
    if (statusCode === "20000001" || statusCode === "20000002") continue;
    if (statusCode && statusCode !== "20000000") {
      throw new Error(`火山 ASR 识别失败：${statusCode} ${statusMessage}${logId ? ` logid=${logId}` : ""}`);
    }
    const parsed = safeJsonParse(raw);
    if (!parsed) throw new Error(`火山 ASR 返回非 JSON 内容：${raw.slice(0, 300)}`);
    const srt = normalizeVolcAsrResponseToSrt(parsed);
    if (!srt.trim()) throw new Error("火山 ASR 未返回可用的带时间轴字幕。");
    return srt;
  }
}

async function assertVolcAsrAccepted(response: Response, phase: string) {
  const statusCode = response.headers.get("X-Api-Status-Code") || "";
  const statusMessage = response.headers.get("X-Api-Message") || response.statusText;
  const logId = response.headers.get("X-Tt-Logid") || "";
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`火山 ASR ${phase}失败：HTTP ${response.status} ${statusMessage}${logId ? ` logid=${logId}` : ""}`);
  }
  if (statusCode && statusCode !== "20000000") {
    throw new Error(`火山 ASR ${phase}失败：${statusCode} ${statusMessage}${logId ? ` logid=${logId}` : ""}${raw ? ` ${raw.slice(0, 160)}` : ""}`);
  }
}

export function normalizeVolcAsrResponseToSrt(response: unknown) {
  const cues = extractVolcAsrCues(response).flatMap(splitTimedTextSegment);
  return cues
    .filter((cue) => cue.endSec > cue.startSec && cue.text.trim())
    .map((cue, index) => `${index + 1}\n${formatSrtTime(cue.startSec)} --> ${formatSrtTime(cue.endSec)}\n${cue.text.trim()}\n`)
    .join("\n");
}

async function extractVolcAsrAudio(mediaPath: string) {
  await mkdir(MEDIA_DIR, { recursive: true });
  const inputStat = await stat(mediaPath);
  const signature = createHash("sha1")
    .update(JSON.stringify({
      mediaPath: path.resolve(mediaPath),
      size: inputStat.size,
      mtimeMs: Math.round(inputStat.mtimeMs),
      version: "volc-asr-wav-v1"
    }))
    .digest("hex")
    .slice(0, 20);
  const outputPath = path.join(MEDIA_DIR, `volc-asr-${signature}.wav`);
  if (await fileExists(outputPath)) return outputPath;
  await runFfmpegCommand([
    "-y",
    "-i", mediaPath,
    "-vn",
    "-ac", "1",
    "-ar", "16000",
    "-c:a", "pcm_s16le",
    outputPath
  ]);
  return outputPath;
}

export function resolveVolcAsrConfigFromEnv(source: EnvLike = process.env): VolcAsrConfig {
  const mode = source.VOLC_ASR_MODE === "flash" ? "flash" : "standard";
  const apiKey = envFrom(source, "VOLC_ASR_API_KEY", "VOLCENGINE_ASR_API_KEY", "BYTEPLUS_ASR_API_KEY");
  const appid = envFrom(source, "VOLC_ASR_APPID", "VOLC_ASR_APP_KEY", "VOLC_APP_ID", "VOLC_APPID");
  const token = envFrom(source, "VOLC_ASR_TOKEN", "VOLC_ASR_ACCESS_TOKEN", "VOLC_ACCESS_KEY");
  const secretKey = envFrom(source, "VOLC_ASR_SECRET_KEY", "VOLC_SECRET_KEY");
  return {
    mode,
    apiKey,
    appid,
    token,
    secretKey,
    resourceId: source.VOLC_ASR_RESOURCE_ID || (mode === "flash" ? VOLC_ASR_DEFAULT_FLASH_RESOURCE_ID : VOLC_ASR_DEFAULT_STANDARD_RESOURCE_ID),
    base: source.VOLC_ASR_BASE || VOLC_ASR_DEFAULT_BASE,
    submitBase: source.VOLC_ASR_SUBMIT_BASE || VOLC_ASR_DEFAULT_SUBMIT_BASE,
    queryBase: source.VOLC_ASR_QUERY_BASE || VOLC_ASR_DEFAULT_QUERY_BASE,
    uid: source.VOLC_ASR_UID || apiKey || appid || "seereel-asr",
    pollMs: Math.max(1000, Number(source.VOLC_ASR_POLL_MS || VOLC_ASR_DEFAULT_POLL_MS)),
    timeoutMs: Math.max(5000, Number(source.VOLC_ASR_TIMEOUT_MS || VOLC_ASR_DEFAULT_TIMEOUT_MS))
  };
}

function legacyVolcAsrHeaders(input: { appid: string; token: string; resourceId: string; requestId: string; sequence?: string }) {
  return {
    "Content-Type": "application/json",
    "X-Api-App-Key": input.appid,
    "X-Api-Access-Key": input.token,
    "X-Api-Resource-Id": input.resourceId,
    "X-Api-Request-Id": input.requestId,
    ...(input.sequence ? { "X-Api-Sequence": input.sequence } : {})
  };
}

function apiKeyVolcAsrHeaders(input: { apiKey: string; resourceId: string; requestId: string; sequence?: string }) {
  return {
    "Content-Type": "application/json",
    "X-Api-Key": input.apiKey,
    "X-Api-Resource-Id": input.resourceId,
    "X-Api-Request-Id": input.requestId,
    ...(input.sequence ? { "X-Api-Sequence": input.sequence } : {})
  };
}

function readVolcAsrConfig(): VolcAsrConfig {
  return resolveVolcAsrConfigFromEnv(process.env);
}

function extractVolcAsrCues(response: unknown): Array<{ startSec: number; endSec: number; text: string }> {
  if (!response || typeof response !== "object") return [];
  const root = response as Record<string, unknown>;
  const result = root.result && typeof root.result === "object" ? root.result as Record<string, unknown> : root;
  const utterances = Array.isArray(result.utterances) ? result.utterances : [];
  if (utterances.length) {
    return utterances.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const item = entry as Record<string, unknown>;
      const text = stringField(item, ["text", "utterance"]);
      const startSec = millisField(item, ["start_time", "startTime", "start"]);
      const endSec = millisField(item, ["end_time", "endTime", "end"]);
      return text && Number.isFinite(startSec) && Number.isFinite(endSec)
        ? [{ startSec: roundSec(startSec), endSec: roundSec(endSec), text }]
        : [];
    });
  }
  const text = stringField(result, ["text"]);
  const durationSec = millisField(root.audio_info && typeof root.audio_info === "object" ? root.audio_info as Record<string, unknown> : result, ["duration"]);
  return text && Number.isFinite(durationSec) && durationSec > 0
    ? [{ startSec: 0, endSec: roundSec(durationSec), text }]
    : [];
}

function splitTimedTextSegment(segment: { startSec: number; endSec: number; text: string }) {
  const clean = segment.text.replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const duration = Math.max(0.1, segment.endSec - segment.startSec);
  const targetChars = isCjkDominant(clean) ? 24 : 54;
  if (clean.length <= targetChars * 1.35 && duration <= 5.5) {
    return [{ ...segment, text: clean }];
  }
  const pieces = splitCaptionText(clean, targetChars);
  if (pieces.length <= 1) return [{ ...segment, text: clean }];
  const totalChars = pieces.reduce((sum, piece) => sum + piece.length, 0) || 1;
  let cursor = segment.startSec;
  return pieces.map((piece, index) => {
    const share = piece.length / totalChars;
    const endSec = index === pieces.length - 1 ? segment.endSec : Math.min(segment.endSec, cursor + duration * share);
    const cue = { startSec: roundSec(cursor), endSec: roundSec(Math.max(cursor + 0.2, endSec)), text: piece };
    cursor = cue.endSec;
    return cue;
  });
}

function splitCaptionText(text: string, targetChars: number) {
  const sentencePieces = text.match(/[^。！？!?；;，,]+[。！？!?；;，,]?/g)?.map((part) => part.trim()).filter(Boolean) || [text];
  const out: string[] = [];
  let current = "";
  const flush = () => {
    if (current.trim()) out.push(current.trim());
    current = "";
  };
  for (const piece of sentencePieces) {
    if (piece.length > targetChars * 1.5) {
      flush();
      for (let i = 0; i < piece.length; i += targetChars) out.push(piece.slice(i, i + targetChars).trim());
      continue;
    }
    if (current && current.length + piece.length > targetChars) flush();
    current += piece;
  }
  flush();
  return out.filter(Boolean);
}

function millisField(obj: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = Number(obj[key]);
    if (Number.isFinite(value)) return value / 1000;
  }
  return Number.NaN;
}

function stringField(obj: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function isCjkDominant(text: string) {
  const cjk = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
  return cjk >= 6 && cjk > text.length * 0.35;
}

function formatSrtTime(sec: number) {
  const safe = Math.max(0, sec);
  const totalMillis = Math.round(safe * 1000);
  const hours = Math.floor(totalMillis / 3_600_000);
  const minutes = Math.floor((totalMillis % 3_600_000) / 60_000);
  const seconds = Math.floor((totalMillis % 60_000) / 1000);
  const millis = totalMillis % 1000;
  return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)},${pad3(millis)}`;
}

function env(...keys: string[]) {
  return envFrom(process.env, ...keys);
}

function envFrom(source: EnvLike, ...keys: string[]) {
  for (const key of keys) {
    const value = source[key]?.trim();
    if (value) return value;
  }
  return "";
}

async function fileExists(filePath: string) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function safeJsonParse(value: string) {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function roundSec(value: number) {
  return Math.round(value * 1000) / 1000;
}

const pad2 = (n: number) => String(n).padStart(2, "0");
const pad3 = (n: number) => String(n).padStart(3, "0");
