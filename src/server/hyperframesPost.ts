import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { MEDIA_DIR, localMediaPathFromMediaUrl, probeMediaDurationSec, probeVideoDimensions, runFfmpegCommand } from "./generators";
import type { PostProductionAudioMode, PostProductionSubtitleMode } from "../shared/types";

const HYPERFRAMES_SIGNATURE_VERSION = "hyperframes-post-v4-lowmem-subtitles";
const DEFAULT_HYPERFRAMES_VERSION = "0.6.97";
const DEFAULT_FFMPEG_SUBTITLE_PRESET = "veryfast";
const DEFAULT_FFMPEG_SUBTITLE_CRF = "20";
const DEFAULT_SUBTITLE_FONT = "Arial Unicode MS";
const DEFAULT_SUBTITLE_FONTSDIR = "/System/Library/Fonts/Supplemental";

export type PostProductionRenderer = "hyperframes" | "ffmpeg-subtitles";

export interface HyperframesPostProductionSignatureInput {
  finalVideoSignature: string;
  title?: string;
  subtitle?: string;
  coverAssetId?: string;
  coverImageUrl?: string;
  subtitleText?: string;
  subtitleMode?: PostProductionSubtitleMode;
  audioMode?: PostProductionAudioMode;
  voice?: string;
  voiceAssetId?: string;
  voiceoverScript?: string;
  musicPrompt?: string;
  musicLyrics?: string;
  musicKind?: string;
  musicDurationSec?: number;
  sourceVolume?: number;
  audioVolume?: number;
}

export interface PostProductionSubtitleCue {
  startSec: number;
  endSec: number;
  text: string;
}

export interface BuildHyperframesIndexInput {
  compositionId: string;
  width: number;
  height: number;
  outputDurationSec: number;
  videoStartSec: number;
  videoDurationSec: number;
  sourceVideoFile: string;
  coverImageFile?: string;
  title?: string;
  subtitle?: string;
  subtitleCues?: PostProductionSubtitleCue[];
}

export interface HyperframesProjectInput extends BuildHyperframesIndexInput {
  projectDir: string;
  outputPath: string;
}

export interface HyperframesRenderInput {
  sessionId: string;
  signature: string;
  sourceVideoPath: string;
  coverImagePath?: string;
  title?: string;
  subtitle?: string;
  subtitleText?: string;
  subtitleMode?: PostProductionSubtitleMode;
  onProgress?: (phase: string) => Promise<void> | void;
}

export interface HyperframesRenderResult {
  videoUrl: string;
  signature: string;
  builtForFinalVideoSignature: string;
  projectDir: string;
  outputPath: string;
  renderer?: PostProductionRenderer;
}

export function computeHyperframesPostProductionSignature(input: HyperframesPostProductionSignatureInput) {
  const stable = {
    version: HYPERFRAMES_SIGNATURE_VERSION,
    finalVideoSignature: input.finalVideoSignature,
    title: input.title?.trim() || "",
    subtitle: input.subtitle?.trim() || "",
    coverAssetId: input.coverAssetId || "",
    coverImageUrl: input.coverImageUrl || "",
    subtitleMode: input.subtitleMode || "none",
    subtitleText: input.subtitleText?.trim() || "",
    audioMode: input.audioMode || "source",
    voice: input.voice || "",
    voiceAssetId: input.voiceAssetId || "",
    voiceoverScript: input.voiceoverScript?.trim() || "",
    musicPrompt: input.musicPrompt?.trim() || "",
    musicLyrics: input.musicLyrics?.trim() || "",
    musicKind: input.musicKind || "",
    musicDurationSec: input.musicDurationSec || 0,
    sourceVolume: Number(input.sourceVolume ?? 1),
    audioVolume: Number(input.audioVolume ?? 1)
  };
  return createHash("sha1").update(JSON.stringify(stable)).digest("hex").slice(0, 20);
}

