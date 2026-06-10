import { spawn } from "node:child_process";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import ffmpeg from "@ffmpeg-installer/ffmpeg";
import {
  MEDIA_DIR,
  localMediaPathFromMediaUrl,
  probeMediaDurationSec,
  runFfmpegCommand
} from "./generators";
import { hasAgentPlanKey } from "./arkCredentials";
import type {
  AudioTrackMode,
  MusicGenerationKind,
  NarrationStrategy,
  NarrationSubtitleMode,
  NarrationSubtitlePosition,
  Session
} from "../shared/types";
import { voicePresetForId } from "../shared/voicePresets";

// Bumped whenever rendering / timing / TTS request shape changes so cached narration artifacts get
// re-rendered (signature is part of the output filename).
const NARRATION_SIGNATURE_VERSION = "narr-v11-timed-lines";

// V3 single-shot SSE endpoint - emits a stream of `event:/data:` blocks whose `data` JSON
// contains base64-encoded audio chunks. v1 (api/v1/tts) is intentionally NOT used: it does not
// support newer voices.
const VOLC_TTS_DEFAULT_BASE = "https://openspeech.bytedance.com/api/v3/tts/unidirectional/sse";
const VOLC_TTS_DEFAULT_VOICE = "zh_male_M392_conversation_wvae_bigtts";
const VOLC_TTS_DEFAULT_VOICE_EN = "en_male_jason_conversation_wvae_bigtts";
const VOLC_TTS_DEFAULT_VOICE_ZH_FEMALE = "BV001_streaming";
const VOLC_TTS_RESOURCE_SEED_1 = "seed-tts-1.0";
const VOLC_TTS_RESOURCE_SEED_2 = "seed-tts-2.0";
const VOLC_TTS_DEFAULT_RESOURCE_ID = "seed-tts-1.0";
const VOLC_TTS_DEFAULT_RATE = 24000;

const DEFAULT_GAP_MS = 200;
const DEFAULT_MAX_TEMPO = 1.30;
const DEFAULT_AMBIENT_DB = -12;
const VOLC_MUSIC_DEFAULT_HOST = "open.volcengineapi.com";
const VOLC_MUSIC_DEFAULT_REGION = "cn-beijing";
const VOLC_MUSIC_DEFAULT_SERVICE = "imagination";
const VOLC_MUSIC_DEFAULT_VERSION = "2024-08-12";
const VOLC_MUSIC_DEFAULT_MODEL_VERSION = "v5.0";
const VOLC_MUSIC_DEFAULT_KIND: MusicGenerationKind = "bgm";
const VOLC_MUSIC_DEFAULT_BILLING_MODE: VolcMusicBillingMode = "postpaid";
const VOLC_MUSIC_DEFAULT_POLL_MS = 5000;
const VOLC_MUSIC_DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;

// ---------- Public types ----------

export interface NarrationLineDescriptor {
  index: number;
  text: string;
  audioPath: string;
  rawDurationSec: number;
  startSec?: number;
}

export interface NarrationTimelineSegment {
  index: number;
  text: string;
  audioPath: string;
  // start/end inside the *output* video (i.e. after global atempo + with gaps), in seconds.
  startSec: number;
  endSec: number;
}

export interface NarrationTimeline {
  segments: NarrationTimelineSegment[];
  /** Global atempo (1.0 = no change) applied to the whole narration track. */
  globalTempo: number;
  /** Duration of the narration track (after atempo applied), in seconds — always <= videoDurationSec. */
  narrationDurationSec: number;
  /** Final clip length. Identical to videoDurationSec — narration NEVER extends the video. */
  outputDurationSec: number;
  /** Original probed video duration, in seconds. */
  videoDurationSec: number;
  /** Number of trailing sentences that had to be dropped because they did not fit at maxTempo. */
  droppedLineCount: number;
  /** Warning string suitable for surfacing to the UI/progress log; empty if no caveat. */
  warning?: string;
}

interface ParsedNarrationLine {
  text: string;
  startSec?: number;
}

export interface NarrationPipelineResult {
  narrationVideoUrl: string;
  narrationSubtitleUrl?: string;
  narrationSignature: string;
  /** The voice id we actually used (may differ from input.voice if we language-swapped). */
  effectiveVoice: string;
  musicTaskId?: string;
  musicAudioUrl?: string;
  musicLocalAudioUrl?: string;
}

export interface NarrationPipelineOptions {
  onProgress?: (phase: string) => Promise<void> | void;
}

// ---------- Signature ----------

export function computeNarrationSignature(input: {
  mode?: AudioTrackMode;
  script: string;
  voice: string;
  strategy: NarrationStrategy;
  finalVideoSignature: string;
  subtitleMode?: NarrationSubtitleMode;
  subtitlePosition?: NarrationSubtitlePosition;
  narrationVolume?: number;
  sourceVolume?: number;
  musicKind?: MusicGenerationKind;
  musicPrompt?: string;
  musicLyrics?: string;
  musicDurationSec?: number;
  musicModelVersion?: string;
}) {
  const payload = JSON.stringify({
    version: NARRATION_SIGNATURE_VERSION,
    mode: input.mode || "voiceover",
    script: input.script.trim(),
    voice: input.voice,
    strategy: input.strategy,
    finalVideoSignature: input.finalVideoSignature,
    subtitleMode: input.subtitleMode || "none",
    subtitlePosition: input.subtitlePosition || "bottom",
    narrationVolume: normalizeVolume(input.narrationVolume, 1.0),
    sourceVolume: input.sourceVolume === undefined ? undefined : normalizeVolume(input.sourceVolume, 0.25),
    musicKind: input.musicKind,
    musicPrompt: input.musicPrompt?.trim() || "",
    musicLyrics: input.musicLyrics?.trim() || "",
    musicDurationSec: input.musicDurationSec,
    musicModelVersion: input.musicModelVersion || VOLC_MUSIC_DEFAULT_MODEL_VERSION
  });
  return createHash("sha1").update(payload).digest("hex").slice(0, 12);
}

// ---------- Script -> sentence list ----------

const SECONDARY_SPLIT_REGEX = /(?<=[，；,;])/g;

