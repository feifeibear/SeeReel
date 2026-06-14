import assert from "node:assert/strict";
import { normalizeAssetImageModel, resolveAssetImageModelSelection } from "../src/shared/imageModels";
import { resolveSeedreamModelIds } from "../src/server/generators";

assert.equal(normalizeAssetImageModel("seedream-5.0-lite"), "seedream-5-lite");
assert.equal(normalizeAssetImageModel("doubao-seedream-5.0-lite"), "seedream-5-lite");
assert.equal(normalizeAssetImageModel("seedream-5-lite"), "seedream-5-lite");
assert.equal(normalizeAssetImageModel("seedream-4-5"), "seedream-4-5");
assert.equal(normalizeAssetImageModel("seedream-4"), "seedream-4");
assert.equal(normalizeAssetImageModel("gpt-image-2"), "gpt-image-2");
assert.equal(normalizeAssetImageModel("unknown-model"), undefined);

assert.equal(
  resolveAssetImageModelSelection({
    generationModel: "seedream-5-lite",
    generationModelActual: "doubao-seedream-4-5-251128"
  }),
  "seedream-5-lite",
  "saved Inspector model choice should not be overridden by the previous actual model"
);

const old50 = process.env.SEEDREAM_50_LITE_MODEL;
const old5 = process.env.SEEDREAM_5_LITE_MODEL;
const oldAgentPlan = process.env.SEEDREAM_AGENT_PLAN_MODEL;
try {
  delete process.env.SEEDREAM_AGENT_PLAN_MODEL;
  process.env.SEEDREAM_50_LITE_MODEL = "seedream-5-0-lite-bp";
  delete process.env.SEEDREAM_5_LITE_MODEL;
  assert.deepEqual(
    resolveSeedreamModelIds("seedream-5-lite", false),
    ["seedream-5-0-lite-bp"],
    "standard BP/CN Seedream 5.0 Lite should use the non-Agent-Plan model override"
  );

  delete process.env.SEEDREAM_50_LITE_MODEL;
  process.env.SEEDREAM_5_LITE_MODEL = "seedream-5-lite-bp";
  assert.deepEqual(resolveSeedreamModelIds("seedream-5-lite", false), ["seedream-5-lite-bp"]);
} finally {
  if (old50 === undefined) delete process.env.SEEDREAM_50_LITE_MODEL;
  else process.env.SEEDREAM_50_LITE_MODEL = old50;
  if (old5 === undefined) delete process.env.SEEDREAM_5_LITE_MODEL;
  else process.env.SEEDREAM_5_LITE_MODEL = old5;
  if (oldAgentPlan === undefined) delete process.env.SEEDREAM_AGENT_PLAN_MODEL;
  else process.env.SEEDREAM_AGENT_PLAN_MODEL = oldAgentPlan;
}

console.log("smoke:seedream-image-model passed");
