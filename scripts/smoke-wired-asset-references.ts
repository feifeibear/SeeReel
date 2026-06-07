import { strict as assert } from "node:assert";
import { buildShotMentionOptions, buildStoryboardMentionOptions } from "../src/client/flow/Inspector";
import { CinemaStore } from "../src/server/store";
import type { Asset, SessionWithShots, Shot, StoreSnapshot } from "../src/shared/types";

const now = "2026-06-07T00:00:00.000Z";

const connectedAsset: Asset = {
  id: "asset_connected",
  name: "Connected Actor",
  type: "character",
  mediaKind: "image",
  description: "old description",
  prompt: "old prompt",
  mediaUrl: "https://example.com/old-connected.png",
  imageUrl: "https://example.com/old-connected.png",
  ownerSessionId: "ses_refs",
  tags: ["connected"],
  createdAt: now,
  updatedAt: now
};

const updatedConnectedAsset: Asset = {
  ...connectedAsset,
  description: "latest description",
  prompt: "latest prompt",
  mediaUrl: "https://example.com/latest-connected.png",
  imageUrl: "https://example.com/latest-connected.png",
  updatedAt: "2026-06-07T01:00:00.000Z"
};

const unconnectedAsset: Asset = {
  id: "asset_unconnected",
  name: "Deleted Looking Asset",
  type: "character",
  mediaKind: "image",
  description: "should not be referenced",
  prompt: "should not be referenced",
  mediaUrl: "https://example.com/unconnected.png",
  imageUrl: "https://example.com/unconnected.png",
  ownerSessionId: "ses_refs",
  tags: ["deleted-looking"],
  createdAt: now,
  updatedAt: now
};

const shot: Shot = {
  id: "shot_refs",
  sessionId: "ses_refs",
  index: 1,
  title: "Reference test shot",
  script: "",
  camera: "",
  durationSec: 15,
  assetIds: [connectedAsset.id],
  rawPrompt: "Only @ConnectedActor should resolve. @DeletedLookingAsset is stale text.",
  prompt: "Only @ConnectedActor should resolve. @DeletedLookingAsset is stale text.",
  debugNote: "",
  seedanceVariant: "standard",
  usePreviousShotClip: false,
  renders: [],
  status: "draft",
  createdAt: now,
  updatedAt: now
};

const session: SessionWithShots = {
  id: "ses_refs",
  title: "Reference Session",
  logline: "",
  style: "",
  targetDurationSec: 15,
  shots: [shot],
  createdAt: now,
  updatedAt: now
};

const assets = [updatedConnectedAsset, unconnectedAsset];

const shotOptions = buildShotMentionOptions(shot, assets, session);
assert.deepEqual(
  shotOptions.map((option) => option.id),
  [connectedAsset.id],
  "shot @ mentions should list only assets wired into this shot"
);

const storyboardOptions = buildStoryboardMentionOptions(shot, assets, session);
assert.deepEqual(
  storyboardOptions.map((option) => option.id),
  [connectedAsset.id],
  "storyboard @ mentions should list only assets wired into this storyboard/shot"
);

const store = new CinemaStore();
(store as unknown as { data: StoreSnapshot }).data = {
  sessions: [session],
  shots: [shot],
  assets
};

const referenced = store.getAssetsForShot(shot);
assert.deepEqual(
  referenced.map((asset) => asset.id),
  [connectedAsset.id],
  "server shot reference resolver must ignore @mentions that are not backed by a canvas edge"
);
assert.equal(
  referenced[0]?.prompt,
  "latest prompt",
  "server shot reference resolver should read the latest asset fields by id at generation time"
);
assert.equal(
  referenced[0]?.mediaUrl,
  "https://example.com/latest-connected.png",
  "server shot reference resolver should read the latest asset media URL by id at generation time"
);

console.log("wired asset references smoke passed");
