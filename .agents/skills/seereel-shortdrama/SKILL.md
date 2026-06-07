---
name: seereel-shortdrama
description: Use when a user asks SeeReel to plan, direct, storyboard, generate, continue, repair, or stitch AI video workflows, especially long videos, one-take shots, drone routes, first-frame/tailframe continuity, Seedance shots, reference images, or visible cloud sessions.
---

# SeeReel Director

SeeReel is a cloud-visible production board. The agent is the director: design the route, rhythm, references, continuity mode, generation order, retries, and stitch plan before pressing render. The web app is the takeover surface: every prompt, asset, storyboard, shot, tailframe, edge, render, stitch job, and final video must remain visible in the cloud session.

## Core Rules

- Use `seereelcli` or SeeReel APIs; do not use private local scripts as the production workflow.
- Upload local user素材 once, then generate characters, scenes, storyboards, shots, tailframes, stitch jobs, and final video through SeeReel cloud APIs.
- Do not use local ffmpeg, local recovered MP4 imports, or hidden scratch media for cloud-only workflows unless recovering from a terminal provider failure; if recovery is unavoidable, write the result back into visible SeeReel state.
- Seedance shots are max 15s. For any requested duration: `shotCount = Math.ceil(totalDurationSec / 15)`.
- Prefer full 15-second Seedance shots when planning narrative video. A single 15s generated clip can carry multiple story beats inside one 15-second shot, using internal camera motion, blocking, gestures, reactions, and dialogue beats. Do not split every beat into a shorter shot unless a hard cut, location jump, time jump, or continuity reset is dramatically necessary. In-shot consistency is usually stronger than cross-shot consistency because face, wardrobe, lighting, and space remain inside one provider generation.
- For long videos or any multi-shot narrative with recurring protagonists, protagonist consistency is blocking. Generate or import approved session-scoped character image assets for every main recurring character before video generation, then reference those assets in every shot where the character appears through `assetIds` and `@CharacterName` mentions. For protagonist-driven long videos, assume the protagonist must be referenced in every narrative shot unless the shot is explicitly an insert with no protagonist presence. Do not render recurring protagonists from prompt text alone.
- Seedance tasks may exceed 15 minutes. Keep polling patiently; do not resubmit just because a task is slow.
- Only send public or signed `http(s)` URLs to Seedance. Local `/media/...` preview paths must be published to TOS first.
- Treat visible seams as a directing problem, not only a stitch problem. If adjacent shots share characters, location, time of day, lighting, color grade, screen direction, or camera motion, they are visually dependent even when their story beats are different. Generate them serially and bridge them with the previous shot's tail clip or strict tailframe anchoring.
- Do not add per-shot background music, score, soundtrack, BGM, stingers, or musical cues by default. They drift between generated shots and stitch poorly. Prompts should request normal diegetic sound only: dialogue, room tone, footsteps, clothing/prop handling, machinery, street ambience, wind, crowd murmur, etc. Use music only when the user explicitly asks, and then define it as one continuous session-level audio bed rather than different music per shot.
- Choose one dialogue language for the whole session from the user's request or `Session.language`. Keep every spoken line in that language across `StoryPlan`, shot scripts, and video prompts. If the technical prompt is written in English for model clarity, quoted dialogue must still remain in the selected dialogue language; do not mix Chinese and English spoken lines unless the user explicitly asks for multilingual dialogue.
- Before submitting each Seedance shot, dry-run or inspect the final composed prompt and confirm it contains the session spoken-language lock. For Chinese sessions it must forbid English dialogue and require Mandarin Chinese for all audible character lines; for English sessions it must forbid Mandarin/Chinese dialogue and require English. This check applies even when the user edited the final composed prompt manually.
- When the user gives only a story idea or script inspiration, route through `seereel-canvas-review` and `seereel-script-chat` first: research characters, plot, and historical background; write a first draft; run review iterations until the reviewer is satisfied; then build the visible canvas. Do not jump straight to video generation from an unresearched premise.
- Unless the user explicitly asks for Interactive Mode or discussion, work autonomously through research, drafting, review, revision, canvas creation, and handoff.

## Story Spine And Scene Design

