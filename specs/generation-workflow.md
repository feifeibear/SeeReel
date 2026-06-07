# Generation Workflow

Status: active
Owner: SeeReel
Last Reviewed: 2026-06-07

## Purpose

Define how SeeReel creates, edits, reviews, retries, and stitches generated media while keeping user-visible canvas state as the source of truth.

## Scope

- Script, character, scene, storyboard, image, video, review, retry, and stitch workflows.
- Prompt editing before and during generation.
- Seedance, Seedream, Seed text generation, VLM review, and final stitching state.
- API and UI behavior for generation nodes.
- CLI-created sessions and browser handoff behavior for human takeover.
- CLI cloud-only production runs where user-provided local素材 may be uploaded once, while generated intermediates are created and stored by SeeReel server tasks.
- Cross-agent skill packaging and routing for Codex, Claude Code, Cursor, and generic Agent Skills runtimes.
- Agent skill orchestration that routes initial idea -> script -> casting/assets -> cinematography -> final canvas review -> approved generation.
- Script-development workflows that collect character, plot, and historical background material before first draft, then revise through review passes before locking `StoryPlan`.
- Casting and production-design workflows that create/import/review character, scene, prop/style, and reference assets and keep `assetIds` auditable.
- Cinematography workflows that turn locked `StoryPlan` plus approved assets into storyboards, shot nodes, camera grammar, continuity wiring, and Seedance-ready `rawPrompt`/`prompt`.
- Final canvas-review workflows that compare all visible canvas nodes, prompts, edges, assets, storyboards, and continuity fields back to the initial idea and locked StoryPlan before video generation.
- Session style-consistency workflows that keep recurring characters, scenes, props, storyboards, and shot prompts in one visual family before render.
- Narrative orientation workflows that make character identity, era/background, scene arena, world rules, relationships, and stakes audience-facing before render.

## Non-Goals

- This spec does not define provider pricing.
- This spec does not require paid generation for ordinary local smoke tests.
- This spec does not define every provider-specific parameter.

## User Stories

- As a creator, I can edit prompts while shaping a workflow and see the saved value in the node.
- As a creator, I understand whether the current running provider request used the old prompt or the new prompt.
- As an operator, I can audit which prompt, references, assets, and review settings produced each render.
- As a human reviewer, I can claim a CLI-created workflow in my browser and continue editing it without sharing the CLI cookie identity.
- As a creator, I can choose among BytePlus standard API, Volcengine CN standard API, and Agent Plan credentials for Seedream image generation and Seedance video generation.
- As an AI agent, I can discover the right SeeReel skill for the user's intent and operate the same visible app state across Codex, Claude Code, Cursor, and CLI package installs.
- As a creator, I can export a complete session package from the UI and import it on another machine as my own editable copy.

## Product Rules

