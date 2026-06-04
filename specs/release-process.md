# Release Process

Status: active
Owner: SeeReel
Last Reviewed: 2026-06-04

## Purpose

Define the release path that keeps local, GitHub, Docker, ECS, and production behavior aligned.

## Scope

- Local verification, GitHub Actions, Docker builds, production deployment, and post-release checks.
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
- Docker builds must only copy files that exist in the committed repository or are produced by the build.
- Release artifacts, Docker images, logs, and deployment commands must not expose AK/SK, tokens, passwords, API keys, or private keys.
- Release verification must include local checks, GitHub Actions, deployment, and online smoke verification when the user asks to publish.

## Acceptance Criteria

- [ ] `npm ci` succeeds in GitHub Actions without ByteDance VPN or internal DNS.
- [ ] GitHub Actions runs `npm run verify:offline` successfully.
- [ ] Docker image build succeeds in GitHub Actions.
- [ ] Production deployment can identify the Git commit it is serving.
- [ ] Release checks include secret scanning and no credential values appear in CI logs.
- [ ] Online behavior is spot-checked after deploy for the changed feature.

## Verification

- [ ] `npm run verify:offline`
- [ ] `gh run list --repo feifeibear/seereel-agent --limit 5`
- [ ] `gh run view <run-id> --json status,conclusion,url,jobs`
- [ ] For deployment work, verify `https://seereel.studio` after the server is updated.

## Change Policy

Update this spec before changing CI, dependency registry behavior, Dockerfile copy rules, deployment scripts, or production verification expectations.
