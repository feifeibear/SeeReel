#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const skillPath = ".agents/skills/seereel-shortdrama/SKILL.md";
const skill = readFileSync(skillPath, "utf8");
const scriptChatPath = ".agents/skills/seereel-script-chat/SKILL.md";
const scriptChat = readFileSync(scriptChatPath, "utf8");

function mustInclude(pattern, message) {
  assert.match(skill, pattern, message);
}

function scriptChatMustInclude(pattern, message) {
  assert.match(scriptChat, pattern, message);
}

mustInclude(/^name: seereel-shortdrama$/m, "director skill keeps the canonical SeeReel skill name");
mustInclude(/SeeReel/, "director skill uses SeeReel product naming");
assert.doesNotMatch(skill.slice(0, 900), /ReelyAI|reelyai/i, "frontmatter and opening stance should not use legacy ReelyAI naming");

mustInclude(/Short One-Shot Frame Director/i, "skill includes a short one-shot frame director section");
mustInclude(/Story Spine And Scene Design/i, "skill includes story-spine and scene-design guidance");
mustInclude(/story spine/i, "skill requires a story spine before narrative rendering");
mustInclude(/protagonist/i, "skill requires a protagonist for narrative shorts");
mustInclude(/reversal/i, "skill requires a reversal/payoff, not only a shot list");
mustInclude(/Character functions/i, "skill teaches character functions");
mustInclude(/Beat ladder/i, "skill teaches a beat ladder");
mustInclude(/setup -> pitch\/trap -> escalation -> reversal\/payoff/i, "skill teaches a coherent 60s/4-shot comedy ladder");
mustInclude(/Scene objective/i, "skill requires each shot to have a scene objective");
mustInclude(/Dialogue packet/i, "skill requires dialogue packets");
mustInclude(/1-3 short speakable lines/i, "skill limits dialogue to short speakable lines per shot");
mustInclude(/performed naturally/i, "skill treats dialogue as performance rather than burned-in text");
mustInclude(/Do not rely on subtitles/i, "skill blocks subtitle-dependent plot");
mustInclude(/one dialogue language/i, "skill requires one dialogue language for the whole session");
mustInclude(/quoted dialogue must still remain in the selected dialogue language/i, "skill keeps quoted dialogue in the chosen language even inside English prompts");
mustInclude(/normal diegetic sound/i, "skill requires normal in-world sound instead of silence or music");
mustInclude(/no music score, no BGM, no per-shot soundtrack/i, "skill blocks per-shot music that stitches poorly");
mustInclude(/patch the `StoryPlan` and all affected shot prompts manually before rendering/i, "skill tells agents to repair incoherent drafts before rendering");
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

scriptChatMustInclude(/Session Style Consistency Contract/i, "script-chat skill includes session-level style consistency guidance");
scriptChatMustInclude(/session style bible/i, "script-chat skill requires a session style bible");
scriptChatMustInclude(/Asset Style Lock/i, "script-chat skill teaches style locks for recurring assets");
scriptChatMustInclude(/Consistency Gate/i, "script-chat skill includes a pre-render consistency gate");
scriptChatMustInclude(/Character Asset Coverage Gate/i, "script-chat skill includes a per-shot character asset coverage gate");
scriptChatMustInclude(/every on-screen speaking or featured character/i, "script-chat skill extracts every visible speaking or featured character");
scriptChatMustInclude(/Recurring and cross-shot characters[\s\S]*must have a generated or imported image asset before video generation/i, "script-chat skill requires generated/imported visuals before rendering important characters");
scriptChatMustInclude(/prompt-only session asset is draft-only/i, "script-chat skill treats prompt-only character assets as draft-only");
scriptChatMustInclude(/Every shot `assetIds` list must include the character assets/i, "script-chat skill links visible character assets through shot assetIds");
scriptChatMustInclude(/Extras, crowds, and one-off background roles/i, "script-chat skill gives a safe exception for non-recurring background roles");
scriptChatMustInclude(/Treat style mismatch as blocking even when the review says `ok=true` or the numeric score is high/i, "script-chat skill blocks style mismatches despite high VLM scores");
scriptChatMustInclude(/cartoon, anime, 3D render, illustration, stylized face, plastic skin, toy proportions/i, "script-chat skill names common style-drift failure modes");
scriptChatMustInclude(/patch every dependent shot prompt with a short style guard/i, "script-chat skill requires dependent shot prompt repair after asset repair");
scriptChatMustInclude(/no cartoon, no 3D render, no stylized animated face/i, "script-chat skill gives a concrete repaired-asset style guard");
scriptChatMustInclude(/one spoken dialogue language/i, "script-chat skill requires one spoken language across the session");
scriptChatMustInclude(/Do not mix Chinese and English dialogue unless the user explicitly asks/i, "script-chat skill blocks accidental mixed-language dialogue");
scriptChatMustInclude(/normal diegetic sound/i, "script-chat skill requires normal generated sound");
scriptChatMustInclude(/no per-shot music, no BGM, no score/i, "script-chat skill blocks per-shot music by default");

console.log("seereel director skill smoke passed");
