# UI System

Status: active
Owner: SeeReel
Last Reviewed: 2026-06-04

## Purpose

Define the durable visual and interaction rules for the SeeReel workstation so the canvas stays readable, premium, and useful across desktop, narrow desktop, and mobile screens.

## Scope

- Canvas background, node contrast, panels, toolbars, inspector surfaces, and responsive behavior.
- Local development, production local runs, and the deployed site.
- Visual rules that affect the main SeeReel session workspace.

## Non-Goals

- This spec does not define marketing landing pages.
- This spec does not choose exact copy for every button.
- This spec does not replace component-level implementation details.

## User Stories

- As a creator, I can read node labels and status information at a glance.
- As a mobile user, I can inspect a session without text overlapping or controls disappearing.
- As an operator, I can visually distinguish canvas, nodes, active selections, and side panels.

## Product Rules

- The canvas and nodes must not use the same effective darkness level; node boundaries must remain visible without hover.
- Primary actions must remain reachable on desktop and mobile, but dense toolbars should collapse or wrap instead of clipping text.
- Button text must fit its container at supported viewport widths.
- UI hierarchy should be calm and product-focused; avoid decorative effects that reduce readability.
- SeeReel is an operational creative workstation, so the first screen should be usable product UI rather than a marketing splash.
- UI must preserve spatial continuity: content or controls already shown to the user must not disappear and reappear somewhere else unless the movement is caused by an explicit user action such as navigation, tab switching, filtering, expanding, collapsing, or responsive layout transition.

## Acceptance Criteria

- [ ] Node title, status, and primary action controls are readable on a 390px-wide viewport.
- [ ] Canvas background, node body, node border, selected node, and inspector panel have visible contrast.
- [ ] Toolbars wrap, collapse, or scroll intentionally instead of hiding button labels.
- [ ] No visible text overlaps adjacent controls in the main session workspace.
- [ ] Previously visible content or controls do not unexpectedly vanish and reappear in another area during normal loading, refresh, polling, or background state updates.
- [ ] Production and local UI use the same committed styles, with no server-only manual patch.

## Verification

- [ ] `npm run verify:offline`
- [ ] Open `http://localhost:5173/#/s/ses_demo_agent_plan` or the current demo session.
- [ ] Check desktop, narrow desktop, and mobile widths.
- [ ] For release changes, verify `https://seereel.studio` after deployment.

## Change Policy

Update this spec before broad UI redesigns and with any fix that changes responsive behavior, canvas layering, or core visual hierarchy.
