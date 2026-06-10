import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const inspector = readFileSync("src/client/flow/Inspector.tsx", "utf8");
const spec = readFileSync("specs/generation-workflow.md", "utf8");

const shotInspector = inspector.match(/function ShotInspector[\s\S]*?\n}\n\n\/\/ ============================================================================\n\/\/ Stitch inspector/);
assert.ok(shotInspector, "ShotInspector component should exist");
const body = shotInspector[0];

assert.match(body, /pendingFlushRef/, "ShotInspector should keep a flush handle for pending auto-save work");
assert.match(body, /lastSavedRef/, "ShotInspector should compare against the last saved prompt snapshot");
assert.match(body, /window\.setTimeout\(doSave,\s*600\)/, "ShotInspector prompt edits should auto-save with the same debounce as image prompts");
assert.match(body, /api\.updateShot\(shot\.id,\s*\{\s*rawPrompt,\s*prompt:\s*rawPrompt,\s*durationSec,\s*composedSeedancePromptDraft:\s*""\s*\}\)/, "ShotInspector auto-save should persist rawPrompt, prompt, durationSec, and clear stale composed drafts");
assert.match(body, /await flushPendingSave\(\)[\s\S]*?await api\.generateShot/, "video generation should flush pending prompt edits before submitting");
assert.doesNotMatch(body, /const save = async/, "ShotInspector should not keep a manual save handler");
assert.doesNotMatch(body, /onClick=\{save\}/, "ShotInspector should not render a manual Save button");
assert.doesNotMatch(body, /保存生成中修改|Save in-flight edits|>\s*\{busy === "save" \? "\.\.\."/, "ShotInspector should not show explicit prompt-save button copy");

assert.match(spec, /video\/Shot prompt edits auto-save/i, "generation workflow spec should document video prompt auto-save");

console.log("smoke:shot-inspector-autosave passed");
