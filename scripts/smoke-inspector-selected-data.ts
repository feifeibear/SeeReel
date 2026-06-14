import assert from "node:assert/strict";
import { resolveFreshSelectedData } from "../src/client/flow/selectedData";
import type { Asset, SessionWithShots, StoreSnapshot } from "../src/shared/types";
import type { FlowNodeData } from "../src/client/flow/buildGraph";

const now = "2026-06-11T00:00:00.000Z";

const staleAsset: Asset = {
  id: "asset_image",
  name: "Image node",
  type: "image",
  mediaKind: "image",
  description: "",
  prompt: "",
  mediaUrl: "/media/old-preview.jpg",
  imageUrl: "/media/old-preview.jpg",
  thumbnailUrl: "/media/old-preview.jpg",
  ownerSessionId: "ses_image",
  tags: ["anchor", "image"],
  createdAt: now,
  updatedAt: now
};

const freshAsset: Asset = {
  ...staleAsset,
  mediaUrl: "/media/new-preview.jpg",
  imageUrl: "/media/new-preview.jpg",
  thumbnailUrl: "/media/new-preview.jpg",
  sourceImageUrl: "https://seedream.example.com/new-original.png",
  generatedAt: "2026-06-11T00:01:00.000Z",
  updatedAt: "2026-06-11T00:01:00.000Z"
};

const session: SessionWithShots = {
  id: "ses_image",
  title: "Image Inspector",
  logline: "",
  style: "",
  targetDurationSec: 15,
  shots: [],
  createdAt: now,
  updatedAt: now
};

const snapshot: StoreSnapshot = {
  sessions: [session],
  shots: [],
  assets: [freshAsset]
};

const selected: FlowNodeData = {
  kind: "image",
  asset: staleAsset,
  referenceAssets: [staleAsset],
  defaultImageModel: "seedream-4-5"
};

const resolved = resolveFreshSelectedData(selected, snapshot, session);
assert.equal(resolved?.kind, "image");
if (resolved?.kind !== "image") throw new Error("expected image node data");

assert.equal(resolved.asset.mediaUrl, "/media/new-preview.jpg", "Inspector should render the latest asset mediaUrl");
assert.equal(resolved.asset.thumbnailUrl, "/media/new-preview.jpg", "Inspector should render the latest asset thumbnail");
assert.equal(resolved.asset.sourceImageUrl, "https://seedream.example.com/new-original.png", "Inspector should retain latest source image");
assert.equal(resolved.referenceAssets?.[0]?.mediaUrl, "/media/new-preview.jpg", "reference chips should also use latest assets");

console.log("smoke:inspector-selected-data passed");
