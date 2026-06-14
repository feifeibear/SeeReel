import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { MEDIA_DIR, runFfmpegCommand } from "./generators";

export interface CanvasImagePreview {
  localUrl: string;
  filePath: string;
}

export interface GeneratedImageCanvasFields {
  mediaUrl: string;
  imageUrl: string;
  thumbnailUrl: string;
  sourceImageUrl: string;
  mediaPath: string;
}

function safeFilePart(value: string) {
  return (value || "image")
    .replace(/_+/g, "-")
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "image";
}

export async function createCanvasImagePreview(
  sourcePath: string,
  opts: { keyHint?: string; maxEdge?: number } = {}
): Promise<CanvasImagePreview> {
  await mkdir(MEDIA_DIR, { recursive: true });
  const maxEdge = Math.max(320, Math.min(opts.maxEdge ?? 1600, 4096));
  const safeStem = safeFilePart(opts.keyHint || path.basename(sourcePath, path.extname(sourcePath)));
  const outputName = `${safeStem}-preview-${Date.now()}.jpg`;
  const outputPath = path.join(MEDIA_DIR, outputName);

  await runFfmpegCommand([
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    sourcePath,
    "-frames:v",
    "1",
    "-vf",
    `scale=w='if(gte(iw,ih),min(${maxEdge},iw),-2)':h='if(gte(iw,ih),-2,min(${maxEdge},ih))':flags=lanczos,format=yuv420p`,
    "-q:v",
    "4",
    outputPath
  ]);

  const info = await stat(outputPath);
  if (!info.isFile() || info.size <= 0) {
    throw new Error("Generated image preview is empty");
  }
  return { localUrl: `/media/${outputName}`, filePath: outputPath };
}

export async function createGeneratedImageCanvasFields(input: {
  localImageUrl: string;
  localImagePath: string;
  remoteImageUrl?: string;
  assetId: string;
}): Promise<GeneratedImageCanvasFields> {
  let previewUrl = input.localImageUrl;
  let previewPath = input.localImagePath;
  try {
    const preview = await createCanvasImagePreview(input.localImagePath, {
      keyHint: input.assetId,
      maxEdge: 1600
    });
    previewUrl = preview.localUrl;
    previewPath = preview.filePath;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[image-preview] generated image preview failed for ${input.assetId}: ${message}`);
  }
  return {
    mediaUrl: previewUrl,
    imageUrl: previewUrl,
    thumbnailUrl: previewUrl,
    sourceImageUrl: input.remoteImageUrl || input.localImageUrl,
    mediaPath: previewPath
  };
}
