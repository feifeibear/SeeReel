import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildBytePlusSeedancePayload, resolveSeedanceModel } from "../src/server/generators";
import { inferTokenUsageModelFamily } from "../src/server/tokenUsage";
import type { ArkCredential } from "../src/server/arkCredentials";
import {
  clampSeedanceDurationSec,
  normalizeSeedanceVariant,
  seedanceReferenceLimits
} from "../src/shared/seedanceModels";
import type { Asset, Shot } from "../src/shared/types";

const inspector = readFileSync("src/client/flow/Inspector.tsx", "utf8");
assert.match(inspector, /Seedance 2\.5/, "Shot Inspector should expose Seedance 2.5");
assert.match(inspector, /value: "2\.5"/, "Shot Inspector should persist the canonical 2.5 variant");
assert.doesNotMatch(inspector, /Seedance 2\.5 \(Agent Plan\)/, "Seedance 2.5 should not be labeled Agent Plan-only");

assert.equal(normalizeSeedanceVariant("2.5"), "2.5");
assert.equal(normalizeSeedanceVariant("seedance-2-5"), "2.5");
assert.equal(normalizeSeedanceVariant("seedance-2.5"), "2.5");
assert.equal(normalizeSeedanceVariant("dreamina-seedance-2-5-260628"), "2.5");
assert.equal(normalizeSeedanceVariant("doubao-seedance-2-5-260628"), "2.5");
assert.equal(normalizeSeedanceVariant("fast"), "fast");
assert.equal(normalizeSeedanceVariant("standard"), "standard");
assert.equal(normalizeSeedanceVariant("unknown"), undefined);

assert.equal(clampSeedanceDurationSec(30, "2.5"), 30);
assert.equal(clampSeedanceDurationSec(3, "2.5"), 4);
assert.equal(clampSeedanceDurationSec(31, "2.5"), 30);
assert.equal(clampSeedanceDurationSec(30, "standard"), 15);
assert.equal(clampSeedanceDurationSec(1, "fast"), 1);
assert.deepEqual(seedanceReferenceLimits("2.5"), { image: 30, video: 10, audio: 10 });
assert.equal(seedanceReferenceLimits("standard").video, 3);
assert.equal(seedanceReferenceLimits("standard").audio, 3);

const byteplus: ArkCredential = {
  apiKey: "test-bp",
  apiBase: "https://ark.ap-southeast.bytepluses.com/api/v3",
  source: "standard",
  standardRoute: "byteplus"
};
const volcCn: ArkCredential = {
  apiKey: "test-cn",
  apiBase: "https://ark.cn-beijing.volces.com/api/v3",
  source: "standard",
  standardRoute: "volcengine-cn"
};
const agentPlan: ArkCredential = {
  apiKey: "test-plan",
  apiBase: "https://ark.cn-beijing.volces.com/api/plan/v3",
  source: "agent-plan"
};

assert.equal(resolveSeedanceModel({ seedanceVariant: "2.5" }, byteplus), "dreamina-seedance-2-5-260628");
assert.equal(resolveSeedanceModel({ seedanceVariant: "2.5" }, volcCn), "doubao-seedance-2-5-260628");
assert.equal(resolveSeedanceModel({ seedanceVariant: "2.5" }, agentPlan), "doubao-seedance-2-5-260628");
assert.equal(resolveSeedanceModel({ seedanceVariant: "standard" }, byteplus), "dreamina-seedance-2-0-260128");
assert.equal(resolveSeedanceModel({ seedanceVariant: "fast" }, byteplus), "dreamina-seedance-2-0-fast-260128");

assert.equal(inferTokenUsageModelFamily({ model: "dreamina-seedance-2-5-260628", provider: "seedance" }), "seedance-2-5");
assert.equal(inferTokenUsageModelFamily({ model: "doubao-seedance-2-5-260628", provider: "seedance" }), "seedance-2-5");
assert.equal(inferTokenUsageModelFamily({ model: "dreamina-seedance-2-0-260128", provider: "seedance" }), "seedance-2-0");
assert.equal(inferTokenUsageModelFamily({ model: "dreamina-seedance-2-0-fast-260128", provider: "seedance" }), "seedance-2-0-fast");

const now = new Date().toISOString();
function videoAsset(index: number): Asset {
  return {
    id: `asset_video_${index}`,
    type: "image",
    mediaKind: "video",
    name: `参考视频${index}`,
    prompt: `reference video ${index}`,
    mediaUrl: `https://example.com/ref-${index}.mp4`,
    createdAt: now,
    updatedAt: now
  };
}

const videos = Array.from({ length: 5 }, (_, index) => videoAsset(index + 1));
const baseShot = {
  id: "shot_seedance_25",
  sessionId: "ses_seedance_25",
  index: 1,
  title: "Shot 1",
  prompt: "cinematic hallway push-in",
  rawPrompt: "cinematic hallway push-in",
  durationSec: 30,
  assetIds: videos.map((asset) => asset.id),
  createdAt: now,
  updatedAt: now
} as Shot;

const payload25 = await buildBytePlusSeedancePayload(
  { ...baseShot, seedanceVariant: "2.5" },
  videos,
  { credential: byteplus, lang: "en" }
);
assert.equal(payload25.model, "dreamina-seedance-2-5-260628");
assert.equal(payload25.duration, 30);
assert.equal(payload25.content.filter((item) => item.role === "reference_video").length, 5);

const payload20 = await buildBytePlusSeedancePayload(
  { ...baseShot, seedanceVariant: "standard" },
  videos,
  { credential: byteplus, lang: "en" }
);
assert.equal(payload20.model, "dreamina-seedance-2-0-260128");
assert.equal(payload20.duration, 15);
assert.equal(payload20.content.filter((item) => item.role === "reference_video").length, 3);

const old25 = process.env.SEEDANCE_25_MODEL;
try {
  process.env.SEEDANCE_25_MODEL = "dreamina-seedance-2-5-override";
  assert.equal(resolveSeedanceModel({ seedanceVariant: "2.5" }, byteplus), "dreamina-seedance-2-5-override");
} finally {
  if (old25 === undefined) delete process.env.SEEDANCE_25_MODEL;
  else process.env.SEEDANCE_25_MODEL = old25;
}

console.log("smoke:seedance-25 passed");
