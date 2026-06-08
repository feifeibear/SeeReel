import assert from "node:assert/strict";
import { resolveVideoDeliveryUrl, shouldRedirectVideoDelivery } from "../src/shared/videoDelivery";

assert.equal(
  resolveVideoDeliveryUrl({
    videoUrl: "/media/slow-local.mp4",
    playbackVideoUrl: "https://media.example.com/fast/shot.mp4"
  }),
  "https://media.example.com/fast/shot.mp4",
  "playbackVideoUrl should win over local videoUrl"
);

assert.equal(
  resolveVideoDeliveryUrl({
    videoUrl: "/media/slow-local.mp4",
    downloadVideoUrl: "https://media.example.com/download/shot.mp4"
  }, "download"),
  "https://media.example.com/download/shot.mp4",
  "downloadVideoUrl should win for download delivery"
);

assert.equal(
  resolveVideoDeliveryUrl({
    videoUrl: "/media/slow-local.mp4",
    remoteVideoUrl: "https://seedance.example.com/original.mp4"
  }),
  "https://seedance.example.com/original.mp4",
  "remoteVideoUrl should be used when no CDN playback URL exists"
);

assert.equal(
  resolveVideoDeliveryUrl({ videoUrl: "/media/local-only.mp4" }),
  "/media/local-only.mp4",
  "local videoUrl should remain the fallback"
);

assert.equal(shouldRedirectVideoDelivery("https://media.example.com/fast/shot.mp4"), true);
assert.equal(shouldRedirectVideoDelivery("/media/local-only.mp4"), false);
assert.equal(shouldRedirectVideoDelivery("http://localhost:5173/media/local.mp4"), false);

console.log("video delivery smoke passed");
