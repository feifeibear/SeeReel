import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { buildSessionGraph } from "../src/client/flow/buildGraph";
import type { SessionWithShots, Shot, StoreSnapshot } from "../src/shared/types";

const now = "2026-06-09T00:00:00.000Z";

const shotA: Shot = {
  id: "shot_a",
  sessionId: "ses_libtv_stitch",
  index: 1,
  title: "A",
  script: "",
  prompt: "",
  status: "ready",
  videoUrl: "/media/a.mp4",
  assetIds: [],
  renders: [],
  createdAt: now,
  updatedAt: now
};

const shotB: Shot = {
  id: "shot_b",
  sessionId: "ses_libtv_stitch",
  index: 2,
  title: "B",
  script: "",
  prompt: "",
  status: "ready",
  videoUrl: "/media/b.mp4",
  referenceVideoFromShotId: "shot_a",
  assetIds: [],
  renders: [],
  createdAt: now,
  updatedAt: now
};

const session: SessionWithShots = {
  id: "ses_libtv_stitch",
  title: "LibTV style stitch",
  logline: "",
  targetDurationSec: 30,
  stitchShotIds: ["shot_a", "shot_b"],
  stitchStatus: "ready",
  finalVideoUrl: "/media/final.mp4",
  shots: [shotA, shotB],
  createdAt: now,
  updatedAt: now
};

const snapshot: StoreSnapshot = {
  sessions: [session],
  shots: [shotA, shotB],
  assets: []
};

const graph = buildSessionGraph(snapshot, session);

assert.equal(
  graph.nodes.some((node) => node.type === "stitchNode" || node.id.startsWith("stitch-")),
  false,
  "LibTV-style canvas should not render a stitch node"
);

assert.equal(
  graph.edges.some((edge) => edge.data && (edge.data as { derivedDefaultStitch?: boolean; canDisconnectStitch?: boolean }).derivedDefaultStitch),
  false,
  "stitch order should no longer be represented by shot-to-stitch default edges"
);

const shotChainEdge = graph.edges.find((edge) => edge.id === "e-shotref-shot_a-shot_b");
assert.ok(shotChainEdge, "shot-to-shot video chain edge should remain visible and drive stitch order");

const createMenuSource = readFileSync("src/client/flow/CreateNodeMenu.tsx", "utf8");
assert.doesNotMatch(createMenuSource, /safePick\("stitch"\)/, "right-click menu should not expose a stitch-node shortcut");
assert.doesNotMatch(createMenuSource, /key:\s*"stitch"/, "right-click menu should not list a stitch node");
assert.match(createMenuSource, /safePick\("audioTrack"\)/, "right-click menu should expose a LibTV-style audio-track shortcut");
assert.match(createMenuSource, /key:\s*"audioTrack"/, "right-click menu should list an audio-track node");

console.log("libtv-style stitch smoke passed");
