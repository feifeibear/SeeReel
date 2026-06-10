import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  MEDIA_DIR,
  localMediaPathFromMediaUrl,
  runFfmpegCommand
} from "./generators";

const AUDIO_SEPARATION_SIGNATURE_VERSION = "audio-sep-v1-center-fallback";

export interface AudioSeparationPipelineInput {
  sessionId: string;
  finalVideoUrl: string;
  finalVideoSignature: string;
}

export interface AudioSeparationPipelineResult {
  vocalsUrl: string;
  backgroundUrl: string;
  signature: string;
  method: "external-command" | "center-vocal fallback";
}

export interface AudioSeparationPipelineOptions {
  onProgress?: (phase: string) => Promise<void> | void;
}

export function computeAudioSeparationSignature(input: { finalVideoSignature: string }) {
  return createHash("sha1")
    .update(JSON.stringify({
      version: AUDIO_SEPARATION_SIGNATURE_VERSION,
      finalVideoSignature: input.finalVideoSignature,
      command: Boolean(process.env.AUDIO_SEPARATION_COMMAND)
    }))
    .digest("hex")
    .slice(0, 12);
}

export async function runAudioSeparationPipeline(
  input: AudioSeparationPipelineInput,
  options: AudioSeparationPipelineOptions = {}
): Promise<AudioSeparationPipelineResult> {
  const signature = computeAudioSeparationSignature({ finalVideoSignature: input.finalVideoSignature });
  await mkdir(MEDIA_DIR, { recursive: true });
  const sourcePath = await materializeFinalVideo(input.finalVideoUrl, input.sessionId, signature);
  const vocalsName = `audio-sep-${input.sessionId}-${signature}-vocals.m4a`;
  const backgroundName = `audio-sep-${input.sessionId}-${signature}-background.m4a`;
  const vocalsPath = path.join(MEDIA_DIR, vocalsName);
  const backgroundPath = path.join(MEDIA_DIR, backgroundName);

  if (await hasUsableFile(vocalsPath) && await hasUsableFile(backgroundPath)) {
    await options.onProgress?.("reuse cached stems");
    return {
      vocalsUrl: `/media/${vocalsName}`,
      backgroundUrl: `/media/${backgroundName}`,
      signature,
      method: process.env.AUDIO_SEPARATION_COMMAND ? "external-command" : "center-vocal fallback"
    };
  }

  const command = process.env.AUDIO_SEPARATION_COMMAND?.trim();
  if (command) {
    await options.onProgress?.("external audio separation");
    await runExternalAudioSeparation(command, {
      input: sourcePath,
      vocals: vocalsPath,
      background: backgroundPath
    });
    return {
      vocalsUrl: `/media/${vocalsName}`,
      backgroundUrl: `/media/${backgroundName}`,
      signature,
      method: "external-command"
    };
  }

  // center-vocal fallback: no model dependency, good enough for a visible local workflow.
  // Vocals are approximated from the stereo center channel; background is a phase-cancelled bed.
  await options.onProgress?.("ffmpeg center-vocal fallback");
  await runFfmpegCommand([
    "-y",
    "-i",
    sourcePath,
    "-vn",
    "-filter_complex",
    "[0:a]aformat=channel_layouts=stereo,pan=mono|c0=0.5*c0+0.5*c1,highpass=f=120,lowpass=f=7000[a]",
    "-map",
    "[a]",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    vocalsPath
  ], 8192);

  await options.onProgress?.("ffmpeg background stem");
  await runFfmpegCommand([
    "-y",
    "-i",
    sourcePath,
    "-vn",
    "-filter_complex",
    "[0:a]aformat=channel_layouts=stereo,pan=stereo|c0=c0-c1|c1=c1-c0,volume=1.2[a]",
    "-map",
    "[a]",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    backgroundPath
  ], 8192);

  return {
    vocalsUrl: `/media/${vocalsName}`,
    backgroundUrl: `/media/${backgroundName}`,
    signature,
    method: "center-vocal fallback"
  };
}

async function materializeFinalVideo(videoUrl: string, sessionId: string, signature: string) {
  const local = localMediaPathFromMediaUrl(videoUrl);
  if (local) return local;
  if (videoUrl.startsWith("file://")) return new URL(videoUrl).pathname;
  if (!videoUrl.startsWith("http")) return videoUrl;

  const cachePath = path.join(MEDIA_DIR, `audio-sep-source-${sessionId}-${signature}.mp4`);
  if (await hasUsableFile(cachePath)) return cachePath;
  const response = await fetch(videoUrl);
  if (!response.ok) throw new Error(`Download final video for audio separation failed: ${response.status} ${response.statusText}`);
  const buf = Buffer.from(await response.arrayBuffer());
  await writeFile(cachePath, buf);
  return cachePath;
}

async function hasUsableFile(filePath: string) {
  try {
    const info = await stat(filePath);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

function runExternalAudioSeparation(command: string, files: { input: string; vocals: string; background: string }) {
  const expanded = command
    .replaceAll("{input}", shellQuote(files.input))
    .replaceAll("{vocals}", shellQuote(files.vocals))
    .replaceAll("{background}", shellQuote(files.background));
  return new Promise<void>((resolve, reject) => {
    const child = spawn(expanded, { shell: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderrTail = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderrTail = `${stderrTail}${chunk}`.slice(-8192);
    });
    child.on("error", reject);
    child.on("close", async (code) => {
      if (code !== 0) return reject(new Error(`AUDIO_SEPARATION_COMMAND failed with exit code ${code}: ${stderrTail.trim()}`));
      if (!(await hasUsableFile(files.vocals)) || !(await hasUsableFile(files.background))) {
        return reject(new Error("AUDIO_SEPARATION_COMMAND did not create both output stems"));
      }
      resolve();
    });
  });
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
