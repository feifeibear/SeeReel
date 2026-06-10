import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolveNodeReviewEnabled } from "../src/shared/reviewSettings";

assert.equal(resolveNodeReviewEnabled(undefined, undefined), false, "server/default review must be off");
assert.equal(resolveNodeReviewEnabled(true, undefined), false, "global true must not auto-enable VLM review");
assert.equal(resolveNodeReviewEnabled(true, true), false, "node true must not auto-enable VLM review");
assert.equal(resolveNodeReviewEnabled(false, true), false, "global false keeps review off");

const app = readFileSync("src/client/App.tsx", "utf8");
assert.doesNotMatch(app, /const visionReviewEnabled = true/, "client must not force global VLM auto review on");

const inspector = readFileSync("src/client/flow/Inspector.tsx", "utf8");
assert.doesNotMatch(inspector, /VLM 审核此节点/, "shot inspector should not expose an auto-VLM toggle");
assert.doesNotMatch(inspector, /VLM review this node/, "shot inspector should not expose an auto-VLM toggle");
assert.doesNotMatch(inspector, /VLM 审核此图片节点/, "asset inspector should not expose an auto-VLM toggle");
assert.doesNotMatch(inspector, /VLM review this image node/, "asset inspector should not expose an auto-VLM toggle");

console.log("smoke:no-auto-vlm-review passed");
