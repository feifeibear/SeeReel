# Release Process

Status: active
Owner: SeeReel
Last Reviewed: 2026-06-05

## Purpose

Define the release path that keeps local, GitHub, Docker, ECS, and production behavior aligned.

## Scope

- Local verification, GitHub Actions, Docker builds, production deployment, npm package publishing, and post-release checks.
- Registry and network assumptions needed by public CI.
- The public site `https://seereel.studio` and production app directory `/opt/seereel-agent/app`.

## Non-Goals

- This spec does not define cloud account billing.
- This spec does not document every ECS operation.
- This spec does not replace emergency rollback procedures.

## User Stories

- As an operator, I can trust that code passing CI will not require a private ByteDance network to install dependencies.
- As a user, I see the same behavior locally and online after deployment.
- As a developer, I can trace which commit is running in production.

## Product Rules

- GitHub Actions must not depend on internal-only registry URLs.
- Private registry hostnames must not be committed to specs or release docs; registry denylist checks may receive blocked hosts from CI/runtime environment.
- Lockfiles must use public or otherwise CI-reachable dependency URLs.
- Production must run committed code from GitHub, not untracked server edits.
- Before publishing, code changes must be organized, committed, and pushed to GitHub; production deploys must identify the exact Git commit they serve.
- Agent skills must be effective after release. If `.agents/skills/` or install behavior changes, refresh/install skills and verify the agent-visible skill surface before calling the release done.
- Docker builds must only copy files that exist in the committed repository or are produced by the build.
- Release artifacts, Docker images, logs, and deployment commands must not expose AK/SK, tokens, passwords, API keys, or private keys.
- Release verification must include local checks, GitHub Actions, deployment to the online site, and online smoke verification when the user asks to publish.
- If `packages/seereel-cli/`, the CLI bin, CLI docs, or public CLI behavior changes, publish `seereelcli` to npm and verify the published package instead of relying only on the local workspace.
- The ECS deploy script must accept both current `SEEREEL_*` and legacy `REELYAI_*` environment names for deployment secrets while writing canonical `SEEREEL_*` runtime keys.

## Acceptance Criteria

- [ ] `npm ci` succeeds in GitHub Actions without ByteDance VPN or internal DNS.
- [ ] GitHub Actions runs `npm run verify:offline` successfully.
- [ ] Docker image build succeeds in GitHub Actions.
- [ ] Code is cleaned up, committed, and pushed to GitHub before production release.
- [ ] Production deployment can identify the Git commit it is serving, and that commit exists on GitHub.
- [ ] Agent skills are installed/refreshed and visible to target runtimes when skill files or skill installation logic changed.
- [ ] `seereelcli` is published to npm and registry-verified when CLI package files or CLI behavior changed.
- [ ] Release checks include secret scanning and no credential values appear in CI logs.
- [ ] Online behavior is spot-checked after deploy for the changed feature.
- [ ] GitHub deploy workflow inputs and secrets can drive `deploy/deploy-to-ecs.sh` without renaming legacy `REELYAI_*` secrets.

## Verification

- [ ] `npm run verify:offline`
- [ ] `gh run list --repo feifeibear/seereel-agent --limit 5`
- [ ] `gh run view <run-id> --json status,conclusion,url,jobs`
- [ ] `npm run install:skill -- --agent all` when skills or skill installation changed.
- [ ] `npm run smoke:seereel-cli` and published-package verification when `seereelcli` changed.
- [ ] For deployment work, verify `https://seereel.studio` after the server is updated.

## Change Policy

Update this spec before changing CI, dependency registry behavior, Dockerfile copy rules, deployment scripts, or production verification expectations.
