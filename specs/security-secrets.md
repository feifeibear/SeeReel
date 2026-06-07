# Security And Secrets

Status: active
Owner: SeeReel
Last Reviewed: 2026-06-06

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
- As a creator, I can save either a standard Ark API key or an Agent Plan key in the browser without the key value appearing in app state, logs, or diagnostics.

## Product Rules

- AK/SK, tokens, passwords, API keys, private keys, signed cookies, admin credentials, and provider credentials must never be committed to GitHub.
- Secrets must never be returned by public or authenticated online APIs unless the endpoint is explicitly a credential-management endpoint and masks values by default.
- Secrets must never be embedded in frontend code, frontend build output, default demo sessions, docs screenshots, Grafana dashboards, Prometheus labels, metrics, logs, or error messages.
- Production secrets must come from protected runtime configuration such as environment variables, deployment secrets, or a secret manager.
- When showing credential status, display only presence, provider name, last updated metadata, or a short masked suffix when truly needed.
- Browser and CLI credential-management endpoints may accept standard Ark API keys and Agent Plan keys, but status responses must expose only configured state, credential kind, fingerprint, timestamps, and storage metadata.
- When both a standard Ark API key and an Agent Plan key are configured for the same local/CLI scope, model generation must prefer the standard API key and fall back to Agent Plan only when no standard key is available.
- Admin free-trial Agent Plan quota must apply only to requests that actually need the site/admin Agent Plan fallback. Requests with browser-saved or environment BytePlus/CN standard Ark keys must not consume or be blocked by that Agent Plan free-trial quota.
- If a secret is suspected to have been exposed, rotate it before treating the incident as fixed.

## Credential Environment Variables

Use this catalog as the source of truth for `KEY`, `ID`, `TOKEN`, and `SECRET`-class environment variables. Values marked secret must never be committed, printed, returned by diagnostics, or shown in browser-visible state except as masked/fingerprinted status.

| Area | Canonical env | Accepted aliases | Secret | Notes |
| --- | --- | --- | --- | --- |
| Public API write guard | `SEEREEL_ACCESS_TOKEN` | `REELYAI_ACCESS_TOKEN` | Yes | Shared access token for protected API writes and production smoke tests. |
| Browser standard Ark key storage | `SEEREEL_API_KEY_ENCRYPTION_SECRET` | `SEEREEL_CREDENTIAL_ENCRYPTION_SECRET`, `SEEREEL_AGENT_PLAN_KEY_ENCRYPTION_SECRET`, `REELYAI_API_KEY_ENCRYPTION_SECRET`, `REELYAI_CREDENTIAL_ENCRYPTION_SECRET`, `REELYAI_AGENT_PLAN_KEY_ENCRYPTION_SECRET` | Yes | Encrypts browser-saved standard Ark API keys and their non-secret route metadata when database storage is enabled. |
| Browser Agent Plan key storage | `SEEREEL_AGENT_PLAN_KEY_ENCRYPTION_SECRET` | `SEEREEL_CREDENTIAL_ENCRYPTION_SECRET`, `REELYAI_AGENT_PLAN_KEY_ENCRYPTION_SECRET`, `REELYAI_CREDENTIAL_ENCRYPTION_SECRET` | Yes | Encrypts browser-saved Agent Plan keys when database storage is enabled. |
| Agent Plan model calls | `ARK_AGENT_PLAN_KEY` | `AGENT_PLAN_API_KEY`, `VOLCENGINE_AGENT_PLAN_KEY` | Yes | Environment Agent Plan key. Public deployments should normally leave this empty and prefer browser-entered user keys or an explicit admin free-trial key. |
| Admin free-trial Agent Plan | `SEEREEL_ADMIN_AGENT_PLAN_KEY` | `REELYAI_ADMIN_AGENT_PLAN_KEY` | Yes | Backend-only free-trial fallback; must stay server-side and behind rate limits. |
| BytePlus standard Seedream calls | `BP_ARK_API_KEY` | `BP_SEEDREAM_API_KEY` | Yes | Highest-priority Seedream standard route; endpoint defaults to `https://ark.ap-southeast.bytepluses.com/api/v3`. Use `BP_SEEDREAM_API_KEY` only when Seedream needs a different BP key from shared Ark calls. |
| Volcengine CN standard Seedream calls | `CN_ARK_API_KEY` | `CN_SEEDREAM_API_KEY` | Yes | Second-priority Seedream standard route; endpoint defaults to `https://ark.cn-beijing.volces.com/api/v3`. Use `CN_SEEDREAM_API_KEY` only when Seedream needs a different CN key from shared Ark calls. |
| BytePlus standard Seedance calls | `BP_ARK_API_KEY` | `BP_SEEDANCE_API_KEY` | Yes | Highest-priority Seedance standard route; endpoint defaults to `https://ark.ap-southeast.bytepluses.com/api/v3`. Use `BP_SEEDANCE_API_KEY` only when Seedance needs a different BP key from shared Ark calls. |
| Volcengine CN standard Seedance calls | `CN_ARK_API_KEY` | `CN_SEEDANCE_API_KEY` | Yes | Second-priority Seedance standard route; endpoint defaults to `https://ark.cn-beijing.volces.com/api/v3`. Use `CN_SEEDANCE_API_KEY` only when Seedance needs a different CN key from shared Ark calls. |
| Seedream image generation | `BP_ARK_API_KEY` | `BP_SEEDREAM_API_KEY`, `CN_ARK_API_KEY`, `CN_SEEDREAM_API_KEY`, `ARK_AGENT_PLAN_KEY` | Yes | Standard Seedream priority is BP > CN > Agent Plan. |
| Seedance video generation | `BP_ARK_API_KEY` | `BP_SEEDANCE_API_KEY`, `CN_ARK_API_KEY`, `CN_SEEDANCE_API_KEY`, `ARK_AGENT_PLAN_KEY` | Yes | Standard Seedance priority is BP > CN > Agent Plan. `SEEDANCE_API_KEY` is reserved for the custom direct `SEEDANCE_API_URL` endpoint and is not part of the standard Seedance route priority. |
| Seed prompt expansion | `SEED_PROMPT_API_KEY` | `BP_ARK_API_KEY`, `ARK_API_KEY` | Yes | Optional standard key for prompt expansion or prompt rewrite paths. |
| VLM review and video analysis | `VISION_REVIEW_API_KEY` | `SEED_PROMPT_API_KEY`, `BP_ARK_API_KEY`, `ARK_API_KEY` | Yes | Optional standard VLM key. Agent Plan VLM uses Agent Plan keys and Plan-compatible model names. |
| OpenAI-compatible text/image helpers | `OPENAI_API_KEY` | `OAI_KEY` | Yes | Optional helper credential for local script/story/image paths that call OpenAI-compatible APIs. |
| TOS access key ID | `TOS_ACCESS_KEY_ID` | `TOS_ACCESS_KEY`, `VOLCENGINE_ACCESS_KEY_ID`, `VOLC_ACCESS_KEY_ID` | Yes | TOS AK used to publish local references to signed/public `http(s)` URLs for remote workers. |
| TOS secret key | `TOS_SECRET_ACCESS_KEY` | `TOS_ACCESS_KEY_SECRET`, `TOS_SECRET_KEY`, `VOLCENGINE_SECRET_ACCESS_KEY`, `VOLCENGINE_ACCESS_KEY_SECRET`, `VOLC_SECRET_ACCESS_KEY` | Yes | TOS SK paired with the access key ID. |
| TOS session token | `TOS_STS_TOKEN` | `VOLCENGINE_SESSION_TOKEN` | Yes | Optional temporary credential token for TOS uploads/signing. |
| Admin login | `SEEREEL_ADMIN_PASSWORD` | `REELYAI_ADMIN_PASSWORD`, `ADMIN_PASSWORD` | Yes | Admin password must be stored as protected runtime config or hashed UI storage, never in Git. |
| Admin username | `SEEREEL_ADMIN_USER` | `REELYAI_ADMIN_USER`, `ADMIN_USER` | No | Identifier, not a secret by itself, but should not be exposed unnecessarily. |
| Feishu alert relay | `FEISHU_WEBHOOK_SECRET` | None | Yes | Optional signing secret for alert webhook delivery. |
| Feishu alert webhook URL | `FEISHU_WEBHOOK_URL` | None | Yes | Treat as secret because webhook URLs can authorize sends. |
| Volcengine TTS app ID | `VOLC_TTS_APPID` | None | Sensitive ID | Required for narration; not a password alone, but do not publish real production values. |
| Volcengine TTS token | `VOLC_TTS_TOKEN` | None | Yes | Required for narration and not replaceable by `ARK_AGENT_PLAN_KEY`. |
| Volcengine TTS resource ID | `VOLC_TTS_RESOURCE_ID` | None | No | Non-secret resource/model-family identifier such as `seed-tts-1.0`; still keep production configs out of screenshots when possible. |
| Rate-limit salt | `SEEREEL_RATE_LIMIT_SALT` | None | Yes | Salt for anonymous IP hashing; rotating changes rate-limit identity fingerprints. |

