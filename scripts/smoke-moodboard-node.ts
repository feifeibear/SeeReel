import { strict as assert } from "node:assert";
import { buildSessionGraph } from "../src/client/flow/buildGraph";
import { buildShotMentionOptions, buildStoryboardMentionOptions } from "../src/client/flow/Inspector";
import type { Asset, SessionWithShots, Shot, StoreSnapshot } from "../src/shared/types";

const now = "2026-06-08T00:00:00.000Z";

const moodboard: Asset = {
  id: "asset_moodboard",
  name: "1880s electric satire moodboard",
  type: "style",
  mediaKind: "image",
  description: "Warm gaslight palette, brass fixtures, newspaper cartoon satire.",
  prompt: "1880s New York, gaslight warmth, early electric-age anxiety, satirical comedy.",
  mediaUrl: "https://example.com/moodboard.png",
  imageUrl: "https://example.com/moodboard.png",
  ownerSessionId: "ses_moodboard",
  tags: ["moodboard", "style-reference"],
  createdAt: now,
  updatedAt: now
};

const shot: Shot = {
  id: "shot_moodboard",
  sessionId: "ses_moodboard",
  index: 1,
  title: "Electric lesson scam",
  script: "",
  camera: "",
  durationSec: 15,
  assetIds: [moodboard.id],
  rawPrompt: "Follow @1880sElectricSatireMoodboard for visual tone.",
  prompt: "Follow @1880sElectricSatireMoodboard for visual tone.",
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
  id: "ses_moodboard",
  title: "Moodboard workflow",
  logline: "",
  style: "",
  targetDurationSec: 15,
  shots: [shot],
  createdAt: now,
  updatedAt: now
};

const snapshot: StoreSnapshot = {
  sessions: [session],
  shots: [shot],
  assets: [moodboard]
};

const graph = buildSessionGraph(snapshot, session);
const moodboardNode = graph.nodes.find((node) => node.id === `image-${moodboard.id}`);
assert.ok(moodboardNode, "moodboard assets should render as unified image nodes");
assert.equal(moodboardNode?.type, "imageNode", "moodboard nodes should use the unified image renderer");

const wiredEdge = graph.edges.find((edge) => edge.source === `image-${moodboard.id}` && edge.target === `storyboard-${shot.id}`);
assert.ok(wiredEdge, "connected moodboards should wire into storyboard/shot generation references");
assert.equal((wiredEdge?.data as { assetId?: string } | undefined)?.assetId, moodboard.id);

const shotMentions = buildShotMentionOptions(shot, [moodboard], session);
assert.deepEqual(shotMentions.map((option) => option.id), [moodboard.id], "shot @ mentions should include wired moodboards");
assert.equal(shotMentions[0]?.tag, "图片");

const storyboardMentions = buildStoryboardMentionOptions(shot, [moodboard], session);
assert.deepEqual(storyboardMentions.map((option) => option.id), [moodboard.id], "storyboard @ mentions should include wired moodboards");
assert.equal(storyboardMentions[0]?.tag, "图片");

console.log("smoke:moodboard-node passed");