export function parsePostProductionSubtitleCues(
  text: string | undefined,
  opts: { videoDurationSec: number; videoStartSec: number }
): PostProductionSubtitleCue[] {
  const raw = (text || "").trim();
  if (!raw) return [];
  const srtCues = parseSrtCues(raw, opts.videoStartSec);
  if (srtCues.length) {
    return clampCues(
      srtCues.flatMap(splitTimedTextSegment),
      opts.videoStartSec,
      opts.videoStartSec + opts.videoDurationSec
    );
  }

  const lines = raw
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return [];
  const usableDuration = Math.max(1, opts.videoDurationSec);
  const slot = usableDuration / lines.length;
  return lines.map((line, index) => {
    const startSec = opts.videoStartSec + index * slot;
    const endSec = Math.min(opts.videoStartSec + usableDuration, startSec + Math.max(1.4, Math.min(3.2, slot * 0.86)));
    return { startSec: roundSec(startSec), endSec: roundSec(endSec), text: line };
  });
}

export function selectPostProductionRenderer(
  input: Pick<HyperframesRenderInput, "title" | "subtitle" | "coverImagePath" | "subtitleMode" | "subtitleText">
): PostProductionRenderer {
  const configured = (process.env.POST_PRODUCTION_RENDERER || "auto").trim().toLowerCase();
  if (configured === "hyperframes") return "hyperframes";
  const hasPackagingVisuals = Boolean(input.coverImagePath || input.title?.trim() || input.subtitle?.trim());
  const hasManualSubtitles = input.subtitleMode === "manual" && Boolean(input.subtitleText?.trim());
  if (configured === "ffmpeg-subtitles") {
    if (hasManualSubtitles && !hasPackagingVisuals) return "ffmpeg-subtitles";
    return "hyperframes";
  }
  if (hasManualSubtitles && !hasPackagingVisuals) return "ffmpeg-subtitles";
  return "hyperframes";
}

export function buildFfmpegSubtitleAss(
  cues: PostProductionSubtitleCue[],
  opts: { width: number; height: number; fontName?: string }
) {
  const width = Math.max(320, Math.round(opts.width || 720));
  const height = Math.max(240, Math.round(opts.height || 1280));
  const fontSize = Math.max(28, Math.round(height * 0.042));
  const marginV = Math.max(48, Math.round(height * 0.085));
  const outline = Math.max(2, Math.round(height * 0.0025));
  const shadow = Math.max(1, Math.round(height * 0.0016));
  const fontName = opts.fontName?.trim() || process.env.POST_PRODUCTION_SUBTITLE_FONT || DEFAULT_SUBTITLE_FONT;
  const maxLineChars = subtitleMaxLineChars(width, fontSize);
  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Default,${fontName},${fontSize},&H00FFFFFF,&H000000FF,&HAA000000,&H66000000,0,0,0,0,100,100,0,0,1,${outline},${shadow},2,48,48,${marginV},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text"
  ];
  const events = cues.map((cue) => (
    `Dialogue: 0,${formatAssTime(cue.startSec)},${formatAssTime(cue.endSec)},Default,,0,0,0,,${escapeAssText(wrapSubtitleTextForAss(cue.text, maxLineChars))}`
  ));
  return [...header, ...events, ""].join("\n");
}

