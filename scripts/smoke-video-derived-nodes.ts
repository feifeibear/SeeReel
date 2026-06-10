import assert from "node:assert/strict";
import { buildSessionGraph } from "../src/client/flow/buildGraph";

const now = "2026-06-09T00:00:00.000Z";
const session = {
  id: "ses_video_nodes",
  ownerUserId: "user_video_nodes",
  title: "Video derived nodes smoke",
  logline: "",
  style: "",
  targetDurationSec: 15,
  canvasNodePositions: {
    "frame-anchor-asset_first": { x: 111, y: 222 },
    "frame-anchor-asset_last": { x: 333, y: 444 },
    "video-asset_tail_clip": { x: 555, y: 666 }
  },
  createdAt: now,
  updatedAt: now,
  shots: [
    {
      id: "shot_one",
      sessionId: "ses_video_nodes",
      index: 1,
      title: "Video one",
      script: "",
      camera: "",
      durationSec: 15,
      assetIds: [],
      rawPrompt: "",
      prompt: "",
      status: "ready",
      videoUrl: "/media/shot-one.mp4",
      renders: [],
      createdAt: now,
      updatedAt: now
    }
  ]
};

const firstFrameAsset = {
  id: "asset_first",
  name: "Video one 首帧",
  type: "scene",
  mediaKind: "image",
  mediaUrl: "/media/first.jpg",
  imageUrl: "/media/first.jpg",
  ownerSessionId: session.id,
  tags: ["firstframe", "frame-anchor", "source-shot:shot_one"],
  createdAt: now,
  updatedAt: now
};

const lastFrameAsset = {
  id: "asset_last",
  name: "Video one 尾帧",
  type: "scene",
  mediaKind: "image",
  mediaUrl: "/media/last.jpg",
  imageUrl: "/media/last.jpg",
  ownerSessionId: session.id,
  tags: ["tailframe", "frame-anchor", "source-shot:shot_one"],
  createdAt: now,
  updatedAt: now
};

const tailClipAsset = {
  id: "asset_tail_clip",
  name: "Video one 尾段 2s",
  type: "other",
  mediaKind: "video",
  mediaUrl: "/media/tail.mp4",
  referenceImageUrl: "/media/tail.mp4",
  ownerSessionId: session.id,
  tags: ["reference-video", "tail-clip", "video-clip", "source-shot:shot_one"],
  clipDurationSec: 2,
  createdAt: now,
  updatedAt: now
};

const snapshot = {
  sessions: [session],
  shots: session.shots,
  assets: [firstFrameAsset, lastFrameAsset, tailClipAsset],
  runtime: { seedreamDefaultModel: "seedream-4-5" }
};

const graph = buildSessionGraph(snapshot as never, session as never);
const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));

assert.equal(nodeById.get("frame-anchor-asset_first")?.type, "tailframeNode", "first frame should render as a standalone frame node");
assert.equal(nodeById.get("frame-anchor-asset_last")?.type, "tailframeNode", "tail frame should render as a standalone frame node");
assert.equal(nodeById.get("video-asset_tail_clip")?.type, "videoAssetNode", "tail clip should render as a standalone video node");
assert.deepEqual(nodeById.get("frame-anchor-asset_first")?.position, { x: 111, y: 222 }, "first frame node should preserve manual canvas position");
assert.deepEqual(nodeById.get("frame-anchor-asset_last")?.position, { x: 333, y: 444 }, "tail frame node should preserve manual canvas position");
assert.deepEqual(nodeById.get("video-asset_tail_clip")?.position, { x: 555, y: 666 }, "tail clip video node should preserve manual canvas position");

const derivedSourceEdges = graph.edges.filter((edge) =>
  edge.source === "shot-shot_one"
  && ["frame-anchor-asset_first", "frame-anchor-asset_last", "video-asset_tail_clip"].includes(edge.target)
);
assert.equal(derivedSourceEdges.length, 0, "derived video buttons should not auto-create source edges");

console.log("video derived nodes smoke passed");
