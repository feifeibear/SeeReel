# Generation Workflow

Status: active
Owner: ReelyAI
Last Reviewed: 2026-06-04

## Purpose

Define how ReelyAI creates, edits, reviews, retries, and stitches generated media while keeping user-visible canvas state as the source of truth.

## Scope

- Script, character, scene, storyboard, image, video, review, retry, and stitch workflows.
- Prompt editing before and during generation.
- Seedance, Seedream, Seed text generation, VLM review, and final stitching state.
- API and UI behavior for generation nodes.
- CLI-created sessions and browser handoff behavior for human takeover.

## Non-Goals

- This spec does not define provider pricing.
- This spec does not require paid generation for ordinary local smoke tests.
- This spec does not define every provider-specific parameter.

## User Stories

- As a creator, I can edit prompts while shaping a workflow and see the saved value in the node.
- As a creator, I understand whether the current running provider request used the old prompt or the new prompt.
- As an operator, I can audit which prompt, references, assets, and review settings produced each render.
- As a human reviewer, I can claim a CLI-created workflow in my browser and continue editing it without sharing the CLI cookie identity.

## Product Rules

- Canvas state and ReelyAI APIs are the source of truth for prompts, references, renders, review settings, stitch order, and final video URLs.
- Manual filesystem recovery is allowed only as a recovery step, and recovered media must be written back into visible app state.
- The project globally does not generate subtitles as part of video output.
- Seedance reference inputs must be public or signed `http(s)` URLs, not local `/media/...` preview paths.
- If a provider request has not been submitted, prompt edits must affect the next submission.
- If a provider request has already been submitted, UI must make clear whether the current render uses the old prompt and whether retry/regeneration will use the new prompt.
- Review controls must be interactive and must not be hard-coded differently between local and production.
- CLI and browser identities are isolated by `reelyai_user_id` cookies. A raw CLI `webUrl` must not be described as browser-visible handoff; agents should return a one-time `handoffUrl` when a human needs to claim and edit the workflow.
- Handoff links must be unguessable, time-limited, one-time use, and transfer the session owner to the current browser identity before redirecting to the session workspace.

## Acceptance Criteria

- [ ] A video node can persist prompt edits while queued or rendering.
- [ ] The UI clearly distinguishes saved prompt from submitted prompt when they differ.
- [ ] Retry and regeneration use the current saved prompt unless the user explicitly selects an older render.
- [ ] Review toggle behavior is the same in local and production builds.
- [ ] Stitching only uses ready shots and records the connected order in visible state.
- [ ] No generated video workflow emits subtitle files or burns subtitles by default.
- [ ] A session created under one cookie identity is hidden from a second cookie identity before handoff, visible to the second identity after claiming `handoffUrl`, and no longer visible to the original CLI identity after claim.
- [ ] CLI `workflow --json` includes `webUrlVisibleInBrowser: false` and a `handoffUrl`; `reelyai handoff --session latest --json` can generate a new handoff link for an existing CLI-owned session.

## Verification

- [ ] `npm run verify:offline`
- [ ] Run `npm run smoke:vlm-review-toggle` when review behavior changes.
- [ ] Run `npm run smoke:reelyai-handoff` when cookie ownership or CLI handoff behavior changes.
- [ ] Use the local app to edit a rendering or queued video node prompt and confirm persisted state.
- [ ] For provider-facing changes, verify submitted request payloads with safe test inputs before release.

## Change Policy

Update this spec before changing node status semantics, prompt persistence, provider submission, review toggles, retry policy, stitching behavior, or CLI/browser session handoff behavior.