Before rendering any narrative short, write a compact story spine into the session. A pretty shot list is not enough: the session needs one protagonist, one pressure or scam, an escalation, a reversal, and a payoff that answers the title or premise.

Research comes before the first complete script draft. For stories tied to real places, eras, technologies, jobs, institutions, public figures, or cultural background, collect sources and turn them into character behavior, plot mechanics, scene texture, and anachronism constraints before writing final beats.

For satire, comedy, or dialogue-driven shorts, save these before generation:

1. **Story spine**: title promise, protagonist, want/fear, antagonist or social pressure, scam/mechanism, escalation, reversal, final joke or sting.
2. **Character functions**: who is the ordinary-person anchor, who profits from confusion, who says the audience's skeptical thought, and who changes by the end.
3. **Beat ladder**: every shot changes story state. A 60s/4-shot comedy should normally read as setup -> pitch/trap -> escalation -> reversal/payoff.
4. **Scene objective**: each shot needs a visible objective, not just an atmosphere. Name what the scene proves, sells, reveals, or overturns.
5. **Dialogue packet**: for each 15s shot, write 1-3 short speakable lines that are tied to visible action. Dialogue should reveal status, fear, contradiction, or punchline.
6. **Information delivery packet**: list the facts the audience must understand in this shot and how each one is delivered through voiceover or character dialogue, backed by visible action when possible.
7. **Audio and language packet**: record the single dialogue language and the non-musical sound bed for the session. Example: "spoken dialogue: Mandarin Chinese throughout; audio: natural street/room ambience, footsteps, props, crowd murmur, no music score."
8. **Research packet**: cite or summarize the sources behind characters, plot, and historical background, and state how they affect assets, beats, and prompts.
9. **Review packet**: record at least two script review passes, the issues found, the fixes applied, and whether the reviewer is satisfied.
10. **15s beat packing**: group related micro-beats into full 15s shots whenever possible. A shot can contain setup, reaction, and turn; do not create one short shot per beat unless the story needs a cut.

Dialogue belongs in story beats, shot scripts, and prompt intent. Do not rely on subtitles or readable signs to carry the plot. In video prompts, state that dialogue is performed naturally and that there are no subtitles, no readable on-screen text, and no text overlays.

For every dialogue-driven prompt, also state: spoken dialogue is in the session's chosen language throughout; no mixed-language dialogue unless requested; natural diegetic sound only; no music score, no BGM, no per-shot soundtrack.

## Orientation And Exposition Gate

Before any narrative render, make the first appearance of every main character and every new story arena legible to a cold viewer. Do not assume the audience knows the product name, the prompt, the asset title, the user's prior chat, or the agent's private notes. If the protagonist is Codex, an AI assistant, a tool, a historical figure, or any anthropomorphic concept, the film must explicitly deliver that identity on screen or in sound before asking the viewer to follow the joke.

For the first 5-10 seconds of the film, or the first 5-10 seconds after a major location/time jump, create an `orientationPacket` and an `identityDelivery` entry:

- **Who**: the character's name or recognizable role, story function, status, and relationship to the other force in the scene. Example: a line like "我是 Codex，被你每次提问叫醒的 AI 编程助手" is valid; a prompt-only asset named `Codex真人化上班族` is not.
- **Where**: the physical or digital arena, visible geography, power positions, entrances/exits, and the object or interface that explains how the scene works.
- **When**: era, time of day, historical period, future rule, or contemporary work context when it matters to the plot. Period and technology rules must be visible or spoken, not only implied by style.
- **World rule**: the one rule the audience needs now, such as "tokens are work oxygen", "the user controls whether Codex stays awake", or "this village has never used electricity."
- **Relationship and stakes**: who pressures whom, what each side wants, and what changes if the protagonist succeeds or fails.
- **Delivery mode**: establishing/master shot, motivated insert, action beat, character dialogue, voiceover, overheard line, or prop behavior. Prefer an establishing or master shot before close-ups unless deliberate confusion is the story goal and the payoff repairs it quickly.

Use the cold-viewer audit before rendering:

- By the first 10 seconds, can a viewer answer who the protagonist is, where the story happens, when or what era/rule governs it, what relationship drives the scene, and why the moment matters?
- Does the first shot establish the stage before relying on close-ups, abstract props, or inside jokes?
- Is every important background fact dramatized through action, conflict, dialogue, voiceover, or a meaningful object instead of only being explained in the prompt?
- If the answer is no, patch the `StoryPlan`, shot script, `audienceDelivery`, and Seedance prompt before paid generation.

