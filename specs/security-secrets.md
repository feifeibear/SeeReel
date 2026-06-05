# Security And Secrets

Status: active
Owner: SeeReel
Last Reviewed: 2026-06-04

## Purpose

Protect SeeReel credentials, API keys, access tokens, passwords, AK/SK pairs, private keys, and provider secrets from being uploaded to GitHub, exposed through online APIs, leaked into frontend bundles, or published in logs and dashboards.

## Scope

- Git-tracked files, specs, docs, scripts, source code, Docker files, CI config, and frontend assets.
- Runtime environment variables, ECS deployment config, dashboards, metrics, diagnostics, logs, API responses, and browser-visible state.
- Provider credentials for Seedance, Seedream, Seed text generation, VLM review, TOS, ARK, Agent Plan, OpenAI-compatible APIs, Grafana, Prometheus, and admin access.

## Non-Goals

- This spec does not define the exact secret manager product.
- This spec does not require committing local `.env` files.
- This spec does not prevent local development from using private credentials that stay outside Git and public surfaces.

## User Stories

- As an operator, I can configure production credentials without exposing them in GitHub.
- As a developer, I can run local tests without accidentally committing AK/SK, tokens, passwords, or API keys.
- As a user, I can trust that online APIs, diagnostics, metrics, and frontend bundles do not reveal private credentials.

## Product Rules

- AK/SK, tokens, passwords, API keys, private keys, signed cookies, admin credentials, and provider credentials must never be committed to GitHub.
- Secrets must never be returned by public or authenticated online APIs unless the endpoint is explicitly a credential-management endpoint and masks values by default.
- Secrets must never be embedded in frontend code, frontend build output, default demo sessions, docs screenshots, Grafana dashboards, Prometheus labels, metrics, logs, or error messages.
- Production secrets must come from protected runtime configuration such as environment variables, deployment secrets, or a secret manager.
- When showing credential status, display only presence, provider name, last updated metadata, or a short masked suffix when truly needed.
- If a secret is suspected to have been exposed, rotate it before treating the incident as fixed.

## Acceptance Criteria

- [ ] Git-tracked code, docs, specs, scripts, and config contain no real AK/SK, tokens, passwords, API keys, or private keys.
- [ ] Frontend bundle and default demo content contain no real secrets.
- [ ] API responses, diagnostics, metrics, logs, and dashboards mask or omit secrets.
- [ ] Secret-related examples use obvious placeholders such as `<YOUR_API_KEY>` or `redacted`.
- [ ] CI or local verification fails on obvious committed secret patterns.

## Verification

- [ ] `npm run verify:offline`
- [ ] `npm run smoke:secrets`
- [ ] Inspect any changed API response, diagnostics output, dashboard JSON, or frontend-visible state that handles credentials.
- [ ] Before publishing, confirm production secrets are configured outside GitHub source files.

## Change Policy

Update this spec before changing credential storage, diagnostics, metrics, admin settings, deployment config, provider clients, frontend credential displays, or public API responses that touch secret material.

