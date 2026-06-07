import { strict as assert } from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";

/**
 * Pre-release guardrail smoke. Boots a throwaway production server with the access-token gate on, a
 * tiny generation cap, and ALL paid model keys forced empty, then asserts the money/compliance
 * guardrails actually hold:
 *
 *  1. Access token gate: probes open, sensitive reads/writes require the token.
 *  2. No silent fake success: in production a generation route with no key returns an error
 *     (not a placeholder image URL).
 *  3. Per-session daily cap: paid submissions are blocked with 429 once the cap is exceeded.
 *
 * Forcing the key envs to empty strings is also a safety guarantee: dotenv never overrides an
 * already-set var, so this smoke can never spend real money even if .env has live keys.
 */

const PORT = process.env.SEEREEL_GUARDRAILS_PORT || process.env.REELYAI_GUARDRAILS_PORT || "5199";
const baseUrl = `http://127.0.0.1:${PORT}`;
const TOKEN = "guardrail-smoke-token";
const CAP = 2;
let cookieHeader = "";

const EMPTY_KEY_ENVS = [
  "ARK_API_KEY",
  "BP_ARK_API_KEY",
  "BP_SEEDREAM_API_KEY",
  "CN_ARK_API_KEY",
  "CN_SEEDREAM_API_KEY",
  "BP_SEEDANCE_API_KEY",
  "CN_SEEDANCE_API_KEY",
  "SEEDANCE_API_KEY",
  "SEEDANCE_API_URL",
  "SEED_PROMPT_API_KEY",
  "ARK_AGENT_PLAN_KEY",
  "AGENT_PLAN_API_KEY",
  "VOLCENGINE_AGENT_PLAN_KEY",
  "OPENAI_API_KEY",
  "VISION_REVIEW_API_KEY"
];

type Raw = { status: number; body: any };

function rememberCookies(headers: Headers) {
  const raw = headers.get("set-cookie");
  if (!raw) return;
  cookieHeader = raw
    .split(/,(?=[^;,]+=)/)
    .map((item) => item.split(";")[0].trim())
    .filter(Boolean)
    .join("; ");
}

async function call(path: string, init?: RequestInit & { token?: boolean }): Promise<Raw> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    ...(init?.headers as Record<string, string>)
  };
  if (init?.token) headers["x-seereel-access"] = TOKEN;
  const res = await fetch(`${baseUrl}${path}`, { ...init, headers });
  rememberCookies(res.headers);
  const text = await res.text();
  let body: any;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

async function isUp() {
  try {
    const res = await fetch(`${baseUrl}/api/healthz`);
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForServer(timeoutMs = 40_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isUp()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Guardrail server did not become ready at ${baseUrl}`);
}

async function main() {
  let sessionId = "";
  // 1) Access gate ------------------------------------------------------------
  try {
    const health = await call("/api/healthz");
    assert.equal(health.status, 200, "healthz must be open without a token");

    const stateNoToken = await call("/api/state");
    assert.equal(stateNoToken.status, 401, "/api/state must require a token");
    assert.equal(stateNoToken.body?.code, "access_token_required", "401 should carry access_token_required code");

    const diagNoToken = await call("/api/diagnostics");
    assert.equal(diagNoToken.status, 401, "/api/diagnostics must require a token");

    const sessionNoToken = await call("/api/sessions", { method: "POST", body: JSON.stringify({ title: "x" }) });
    assert.equal(sessionNoToken.status, 401, "POST /api/sessions must require a token");

    const stateWithToken = await call("/api/state", { token: true });
    assert.equal(stateWithToken.status, 200, "/api/state must succeed with a valid token");
    console.log("[ok] access token gate");

    // Create the fixtures we need (with token).
    const session = await call("/api/sessions", {
      method: "POST",
      token: true,
      body: JSON.stringify({ title: "Guardrail Smoke", logline: "guardrail", style: "test", targetDurationSec: 10, shotCount: 0 })
    });
    assert.equal(session.status, 200, "session create should succeed with token");
    sessionId = session.body.id as string;

    const asset = await call("/api/assets", {
      method: "POST",
      token: true,
      body: JSON.stringify({ name: "Guardrail Asset", type: "character", description: "guardrail", prompt: "a hero", ownerSessionId: sessionId, tags: ["smoke"] })
    });
    assert.equal(asset.status, 200, "asset create should succeed with token");
    const assetId = asset.body.id as string;

    // 2) No silent fake success + 3) cap, exercised on the same paid route -------
    // CAP=2: first two generate attempts consume a slot and must ERROR (no key in production),
    // the third must be blocked by the cap with 429.
    const gen1 = await call(`/api/assets/${assetId}/generate`, { method: "POST", token: true, body: JSON.stringify({}) });
    assert.ok(gen1.status >= 400, `generate #1 should error without a key, got ${gen1.status}`);
    assert.equal(gen1.status === 429, false, "generate #1 should not be the cap (cap not reached yet)");
    assert.equal(/placehold\.co|placeholder/i.test(JSON.stringify(gen1.body)), false, "generate must not return a placeholder success in production");

    const gen2 = await call(`/api/assets/${assetId}/generate`, { method: "POST", token: true, body: JSON.stringify({}) });
    assert.ok(gen2.status >= 400 && gen2.status !== 429, `generate #2 should error (not cap), got ${gen2.status}`);
    console.log("[ok] no silent fake success in production");

    const gen3 = await call(`/api/assets/${assetId}/generate`, { method: "POST", token: true, body: JSON.stringify({}) });
    assert.equal(gen3.status, 429, `generate #3 should hit the daily cap (429), got ${gen3.status}`);
    assert.equal(gen3.body?.code, "generation_cap_exceeded", "cap response should carry generation_cap_exceeded code");
    console.log(`[ok] per-session daily generation cap (cap=${CAP})`);

    console.log("guardrail smoke passed");
  } finally {
    if (sessionId) {
      await call(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE", token: true }).catch(() => undefined);
    }
  }
}

async function run() {
  if (await isUp()) {
    throw new Error(`Port ${PORT} already in use; stop the server there so the guardrail smoke can boot a controlled instance.`);
  }
  const emptyKeys = Object.fromEntries(EMPTY_KEY_ENVS.map((name) => [name, ""]));
  const child: ChildProcess = spawn("tsx", ["src/server/index.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...emptyKeys,
      NODE_ENV: "production",
      PORT,
      SEEREEL_COOKIE_SECURE: "0",
      SEEREEL_ACCESS_TOKEN: TOKEN,
      SEEREEL_DISABLE_ADMIN_AGENT_PLAN: "1",
      SEEREEL_SESSION_GENERATION_DAILY_CAP: String(CAP),
      SEEREEL_SKIP_SKILL_INSTALL: "1"
    },
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout?.on("data", (chunk) => process.stdout.write(`[server] ${chunk}`));
  child.stderr?.on("data", (chunk) => process.stderr.write(`[server] ${chunk}`));

  try {
    await waitForServer();
    await main();
  } finally {
    terminateServer(child);
  }
}

function terminateServer(child: ChildProcess) {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") {
      child.kill("SIGTERM");
    } else {
      process.kill(-child.pid, "SIGTERM");
    }
  } catch {
    child.kill("SIGTERM");
  }
}

run().catch((err) => {
  console.error(`[fail] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