Model ID variables such as `SEEDREAM_AGENT_PLAN_MODEL`, `SEEDANCE_AGENT_PLAN_MODEL`, `SEEDANCE_AGENT_PLAN_FAST_MODEL`, `VISION_REVIEW_AGENT_PLAN_MODEL`, `VIDEO_ANALYZE_AGENT_PLAN_MODEL`, `SEEDREAM_MODEL`, `SEEDREAM_45_MODEL`, `SEEDANCE_MODEL`, `SEEDANCE_FAST_MODEL`, and `VISION_REVIEW_MODEL` are not secrets. They may appear in specs, docs, diagnostics, and usage metrics, but must not be confused with API keys or tokens.

## Acceptance Criteria

- [ ] Git-tracked code, docs, specs, scripts, and config contain no real AK/SK, tokens, passwords, API keys, or private keys.
- [ ] Frontend bundle and default demo content contain no real secrets.
- [ ] API responses, diagnostics, metrics, logs, and dashboards mask or omit secrets.
- [ ] The top-bar API Keys panel can save either a standard Ark API key or an Agent Plan key and shows only masked status/fingerprint afterward.
- [ ] Standard Ark API key requests bypass site/admin Agent Plan free-trial quota while still keeping keys server-side and masked in status surfaces.
- [ ] The CLI can configure a standard Ark API key without printing it, and local config status reports only whether it is configured.
- [ ] `KEY`, `ID`, `TOKEN`, and `SECRET` environment variables are documented in this spec before new credential surfaces are added to `.env.example`, deploy scripts, docs, or runtime code.
- [ ] Secret-related examples use obvious placeholders such as `<YOUR_API_KEY>` or `redacted`.
- [ ] CI or local verification fails on obvious committed secret patterns.

## Verification

- [ ] `npm run verify:offline`
- [ ] `npm run smoke:secrets`
- [ ] Inspect any changed API response, diagnostics output, dashboard JSON, or frontend-visible state that handles credentials.
- [ ] Before publishing, confirm production secrets are configured outside GitHub source files.

## Change Policy

Update this spec before changing credential storage, diagnostics, metrics, admin settings, deployment config, provider clients, frontend credential displays, or public API responses that touch secret material.