export function buildHyperframesIndexHtml(input: BuildHyperframesIndexInput) {
  const cues = input.subtitleCues || [];
  const title = input.title?.trim() || "";
  const subtitle = input.subtitle?.trim() || "";
  const coverDuration = Math.max(0, input.videoStartSec);
  const escapedCompositionId = escapeAttr(input.compositionId);
  const css = buildCss(input.width, input.height);
  const cover = input.coverImageFile
    ? `<img class="cover-media clip" data-start="0" data-duration="${formatSec(coverDuration || 1.2)}" data-track-index="2" src="${escapeAttr(input.coverImageFile)}" />`
    : "";
  const coverFallback = input.coverImageFile ? "" : `<div class="cover-fallback clip" data-start="0" data-duration="${formatSec(coverDuration || 1.2)}" data-track-index="2"></div>`;
  const titleCard = title || subtitle
    ? `<div class="title-card clip" data-start="0" data-duration="${formatSec(Math.max(coverDuration, 1.2))}" data-track-index="3">
        ${title ? `<h1>${escapeHtml(title)}</h1>` : ""}
        ${subtitle ? `<p>${escapeHtml(subtitle)}</p>` : ""}
      </div>`
    : "";
  const subtitleClips = cues.map((cue, index) => (
    `<div class="subtitle-cue clip" data-start="${formatSec(cue.startSec)}" data-duration="${formatSec(Math.max(0.2, cue.endSec - cue.startSec))}" data-track-index="${10 + index}">${escapeHtml(cue.text)}</div>`
  )).join("\n");

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${input.width}, height=${input.height}" />
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
    <style>${css}</style>
  </head>
  <body>
    <div
      id="root"
      data-composition-id="${escapedCompositionId}"
      data-start="0"
      data-duration="${formatSec(input.outputDurationSec)}"
      data-width="${input.width}"
      data-height="${input.height}"
    >
      ${cover}
      ${coverFallback}
      ${titleCard}
      <video class="base-video clip" data-start="${formatSec(input.videoStartSec)}" data-duration="${formatSec(input.videoDurationSec)}" data-track-index="1" src="${escapeAttr(input.sourceVideoFile)}" playsinline preload="auto"></video>
      ${subtitleClips}
    </div>
    <script>
      window.__timelines = window.__timelines || {};
      const tl = gsap.timeline({ paused: true });
      tl.from(".title-card h1", { opacity: 0, y: 26, duration: 0.55, ease: "power2.out" }, 0.08);
      tl.from(".title-card p", { opacity: 0, y: 18, duration: 0.45, ease: "power2.out" }, 0.22);
      tl.to(".title-card", { opacity: 0, duration: 0.32, ease: "power2.in" }, ${JSON.stringify(Math.max(0.5, coverDuration - 0.35))});
      window.__timelines["${escapedCompositionId}"] = tl;
    </script>
  </body>
</html>`;
}

export function buildAutoSubtitleSrtFromScript(
  script: string | undefined,
  opts: { videoDurationSec: number; videoStartSec?: number }
) {
  const lines = splitSubtitleScript(script);
  if (!lines.length) return "";
  const startOffset = Math.max(0, opts.videoStartSec || 0);
  const duration = Math.max(0.5, opts.videoDurationSec);
  const slot = duration / lines.length;
  return lines.map((text, index) => {
    const startSec = startOffset + index * slot;
    const endSec = index === lines.length - 1 ? startOffset + duration : startOffset + (index + 1) * slot;
    return `${index + 1}\n${formatSrtTime(startSec)} --> ${formatSrtTime(endSec)}\n${text}\n`;
  }).join("\n");
}

export function normalizeHyperframesTranscriptToSrt(transcript: unknown) {
  const parsed = typeof transcript === "string" ? safeJsonParse(transcript) : transcript;
  const segments = extractTranscriptSegments(parsed);
  return segments
    .filter((segment) => Number.isFinite(segment.startSec) && Number.isFinite(segment.endSec) && segment.endSec > segment.startSec && segment.text.trim())
    .map((segment, index) => `${index + 1}\n${formatSrtTime(segment.startSec)} --> ${formatSrtTime(segment.endSec)}\n${segment.text.trim()}\n`)
    .join("\n");
}

export async function normalizeHyperframesTranscribeResultToSrt(transcript: unknown) {
  const parsed = typeof transcript === "string" ? safeJsonParse(transcript) : transcript;
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const transcriptPath = (parsed as { transcriptPath?: unknown }).transcriptPath;
    if (typeof transcriptPath === "string" && transcriptPath.trim()) {
      const file = await readFile(transcriptPath, "utf8");
      return normalizeHyperframesTranscriptToSrt(file);
    }
  }
  return normalizeHyperframesTranscriptToSrt(parsed);
}

export async function transcribeMediaToSrtWithHyperframes(
  mediaPath: string,
  opts: { language?: string; model?: string; projectDir?: string } = {}
) {
  const transcript = await runHyperframesTranscribe(mediaPath, opts);
  const srt = await normalizeHyperframesTranscribeResultToSrt(transcript);
  if (!srt.trim()) throw new Error("HyperFrames transcribe did not return timed subtitle segments.");
  return srt;
}

export async function renderHyperframesPostProduction(
  input: HyperframesRenderInput & { finalVideoSignature: string }
): Promise<HyperframesRenderResult> {
  const report = async (phase: string) => {
    try {
      await input.onProgress?.(phase);
    } catch {
      /* progress is best effort */
    }
  };
  await mkdir(MEDIA_DIR, { recursive: true });
  const renderer = selectPostProductionRenderer(input);
  if (renderer === "ffmpeg-subtitles") {
    return renderFfmpegSubtitlePostProduction(input);
  }
  const projectDir = path.join(process.cwd(), "data", "hyperframes", `${safeName(input.sessionId)}-${input.signature}`);
  const assetDir = path.join(projectDir, "assets");
  const outputName = `final-${safeName(input.sessionId)}-hyperframes-${input.signature}.mp4`;
  const outputPath = path.join(MEDIA_DIR, outputName);
  const hyperframesOutputPath = process.env.HYPERFRAMES_DOWNSCALE_1080P === "0"
    ? outputPath
    : path.join(MEDIA_DIR, `final-${safeName(input.sessionId)}-hyperframes-${input.signature}-raw.mp4`);
  if (await fileExists(outputPath)) {
    await report(`reused cached HyperFrames render (${input.signature})`);
    return {
      videoUrl: `/media/${outputName}`,
      signature: input.signature,
      builtForFinalVideoSignature: input.finalVideoSignature,
      projectDir,
      outputPath,
      renderer: "hyperframes"
    };
  }

  await report("hyperframes project");
  await mkdir(assetDir, { recursive: true });
  const sourceExt = extForPath(input.sourceVideoPath, ".mp4");
  const sourceAssetPath = path.join(assetDir, `base${sourceExt}`);
  await copyFile(input.sourceVideoPath, sourceAssetPath);
  let coverFile: string | undefined;
  if (input.coverImagePath) {
    const coverExt = extForPath(input.coverImagePath, ".jpg");
    const coverAssetPath = path.join(assetDir, `cover${coverExt}`);
    await copyFile(input.coverImagePath, coverAssetPath);
    coverFile = `assets/${path.basename(coverAssetPath)}`;
  }
  const videoDurationSec = await probeMediaDurationSec(sourceAssetPath);
  const videoStartSec = input.coverImagePath || input.title || input.subtitle ? 1.5 : 0;
  const outputDurationSec = videoStartSec + videoDurationSec;
  const cues = input.subtitleMode === "manual"
    ? parsePostProductionSubtitleCues(input.subtitleText, { videoDurationSec, videoStartSec })
    : [];

  await writeProjectFiles({
    projectDir,
    outputPath: hyperframesOutputPath,
    compositionId: "seereel-post",
    width: 1920,
    height: 1080,
    outputDurationSec,
    videoStartSec,
    videoDurationSec,
    sourceVideoFile: `assets/${path.basename(sourceAssetPath)}`,
    coverImageFile: coverFile,
    title: input.title,
    subtitle: input.subtitle,
    subtitleCues: cues
  });
  await report("hyperframes render");
  await runHyperframesRender(projectDir, hyperframesOutputPath);
  if (hyperframesOutputPath !== outputPath) {
    await report("ffmpeg downscale 1080p");
    await downscaleHyperframesOutput(hyperframesOutputPath, outputPath);
  }
  await report("hyperframes render complete");
  return {
    videoUrl: `/media/${outputName}`,
    signature: input.signature,
    builtForFinalVideoSignature: input.finalVideoSignature,
    projectDir,
    outputPath,
    renderer: "hyperframes"
  };
}

async function renderFfmpegSubtitlePostProduction(
  input: HyperframesRenderInput & { finalVideoSignature: string }
): Promise<HyperframesRenderResult> {
  const report = async (phase: string) => {
    try {
      await input.onProgress?.(phase);
    } catch {
      /* progress is best effort */
    }
  };
  await mkdir(MEDIA_DIR, { recursive: true });
  const projectDir = path.join(process.cwd(), "data", "post-production", `${safeName(input.sessionId)}-${input.signature}`);
  const outputName = `final-${safeName(input.sessionId)}-subtitles-${input.signature}.mp4`;
  const outputPath = path.join(MEDIA_DIR, outputName);
  if (await fileExists(outputPath)) {
    await report(`reused cached ffmpeg subtitle render (${input.signature})`);
    return {
      videoUrl: `/media/${outputName}`,
      signature: input.signature,
      builtForFinalVideoSignature: input.finalVideoSignature,
      projectDir,
      outputPath,
      renderer: "ffmpeg-subtitles"
    };
  }

  await report("ffmpeg subtitle project");
  await mkdir(projectDir, { recursive: true });
  const videoDurationSec = await probeMediaDurationSec(input.sourceVideoPath);
  const dimensions = await probeVideoDimensions(input.sourceVideoPath).catch(() => ({ width: 720, height: 1280 }));
  const cues = parsePostProductionSubtitleCues(input.subtitleText, {
    videoDurationSec,
    videoStartSec: 0
  });
  if (!cues.length) throw new Error("No timed subtitles available for ffmpeg subtitle render.");
  const assPath = path.join(projectDir, "subtitles.ass");
  await writeFile(assPath, buildFfmpegSubtitleAss(cues, dimensions), "utf8");
  const tempOutputPath = `${outputPath}.partial-${process.pid}.mp4`;
  await unlink(tempOutputPath).catch(() => undefined);
  await report("ffmpeg subtitle burn");
  try {
    await runFfmpegCommand([
      "-y",
      "-i", input.sourceVideoPath,
      "-vf", buildAssVideoFilter(assPath),
      "-map", "0:v:0",
      "-map", "0:a?",
      "-c:v", "libx264",
      "-preset", process.env.POST_PRODUCTION_FFMPEG_PRESET || DEFAULT_FFMPEG_SUBTITLE_PRESET,
      "-crf", process.env.POST_PRODUCTION_FFMPEG_CRF || DEFAULT_FFMPEG_SUBTITLE_CRF,
      "-pix_fmt", "yuv420p",
      "-c:a", "copy",
      tempOutputPath
    ], 8192);
    await rename(tempOutputPath, outputPath);
  } catch (error) {
    await unlink(tempOutputPath).catch(() => undefined);
    throw error;
  }
  await report("ffmpeg subtitle render complete");
  return {
    videoUrl: `/media/${outputName}`,
    signature: input.signature,
    builtForFinalVideoSignature: input.finalVideoSignature,
    projectDir,
    outputPath,
    renderer: "ffmpeg-subtitles"
  };
}

async function downscaleHyperframesOutput(inputPath: string, outputPath: string) {
  await runFfmpegCommand([
    "-y",
    "-i", inputPath,
    "-vf", "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "20",
    "-c:a", "aac",
    "-b:a", "160k",
    "-movflags", "+faststart",
    outputPath
  ]);
}

export async function materializePostProductionMedia(url: string, scopeId: string, signature: string, fallbackExt = ".bin") {
  const local = localMediaPathFromMediaUrl(url);
  if (local) return local;
  if (url.startsWith("file://")) return new URL(url).pathname;
  if (!url.startsWith("http")) return url;
  await mkdir(MEDIA_DIR, { recursive: true });
  const ext = extForPath(new URL(url).pathname, fallbackExt);
  const cachePath = path.join(MEDIA_DIR, `hyperframes-source-${safeName(scopeId)}-${signature}${ext}`);
  if (await fileExists(cachePath)) return cachePath;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download media for HyperFrames failed: ${response.status} ${response.statusText}`);
  await writeFile(cachePath, Buffer.from(await response.arrayBuffer()));
  return cachePath;
}

