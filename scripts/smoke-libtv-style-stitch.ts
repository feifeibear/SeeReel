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

const stitchNode = graph.nodes.find((node) => node.id === "stitch-ses_libtv_stitch-legacy");
assert.ok(stitchNode, "canvas should render a visible stitch node for final-video assembly");
assert.equal(stitchNode.type, "stitchNode");
assert.equal((stitchNode.data as { kind?: string; legacy?: boolean }).kind, "stitch");
assert.equal((stitchNode.data as { legacy?: boolean }).legacy, true);

const stitchEdges = graph.edges.filter((edge) => edge.target === stitchNode.id);
assert.deepEqual(stitchEdges, [], "stitch playlist should not be represented by noisy video-to-stitch canvas edges");

const shotChainEdge = graph.edges.find((edge) => edge.id === "e-shotref-shot_a-shot_b");
assert.ok(shotChainEdge, "shot-to-shot video chain edge should remain visible and drive stitch order");

const createMenuSource = readFileSync("src/client/flow/CreateNodeMenu.tsx", "utf8");
assert.match(createMenuSource, /safePick\("stitch"\)/, "right-click menu should expose a stitch-node shortcut");
assert.match(createMenuSource, /key:\s*"stitch"/, "right-click menu should list a stitch node");
assert.match(createMenuSource, /safePick\("audioTrack"\)/, "right-click menu should expose a LibTV-style audio-track shortcut");
assert.match(createMenuSource, /key:\s*"audioTrack"/, "right-click menu should list an audio-track node");

const inspectorSource = readFileSync("src/client/flow/Inspector.tsx", "utf8");
assert.match(inspectorSource, /defaultStitchIds = stitchableShots\.map\(\(shot\) => shot\.id\)/, "stitch panel should default to generated canvas videos in creation order");
assert.match(inspectorSource, /availableStitchShots/, "stitch panel should expose available canvas video nodes");
assert.match(inspectorSource, /application\/x-seereel-shot-id/, "available video nodes should be draggable into the stitch playlist");
assert.doesNotMatch(inspectorSource, /还没有视频连到这个拼接节点/, "stitch panel should not require drawing every video into the stitch node");
assert.match(inspectorSource, /draggable=\{effectiveIds\.length > 1\}/, "stitch playlist items should be draggable for order adjustment");
assert.match(inspectorSource, /onDrop=\{\(e\) => \{[\s\S]*?saveOrder\(reorderStitchIds\(effectiveIds, dragIndex, index\)\)/, "dropping a stitch playlist item should persist the reordered playlist");
assert.match(inspectorSource, /className="inspector-secondary-actions"/, "inline reset controls should not reuse the sticky footer action bar");

console.log("libtv-style stitch smoke passed");