## Information Delivery Gate

Important prompt information must reach the audience. Do not leave story-critical facts only inside the private prompt, the asset description, the agent's plan, or invisible lore.

For every narrative shot, add an `audienceDelivery` plan to the beat, shot script, or prompt. It should list:

- **Fact**: what the viewer must know now, such as who wants what, why a character is afraid, what the scam rule is, what changed since the previous shot, why an object matters, what a price/deadline/threat means, or what irony the shot is exposing.
- **Delivery mode**: character dialogue, voiceover/narration, overheard crowd line, vendor call, argument, confession, question-and-answer, or visible action supported by a spoken line.
- **Line**: one short speakable line in the session language. Prefer character dialogue for in-scene conflict; use voiceover or narration for time jumps, montage, historical setup, silent inserts, or facts no character would naturally say.
- **Visual backup**: the action, prop, reaction, or blocking that makes the spoken information feel embodied rather than dumped.

Use this rule:

- If the viewer cannot infer a fact from the image alone in two seconds, put that fact into voiceover or character dialogue.
- If a line sounds like encyclopedia exposition, turn it into conflict, sales talk, gossip, a question, a taunt, a confession, or a joke.
- If using voiceover, keep it in the same spoken language as the session and make it narratively motivated; do not create a new narrator voice every shot unless the whole film has a narrator.
- Do not solve missing information with subtitles, readable signs, UI text, captions, or text overlays unless the user explicitly asked for readable text.
- For satire, the mechanism of the scam must be spoken or acted: the audience should hear the promise, the fear, the price, and the contradiction.
- For comedy, the setup and payoff should both be audience-facing: one line can plant the premise, a reaction or counter-line can land the joke.

Common fixes:

| Hidden prompt fact | Audience-facing rewrite |
| --- | --- |
| "He is afraid technology will replace him." | He whispers, "If I can't learn this by Monday, the office will replace me with a boy who can." |
| "The course is a scam." | The teacher says, "Lesson one: never touch the wire; sell the certificate first." |
| "The lamp is not connected to power." | A skeptic points at the dangling cord: "Your future is bright, sir, but it is not plugged in." |
| "Three months later..." | A single session-level narrator says, "Three months later, every shop had a bulb in the window and no wire in the wall." |

Pre-render story audit:

- Can the agent summarize the film in beginning / middle / end / punchline form?
- Can a cold viewer answer who/where/when/world-rule/relationship/stakes by the first 10 seconds without reading the prompt?
- Does every shot cause the next shot, instead of merely sharing the same theme?
- Does the final shot reverse or complete the first-shot problem?
- Would the story still be understandable if the viewer muted the video?
- Would the story still be understandable without reading the prompt? If not, move the missing facts into `audienceDelivery` as voiceover or character dialogue with visible backup.
- For long videos, do all main recurring protagonists have generated or imported character image assets, and does every applicable shot include those character assets in `assetIds` plus matching `@CharacterName` prompt mentions?
- If the generator produced generic, contaminated, or asset-leaking beats, patch the `StoryPlan` and all affected shot prompts manually before rendering.

## Cinematic Shot Language

Before writing or rendering narrative shots, create a camera grammar plan. The plan must make the camera feel motivated by story, blocking, attention, or continuity. Do not add push-ins, handheld shake, drone moves, whip pans, or close-ups just because they sound cinematic.

For each shot, write these fields into the shot plan or prompt:

1. **Camera motivation**: why the camera moves or stays still. Examples: follow a handoff, reveal a hidden object, tighten pressure during a lie, hold still for deadpan comedy, widen when the character realizes they are isolated.
2. **Coverage ladder**: how the shot size changes inside the 15s clip. Use a deliberate progression such as establishing/WS -> MS/two-shot -> CU/reaction, or keep one locked-off master if the joke depends on awkward stillness.
3. **Axis and screen direction**: define the 180-degree action line for dialogue, sales pitches, chases, queues, or any two-sided exchange. Keep eyelines and left/right movement consistent unless the story wants disorientation and the prompt states that reason.
4. **Blocking before movement**: describe where characters stand, enter, cross, sit, hand over props, or turn before describing the camera move. Camera movement should follow or reveal blocking, not force actors to wander for decoration.
5. **Cut bridge**: name how this shot enters from or exits to the adjacent shot: match on action, eyeline match, prop insert, reaction shot, cutaway, sound bridge, continuing screen direction, tailframe, or previous-tail reference video.
6. **Attention target**: name the one thing the viewer must notice by the end: face reaction, exchanged coin, letter, door, receipt, broken machine, crowd turn, empty room, etc.

