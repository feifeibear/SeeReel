import assert from "node:assert/strict";
import { buildSessionGraph } from "../src/client/flow/buildGraph";

const now = "2026-06-08T00:00:00.000Z";
const session = {
  id: "ses_layout",
  ownerUserId: "user_layout",
  title: "Layout smoke",
  logline: "",
  style: "",
  targetDurationSec: 30,
  canvasNodePositions: {
    "asset-asset_character": { x: 333, y: 444 },
    "shot-shot_one": { x: 777, y: 888 },
    "stitch-ses_layout-stitch_one": { x: 1111, y: 222 }
  },
  stitchJobs: [{ id: "stitch_one", name: "Manual stitch", shotIds: ["shot_one"], status: "idle", createdAt: now, updatedAt: now }],
  createdAt: now,
  updatedAt: now,
  shots: [
    {
      id: "shot_one",
      sessionId: "ses_layout",
      index: 1,
      title: "Shot one",
      script: "",
      camera: "",
      durationSec: 15,
      assetIds: ["asset_character"],
      rawPrompt: "",
      prompt: "",
      status: "draft",
      renders: [],
      createdAt: now,
      updatedAt: now
    }
  ]
};

const snapshot = {
  sessions: [session],
  shots: session.shots,
  assets: [
    {
      id: "asset_character",
      name: "Character",
      type: "character",
      mediaKind: "none",
      description: "",
      prompt: "",
      ownerSessionId: "ses_layout",
      tags: ["anchor", "character"],
      createdAt: now,
      updatedAt: now
    }
  ],
  runtime: { seedreamDefaultModel: "seedream-4-5" }
};

const graph = buildSessionGraph(snapshot as never, session as never);
const positions = new Map(graph.nodes.map((node) => [node.id, node.position]));

assert.deepEqual(positions.get("asset-asset_character"), { x: 333, y: 444 });
assert.deepEqual(positions.get("shot-shot_one"), { x: 777, y: 888 });
assert.deepEqual(positions.get("stitch-ses_layout-stitch_one"), { x: 1111, y: 222 });

console.log("smoke:canvas-node-layout passed");
