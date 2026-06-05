# Observability

Status: active
Owner: SeeReel
Last Reviewed: 2026-06-04

## Purpose

Define what SeeReel must expose so operators can understand traffic, service health, and generation-provider usage.

## Scope

- Health, readiness, HTTP traffic, latency, errors, active sessions, and provider call counters.
- Metrics needed for Grafana and Prometheus dashboards.
- Seedance, Seedream, and Seed text generation usage visibility.

## Non-Goals

- This spec does not require long-term business intelligence storage.
- This spec does not define paid cloud observability products.
- This spec does not expose secrets, access tokens, passwords, AK/SK, API keys, or raw user prompts in metrics labels.

## User Stories

- As an operator, I can see whether the service is up and ready.
- As a product owner, I can see visit volume and generation call counts.
- As an on-call responder, I can detect 5xx errors, high latency, and missing metrics quickly.

## Product Rules

- Metrics endpoints must be accessible only from trusted monitoring paths or protected by deployment controls.
- Grafana panels must query metric names that the running service actually exports.
- Browser-origin restrictions must be intentional and documented so dashboards do not show only `origin not allowed`.
- Provider metrics must distinguish Seedance, Seedream, and Seed text generation without leaking prompt content.
- Dashboard credentials, AK/SK, tokens, passwords, API keys, and secrets must stay out of Git and dashboard JSON.

## Acceptance Criteria

- [ ] The dashboard shows service up/readiness, QPS, 5xx rate, and P95 latency when the service is running.
- [ ] The dashboard shows visit/session volume or a documented approximation.
- [ ] The dashboard shows Seedance, Seedream, and Seed text call counts.
- [ ] Grafana panels do not show `No data` because of mismatched metric names.
- [ ] Grafana dashboards, Prometheus labels, logs, and diagnostics expose no credential values.
- [ ] Local and production dashboards use documented data sources and credentials handling.

## Verification

- [ ] `npm run verify:offline`
- [ ] Query `/api/healthz` locally or in production as appropriate.
- [ ] Query the metrics endpoint from Prometheus and confirm expected series names.
- [ ] Open Grafana and verify panels load real values after traffic is generated.

## Change Policy

Update this spec before changing metrics names, dashboard queries, access controls, Prometheus deployment, or generation usage accounting.
