import { strict as assert } from "node:assert";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { cleanupDeletedSessionArtifacts, collectDeletedSessionArtifacts } from "../src/server/sessionCleanup";

async function exists(filePath: string) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const repoRoot = process.cwd();
  const tempDir = await mkdtemp(path.join(tmpdir(), "seereel-delete-cleanup-"));
  const mediaDir = path.join(tempDir, "data", "media");
  await mkdir(mediaDir, { recursive: true });
  process.chdir(tempDir);

  try {
    const files = {
      deleteAsset: path.join(mediaDir, "delete-asset.png"),
      deleteShot: path.join(mediaDir, "delete-shot.mp4"),
      deleteRender: path.join(mediaDir, "delete-render.mp4"),
      deleteFinal: path.join(mediaDir, "delete-final.mp4"),
      deleteNarration: path.join(mediaDir, "delete-narration.mp4"),
      keepShared: path.join(mediaDir, "keep-shared.png")
    };
    await Promise.all(Object.values(files).map((filePath) => writeFile(filePath, `media:${path.basename(filePath)}`)));

    const storeModule = await import(`${pathToFileURL(path.join(repoRoot, "src/server/store.ts")).href}?deleteCleanup=${Date.now()}`);
    const { CinemaStore } = storeModule as typeof import("../src/server/store");
    const store = new CinemaStore();
    await store.load();

    const owner = "delete-cleanup-owner";
    const session = await store.createSession({
      title: "Delete Cleanup",
      logline: "cleanup local and cloud intermediates",
      style: "smoke",
      targetDurationSec: 15,
      shotCount: 1
    }, owner);
    const shot = session.shots[0];
    assert.ok(shot, "session has a shot");

    const asset = await store.upsertAsset({
      ownerUserId: owner,
      ownerSessionId: session.id,
      name: "Cleanup asset",
      type: "scene",
      mediaKind: "image",
      description: "",
      prompt: "",
      mediaUrl: "/media/delete-asset.png",
      imageUrl: "/media/keep-shared.png",
      tosObjectKey: "tos/delete-asset.png",
      tags: ["cleanup"]
    });
    assert.ok(asset, "session asset exists");

    await store.upsertAsset({
      ownerUserId: owner,
      name: "Shared survivor",
      type: "scene",
      mediaKind: "image",
      description: "",
      prompt: "",
      mediaUrl: "/media/keep-shared.png",
      tosObjectKey: "tos/keep-shared.png",
      tags: ["shared"]
    });

    const updatedShot = await store.updateShot(shot.id, {
      assetIds: [asset.id],
      videoUrl: "/media/delete-shot.mp4",
      referenceClipUrl: "https://tos.example.com/delete-tail.mp4",
      referenceClipTosObjectKey: "tos/delete-tail.mp4",
      renders: [{
        id: "render_delete_cleanup",
        model: "smoke",
        prompt: "cleanup",
        videoUrl: "/media/delete-render.mp4",
        referenceClipTosObjectKey: "tos/delete-render-tail.mp4",
        status: "ready"
      }]
    });
    assert.ok(updatedShot, "shot media saved");

    await store.updateSession(session.id, {
      finalVideoUrl: "/media/delete-final.mp4",
      narrationVideoUrl: "/media/delete-narration.mp4"
    });

    const before = store.snapshot();
    const deletedArtifacts = collectDeletedSessionArtifacts(before, session.id);
    assert.equal(deletedArtifacts.localMediaUrls.has("/media/delete-asset.png"), true, "session asset media is a cleanup candidate");
    assert.equal(deletedArtifacts.localMediaUrls.has("/media/delete-render.mp4"), true, "render media is a cleanup candidate");
    assert.equal(deletedArtifacts.tosObjectKeys.has("tos/delete-asset.png"), true, "session TOS object is a cleanup candidate");
    assert.equal(deletedArtifacts.tosObjectKeys.has("tos/delete-tail.mp4"), true, "shot TOS object is a cleanup candidate");
    assert.equal(deletedArtifacts.tosObjectKeys.has("tos/delete-render-tail.mp4"), true, "render TOS object is a cleanup candidate");

    const deleted = await store.deleteSession(session.id);
    assert.equal(deleted, true, "session delete succeeds");

    const deletedTosKeys: string[] = [];
    const result = await cleanupDeletedSessionArtifacts(deletedArtifacts, store.snapshot(), {
      mediaDir,
      deleteTosObjectKeys: async (keys) => {
        deletedTosKeys.push(...keys);
        return { deletedKeys: keys, failed: [] };
      }
    });

    assert.deepEqual(result.failedLocalMedia, [], "local cleanup has no failures");
    assert.equal(await exists(files.deleteAsset), false, "unshared session asset file is deleted");
    assert.equal(await exists(files.deleteShot), false, "unshared selected shot video is deleted");
    assert.equal(await exists(files.deleteRender), false, "unshared render video is deleted");
    assert.equal(await exists(files.deleteFinal), false, "unshared final stitch video is deleted");
    assert.equal(await exists(files.deleteNarration), false, "unshared narration video is deleted");
    assert.equal(await exists(files.keepShared), true, "shared local media stays on disk");
    assert.deepEqual(
      deletedTosKeys,
      ["tos/delete-asset.png", "tos/delete-render-tail.mp4", "tos/delete-tail.mp4"],
      "only unshared TOS objects are deleted"
    );

    console.log("session delete cleanup smoke passed");
  } finally {
    process.chdir(repoRoot);
    await rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
