import assert from "node:assert/strict";
import { buildLocalStoryPlan } from "../src/server/generators";
import type { Asset, SessionWithShots, Shot } from "../src/shared/types";

function shot(id: string, index: number, assetIds: string[] = []): Shot {
  return {
    id,
    sessionId: "ses_new",
    index,
    title: `Shot ${index}`,
    script: "",
    camera: "",
    durationSec: 15,
    assetIds,
    prompt: ""
  };
}

const session: SessionWithShots = {
  id: "ses_new",
  title: "2026 世界杯 MV",
  logline: "全球球迷在同一声呐喊里奔向美加墨世界杯。",
  style: "cinematic sports music video",
  targetDurationSec: 30,
  shots: [shot("shot_1", 1), shot("shot_2", 2)]
};

const oldGlobalAssets: Asset[] = [
  {
    id: "asset_old_cao",
    name: "曹操",
    type: "character",
    mediaKind: "image",
    description: "旧项目角色",
    prompt: "三国人物",
    tags: ["old"]
  },
  {
    id: "asset_old_chen",
    name: "陈宫",
    type: "character",
    mediaKind: "image",
    description: "旧项目角色",
    prompt: "三国人物",
    tags: ["old"]
  }
];

const cleanStory = buildLocalStoryPlan(session, oldGlobalAssets);
const cleanText = JSON.stringify(cleanStory);
assert.equal(cleanStory.characters.length, 0, "unowned global characters must not become StoryPlan cast");
assert(!cleanText.includes("曹操"), "old global asset name leaked into local story plan");
assert(!cleanText.includes("陈宫"), "old global asset name leaked into local story plan");
assert(!cleanText.includes("@曹操"), "old global asset mention leaked into beats");
assert(!cleanText.includes("@陈宫"), "old global asset mention leaked into beats");

const scopedAsset: Asset = {
  id: "asset_session_ball_kid",
  ownerSessionId: "ses_new",
  name: "球童",
  type: "character",
  mediaKind: "image",
  description: "本次世界杯 MV 的引导角色",
  prompt: "stadium ball kid",
  tags: ["current"]
};

const scopedStory = buildLocalStoryPlan(session, [...oldGlobalAssets, scopedAsset]);
const scopedText = JSON.stringify(scopedStory);
assert(scopedText.includes("球童"), "session-owned asset should remain available to planning");
assert(!scopedText.includes("曹操"), "old global asset leaked when session-owned assets exist");
assert(!scopedText.includes("陈宫"), "old global asset leaked when session-owned assets exist");

const wiredSession: SessionWithShots = {
  ...session,
  shots: [shot("shot_1", 1, ["asset_global_wired"]), shot("shot_2", 2)]
};
const wiredAsset: Asset = {
  id: "asset_global_wired",
  name: "主视觉奖杯",
  type: "prop",
  mediaKind: "image",
  description: "被当前 shot 显式连线的全局资产",
  prompt: "world cup trophy visual",
  tags: ["global"]
};

const wiredStory = buildLocalStoryPlan(wiredSession, [...oldGlobalAssets, wiredAsset]);
const wiredText = JSON.stringify(wiredStory);
assert(wiredText.includes("主视觉奖杯"), "explicitly wired global asset should remain available");
assert(!wiredText.includes("曹操"), "unwired old global asset leaked beside wired global asset");
assert(!wiredText.includes("陈宫"), "unwired old global asset leaked beside wired global asset");

console.log("smoke-session-asset-scope: ok");