- Canvas state and SeeReel APIs are the source of truth for prompts, references, renders, review settings, stitch order, and final video URLs.
- Manual filesystem recovery is allowed only as a recovery step, and recovered media must be written back into visible app state.
- In CLI cloud-only mode, local files are allowed only as user input references. Characters, scenes, storyboards, shot videos, stitch outputs, and final videos must be produced through SeeReel APIs/server jobs, persisted in canvas state, and not fabricated from local scratch media.
- Generated video workflows do not emit subtitle files or burn subtitles by default. The post-stitch audio-track node is the only allowed subtitle surface: it may either add no subtitles or burn the narration script into the narrated mp4 when the user explicitly selects that option and position.
- Seedance reference inputs must be public or signed `http(s)` URLs, not local `/media/...` preview paths.
- Tail-frame assets used as a next-shot first-frame anchor must be extracted from the strict final decoded frame of the source video, not from an approximate near-end timestamp.
- Previous-shot continuity clips must be real trimmed tail clips, not merely metadata labels on a full previous shot. When `usePreviousShotClip` is enabled, generation should default to the previous shot's final 2 seconds, persist the local preview in visible shot state, and publish the trimmed clip to TOS before sending it as Seedance `reference_video`. A full previous-shot reference is only an acceptable fallback when tail extraction or publish fails.
- The video-node UI must expose "previous tail clip" continuity as a first-class control for shot 2+, with a 2-second default and editable seconds. This control is mutually exclusive with first/last-frame mode and explicit reference-video wiring.
- If a provider request has not been submitted, prompt edits must affect the next submission.
- If a provider request has already been submitted, UI must make clear whether the current render uses the old prompt and whether retry/regeneration will use the new prompt.
- Review controls must be interactive and must not be hard-coded differently between local and production.
- CLI and browser identities are isolated by `seereel_user_id` cookies. A raw CLI `webUrl` must not be described as browser-visible handoff; agents should return a one-time `handoffUrl` when a human needs to claim and edit the workflow.
- Handoff links must be same-origin API links under `/api/handoff/:token`, unguessable, time-limited, one-time use, and transfer the session owner to the current browser identity before redirecting to the session workspace.
- Handoff must not make sessions public or weaken owner checks; users without the original owner cookie or an unclaimed handoff token must keep receiving not-found responses for isolated sessions.
- A CLI cloud-only run that renders video must be able to upload the user reference, generate server-side storyboard assets, render shots, stitch the final video, then download only the final cloud artifact to the user computer.
- 30s/60s one-shot requests must be planned as visible Seedance-sized shot chains with an explicit frame bridge plan. The director skill must teach agents to compute shot count with `Math.ceil(totalDurationSec / 15)`, design a route bible and rhythm map, choose first-frame/tailframe/reference-video modes intentionally, and keep all intermediate nodes visible in the cloud session. 30min requests are treated as an edge case, not the default workflow center.
- Narrative and dialogue workflows should prefer full 15-second Seedance shots. Agents should pack multiple related story beats into one 15s shot using internal motion beats when character, location, lighting, and emotional continuity are shared. Agents should not create one shorter video per beat unless a hard cut, location jump, time jump, or continuity reset is dramatically necessary; in-shot consistency is usually stronger than cross-shot consistency.
- Narrative shots that share location, time of day, lighting, characters, or camera direction should not be treated as independent just because their story beats are different. Generate them serially and use previous-tail continuity (`usePreviousShotClip: true`, `previousShotClipSec: 2`) unless the cut is meant to be visibly hard. Use strict tailframe-to-first-frame anchoring when the next shot must begin on the exact final composition of the previous shot.
- Narrative shorts must have a saved story spine before render: title promise, protagonist, want/fear, antagonist or social pressure, escalation, reversal, and payoff.
- When a user gives a rough script idea or inspiration, the agent must research relevant characters, plot mechanisms, and historical background before writing the first complete draft. Research can use web search, local memory, user-provided references, or reliable primary/secondary sources, and the useful findings must be summarized in visible `StoryPlan` state.
- Research notes must explain how sources affect character assets, scene assets, beats, shot prompts, or anachronism constraints. Research must not remain only in private agent scratch notes.
- After the first script draft, `seereel-script-chat` must run script review iterations and patch the `StoryPlan` until the reviewer is satisfied or a bounded review loop reaches unresolved blockers. New script ideas require at least two review passes before `StoryPlan` lock.
- Unless the user explicitly asks for `交互模式`, discussion, or questions, the agent should work autonomously through research, drafting, review, revision, and canvas creation. Missing preferences should be inferred conservatively unless they are hard blockers.
- Every generated narrative shot must have a scene objective and must change story state. For 60s/4-shot satire or comedy, the director skill should teach a setup -> trap/pitch -> escalation -> reversal/payoff ladder unless the user specifies another structure.
- Dialogue-driven prompts must keep dialogue in `StoryPlan` beats, shot scripts, and prompt intent. They must describe dialogue as naturally performed action and must not depend on subtitles, readable signs, or text overlays to carry plot.
- Story-critical prompt information must be audience-facing. Agents must turn facts required to understand the plot, joke, scam, relationship, time jump, threat, or reversal into `audienceDelivery` entries delivered through voiceover or character dialogue, with visible action/reaction backup. Private prompt-only lore, subtitles, readable signs, UI text, captions, and text overlays do not count unless the user explicitly asks for readable text.
- Narrative shorts must include an opening orientation packet before render. By the first 10 seconds, a cold viewer should be able to answer who the protagonist is, where the story happens, when or what era/rule governs it, what relationship drives the scene, and why the moment matters. Every main character's first appearance must include `identityDelivery` through action, dialogue, voiceover, prop behavior, or a motivated establishing/master shot. The agent must not assume the viewer knows product names such as Codex, asset titles, prompt lore, or prior chat context.
- Dialogue-driven workflows must choose one spoken dialogue language for the session, inferred from the user's request or `Session.language`, and keep every quoted spoken line in that language across `StoryPlan`, shot scripts, and provider prompts. Technical prompt prose may be English, but quoted dialogue must not mix Chinese and English unless the user explicitly asks for multilingual dialogue.
- Seedance video prompt composition must enforce the session spoken-language lock in the submitted payload, not only in agent guidance. Auto-composed prompts and user-edited composed prompts must both include a language-lock block that says all audible character dialogue stays in the session language and forbids accidental bilingual or foreign-language dialogue unless explicitly requested.
- Agent-written Seedance prompts must follow a shot-contract structure before paid render: shot identity, reference roles, entry frame, explicit shot size/framing, chronological `0-4s / 4-9s / 9-13s / 13-15s` motion beats, dialogue/sound, camera/style, exit frame, and negative constraints. Agents must dry-run or inspect the final composed prompt and remove stale assets, old characters, mixed languages, storyboard-grid instructions, or contradictory first-frame/reference-video modes. Multi-reference prompts must assign each material a function such as character anchor, scene tone, camera/motion reference, or audio rhythm rather than filling every available reference slot by habit.
- Agent-written narrative prompts must include cinematic camera grammar before paid render: camera motivation, coverage ladder, axis/screen direction, blocking, attention target, and cut bridge. Camera movement must have a subject, speed, endpoint, and story reason; otherwise the agent should choose an intentional lock-off. Adjacent narrative shots should use continuity editing ideas such as 180-degree axis consistency, eyeline match, match on action, reaction shots, inserts, cutaways, sound bridges, previous-tail clips, or tailframes so the stitched film does not feel like unrelated generated clips.
- Reference-video continuity should use the shortest useful clip, usually 2-4 seconds around the needed motion, camera move, or handoff. Agents must not send an entire previous 15-second shot when only the final camera/motion cue is needed.
- Retry workflows should change one variable at a time and record the change in visible session notes or prompt metadata: prompt wording, reference set, trimmed reference duration, or generation parameters. Agents must avoid changing prompt, references, duration, ratio, and mode all in one retry when diagnosing a failed shot.
- Generated video prompts must default to natural diegetic sound only: spoken dialogue, room tone, footsteps, props, machinery, street ambience, wind, crowd murmur, breathing, and other in-world sounds. Agents must not add per-shot background music, BGM, score, soundtrack, stingers, or music cues by default because separately generated music does not stitch continuously. If the user explicitly requests music, it must be defined as one continuous session-level music bed rather than different music per shot.
- `seereel-casting-assets` must establish a session style bible before recurring asset generation and reuse it in character, scene, prop, storyboard, and shot prompts. VLM style-mismatch reasons such as cartoon, anime, 3D render, illustration, plastic skin, toy proportions, or wrong-era look are blocking for recurring assets even when the numeric review score is high.
- `seereel-casting-assets` should extract every on-screen speaking or featured character as a session-scoped character asset whenever possible, not only the protagonist or originally named cast. Recurring, cross-shot, named, speaking, or featured characters need an explicit continuity plan; generated/imported visual assets are preferred, but prompt-only, storyboard-only, or rendered-frame continuity can be valid when recorded deliberately.
- Before render, every shot `assetIds` list must include the character assets for that shot's visible speaking or featured characters. When an agent adds a new character to an existing shot, it must create/generate or import that character asset and patch dependent shot `assetIds` in the same workflow step.
- Seedance generation must not automatically attach the whole session cast to every shot. Session StoryPlan cast assets may be auto-added only when the shot prompt explicitly `@mentions` that character; manually wired `shot.assetIds` remain valid, but stale/unrelated cast must be removed before paid render.
- Once a rendered shot establishes an accepted recurring character face, later continuity repairs should prefer rendered-frame identity anchors extracted from that accepted video over the original lookbook. The extracted frames must be uploaded or published as visible session assets before reuse so the identity chain remains auditable.
- When a recurring asset is repaired or regenerated for style consistency, `seereel-casting-assets` must report dependent shots and `seereel-cinematography` must patch those shot prompts with a compact style guard before regenerating those shots.
- The staged review workflow must stop before video generation. The canvas must contain a saved locked `StoryPlan`, approved recurring character assets, approved recurring scene assets, shot nodes, per-shot prompts, storyboard prompts, and explicit `assetIds` links showing which character/scene/storyboard references each shot needs.
- `seereel-canvas-review` is the final consistency gate. It must compare the current canvas to the initial idea and locked `StoryPlan`; check node prompts, edges, `assetIds`, storyboard references, and continuity fields; then either PASS or route each failure back to `seereel-script-chat`, `seereel-casting-assets`, `seereel-cinematography`, `seereel-cli`, or `seereel-agent-session`.
- The top bar credential entrypoint is named `API Keys`; inside it, users can save a BytePlus standard API key, a Volcengine CN standard API key, or an Agent Plan key.
- Seedream and Seedance standard API routes must use these endpoints unless explicitly overridden by route-specific env: BytePlus uses `https://ark.ap-southeast.bytepluses.com/api/v3`; Volcengine CN uses `https://ark.cn-beijing.volces.com/api/v3`; Agent Plan uses `https://ark.cn-beijing.volces.com/api/plan/v3`.
- Browser, CLI, and server-side Seedream/Seedance generation must resolve credential families in this order: BytePlus standard API, Volcengine CN standard API, Agent Plan. Within each family, request/browser credentials may be used before same-family environment credentials.
- The site/admin Agent Plan free-trial path is active only when no standard Ark API key is available for the request or environment and the user has not supplied their own Agent Plan key. A configured BytePlus or CN standard Ark key must not be blocked by Agent Plan free-trial user/IP/global quota.
- Session export packages must contain the visible session, shots, related assets, stitch jobs, prompt/review/render metadata, and local `/media/...` previews needed to reopen the workflow elsewhere.
- Session export packages must not contain API keys, Agent Plan keys, access tokens, admin credentials, cookies, or environment variables.
- Session import must create a new editable copy owned by the current browser identity. It must remap session, shot, asset, stitch, and render ids, and rewrite all internal references so the imported canvas keeps its graph links, first-frame/tail-frame continuity, reference-video wiring, stitch order, and local media previews.
- Importing a package must not overwrite an existing session unless the user explicitly chooses a future overwrite mode. The default UI path is copy-import.

