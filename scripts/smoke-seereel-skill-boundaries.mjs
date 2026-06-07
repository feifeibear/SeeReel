#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const skillsRoot = ".agents/skills";

function readSkill(name) {
  const skillPath = path.join(skillsRoot, name, "SKILL.md");
  assert.ok(existsSync(skillPath), `${name} skill should exist at ${skillPath}`);
  return readFileSync(skillPath, "utf8");
}

function mustInclude(skill, pattern, message) {
  assert.match(skill, pattern, message);
}

function mustNotInclude(skill, pattern, message) {
  assert.doesNotMatch(skill, pattern, message);
}

const shortdrama = readSkill("seereel-shortdrama");
const scriptChat = readSkill("seereel-script-chat");
const castingAssets = readSkill("seereel-casting-assets");
const cinematography = readSkill("seereel-cinematography");
const canvasReview = readSkill("seereel-canvas-review");
const storyboard = readSkill("seereel-storyboard-imagegen");
const cli = readSkill("seereel-cli");
const agentSession = readSkill("seereel-agent-session");

for (const [name, skill] of Object.entries({
  "seereel-shortdrama": shortdrama,
  "seereel-script-chat": scriptChat,
  "seereel-casting-assets": castingAssets,
  "seereel-cinematography": cinematography,
  "seereel-canvas-review": canvasReview,
  "seereel-storyboard-imagegen": storyboard,
  "seereel-cli": cli,
  "seereel-agent-session": agentSession
})) {
  mustInclude(skill, new RegExp(`^name: ${name}$`, "m"), `${name} keeps its canonical skill name`);
  mustInclude(skill, /^description: Use when/m, `${name} has trigger-oriented frontmatter`);
}

mustInclude(shortdrama, /Boundary: orchestrates stages/i, "shortdrama should be the orchestrator");
mustInclude(shortdrama, /does not rewrite the detailed deliverables owned by stage skills/i, "shortdrama should not duplicate stage deliverables");
mustInclude(shortdrama, /seereel-script-chat[\s\S]*seereel-casting-assets[\s\S]*seereel-cinematography[\s\S]*seereel-canvas-review/i, "shortdrama routes through the staged workflow");
mustInclude(shortdrama, /Only enter paid video generation after canvas-review passes/i, "shortdrama waits for final canvas review");

mustInclude(scriptChat, /Boundary: script development only/i, "script-chat is scoped to script development");
mustInclude(scriptChat, /Output contract: StoryPlan/i, "script-chat outputs the StoryPlan");
mustInclude(scriptChat, /Does not create character\/scene assets/i, "script-chat does not own asset creation");
mustInclude(scriptChat, /Does not write final Seedance shot prompts/i, "script-chat does not own final video prompts");
mustNotInclude(scriptChat, /POST \/api\/assets/, "script-chat should not document asset creation APIs");
mustNotInclude(scriptChat, /Seedance Prompt Contract/i, "script-chat should not own the final Seedance prompt contract");

mustInclude(castingAssets, /Boundary: character and scene assets only/i, "casting-assets is scoped to assets");
mustInclude(castingAssets, /Input contract: initial idea and locked StoryPlan/i, "casting-assets consumes the StoryPlan");
mustInclude(castingAssets, /Output contract: approved character assets, scene assets, and assetIds/i, "casting-assets outputs approved assets and ids");
mustInclude(castingAssets, /Does not change plot beats or dialogue/i, "casting-assets must not rewrite the script");
mustInclude(castingAssets, /Does not write final shot prompts/i, "casting-assets must not own final shot prompts");
mustInclude(castingAssets, /style bible/i, "casting-assets owns visual style locking");
mustInclude(castingAssets, /character asset coverage/i, "casting-assets owns character coverage");

mustInclude(cinematography, /Boundary: storyboard, shot design, and prompts only/i, "cinematography is scoped to shots and prompts");
mustInclude(cinematography, /Input contract: locked StoryPlan and approved assetIds/i, "cinematography consumes StoryPlan and assets");
mustInclude(cinematography, /Output contract: storyboard plan, shot nodes, rawPrompt\/prompt, and continuity wiring/i, "cinematography outputs storyboard shots and prompts");
mustInclude(cinematography, /Does not rewrite the StoryPlan/i, "cinematography must not rewrite script");
mustInclude(cinematography, /Does not create or approve casting assets/i, "cinematography must not own assets");
mustInclude(cinematography, /camera grammar/i, "cinematography owns camera grammar");
mustInclude(cinematography, /previous-tail|tailframe|firstFrameAssetId/i, "cinematography owns continuity wiring");

mustInclude(canvasReview, /Boundary: final consistency review and fallback routing only/i, "canvas-review is scoped to final review");
mustInclude(canvasReview, /initial idea/i, "canvas-review checks against the initial idea");
mustInclude(canvasReview, /locked StoryPlan/i, "canvas-review checks against the locked StoryPlan");
mustInclude(canvasReview, /node prompts, edges, assetIds/i, "canvas-review checks canvas nodes, prompts, edges, and assets");
mustInclude(canvasReview, /fallback to `seereel-script-chat`/i, "canvas-review routes script failures back to script-chat");
mustInclude(canvasReview, /fallback to `seereel-casting-assets`/i, "canvas-review routes asset failures back to casting-assets");
mustInclude(canvasReview, /fallback to `seereel-cinematography`/i, "canvas-review routes shot failures back to cinematography");
mustInclude(canvasReview, /Does not invent replacement content itself/i, "canvas-review should not become another generator");
mustInclude(canvasReview, /Do not generate video/i, "canvas-review blocks video generation");

mustInclude(storyboard, /Boundary: storyboard reference images only/i, "storyboard-imagegen is scoped to reference images");
mustInclude(storyboard, /Does not author the full Seedance video prompt/i, "storyboard-imagegen should not own full video prompts");

mustInclude(cli, /Boundary: transport and node operations only/i, "cli skill is infrastructure only");
mustInclude(agentSession, /Boundary: REST session control only/i, "agent-session skill is infrastructure only");

console.log("seereel skill boundary smoke passed");
