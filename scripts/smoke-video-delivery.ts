import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

const indexSource = readFileSync("src/server/index.ts", "utf8");
assert.match(
  indexSource,
  /publishLocalMediaToTosWithTimeout/,
  "final video TOS/CDN publish should be bounded so completed local stitches do not remain running forever"
);
assert.match(
  indexSource,
  /FINAL_VIDEO_PUBLISH_TIMEOUT_MS/,
  "final video publish timeout should be configurable"
);

console.log("video delivery smoke passed");
