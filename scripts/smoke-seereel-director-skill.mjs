#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const skillPath = ".agents/skills/seereel-shortdrama/SKILL.md";
const skill = readFileSync(skillPath, "utf8");

function mustInclude(pattern, message) {
  assert.match(skill, pattern, message);
}

mustInclude(/^name: seereel-shortdrama$/m, "director skill keeps the canonical SeeReel skill name");
mustInclude(/SeeReel/, "director skill uses SeeReel product naming");
assert.doesNotMatch(skill.slice(0, 900), /ReelyAI|reelyai/i, "frontmatter and opening stance should not use legacy ReelyAI naming");

mustInclude(/Short One-Shot Frame Director/i, "skill includes a short one-shot frame director section");
mustInclude(/30s\s*=\s*2\s*(?:shots|segments)/i, "skill teaches 30-second one-shot decomposition into 2 Seedance-sized shots");
mustInclude(/60s\s*=\s*4\s*(?:shots|segments)/i, "skill teaches 60-second one-shot decomposition into 4 Seedance-sized shots");
mustInclude(/Math\.ceil\(totalDurationSec\s*\/\s*15\)/, "skill gives the exact shot-count formula");
mustInclude(/one-shot illusion/i, "skill frames long one-take requests as an illusion built from visible shot chains");
mustInclude(/30min.*edge case/i, "skill treats 30-minute requests as an edge case, not the default center");

mustInclude(/firstFrameAssetId/, "skill teaches first-frame anchors");
mustInclude(/lastFrameAssetId/, "skill teaches last-frame anchors");
mustInclude(/tailframe/, "skill teaches tailframe extraction and chaining");
mustInclude(/referenceVideoFromShotId/, "skill teaches cross-shot reference-video continuity");
mustInclude(/usePreviousShotClip/, "skill teaches previous-shot continuity");
mustInclude(/previousShotClipSec/, "skill teaches continuity clip duration");

mustInclude(/Frame Mode Decision Table/i, "skill includes a decision table for continuity/reference modes");
mustInclude(/首帧/, "skill includes Chinese wording for first-frame decisions");
mustInclude(/尾帧/, "skill includes Chinese wording for tail-frame decisions");
mustInclude(/frame bridge plan/i, "skill teaches first/last-frame bridge planning");
mustInclude(/route bible/i, "skill teaches a route bible for drone path continuity");
mustInclude(/rhythm map/i, "skill teaches pacing/rhythm design before generation");
mustInclude(/Seedance tasks may exceed 15 minutes/i, "skill tells agents to wait patiently for long Seedance tasks");
mustInclude(/cloud session/i, "skill requires generated intermediates to remain visible in the cloud session");
mustInclude(/Do not use local ffmpeg/i, "skill blocks private local stitching for cloud-only workflows");

console.log("seereel director skill smoke passed");
