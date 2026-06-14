import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createGeneratedImageCanvasFields } from "../src/server/imagePreview";
import { runFfmpegCommand } from "../src/server/generators";

const tmp = await mkdtemp(path.join(os.tmpdir(), "seereel-generated-image-"));
try {
  const source = path.join(tmp, "generated-4k.png");
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

  const fields = await createGeneratedImageCanvasFields({
    localImageUrl: `/media/${path.basename(source)}`,
    localImagePath: source,
    remoteImageUrl: "https://seedream.example.com/generated/original.png",
    assetId: "asset_generated_smoke"
  });

  assert.match(fields.mediaUrl, /^\/media\/asset-generated-smoke-preview-\d+\.jpg$/);
  assert.equal(fields.imageUrl, fields.mediaUrl, "canvas imageUrl should use the local preview");
  assert.equal(fields.thumbnailUrl, fields.mediaUrl, "thumbnailUrl should use the local preview");
  assert.equal(
    fields.sourceImageUrl,
    "https://seedream.example.com/generated/original.png",
    "remote generated image URL should be kept only as the source image"
  );
  assert.notEqual(fields.mediaUrl, fields.sourceImageUrl, "canvas preview should not point at the remote source URL");

  await rm(fields.mediaPath, { force: true });
} finally {
  await rm(tmp, { recursive: true, force: true });
}

console.log("smoke:generated-image-preview passed");
