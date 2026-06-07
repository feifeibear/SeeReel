import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

async function main() {
  const repoRoot = process.cwd();
  const tempDir = await mkdtemp(path.join(tmpdir(), "seereel-gallery-"));
  process.chdir(tempDir);

  try {
    const { CinemaStore } = await import("../src/server/store");
    const store = new CinemaStore();
    await store.load();

    const ownerA = "gallery-owner-a";
    const ownerB = "gallery-owner-b";
    const session = await store.createSession({
      title: "Gallery Smoke Original",
      logline: "A courier finds tomorrow's memories inside a cracked phone.",
      style: "neon rain, handheld noir",
      targetDurationSec: 30,
      shotCount: 1,
      language: "en"
    }, ownerA);
    const shot = session.shots[0];
    assert.ok(shot, "source session should have one shot");

    const asset = await store.upsertAsset({
      name: "Courier",
      type: "character",
      mediaKind: "image",
      ownerSessionId: session.id,
      ownerUserId: ownerA,
      prompt: "A tired courier in a reflective jacket",
      description: "main character",
      mediaUrl: "https://cdn.example.com/courier.png",
      imageUrl: "https://cdn.example.com/courier.png",
      tags: ["character"]
    });
    assert.ok(asset, "asset should be created");

    const updatedShot = await store.updateShot(shot.id, {
      title: "Memory Pickup",
      rawPrompt: "Courier opens the phone and sees tomorrow.",
      prompt: "Courier opens the phone and sees tomorrow.",
      assetIds: [asset.id],
      videoUrl: "https://cdn.example.com/gallery-shot.mp4",
      status: "ready"
    });
    assert.equal(updatedShot?.videoUrl, "https://cdn.example.com/gallery-shot.mp4", "shot preview video should be saved");

    const updatedSession = await store.updateSession(session.id, {
      finalVideoUrl: "https://cdn.example.com/gallery-final.mp4",
      finalVideoGeneratedAt: "2026-06-05T00:00:00.000Z"
    });
    assert.equal(updatedSession?.finalVideoUrl, "https://cdn.example.com/gallery-final.mp4", "final video should be saved");

    const galleryItem = await store.publishSessionToGallery(session.id, {
      title: "Memory Courier",
      description: "A remixable noir micro-drama.",
      creatorName: "Smoke Creator",
      tags: ["noir", "memory"]
    });

    assert.equal(galleryItem.title, "Memory Courier", "gallery item uses user-facing title");
    assert.equal(galleryItem.previewVideoUrl, "https://cdn.example.com/gallery-final.mp4", "gallery item previews the final video");
    assert.equal(galleryItem.shotCount, 1, "gallery item records shot count");

    const gallery = store.listGalleryItems();
    assert.equal(gallery.some((item) => item.id === galleryItem.id), true, "gallery list includes the published item");

    await store.deleteSession(session.id);
    assert.equal(store.getSession(session.id), undefined, "source session can be deleted after publishing");

    const copied = await store.copyGalleryItemToSession(galleryItem.id, ownerB);
    assert.ok(copied.id.startsWith("ses_"), "copied session gets a real session id");
    assert.notEqual(copied.id, session.id, "copied session does not reuse source session id");
    assert.equal(copied.ownerUserId, ownerB, "copied session belongs to the copying user");
    assert.equal(copied.title.includes("Memory Courier"), true, "copied session title preserves gallery title");
    assert.equal(copied.shots.length, 1, "copied session preserves shots");
    assert.notEqual(copied.shots[0].id, shot.id, "copied shot gets a new id");
    assert.equal(copied.shots[0].assetIds.length, 1, "copied shot keeps asset wiring");
    assert.notEqual(copied.shots[0].assetIds[0], asset.id, "copied shot points at the copied asset");

    const ownerBSnapshot = store.snapshotForOwner(ownerB);
    assert.equal(ownerBSnapshot.sessions.some((item) => item.id === copied.id), true, "copy appears in owner B snapshot");
    assert.equal(ownerBSnapshot.assets.some((item) => item.id === copied.shots[0].assetIds[0]), true, "copied asset appears in owner B snapshot");
    assert.equal(ownerBSnapshot.gallery?.some((item) => item.id === galleryItem.id), true, "gallery remains visible in scoped snapshots");

    assert.equal(await store.deleteGalleryItem(galleryItem.id, ownerB), false, "other owners cannot delete the published gallery item");
    assert.equal(store.listGalleryItems().some((item) => item.id === galleryItem.id), true, "gallery item remains after rejected delete");
    assert.equal(await store.deleteGalleryItem(galleryItem.id, ownerA), true, "published gallery item can be deleted by its owner");
    assert.equal(store.listGalleryItems().some((item) => item.id === galleryItem.id), false, "deleted gallery item is removed from list");
    assert.equal(await store.copyGalleryItemToSession(galleryItem.id, ownerB), undefined, "deleted gallery item cannot be copied");
    assert.equal(await store.deleteGalleryItem(galleryItem.id, ownerA), false, "deleting a missing gallery item reports false");

    console.log("gallery sharing smoke passed", { galleryId: galleryItem.id, copiedSessionId: copied.id });
  } finally {
    process.chdir(repoRoot);
    await rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
