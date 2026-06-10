import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

const read = (file: string) => readFileSync(file, "utf8");

const types = read("src/shared/types.ts");
assert.match(types, /AssetType = .*"voice"/, "AssetType should include voice");
assert.match(types, /AssetMediaKind = .*"audio"/, "AssetMediaKind should include audio");
assert.match(types, /voicePrompt\?: string/, "voice prompt should persist on Asset");
assert.match(types, /voiceId\?: string/, "voice id should persist on Asset");
assert.match(types, /voicePreviewAudioUrl\?: string/, "voice preview audio URL should persist on Asset");

const menu = read("src/client/flow/CreateNodeMenu.tsx");
assert.match(menu, /CreateMenuOption = .*"voice"/, "create menu should expose voice option");
assert.match(menu, /key:\s*"voice"/, "create menu should list voice node");

const graph = read("src/client/flow/buildGraph.ts");
assert.match(graph, /VoiceNodeData/, "graph should define VoiceNodeData");
assert.match(graph, /type:\s*"voiceNode"/, "graph should emit voiceNode nodes");
assert.match(graph, /asset\.type === "voice"/, "graph should route voice assets separately");

const nodes = read("src/client/flow/nodes.tsx");
assert.match(nodes, /function VoiceNodeImpl/, "Voice node component should exist");
assert.match(nodes, /voicePreviewAudioUrl/, "Voice node should show preview audio state");

const inspector = read("src/client/flow/Inspector.tsx");
assert.match(inspector, /VoiceInspector/, "Voice inspector should exist");
assert.match(inspector, /generateVoicePreview/, "Voice inspector should generate preview audio");
assert.match(inspector, /selected\.kind === "voice"/, "Inspector should route voice nodes");
assert.match(inspector, /<VoiceInspector[\s\S]*onDeleteCanvasAsset=\{onDeleteCanvasAsset\}/, "Inspector should pass canvas asset deletion into VoiceInspector");
assert.match(inspector, /deleteVoice/, "Voice inspector should expose a delete action");
assert.match(inspector, /voiceAssets/, "Audio Track inspector should list voice assets");

const flowView = read("src/client/flow/FlowView.tsx");
assert.match(flowView, /isAssetBackedNodeData/, "FlowView should use one asset-backed deletion helper");
assert.match(flowView, /data\.kind === "voice"/, "Voice nodes should be treated as asset-backed nodes for canvas deletion");
assert.match(flowView, /onDeleteCanvasAsset\(data\.asset\)/, "Voice node canvas deletion should use the shared asset delete path");

const api = read("src/client/api.ts");
assert.match(api, /generateVoicePreview/, "client API should call voice preview route");
assert.match(api, /voice-preview/, "client API should use voice preview endpoint");

const server = read("src/server/index.ts");
assert.match(server, /\/api\/assets\/:assetId\/voice-preview/, "server should expose voice preview endpoint");
assert.match(server, /synthesizeViaDoubao/, "voice preview endpoint should use existing TTS generation");

const app = read("src/client/App.tsx");
assert.match(app, /Untitled voice/, "App should create voice assets");
assert.match(app, /未命名声音/, "App should create localized voice assets");

const spec = read("specs/generation-workflow.md");
assert.match(spec, /声音节点/, "spec should document Voice nodes");

console.log("voice node smoke passed");
