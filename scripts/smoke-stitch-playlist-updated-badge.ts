import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isShotVideoUpdatedAfterFinal } from "../src/client/flow/stitchFreshness";
import type { Shot, StitchJob } from "../src/shared/types";

const baseShot: Shot = {
  id: "shot_updated",
  sessionId: "ses_updated",
  index: 1,
  title: "Updated shot",
  script: "",
  camera: "",
  durationSec: 15,
  assetIds: [],
  prompt: "",
  status: "ready",
  videoUrl: "/media/updated.mp4",
  videoGeneratedAt: "2026-06-10T10:05:00.000Z",
  createdAt: "2026-06-10T09:00:00.000Z",
  updatedAt: "2026-06-10T10:05:00.000Z"
};

const finalJob: StitchJob = {
  id: "stitch_main",
  name: "完整视频",
  shotIds: ["shot_updated"],
  status: "ready",
  finalVideoUrl: "/media/final.mp4",
  finalVideoGeneratedAt: "2026-06-10T10:00:00.000Z",
  createdAt: "2026-06-10T09:30:00.000Z",
  updatedAt: "2026-06-10T10:00:00.000Z"
};

assert.equal(
  isShotVideoUpdatedAfterFinal(baseShot, finalJob),
  true,
  "a shot whose current video was generated after the final video should be marked updated"
);
assert.equal(
  isShotVideoUpdatedAfterFinal({ ...baseShot, videoGeneratedAt: "2026-06-10T09:55:00.000Z" }, finalJob),
  false,
  "a shot whose current video predates the final video should not be marked updated"
);
assert.equal(
  isShotVideoUpdatedAfterFinal(
    {
      ...baseShot,
      videoGeneratedAt: undefined,
      renders: [{
        id: "render_new",
        model: "seedance",
        prompt: "",
        status: "ready",
        videoUrl: "/media/updated.mp4",
        videoGeneratedAt: "2026-06-10T10:06:00.000Z",
        createdAt: "2026-06-10T10:02:00.000Z",
        updatedAt: "2026-06-10T10:06:00.000Z"
      }]
    },
    finalJob
  ),
  true,
  "matching render metadata should also mark the shot updated when top-level videoGeneratedAt is missing"
);

const inspectorSource = readFileSync("src/client/flow/Inspector.tsx", "utf8");
assert.match(inspectorSource, /isShotVideoUpdatedAfterFinal/, "Stitch Inspector should compute per-playlist-item video freshness");
assert.match(inspectorSource, /inspector-stale-tag/, "Stitch Inspector should render a badge for updated playlist items");
assert.match(inspectorSource, /已更新/, "updated playlist badge should use the requested Chinese copy");

console.log("smoke:stitch-playlist-updated-badge passed");