Use shot types by function:

| Need | Camera choice |
| --- | --- |
| Establish geography or social scale | EWS/WS/establishing or master shot; hold long enough to read entrances, exits, and power positions |
| Dialogue, bargaining, accusation, seduction, sales pitch | MS/two-shot or OTS shot-reverse-shot with stable 180-degree axis and eyeline match |
| Emotional turn, lie, fear, realization, punchline | CU or MCU reaction shot; hold the reaction half a beat longer for comedy |
| Scam mechanics, clue, payment, invention, weapon, contract, receipt | Insert/cut-in of the object or hands; return to a reaction or wider shot so geography remains clear |
| Off-screen threat, crowd pressure, status contrast | Cutaway or reaction shot that shows what the speaker cannot see or what the audience must infer |
| Rising pressure inside one 15s clip | Slow motivated push-in or lateral track tied to a specific action; avoid repeated generic push-ins across consecutive shots |
| Isolation, failure, anticlimax, satire payoff | Dolly/pull-out, widening frame, or locked-off tableau that lets the absurdity sit |

15-second shot rhythm should normally have a camera arc as well as an action arc:

- `0-3s`: establish geography, axis, and the attention target.
- `3-7s`: actor blocking creates the problem or temptation.
- `7-11s`: motivated camera change reveals new information, pressure, or contradiction.
- `11-15s`: reaction, insert, or exit frame that hands off to the next shot.

For satire and comedy, do not let dialogue alone carry the joke. Use visual punctuation: a reaction close-up, a held wide tableau, a money/object insert, or a cutaway that undercuts the speaker. The final laugh often comes from the person not speaking.

Common amateur patterns to avoid:

- Every shot starts as an unrelated establishing shot, so the film feels restarted four times.
- Every shot uses the same medium push-in, so the camera has no dramatic contrast.
- The prompt lists "cinematic camera movement" without a motivated subject, blocking, speed, or endpoint.
- The edit crosses the axis between two speakers or reverses screen direction without a visible bridge.
- The cut happens after an action finishes instead of during the action, making the seam feel hard.
- A close-up appears before the audience understands the room, the prop, or who is looking at whom.
- A camera move hides the joke instead of staging a clear setup, reveal, reaction, and payoff.

## Long Video Character Consistency Gate

Before generating any long video, MV, multi-shot biopic, episodic scene, or protagonist-led narrative, build a visible character-asset coverage table in the session notes or working checklist.

The table must answer:

1. **Main cast**: each recurring protagonist or featured character, their approved `assetId`, whether the image is generated/imported, and whether the asset matches the session style.
2. **Shot coverage**: for every shot, list visible/speaking/featured characters and the character `assetIds` attached to that shot.
3. **Prompt coverage**: every shot prompt that shows a recurring protagonist must name the matching `@CharacterName` and include a compact identity/style guard.
4. **Blocking gaps**: if a main recurring character only has a prompt-only placeholder, missing media, mismatched style, or missing shot references, stop before Seedance generation and create/import/repair the character asset first.

After the first successful shot establishes an actor face, prefer approved rendered-frame identity anchors for later shots. Extract clear face frames from the accepted render, upload them as visible session assets, publish them to TOS if needed, and use those rendered-frame anchors when a later time jump, costume change, battle scene, or final confrontation must still read as the same performer. Character lookbooks are useful for initial casting; the accepted video frame is the stronger source of truth once the film has already chosen a face.

Do not auto-attach the whole session cast to every shot. A shot reference set should include only characters visible or explicitly mentioned in that shot, plus scene/prop references that have a named function. Too many unrelated cast assets can cause face swaps, age jumps, costume bleed, or the wrong historical figure appearing in the generated video. Before paid render, inspect the exact `assetIds` and `@CharacterName` mentions: remove stale characters, old storyboards, and unneeded background cast.

