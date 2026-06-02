import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
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
import type { NarrationStrategy, Session } from "../shared/types";

// Bumped whenever rendering / timing / TTS request shape changes so cached narration artifacts get
// re-rendered (signature is part of the output filename). v3 = English support + don't pad video +
// arial-unicode subtitle font + seed-tts-1.0 default.
const NARRATION_SIGNATURE_VERSION = "narr-v8-bottom-2lines";

// V3 single-shot SSE endpoint - emits a stream of `event:/data:` blocks whose `data` JSON
// contains base64-encoded audio chunks. v1 (api/v1/tts) is intentionally NOT used: it does not
// support newer voices.
const VOLC_TTS_DEFAULT_BASE = "https://openspeech.bytedance.com/api/v3/tts/unidirectional/sse";
const VOLC_TTS_DEFAULT_VOICE = "zh_male_M392_conversation_wvae_bigtts";
const VOLC_TTS_DEFAULT_VOICE_EN = "en_male_jason_conversation_wvae_bigtts";
// Most appids only have seed-tts-1.0 authorized. The *_bigtts speaker IDs still work fine under
// seed-tts-1.0; if a user actually has 2.0 access they can override via env.
const VOLC_TTS_DEFAULT_RESOURCE_ID = "seed-tts-1.0";
const VOLC_TTS_DEFAULT_RATE = 24000;

const DEFAULT_GAP_MS = 200;
const DEFAULT_MAX_TEMPO = 1.30;
const DEFAULT_AMBIENT_DB = -12;

// ffmpeg-installer ships ffmpeg with libass but NO libfontconfig, so system font names cannot be
// resolved and they silently fall back to Helvetica (which has no CJK glyphs → ⬛). We point
// libass at a directory that holds a single .ttf with full CJK + Latin coverage and reference it
// by PostScript name.
const SUBTITLE_FONT_DEFAULT = "Arial Unicode MS";
const SUBTITLE_FONTSDIR_DEFAULT = "/System/Library/Fonts/Supplemental";

// ---------- Public types ----------

