import { strict as assert } from "node:assert";
import { collectDeletedSessionsArtifacts } from "../src/server/sessionCleanup";
import type { StoreSnapshot } from "../src/shared/types";

const snapshot: StoreSnapshot = {
  gallery: [],
  sessions: [
    { id: "ses_a", title: "A", logline: "", style: "", targetDurationSec: 15, shotCount: 1, createdAt: "", updatedAt: "", finalVideoUrl: "/media/a-final.mp4" },
    { id: "ses_b", title: "B", logline: "", style: "", targetDurationSec: 15, shotCount: 1, createdAt: "", updatedAt: "", narrationVideoUrl: "/media/b-narration.mp4" },
    { id: "ses_keep", title: "Keep", logline: "", style: "", targetDurationSec: 15, shotCount: 1, createdAt: "", updatedAt: "" }
  ],
  shots: [
    { id: "shot_a", sessionId: "ses_a", index: 1, title: "A", script: "", prompt: "", status: "ready", videoUrl: "/media/a-shot.mp4", assetIds: [], renders: [], createdAt: "", updatedAt: "" },
    { id: "shot_b", sessionId: "ses_b", index: 1, title: "B", script: "", prompt: "", status: "ready", videoUrl: "/media/b-shot.mp4", assetIds: [], renders: [{ id: "render_b", status: "ready", model: "smoke", prompt: "", videoUrl: "/media/b-render.mp4", referenceClipTosObjectKey: "tos/b-render-tail.mp4" }], createdAt: "", updatedAt: "" }
  ],
  assets: [
    { id: "asset_a", ownerSessionId: "ses_a", name: "A", type: "scene", mediaKind: "image", description: "", prompt: "", mediaUrl: "/media/a-asset.png", tosObjectKey: "tos/a-asset.png", tags: [], createdAt: "", updatedAt: "" },
    { id: "asset_b", ownerSessionId: "ses_b", name: "B", type: "scene", mediaKind: "image", description: "", prompt: "", mediaUrl: "/media/b-asset.png", tosObjectKey: "tos/b-asset.png", tags: [], createdAt: "", updatedAt: "" },
    { id: "asset_keep", name: "Keep", type: "scene", mediaKind: "image", description: "", prompt: "", mediaUrl: "/media/shared.png", tosObjectKey: "tos/shared.png", tags: [], createdAt: "", updatedAt: "" }
  ]
};

const artifacts = collectDeletedSessionsArtifacts(snapshot, ["ses_a", "ses_b"]);

assert.deepEqual([...artifacts.localMediaUrls].sort(), [
  "/media/a-asset.png",
  "/media/a-final.mp4",
  "/media/a-shot.mp4",
  "/media/b-asset.png",
  "/media/b-narration.mp4",
  "/media/b-render.mp4",
  "/media/b-shot.mp4"
]);
assert.deepEqual([...artifacts.tosObjectKeys].sort(), [
  "tos/a-asset.png",
  "tos/b-asset.png",
  "tos/b-render-tail.mp4"
]);

console.log("session bulk delete cleanup smoke passed");
