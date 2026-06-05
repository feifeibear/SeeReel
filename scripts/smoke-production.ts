const baseUrl = (process.env.SEEREEL_BASE_URL || process.env.REELYAI_BASE_URL || process.env.APP_PUBLIC_URL || "http://127.0.0.1:5173").replace(/\/$/, "");
const accessToken = (process.env.SEEREEL_ACCESS_TOKEN || process.env.REELYAI_ACCESS_TOKEN || "").trim();

function authHeaders(extra?: Record<string, string>) {
  return { accept: "application/json", ...(accessToken ? { "x-seereel-access": accessToken, "x-reelyai-access": accessToken } : {}), ...extra };
}

async function getJson(path: string) {
  const url = `${baseUrl}${path}`;
  const started = Date.now();
  const response = await fetch(url, { headers: authHeaders() });
  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    throw new Error(`${path} did not return JSON: ${text.slice(0, 200)}`);
  }
  if (!response.ok) {
    throw new Error(`${path} returned ${response.status}: ${text.slice(0, 500)}`);
  }
  return { status: response.status, ms: Date.now() - started, body };
}

function assertRecord(value: unknown, path: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} returned a non-object payload`);
}

/** A sensitive path that must NOT be publicly reachable: expect a non-200 (Caddy 404 or app 401). */
async function assertBlocked(path: string) {
  const response = await fetch(`${baseUrl}${path}`, { headers: { accept: "application/json" } });
  if (response.ok) {
    throw new Error(`${path} is publicly reachable (status ${response.status}); it must be blocked at the edge or behind the access token`);
  }
  return response.status;
}

async function main() {
  console.log(`[smoke-production] target=${baseUrl} accessGuard=${accessToken ? "on" : "off"}`);

  const health = await getJson("/api/healthz");
  assertRecord(health.body, "/api/healthz");
  if (health.body.ok !== true) throw new Error("/api/healthz did not report ok=true");
  console.log(`[ok] healthz ${health.ms}ms pid=${health.body.pid ?? "?"}`);

  const ready = await getJson("/api/readyz");
  assertRecord(ready.body, "/api/readyz");
  if (ready.body.ok !== true) throw new Error(`/api/readyz did not report ok=true: ${JSON.stringify(ready.body)}`);
  console.log(`[ok] readyz ${ready.ms}ms`);

  // Security posture: /metrics and /api/diagnostics must never be publicly reachable.
  const metricsStatus = await assertBlocked("/metrics");
  console.log(`[ok] /metrics blocked publicly (status ${metricsStatus})`);
  const diagStatus = await assertBlocked("/api/diagnostics");
  console.log(`[ok] /api/diagnostics blocked publicly (status ${diagStatus})`);

  // When the access gate is enabled, /api/state must reject anonymous reads.
  if (accessToken) {
    const anon = await fetch(`${baseUrl}/api/state`, { headers: { accept: "application/json" } });
    if (anon.ok) throw new Error("/api/state is readable without the access token even though the gate is configured");
    console.log(`[ok] /api/state blocks anonymous reads (status ${anon.status})`);
  }

  const state = await getJson("/api/state");
  assertRecord(state.body, "/api/state");
  if (!Array.isArray(state.body.sessions) || !Array.isArray(state.body.shots) || !Array.isArray(state.body.assets)) {
    throw new Error("/api/state is missing sessions/shots/assets arrays");
  }
  if (!state.body.runtime || typeof state.body.runtime !== "object") {
    throw new Error("/api/state is missing runtime info");
  }
  console.log(`[ok] state ${state.ms}ms sessions=${state.body.sessions.length} shots=${state.body.shots.length} assets=${state.body.assets.length}`);
}

main().catch((error) => {
  console.error(`[fail] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