export interface NarrationLineDescriptor {
  index: number;
  text: string;
  audioPath: string;
  rawDurationSec: number;
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

export interface NarrationPipelineResult {
  narrationVideoUrl: string;
  narrationSubtitleUrl: string;
  narrationSignature: string;
  /** The voice id we actually used (may differ from input.voice if we language-swapped). */
  effectiveVoice: string;
}

export interface NarrationPipelineOptions {
  onProgress?: (phase: string) => Promise<void> | void;
}

// ---------- Signature ----------

export function computeNarrationSignature(input: {
  script: string;
  voice: string;
  strategy: NarrationStrategy;
  finalVideoSignature: string;
}) {
  const payload = JSON.stringify({
    version: NARRATION_SIGNATURE_VERSION,
    script: input.script.trim(),
    voice: input.voice,
    strategy: input.strategy,
    finalVideoSignature: input.finalVideoSignature
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
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(cfg.base, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Api-App-Id": cfg.appid,
          "X-Api-Access-Key": cfg.token,
          "X-Api-Resource-Id": cfg.resourceId,
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
      if (attempt < 3) await new Promise((r) => setTimeout(r, 800 * attempt));
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
  lines: Array<{ text: string; audioPath: string; rawDurationSec: number }>,
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

  let globalTempo = 1.0;
  if (naturalTotal > videoDurationSec) {
    globalTempo = Math.min(maxTempo, naturalTotal / videoDurationSec);
  }

  const segments: NarrationTimelineSegment[] = [];
  let cursorSec = 0;
  let droppedLineCount = 0;
  const epsilon = 0.05;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
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
    warning = `脚本略长于视频：旁白整体加速 ${globalTempo.toFixed(2)}x 以贴合视频长度。`;
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
 *  - writes per-line mp3, srt and final mp4 into MEDIA_DIR
 *  - if a previous run produced the same signature artifacts (verified by file existence), it
 *    reuses them and returns immediately
 *
 * Throws (caller is expected to record `narrationStatus=error` + `narrationError`):
 *  - Volcengine credentials missing
 *  - probed video duration unavailable
 *  - ffmpeg failure (the message includes a stderr tail)
 */
export async function runNarrationPipeline(
  session: Pick<Session, "id" | "finalVideoUrl" | "finalVideoSignature">,
  input: { script: string; voice: string; strategy: NarrationStrategy },
  options: NarrationPipelineOptions = {}
): Promise<NarrationPipelineResult> {
  if (!session.finalVideoUrl) {
    throw new Error("Session has no finalVideoUrl — 请先完成拼接再生成解说。");
  }
  if (!session.finalVideoSignature) {
    throw new Error("Session has no finalVideoSignature — 请先完成一次拼接再生成解说。");
  }

  // Safety net: if the requested voice doesn't match the script's dominant language, swap it for
  // the default speaker of the correct language. Guarantees "English script -> English narration /
  // Chinese script -> Chinese narration" even if the client cached a stale voice id.
  const effectiveVoice = resolveEffectiveVoice(input.script, input.voice);
  if (effectiveVoice !== input.voice) {
    console.log(
      `[narration ${session.id}] voice ${input.voice} doesn't match script language → swapping to ${effectiveVoice}`
    );
  }

  const cfg = readVolcConfig(effectiveVoice);

  const signature = computeNarrationSignature({
    script: input.script,
    voice: cfg.voice,
    strategy: input.strategy,
    finalVideoSignature: session.finalVideoSignature
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
  const outputSrtName = `narr-${session.id}-${signature}.srt`;
  const outputVideoPath = path.join(MEDIA_DIR, outputVideoName);
  const outputSrtPath = path.join(MEDIA_DIR, outputSrtName);

  // Quick reuse: if both files already exist on disk for this signature, return without rebuilding.
  if ((await fileExists(outputVideoPath)) && (await fileExists(outputSrtPath))) {
    await report(`reused cached narration (signature ${signature})`);
    return {
      narrationVideoUrl: `/media/${outputVideoName}`,
      narrationSubtitleUrl: `/media/${outputSrtName}`,
      narrationSignature: signature,
      effectiveVoice: effectiveVoice
    };
  }

  await report(`signature=${signature} voice=${cfg.voice}`);

  const sourceVideoPath = await materializeFinalVideo(session.finalVideoUrl, session.id, signature);
  const videoDurationSec = await probeMediaDurationSec(sourceVideoPath);
  await report(`video duration ${videoDurationSec.toFixed(2)}s`);

  const lines = splitScriptIntoLines(input.script);
  if (!lines.length) throw new Error("脚本为空或全是标点。");
  await report(`split script into ${lines.length} lines`);

  const lineDescriptors: NarrationLineDescriptor[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const text = lines[index];
    const audioPath = path.join(MEDIA_DIR, `narr-${session.id}-${signature}-line-${pad3(index + 1)}.mp3`);
    if (!(await fileExists(audioPath))) {
      await report(`tts ${index + 1}/${lines.length}: ${truncatePreview(text)}`);
      try {
        const audio = await synthesizeViaDoubao(text, cfg.voice);
        await writeFile(audioPath, audio);
      } catch (err) {
        await report(`tts ${index + 1} failed (${(err as Error).message}); inserting silence`);
        await writeSilentMp3(audioPath, estimateSilenceSecFor(text));
      }
    } else {
      await report(`tts ${index + 1}/${lines.length}: reuse cached`);
    }
    const rawDurationSec = await probeMediaDurationSec(audioPath).catch(() => 0);
    lineDescriptors.push({ index, text, audioPath, rawDurationSec });
  }

  const timeline = assembleNarrationTimeline(
    lineDescriptors.map((line) => ({ text: line.text, audioPath: line.audioPath, rawDurationSec: line.rawDurationSec })),
    videoDurationSec
  );
  await report(
    `timeline: narration=${timeline.narrationDurationSec.toFixed(2)}s / video=${timeline.videoDurationSec.toFixed(2)}s tempo=${timeline.globalTempo.toFixed(3)} kept=${timeline.segments.length} dropped=${timeline.droppedLineCount}`
  );
  if (timeline.warning) await report(timeline.warning);

  const srt = buildSrt(timeline.segments);
  await writeFile(outputSrtPath, srt, "utf8");
  await report(`srt written -> ${outputSrtName}`);

  await renderFinalNarratedVideo({
    sourceVideoPath,
    timeline,
    srtPath: outputSrtPath,
    outputPath: outputVideoPath,
    report
  });

  return {
    narrationVideoUrl: `/media/${outputVideoName}`,
    narrationSubtitleUrl: `/media/${outputSrtName}`,
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
  srtPath: string;
  outputPath: string;
  report: (phase: string) => Promise<void>;
}) {
  const { sourceVideoPath, timeline, srtPath, outputPath, report } = opts;
  const hasAudio = await probeHasAudio(sourceVideoPath);
  const ambientDb = parseNumberEnv(process.env.NARRATION_AMBIENT_DB, DEFAULT_AMBIENT_DB);
  const ambientGain = Math.pow(10, ambientDb / 20); // -12 dB -> ~0.25

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
    filterParts.push(`[${inputIdx}:a]aformat=channel_layouts=stereo,volume=1.0${tempoFilter}${delayFilter}[${label}]`);
    narrationLabels.push(`[${label}]`);
  });

  // Mix narration lines into a single [narrmix] track (or silence when zero lines).
  if (narrationLabels.length === 0) {
    filterParts.push(`anullsrc=channel_layout=stereo:sample_rate=44100[narrmix]`);
  } else if (narrationLabels.length === 1) {
    filterParts.push(`${narrationLabels[0]}anull[narrmix]`);
  } else {
    filterParts.push(`${narrationLabels.join("")}amix=inputs=${narrationLabels.length}:duration=longest:normalize=0[narrmix]`);
  }

  // Ambient track: from input 0 if present, otherwise the silent stereo source.
  const ambientSourceLabel = hasAudio ? "[0:a]" : `[${silenceInputIndex}:a]`;
  filterParts.push(`${ambientSourceLabel}aformat=channel_layouts=stereo,volume=${ambientGain.toFixed(3)}[ambient]`);
  filterParts.push(`[ambient][narrmix]amix=inputs=2:duration=longest:normalize=0[aout]`);

  // Video chain: burn subtitles. The font MUST be referenced by PostScript name AND `fontsdir`
  // must point at a directory containing a TTF/TTC whose name matches, otherwise libass (no
  // fontconfig in our ffmpeg build) silently falls back to Helvetica and CJK glyphs render as ⬛.
  const subtitleFont = process.env.NARRATION_SUBTITLE_FONT?.trim() || SUBTITLE_FONT_DEFAULT;
  const subtitleFontsdir = process.env.NARRATION_SUBTITLE_FONTSDIR?.trim() || SUBTITLE_FONTSDIR_DEFAULT;
  const safeSrtPath = escapeFfmpegFilterArg(srtPath);
  const safeFontsdir = escapeFfmpegFilterArg(subtitleFontsdir);
  // Subtitle style — minimal, no backdrop, hugs the very bottom of the frame:
  //  - BorderStyle=1: outline ONLY, NO opaque box behind text. Pixels outside glyph+outline are
  //    100% transparent so the picture remains fully visible.
  //  - Outline=1 + Shadow=0: a thin black rim is enough to read white text on bright skies/grass
  //    without making the glyphs look like they sit on a black slab.
  //  - Alignment=2 (bottom-center) + MarginV=12: pinned to ~5% from the bottom edge so subtitles
  //    sit in the letterbox / sky / floor region instead of the subject's face.
  //  - FontSize=12 is interpreted relative to libass's default PlayResY (288) → ~53px glyph height
  //    at 720x1280, so a 2-line cue takes ~110px ≈ 9% of frame height.
  const forceStyle = `FontName=${subtitleFont},FontSize=12,BorderStyle=1,Outline=1,Shadow=0,Alignment=2,MarginV=12,MarginL=40,MarginR=40,PrimaryColour=&H00FFFFFF&,OutlineColour=&H00000000&,BackColour=&H00000000&`;
  filterParts.push(`[0:v]subtitles=${safeSrtPath}:fontsdir=${safeFontsdir}:force_style='${forceStyle}'[vout]`);

  ffmpegArgs.push("-filter_complex", filterParts.join(";"));
  ffmpegArgs.push("-map", "[vout]", "-map", "[aout]");
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

  await report(`ffmpeg narration mix -> ${path.basename(outputPath)}`);
  const start = Date.now();
  try {
    await runFfmpegCommand(ffmpegArgs, 8192);
  } catch (err) {
    // Clean up so the next attempt does not reuse a half-written file.
    await unlink(outputPath).catch(() => undefined);
    const message = err instanceof Error ? err.message : String(err);
    if (/libass|subtitles/i.test(message) && /not found|No such filter|fontconfig/i.test(message)) {
      throw new Error(
        `ffmpeg 缺少 libass / 中文字体支持；硬烧字幕失败。请确认 ffmpeg 编译时启用了 libass，且系统有 PingFang SC 字体。原始错误：\n${message}`
      );
    }
    throw err;
  }
  await report(`ffmpeg narration mix done in ${((Date.now() - start) / 1000).toFixed(1)}s`);
}

/**
 * The ffmpeg subtitles filter parses ':' / ',' / '\\' inside its arg. On macOS absolute paths
 * never contain ':' so this is a thin escape that mainly guards against single quotes in the
 * media directory path.
 */
function escapeFfmpegFilterArg(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
}
