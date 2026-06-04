# Default Demo Session

Status: active
Owner: SeeReel
Last Reviewed: 2026-06-04

## Purpose

Define how new users discover a working SeeReel example immediately after opening the app.

## Scope

- Default sessions shown in the web UI.
- Demo sessions such as `ses_demo_agent_plan` and generated variants.
- Example content that demonstrates canvas flexibility, prompt editing, references, review, generation, and stitch flow.

## Non-Goals

- This spec does not require checked-in generated media fixtures.
- This spec does not define every marketing copy block.
- This spec does not require paid generation when a static demo state is enough.

## User Stories

- As a new user, I can open SeeReel and immediately see a complete example session.
- As a product evaluator, I can understand how to use Seedance, Seedream, Seed text, review, and stitching in one workflow.
- As an operator, I can update the demo without breaking CI or Docker builds.

## Product Rules

- Default demo content must be visible in the app, not hidden in private scratch files.
- Demo sessions should showcase characters, scenes, shots, references, review settings, and stitch order.
- Demo state should not require checked-in binary fixtures unless the release process explicitly supports them.
- If a local demo session ID is promoted as default, the web UI must route users to it consistently.
- Example content must respect the global no-subtitle rule.

## Acceptance Criteria

- [ ] A first-time visitor can see a default example session without manual setup.
- [ ] The example demonstrates Seedance video, Seedream image, Seed text, review, and stitching concepts.
- [ ] `ses_demo_agent_plan` or its configured successor is reachable from the local app.
- [ ] Production uses the same default-session selection code path as local.
- [ ] Docker builds do not depend on missing checked-in fixture directories.

## Verification

- [ ] `npm run verify:offline`
- [ ] Open `http://localhost:5173/#/s/ses_demo_agent_plan`.
- [ ] Open the app with no explicit session and confirm the default example is visible.
- [ ] For release work, verify the same path on `https://seereel.studio`.

## Change Policy

Update this spec before changing default session selection, demo content storage, checked-in demo assets, or first-run behavior.

