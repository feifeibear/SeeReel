import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync("src/client/flow/nodes.tsx", "utf8");
const appSource = readFileSync("src/client/App.tsx", "utf8");
const inspectorSource = readFileSync("src/client/flow/Inspector.tsx", "utf8");
const storeSource = readFileSync("src/server/store.ts", "utf8");
const css = readFileSync("src/client/styles.css", "utf8");

const shotNode = source.match(/function ShotNodeImpl[\s\S]*?\n}\n\n\/\/ ============================================================================\n\/\/ StitchNode/);
const referenceVideoNode = source.match(/function ReferenceVideoNodeImpl[\s\S]*?\n}\n\n\/\/ ============================================================================\n\/\/ VideoAssetNode/);
const videoAssetNode = source.match(/function VideoAssetNodeImpl[\s\S]*?\n}\n\n\/\/ ============================================================================\n\/\/ VideoProcessorNode/);
const videoProcessorNode = source.match(/function VideoProcessorNodeImpl[\s\S]*?\n}\n\n\/\/ ============================================================================\n\/\/ TailframeNode/);

assert.match(source, /function formatDurationLabel\(/, "video nodes should share duration formatting");
assert.match(source, /function VideoDurationBadge\(/, "video nodes should share an inline duration badge");
assert.match(css, /\.flow-node-duration-badge/, "duration badges should have dedicated styling");

for (const [name, body] of [
  ["ShotNodeImpl", shotNode?.[0]],
  ["ReferenceVideoNodeImpl", referenceVideoNode?.[0]],
  ["VideoAssetNodeImpl", videoAssetNode?.[0]],
  ["VideoProcessorNodeImpl", videoProcessorNode?.[0]]
] as const) {
  assert.ok(body, `${name} should exist`);
  assert.match(body, /<VideoDurationBadge/, `${name} should render the inline duration badge`);
}

assert.match(
  source,
  /selectedRender\?\.durationSec \?\? shot\.durationSec/,
  "shot nodes should prefer the selected render duration and fall back to planned shot duration"
);

assert.match(
  source,
  /asset\.clipDurationSec \?\? asset\.originalDurationSec/,
  "video asset nodes should prefer clip duration and fall back to original duration"
);

assert.match(appSource, /api\.appendShot\([\s\S]*?durationSec:\s*15/, "new canvas video nodes should default to 15 seconds in the client");
assert.match(inspectorSource, /useState<number>\(shot\.durationSec \|\| 15\)/, "Shot Inspector should fall back to a 15-second duration");
assert.match(inspectorSource, /setDurationSec\(Number\(e\.target\.value\) \|\| 15\)/, "empty duration edits should fall back to 15 seconds");
assert.match(storeSource, /partial\?\.durationSec \|\| 15/, "appendShot API should default omitted durations to 15 seconds");

console.log("video node duration badge smoke passed");