Parallel generation does not override this gate. A shot can be generated in parallel only after its main-character assets and `assetIds` are already correct.

## Short One-Shot Frame Director

Treat "一镜到底", "one-shot", 30s, and 60s requests as a short one-shot illusion made from visible Seedance segments joined by deliberate first/last-frame continuity.

- 30s = 2 shots/segments; 60s = 4 shots/segments.
- 30min is an edge case: 30min = 120 shots/segments at 15s each. Do not center normal director behavior around this unless the user truly asks for a long-form piece.
- Each segment needs a local beat, an entry state, an exit state, and a continuity handoff to the next segment.
- Do not ask the model to make a true 30s/60s single generation when it exceeds the provider limit. Build a routed chain and stitch it.

Before generating, write these into the session:

1. **Route bible**: fixed geography, start/end points, altitude bands, turn direction, landmarks, forbidden drift, and what must not appear. For drone routes, preserve the path as motion intent; do not render the drawn route line unless the user asks.
2. **Rhythm map**: divide the full duration into 15s segments. Example for 60s: launch 0-15s, climb 15-30s, sweep/loop 30-45s, descent/resolve 45-60s.
3. **Segment sheet**: for every shot, store title, duration, camera motion, entry frame, mid-beat, exit frame, references, continuity mode, and retry note.
4. **Frame bridge plan**: decide how each shot's final frame becomes the next shot's first frame. For 30s/60s one-shot requests, this is the default directing work, not an optional repair step.
5. **Continuity bible**: repeat the same visual identity in every prompt: camera type, world, time of day, skyline/weather, lens feel, color grade, motion smoothness, and negative constraints.

## Frame Mode Decision Table

Use one continuity mode per shot. Do not stack mutually exclusive modes.

| Situation | Use | Patch / action |
| --- | --- | --- |
| Shot 1 must start from an exact uploaded image/composition 首帧 | first-frame anchor | `firstFrameAssetId=<asset>`; no normal reference images for that shot |
| Shot N must begin exactly where shot N-1 ended 尾帧接力 | strict tailframe -> first frame | `seereelcli node tailframe --id <prevShot> --publish-tos --canvas-node --json`, then `firstFrameAssetId=<tailframeAsset>` |
| Shot N should follow previous motion/framing/color but can adapt content | previous-tail reference-video continuity | `usePreviousShotClip=true`, `previousShotClipSec=2` by default; use 3-4 seconds only when motion is complex |
| A long 15s segment needs four in-shot beats | storyboard reference | generate a 2x2 or 3x3 sub-storyboard and attach as `assetIds`; avoid `firstFrameAssetId` unless opening lock matters more |
| User provides a route/reference image | input reference asset | upload as session asset, mention it in route bible, attach to storyboard planning; do not draw it in final unless requested |
| Need a precise end pose for a later segment | last-frame planning | set or preserve `lastFrameAssetId` when available, otherwise extract tailframe after render and connect it visibly |

Default for short one-shot illusion:

- Shot 1: use uploaded/reference image as planning reference; use `firstFrameAssetId` only if the opening frame must match exactly.
- Shot 2+: prefer strict tailframe -> `firstFrameAssetId` when seamless visual continuity matters most. This is the default for 30s/60s one-shot videos.
- If the UI/API exposes `lastFrameAssetId`, preserve the planned exit pose/composition there; otherwise extract the strict tailframe after render and connect it visibly.
- Use `usePreviousShotClip` with `previousShotClipSec=2` when the cut can remain a cut but should carry over lighting, palette, blocking, screen direction, and motion energy. This should use a real trimmed tail clip from the previous video, not the whole previous shot, so the next generation sees the handoff moment rather than unrelated earlier action.
- Generate serially. Wait for shot N, create/publish tailframe if needed, patch shot N+1, then generate N+1.

## Seam Reduction Rules

When a stitched result has obvious seams (hard lighting jump, different color temperature, sudden style change, character position reset, or camera motion discontinuity), repair the earliest seam before regenerating downstream shots.

Use this order:

