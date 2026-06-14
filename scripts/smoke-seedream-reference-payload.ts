import assert from "node:assert/strict";
import { buildSeedreamImageRequestBody } from "../src/server/generators";

const prompt = [
  "参考图 1 建筑的平视图，风格保持原图一致"
].join("\n");

const refs = Array.from({ length: 16 }, (_, index) => `https://example.com/ref-${index + 1}.png`);

const liteBody = buildSeedreamImageRequestBody({
  model: "seedream-5-0-lite",
  prompt,
  image: refs,
  size: "2K",
  supportsOutputFormat: true,
  webSearchPayload: {}
});

assert.deepEqual(
  liteBody.image,
  refs.slice(0, 14),
  "Seedream payload must submit references as an ordered image array capped to the official 14-image limit"
);
assert.equal(liteBody.sequential_image_generation, "disabled", "Seedream payload must explicitly request single-image output");
assert.equal(liteBody.output_format, "png", "Seedream 5.0 Lite payload should request PNG output when supported");
assert.equal(liteBody.response_format, "url");
assert.equal(liteBody.watermark, false);

const seedream45Body = buildSeedreamImageRequestBody({
  model: "seedream-4-5-251128",
  prompt,
  image: [refs[0]],
  size: "2K",
  supportsOutputFormat: false,
  webSearchPayload: {}
});

assert.deepEqual(seedream45Body.image, [refs[0]], "single references should still be sent as image arrays for stable image 1 binding");
assert.equal(seedream45Body.sequential_image_generation, "disabled");
assert.ok(!("output_format" in seedream45Body), "Seedream 4.5/4.0 must not receive unsupported output_format");

console.log("seedream reference payload smoke passed");