## Agent Skill System

- `.agents/skills/` is the single source of truth for project skills. Runtime-specific directories such as `.cursor/skills/`, `.claude/skills/`, `~/.codex/skills/`, `~/.claude/skills/`, `~/.cursor/skills/`, and `~/.agents/skills/` are install or mirror surfaces.
- `CLAUDE.md` must continue to point at `AGENTS.md`, so Claude Code reads the same project context as Codex and other agents.
- `npm run install:skill` must copy selected skills from `.agents/skills/` to detected or requested runtimes without making any runtime the canonical source.
- `packages/seereel-cli/skills/seereel-cli/SKILL.md` is the npm package's bundled CLI skill. It must stay in sync with `.agents/skills/seereel-cli/SKILL.md` whenever CLI behavior, credential guidance, handoff behavior, render behavior, or node-control behavior changes.
- `seereelcli skill install --agent all` installs only the bundled `seereel-cli` skill to global runtime skill folders. It does not replace the full repo skill set.
- Agent-facing docs must describe the same skill model: `AGENTS.md`, `README.md`, `README.zh-CN.md`, `.agents/skills/*/SKILL.md`, and the CLI bundled skill should not disagree about source-of-truth paths, credential precedence, handoff URLs, or production safety boundaries.
- Agents should route user intent to skills as follows:

