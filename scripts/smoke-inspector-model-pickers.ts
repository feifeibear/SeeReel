import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const inspector = readFileSync("src/client/flow/Inspector.tsx", "utf8");
const nodes = readFileSync("src/client/flow/nodes.tsx", "utf8");

const assetInspector = inspector.match(/function AssetInspector[\s\S]*?\n}\n\n\/\/ ============================================================================\n\/\/ Storyboard inspector/);
assert.ok(assetInspector, "AssetInspector component should exist");
assert.match(assetInspector[0], /图片模型|Image model/, "image model picker should live in AssetInspector");
assert.match(assetInspector[0], /generationModel/, "AssetInspector should persist the selected image model on the asset");

const shotInspector = inspector.match(/function ShotInspector[\s\S]*?\n}\n\n\/\/ ============================================================================\n\/\/ Stitch inspector/);
assert.ok(shotInspector, "ShotInspector component should exist");
assert.match(shotInspector[0], /Seedance 模型|Seedance model/, "video model picker should live in ShotInspector");
assert.match(shotInspector[0], /seedanceVariant/, "ShotInspector should persist the selected Seedance variant on the shot");

const assetNode = nodes.match(/function AssetNodeImpl[\s\S]*?\n}\n\n\/\/ ============================================================================\n\/\/ StoryboardNode/);
assert.ok(assetNode, "AssetNode component should exist");
assert.doesNotMatch(assetNode[0], /NodeModelPicker<AssetImageModel>/, "image model picker should not render on the canvas node");

console.log("smoke:inspector-model-pickers passed");
