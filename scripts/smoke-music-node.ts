import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildSessionGraph } from "../src/client/flow/buildGraph";
import type { Asset, SessionWithShots, StoreSnapshot } from "../src/shared/types";

const now = "2026-06-10T00:00:00.000Z";
const musicAsset: Asset = {
  id: "asset_music",
  name: "Suspense BGM",
  type: "music",
  mediaKind: "audio",
  ownerSessionId: "ses_music",
  description: "低频弦乐，冷色电子脉冲",
  prompt: "低频弦乐，冷色电子脉冲",
  musicKind: "bgm",
  musicPrompt: "低频弦乐，冷色电子脉冲",
  musicDurationSec: 60,
  musicStatus: "ready",
  mediaUrl: "/media/music.mp3",
  createdAt: now,
  updatedAt: now
};

const session: SessionWithShots = {
  id: "ses_music",
  title: "Music smoke",
  logline: "",
  targetDurationSec: 60,
  shots: [],
  createdAt: now,
  updatedAt: now
};

const snapshot: StoreSnapshot = {
  sessions: [session],
  shots: [],
  assets: [musicAsset]
};

const graph = buildSessionGraph(snapshot, session);
const musicNode = graph.nodes.find((node) => node.id === "music-asset_music");
assert.ok(musicNode, "music assets should render as visible canvas nodes");
assert.equal(musicNode.type, "musicNode", "music assets should use a dedicated music node type");

const typesSource = readFileSync("src/shared/types.ts", "utf8");
assert.match(typesSource, /AssetType = [^\n]*"music"/, "AssetType should include music");
assert.match(typesSource, /musicStatus\?: "idle" \| "generating" \| "ready" \| "error"/, "Asset should persist music generation status");

const createMenuSource = readFileSync("src/client/flow/CreateNodeMenu.tsx", "utf8");
assert.match(createMenuSource, /safePick\("music"\)/, "right-click menu should support creating music nodes");
assert.match(createMenuSource, /key:\s*"music"/, "right-click menu should list a music node");

const flowSource = readFileSync("src/client/flow/FlowView.tsx", "utf8");
assert.match(flowSource, /musicNode:\s*MusicNode/, "FlowView should register MusicNode");
assert.match(flowSource, /onCreateAnchorAsset\("music"\)/, "FlowView should create music assets from the menu");
assert.match(flowSource, /if \(option === "music"\)[\s\S]*?await onMutated\(\);/, "music node creation should refresh canvas state after persisting the new asset");

const appSource = readFileSync("src/client/App.tsx", "utf8");
assert.match(appSource, /music:\s*"Untitled music"/, "English create-asset seed names should include music");
assert.match(appSource, /music:\s*"未命名音乐"/, "Chinese create-asset seed names should include music");

const nodesSource = readFileSync("src/client/flow/nodes.tsx", "utf8");
assert.match(nodesSource, /function MusicNodeImpl/, "nodes.tsx should render a MusicNodeImpl");
assert.match(nodesSource, /<audio[\s\S]*controls/, "music nodes should play generated audio inline");

const inspectorSource = readFileSync("src/client/flow/Inspector.tsx", "utf8");
assert.match(inspectorSource, /MusicInspector/, "Inspector should expose a music-node editor");
assert.match(inspectorSource, /generateMusicAsset/, "Music Inspector should trigger music generation through the client API");
assert.match(inspectorSource, /生成音乐/, "Music Inspector should show a generate music action");

const apiSource = readFileSync("src/client/api.ts", "utf8");
assert.match(apiSource, /generateMusicAsset/, "client API should expose music asset generation");
assert.match(apiSource, /music-generate/, "client API should call the music-generate route");

const serverSource = readFileSync("src/server/index.ts", "utf8");
assert.match(serverSource, /\/api\/assets\/:assetId\/music-generate/, "server should expose a music generation route");
assert.match(serverSource, /generateVolcMusic/, "server route should use the existing Volcengine music generator");

console.log("smoke:music-node passed");
