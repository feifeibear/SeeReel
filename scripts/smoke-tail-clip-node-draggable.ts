import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync("src/client/flow/nodes.tsx", "utf8");
const videoAssetNode = source.match(/function VideoAssetNodeImpl[\s\S]*?\n}\n\n\/\/ ============================================================================\n\/\/ VideoProcessorNode/);
const graphSource = readFileSync("src/client/flow/buildGraph.ts", "utf8");

assert.ok(videoAssetNode, "VideoAssetNodeImpl should exist");

const body = videoAssetNode[0];
assert.match(graphSource, /tailClipVideoAssets[\s\S]*type:\s*"videoAssetNode"/, "tail-clip assets should render as standalone video nodes");
assert.match(body, /tag-shot/, "tail-clip video nodes should use the video node visual tag");
assert.match(body, /\{t\.nodes\.video\}/, "tail-clip video nodes should be labeled as video");
assert.match(body, /<RobustVideoThumb/, "tail-clip video nodes should render an inline playable video preview");
assert.doesNotMatch(source, /className="flow-video-drag-surface"/, "shared video preview should not cover native player controls with a drag surface");
assert.match(body, /api\.assetStreamUrl\(asset\.id,\s*asset\.updatedAt\s*\|\|\s*asset\.id\)/, "tail-clip video nodes should stream through the asset playback route");
assert.match(body, /api\.downloadAssetUrl\(asset\.id\)/, "tail-clip video nodes should keep the asset download route");

console.log("smoke:tail-clip-node-draggable passed");
