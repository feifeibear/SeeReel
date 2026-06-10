import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

const types = read("src/shared/types.ts");
assert.match(types, /export type AudioSeparationStatus = "idle" \| "running" \| "ready" \| "error"/);
assert.match(types, /audioSeparationVocalsUrl\?: string/);
assert.match(types, /audioSeparationBackgroundUrl\?: string/);
assert.match(types, /audioSeparationBuiltForFinalVideoSignature\?: string/);

assert.ok(existsSync(path.join(root, "src/server/audioSeparation.ts")), "server audio separation pipeline should exist");
const pipeline = read("src/server/audioSeparation.ts");
assert.match(pipeline, /export function computeAudioSeparationSignature/);
assert.match(pipeline, /export async function runAudioSeparationPipeline/);
assert.match(pipeline, /AUDIO_SEPARATION_COMMAND/);
assert.match(pipeline, /center-vocal fallback/i);
assert.match(pipeline, /vocalsUrl/);
assert.match(pipeline, /backgroundUrl/);

const server = read("src/server/index.ts");
assert.match(server, /audioSeparationInflight/);
assert.match(server, /app\.post\("\/api\/sessions\/:sessionId\/audio-separation"/);
assert.match(server, /app\.post\("\/api\/sessions\/:sessionId\/audio-separation\/poll"/);
assert.match(server, /runAudioSeparationPipeline/);

const api = read("src/client/api.ts");
assert.match(api, /separateFinalAudio/);
assert.match(api, /audio-separation/);
assert.match(api, /pollAudioSeparation/);

const inspector = read("src/client/flow/Inspector.tsx");
assert.match(inspector, /runAudioSeparation/);
assert.match(inspector, /分离人声\/背景/);
assert.match(inspector, /audioSeparationVocalsUrl/);
assert.match(inspector, /audioSeparationBackgroundUrl/);

const spec = read("specs/generation-workflow.md");
assert.match(spec, /人声\/背景分离/);
assert.match(spec, /smoke:audio-separation/);

console.log("audio separation smoke passed");
