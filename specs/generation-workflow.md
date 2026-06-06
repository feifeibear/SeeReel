# Generation Workflow

Status: active
Owner: SeeReel
Last Reviewed: 2026-06-06

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
- Agent director workflows for short one-shot-illusion videos, including route/rhythm planning and first-frame/tailframe/reference-video continuity decisions.
- Agent script-director workflows for narrative, satire, comedy, and dialogue-driven shorts, including story spine, scene objectives, character functions, and dialogue packets before render.
- Agent canvas-review workflows that expand an initial idea into visible script, character, scene, storyboard, shot prompt, and reference-link nodes before any video generation.
- Session style-consistency workflows that keep recurring characters, scenes, props, storyboards, and shot prompts in one visual family before render.

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
- The project globally does not generate subtitles as part of video output.
- Seedance reference inputs must be public or signed `http(s)` URLs, not local `/media/...` preview paths.
- Tail-frame assets used as a next-shot first-frame anchor must be extracted from the strict final decoded frame of the source video, not from an approximate near-end timestamp.
- If a provider request has not been submitted, prompt edits must affect the next submission.
- If a provider request has already been submitted, UI must make clear whether the current render uses the old prompt and whether retry/regeneration will use the new prompt.
- Review controls must be interactive and must not be hard-coded differently between local and production.
- CLI and browser identities are isolated by `seereel_user_id` cookies. A raw CLI `webUrl` must not be described as browser-visible handoff; agents should return a one-time `handoffUrl` when a human needs to claim and edit the workflow.
- Handoff links must be same-origin API links under `/api/handoff/:token`, unguessable, time-limited, one-time use, and transfer the session owner to the current browser identity before redirecting to the session workspace.
- Handoff must not make sessions public or weaken owner checks; users without the original owner cookie or an unclaimed handoff token must keep receiving not-found responses for isolated sessions.
- A CLI cloud-only run that renders video must be able to upload the user reference, generate server-side storyboard assets, render shots, stitch the final video, then download only the final cloud artifact to the user computer.
- 30s/60s one-shot requests must be planned as visible Seedance-sized shot chains with an explicit frame bridge plan. The director skill must teach agents to compute shot count with `Math.ceil(totalDurationSec / 15)`, design a route bible and rhythm map, choose first-frame/tailframe/reference-video modes intentionally, and keep all intermediate nodes visible in the cloud session. 30min requests are treated as an edge case, not the default workflow center.
- Narrative shorts must have a saved story spine before render: title promise, protagonist, want/fear, antagonist or social pressure, escalation, reversal, and payoff.
- Every generated narrative shot must have a scene objective and must change story state. For 60s/4-shot satire or comedy, the director skill should teach a setup -> trap/pitch -> escalation -> reversal/payoff ladder unless the user specifies another structure.
- Dialogue-driven prompts must keep dialogue in `StoryPlan` beats, shot scripts, and prompt intent. They must describe dialogue as naturally performed action and must not depend on subtitles, readable signs, or text overlays to carry plot.
- Dialogue-driven workflows must choose one spoken dialogue language for the session, inferred from the user's request or `Session.language`, and keep every quoted spoken line in that language across `StoryPlan`, shot scripts, and provider prompts. Technical prompt prose may be English, but quoted dialogue must not mix Chinese and English unless the user explicitly asks for multilingual dialogue.
- Generated video prompts must default to natural diegetic sound only: spoken dialogue, room tone, footsteps, props, machinery, street ambience, wind, crowd murmur, breathing, and other in-world sounds. Agents must not add per-shot background music, BGM, score, soundtrack, stingers, or music cues by default because separately generated music does not stitch continuously. If the user explicitly requests music, it must be defined as one continuous session-level music bed rather than different music per shot.
- Script-chat workflows must establish a session style bible before recurring asset generation and reuse it in character, scene, prop, storyboard, and shot prompts. VLM style-mismatch reasons such as cartoon, anime, 3D render, illustration, plastic skin, toy proportions, or wrong-era look are blocking for recurring assets even when the numeric review score is high.
- Script-chat workflows must extract every on-screen speaking or featured character as a session-scoped character asset whenever possible, not only the protagonist or originally named cast. Any recurring, cross-shot, named, speaking, or featured character must have a generated or imported visual asset before video generation; prompt-only character assets are draft-only.
- Before render, every shot `assetIds` list must include the character assets for that shot's visible speaking or featured characters. When an agent adds a new character to an existing shot, it must create/generate or import that character asset and patch dependent shot `assetIds` in the same workflow step.
- When a recurring asset is repaired or regenerated for style consistency, all dependent shot prompts must be patched with a compact style guard before regenerating those shots.
- Review-first canvas planning must stop before video generation. The canvas must contain a saved `StoryPlan`, recurring character assets, recurring scene assets, shot nodes, per-shot prompts, storyboard prompts, and explicit `assetIds` links showing which character/scene/storyboard references each shot needs.
- The top bar credential entrypoint is named `API Keys`; inside it, users can save a BytePlus standard API key, a Volcengine CN standard API key, or an Agent Plan key.
- Seedream and Seedance standard API routes must use these endpoints unless explicitly overridden by route-specific env: BytePlus uses `https://ark.ap-southeast.bytepluses.com/api/v3`; Volcengine CN uses `https://ark.cn-beijing.volces.com/api/v3`; Agent Plan uses `https://ark.cn-beijing.volces.com/api/plan/v3`.
- Browser, CLI, and server-side Seedream/Seedance generation must resolve credential families in this order: BytePlus standard API, Volcengine CN standard API, Agent Plan. Within each family, request/browser credentials may be used before same-family environment credentials.
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
| `seereel-shortdrama` | End-to-end directing, planning, storyboard, Seedance generation, repair, continuity, and stitch workflows. |
| `seereel-canvas-review` | Review-first intake that turns a rough idea into visible script, character, scene, storyboard, shot prompt, and reference-link canvas nodes without video generation. |
| `seereel-agent-session` | REST-driven session, asset, storyboard, shot, render, poll, and stitch operations against visible SeeReel state. |
| `seereel-cli` | Local or published CLI operation, workflow creation, handoff, node control, review, repair, publish-to-TOS, render, and stitch. |
| `seereel-script-chat` | Guided story, casting, dialogue, beat ladder, shot count, and StoryPlan preparation before render. |
| `seereel-storyboard-imagegen` | Cinematic 3x3 storyboard contact-sheet prompting for one Seedance shot and clean reference planning. |
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
- [ ] No generated video workflow emits subtitle files or burns subtitles by default.
- [ ] A session created under one cookie identity is hidden from a second cookie identity before handoff, visible to the second identity after claiming `handoffUrl`, and no longer visible to the original CLI identity after claim.
- [ ] CLI `workflow --json` includes `webUrlVisibleInBrowser: false` and a same-origin `/api/handoff/:token` `handoffUrl`; `seereelcli handoff --session latest --json` can generate a new handoff link for an existing CLI-owned session.
- [ ] Reusing a claimed handoff token returns not-found and does not transfer ownership again.
- [ ] `seereelcli workflow --cloud-only --reference-image <path-or-url> --render --stitch --output <file>` uploads the reference as an input asset, performs storyboard/render/stitch through server APIs, returns a handoff URL, and downloads the final cloud artifact without creating local intermediate media.
- [ ] `npm run smoke:seereel-director-skill` passes and proves the SeeReel director skill covers short one-shot illusion planning, 30s-to-2-shot and 60s-to-4-shot decomposition, frame bridge planning, route bible/rhythm map design, first-frame/tailframe/reference-video continuity, long Seedance waits, and cloud-session visibility.
- [ ] `npm run smoke:seereel-director-skill` also proves the director skill covers story spine, character functions, scene objectives, beat ladder, dialogue packets, no-subtitle dialogue handling, and manual prompt repair before render when a draft is incoherent.
- [ ] `npm run smoke:seereel-director-skill` also proves the director and script-chat skills require one spoken dialogue language per session, natural diegetic sound, and no per-shot music/BGM/score by default.
- [ ] `npm run smoke:seereel-director-skill` also proves the script-chat skill covers session style bible, style locks, consistency gate, character asset coverage for visible/speaking/featured characters, generated/imported visual requirements for cross-shot characters, blocking VLM style mismatches despite high scores, and dependent-shot style guards after asset repair.
- [ ] `npm run smoke:seereel-canvas-review-skill` passes and proves the canvas-review skill covers review-first script expansion, character assets, scene assets, storyboards, shot prompts, `assetIds` reference links, human approval, manual-edit refresh, and no video generation before approval.
- [ ] When BP, CN, and Agent Plan credentials all exist, Seedream/Seedance generation uses the BP standard route; when BP is absent and CN plus Agent Plan exist, it uses the CN standard route; when both standard routes are absent, it falls back to Agent Plan.
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
- [ ] Run `npm run smoke:seereel-director-skill` when agent director, script-director, one-shot, first-frame, tailframe, route-planning, beat-ladder, dialogue-prompt, style-bible, asset-style-lock, character-asset coverage, or consistency-gate skill behavior changes.
- [ ] Run `npm run smoke:seereel-canvas-review-skill` when review-first canvas intake, script expansion, character/scene/storyboard planning, or shot-reference skill behavior changes.
- [ ] Run `npm run install:skill -- --agent all --dry-run` when skill files, skill routing, or skill installation behavior changes.
- [ ] Check `diff -u .agents/skills/seereel-cli/SKILL.md packages/seereel-cli/skills/seereel-cli/SKILL.md` when CLI skill guidance changes.
- [ ] Run `npm run smoke:session-portability` when session export/import behavior changes.
- [ ] Run `npm run smoke:tailframe-strict` when tail-frame extraction or first-frame chaining changes.
- [ ] Use the local app to edit a rendering or queued video node prompt and confirm persisted state.
- [ ] For provider-facing changes, verify submitted request payloads with safe test inputs before release.
- [ ] For credential-routing changes, run `npm run test:ark-credentials`, the relevant CLI smoke, and `npm run smoke:secrets`.

## Change Policy

Update this spec before changing node status semantics, prompt persistence, provider submission, review toggles, retry policy, stitching behavior, CLI/browser session handoff behavior, or agent skill packaging/routing behavior.
