#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const skillPath = ".agents/skills/seereel-canvas-review/SKILL.md";
const skill = readFileSync(skillPath, "utf8");
const frontmatter = skill.match(/^---[\s\S]*?---/)?.[0] || "";

function mustInclude(pattern, message) {
  assert.match(skill, pattern, message);
}

mustInclude(/^name: seereel-canvas-review$/m, "skill keeps the canonical canvas-review name");
mustInclude(/^description: Use when/m, "description is trigger-only and discoverable");
assert.doesNotMatch(frontmatter, /render|stitch/i, "frontmatter should not route directly to video generation");

mustInclude(/Boundary: final consistency review and fallback routing only/i, "skill is scoped to final review");
mustInclude(/initial idea/i, "skill checks initial idea alignment");
mustInclude(/locked StoryPlan/i, "skill checks the locked StoryPlan");
mustInclude(/node prompts, edges, assetIds/i, "skill checks prompts, graph edges, and asset references");
mustInclude(/storyboard references/i, "skill checks storyboard references");
mustInclude(/continuity wiring/i, "skill checks continuity wiring");
mustInclude(/Inspect the visible canvas, not private notes/i, "skill reviews visible app state");
mustInclude(/Does not invent replacement content itself/i, "skill does not become another generator");
mustInclude(/Do not generate video/i, "skill blocks video generation during review");
mustInclude(/still-image\/storyboard\/reference generation/i, "skill may complete still references for review");
mustInclude(/fallback to `seereel-script-chat`/i, "skill routes script failures to script-chat");
mustInclude(/fallback to `seereel-casting-assets`/i, "skill routes asset failures to casting-assets");
mustInclude(/fallback to `seereel-cinematography`/i, "skill routes shot/prompt failures to cinematography");
mustInclude(/fallback to `seereel-cli` or `seereel-agent-session`/i, "skill routes transport failures to infra skills");
mustInclude(/Issue:[\s\S]*Evidence:[\s\S]*Owning skill:[\s\S]*Required repair:[\s\S]*Re-review scope:/i, "skill records actionable fallback reports");
mustInclude(/A PASS handoff must include/i, "skill defines final pass handoff");
mustInclude(/explicit statement: no video generation was run in review/i, "skill reports no video generation");

console.log("seereel canvas-review skill smoke passed");
