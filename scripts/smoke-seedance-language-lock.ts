import assert from "node:assert/strict";
import { composeSeedanceVideoText } from "../src/server/promptCompose";

const zhPrompt = "Two men argue in a classroom. One says: \"Buy my course.\"";

const zh = composeSeedanceVideoText(
  {
    shot: {
      rawPrompt: zhPrompt,
      prompt: "",
      durationSec: 15
    },
    referencedAssets: [],
    resolution: "9:16"
  },
  "zh"
);

assert.equal(zh.composedPrompt, zhPrompt);
assert.deepEqual(zh.parts, { raw: zhPrompt });
assert.doesNotMatch(zh.composedPrompt, /会话口语语言锁定|不要生成英语对白/);

const enPrompt = "两个角色在街角争吵。甲说：『别买课。』";

const en = composeSeedanceVideoText(
  {
    shot: {
      rawPrompt: enPrompt,
      prompt: "",
      durationSec: 15
    },
    referencedAssets: [],
    resolution: "9:16"
  },
  "en"
);

assert.equal(en.composedPrompt, enPrompt);
assert.deepEqual(en.parts, { raw: enPrompt });
assert.doesNotMatch(en.composedPrompt, /SESSION SPOKEN-LANGUAGE LOCK|Do not generate Mandarin/);

console.log("seedance prompt ownership smoke passed");
