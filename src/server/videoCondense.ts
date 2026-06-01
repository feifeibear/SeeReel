import { spawn } from "node:child_process";
import { mkdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";

/**
 * Condense a long / oversized reference video to fit Seedance r2v's two hard limits:
 *
 *   - duration ≤ 15.2 seconds
 *   - frame pixel count ≥ 409,600 (≈ 720×570) — frames smaller than that are rejected
 *
 * Three strategies, each preserving different aspects of the source:
 *
 *   - "sample-concat" (default): split source into 4 evenly-spaced 3-second windows, scale each to
 *     960×720 letterbox, concat. Keeps authentic motion / lighting at each sample point at the cost
 *     of N hard cuts. Best when the source has multiple distinct beats and you want all sampled.
 *   - "trim": take the first 15s of the source, scale to 960×720. Bit-faithful motion timing for
 *     that segment, but the rest of the source is dropped. Best when the opening already covers
 *     the look/motion you want R2V to copy.
 *   - "speedup": atempo + setpts the whole source so it lands at ≤15s, scale to 960×720. Every
 *     frame is preserved, but motion plays at duration/15× — R2V will copy that accelerated pace.
 *     Best when full-arc coverage matters more than natural motion timing.
 *
 * For sources that already fit the limits we no-op and return the original path regardless of
 * strategy.
 *
 * The condensed file is written next to the original under data/media/. The caller is expected to
 * publish the condensed file to TOS (so Seedance can fetch it) while keeping the ORIGINAL file
 * around for downstream analyze-video / poster generation — that pipeline benefits from the full
 * source, not the condensed reel.
 */

const MAX_DURATION_SEC = 15;
const MIN_PIXELS = 409600;
const TARGET_W = 960;
const TARGET_H = 720;
const SAMPLE_COUNT = 4;
const SAMPLE_LEN_SEC = 3;

export interface ProbeInfo {
  durationSec: number;
  width: number;
  height: number;
}

export interface CondenseResult {
  /** Path of the file the caller should publish to TOS (original if no condensing needed). */
  publishPath: string;
  /** Whether ffmpeg actually ran and produced a new file (vs. caller falling through to source). */
  condensed: boolean;
  /** Which strategy was actually applied (defaults to "sample-concat"; "none" when no-op). */
  strategy: CondenseStrategy | "none";
  /** Probe of the original source. */
  source: ProbeInfo;
  /** Probe of the publish file (== source when condensed=false). */
  publish: ProbeInfo;
  /** Human-readable note describing what happened, for logging / UI surfacing. */
  note: string;
}

export type CondenseStrategy = "sample-concat" | "trim" | "speedup";

export interface CondenseOptions {
  /** Which condensing strategy to use; defaults to "sample-concat" for backward compat. */
  strategy?: CondenseStrategy;
}

const FFMPEG_BIN = ffmpegInstaller.path;
// @ffmpeg-installer ships ffmpeg but not ffprobe. We rely on ffmpeg's own `-i` parsing for probe.

export async function probeVideo(filePath: string): Promise<ProbeInfo> {
  const info = await stat(filePath);
  if (!info.isFile() || info.size <= 0) throw new Error(`probeVideo: not a regular file: ${filePath}`);
  // Use ffmpeg with `-i` and parse stderr — works even though ffprobe isn't bundled.
  const stderr = await runFfmpegCapture(["-hide_banner", "-i", filePath]);
  const durationMatch = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const videoLineMatch = stderr.match(/^\s*Stream [^\n]*Video:[^\n]*$/m);
  const videoLine = videoLineMatch ? videoLineMatch[0] : "";
  const dimensionMatches = Array.from(videoLine.matchAll(/(\d{3,5})x(\d{3,5})/g));
  const dimMatch = dimensionMatches.length ? dimensionMatches[dimensionMatches.length - 1] : null;
  const durationSec = durationMatch
    ? Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3])
    : 0;
  const width = dimMatch ? Number(dimMatch[1]) : 0;
  const height = dimMatch ? Number(dimMatch[2]) : 0;
  if (!durationSec || !width || !height) {
    throw new Error(`probeVideo: failed to parse ffmpeg -i output (dur=${durationSec}, ${width}x${height})`);
  }
  return { durationSec, width, height };
}