| Skill | Primary use |
| --- | --- |
| `seereel-shortdrama` | End-to-end orchestration, stage routing, approval gates, fallback ownership, and transition into approved render/stitch. |
| `seereel-script-chat` | Initial idea or source material -> researched, reviewed, locked `StoryPlan`; no asset creation or final Seedance prompt ownership. |
| `seereel-casting-assets` | Locked `StoryPlan` -> approved character/scene/prop/style assets, style bible, coverage table, and `assetIds`; no plot/dialogue or final prompt ownership. |
| `seereel-cinematography` | Locked `StoryPlan` plus approved assets -> storyboard plan, shot nodes, camera grammar, continuity wiring, and `rawPrompt`/`prompt`; no script or asset approval ownership. |
| `seereel-canvas-review` | Final consistency review of initial idea, locked `StoryPlan`, node prompts, edges, `assetIds`, storyboard references, continuity, and fallback routing before video generation. |
| `seereel-agent-session` | REST-driven session, asset, storyboard, shot, render, poll, TOS publish, and stitch operations against visible SeeReel state. |
| `seereel-cli` | Local or published CLI transport, configuration, workflow creation, handoff, node control, publish-to-TOS, render polling, repair commands, download, and stitch. |
| `seereel-storyboard-imagegen` | Cinematic declared-grid storyboard contact-sheet and clean-keyframe prompting for one shot; no full Seedance prompt ownership. |
| `vibe-creating-prompt` | Video prompt polishing when the user's input is emotional, atmospheric, memory-like, or Vibe Creating oriented. |

