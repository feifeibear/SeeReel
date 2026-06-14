import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCanvasImagePreview } from "../src/server/imagePreview";
import { runFfmpegCommand } from "../src/server/generators";

const tmp = await mkdtemp(path.join(os.tmpdir(), "seereel-4k-image-"));
let previewPath: string | undefined;
try {
  const source = path.join(tmp, "source-4k.png");
  await runFfmpegCommand([
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=3840x2160:rate=1",
    "-frames:v",
    "1",
    source
  ]);

  const preview = await createCanvasImagePreview(source, { keyHint: "smoke-4k-upload", maxEdge: 1600 });
  previewPath = preview.filePath;
  assert.match(preview.localUrl, /^\/media\/smoke-4k-upload-preview-\d+\.jpg$/);
  assert.ok(preview.filePath.endsWith(".jpg"), "4K upload preview should be a browser-friendly jpg");

  const stderr: string[] = [];
  await runFfmpegCommand([
    "-hide_banner",
    "-i",
    preview.filePath,
    "-f",
    "null",
    "-"
  ]).catch((error) => {
    stderr.push(String(error));
  });
  assert.equal(stderr.length, 0, "generated preview should be readable by ffmpeg");
} finally {
  if (previewPath) await rm(previewPath, { force: true });
  await rm(tmp, { recursive: true, force: true });
}

console.log("smoke:image-upload-preview passed");
