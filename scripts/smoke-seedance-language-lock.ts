import assert from "node:assert/strict";
import {
  composeSeedanceVideoText,
  enforceSpokenLanguageInstruction
} from "../src/server/promptCompose";

const zh = composeSeedanceVideoText(
  {
    shot: {
      rawPrompt: "Two men argue in a classroom. One says: \"Buy my course.\"",
      prompt: "",
      durationSec: 15
    },
    referencedAssets: [],
    resolution: "9:16"
  },
  "zh"
);

assert.match(zh.composedPrompt, /会话口语语言锁定/);
assert.match(zh.composedPrompt, /所有可听见的人物对白必须只说中文普通话/);
assert.match(zh.composedPrompt, /不要生成英语对白/);
assert.equal(zh.parts.spokenLanguage, enforceSpokenLanguageInstruction("", "zh"));

const en = composeSeedanceVideoText(
  {
    shot: {
      rawPrompt: "两个角色在街角争吵。甲说：『别买课。』",
      prompt: "",
      durationSec: 15
    },
    referencedAssets: [],
    resolution: "9:16"
  },
  "en"
);

assert.match(en.composedPrompt, /SESSION SPOKEN-LANGUAGE LOCK/);
assert.match(en.composedPrompt, /spoken in English only/);
assert.match(en.composedPrompt, /Do not generate Mandarin/);

const manualZh = enforceSpokenLanguageInstruction("manual edited prompt with English dialogue", "zh");
assert.match(manualZh, /manual edited prompt/);
assert.match(manualZh, /会话口语语言锁定/);
assert.equal(enforceSpokenLanguageInstruction(manualZh, "zh"), manualZh);

console.log("seedance language lock smoke passed");
