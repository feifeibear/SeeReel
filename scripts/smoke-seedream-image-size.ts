import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const types = readFileSync("src/shared/types.ts", "utf8");
const generators = readFileSync("src/server/generators.ts", "utf8");
const server = readFileSync("src/server/index.ts", "utf8");
const api = readFileSync("src/client/api.ts", "utf8");
const inspector = readFileSync("src/client/flow/Inspector.tsx", "utf8");

assert.match(types, /export type AssetImageSize = "2K" \| "4K"/, "shared types should define Seedream image size choices");
assert.match(types, /seedreamSize\?: AssetImageSize/, "assets should persist the selected Seedream size");

assert.match(generators, /size\?: AssetImageSize/, "Seedream generation options should accept an image size");
assert.match(generators, /process\.env\.SEEDREAM_SIZE[\s\S]*\|\|\s*"2K"/, "Seedream size should default to 2K when unset");
assert.doesNotMatch(generators, /process\.env\.SEEDREAM_SIZE\s*\|\|\s*"4K"/, "Seedream size must no longer default to 4K");

assert.match(server, /reqBody\.seedreamSize/, "asset generation route should read requested Seedream size");
assert.match(server, /seedreamSize:\s*seedreamSize/, "asset generation should persist the chosen Seedream size");

assert.match(api, /seedreamSize\?: AssetImageSize/, "client generateAsset API should accept Seedream size");

const assetInspector = inspector.match(/function AssetInspector[\s\S]*?\n}\n\n\/\/ ============================================================================\n\/\/ Storyboard inspector/);
assert.ok(assetInspector, "AssetInspector component should exist");
assert.match(assetInspector[0], /图片分辨率|Image resolution/, "AssetInspector should render an image resolution picker");
assert.match(assetInspector[0], /seedreamSize/, "AssetInspector should persist the selected image resolution");
assert.match(assetInspector[0], /2K/, "AssetInspector should offer 2K");
assert.match(assetInspector[0], /4K/, "AssetInspector should offer 4K");

console.log("smoke:seedream-image-size passed");