export async function condenseForSeedanceR2V(
  localFilePath: string,
  opts: CondenseOptions = {}
): Promise<CondenseResult> {
  const strategy: CondenseStrategy = opts.strategy || "sample-concat";
  const source = await probeVideo(localFilePath);
  const pixelsOk = source.width * source.height >= MIN_PIXELS;
  const durationOk = source.durationSec <= MAX_DURATION_SEC;
  if (pixelsOk && durationOk) {
    return {
      publishPath: localFilePath,
      condensed: false,
      strategy: "none",
      source,
      publish: source,
      note: `源视频满足 Seedance r2v 限制（${source.durationSec.toFixed(1)}s, ${source.width}x${source.height}），无需处理。`
    };
  }

  const dir = path.dirname(localFilePath);
  const ext = path.extname(localFilePath) || ".mp4";
  const stem = path.basename(localFilePath, ext);
  // Per-strategy output filename so reclip across strategies doesn't clobber prior runs that may
  // still be referenced by other shots.
  const outPath = path.join(dir, `${stem}-${strategy}${ext}`);

  await mkdir(dir, { recursive: true });
  try { await unlink(outPath); } catch {}

  if (strategy === "trim") {
    await runTrimStrategy(localFilePath, outPath);
  } else if (strategy === "speedup") {
    await runSpeedupStrategy(localFilePath, outPath, source.durationSec);
  } else {
    await runSampleConcatStrategy(localFilePath, outPath, source.durationSec);
  }

  const publish = await probeVideo(outPath);
  const note = describeCondense(source, publish, strategy);
  return { publishPath: outPath, condensed: true, strategy, source, publish, note };
}

async function runTrimStrategy(inputPath: string, outPath: string): Promise<void> {
  // Take the first MAX_DURATION_SEC of the source, scale-letterbox to 960×720. We keep audio
  // when present and fall back to video-only on failure. Using -ss 0 + -t emits a clean PTS so
  // Seedance doesn't get confused by edit lists from negative-start streams.
  const baseArgs = ["-y", "-hide_banner", "-loglevel", "error", "-i", inputPath, "-t", String(MAX_DURATION_SEC)];
  const filter = `scale=${TARGET_W}:${TARGET_H}:force_original_aspect_ratio=decrease,` +
    `pad=${TARGET_W}:${TARGET_H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24`;
  const withAudio = [
    ...baseArgs,
    "-vf", filter,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "96k",
    "-movflags", "+faststart",
    outPath
  ];
  try {
    await runFfmpeg(withAudio);
  } catch {
    try { await unlink(outPath); } catch {}
    const videoOnly = [
      ...baseArgs,
      "-an",
      "-vf", filter,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      outPath
    ];
    await runFfmpeg(videoOnly);
  }
}

async function runSpeedupStrategy(inputPath: string, outPath: string, sourceDurationSec: number): Promise<void> {
  // Compute setpts factor so the whole source fits within MAX_DURATION_SEC. Picking a slightly
  // tighter target (14.5s) gives ~5% headroom against probe / re-encode drift that could push us
  // back over the 15.2s ceiling.
  const targetSec = Math.min(MAX_DURATION_SEC, 14.5);
  const speed = Math.max(1.001, sourceDurationSec / targetSec);
  // setpts=PTS/speed plays back faster; atempo handles audio. atempo per-instance is clamped to
  // [0.5, 100], so 1× chained = OK for any reasonable speedup.
  const videoFilter = `setpts=PTS/${speed.toFixed(4)},scale=${TARGET_W}:${TARGET_H}:` +
    `force_original_aspect_ratio=decrease,pad=${TARGET_W}:${TARGET_H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24`;
  const audioFilter = buildAtempoChain(speed);
  const baseArgs = ["-y", "-hide_banner", "-loglevel", "error", "-i", inputPath];
  const withAudio = [
    ...baseArgs,
    "-filter_complex", `[0:v]${videoFilter}[v];[0:a]${audioFilter}[a]`,
    "-map", "[v]", "-map", "[a]",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "96k",
    "-movflags", "+faststart",
    outPath
  ];
  try {
    await runFfmpeg(withAudio);
  } catch {
    try { await unlink(outPath); } catch {}
    const videoOnly = [
      ...baseArgs,
      "-an",
      "-vf", videoFilter,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      outPath
    ];
    await runFfmpeg(videoOnly);
  }
}

/** atempo only accepts [0.5, 100] per instance; chain when speed > 100 (rare here, but cheap). */
function buildAtempoChain(speed: number): string {
  let remaining = speed;
  const parts: string[] = [];
  while (remaining > 100) {
    parts.push("atempo=100");
    remaining /= 100;
  }
  parts.push(`atempo=${remaining.toFixed(4)}`);
  return parts.join(",");
}