1. **Prompt bridge**: add a compact entry-frame line to shot N+1 that names the previous shot's final visible state, lighting, palette, character positions, and camera direction.
2. **Previous-tail clip**: for ordinary narrative continuity, regenerate shot N+1 with `usePreviousShotClip=true` and `previousShotClipSec=2`. This trims the previous shot's final two seconds and sends that short clip as Seedance `reference_video`.
3. **Strict tailframe**: if the first frame must exactly match the previous last frame, extract/publish a tailframe from shot N and set it as `firstFrameAssetId` for shot N+1.
4. **Scene reset**: only skip continuity references when the story wants a deliberate hard cut, new location, time jump, dream transition, montage beat, or visual contrast.

Do not parallel-generate adjacent shots that need seam reduction. Parallel generation is appropriate only for visually independent branches: different locations, different characters, montage inserts, alternate takes, or shots that will not use previous-tail, tailframe, `referenceVideoFromShotId`, or other upstream references.

## Prompt Pattern

## Seedance Prompt Contract

Treat every Seedance prompt as a shot contract, not a mood-board paragraph. Official Seedance guidance rewards concrete subject, motion, camera, reference, dialogue, and media-role instructions; vague cinematic adjectives should only support a clear visual plan.

Before paid render, dry-run the final composed prompt and inspect the exact submitted text, not only the agent draft. Remove stale assets, old characters, mixed languages, storyboard-grid wording, subtitle requests, and contradictory media modes before submission.

Write each prompt in this order:

1. **Shot identity**: film title, shot index/count, duration, ratio, narrative role, and explicit shot size/framing such as WS/MS/CU or 远景/中景/近景/特写. Do not let Seedance choose framing by default.
2. **Reference roles**: name which attached assets control face/wardrobe, location/style, camera motion, or audio rhythm. Do not use the maximum number of references by habit; too many references can blur priority and create style conflicts.
3. **Camera grammar**: camera motivation, coverage ladder, axis/screen direction, blocking, attention target, and cut bridge. A move must have a subject, speed, endpoint, and story reason.
4. **Entry frame**: what is visible at 0s, including character positions, lighting, palette, lens, and screen direction.
5. **Chronological motion**: use `0-4s / 4-9s / 9-13s / 13-15s` beats for a 15s clip. List consecutive visible actions in order; do not hide the real action inside abstract tone words.
6. **Audience delivery**: important prompt information as voiceover or character dialogue, with visible backup action or reaction. Do not leave plot-critical facts as private prompt context.
7. **Dialogue and sound**: short speakable lines in the session language, natural diegetic sound only, and no subtitles or readable text unless the story explicitly needs visible text.
8. **Camera and style**: camera movement, lens/composition, shot size/framing, lighting, grade, era/genre guard, and motion intensity.
9. **Exit frame**: the final visual state needed for the next handoff.
10. **Negative constraints**: no style drift, no wrong-era objects, no cartoon/3D render for live action, no mixed-language dialogue, no per-shot music by default, no subtitles, no watermark, no logo.

Media-mode rules:

- `firstFrameAssetId`: the first frame is the literal opening frame. Describe how the image animates forward from that exact composition; do not also attach ordinary reference images that compete with it.
- `lastFrameAssetId`: use only when the API/UI supports a first/last-frame pair or when the planned exit pose must be preserved for a later handoff.
- `reference_video` or `usePreviousShotClip`: the reference video controls motion, camera, rhythm, lighting handoff, and continuity energy; the text prompt still controls the next story action and dialogue. Trim the reference video to only the movement needed, usually 2-4 seconds. Do not send a whole 15-second clip when the next shot only needs the last camera move or handoff moment.
- Storyboard/contact-sheet references are planning aids. If sent directly to Seedance, state that the storyboard guides composition/action progression and must not be rendered as a 3x3 grid with numbers or labels.
- For multi-reference shots, assign each material a function: character anchor, scene tone, camera/motion reference, or audio rhythm. Prefer 4-5 strong references over filling every allowed slot.

Quality gate:

