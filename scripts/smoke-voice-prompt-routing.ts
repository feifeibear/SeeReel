import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import {
  inferVolcTtsResourceIdForVoice,
  resolveVoiceIdFromVoicePrompt,
  resolveVolcTtsResourceCandidates
} from "../src/server/narration";

assert.equal(
  resolveVoiceIdFromVoicePrompt({ voicePrompt: "20 岁女人声音，东北话" }),
  "BV020_streaming",
  "Northeast female prompt should resolve to the Northeast female TTS voice"
);

assert.equal(
  resolveVoiceIdFromVoicePrompt({ voicePrompt: "40 岁男人声音，东北话" }),
  "BV021_streaming",
  "Northeast male prompt should resolve to the Northeast male TTS voice"
);

assert.equal(
  resolveVoiceIdFromVoicePrompt({ voiceId: "custom_voice_id", voicePrompt: "20 岁女人声音，东北话" }),
  "custom_voice_id",
  "Explicit voice id should win over prompt inference"
);

assert.equal(
  inferVolcTtsResourceIdForVoice("zh_male_M392_conversation_wvae_bigtts"),
  "seed-tts-2.0",
  "BigTTS voice ids should default to the Seed TTS 2.0 resource family"
);

assert.equal(
  inferVolcTtsResourceIdForVoice("BV020_streaming"),
  "seed-tts-1.0",
  "BV streaming voice ids should default to the Seed TTS 1.0 resource family"
);

assert.deepEqual(
  resolveVolcTtsResourceCandidates("zh_male_M392_conversation_wvae_bigtts", "seed-tts-1.0").slice(0, 2),
  ["seed-tts-1.0", "seed-tts-2.0"],
  "Configured resource should be tried first, then the inferred compatible voice resource"
);

const server = readFileSync("src/server/index.ts", "utf8");
const narration = readFileSync("src/server/narration.ts", "utf8");
assert.match(server, /resolveVoiceIdFromVoicePrompt/, "server routes should use prompt-based voice id resolution");
assert.match(server, /voiceAssetId[\s\S]*voiceAsset/, "narration route should inspect selected voice assets");
assert.match(narration, /isVolcTtsResourceMismatch/, "TTS should detect resource/speaker mismatch errors");
assert.match(narration, /resolveVolcTtsResourceCandidates/, "TTS should retry with compatible resource ids for the selected speaker");

console.log("smoke:voice-prompt-routing passed");