async function writeProjectFiles(input: HyperframesProjectInput) {
  await writeFile(path.join(input.projectDir, "index.html"), buildHyperframesIndexHtml(input));
  await writeFile(path.join(input.projectDir, "meta.json"), JSON.stringify({
    id: "seereel-post",
    name: "SeeReel Post Production",
    createdAt: new Date().toISOString()
  }, null, 2));
  await writeFile(path.join(input.projectDir, "hyperframes.json"), JSON.stringify({
    $schema: "https://hyperframes.heygen.com/schema/hyperframes.json",
    registry: "https://raw.githubusercontent.com/heygen-com/hyperframes/main/registry",
    paths: { blocks: "compositions", components: "compositions/components", assets: "assets" }
  }, null, 2));
  await writeFile(path.join(input.projectDir, "package.json"), JSON.stringify({
    name: "seereel-hyperframes-post",
    private: true,
    type: "module"
  }, null, 2));
}

async function runHyperframesRender(projectDir: string, outputPath: string) {
  const command = process.env.HYPERFRAMES_COMMAND?.trim();
  const args = command
    ? splitCommand(command)
    : ["npx", "--yes", `hyperframes@${process.env.HYPERFRAMES_VERSION || DEFAULT_HYPERFRAMES_VERSION}`];
  const [bin, ...baseArgs] = args;
  const renderArgs = [
    ...baseArgs,
    "render",
    projectDir,
    "--output",
    outputPath,
    "--quality",
    process.env.HYPERFRAMES_QUALITY || "standard",
    "--resolution",
    process.env.HYPERFRAMES_RESOLUTION || "landscape"
  ];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(bin, renderArgs, {
      cwd: projectDir,
      env: { ...process.env, npm_config_yes: "true" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let tail = "";
    const collect = (chunk: Buffer) => {
      tail = `${tail}${chunk.toString("utf8")}`.slice(-12_000);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`HyperFrames render failed with exit code ${code}. ${tail.trim()}`));
    });
  });
}