- The prompt has one visible objective and one story-state change.
- Every recurring or featured character in the prompt has matching `assetIds` and `@CharacterName` mentions.
- Prompt prose can be English for model clarity, but quoted dialogue stays in the session spoken language.
- Historical or branded settings include an anachronism/style guard.
- Continuity shots name the previous exit state and choose exactly one continuity mode.
- Every shot states shot size/framing explicitly, because unspoken defaults can jump from wide/medium coverage to close-up portrait framing and break continuity.
- Every shot has motivated camera movement or an intentional lock-off, a clear attention target, and a cut bridge such as match on action, eyeline match, reaction, insert, cutaway, sound bridge, previous-tail, or tailframe.
- Every shot exposes important prompt information through `audienceDelivery`: voiceover or character dialogue plus visible action/reaction. Private prompt-only lore does not count.
- Retry notes follow one variable changed per retry: adjust only the prompt, only the reference set, only the trimmed reference duration, or only the generation parameters, then record what changed and why.

Every Seedance prompt should carry:

1. Continuity bible.
2. Story spine role: setup, trap, escalation, reversal, payoff, or bridge.
3. Segment number and role in the rhythm map.
4. Camera grammar: motivation, coverage ladder, axis/screen direction, blocking, attention target, and cut bridge.
5. Entry frame: what the viewer sees at 0s, including explicit shot size/framing.
6. Motion beats: `0-4s`, `4-9s`, `9-13s`, `13-15s`.
7. Audience delivery: important prompt information delivered through voiceover or character dialogue, with visible action or reaction backup.
8. Dialogue/action packet: 1-3 short lines performed naturally, each attached to a visible gesture, decision, or reaction.
9. Sound packet: normal diegetic audio only, such as the characters' spoken dialogue in one chosen language, room tone, footsteps, props, machinery, street ambience, wind, or crowd murmur; no music score, no BGM, no per-shot soundtrack unless the user explicitly requested a continuous session-level music bed.
10. Exit frame: what must be true at the final frame for the next handoff.
11. Negative constraints: no subtitles, no text overlays, no route line unless requested, no landmark jumps, no teleporting, no style drift, no mixed-language dialogue unless requested, no music score by default.

For drone FPV routes, write like a flight plan: altitude, speed, banking direction, landmark pass order, distance to buildings, water/skyline relation, and exit bearing.

## SeeReel Cloud Workflow

Use this order for full automation:

1. Create/select one session.
2. Upload local user references as cloud assets.
3. For narrative ideas, run the research pass before the first full draft.
4. Save story spine, character functions, beat ladder, dialogue packet, research packet, review packet, and scene objectives into the session `StoryPlan`.
5. Generate or import approved character image assets for every main recurring protagonist/featured character, then patch all applicable shot `assetIds` and `@CharacterName` prompt mentions before video generation.
6. Run review iterations and patch the `StoryPlan`, character assets, shot `assetIds`, and shot prompts until the reviewer is satisfied.
7. Save route bible, rhythm map, and segment sheet in session/shot prompts.
8. Generate server-side storyboard/sub-storyboard assets for the segments.
9. Publish any local references/tailframes to TOS before Seedance.
10. Generate shots serially according to the frame-mode plan.
11. Poll patiently; Seedance can run longer than 15 minutes.
12. After each ready shot, inspect state, extract tailframe when needed, and patch the next shot.
13. Stitch only when required shots are `ready`.
14. Download only the final cloud artifact to the user computer.
15. Return the final path plus a fresh `handoffUrl`, not a raw CLI-only `webUrl`.

## Failure Handling

- Slow task: keep polling same `cgt-*` task; do not duplicate submissions.
- Expired reference URL: republish to TOS or remove from `assetIds`, then retry.
- Bad continuity: regenerate the earliest broken segment before continuing downstream.
- Bad reference-video contamination: trim the reference video shorter, usually to 2-4 seconds around the exact camera/motion handoff, and restate which part of the reference controls motion versus which text controls new content.
- Retry discipline: change one variable per retry and write it into visible notes or prompt metadata. Do not change prompt wording, reference assets, duration, ratio, and generation mode all at once; otherwise the session cannot learn which change fixed or broke the shot.
- Stitch failure: retry `/stitch` before regenerating shots.
- User edits the board: treat the UI state as source of truth and refresh status before continuing.

## Output Checklist

When reporting back, include session id/title, handoff URL, shot count, ready/failed summary, final local path, and what intermediate nodes exist in the cloud session.
