import assert from "node:assert/strict";
import { buildSessionGraph } from "../src/client/flow/buildGraph";
import { buildShotMentionOptions, buildStoryboardMentionOptions } from "../src/client/flow/Inspector";
import type { Asset, SessionWithShots, Shot, StoreSnapshot } from "../src/shared/types";

const now = "2026-06-09T00:00:00.000Z";

const imageAssets: Asset[] = [
  {
    id: "asset_character",
    name: "Old character ref",
    type: "character",
    mediaKind: "image",
    description: "legacy character asset",
    prompt: "",
    ownerSessionId: "ses_images",
    tags: ["anchor", "character"],
    createdAt: now,
    updatedAt: now
  },
  {
    id: "asset_scene",
    name: "Old scene ref",
    type: "scene",
    mediaKind: "image",
    description: "legacy scene asset",
    prompt: "",
    ownerSessionId: "ses_images",
    tags: ["anchor", "scene"],
    referenceAssetIds: ["asset_character"],
    createdAt: now,
    updatedAt: now
  },
  {
    id: "asset_mood",
    name: "Moodboard ref",
    type: "style",
    mediaKind: "image",
    description: "legacy moodboard asset",
    prompt: "",
    ownerSessionId: "ses_images",
    tags: ["moodboard", "style-reference"],
    createdAt: now,
    updatedAt: now
  }
];

const shot: Shot = {
  id: "shot_one",
  sessionId: "ses_images",
  index: 1,
  title: "Shot one",
  script: "",
  camera: "",
  durationSec: 15,
  assetIds: imageAssets.map((asset) => asset.id),
  rawPrompt: "",
  prompt: "",
  debugNote: "",
  seedanceVariant: "standard",
  usePreviousShotClip: false,
  renders: [],
  status: "draft",
  subShotPanelCount: 9,
  createdAt: now,
  updatedAt: now
};

const session: SessionWithShots = {
  id: "ses_images",
  title: "Simplified image canvas",
  logline: "",
  style: "",
  targetDurationSec: 15,
  canvasNodePositions: {
    "asset-asset_character": { x: 321, y: 654 }
  },
  shots: [shot],
  createdAt: now,
  updatedAt: now
};

const snapshot: StoreSnapshot = {
  sessions: [session],
  shots: [shot],
  assets: imageAssets
};

const graph = buildSessionGraph(snapshot, session);
for (const asset of imageAssets) {
  const node = graph.nodes.find((item) => item.id === `image-${asset.id}`);
  assert.ok(node, `${asset.type} assets should render as unified image nodes`);
  assert.equal(node?.type, "imageNode");
  assert.equal(node?.data.kind, "image");
}

assert.deepEqual(
  graph.nodes.find((item) => item.id === "image-asset_character")?.position,
  { x: 321, y: 654 },
  "image nodes should preserve legacy asset-* saved positions"
);

const imageToImageEdge = graph.edges.find((edge) => edge.source === "image-asset_character" && edge.target === "image-asset_scene");
assert.ok(imageToImageEdge, "image nodes should connect to image nodes for image editing references");
assert.equal((imageToImageEdge?.data as { canDisconnectAssetReference?: boolean }).canDisconnectAssetReference, true);

const shotMentionTags = buildShotMentionOptions(shot, imageAssets, session).map((option) => option.tag);
assert.deepEqual(shotMentionTags, ["图片", "图片", "图片"], "wired visual references should appear as image mentions");

const storyboardMentionTags = buildStoryboardMentionOptions(shot, imageAssets, session).map((option) => option.tag);
assert.deepEqual(storyboardMentionTags, ["图片", "图片", "图片"], "storyboard references should appear as image mentions");

console.log("smoke:image-node-simplified passed");