async function runHyperframesTranscribe(
  mediaPath: string,
  opts: { language?: string; model?: string; projectDir?: string } = {}
) {
  const command = process.env.HYPERFRAMES_COMMAND?.trim();
  const args = command
    ? splitCommand(command)
    : ["npx", "--yes", `hyperframes@${process.env.HYPERFRAMES_VERSION || DEFAULT_HYPERFRAMES_VERSION}`];
  const [bin, ...baseArgs] = args;
  const projectDir = opts.projectDir || process.cwd();
  const transcribeArgs = [...baseArgs, "transcribe", mediaPath, "--json", "--dir", projectDir];
  const model = opts.model || process.env.HYPERFRAMES_TRANSCRIBE_MODEL;
  if (model) transcribeArgs.push("--model", model);
  if (opts.language) transcribeArgs.push("--language", opts.language);
  return await new Promise<unknown>((resolve, reject) => {
    const child = spawn(bin, transcribeArgs, {
      cwd: projectDir,
      env: { ...process.env, npm_config_yes: "true" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-12_000); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`HyperFrames transcribe failed with exit code ${code}. ${stderr.trim()}`));
        return;
      }
      try {
        resolve(parseJsonFromCliOutput(stdout));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function parseSrtCues(raw: string, videoStartSec: number): PostProductionSubtitleCue[] {
  const blocks = raw.split(/\r?\n\s*\r?\n/);
  const cues: PostProductionSubtitleCue[] = [];
  for (const block of blocks) {
    const lines = block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const timeIndex = lines.findIndex((line) => /-->/i.test(line));
    if (timeIndex < 0) continue;
    const match = lines[timeIndex].match(/(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}|\d{1,2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}|\d{1,2}:\d{2}[,.]\d{1,3})/);
    if (!match) continue;
    const text = lines.slice(timeIndex + 1).join("\n").trim();
    if (!text) continue;
    cues.push({
      startSec: roundSec(parseTimecode(match[1]) + videoStartSec),
      endSec: roundSec(parseTimecode(match[2]) + videoStartSec),
      text
    });
  }
  return cues;
}

function splitSubtitleScript(script: string | undefined) {
  const raw = (script || "").trim();
  if (!raw) return [];
  const lines = raw
    .split(/\r?\n+/)
    .flatMap((line) => line.match(/[^。！？!?；;]+[。！？!?；;]?/g) || [line])
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length ? lines : [raw];
}

function extractTranscriptSegments(input: unknown): PostProductionSubtitleCue[] {
  if (!input || typeof input !== "object") return [];
  if (Array.isArray(input)) return input.flatMap(extractTranscriptSegment);
  const obj = input as Record<string, unknown>;
  for (const key of ["segments", "chunks", "utterances", "results"]) {
    const value = obj[key];
    if (Array.isArray(value)) return value.flatMap(extractTranscriptSegment);
  }
  if (obj.transcript) return extractTranscriptSegments(obj.transcript);
  if (Array.isArray(obj.words)) return groupTranscriptWords(obj.words);
  return extractTranscriptSegment(obj);
}

function extractTranscriptSegment(input: unknown): PostProductionSubtitleCue[] {
  if (!input || typeof input !== "object") return [];
  const obj = input as Record<string, unknown>;
  const startSec = numericField(obj, ["startSec", "start", "from", "begin"]);
  const endSec = numericField(obj, ["endSec", "end", "to", "finish"]);
  const text = stringField(obj, ["text", "transcript", "sentence", "caption"]);
  if (Number.isFinite(startSec) && Number.isFinite(endSec) && text) {
    return splitTimedTextSegment({ startSec: roundSec(startSec), endSec: roundSec(endSec), text });
  }
  const timestamp = obj.timestamp || obj.timestamps;
  if (Array.isArray(timestamp) && timestamp.length >= 2 && text) {
    const start = Number(timestamp[0]);
    const end = Number(timestamp[1]);
    if (Number.isFinite(start) && Number.isFinite(end)) return splitTimedTextSegment({ startSec: roundSec(start), endSec: roundSec(end), text });
  }
  if (Array.isArray(obj.words)) return groupTranscriptWords(obj.words);
  return [];
}

function splitTimedTextSegment(segment: PostProductionSubtitleCue): PostProductionSubtitleCue[] {
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

function subtitleMaxLineChars(width: number, fontSize: number) {
  const safeWidth = Math.max(120, width - 96);
  const approxCjkCharWidth = fontSize * 0.88;
  return Math.max(8, Math.min(18, Math.floor(safeWidth / approxCjkCharWidth)));
}

function wrapSubtitleTextForAss(text: string, maxLineChars: number) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  const pieces = splitCaptionText(normalized, maxLineChars)
    .flatMap((piece) => {
      if (piece.length <= maxLineChars) return [piece];
      const chunks: string[] = [];
      for (let i = 0; i < piece.length; i += maxLineChars) chunks.push(piece.slice(i, i + maxLineChars));
      return chunks;
    })
    .map((piece) => piece.trim())
    .filter(Boolean);
  return mergeDanglingSubtitlePunctuation(pieces, maxLineChars).join("\n");
}

function mergeDanglingSubtitlePunctuation(lines: string[], maxLineChars: number) {
  const out: string[] = [];
  for (const line of lines) {
    if (/^[。！？!?，,；;、：:）)】》]+$/.test(line) && out.length) {
      const previous = out[out.length - 1];
      if (previous.length + line.length <= maxLineChars + 1) {
        out[out.length - 1] = `${previous}${line}`;
        continue;
      }
    }
    out.push(line);
  }
  return out;
}

function isCjkDominant(text: string) {
  const cjk = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
  return cjk >= 6 && cjk > text.length * 0.35;
}

function groupTranscriptWords(words: unknown[]) {
  const out: PostProductionSubtitleCue[] = [];
  let current: PostProductionSubtitleCue | undefined;
  for (const word of words) {
    const segment = extractTranscriptSegment(word)[0];
    if (!segment) continue;
    if (!current) {
      current = { ...segment };
      continue;
    }
    const wouldBeLong = current.text.length + segment.text.length > 38;
    const wouldExceedTime = segment.endSec - current.startSec > 4.5;
    if (wouldBeLong || wouldExceedTime) {
      out.push(current);
      current = { ...segment };
    } else {
      current.text = `${current.text}${isCjkBoundary(current.text, segment.text) ? "" : " "}${segment.text}`;
      current.endSec = segment.endSec;
    }
  }
  if (current) out.push(current);
  return out;
}

function numericField(obj: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = Number(obj[key]);
    if (Number.isFinite(value)) return value;
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

function isCjkBoundary(left: string, right: string) {
  return /[\u4e00-\u9fff]$/.test(left) || /^[\u4e00-\u9fff]/.test(right);
}

function parseJsonFromCliOutput(stdout: string) {
  const trimmed = stdout.trim();
  const direct = safeJsonParse(trimmed);
  if (direct) return direct;
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const parsed = safeJsonParse(trimmed.slice(firstBrace, lastBrace + 1));
    if (parsed) return parsed;
  }
  const firstBracket = trimmed.indexOf("[");
  const lastBracket = trimmed.lastIndexOf("]");
  if (firstBracket >= 0 && lastBracket > firstBracket) {
    const parsed = safeJsonParse(trimmed.slice(firstBracket, lastBracket + 1));
    if (parsed) return parsed;
  }
  throw new Error(`HyperFrames transcribe returned non-JSON output: ${trimmed.slice(0, 500)}`);
}

function safeJsonParse(value: string) {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function parseTimecode(value: string) {
  const normalized = value.replace(",", ".");
  const parts = normalized.split(":").map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return 0;
}

function clampCues(cues: PostProductionSubtitleCue[], minSec: number, maxSec: number) {
  return cues
    .map((cue) => ({
      ...cue,
      startSec: roundSec(Math.max(minSec, Math.min(maxSec, cue.startSec))),
      endSec: roundSec(Math.max(minSec, Math.min(maxSec, cue.endSec)))
    }))
    .filter((cue) => cue.endSec > cue.startSec && cue.text.trim());
}

function buildCss(width: number, height: number) {
  return `
      * { box-sizing: border-box; }
      html, body { margin: 0; width: ${width}px; height: ${height}px; overflow: hidden; background: #05080c; font-family: Inter, "SF Pro Display", "PingFang SC", "Microsoft YaHei", sans-serif; }
      #root { position: relative; width: ${width}px; height: ${height}px; overflow: hidden; background: #05080c; }
      .base-video, .cover-media, .cover-fallback { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
      .cover-fallback { background: radial-gradient(circle at 50% 35%, #1f2937, #05080c 66%); }
      .cover-media { filter: saturate(0.98) contrast(1.02); }
      .title-card { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 90px 140px; color: #fff; text-align: center; background: linear-gradient(180deg, rgba(0,0,0,0.25), rgba(0,0,0,0.58)); text-shadow: 0 8px 28px rgba(0,0,0,0.58); }
      .title-card h1 { margin: 0; max-width: 1500px; font-size: 92px; line-height: 1.08; font-weight: 760; letter-spacing: 0; }
      .title-card p { margin: 26px 0 0; max-width: 1200px; font-size: 36px; line-height: 1.3; font-weight: 520; color: rgba(255,255,255,0.88); }
      .subtitle-cue { position: absolute; left: 220px; right: 220px; bottom: 78px; padding: 18px 30px; border-radius: 8px; color: #fff; background: rgba(0,0,0,0.62); text-align: center; font-size: 42px; line-height: 1.32; font-weight: 680; text-shadow: 0 3px 10px rgba(0,0,0,0.65); white-space: pre-wrap; }
    `;
}

function splitCommand(command: string) {
  return command.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((part) => part.replace(/^"|"$/g, "")) || [];
}

function safeName(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || "session";
}

function extForPath(value: string, fallback: string) {
  const ext = path.extname(value.split("?")[0]).toLowerCase();
  return ext && ext.length <= 8 ? ext : fallback;
}

async function fileExists(filePath: string) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function formatSec(value: number) {
  return String(roundSec(value));
}

function roundSec(value: number) {
  return Math.round(value * 1000) / 1000;
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

function formatAssTime(sec: number) {
  const safe = Math.max(0, sec);
  const totalCentis = Math.round(safe * 100);
  const hours = Math.floor(totalCentis / 360_000);
  const minutes = Math.floor((totalCentis % 360_000) / 6_000);
  const seconds = Math.floor((totalCentis % 6_000) / 100);
  const centis = totalCentis % 100;
  return `${hours}:${pad2(minutes)}:${pad2(seconds)}.${pad2(centis)}`;
}

function escapeAssText(value: string) {
  return value
    .replace(/\r?\n/g, "\\N")
    .replace(/[{}]/g, "")
    .trim();
}

function escapeFfmpegFilterArg(value: string) {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'");
}

function buildAssVideoFilter(assPath: string) {
  const fontsDir = process.env.POST_PRODUCTION_SUBTITLE_FONTSDIR || DEFAULT_SUBTITLE_FONTSDIR;
  const fontsDirSuffix = fontsDir.trim() ? `:fontsdir='${escapeFfmpegFilterArg(fontsDir)}'` : "";
  return `ass='${escapeFfmpegFilterArg(assPath)}'${fontsDirSuffix}`;
}

const pad2 = (n: number) => String(n).padStart(2, "0");
const pad3 = (n: number) => String(n).padStart(3, "0");

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(value: string) {
  return escapeHtml(value).replace(/`/g, "&#96;");
}
