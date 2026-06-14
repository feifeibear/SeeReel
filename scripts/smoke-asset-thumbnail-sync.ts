import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const originalCwd = process.cwd();
const tempDir = await mkdtemp(path.join(os.tmpdir(), "seereel-asset-thumb-sync-"));

try {
  process.chdir(tempDir);
  const { CinemaStore } = await import("../src/server/store");
  const store = new CinemaStore();
  await store.load();

  const created = await store.upsertAsset({
    name: "Image node",
    type: "image",
    mediaKind: "image",
    description: "",
    prompt: "",
    mediaUrl: "/media/old-current.jpg",
    imageUrl: "/media/old-current.jpg",
    thumbnailUrl: "/media/old-thumbnail-from-other-node.jpg",
    tags: []
  });
  assert.ok(created);

  const updated = await store.upsertAsset({
    id: created.id,
    mediaUrl: "/media/new-current.jpg",
    imageUrl: "/media/new-current.jpg",
    mediaKind: "image"
  });

  assert.equal(updated?.mediaUrl, "/media/new-current.jpg");
  assert.equal(updated?.imageUrl, "/media/new-current.jpg");
  assert.equal(
    updated?.thumbnailUrl,
    "/media/new-current.jpg",
    "image asset thumbnail should follow the current media when no explicit thumbnail is provided"
  );
} finally {
  process.chdir(originalCwd);
  await rm(tempDir, { recursive: true, force: true });
}

console.log("asset thumbnail sync smoke passed");
