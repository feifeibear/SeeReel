import assert from "node:assert/strict";
import { expandAssetPrompt } from "../src/server/generators";

async function main() {
  process.env.SEED_PROMPT_API_KEY = "";
  process.env.BP_ARK_API_KEY = "";
  process.env.ARK_API_KEY = "";

  const goldenRetriever = await expandAssetPrompt({
    type: "character",
    name: "金毛",
    prompt: "一只金毛"
  });

  assert.match(goldenRetriever.prompt, /一只金毛|金毛/);
  assert.doesNotMatch(
    goldenRetriever.prompt,
    /成年人|真实真人|人脸|五官|发型|头发|皮肤|第二人/,
    "non-human character prompts must not be expanded as human character lookbooks"
  );

  const goldenHairedPerson = await expandAssetPrompt({
    type: "character",
    name: "金发人物",
    prompt: "一个金色头发的人"
  });

  assert.match(goldenHairedPerson.prompt, /真实真人|成年人|人物|演员/);
  assert.doesNotMatch(
    goldenHairedPerson.prompt,
    /非人类角色参考底板|禁止拟人化/,
    "explicit human character prompts must keep using the human character lookbook"
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
