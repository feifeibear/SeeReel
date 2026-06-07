import assert from "node:assert/strict";
import { getMentionedSessionCastAssets } from "../src/server/castReferences";
import type { Asset, Session } from "../src/shared/types";

const session = {
  id: "ses_cast_filter",
  story: {
    characters: [
      { name: "曹操", assetId: "asset_cao", assetMention: "@曹操" },
      { name: "陈宫", assetId: "asset_chen", assetMention: "@陈宫" },
      { name: "董卓", assetId: "asset_dong", assetMention: "@董卓" }
    ]
  }
} as Session;

const assets = [
  { id: "asset_cao", name: "曹操", type: "character", tags: ["cast"], ownerSessionId: session.id },
  { id: "asset_chen", name: "陈宫", type: "character", tags: ["cast"], ownerSessionId: session.id },
  { id: "asset_dong", name: "董卓", type: "character", tags: ["cast"], ownerSessionId: session.id }
] as Asset[];

const mentioned = getMentionedSessionCastAssets(session, assets, "白门楼最后一幕：@曹操 看着刑场，不能出现其他主要角色。");

assert.deepEqual(
  mentioned.map((asset) => asset.id),
  ["asset_cao"],
  "Seedance shot references must include only session cast explicitly @mentioned in that shot"
);

assert.deepEqual(
  getMentionedSessionCastAssets(session, assets, "白门楼最后一幕：曹操看着刑场。"),
  [],
  "plain prose character names must not auto-attach the whole session cast"
);

assert.deepEqual(
  getMentionedSessionCastAssets(session, assets, "白门楼最后一幕：@曹操 看着刑场。", new Set(["asset_chen"])),
  [],
  "explicit @mentioned cast must still be wired into this shot before it can become a Seedance reference"
);

console.log("seedance cast filter smoke passed");
