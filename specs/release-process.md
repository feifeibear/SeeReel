# Release Process

Status: active
Owner: SeeReel
Last Reviewed: 2026-06-05

## Purpose

Define the release path that keeps local, GitHub, Docker, ECS, and production behavior aligned.

## Scope

- Local verification, GitHub Actions, Docker builds, production deployment, npm package publishing, and post-release checks.
- Registry and network assumptions needed by public CI.
- The public site `https://seereel.studio` and the production ECS app directory. The current ECS directory may still be the legacy path `/opt/reelyai-agent/app`; pass it explicitly through `SEEREEL_ECS_DIR` until the host is migrated.

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
- ECS rsync deploys must exclude local generated or private workspace directories such as `outputs/`, `assets/generated/`, `assets/references/`, `.vscode/`, `data/`, `.env*`, and runtime skill mirrors. Deployment should ship committed source and build/runtime config, not local creative media.
- Release artifacts, Docker images, logs, and deployment commands must not expose AK/SK, tokens, passwords, API keys, or private keys.
- Release verification must include local checks, GitHub Actions, deployment to the online site, and online smoke verification when the user asks to publish.
- The public `seereel.studio` UI is served by a Vercel static frontend. A production release is incomplete if only ECS/API is updated; after any frontend-visible change, deploy `dist/client` with `deploy/vercel-static-frontend.json` and re-alias `seereel.studio` to the new Vercel deployment.
- If `packages/seereel-cli/`, the CLI bin, CLI docs, or public CLI behavior changes, publish `seereelcli` to npm and verify the published package instead of relying only on the local workspace.
- The ECS deploy script must accept both current `SEEREEL_*` and legacy `REELYAI_*` environment names for deployment secrets while writing canonical `SEEREEL_*` runtime keys.
- ECS SSH/rsync operations must be non-interactive and bounded by connection timeout / keepalive settings so a blocked runner or fallback host cannot hang the release indefinitely.
- ECS deploys must inject the current Git SHA into `SEEREEL_COMMIT_SHA` so `/api/healthz` and `/api/diagnostics` can identify the running commit.
- A release is not complete until `origin/main`, the local `HEAD`, and production `/api/healthz.commit` all identify the same commit.
- For UI-affecting releases, `https://seereel.studio/` must also serve the matching Vercel static deployment; verify frontend freshness with the Vercel alias/deployment result plus changed UI markers, not only `/api/healthz.commit`.
- GitHub Deploy workflow SSH timeouts are an infrastructure reachability failure, not a code failure. If the latest GitHub CI is green, use the direct ECS fallback instead of reworking unrelated code.

## Acceptance Criteria

- [ ] `npm ci` succeeds in GitHub Actions without ByteDance VPN or internal DNS.
- [ ] GitHub Actions runs `npm run verify:offline` successfully.
- [ ] Docker image build succeeds in GitHub Actions.
- [ ] ECS deploy rsync excludes local generated media and editor/runtime state.
- [ ] Code is cleaned up, committed, and pushed to GitHub before production release.
- [ ] Production deployment can identify the Git commit it is serving, and that commit exists on GitHub.
- [ ] Agent skills are installed/refreshed and visible to target runtimes when skill files or skill installation logic changed.
- [ ] `seereelcli` is published to npm and registry-verified when CLI package files or CLI behavior changed.
- [ ] Release checks include secret scanning and no credential values appear in CI logs.
- [ ] Online behavior is spot-checked after deploy for the changed feature.
- [ ] UI-affecting releases deploy the Vercel static frontend and alias `seereel.studio` to that deployment.
- [ ] Online verification proves both API commit freshness and Vercel-served UI freshness.
- [ ] GitHub deploy workflow inputs and secrets can drive `deploy/deploy-to-ecs.sh` without renaming legacy `REELYAI_*` secrets.
- [ ] ECS deploy SSH calls fail fast on unreachable hosts and do not wait for interactive prompts.
- [ ] `/api/healthz` includes the Git commit served by production after deploy.
- [ ] The final deployed commit matches `git rev-parse HEAD` and `git ls-remote origin refs/heads/main`.

## Successful Release Runbook

Use this order when the user says to publish current changes. Do not skip to deploy while the worktree, pushed commit, CI result, and production commit disagree.

### 1. Confirm Scope

```bash
git status --short --branch
git log -5 --oneline --decorate
```

- If the worktree is dirty, decide whether every dirty file is part of "current changes". Do not deploy behind uncommitted changes.
- If another agent or the user pushes during the release, fetch/status again and deploy the newest intended `origin/main`, not the older commit already in your head.
- For README/demo media, verify links before publishing. Do not commit cloud session download links unless the session is still publicly reachable.

### 2. Local Release Gate

Run the full gate before pushing release commits:

```bash
npm run install:skill -- --agent all
npm run verify:release
git diff --check
```

When CLI/session/handoff/director behavior changed, also run:

```bash
npm run smoke:seereel-cli-status
npm run smoke:seereel-handoff
npm run smoke:seereel-cli-cloud-only
npm run smoke:seereel-director-skill
npm publish ./packages/seereel-cli --access public --dry-run
```