/** Best-effort guess of the dominant language of a free-form script. */
export function detectScriptLanguage(script: string): "en" | "zh" {
  const sample = script.slice(0, 500);
  const cjk = (sample.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
  const latin = (sample.match(/[A-Za-z]/g) || []).length;
  return latin > cjk * 1.5 ? "en" : "zh";
}

/** Volcengine speaker ids are namespaced by language prefix: `en_*` vs everything else (zh_*). */
export function inferVoiceLanguage(voice: string): "en" | "zh" {
  return voice.startsWith("en_") ? "en" : "zh";
}

/**
 * Pick the voice we should actually feed to TTS. If the requested voice's language doesn't match
 * the script's dominant language, swap in the default speaker for the correct language so an
 * English script always gets an English voice and a Chinese script always gets a Chinese voice.
 */
export function resolveEffectiveVoice(script: string, requestedVoice: string): string {
  const scriptLang = detectScriptLanguage(script);
  const voiceLang = inferVoiceLanguage(requestedVoice);
  if (scriptLang === voiceLang) return requestedVoice;
  return scriptLang === "en" ? VOLC_TTS_DEFAULT_VOICE_EN : VOLC_TTS_DEFAULT_VOICE;
}

function containsAny(text: string, patterns: string[]) {
  return patterns.some((pattern) => text.includes(pattern));
}

export function resolveVoiceIdFromVoicePrompt(input: {
  voiceId?: string;
  voicePresetId?: string;
  voicePrompt?: string;
  previewText?: string;
  script?: string;
}): string | undefined {
  const explicit = input.voiceId?.trim();
  if (explicit) return explicit;
  const preset = voicePresetForId(input.voicePresetId);
  if (preset) return preset.voiceId;
  const text = [
    input.voicePrompt,
    input.previewText,
    input.script
  ].filter(Boolean).join(" ").toLowerCase();
  if (!text.trim()) return undefined;

  const wantsFemale = containsAny(text, [
    "女", "女人", "女生", "女孩", "少女", "姑娘", "大姐", "阿姨", "奶奶", "母亲", "妈妈",
    "female", "woman", "girl", "lady", "young woman"
  ]);
  const wantsMale = containsAny(text, [
    "男", "男人", "男生", "男孩", "少年", "大哥", "叔叔", "爷爷", "父亲", "爸爸",
    "male", "man", "boy", "gentleman"
  ]);
  const northeast = containsAny(text, ["东北", "东北话", "东北口音", "northeast", "dongbei"]);
  const english = containsAny(text, ["英文", "英语", "美式", "英式", "english", "american", "british"]);

  if (northeast && wantsFemale) return voicePresetForId("dongbei-female")?.voiceId || "BV020_streaming";
  if (northeast && wantsMale) return voicePresetForId("dongbei-male")?.voiceId || "BV021_streaming";
  if (english) return VOLC_TTS_DEFAULT_VOICE_EN;
  if (wantsFemale) return voicePresetForId("young-female")?.voiceId || VOLC_TTS_DEFAULT_VOICE_ZH_FEMALE;
  if (wantsMale) return VOLC_TTS_DEFAULT_VOICE;
  return undefined;
}
const SOFT_LIMIT = 80;
const HARD_LIMIT = 180;

/**
 * Split a free-form Chinese/English script into TTS-friendly sentences.
 *
 *  - First, normalize whitespace so a hard-wrapped paragraph like
 *      "...spotted\nforty-five miles south..."
 *    folds back into one logical sentence (single newlines → space; blank lines kept as breaks).
 *  - Then split on:
 *      * any CJK terminal: 。！？
 *      * English `.` / `!` / `?` followed by whitespace + uppercase/quote/paren start, AND preceded
 *        by at least two lowercase/digit characters so we don't break on "Mr.", "Dr.", "U.S.", "1.5".
 *      * paragraph breaks (\n\n+)
 *  - Sentences longer than HARD_LIMIT chars are further sliced by ，； , ;.
 *  - Whitespace-only / pure-punctuation pieces are dropped.
 */
export function splitScriptIntoLines(script: string): string[] {
  if (!script.trim()) return [];

  // Normalize whitespace: collapse intra-sentence newlines into spaces, keep paragraph breaks.
  const normalized = script
    .replace(/\r\n/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n\n")
    .replace(/(?<!\n)\n(?!\n)/g, " ")
    .trim();

  // Inject a sentinel after each sentence terminator, then split by sentinel.
  // The English regex requires at least two [a-z0-9] chars before the terminator AND a closing
  // bracket/quote may follow before the space, so "U.S.", "Mr.", "1.5" stay glued together.
  const SENTINEL = "\u0001";
  const sentenced = normalized
    .replace(/([。！？])/g, `$1${SENTINEL}`)
    .replace(/([a-z0-9]{2}[.!?]["')\]]*)\s+(?=["'(\[A-Z\d])/g, `$1${SENTINEL}`)
    .replace(/\n{2,}/g, SENTINEL);

  const out: string[] = [];
  for (const raw of sentenced.split(new RegExp(`${SENTINEL}+`))) {
    const segment = raw.replace(/\s+/g, " ").trim();
    if (!segment) continue;
    if (segment.length <= HARD_LIMIT) {
      out.push(segment);
      continue;
    }
    // Long sentence: slice by ，；,; while keeping the punctuation glued to the left half.
    const pieces = segment
      .split(SECONDARY_SPLIT_REGEX)
      .map((piece) => piece.trim())
      .filter(Boolean);
    let buffer = "";
    for (const piece of pieces) {
      if (buffer && (buffer.length + 1 + piece.length) > HARD_LIMIT) {
        out.push(buffer);
        buffer = "";
      }
      buffer = buffer ? `${buffer} ${piece}` : piece;
      if (buffer.length >= SOFT_LIMIT && /[，；,;]$/.test(buffer)) {
        out.push(buffer);
        buffer = "";
      }
    }
    if (buffer) out.push(buffer);
  }
  return out.filter((line) => /[\p{L}\p{N}]/u.test(line));
}

/**
 * Parse optional leading timecodes from narration lines.
 *
 * Supported forms:
 *   [00:15] 文本
 *   [15s] 文本
 *   [15] 文本
 *
 * The marker controls when that TTS line starts in the final video. It is not spoken.
 * Plain scripts keep the existing automatic left-to-right packing behavior.
 */
export function parseNarrationScriptLines(script: string): ParsedNarrationLine[] {
  return splitScriptIntoLines(script)
    .map((line) => {
      const match = line.match(/^\s*\[(?:(\d{1,2}):)?(\d{1,2})(?:\.(\d{1,3}))?s?\]\s*(.+)$/i);
      if (!match) return { text: line };
      const minutes = match[1] ? Number(match[1]) : 0;
      const seconds = Number(match[2]);
      const fraction = match[3] ? Number(`0.${match[3]}`) : 0;
      const text = match[4].trim();
      const startSec = minutes * 60 + seconds + fraction;
      if (!text || !Number.isFinite(startSec)) return { text: line };
      return { text, startSec };
    })
    .filter((line) => /[\p{L}\p{N}]/u.test(line.text));
}

// ---------- Volcengine OpenSpeech TTS ----------

interface VolcConfig {
  appid: string;
  token: string;
  voice: string;
  base: string;
  rate: number;
  resourceId: string;
}

function readVolcConfig(voiceOverride?: string): VolcConfig {
  const appid = process.env.VOLC_TTS_APPID || "";
  const token = process.env.VOLC_TTS_TOKEN || "";
  if (!appid || !token) {
    const agentPlanNote = hasAgentPlanKey()
      ? " ARK_AGENT_PLAN_KEY 已检测到，但它是 Ark/Agent Plan 模型 API Key，当前 OpenSpeech TTS 仍需要 VOLC_TTS_APPID 与 VOLC_TTS_TOKEN。"
      : "";
    throw new Error(
      `火山 TTS 凭证未配置。请在 shell（如 ~/.zshrc）或 .env 设置 VOLC_TTS_APPID 与 VOLC_TTS_TOKEN，参考 Volcengine OpenSpeech 控制台。${agentPlanNote}`
    );
  }
  return {
    appid,
    token,
    voice: voiceOverride || process.env.VOLC_TTS_VOICE_TYPE || VOLC_TTS_DEFAULT_VOICE,
    base: process.env.VOLC_TTS_BASE || VOLC_TTS_DEFAULT_BASE,
    rate: parseNumberEnv(process.env.VOLC_TTS_RATE, VOLC_TTS_DEFAULT_RATE),
    resourceId: process.env.VOLC_TTS_RESOURCE_ID || VOLC_TTS_DEFAULT_RESOURCE_ID
  };
}

export function inferVolcTtsResourceIdForVoice(voice: string): string {
  const normalized = voice.trim();
  if (normalized.includes("_bigtts")) return VOLC_TTS_RESOURCE_SEED_2;
  if (/^BV\d+_streaming$/i.test(normalized)) return VOLC_TTS_RESOURCE_SEED_1;
  return VOLC_TTS_DEFAULT_RESOURCE_ID;
}

export function resolveVolcTtsResourceCandidates(voice: string, configuredResourceId: string): string[] {
  return Array.from(new Set([
    configuredResourceId,
    inferVolcTtsResourceIdForVoice(voice),
    VOLC_TTS_RESOURCE_SEED_1,
    VOLC_TTS_RESOURCE_SEED_2
  ].filter(Boolean)));
}

function isVolcTtsResourceMismatch(err: Error) {
  return /resource ID is mismatched|mismatched with speaker related resource/i.test(err.message);
}

/**
 * Synthesize one line of text via Volcengine OpenSpeech v3 single-shot SSE endpoint.
 *
 * Request shape (per https://www.volcengine.com/docs/6561/1598757):
 *   POST {base}                       // default: .../api/v3/tts/unidirectional/sse
 *   Headers:
 *     X-Api-App-Id: <appid>
 *     X-Api-Access-Key: <access_token>
 *     X-Api-Resource-Id: seed-tts-2.0 (for *_bigtts voices) | seed-tts-1.0 (for legacy voices)
 *     X-Api-Request-Id: <uuid>
 *   Body: { user: { uid }, req_params: { text, speaker, audio_params: { format, sample_rate } } }
 *
 * Response: a text/event-stream where each event block looks like
 *     event: 352
 *     data: {"code":0,"data":"<base64 audio chunk>"}
 * and the final block is `event: 152` with code=20000000 (SessionFinish). On error, code is
 * a non-zero non-20000000 value (45000000 voice unauthorized, 55000000 server error, etc.).
 *
 * Retries up to 3 times on network / non-fatal errors.
 */
export async function synthesizeViaDoubao(text: string, voice?: string): Promise<Buffer> {
  const cfg = readVolcConfig(voice);
  const resourceCandidates = resolveVolcTtsResourceCandidates(cfg.voice, cfg.resourceId);
  const payload = {
    user: { uid: `cinema_agent_${cfg.appid}` },
    req_params: {
      text,
      speaker: cfg.voice,
      audio_params: {
        format: "mp3",
        sample_rate: cfg.rate
      }
    }
  };

  let lastErr: Error | undefined;
  for (const resourceId of resourceCandidates) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const response = await fetch(cfg.base, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Api-App-Id": cfg.appid,
            "X-Api-Access-Key": cfg.token,
            "X-Api-Resource-Id": resourceId,
            "X-Api-Request-Id": randomUUID()
          },
          body: JSON.stringify(payload)
        });
        if (!response.ok) {
          const errBody = await response.text().catch(() => "");
          throw new Error(`Volcengine TTS HTTP ${response.status} ${response.statusText}: ${errBody.slice(0, 200)}`);
        }
        if (!response.body) throw new Error("Volcengine TTS returned no body");

        const audio = await consumeVolcSseStream(response.body);
        if (!audio.length) {
          throw new Error("Volcengine TTS returned empty audio (no audio chunks in stream)");
        }
        return audio;
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        if (isVolcTtsResourceMismatch(lastErr)) break;
        if (attempt < 3) await new Promise((r) => setTimeout(r, 800 * attempt));
      }
    }
  }
  throw lastErr || new Error("Volcengine TTS failed");
}