- The listed project skills may call into the same SeeReel APIs or CLI, but the visible web app state remains the production handoff surface.
- Adding, deleting, renaming, or materially changing a skill is an agent-workflow change and must update this spec, the relevant README/AGENTS guidance, and any affected smoke tests in the same change.

## Acceptance Criteria

- [ ] A video node can persist prompt edits while queued or rendering.
- [ ] The UI clearly distinguishes saved prompt from submitted prompt when they differ.
- [ ] Retry and regeneration use the current saved prompt unless the user explicitly selects an older render.
- [ ] Review toggle behavior is the same in local and production builds.
- [ ] Stitching only uses ready shots and records the connected order in visible state.
- [ ] Tail-frame extraction returns the source video's strict final decoded frame and preserves the decoded frame dimensions.
- [ ] Enabling previous-tail continuity on shot 2+ defaults to 2 seconds, persists the chosen seconds, clears mutually exclusive first/last-frame and explicit reference-video fields, generates a local tail-clip preview, and sends a published trimmed tail clip as Seedance `reference_video` when TOS is configured.
- [ ] No generated video workflow emits subtitle files or burns subtitles by default; the post-stitch audio-track node exposes only "no subtitles" and "burn subtitles into video" modes, with a selectable burn-in position.
- [ ] A session created under one cookie identity is hidden from a second cookie identity before handoff, visible to the second identity after claiming `handoffUrl`, and no longer visible to the original CLI identity after claim.
- [ ] CLI `workflow --json` includes `webUrlVisibleInBrowser: false` and a same-origin `/api/handoff/:token` `handoffUrl`; `seereelcli handoff --session latest --json` can generate a new handoff link for an existing CLI-owned session.
- [ ] Reusing a claimed handoff token returns not-found and does not transfer ownership again.
- [ ] `seereelcli workflow --cloud-only --reference-image <path-or-url> --render --stitch --output <file>` uploads the reference as an input asset, performs storyboard/render/stitch through server APIs, returns a handoff URL, and downloads the final cloud artifact without creating local intermediate media.
- [ ] `npm run smoke:seereel-skill-boundaries` passes and proves each SeeReel skill has a non-overlapping boundary: script, casting/assets, cinematography, final review, orchestration, and transport.
- [ ] `npm run smoke:seereel-director-skill` passes and proves `seereel-shortdrama` orchestrates the staged pipeline, gates paid generation on `seereel-canvas-review`, and routes story, asset, and shot failures to their owning skills.
- [ ] `npm run smoke:seereel-director-skill` also proves `seereel-script-chat` owns research, script review, and `StoryPlan`, while explicitly avoiding asset creation and final Seedance prompt ownership.
- [ ] `npm run smoke:seereel-director-skill` also proves `seereel-casting-assets` owns style bible, character asset coverage, asset APIs, and visual consistency without rewriting plot/dialogue or final shot prompts.
- [ ] `npm run smoke:seereel-director-skill` also proves `seereel-cinematography` owns storyboard, shot nodes, camera grammar, continuity wiring, and the Seedance prompt contract without rewriting script or approving assets.
- [ ] `npm run smoke:seereel-director-skill` also proves `seereel-storyboard-imagegen` is limited to declared-grid storyboard reference images and does not own the full Seedance video prompt.
- [ ] `npm run smoke:seedance-language-lock` proves Seedance prompt composition adds a submitted spoken-language lock for Chinese and English sessions, including user-edited composed prompts.
- [ ] `npm run smoke:seedance-cast-filter` proves Seedance prompt composition only auto-adds StoryPlan cast assets explicitly `@mentioned` in the shot prompt and does not attach the whole session cast from plain prose.
- [ ] `npm run smoke:seereel-canvas-review-skill` passes and proves `seereel-canvas-review` checks initial idea, locked `StoryPlan`, node prompts, edges, `assetIds`, storyboard references, continuity wiring, still-reference readiness, and fallback ownership while blocking video generation before approval.
- [ ] When BP, CN, and Agent Plan credentials all exist, Seedream/Seedance generation uses the BP standard route; when BP is absent and CN plus Agent Plan exist, it uses the CN standard route; when both standard routes are absent, it falls back to Agent Plan.
- [ ] When a browser or environment BytePlus/CN standard Ark API key exists, generation does not consume or get blocked by the site/admin Agent Plan free-trial quota.
- [ ] The UI `API Keys` panel exposes separate BytePlus API, CN API, and Agent Plan choices without returning raw key values after save.
- [ ] CLI `configure` can save a standard API key, prefers it over Agent Plan for render/review credential bootstrap, and prints only configured/not-configured status.
- [ ] `.agents/skills/` contains the complete project skill set documented in this spec, and runtime mirror directories are treated as generated/install surfaces rather than sources of truth.
- [ ] `.agents/skills/seereel-cli/SKILL.md` and `packages/seereel-cli/skills/seereel-cli/SKILL.md` match whenever CLI skill behavior changes.
- [ ] `CLAUDE.md` resolves to `AGENTS.md`, and AGENTS/README guidance stays consistent with the skill source-of-truth model.
- [ ] `npm run install:skill -- --agent all --dry-run` shows every project skill being installable to the supported runtime targets.
- [ ] The UI can download the selected session as a `.seereel-session` package.
- [ ] The UI can load a `.seereel-session` package, create a new current-user-owned session, and preserve all internal graph references after id remapping.
- [ ] Session packages include local media bytes for `/media/...` previews but do not include credentials or raw secret material.

