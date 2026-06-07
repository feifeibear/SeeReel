#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const shortdrama = readFileSync(".agents/skills/seereel-shortdrama/SKILL.md", "utf8");
const scriptChat = readFileSync(".agents/skills/seereel-script-chat/SKILL.md", "utf8");
const castingAssets = readFileSync(".agents/skills/seereel-casting-assets/SKILL.md", "utf8");
const cinematography = readFileSync(".agents/skills/seereel-cinematography/SKILL.md", "utf8");
const storyboard = readFileSync(".agents/skills/seereel-storyboard-imagegen/SKILL.md", "utf8");

function mustInclude(skill, pattern, message) {
  assert.match(skill, pattern, message);
}

function mustNotInclude(skill, pattern, message) {
  assert.doesNotMatch(skill, pattern, message);
}

mustInclude(shortdrama, /^name: seereel-shortdrama$/m, "director skill keeps the canonical SeeReel skill name");
mustInclude(shortdrama, /Boundary: orchestrates stages/i, "director skill is now an orchestrator");
mustInclude(shortdrama, /does not rewrite the detailed deliverables owned by stage skills/i, "director does not duplicate stage details");
mustInclude(shortdrama, /seereel-script-chat[\s\S]*seereel-casting-assets[\s\S]*seereel-cinematography[\s\S]*seereel-canvas-review/i, "director routes through the split pipeline");
mustInclude(shortdrama, /Only enter paid video generation after canvas-review passes/i, "director gates paid generation on final review");
mustInclude(shortdrama, /Premise drift[\s\S]*seereel-script-chat/i, "director routes story failures to script-chat");
mustInclude(shortdrama, /Character identity drift[\s\S]*seereel-casting-assets/i, "director routes asset failures to casting-assets");
mustInclude(shortdrama, /Weak camera grammar[\s\S]*seereel-cinematography/i, "director routes shot failures to cinematography");

mustInclude(scriptChat, /^name: seereel-script-chat$/m, "script-chat keeps canonical name");
mustInclude(scriptChat, /Boundary: script development only/i, "script-chat is script-only");
mustInclude(scriptChat, /Output contract: StoryPlan/i, "script-chat outputs a StoryPlan");
mustInclude(scriptChat, /Research Pass/i, "script-chat owns research before draft");
mustInclude(scriptChat, /Script Review Loop/i, "script-chat owns script review");
mustInclude(scriptChat, /Does not create character\/scene assets/i, "script-chat does not create assets");
mustInclude(scriptChat, /Does not write final Seedance shot prompts/i, "script-chat does not write final shot prompts");
mustNotInclude(scriptChat, /POST \/api\/assets/, "script-chat should not document asset creation APIs");
mustNotInclude(scriptChat, /Seedance Prompt Contract/i, "script-chat should not own final video prompt contract");

mustInclude(castingAssets, /^name: seereel-casting-assets$/m, "casting-assets keeps canonical name");
mustInclude(castingAssets, /Boundary: character and scene assets only/i, "casting-assets owns assets only");
mustInclude(castingAssets, /style bible/i, "casting-assets owns style bible");
mustInclude(castingAssets, /Character Asset Coverage/i, "casting-assets owns character coverage");
mustInclude(castingAssets, /Does not change plot beats or dialogue/i, "casting-assets does not rewrite script");
mustInclude(castingAssets, /Does not write final shot prompts/i, "casting-assets does not write prompts");
mustInclude(castingAssets, /POST \/api\/assets/i, "casting-assets documents asset APIs");

mustInclude(cinematography, /^name: seereel-cinematography$/m, "cinematography keeps canonical name");
mustInclude(cinematography, /Boundary: storyboard, shot design, and prompts only/i, "cinematography owns shots and prompts");
mustInclude(cinematography, /Camera Grammar/i, "cinematography owns camera grammar");
mustInclude(cinematography, /Seedance Prompt Contract/i, "cinematography owns final prompt contract");
mustInclude(cinematography, /Continuity Wiring/i, "cinematography owns continuity wiring");
mustInclude(cinematography, /Does not rewrite the StoryPlan/i, "cinematography does not rewrite script");
mustInclude(cinematography, /Does not create or approve casting assets/i, "cinematography does not own assets");
mustInclude(cinematography, /0-4s:[\s\S]*4-9s:[\s\S]*9-13s:[\s\S]*13-15s:/i, "cinematography keeps chronological 15s motion beats");
mustInclude(cinematography, /firstFrameAssetId/i, "cinematography covers first-frame anchors");
mustInclude(cinematography, /previousShotClipSec/i, "cinematography covers previous-tail clip seconds");
mustInclude(cinematography, /referenceVideoFromShotId/i, "cinematography covers reference-video continuity");

mustInclude(storyboard, /^name: seereel-storyboard-imagegen$/m, "storyboard skill keeps canonical name");
mustInclude(storyboard, /Boundary: storyboard reference images only/i, "storyboard imagegen is image-only");
mustInclude(storyboard, /Does not author the full Seedance video prompt/i, "storyboard imagegen does not own full video prompt");
mustInclude(storyboard, /strict declared grid/i, "storyboard imagegen enforces declared grids");
mustInclude(storyboard, /complete movie still/i, "storyboard imagegen requires complete movie still panels");
mustInclude(storyboard, /not a concept board/i, "storyboard imagegen rejects concept boards");

console.log("seereel director skill smoke passed");