/**
 * Stream-decode the SSE response, concatenate base64 audio chunks, and surface a meaningful
 * error if any event signals a non-success code (other than 0 = chunk OK and 20000000 = end).
 */
async function consumeVolcSseStream(body: ReadableStream<Uint8Array>): Promise<Buffer> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  const audioChunks: Buffer[] = [];
  let fatalErr: Error | undefined;

  for (;;) {
    const { done, value } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: true });
    // Split into SSE event blocks on the wire boundary "\n\n".
    for (;;) {
      const sep = buffer.indexOf("\n\n");
      if (sep < 0) break;
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const dataPayload = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("");
      if (!dataPayload) continue;
      let obj: { code?: number; message?: string; data?: string | null };
      try {
        obj = JSON.parse(dataPayload);
      } catch {
        continue;
      }
      const code = typeof obj.code === "number" ? obj.code : 0;
      if (code !== 0 && code !== 20000000) {
        fatalErr = new Error(`Volcengine TTS error code=${code} message=${obj.message || ""}`);
        break;
      }
      if (typeof obj.data === "string" && obj.data) {
        audioChunks.push(Buffer.from(obj.data, "base64"));
      }
    }
    if (fatalErr) break;
    if (done) break;
  }
  if (fatalErr) throw fatalErr;
  return Buffer.concat(audioChunks);
}

// ---------- Volcengine Music (doubao-music / imagination OpenAPI) ----------

type VolcMusicBillingMode = "postpaid" | "prepaid";

interface VolcMusicConfig {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  host: string;
  region: string;
  service: string;
  version: string;
  billingMode: VolcMusicBillingMode;
  modelVersion: string;
  tosBucket?: string;
  pollMs: number;
  timeoutMs: number;
}

interface VolcMusicSignedRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
  action: string;
}

interface VolcMusicPollResult {
  status: "running" | "succeeded" | "failed";
  audioUrl?: string;
  taskId?: string;
  lyrics?: string;
  durationSec?: number;
  failureReason?: string;
  raw: unknown;
}

function readVolcMusicConfig(modelVersion?: string): VolcMusicConfig {
  const accessKeyId = env(
    "VOLC_MUSIC_ACCESS_KEY_ID",
    "VOLCENGINE_ACCESS_KEY",
    "VOLCENGINE_ACCESS_KEY_ID",
    "VOLC_ACCESS_KEY",
    "VOLC_ACCESS_KEY_ID",
    "TOS_ACCESS_KEY_ID",
    "TOS_ACCESS_KEY"
  );
  const secretAccessKey = env(
    "VOLC_MUSIC_SECRET_ACCESS_KEY",
    "VOLCENGINE_SECRET_KEY",
    "VOLCENGINE_SECRET_ACCESS_KEY",
    "VOLC_SECRET_KEY",
    "VOLC_SECRET_ACCESS_KEY",
    "TOS_SECRET_ACCESS_KEY",
    "TOS_ACCESS_KEY_SECRET"
  );
  if (!accessKeyId || !secretAccessKey) {
    const agentPlanNote = hasAgentPlanKey()
      ? " ARK_AGENT_PLAN_KEY 已检测到，但豆包音乐走火山 openapi 签名（Service=imagination），Agent Plan 不能替代 AK/SK。"
      : "";
    throw new Error(
      `火山音乐凭证未配置。请设置 VOLC_MUSIC_ACCESS_KEY_ID 与 VOLC_MUSIC_SECRET_ACCESS_KEY（或 arkcli SSO 写入的 VOLCENGINE_ACCESS_KEY / VOLCENGINE_SECRET_KEY）。${agentPlanNote}`
    );
  }
  return {
    accessKeyId,
    secretAccessKey,
    sessionToken: env("VOLC_MUSIC_SESSION_TOKEN", "VOLCENGINE_SESSION_TOKEN", "VOLCENGINE_STS_TOKEN"),
    host: process.env.VOLC_MUSIC_HOST || VOLC_MUSIC_DEFAULT_HOST,
    region: process.env.VOLC_MUSIC_REGION || VOLC_MUSIC_DEFAULT_REGION,
    service: process.env.VOLC_MUSIC_SERVICE || VOLC_MUSIC_DEFAULT_SERVICE,
    version: process.env.VOLC_MUSIC_API_VERSION || VOLC_MUSIC_DEFAULT_VERSION,
    billingMode: parseVolcMusicBillingMode(process.env.VOLC_MUSIC_BILLING_MODE),
    modelVersion: modelVersion || process.env.VOLC_MUSIC_MODEL_VERSION || VOLC_MUSIC_DEFAULT_MODEL_VERSION,
    tosBucket: process.env.VOLC_MUSIC_TOS_BUCKET || undefined,
    pollMs: parseNumberEnv(process.env.VOLC_MUSIC_POLL_MS, VOLC_MUSIC_DEFAULT_POLL_MS),
    timeoutMs: parseNumberEnv(process.env.VOLC_MUSIC_TIMEOUT_MS, VOLC_MUSIC_DEFAULT_TIMEOUT_MS)
  };
}

