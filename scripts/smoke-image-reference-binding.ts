import assert from "node:assert/strict";
import { composeSeedreamAssetPrompt } from "../src/server/promptCompose";
import type { Asset } from "../src/shared/types";

const now = new Date().toISOString();

const target: Pick<Asset, "prompt" | "description" | "name" | "type"> = {
  type: "image",
  name: "三视图",
  description: "",
  prompt: "@兵营 建筑的平视图，沿用 @屋顶 的红色材质，风格保持原图一致"
};

const barracks: Asset = {
  id: "asset_barracks",
  type: "image",
  mediaKind: "image",
  name: "兵营",
  prompt: "红色警戒 2 苏联兵营参考图，红色屋顶、混凝土墙体、军工建筑比例",
  mediaUrl: "https://example.com/barracks.png",
  createdAt: now,
  updatedAt: now
};

const roof: Asset = {
  id: "asset_roof",
  type: "image",
  mediaKind: "image",
  name: "屋顶",
  prompt: "红色金属屋顶参考图，边缘有工业铆钉",
  mediaUrl: "https://example.com/roof.png",
  createdAt: now,
  updatedAt: now
};

const prompt = composeSeedreamAssetPrompt(target, true, "zh", { referenceAssets: [barracks, roof] }).composedPrompt;

assert.ok(prompt.startsWith("参考图 1 建筑的平视图"), "Seedream image prompt should rewrite @ image handles to reference-image labels");
assert.match(prompt.split("\n\n")[0], /参考图 2 的红色材质/, "Seedream image prompt should number multiple @ image handles in submitted-reference order");
assert.doesNotMatch(prompt.split("\n\n")[0], /@兵营|@屋顶/, "Seedream image prompt body should not keep raw @ handles after reference rewrite");
assert.doesNotMatch(prompt, /参考图绑定|图\s*1\s*=|@兵营|@屋顶/, "Seedream image prompt must not append a reference binding section");

console.log("image reference binding smoke passed");
