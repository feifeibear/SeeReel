import assert from "node:assert/strict";
import { createPendingImageUploadAsset } from "../src/client/uploadPlaceholders";

const pendingCharacter = createPendingImageUploadAsset({
  fileName: "electrician.png",
  kind: "character",
  sessionId: "ses_upload_test",
  objectUrl: "blob:http://localhost/electrician",
  now: "2026-06-07T10:00:00.000Z",
  randomSuffix: "abc123",
  lang: "en"
});

assert.equal(pendingCharacter.id, "pending-image-upload-1780826400000-abc123");
assert.equal(pendingCharacter.ownerSessionId, "ses_upload_test");
assert.equal(pendingCharacter.type, "character");
assert.equal(pendingCharacter.mediaKind, "image");
assert.equal(pendingCharacter.mediaUrl, "blob:http://localhost/electrician");
assert.equal(pendingCharacter.imageUrl, "blob:http://localhost/electrician");
assert.deepEqual(pendingCharacter.tags, ["anchor", "uploaded", "character", "client-pending-upload"]);
assert.match(pendingCharacter.description || "", /Uploading image/);

const pendingScene = createPendingImageUploadAsset({
  fileName: ".jpg",
  kind: "scene",
  sessionId: "ses_upload_test",
  objectUrl: "blob:http://localhost/scene",
  now: "2026-06-07T10:00:01.000Z",
  randomSuffix: "scene1",
  lang: "zh"
});

assert.equal(pendingScene.name, "上传场景");
assert.equal(pendingScene.type, "scene");
assert.deepEqual(pendingScene.tags, ["anchor", "uploaded", "scene", "client-pending-upload"]);
assert.match(pendingScene.description || "", /上传中/);

console.log("smoke:image-upload-placeholder passed");