function parseVolcMusicBillingMode(value: string | undefined): VolcMusicBillingMode {
  return value === "prepaid" || value === "postpaid" ? value : VOLC_MUSIC_DEFAULT_BILLING_MODE;
}

export function buildVolcMusicRequest(input: {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  host?: string;
  region?: string;
  service?: string;
  version?: string;
  action: string;
  body: Record<string, unknown>;
  now?: Date;
}): VolcMusicSignedRequest {
  const host = input.host || VOLC_MUSIC_DEFAULT_HOST;
  const region = input.region || VOLC_MUSIC_DEFAULT_REGION;
  const service = input.service || VOLC_MUSIC_DEFAULT_SERVICE;
  const version = input.version || VOLC_MUSIC_DEFAULT_VERSION;
  const now = input.now || new Date();
  const xDate = toVolcXDate(now);
  const shortDate = xDate.slice(0, 8);
  const body = JSON.stringify(input.body);
  const payloadHash = sha256Hex(body);
  const query = canonicalQuery({ Action: input.action, Version: version });
  const canonicalHeaderMap: Record<string, string> = {
    "content-type": "application/json",
    host,
    "x-content-sha256": payloadHash,
    "x-date": xDate
  };
  if (input.sessionToken) canonicalHeaderMap["x-security-token"] = input.sessionToken;
  const signedHeaderNames = Object.keys(canonicalHeaderMap).sort();
  const canonicalHeaders = signedHeaderNames.map((key) => `${key}:${canonicalHeaderMap[key]}`).join("\n") + "\n";
  const signedHeaders = signedHeaderNames.join(";");
  const canonicalRequest = [
    "POST",
    "/",
    query,
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join("\n");
  const credentialScope = `${shortDate}/${region}/${service}/request`;
  const stringToSign = [
    "HMAC-SHA256",
    xDate,
    credentialScope,
    sha256Hex(canonicalRequest)
  ].join("\n");
  const signature = hmacHex(signingKey(input.secretAccessKey, shortDate, region, service), stringToSign);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Host: host,
    "X-Date": xDate,
    "X-Content-Sha256": payloadHash,
    Authorization: `HMAC-SHA256 Credential=${input.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
  };
  if (input.sessionToken) headers["X-Security-Token"] = input.sessionToken;
  return {
    action: input.action,
    url: `https://${host}/?${query}`,
    body,
    headers
  };
}

async function requestVolcMusic(config: VolcMusicConfig, action: string, body: Record<string, unknown>) {
  const request = buildVolcMusicRequest({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    sessionToken: config.sessionToken,
    host: config.host,
    region: config.region,
    service: config.service,
    version: config.version,
    action,
    body
  });
  const response = await fetch(request.url, {
    method: "POST",
    headers: request.headers,
    body: request.body
  });
  const text = await response.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Volcengine Music ${action} returned non-JSON HTTP ${response.status}: ${text.slice(0, 240)}`);
  }
  if (!response.ok) {
    throw new Error(`Volcengine Music ${action} HTTP ${response.status}: ${extractVolcMessage(json) || text.slice(0, 240)}`);
  }
  const code = numberAt(json, "Code");
  if (code !== undefined && code !== 0) {
    throw new Error(`Volcengine Music ${action} code=${code}: ${extractVolcMessage(json)}`);
  }
  const metadataError = objectAt(json, "ResponseMetadata", "Error");
  if (metadataError) {
    throw new Error(`Volcengine Music ${action}: ${extractVolcMessage(metadataError)}`);
  }
  return json;
}

export async function generateVolcMusic(input: {
  kind: MusicGenerationKind;
  prompt: string;
  lyrics?: string;
  durationSec: number;
  modelVersion?: string;
  onProgress?: (phase: string) => Promise<void> | void;
}): Promise<{ taskId: string; audioUrl: string; lyrics?: string; durationSec?: number }> {
  const config = readVolcMusicConfig(input.modelVersion);
  const action = musicAction(input.kind, config.billingMode);
  const body = buildMusicCreateBody(input, config);
  const created = await requestVolcMusic(config, action, body);
  const taskId = stringAt(created, "Result", "TaskID") || stringAt(created, "TaskID");
  if (!taskId) {
    throw new Error(`Volcengine Music ${action} did not return TaskID`);
  }
  await input.onProgress?.(`music task ${taskId}`);

  const started = Date.now();
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, Math.max(1000, config.pollMs)));
    const polled = await pollVolcMusicTask(config, taskId);
    if (polled.status === "succeeded" && polled.audioUrl) {
      return {
        taskId,
        audioUrl: polled.audioUrl,
        lyrics: polled.lyrics,
        durationSec: polled.durationSec
      };
    }
    if (polled.status === "failed") {
      throw new Error(`Volcengine Music task ${taskId} failed: ${polled.failureReason || "unknown error"}`);
    }
    if (Date.now() - started > config.timeoutMs) {
      throw new Error(`Volcengine Music task ${taskId} timed out after ${Math.round(config.timeoutMs / 1000)}s`);
    }
    await input.onProgress?.(`music task ${taskId} still running`);
  }
}

async function pollVolcMusicTask(config: VolcMusicConfig, taskId: string): Promise<VolcMusicPollResult> {
  const json = await requestVolcMusic(config, "QuerySong", { TaskID: taskId });
  return parseVolcMusicPollResult(json);
}

export function parseVolcMusicPollResult(json: unknown): VolcMusicPollResult {
  const result = objectAt(json, "Result") || (typeof json === "object" && json !== null ? json : {});
  const songDetail = objectAt(result, "SongDetail") || objectAt(json, "SongDetail") || {};
  const audioUrl =
    stringAt(songDetail, "AudioUrl") ||
    stringAt(songDetail, "AudioURL") ||
    stringAt(songDetail, "Audio") ||
    stringAt(result, "AudioUrl") ||
    stringAt(result, "AudioURL") ||
    stringAt(json, "AudioUrl");
  const statusValue = valueAt(result, "Status") ?? valueAt(json, "Status");
  const statusString = String(statusValue ?? "").toLowerCase();
  const failureReason = extractVolcFailureReason(result) || extractVolcFailureReason(json);
  if (audioUrl || statusValue === 2 || statusString === "success" || statusString === "succeeded") {
    return {
      status: audioUrl ? "succeeded" : "running",
      audioUrl,
      taskId: stringAt(result, "TaskID") || stringAt(json, "TaskID"),
      lyrics: stringAt(songDetail, "Lyrics") || stringAt(result, "Lyrics"),
      durationSec: numberAt(songDetail, "Duration") || numberAt(result, "Duration"),
      raw: json
    };
  }
  if (statusValue === 3 || statusString === "failed" || statusString === "fail" || statusString === "error") {
    return {
      status: "failed",
      taskId: stringAt(result, "TaskID") || stringAt(json, "TaskID"),
      failureReason,
      raw: json
    };
  }
  return {
    status: "running",
    taskId: stringAt(result, "TaskID") || stringAt(json, "TaskID"),
    raw: json
  };
}

function buildMusicCreateBody(
  input: { kind: MusicGenerationKind; prompt: string; lyrics?: string; durationSec: number; modelVersion?: string },
  config: VolcMusicConfig
) {
  const duration = clampMusicDuration(input.durationSec, input.kind);
  if (input.kind === "song") {
    return stripUndefined({
      Prompt: input.prompt,
      Lyrics: input.lyrics?.trim() || undefined,
      Duration: duration,
      ModelVersion: config.modelVersion,
      VodFormat: "mp3",
      TosBucket: config.tosBucket || undefined
    });
  }
  return stripUndefined({
    Text: input.prompt,
    Duration: duration,
    EnableInputRewrite: false,
    Version: config.modelVersion,
    TosBucket: config.tosBucket || undefined
  });
}

function musicAction(kind: MusicGenerationKind, billingMode: VolcMusicBillingMode) {
  if (kind === "song") return billingMode === "prepaid" ? "GenSongV4" : "GenSongForTime";
  return billingMode === "prepaid" ? "GenBGM" : "GenBGMForTime";
}

function clampMusicDuration(durationSec: number, kind: MusicGenerationKind) {
  const parsed = Number(durationSec);
  const fallback = kind === "song" ? 60 : 60;
  const value = Number.isFinite(parsed) ? parsed : fallback;
  const min = kind === "song" ? 30 : 30;
  const max = kind === "song" ? 240 : 120;
  return Math.max(min, Math.min(max, Math.round(value)));
}

export async function downloadRemoteAudio(url: string, sessionId: string, signature: string) {
  await mkdir(MEDIA_DIR, { recursive: true });
  const ext = extensionFromUrl(url) || ".mp3";
  const outputPath = path.join(MEDIA_DIR, `music-${sessionId}-${signature}${ext}`);
  if (await fileExists(outputPath)) return outputPath;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download music audio failed: ${response.status} ${response.statusText}`);
  const buf = Buffer.from(await response.arrayBuffer());
  if (!buf.length) throw new Error("Downloaded music audio is empty");
  await writeFile(outputPath, buf);
  return outputPath;
}

