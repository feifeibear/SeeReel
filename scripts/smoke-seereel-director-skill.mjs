#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const skillPath = ".agents/skills/seereel-shortdrama/SKILL.md";
const skill = readFileSync(skillPath, "utf8");
const scriptChatPath = ".agents/skills/seereel-script-chat/SKILL.md";
const scriptChat = readFileSync(scriptChatPath, "utf8");
const storyboardPath = ".agents/skills/seereel-storyboard-imagegen/SKILL.md";
const storyboard = readFileSync(storyboardPath, "utf8");

function mustInclude(pattern, message) {
  assert.match(skill, pattern, message);
}

function scriptChatMustInclude(pattern, message) {
  assert.match(scriptChat, pattern, message);
}

function storyboardMustInclude(pattern, message) {
  assert.match(storyboard, pattern, message);
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
mustInclude(/Orientation And Exposition Gate/i, "skill includes an orientation and exposition gate");
mustInclude(/first 5-10 seconds/i, "skill requires opening orientation within the first seconds");
mustInclude(/Do not assume the audience knows the product name/i, "skill blocks prompt-only product identity assumptions");
mustInclude(/Codex[\s\S]*AI assistant/i, "skill explicitly covers Codex or AI assistant identity delivery");
mustInclude(/orientationPacket/i, "skill requires an orientation packet");
mustInclude(/identityDelivery/i, "skill requires first-appearance identity delivery");
mustInclude(/who\/where\/when\/world-rule\/relationship\/stakes/i, "skill adds a cold-viewer orientation audit");
mustInclude(/Information Delivery Gate/i, "skill includes an information delivery gate");
mustInclude(/Important prompt information/i, "skill requires important prompt information to reach the audience");
mustInclude(/voiceover or character dialogue/i, "skill requires important information to be delivered through voiceover or character dialogue");
mustInclude(/audienceDelivery/i, "skill records audience-facing delivery plans in story beats");
mustInclude(/one dialogue language/i, "skill requires one dialogue language for the whole session");
mustInclude(/quoted dialogue must still remain in the selected dialogue language/i, "skill keeps quoted dialogue in the chosen language even inside English prompts");
mustInclude(/session spoken-language lock/i, "skill requires checking the submitted spoken-language lock");
mustInclude(/forbid English dialogue and require Mandarin Chinese/i, "skill names the Chinese-session language-lock requirement");
mustInclude(/normal diegetic sound/i, "skill requires normal in-world sound instead of silence or music");
mustInclude(/no music score, no BGM, no per-shot soundtrack/i, "skill blocks per-shot music that stitches poorly");
mustInclude(/patch the `StoryPlan` and all affected shot prompts manually before rendering/i, "skill tells agents to repair incoherent drafts before rendering");
mustInclude(/Cinematic Shot Language/i, "skill includes cinematic shot-language guidance");
mustInclude(/camera grammar plan/i, "skill requires a camera grammar plan before rendering");
mustInclude(/Camera motivation/i, "skill requires camera motivation");
mustInclude(/Coverage ladder/i, "skill requires a coverage ladder");
mustInclude(/Axis and screen direction/i, "skill requires axis and screen direction planning");
mustInclude(/180-degree action line/i, "skill teaches the 180-degree action line for continuity");
mustInclude(/Blocking before movement/i, "skill requires blocking before camera movement");
mustInclude(/Cut bridge/i, "skill requires cut-bridge planning");
mustInclude(/match on action/i, "skill teaches match-on-action bridges");
mustInclude(/eyeline match/i, "skill teaches eyeline-match continuity");
mustInclude(/reaction shot/i, "skill teaches reaction shots for story and comedy");
mustInclude(/Insert\/cut-in/i, "skill teaches insert and cut-in shots for prop/scam mechanics");
mustInclude(/cutaway/i, "skill teaches cutaways for off-screen pressure and context");
mustInclude(/sound bridge/i, "skill teaches sound bridges as transitions");
mustInclude(/hold the reaction half a beat longer for comedy/i, "skill teaches comedy reaction timing");
mustInclude(/Do not add push-ins, handheld shake, drone moves, whip pans, or close-ups just because they sound cinematic/i, "skill blocks unmotivated cinematic moves");
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
mustInclude(/visible seams/i, "skill treats visible seams as a continuity problem");
mustInclude(/previous-tail/i, "skill names previous-tail continuity as the seam-reduction default");
mustInclude(/final two seconds/i, "skill teaches the two-second previous-tail bridge");
mustInclude(/Do not parallel-generate adjacent shots that need seam reduction/i, "skill blocks parallel generation for visually dependent adjacent shots");
mustInclude(/Parallel generation is appropriate only for visually independent branches/i, "skill reserves parallel rendering for independent visual branches");

mustInclude(/Frame Mode Decision Table/i, "skill includes a decision table for continuity/reference modes");
mustInclude(/首帧/, "skill includes Chinese wording for first-frame decisions");
mustInclude(/尾帧/, "skill includes Chinese wording for tail-frame decisions");
mustInclude(/frame bridge plan/i, "skill teaches first/last-frame bridge planning");
mustInclude(/route bible/i, "skill teaches a route bible for drone path continuity");
mustInclude(/rhythm map/i, "skill teaches pacing/rhythm design before generation");
mustInclude(/Seedance tasks may exceed 15 minutes/i, "skill tells agents to wait patiently for long Seedance tasks");
mustInclude(/cloud session/i, "skill requires generated intermediates to remain visible in the cloud session");
mustInclude(/Do not use local ffmpeg/i, "skill blocks private local stitching for cloud-only workflows");
mustInclude(/Prefer full 15-second Seedance shots/i, "skill prefers full 15-second Seedance clips");
mustInclude(/multiple story beats inside one 15-second shot/i, "skill packs multiple beats into one Seedance shot when possible");
mustInclude(/Do not split every beat into a shorter shot/i, "skill avoids unnecessary shorter clips per beat");
mustInclude(/in-shot consistency/i, "skill explains why one longer shot preserves consistency");
mustInclude(/Long Video Character Consistency Gate/i, "skill includes a long-video character consistency gate");
mustInclude(/protagonist consistency is blocking/i, "skill treats protagonist consistency as blocking for long videos");
mustInclude(/Generate or import approved session-scoped character image assets for every main recurring character before video generation/i, "skill requires generated/imported character assets before long-video generation");
mustInclude(/assume the protagonist must be referenced in every narrative shot/i, "skill references protagonists in every narrative shot unless explicitly absent");
mustInclude(/approved rendered-frame identity anchors/i, "skill teaches rendered-frame identity anchors after the first good shot");
mustInclude(/Do not auto-attach the whole session cast/i, "skill blocks whole-cast reference pollution");
mustInclude(/visible or explicitly mentioned in that shot/i, "skill filters shot references to visible or explicitly mentioned cast");
mustInclude(/Parallel generation does not override this gate/i, "skill prevents parallel rendering from bypassing character coverage");
mustInclude(/Seedance Prompt Contract/i, "skill includes a Seedance prompt contract section");
mustInclude(/shot contract/i, "skill treats Seedance prompts as shot contracts");
mustInclude(/dry-run the final composed prompt/i, "skill requires a dry-run of the final composed prompt before paid render");
mustInclude(/0-4s \/ 4-9s \/ 9-13s \/ 13-15s/i, "skill requires chronological motion beats for 15s clips");
mustInclude(/Reference roles/i, "skill requires explicit reference-role assignment");
mustInclude(/Do not use the maximum number of references by habit/i, "skill blocks filling every reference slot by habit");
mustInclude(/explicit shot size\/framing/i, "skill requires explicit shot size and framing");
mustInclude(/WS\/MS\/CU or 远景\/中景\/近景\/特写/i, "skill gives concrete shot-size vocabulary");
mustInclude(/Camera grammar/i, "skill adds camera grammar to the Seedance prompt contract");
mustInclude(/subject, speed, endpoint, and story reason/i, "skill requires concrete camera movement semantics");
mustInclude(/motivated camera movement or an intentional lock-off/i, "skill quality-gates camera movement or lock-off choice");
mustInclude(/attention target/i, "skill requires each shot to name an attention target");
mustInclude(/usually 2-4 seconds/i, "skill recommends short trimmed reference videos");
mustInclude(/Do not send a whole 15-second clip/i, "skill blocks whole-clip reference-video contamination");
mustInclude(/one variable changed per retry/i, "skill requires one-variable retry discipline");
mustInclude(/first frame is the literal opening frame/i, "skill explains first-frame anchor semantics");
mustInclude(/reference video controls motion, camera, rhythm, lighting handoff/i, "skill explains reference-video continuity semantics");
mustInclude(/must not be rendered as a 3x3 grid/i, "skill prevents storyboard contact sheets from leaking into video output");
mustInclude(/character anchor, scene tone, camera\/motion reference, or audio rhythm/i, "skill assigns multi-reference materials by function");

scriptChatMustInclude(/Session Style Consistency Contract/i, "script-chat skill includes session-level style consistency guidance");
scriptChatMustInclude(/session style bible/i, "script-chat skill requires a session style bible");
scriptChatMustInclude(/Asset Style Lock/i, "script-chat skill teaches style locks for recurring assets");
scriptChatMustInclude(/Consistency Gate/i, "script-chat skill includes a pre-render consistency gate");
scriptChatMustInclude(/Character Asset Coverage Gate/i, "script-chat skill includes a per-shot character asset coverage gate");
scriptChatMustInclude(/every on-screen speaking or featured character/i, "script-chat skill extracts every visible speaking or featured character");
scriptChatMustInclude(/Recurring and cross-shot characters[\s\S]*must have a generated or imported image asset before video generation/i, "script-chat skill requires generated/imported visuals before rendering important characters");
scriptChatMustInclude(/treat protagonist identity consistency as a blocking production requirement/i, "script-chat skill blocks long-video generation without protagonist identity coverage");
scriptChatMustInclude(/assume the protagonist asset belongs in every narrative shot's `assetIds`/i, "script-chat skill attaches protagonists to every narrative shot when applicable");
scriptChatMustInclude(/prompt-only session asset is draft-only/i, "script-chat skill treats prompt-only character assets as draft-only");
scriptChatMustInclude(/Every shot `assetIds` list must include the character assets/i, "script-chat skill links visible character assets through shot assetIds");
scriptChatMustInclude(/missing protagonist `assetIds` or missing `@角色名` prompt mentions are blocking gaps/i, "script-chat skill makes missing protagonist references blocking");
scriptChatMustInclude(/Extras, crowds, and one-off background roles/i, "script-chat skill gives a safe exception for non-recurring background roles");
scriptChatMustInclude(/Treat style mismatch as blocking even when the review says `ok=true` or the numeric score is high/i, "script-chat skill blocks style mismatches despite high VLM scores");
scriptChatMustInclude(/cartoon, anime, 3D render, illustration, stylized face, plastic skin, toy proportions/i, "script-chat skill names common style-drift failure modes");
scriptChatMustInclude(/patch every dependent shot prompt with a short style guard/i, "script-chat skill requires dependent shot prompt repair after asset repair");
scriptChatMustInclude(/no cartoon, no 3D render, no stylized animated face/i, "script-chat skill gives a concrete repaired-asset style guard");
scriptChatMustInclude(/one spoken dialogue language/i, "script-chat skill requires one spoken language across the session");
scriptChatMustInclude(/orientationPacket/i, "script-chat skill stores opening orientation packets");
scriptChatMustInclude(/identityDelivery/i, "script-chat skill stores first-appearance identity delivery");
scriptChatMustInclude(/first 10 seconds[\s\S]*who\/where\/when\/world-rule\/relationship\/stakes/i, "script-chat skill audits cold-viewer comprehension in the first seconds");
scriptChatMustInclude(/Information Delivery Gate/i, "script-chat skill includes an information delivery gate");
scriptChatMustInclude(/audienceDelivery/i, "script-chat skill stores audience-facing information delivery in beats");
scriptChatMustInclude(/voiceover or character dialogue/i, "script-chat skill requires important information to be spoken via voiceover or dialogue");
scriptChatMustInclude(/Do not mix Chinese and English dialogue unless the user explicitly asks/i, "script-chat skill blocks accidental mixed-language dialogue");
scriptChatMustInclude(/normal diegetic sound/i, "script-chat skill requires normal generated sound");
scriptChatMustInclude(/no per-shot music, no BGM, no score/i, "script-chat skill blocks per-shot music by default");
scriptChatMustInclude(/Prefer 15-second Seedance shots/i, "script-chat skill prefers 15-second shot planning");
scriptChatMustInclude(/multiple beats inside one shot/i, "script-chat skill packs multiple beats into one shot");
scriptChatMustInclude(/not one short shot per beat/i, "script-chat skill avoids one short clip per beat");
scriptChatMustInclude(/seam plan/i, "script-chat skill reviews the cut-to-cut seam plan");
scriptChatMustInclude(/previous-tail continuity handoff/i, "script-chat skill plans previous-tail handoffs before render");
scriptChatMustInclude(/Research Pass/i, "script-chat skill requires research before drafting");
scriptChatMustInclude(/characters, plot, and historical background/i, "script-chat skill researches role, plot, and background context");
scriptChatMustInclude(/Script Review Loop/i, "script-chat skill requires review iterations after the first draft");
scriptChatMustInclude(/until the reviewer is satisfied/i, "script-chat skill iterates until review is satisfied");
scriptChatMustInclude(/Interactive Mode/i, "script-chat skill defines when questions are allowed");
scriptChatMustInclude(/otherwise work autonomously/i, "script-chat skill defaults to autonomous execution without explicit discussion mode");
scriptChatMustInclude(/Seedance Prompt Contract/i, "script-chat skill applies the Seedance prompt contract to shot prompts");
scriptChatMustInclude(/production contract, not a synopsis/i, "script-chat skill treats shot prompts as production contracts");
scriptChatMustInclude(/explicit shot size\/framing/i, "script-chat skill requires explicit shot size and framing");
scriptChatMustInclude(/reference-role line/i, "script-chat skill requires reference role lines");
scriptChatMustInclude(/trimmed reference duration plan/i, "script-chat skill plans trimmed reference-video duration");
scriptChatMustInclude(/previous-tail reference video controls motion, camera, rhythm, and lighting handoff/i, "script-chat skill teaches previous-tail reference-video semantics");
scriptChatMustInclude(/dry-run checklist item/i, "script-chat skill requires final composed prompt dry-run checks");
scriptChatMustInclude(/changes one variable at a time/i, "script-chat skill requires one-variable retry notes");
scriptChatMustInclude(/Do not fill every available Seedance reference slot by default/i, "script-chat skill avoids overloading reference slots");

storyboardMustInclude(/Seedance prompt handoff/i, "storyboard skill includes Seedance prompt handoff guidance");
storyboardMustInclude(/Use the storyboard as a visual reference, not as the whole Seedance prompt/i, "storyboard skill separates visual reference from prompt contract");
storyboardMustInclude(/shot contract/i, "storyboard skill requires the Seedance shot contract");
storyboardMustInclude(/explicit shot size\/framing/i, "storyboard skill carries shot size and framing into Seedance handoff");
storyboardMustInclude(/panel borders, panel numbers, captions, labels, or a grid layout/i, "storyboard skill blocks contact-sheet artifacts in video output");
storyboardMustInclude(/clean keyframe/i, "storyboard skill prefers clean keyframes when first-frame precision matters");

console.log("seereel director skill smoke passed");