## Verification

- [ ] `npm run verify:offline`
- [ ] Run `npm run smoke:vlm-review-toggle` when review behavior changes.
- [ ] Run `npm run smoke:seereel-handoff` when cookie ownership or CLI handoff behavior changes.
- [ ] Run `npm run smoke:seereel-cli-cloud-only` when CLI cloud-only workflow behavior changes.
- [ ] Run `npm run smoke:seereel-skill-boundaries` when SeeReel skill ownership, skill names, or cross-skill responsibilities change.
- [ ] Run `npm run smoke:seereel-director-skill` when orchestration, script-development, casting/assets, cinematography, storyboard-reference, or fallback-routing skill behavior changes.
- [ ] Run `npm run smoke:seereel-director-skill` and `npm run smoke:seereel-canvas-review-skill` when orientationPacket, identityDelivery, opening exposition, first-appearance, cold-viewer audit, or final canvas-review guidance changes.
- [ ] Run `npm run smoke:seedance-cast-filter` when Seedance reference asset composition, StoryPlan cast auto-add behavior, prompt mention handling, or per-shot `assetIds` filtering changes.
- [ ] Run `npm run smoke:seereel-canvas-review-skill` when final canvas consistency review, still-reference completion, fallback routing, or pre-generation approval behavior changes.
- [ ] Run `npm run install:skill -- --agent all --dry-run` when skill files, skill routing, or skill installation behavior changes.
- [ ] Check `diff -u .agents/skills/seereel-cli/SKILL.md packages/seereel-cli/skills/seereel-cli/SKILL.md` when CLI skill guidance changes.
- [ ] Run `npm run smoke:session-portability` when session export/import behavior changes.
- [ ] Run `npm run smoke:tailframe-strict` when tail-frame extraction or first-frame chaining changes.
- [ ] Run `npm run smoke:seereel-director-skill` and `npm run smoke:specs` when previous-tail continuity guidance or UI behavior changes.
- [ ] Run `npm run smoke:seedance-language-lock` when Seedance prompt composition, session language handling, or user-edited composed prompt submission changes.
- [ ] Use the local app to edit a rendering or queued video node prompt and confirm persisted state.
- [ ] For provider-facing changes, verify submitted request payloads with safe test inputs before release.
- [ ] For credential-routing changes, run `npm run test:ark-credentials`, the relevant CLI smoke, and `npm run smoke:secrets`.

## Change Policy

Update this spec before changing node status semantics, prompt persistence, provider submission, review toggles, retry policy, stitching behavior, CLI/browser session handoff behavior, or agent skill packaging/routing behavior.