function extensionFromUrl(url: string) {
  try {
    const ext = path.extname(new URL(url).pathname).toLowerCase();
    return ext && ext.length <= 8 ? ext : "";
  } catch {
    return "";
  }
}

function toVolcXDate(date: Date) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function canonicalQuery(params: Record<string, string>) {
  return Object.entries(params)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
}

function sha256Hex(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function hmacBuffer(key: Buffer | string, value: string) {
  return createHmac("sha256", key).update(value).digest();
}

function hmacHex(key: Buffer | string, value: string) {
  return createHmac("sha256", key).update(value).digest("hex");
}

function signingKey(secret: string, shortDate: string, region: string, service: string) {
  return hmacBuffer(hmacBuffer(hmacBuffer(hmacBuffer(secret, shortDate), region), service), "request");
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== "")) as T;
}

function env(...keys: string[]) {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

function valueAt(value: unknown, ...pathParts: string[]): unknown {
  let current: unknown = value;
  for (const part of pathParts) {
    if (!current || typeof current !== "object" || !(part in current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function objectAt(value: unknown, ...pathParts: string[]) {
  const out = valueAt(value, ...pathParts);
  return out && typeof out === "object" ? out as Record<string, unknown> : undefined;
}

function stringAt(value: unknown, ...pathParts: string[]) {
  const out = valueAt(value, ...pathParts);
  return typeof out === "string" && out ? out : undefined;
}

function numberAt(value: unknown, ...pathParts: string[]) {
  const out = valueAt(value, ...pathParts);
  return typeof out === "number" && Number.isFinite(out) ? out : undefined;
}

function extractVolcFailureReason(value: unknown) {
  const failure = objectAt(value, "FailureReason");
  if (failure) return extractVolcMessage(failure);
  return stringAt(value, "FailureReason") || stringAt(value, "Error") || stringAt(value, "Message");
}

function extractVolcMessage(value: unknown) {
  return (
    stringAt(value, "Message") ||
    stringAt(value, "Msg") ||
    stringAt(value, "message") ||
    stringAt(value, "Error", "Message") ||
    stringAt(value, "ResponseMetadata", "Error", "Message") ||
    JSON.stringify(value).slice(0, 240)
  );
}

// ---------- Timeline assembly ----------

/**
 * Pack narration sentences inside the video timeline without ever extending the video.
 *
 *  1. Compute "natural" runtime = sum(speech) + (lines-1)*gap.
 *  2. If natural runtime <= video → tempo=1.0 and we just lay sentences end-to-end starting at 0.
 *  3. If natural runtime > video, set globalTempo = min(maxTempo, natural/video). atempo speeds up
 *     the whole narration track by that factor (default cap = 1.30x ≈ 30% faster).
 *  4. Walk the sentence list left-to-right at globalTempo; the moment placing the next sentence
 *     would push past videoDurationSec, drop it AND all remaining sentences and surface a warning.
 *
 * Net effect: outputDurationSec === videoDurationSec, regardless of how long the script is.
 * Trailing sentences may be silently dropped — caller is expected to show the warning back.
 */
export function assembleNarrationTimeline(
  lines: Array<{ text: string; audioPath: string; rawDurationSec: number; startSec?: number }>,
  videoDurationSec: number,
  opts?: { gapMs?: number; maxTempo?: number }
): NarrationTimeline {
  const gapSec = (opts?.gapMs ?? parseNumberEnv(process.env.NARRATION_GAP_MS, DEFAULT_GAP_MS)) / 1000;
  const maxTempo = Math.max(
    1.0,
    opts?.maxTempo ?? parseNumberEnv(process.env.NARRATION_FIT_MAX_TEMPO, DEFAULT_MAX_TEMPO)
  );

  if (!lines.length) {
    return {
      segments: [],
      globalTempo: 1.0,
      narrationDurationSec: 0,
      outputDurationSec: videoDurationSec,
      videoDurationSec,
      droppedLineCount: 0,
      warning: undefined
    };
  }

  const totalSpeechSec = lines.reduce((sum, line) => sum + line.rawDurationSec, 0);
  const totalGapSec = gapSec * Math.max(0, lines.length - 1);
  const naturalTotal = totalSpeechSec + totalGapSec;
  const hasTimedLines = lines.some((line) => Number.isFinite(line.startSec));

  let globalTempo = 1.0;
  if (hasTimedLines) {
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const startSec = clampTimelineStart(line.startSec ?? 0, videoDurationSec);
      const nextTimed = lines.slice(index + 1).find((next) => Number.isFinite(next.startSec));
      const windowEnd = nextTimed?.startSec !== undefined
        ? clampTimelineStart(nextTimed.startSec, videoDurationSec)
        : videoDurationSec;
      const availableSec = Math.max(0.1, windowEnd - startSec - gapSec);
      globalTempo = Math.max(globalTempo, line.rawDurationSec / availableSec);
    }
    globalTempo = Math.min(maxTempo, globalTempo);
  } else if (naturalTotal > videoDurationSec) {
    globalTempo = Math.min(maxTempo, naturalTotal / videoDurationSec);
  }

  const segments: NarrationTimelineSegment[] = [];
  let cursorSec = 0;
  let droppedLineCount = 0;
  const epsilon = 0.05;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (hasTimedLines && Number.isFinite(line.startSec)) {
      cursorSec = Math.max(cursorSec, clampTimelineStart(line.startSec, videoDurationSec));
    }
    const adjustedDuration = line.rawDurationSec / globalTempo;
    const endIfPlaced = cursorSec + adjustedDuration;
    if (endIfPlaced > videoDurationSec + epsilon) {
      droppedLineCount = lines.length - index;
      break;
    }
    segments.push({
      index,
      text: line.text,
      audioPath: line.audioPath,
      startSec: cursorSec,
      endSec: Math.min(endIfPlaced, videoDurationSec)
    });
    const nextIdx = index + 1;
    cursorSec = nextIdx < lines.length ? endIfPlaced + gapSec / globalTempo : endIfPlaced;
  }

  const narrationDurationSec = segments.length ? segments[segments.length - 1].endSec : 0;

  let warning: string | undefined;
  if (droppedLineCount > 0) {
    const tempoNote = globalTempo > 1.001 ? `已按 ${globalTempo.toFixed(2)}x 加速；` : "";
    warning = `脚本明显长于视频：${tempoNote}末尾 ${droppedLineCount} 句因放不下被裁掉。视频长度未改变；如需保留请缩短脚本或在 .env 调大 NARRATION_FIT_MAX_TEMPO（默认 ${DEFAULT_MAX_TEMPO}）。`;
  } else if (globalTempo > 1.001) {
    warning = hasTimedLines
      ? `部分带时间码旁白略长：旁白整体加速 ${globalTempo.toFixed(2)}x 以贴合指定镜头窗口。`
      : `脚本略长于视频：旁白整体加速 ${globalTempo.toFixed(2)}x 以贴合视频长度。`;
  }

  return {
    segments,
    globalTempo,
    narrationDurationSec,
    outputDurationSec: videoDurationSec,
    videoDurationSec,
    droppedLineCount,
    warning
  };
}

function clampTimelineStart(value: number | undefined, videoDurationSec: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(value || 0, Math.max(0, videoDurationSec - 0.05)));
}

// ---------- SRT ----------

// Approx chars per rendered line at FontSize=12 + MarginL/R=40 on a 720x1280 frame, after which
// libass wraps. CJK doesn't wrap on its own so we also hard-wrap upstream to match.
const SUBTITLE_PER_EN_LINE = 24;
const SUBTITLE_PER_CJK_LINE = 18;
// Hard cap of rendered lines per cue. If a single TTS segment would render more than this many
// stacked lines we split it into multiple time-shared sub-cues so the subtitle area stays small
// (≤ 2 lines ≈ 110px ≈ 9% of vertical frame).
const SUBTITLE_MAX_LINES_PER_CUE = 2;

export function buildSrt(segments: NarrationTimelineSegment[]) {
  const expanded = segments.flatMap((seg) => splitSegmentForSrt(seg));
  return expanded
    .map((seg, idx) => {
      const cueIndex = idx + 1;
      const start = formatSrtTime(seg.startSec);
      const end = formatSrtTime(seg.endSec);
      return `${cueIndex}\n${start} --> ${end}\n${wrapSubtitleLine(seg.text)}\n`;
    })
    .join("\n");
}

function isCjkDominant(text: string) {
  const cjk = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
  const spaces = (text.match(/ /g) || []).length;
  return cjk >= 6 && cjk > spaces * 3;
}

function estimateRenderedLines(text: string): number {
  const perLine = isCjkDominant(text) ? SUBTITLE_PER_CJK_LINE : SUBTITLE_PER_EN_LINE;
  return Math.max(1, Math.ceil(text.length / perLine));
}

/**
 * If a single narration segment would render as more than SUBTITLE_MAX_LINES_PER_CUE lines, slice
 * it into k smaller sub-cues. Each sub-cue gets a slice of the segment's [startSec, endSec]
 * proportional to its character count, and a slice of the text that breaks at the highest-scored
 * boundary (CJK sentence end > CJK clause comma > English sentence end > English clause comma >
 * space) closest to the equi-character target.
 *
 * NOTE: this only affects what's burned into the video / written to .srt — the audio track still
 * plays the unsplit TTS clip behind it, so the spoken sentence remains a single uninterrupted
 * utterance.
 */
function splitSegmentForSrt(seg: NarrationTimelineSegment, maxLines = SUBTITLE_MAX_LINES_PER_CUE): NarrationTimelineSegment[] {
  const renderedLines = estimateRenderedLines(seg.text);
  if (renderedLines <= maxLines) return [seg];
  const k = Math.ceil(renderedLines / maxLines);
  const pieces = splitTextIntoKParts(seg.text, k);
  if (pieces.length <= 1) return [seg];
  const totalChars = pieces.reduce((sum, piece) => sum + piece.length, 0) || 1;
  const total = Math.max(0, seg.endSec - seg.startSec);
  const out: NarrationTimelineSegment[] = [];
  let cursor = seg.startSec;
  pieces.forEach((piece, i) => {
    const isLast = i === pieces.length - 1;
    const share = piece.length / totalChars;
    const end = isLast ? seg.endSec : cursor + total * share;
    out.push({
      index: seg.index,
      text: piece,
      audioPath: seg.audioPath,
      startSec: cursor,
      endSec: end
    });
    cursor = end;
  });
  return out;
}

function splitTextIntoKParts(text: string, k: number): string[] {
  if (k <= 1 || text.length <= 1) return [text];
  const target = text.length / k;
  type BreakOp = { idx: number; score: number };
  const breaks: BreakOp[] = [];
  for (let i = 1; i < text.length; i += 1) {
    const ch = text[i - 1];
    const next = text[i] || "";
    let score = 0;
    if (/[。！？]/.test(ch)) score = 100;
    else if (/[，、；]/.test(ch)) score = 60;
    else if (/[.!?]/.test(ch) && /\s/.test(next)) score = 90;
    else if (/[,;:]/.test(ch) && /\s/.test(next)) score = 55;
    else if (ch === " ") score = 25;
    if (score > 0) breaks.push({ idx: i, score });
  }
  const minGap = Math.max(4, Math.floor(target * 0.3));
  const chosen: number[] = [];
  for (let n = 1; n < k; n += 1) {
    const wanted = Math.round(target * n);
    const lastChosen = chosen[chosen.length - 1] ?? 0;
    const window = Math.max(8, Math.round(target * 0.5));
    const candidates = breaks.filter(
      (b) => b.idx > lastChosen + minGap && Math.abs(b.idx - wanted) <= window
    );
    if (candidates.length) {
      candidates.sort((a, b) => b.score - a.score || Math.abs(a.idx - wanted) - Math.abs(b.idx - wanted));
      chosen.push(candidates[0].idx);
    } else {
      // No friendly boundary: fall back to a hard character split at the wanted index.
      chosen.push(Math.max(lastChosen + minGap, wanted));
    }
  }
  const pieces: string[] = [];
  let prev = 0;
  for (const c of chosen) {
    pieces.push(text.slice(prev, c).trim());
    prev = c;
  }
  pieces.push(text.slice(prev).trim());
  return pieces.filter(Boolean);
}

/**
 * libass auto-wraps subtitle lines on ASCII whitespace (English) but CANNOT wrap continuous CJK
 * runs — Chinese has no spaces and libass doesn't treat 中文标点 as wrap opportunities. So we
 * also hard-wrap CJK-dominant text upstream so libass renders ≤ 2 stacked lines.
 */
function wrapSubtitleLine(text: string, perCjkLine = SUBTITLE_PER_CJK_LINE): string {
  if (!isCjkDominant(text)) return text;
  if (text.length <= perCjkLine) return text;
  const out: string[] = [];
  for (let i = 0; i < text.length; i += perCjkLine) out.push(text.slice(i, i + perCjkLine));
  return out.join("\n");
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

const pad2 = (n: number) => String(n).padStart(2, "0");
const pad3 = (n: number) => String(n).padStart(3, "0");

function parseNumberEnv(value: string | undefined, fallback: number): number {
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

// ---------- Pipeline ----------

/**
 * Run the full narration pipeline for a session that already has a `finalVideoUrl`.
 *
 * Side effects:
 *  - writes per-line mp3 and an audio-only narrated mp4 into MEDIA_DIR
 *  - if a previous run produced the same signature artifact (verified by file existence), it reuses
 *    it and returns immediately
 *
 * Throws (caller is expected to record `narrationStatus=error` + `narrationError`):
 *  - Volcengine credentials missing
 *  - probed video duration unavailable
 *  - ffmpeg failure (the message includes a stderr tail)
 */
export async function runNarrationPipeline(
  session: Pick<Session, "id" | "finalVideoUrl" | "finalVideoSignature">,
  input: {
    mode?: AudioTrackMode;
    script: string;
    voice: string;
    strategy: NarrationStrategy;
    subtitleMode?: NarrationSubtitleMode;
    subtitlePosition?: NarrationSubtitlePosition;
    narrationVolume?: number;
    sourceVolume?: number;
    musicKind?: MusicGenerationKind;
    musicPrompt?: string;
    musicLyrics?: string;
    musicDurationSec?: number;
    musicModelVersion?: string;
  },
  options: NarrationPipelineOptions = {}
): Promise<NarrationPipelineResult> {
  if (!session.finalVideoUrl) {
    throw new Error("Session has no finalVideoUrl — 请先完成拼接再生成解说。");
  }
  if (!session.finalVideoSignature) {
    throw new Error("Session has no finalVideoSignature — 请先完成一次拼接再生成解说。");
  }

  const mode: AudioTrackMode = input.mode === "music" ? "music" : "voiceover";
  // Safety net: if the requested voice doesn't match the script's dominant language, swap it for
  // the default speaker of the correct language. Guarantees "English script -> English narration /
  // Chinese script -> Chinese narration" even if the client cached a stale voice id.
  const effectiveVoice = mode === "voiceover" ? resolveEffectiveVoice(input.script, input.voice) : input.voice;
  if (effectiveVoice !== input.voice) {
    console.log(
      `[narration ${session.id}] voice ${input.voice} doesn't match script language → swapping to ${effectiveVoice}`
    );
  }

  const cfg = mode === "voiceover" ? readVolcConfig(effectiveVoice) : undefined;
  const effectiveVoiceForSignature = cfg?.voice || effectiveVoice;

  const signature = computeNarrationSignature({
    mode,
    script: input.script,
    voice: effectiveVoiceForSignature,
    strategy: input.strategy,
    finalVideoSignature: session.finalVideoSignature,
    subtitleMode: input.subtitleMode,
    subtitlePosition: input.subtitlePosition,
    narrationVolume: input.narrationVolume,
    sourceVolume: input.sourceVolume,
    musicKind: input.musicKind,
    musicPrompt: input.musicPrompt,
    musicLyrics: input.musicLyrics,
    musicDurationSec: input.musicDurationSec,
    musicModelVersion: input.musicModelVersion
  });
  const report = async (phase: string) => {
    console.log(`[narration ${session.id}] ${phase}`);
    try {
      await options.onProgress?.(phase);
    } catch (err) {
      console.warn(`[narration ${session.id}] progress callback threw: ${(err as Error).message}`);
    }
  };

  await mkdir(MEDIA_DIR, { recursive: true });

  const outputVideoName = `final-${session.id}-${session.finalVideoSignature}-narrated-${signature}.mp4`;
  const outputVideoPath = path.join(MEDIA_DIR, outputVideoName);
  const subtitleMode = input.subtitleMode || "none";
  const subtitlePosition = input.subtitlePosition || "bottom";

  // Quick reuse: if the audio-only narrated video already exists on disk for this signature, return
  // without rebuilding.
  if (await fileExists(outputVideoPath)) {
    await report(`reused cached narration (signature ${signature})`);
    return {
      narrationVideoUrl: `/media/${outputVideoName}`,
      narrationSignature: signature,
      effectiveVoice: effectiveVoice
    };
  }

  await report(mode === "music" ? `signature=${signature} music=doubao-music` : `signature=${signature} voice=${effectiveVoiceForSignature}`);

  const sourceVideoPath = await materializeFinalVideo(session.finalVideoUrl, session.id, signature);
  const videoDurationSec = await probeMediaDurationSec(sourceVideoPath);
  await report(`video duration ${videoDurationSec.toFixed(2)}s`);

  if (mode === "music") {
    const prompt = (input.musicPrompt || input.script || "").trim();
    if (!prompt) throw new Error("音乐提示词为空。");
    const musicDurationSec = input.musicDurationSec || videoDurationSec;
    await report(`music submit ${input.musicKind || VOLC_MUSIC_DEFAULT_KIND}: ${truncatePreview(prompt)}`);
    const music = await generateVolcMusic({
      kind: input.musicKind || VOLC_MUSIC_DEFAULT_KIND,
      prompt,
      lyrics: input.musicLyrics,
      durationSec: musicDurationSec,
      modelVersion: input.musicModelVersion,
      onProgress: report
    });
    await report(`music ready task=${music.taskId}`);
    const musicPath = await downloadRemoteAudio(music.audioUrl, session.id, signature);
    const musicLocalAudioUrl = `/media/${path.basename(musicPath)}`;
    const timeline: NarrationTimeline = {
      segments: [{
        index: 0,
        text: prompt,
        audioPath: musicPath,
        startSec: 0,
        endSec: videoDurationSec
      }],
      globalTempo: 1.0,
      narrationDurationSec: videoDurationSec,
      outputDurationSec: videoDurationSec,
      videoDurationSec,
      droppedLineCount: 0
    };
    await renderFinalNarratedVideo({
      sourceVideoPath,
      timeline,
      outputPath: outputVideoPath,
      subtitleMode: "none",
      subtitlePosition: "bottom",
      narrationVolume: input.narrationVolume,
      sourceVolume: input.sourceVolume,
      report
    });
    return {
      narrationVideoUrl: `/media/${outputVideoName}`,
      narrationSignature: signature,
      effectiveVoice,
      musicTaskId: music.taskId,
      musicAudioUrl: music.audioUrl,
      musicLocalAudioUrl
    };
  }

  const lines = parseNarrationScriptLines(input.script);
  if (!lines.length) throw new Error("脚本为空或全是标点。");
  await report(`split script into ${lines.length} lines`);

  const lineDescriptors: NarrationLineDescriptor[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const text = line.text;
    const audioPath = path.join(MEDIA_DIR, `narr-${session.id}-${signature}-line-${pad3(index + 1)}.mp3`);
    if (!(await fileExists(audioPath))) {
      await report(`tts ${index + 1}/${lines.length}: ${truncatePreview(text)}`);
      try {
        const audio = await synthesizeViaDoubao(text, effectiveVoiceForSignature);
        await writeFile(audioPath, audio);
      } catch (err) {
        await report(`tts ${index + 1} failed (${(err as Error).message}); inserting silence`);
        await writeSilentMp3(audioPath, estimateSilenceSecFor(text));
      }
    } else {
      await report(`tts ${index + 1}/${lines.length}: reuse cached`);
    }
    const rawDurationSec = await probeMediaDurationSec(audioPath).catch(() => 0);
    lineDescriptors.push({ index, text, audioPath, rawDurationSec, startSec: line.startSec });
  }

  const timeline = assembleNarrationTimeline(
    lineDescriptors.map((line) => ({
      text: line.text,
      audioPath: line.audioPath,
      rawDurationSec: line.rawDurationSec,
      startSec: line.startSec
    })),
    videoDurationSec
  );
  await report(
    `timeline: narration=${timeline.narrationDurationSec.toFixed(2)}s / video=${timeline.videoDurationSec.toFixed(2)}s tempo=${timeline.globalTempo.toFixed(3)} kept=${timeline.segments.length} dropped=${timeline.droppedLineCount}`
  );
  if (timeline.warning) await report(timeline.warning);

  let subtitlePath: string | undefined;
  if (subtitleMode === "burn") {
    subtitlePath = path.join(MEDIA_DIR, `narr-${session.id}-${signature}.srt`);
    await writeFile(subtitlePath, buildSrt(timeline.segments));
    await report(`subtitle burn-in enabled (${subtitlePosition})`);
  }

  await renderFinalNarratedVideo({
    sourceVideoPath,
    timeline,
    outputPath: outputVideoPath,
    subtitleMode,
    subtitlePosition,
    subtitlePath,
    narrationVolume: input.narrationVolume,
    sourceVolume: input.sourceVolume,
    report
  });

  return {
    narrationVideoUrl: `/media/${outputVideoName}`,
    narrationSignature: signature,
    effectiveVoice: effectiveVoice
  };
}

// ---------- Internal helpers ----------

async function materializeFinalVideo(videoUrl: string, sessionId: string, signature: string) {
  const local = localMediaPathFromMediaUrl(videoUrl);
  if (local) return local;
  if (videoUrl.startsWith("file://")) return new URL(videoUrl).pathname;
  if (!videoUrl.startsWith("http")) return videoUrl;

  await mkdir(MEDIA_DIR, { recursive: true });
  const cachePath = path.join(MEDIA_DIR, `narr-source-${sessionId}-${signature}.mp4`);
  if (await fileExists(cachePath)) return cachePath;
  const response = await fetch(videoUrl);
  if (!response.ok) throw new Error(`Download finalVideoUrl failed: ${response.status} ${response.statusText}`);
  const buf = Buffer.from(await response.arrayBuffer());
  await writeFile(cachePath, buf);
  return cachePath;
}

async function fileExists(filePath: string) {
  try {
    const info = await stat(filePath);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

function truncatePreview(text: string) {
  return text.length > 24 ? `${text.slice(0, 22)}…` : text;
}

function estimateSilenceSecFor(text: string) {
  // Heuristic fallback when TTS fails: take the longer of "Chinese chars / 5 cps" vs
  // "English words / 2.5 wps" so the gap roughly matches what the spoken line would have been.
  const charsSec = text.length / 5;
  const wordCount = (text.match(/\b[\w']+\b/g) || []).length;
  const wordsSec = wordCount / 2.5;
  return Math.max(0.6, Math.min(10, Math.max(charsSec, wordsSec)));
}

async function writeSilentMp3(outputPath: string, durationSec: number) {
  await runFfmpegCommand([
    "-y",
    "-f",
    "lavfi",
    "-i",
    `anullsrc=channel_layout=mono:sample_rate=24000`,
    "-t",
    durationSec.toFixed(2),
    "-q:a",
    "9",
    "-acodec",
    "libmp3lame",
    outputPath
  ]);
}

async function probeHasAudio(filePath: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const child = spawn(ffmpeg.path, ["-hide_banner", "-i", filePath], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-8192);
    });
    child.on("error", () => resolve(false));
    child.on("close", () => {
      resolve(/Stream #\d+:\d+.*Audio:/.test(stderr));
    });
  });
}

async function renderFinalNarratedVideo(opts: {
  sourceVideoPath: string;
  timeline: NarrationTimeline;
  outputPath: string;
  subtitleMode: NarrationSubtitleMode;
  subtitlePosition: NarrationSubtitlePosition;
  subtitlePath?: string;
  narrationVolume?: number;
  sourceVolume?: number;
  report: (phase: string) => Promise<void>;
}) {
  const { sourceVideoPath, timeline, outputPath, subtitleMode, subtitlePosition, subtitlePath, report } = opts;
  const hasAudio = await probeHasAudio(sourceVideoPath);
  const ambientDb = parseNumberEnv(process.env.NARRATION_AMBIENT_DB, DEFAULT_AMBIENT_DB);
  const ambientGain = opts.sourceVolume === undefined
    ? Math.pow(10, ambientDb / 20) // -12 dB -> ~0.25
    : normalizeVolume(opts.sourceVolume, 0.25);
  const narrationGain = normalizeVolume(opts.narrationVolume, 1.0);

  // Build per-segment narration mix: each TTS clip is delayed by its startSec (in ms) and then
  // mixed together. amix's inputs are listed in order [narr_0][narr_1]...[narr_n-1].
  const ffmpegArgs: string[] = ["-y"];
  ffmpegArgs.push("-i", sourceVideoPath);
  timeline.segments.forEach((segment) => {
    ffmpegArgs.push("-i", segment.audioPath);
  });
  if (!hasAudio) {
    // Provide a silent stereo source so the [orig:a] branch in filtergraph stays valid.
    ffmpegArgs.push("-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100");
  }

  const narrInputBase = 1; // [1:a]..[N:a] are TTS lines
  const silenceInputIndex = 1 + timeline.segments.length; // only present if !hasAudio

  // Per-segment chain: pull out audio, set tempo, delay, output a unique label.
  const filterParts: string[] = [];
  const narrationLabels: string[] = [];
  timeline.segments.forEach((segment, idx) => {
    const inputIdx = narrInputBase + idx;
    const label = `narr${idx}`;
    const delayMs = Math.round(segment.startSec * 1000);
    const tempoFilter = timeline.globalTempo !== 1.0 ? `,atempo=${timeline.globalTempo.toFixed(4)}` : "";
    const delayFilter = delayMs > 0 ? `,adelay=${delayMs}|${delayMs}` : "";
    filterParts.push(`[${inputIdx}:a]aformat=channel_layouts=stereo,volume=${narrationGain.toFixed(3)}${tempoFilter}${delayFilter}[${label}]`);
    narrationLabels.push(`[${label}]`);
  });

  // Mix narration lines into a single [narrmix] track (or silence when zero lines).
  if (narrationLabels.length === 0) {
    filterParts.push(`anullsrc=channel_layout=stereo:sample_rate=44100[narrmix]`);
  } else if (narrationLabels.length === 1) {
    filterParts.push(`${narrationLabels[0]}anull[narrmix]`);
  } else {
    filterParts.push(`${narrationLabels.join("")}${buildAmixFilter(narrationLabels.length)}[narrmix]`);
  }

  // Ambient track: from input 0 if present, otherwise the silent stereo source.
  const ambientSourceLabel = hasAudio ? "[0:a]" : `[${silenceInputIndex}:a]`;
  filterParts.push(`${ambientSourceLabel}aformat=channel_layouts=stereo,volume=${ambientGain.toFixed(3)}[ambient]`);
  filterParts.push(`[ambient][narrmix]${buildAmixFilter(2)}[aout]`);
  const shouldBurnSubtitles = subtitleMode === "burn" && Boolean(subtitlePath);
  if (shouldBurnSubtitles && subtitlePath) {
    filterParts.push(`[0:v]subtitles='${escapeFfmpegFilterArg(subtitlePath)}':force_style='${subtitleForceStyle(subtitlePosition)}'[vout]`);
  }

  ffmpegArgs.push("-filter_complex", filterParts.join(";"));
  ffmpegArgs.push("-map", shouldBurnSubtitles ? "[vout]" : "0:v", "-map", "[aout]");
  ffmpegArgs.push(
    // Keep the output exactly as long as the input video — narration is truncated upstream if it
    // would otherwise extend past videoDurationSec.
    "-t", timeline.outputDurationSec.toFixed(3),
    "-c:v", "libx264",
    "-preset", "medium",
    "-crf", "18",
    "-pix_fmt", "yuv420p",
    "-profile:v", "high",
    "-level", "4.0",
    "-c:a", "aac",
    "-b:a", "192k",
    "-movflags", "+faststart",
    outputPath
  );

  await report(`ffmpeg narration mix${shouldBurnSubtitles ? " + burned subtitles" : ""} -> ${path.basename(outputPath)}`);
  const start = Date.now();
  try {
    await runFfmpegCommand(ffmpegArgs, 8192);
  } catch (err) {
    // Clean up so the next attempt does not reuse a half-written file.
    await unlink(outputPath).catch(() => undefined);
    throw err;
  }
  await report(`ffmpeg narration mix done in ${((Date.now() - start) / 1000).toFixed(1)}s`);
}

export function buildAmixFilter(inputCount: number) {
  const safeCount = Math.max(1, Math.floor(inputCount));
  return `amix=inputs=${safeCount}:duration=longest`;
}

function normalizeVolume(value: number | undefined, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(2, parsed));
}

function escapeFfmpegFilterArg(value: string) {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'");
}

function subtitleForceStyle(position: NarrationSubtitlePosition) {
  const alignment = position === "top" ? 8 : position === "middle" ? 5 : 2;
  const marginV = position === "middle" ? 0 : 72;
  return [
    "FontName=Arial",
    "FontSize=42",
    "PrimaryColour=&H00FFFFFF",
    "OutlineColour=&HAA000000",
    "BorderStyle=1",
    "Outline=2",
    "Shadow=1",
    `Alignment=${alignment}`,
    `MarginV=${marginV}`
  ].join(",");
}
