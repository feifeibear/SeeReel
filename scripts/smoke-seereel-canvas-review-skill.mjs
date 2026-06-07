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

mustInclude(/review-first canvas/i, "skill frames the workflow as review-first canvas planning");
mustInclude(/Do not generate video/i, "skill blocks video generation during this stage");
mustInclude(/human approval/i, "skill requires human approval before render");
mustInclude(/Canvas Readiness Contract/i, "skill defines a concrete canvas readiness contract");
mustInclude(/角色/i, "skill covers character planning");
mustInclude(/场景/i, "skill covers scene planning");
mustInclude(/故事板/i, "skill covers storyboard planning");
mustInclude(/分镜/i, "skill covers shot planning");
mustInclude(/prompt/i, "skill covers prompt authoring");
mustInclude(/assetIds/, "skill records shot-to-reference asset links");
mustInclude(/scene assets/i, "skill creates or reuses scene assets");
mustInclude(/character assets/i, "skill creates or reuses character assets");
mustInclude(/Prefer 15-second Seedance shots/i, "skill prefers 15-second shot planning");
mustInclude(/multiple beats inside one shot/i, "skill packs related beats into one shot");
mustInclude(/not one short shot per beat/i, "skill avoids unnecessary short clips per beat");
mustInclude(/StoryPlan/, "skill saves the full story layer");
mustInclude(/PATCH \/api\/sessions\/:sessionId\/script/, "skill uses the script API");
mustInclude(/POST \/api\/sessions\/:sessionId\/storyboard/, "skill uses the storyboard API");
mustInclude(/PATCH \/api\/shots\/:shotId/, "skill patches shot prompts and references");
mustInclude(/seereel-script-chat/, "skill composes with the script-chat skill");
mustInclude(/seereel-storyboard-imagegen/, "skill composes with storyboard prompt guidance");
mustInclude(/Research Pass/i, "skill requires research before first script draft");
mustInclude(/characters, plot, and historical background/i, "skill researches character, plot, and historical context");
mustInclude(/cite or summarize the sources/i, "skill preserves research provenance in visible state");
mustInclude(/Script Review Loop/i, "skill requires script review iterations before canvas handoff");
mustInclude(/Run at least two review passes/i, "skill does not stop after a single self-review");
mustInclude(/until the reviewer is satisfied/i, "skill iterates until the review is satisfied");
mustInclude(/orientationPacket/i, "skill stores opening orientation packets");
mustInclude(/identityDelivery/i, "skill stores first-appearance identity delivery");
mustInclude(/first 10 seconds[\s\S]*who\/where\/when\/world-rule\/relationship\/stakes/i, "skill audits cold-viewer comprehension in the first seconds");
mustInclude(/audienceDelivery/, "skill records audience-facing delivery plans");
mustInclude(/important prompt information/i, "skill requires important prompt information to reach the audience");
mustInclude(/voiceover or character dialogue/i, "skill requires important information to be delivered through voiceover or character dialogue");
mustInclude(/visible action\/reaction backup|visible action or reaction backup/i, "skill requires spoken information to have visible backup");
mustInclude(/prompt-only lore/i, "skill rejects prompt-only lore as audience comprehension");
mustInclude(/Interactive Mode/i, "skill defines when the agent may ask the user questions");
mustInclude(/otherwise work autonomously/i, "skill defaults to autonomous execution unless discussion is requested");
mustInclude(/Handoff Checklist/i, "skill ends with a human review checklist");
mustInclude(/no subtitles/i, "skill prevents subtitle-dependent video prompts");
mustInclude(/refresh status/i, "skill respects manual UI edits before continuing");

console.log("seereel canvas-review skill smoke passed");
