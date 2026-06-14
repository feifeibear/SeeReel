import assert from "node:assert/strict";
import { buildBytePlusSeedancePayload } from "../src/server/generators";
import { composeSeedanceVideoText } from "../src/server/promptCompose";
import type { Asset, Shot } from "../src/shared/types";

const now = new Date().toISOString();
const prompt = "@兵营 前方，动员兵 4x12 方阵正步通过，承接 @尾段参考 的运动节奏，跟随 @鼓点参考 的节拍，高喊 for the union!";

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

const tailClip: Asset = {
  id: "asset_tail",
  type: "image",
  mediaKind: "video",
  name: "尾段参考",
  prompt: "上一镜最后两秒的镜头运动和节奏",
  mediaUrl: "https://example.com/tail.mp4",
  createdAt: now,
  updatedAt: now
};

const drumBeat: Asset = {
  id: "asset_drum",
  type: "music",
  mediaKind: "audio",
  name: "鼓点参考",
  prompt: "整齐、低频、军乐鼓点节拍",
  mediaUrl: "https://example.com/drum.mp3",
  createdAt: now,
  updatedAt: now
};

const composed = composeSeedanceVideoText({
  shot: { rawPrompt: prompt, prompt, durationSec: 15 },
  referencedAssets: [barracks, tailClip, drumBeat],
  resolution: "9:16"
}, "zh");

assert.ok(composed.composedPrompt.startsWith("【Pictures 1】"), "Seedance text should rewrite @ image handles to Playground-style media labels");
assert.match(composed.composedPrompt.split("\n\n")[0], /【Video 1】/, "Seedance text should rewrite @ video handles to Playground-style media labels");
assert.match(composed.composedPrompt.split("\n\n")[0], /【Audio 1】/, "Seedance text should rewrite @ audio handles to Playground-style media labels");
assert.doesNotMatch(composed.composedPrompt.split("\n\n")[0], /@兵营|@尾段参考|@鼓点参考/, "Seedance text body should not keep raw @ handles after Playground-style rewrite");
assert.match(composed.composedPrompt, /Seedance 参考绑定|参考资产清单/, "Seedance text must append reference binding metadata");
assert.match(composed.composedPrompt, /参考图\s*1[^\n]*reference_image\s*1[^\n]*@兵营/, "Seedance text must bind reference_image 1 to @兵营");
assert.match(composed.composedPrompt, /参考视频\s*1[^\n]*reference_video\s*1[^\n]*@尾段参考/, "Seedance text must bind reference_video 1 to @尾段参考");
assert.match(composed.composedPrompt, /参考音频\s*1[^\n]*reference_audio\s*1[^\n]*@鼓点参考/, "Seedance text must bind reference_audio 1 to @鼓点参考");
assert.match(composed.composedPrompt, /参考图\s*1 \/ Pictures 1/, "Seedance image binding should mirror BytePlus Playground labels");
assert.match(composed.composedPrompt, /参考视频\s*1 \/ Video 1/, "Seedance video binding should mirror BytePlus Playground labels");
assert.match(composed.composedPrompt, /参考音频\s*1 \/ Audio 1/, "Seedance audio binding should mirror BytePlus Playground labels");
assert.doesNotMatch(composed.composedPrompt, /reference_video[^\n]*image 资产/, "Seedance video binding must describe the submitted media role, not the library asset type");
assert.match(composed.composedPrompt, /不是普通文字概念/, "Seedance text must tell the model @XXX names are attached reference media");

const noMention = composeSeedanceVideoText({
  shot: { rawPrompt: "兵营前方有方阵通过", prompt: "", durationSec: 15 },
  referencedAssets: [barracks],
  resolution: "9:16"
}, "zh");
assert.equal(noMention.composedPrompt, "兵营前方有方阵通过", "plain prose asset names must not trigger hidden binding");

const payload = await buildBytePlusSeedancePayload(
  {
    id: "shot_seedance_binding",
    sessionId: "ses_seedance_binding",
    index: 1,
    title: "Shot 1",
    prompt,
    rawPrompt: prompt,
    durationSec: 15,
    assetIds: [barracks.id],
    createdAt: now,
    updatedAt: now
  } as Shot,
  [barracks, tailClip, drumBeat],
  { prebuiltText: prompt, lang: "zh" }
);

const textItem = payload.content.find((item) => item.type === "text");
assert.equal(textItem?.text, payload.composedText);
assert.match(payload.composedText.split("\n\n")[0], /【Pictures 1】/, "prebuilt Seedance payload text must rewrite image @ handles");
assert.match(payload.composedText.split("\n\n")[0], /【Video 1】/, "prebuilt Seedance payload text must rewrite video @ handles");
assert.match(payload.composedText.split("\n\n")[0], /【Audio 1】/, "prebuilt Seedance payload text must rewrite audio @ handles");
assert.match(payload.composedText, /参考图\s*1[^\n]*reference_image\s*1[^\n]*@兵营/, "prebuilt Seedance payload text must still include image binding metadata");
assert.match(payload.composedText, /参考视频\s*1[^\n]*reference_video\s*1[^\n]*@尾段参考/, "prebuilt Seedance payload text must still include video binding metadata");
assert.match(payload.composedText, /参考音频\s*1[^\n]*reference_audio\s*1[^\n]*@鼓点参考/, "prebuilt Seedance payload text must still include audio binding metadata");
assert.equal(payload.content.filter((item) => item.role === "reference_image").length, 1);
assert.equal(payload.content.filter((item) => item.role === "reference_video").length, 1);
assert.equal(payload.content.filter((item) => item.role === "reference_audio").length, 1);

console.log("seedance reference binding smoke passed");
