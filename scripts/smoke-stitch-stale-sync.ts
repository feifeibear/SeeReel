import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createStitchSignature } from "../src/server/generators";
import type { Shot } from "../src/shared/types";

const now = "2026-06-10T00:00:00.000Z";
const shotBase: Shot = {
  id: "shot_sync",
  sessionId: "ses_sync",
  index: 1,
  title: "Shot sync",
  script: "",
  rawPrompt: "",
  prompt: "",
  durationSec: 15,
  assetIds: [],
  renders: [{ id: "render_old", videoUrl: "/media/old.mp4", status: "succeeded", createdAt: now, updatedAt: now }],
  status: "ready",
  videoUrl: "/media/old.mp4",
  createdAt: now,
  updatedAt: now
};

const oldSignature = createStitchSignature([shotBase]);
const rerenderedSignature = createStitchSignature([{
  ...shotBase,
  videoUrl: "/media/new.mp4",
  renders: [...(shotBase.renders || []), { id: "render_new", videoUrl: "/media/new.mp4", status: "succeeded", createdAt: now, updatedAt: now }]
}]);
assert.notEqual(oldSignature, rerenderedSignature, "stitch signature should change when a selected shot video changes");

const indexSource = readFileSync("src/server/index.ts", "utf8");
assert.match(indexSource, /enrichSnapshotWithStitchFreshness/, "state snapshots should be enriched with stitch freshness metadata");
assert.match(indexSource, /currentStitchSignature/, "legacy stitch state should expose the current input signature");
assert.match(indexSource, /finalVideoStale/, "legacy stitch state should flag stale final video outputs");
assert.match(indexSource, /stitchUnlistedShotIds/, "legacy stitch state should flag newly created videos outside a custom playlist");
assert.match(indexSource, /currentInputSignature/, "stitch jobs should expose their current input signature");
assert.match(indexSource, /unlistedShotIds/, "stitch jobs should flag newly created videos outside a custom playlist");

const inspectorSource = readFileSync("src/client/flow/Inspector.tsx", "utf8");
assert.match(inspectorSource, /finalVideoStale/, "Stitch Inspector should surface stale full-video state");
assert.match(inspectorSource, /源视频已更新，请重新拼接/, "Stitch Inspector should tell users to restitch when source videos changed");
assert.match(inspectorSource, /新视频未加入/, "Stitch Inspector should tell users when newly created videos are outside the playlist");
assert.match(inspectorSource, /unlistedShotIds/, "Stitch Inspector should render actions for unlisted videos");

const nodesSource = readFileSync("src/client/flow/nodes.tsx", "utf8");
assert.match(nodesSource, /finalVideoStale/, "Stitch canvas node should mark stale final videos");
assert.match(nodesSource, /源视频已更新/, "Stitch canvas node should show a compact stale badge");

console.log("smoke:stitch-stale-sync passed");
