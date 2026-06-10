import assert from "node:assert/strict";
import { expandAssetPrompt, generateAssetImage } from "../src/server/generators";
import { composeSeedanceVideoText } from "../src/server/promptCompose";

async function main() {
  process.env.SEED_PROMPT_API_KEY = "";
  process.env.BP_ARK_API_KEY = "";
  process.env.ARK_API_KEY = "";
  process.env.SEEDANCE_RATIO = "";

  const userPrompt = "一只金毛坐在蓝色沙发上";
  const goldenRetriever = await expandAssetPrompt({
    type: "character",
    name: "金毛",
    prompt: userPrompt
  });

  assert.equal(goldenRetriever.prompt, userPrompt, "image prompt expansion must be a no-op");

  const imageResult = await generateAssetImage({
    id: "asset_prompt_no_rewrite",
    type: "character",
    name: "金毛",
    prompt: userPrompt,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }, "seedream-4-5");

  assert.equal(imageResult.composedPrompt, userPrompt, "Seedream prompt must submit user text verbatim");

  assert.doesNotMatch(
    imageResult.composedPrompt,
    /ARRI|STRICT NEGATIVE|角色参考底板|lookbook|cinematography|no text/i,
    "Seedream prompt must not include system expansion templates"
  );

  const videoPrompt = "镜头从电梯门打开开始，王木走进会议室，停在空椅前沉默三秒";
  const video = composeSeedanceVideoText({
    shot: { rawPrompt: videoPrompt, prompt: videoPrompt, durationSec: 15 },
    referencedAssets: [{
      id: "asset_ref",
      type: "scene",
      name: "会议室",
      prompt: "现代会议室",
      mediaKind: "image",
      mediaUrl: "https://example.com/room.png",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }],
    resolution: "9:16"
  }, "zh");

  assert.equal(video.composedPrompt, videoPrompt, "Seedance prompt composition must keep only user text");
  assert.deepEqual(video.parts, { raw: videoPrompt });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
