import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { VOICE_PRESETS, voicePresetForId } from "../src/shared/voicePresets";

assert.ok(VOICE_PRESETS.length >= 5, "voice preset list should expose several selectable voices");
assert.ok(VOICE_PRESETS.some((voice) => voice.id === "young-female" && voice.voiceId === "BV001_streaming"), "young female preset should be available");
assert.ok(VOICE_PRESETS.some((voice) => voice.id === "dongbei-female" && voice.voiceId === "BV020_streaming"), "Northeast female preset should be available");
assert.equal(voicePresetForId("BV020_streaming")?.labelZh, "东北丫头", "lookup by voice id should find the preset");

const types = readFileSync("src/shared/types.ts", "utf8");
assert.match(types, /voicePresetId\?: string/, "Asset should persist selected voice preset id");

const inspector = readFileSync("src/client/flow/Inspector.tsx", "utf8");
assert.match(inspector, /VOICE_PRESETS/, "Voice inspector should render preset choices from the shared list");
assert.match(inspector, /voice-preset-grid/, "Voice inspector should render a preset grid");
assert.match(inspector, /voice-preset-card/, "Voice inspector should render preset cards");
assert.match(inspector, /setVoiceId\(preset\.voiceId\)/, "Selecting a preset should write its voice id");
assert.match(inspector, /voicePresetId/, "Voice inspector should persist selected preset id");

const nodes = readFileSync("src/client/flow/nodes.tsx", "utf8");
assert.match(nodes, /voicePresetForId/, "Voice node should display the selected preset");
assert.match(nodes, /voice-node-preset/, "Voice node should show a preset-style visual body");

const styles = readFileSync("src/client/styles.css", "utf8");
assert.match(styles, /\.voice-preset-grid/, "Preset grid styles should exist");
assert.match(styles, /\.voice-preset-card/, "Preset card styles should exist");
assert.match(styles, /\.voice-node-preset/, "Voice node preset body styles should exist");

console.log("smoke:voice-preset-selector passed");