### 3. Push And Watch GitHub CI

```bash
git push origin main
gh run list --repo feifeibear/SeeReel --branch main --limit 5
gh run watch <ci-run-id> --repo feifeibear/SeeReel --exit-status
```

If HTTPS push fails with `RPC failed`, `HTTP 400`, or `unexpected disconnect while reading sideband packet`, retry once with bounded HTTP settings:

```bash
git -c http.postBuffer=157286400 -c http.version=HTTP/1.1 push origin main
```

Do not continue to production until the CI run for the commit you intend to deploy is successful.

### 4. Deploy Production

Prefer the GitHub Deploy workflow first:

```bash
gh workflow run Deploy \
  --repo feifeibear/SeeReel \
  --ref main \
  -f environment=production \
  -f public_url=https://seereel.studio
gh run watch <deploy-run-id> --repo feifeibear/SeeReel --exit-status
```

If that workflow fails in `Deploy to ECS` with `ssh: connect to host ... Connection timed out`, switch to the direct ECS fallback from the operator machine after confirming the latest CI is green:

```bash
SEEREEL_ECS_HOST="<production-host>" \
SEEREEL_ECS_USER=root \
SEEREEL_ECS_PORT=2222 \
SEEREEL_ECS_KEY="<local-deploy-key>" \
SEEREEL_ECS_DIR=/opt/reelyai-agent/app \
APP_PUBLIC_URL=https://seereel.studio \
bash deploy/deploy-to-ecs.sh
```

Keep host names, keys, tokens, and AK/SK values outside git. The fallback command must print the intended public URL and commit before remote build starts.

### 5. Deploy Vercel Static UI

For any frontend-visible change, update the Vercel static layer after the ECS/API deploy. Build from the same committed workspace, package only the static client, and point `seereel.studio` at the fresh Vercel deployment:

```bash
npm run build
tmp=/tmp/seereel-vercel-static
rm -rf "$tmp"
mkdir -p "$tmp/.vercel"
cp -R dist/client/. "$tmp/"
cp deploy/vercel-static-frontend.json "$tmp/vercel.json"
cp .vercel/project.json "$tmp/.vercel/project.json"
(cd "$tmp" && npx vercel deploy --prod --yes)
npx vercel alias set <deployment-host>.vercel.app seereel.studio
```

Do not call a UI-affecting release done while `https://seereel.studio/` still serves an older Vercel deployment, even when `/api/healthz` already reports the new ECS commit.

### 6. Verify Online

```bash
curl -fsS https://seereel.studio/api/healthz
curl -fsS https://seereel.studio/api/readyz
SEEREEL_BASE_URL=https://seereel.studio REELYAI_BASE_URL=https://seereel.studio npm run smoke:production
```

Check changed routes explicitly; at minimum:

```bash
for route in / /gallery /canvas/ses /ai-use-me.html; do
  curl --max-time 25 -L -s -o /tmp/seereel-route-check.html -w "$route %{http_code}\n" "https://seereel.studio$route"
done
```

For UI-affecting releases, also verify the Vercel-served static page is fresh:

```bash
curl -fsSI https://seereel.studio/
curl -fsS https://seereel.studio/ | rg "<changed-ui-marker>"
```

For ECS fallback deploys, also verify the remote containers are healthy with `docker compose -f deploy/docker-compose.volcengine.yml --env-file deploy/.env.production ps`.

### 7. Publish `seereelcli` When Changed

If `packages/seereel-cli/`, CLI docs, CLI skill behavior, or the CLI bin changed:

```bash
npm whoami
npm publish ./packages/seereel-cli --access public
npm view seereelcli version dist-tags --json
```

If npm auth is unavailable (`E401`) or the registry rejects publish, do not call this item done. Record npm publish as blocked and include the registry's current `latest` version.

### 8. Close The Release

- Stop any local dev/prod server started only for smoke testing.
- Confirm `git status --short --branch` is clean and aligned with `origin/main`.
- Final release notes must include the deployed commit, CI run, deploy path used, Vercel UI deployment/alias result when applicable, online verification result, and npm publish status.

## Verification

- [ ] `npm run verify:offline`
- [ ] `npm run verify:release`
- [ ] `npm run smoke:deploy-excludes`
- [ ] `gh run list --repo feifeibear/SeeReel --branch main --limit 5`
- [ ] `gh run view <run-id> --json status,conclusion,url,jobs`
- [ ] `npm run install:skill -- --agent all` when skills or skill installation changed.
- [ ] `npm run smoke:seereel-cli` and published-package verification when `seereelcli` changed.
- [ ] For deployment work, verify `https://seereel.studio` after the server is updated, including `/api/healthz`, `/api/readyz`, `npm run smoke:production`, and the changed frontend routes.
- [ ] For UI-affecting deployment work, deploy the Vercel static frontend, alias `seereel.studio` to the new deployment, and verify changed UI markers on `https://seereel.studio/`.

## Change Policy

Update this spec before changing CI, dependency registry behavior, Dockerfile copy rules, deployment scripts, or production verification expectations.
