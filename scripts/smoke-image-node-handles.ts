import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/client/flow/nodes.tsx", import.meta.url), "utf8");
const assetNodeStart = source.indexOf("function AssetNodeImpl");
const assetNodeEnd = source.indexOf("// ============================================================================\n// StoryboardNode", assetNodeStart);
assert.ok(assetNodeStart >= 0 && assetNodeEnd > assetNodeStart, "AssetNodeImpl source block should be present");

const assetNodeSource = source.slice(assetNodeStart, assetNodeEnd);
assert.match(
  assetNodeSource,
  /<Handle\s+type="target"\s+position=\{Position\.Left\}\s+id="in"\s*\/>/,
  "unified image nodes need a left target handle so image nodes can connect into image nodes"
);
assert.match(
  assetNodeSource,
  /<Handle\s+type="source"\s+position=\{Position\.Right\}\s+id="out"\s*\/>/,
  "unified image nodes need a right source handle"
);

console.log("smoke:image-node-handles passed");