async function runSampleConcatStrategy(
  localFilePath: string,
  outPath: string,
  sourceDurationSec: number
): Promise<void> {
  const totalDuration = Math.min(sourceDurationSec, 600);
  const startPoints = pickSampleStarts(totalDuration, SAMPLE_COUNT, SAMPLE_LEN_SEC);
  const args: string[] = ["-y", "-hide_banner", "-loglevel", "error"];
  for (const start of startPoints) {
    args.push("-ss", start.toFixed(2), "-t", String(SAMPLE_LEN_SEC), "-i", localFilePath);
  }
  const filterParts: string[] = [];
  const concatInputs: string[] = [];
  for (let i = 0; i < startPoints.length; i++) {
    filterParts.push(
      `[${i}:v]scale=${TARGET_W}:${TARGET_H}:force_original_aspect_ratio=decrease,` +
        `pad=${TARGET_W}:${TARGET_H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24[v${i}]`
    );
    filterParts.push(`[${i}:a]aresample=48000,asetpts=PTS-STARTPTS[a${i}]`);
    concatInputs.push(`[v${i}][a${i}]`);
  }
  filterParts.push(
    `${concatInputs.join("")}concat=n=${startPoints.length}:v=1:a=1[outv][outa]`
  );
  args.push(
    "-filter_complex", filterParts.join(";"),
    "-map", "[outv]", "-map", "[outa]",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "96k",
    "-movflags", "+faststart",
    outPath
  );

  try {
    await runFfmpeg(args);
  } catch {
    const videoOnlyArgs: string[] = ["-y", "-hide_banner", "-loglevel", "error"];
    for (const start of startPoints) {
      videoOnlyArgs.push("-ss", start.toFixed(2), "-t", String(SAMPLE_LEN_SEC), "-i", localFilePath);
    }
    const filterVOnly: string[] = [];
    const concatVOnly: string[] = [];
    for (let i = 0; i < startPoints.length; i++) {
      filterVOnly.push(
        `[${i}:v]scale=${TARGET_W}:${TARGET_H}:force_original_aspect_ratio=decrease,` +
          `pad=${TARGET_W}:${TARGET_H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24[v${i}]`
      );
      concatVOnly.push(`[v${i}]`);
    }
    filterVOnly.push(`${concatVOnly.join("")}concat=n=${startPoints.length}:v=1:a=0[outv]`);
    videoOnlyArgs.push(
      "-filter_complex", filterVOnly.join(";"),
      "-map", "[outv]",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      outPath
    );
    try { await unlink(outPath); } catch {}
    await runFfmpeg(videoOnlyArgs);
  }
}

function pickSampleStarts(durationSec: number, count: number, segLen: number): number[] {
  // If the source is shorter than count * segLen we just produce as many segments as fit.
  const usable = Math.max(0, durationSec - segLen);
  if (usable <= 0) return [0];
  const points: number[] = [];
  for (let i = 0; i < count; i++) {
    const t = (usable * i) / Math.max(1, count - 1);
    points.push(Math.max(0, Math.min(usable, Number(t.toFixed(2)))));
  }
  return points;
}

function describeCondense(src: ProbeInfo, dst: ProbeInfo, strategy: CondenseStrategy): string {
  const head = `源视频 ${src.durationSec.toFixed(1)}s @ ${src.width}x${src.height} 不满足 Seedance r2v 限制`;
  const tail = `产出 ${dst.durationSec.toFixed(1)}s @ ${dst.width}x${dst.height} 参考片`;
  if (strategy === "trim") {
    return `${head}，已截取前 ${MAX_DURATION_SEC}s 并 letterbox 到 ${TARGET_W}x${TARGET_H}，${tail}（trim 策略，原速运动）。`;
  }
  if (strategy === "speedup") {
    const factor = src.durationSec / dst.durationSec;
    return `${head}，已整体加速 ${factor.toFixed(2)}× 至 ≤${MAX_DURATION_SEC}s 并 letterbox 到 ${TARGET_W}x${TARGET_H}，${tail}（speedup 策略，全帧覆盖但运动加快）。`;
  }
  return `${head}，已自动从 ${SAMPLE_COUNT} 个均匀分布点各取 ${SAMPLE_LEN_SEC}s 拼成 ${TARGET_W}x${TARGET_H} 参考片，${tail}（sample-concat 策略，多 beat 覆盖带硬切）。`;
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG_BIN, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolve();
      reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-1000)}`));
    });
  });
}

function runFfmpegCapture(args: string[]): Promise<string> {
  // ffmpeg with `-i` only writes its banner to stderr and exits non-zero (no output specified),
  // which is the standard idiom for probe. We capture stderr regardless of exit code.
  return new Promise((resolve) => {
    const child = spawn(FFMPEG_BIN, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("close", () => resolve(stderr));
    child.on("error", () => resolve(stderr));
  });
}
