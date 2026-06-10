import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildPendingConnectEdge } from "../src/client/flow/pendingConnection";
import type { SessionWithShots, Shot, StoreSnapshot } from "../src/shared/types";

const now = "2026-06-10T00:00:00.000Z";
const sourceShot: Shot = {
  id: "source",
  sessionId: "ses_video_link",
  index: 1,
  title: "Source",
  script: "",
  camera: "",
  durationSec: 15,
  assetIds: [],
  prompt: "",
  status: "draft",
  createdAt: now,
  updatedAt: now
};
const targetShot: Shot = {
  id: "target",
  sessionId: "ses_video_link",
  index: 2,
  title: "Target",
  script: "",
  camera: "",
  durationSec: 15,
  assetIds: [],
  prompt: "",
  status: "draft",
  createdAt: now,
  updatedAt: now
};
const session: SessionWithShots = {
  id: "ses_video_link",
  title: "Video link",
  logline: "",
  targetDurationSec: 30,
  shots: [sourceShot, targetShot],
  createdAt: now,
  updatedAt: now
};
const snapshot: StoreSnapshot = { sessions: [session], shots: [sourceShot, targetShot], assets: [] };

const pending = buildPendingConnectEdge({
  connection: { source: "shot-source", target: "shot-target" },
  session,
  snapshot
});
assert.equal(pending?.id, "e-shotref-source-target", "shot-to-shot pending edge should render even before source video exists");

const flowSource = readFileSync("src/client/flow/FlowView.tsx", "utf8");
assert.doesNotMatch(flowSource, /!sourceShot\.videoUrl[\s\S]{0,180}无法连接/, "FlowView should not reject Shot-to-Shot linking just because the source has not rendered yet");
assert.match(flowSource, /referenceVideoFromShotId: srcShotId/, "Shot-to-Shot linking should still persist referenceVideoFromShotId");

console.log("smoke:shot-to-shot-pending-video-link passed");
