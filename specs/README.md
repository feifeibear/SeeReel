# SeeReel Spec Coding

This directory is the project-native spec coding system for SeeReel. It is intentionally lightweight: Markdown specs are the source of product intent, and existing smoke tests plus GitHub Actions are the execution gate.

## When To Use Specs

Create or update a spec before implementation when a change affects user-visible behavior, generation state, release behavior, observability, data persistence, API contracts, or agent workflows.

Small fixes can skip specs when they do not change product rules. Examples: typo fixes, obvious broken imports, stale copy commands, dependency lockfile cleanup, and narrow visual polish.

## Workflow

1. Pick the nearest long-lived spec, or copy `_template.md` for a new product area.
2. Update `Status`, `Last Reviewed`, scope, product rules, acceptance criteria, and verification steps.
3. Implement the code against the acceptance criteria.
4. Run `npm run smoke:specs` for spec shape and `npm run verify:offline` before release.
5. In the final answer or PR, name the spec that governed the change and list any criteria that could not be verified.

## Status Values

- `draft`: intent is being discussed and is not yet binding.
- `active`: current product rule for new work.
- `implemented`: shipped behavior that should stay true.
- `superseded`: kept for history; a newer spec owns the rule.

## Spec Ownership Rules

- Prefer updating an existing long-lived spec over creating one-off documents.
- Product rules must describe what users can rely on, not implementation details.
- Acceptance criteria must be checkable.
- Verification must include `npm run verify:offline`; add browser, production, or API checks when relevant.
- If code and spec disagree, treat that as a bug in either the implementation or the spec. Resolve the disagreement in the same change.

