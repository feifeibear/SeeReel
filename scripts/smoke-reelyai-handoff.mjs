#!/usr/bin/env node

const baseUrl = (process.env.SEEREEL_SMOKE_BASE_URL || process.env.REELYAI_SMOKE_BASE_URL || "http://localhost:5174").replace(/\/+$/, "");

class CookieJar {
  cookies = new Map();

  header() {
    return Array.from(this.cookies.entries())
      .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
      .join("; ");
  }

  remember(headers) {
    const lines =
      typeof headers.getSetCookie === "function"
        ? headers.getSetCookie()
        : splitSetCookie(headers.get("set-cookie") || "");
    for (const line of lines) {
      const [pair] = line.split(";");
      const index = pair.indexOf("=");
      if (index <= 0) continue;
      const key = pair.slice(0, index).trim();
      const value = decodeURIComponent(pair.slice(index + 1).trim());
      if (value) this.cookies.set(key, value);
      else this.cookies.delete(key);
    }
  }
}

function splitSetCookie(value) {
  if (!value) return [];
  return value.split(/,(?=[^;,]+=)/).map((item) => item.trim()).filter(Boolean);
}

async function request(jar, route, init = {}) {
  const headers = {
    Accept: "application/json",
    ...(init.body ? { "Content-Type": "application/json" } : {}),
    ...(jar.header() ? { Cookie: jar.header() } : {}),
    ...(init.headers || {})
  };
  const res = await fetch(`${baseUrl}${route}`, { ...init, headers, redirect: init.redirect || "follow" });
  jar.remember(res.headers);
  const text = await res.text();
  let body = text;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    // Keep plain text body.
  }
  if (!res.ok && init.expectOk !== false) {
    throw new Error(`${route} failed with ${res.status}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
  }
  return { res, body };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const agent = new CookieJar();
const browser = new CookieJar();
let sessionId;

try {
  await request(agent, "/api/healthz");
  await request(browser, "/api/healthz");

  const created = await request(agent, "/api/sessions", {
    method: "POST",
    body: JSON.stringify({
      title: "Smoke handoff session",
      logline: "handoff smoke",
      style: "minimal",
      targetDurationSec: 15,
      shotCount: 1
    })
  });
  sessionId = created.body.id;
  assert(sessionId, "session id missing");

  const before = await request(browser, "/api/state");
  assert(!before.body.sessions.some((session) => session.id === sessionId), "browser should not see CLI-owned session before handoff");

  const handoff = await request(agent, `/api/sessions/${encodeURIComponent(sessionId)}/handoff`, { method: "POST" });
  assert(handoff.body.handoffUrl, "handoffUrl missing");
  assert(handoff.body.webUrlVisibleInBrowser === false, "handoff response should flag raw webUrl as not browser-visible");
  const handoffUrl = new URL(handoff.body.handoffUrl);
  assert(handoffUrl.origin === baseUrl, "handoffUrl should use the configured app origin");
  assert(handoffUrl.pathname.startsWith("/api/handoff/"), "handoffUrl should use the API claim route");
  const token = handoff.body.handoffToken || handoffUrl.pathname.split("/").pop();
  assert(token, "handoff token missing");

  const claim = await request(browser, `/api/handoff/${encodeURIComponent(token)}`, {
    redirect: "manual",
    expectOk: false
  });
  assert(claim.res.status === 302, `expected handoff redirect, got ${claim.res.status}`);
  assert(claim.res.headers.get("location") === `/#/s/${encodeURIComponent(sessionId)}`, "handoff redirect target mismatch");

  const secondClaim = await request(agent, `/api/handoff/${encodeURIComponent(token)}`, {
    redirect: "manual",
    expectOk: false
  });
  assert(secondClaim.res.status === 404, "handoff token should be one-time use");

  const after = await request(browser, "/api/state");
  assert(after.body.sessions.some((session) => session.id === sessionId), "browser should see session after handoff");

  const agentAfter = await request(agent, "/api/state");
  assert(!agentAfter.body.sessions.some((session) => session.id === sessionId), "CLI owner should lose session after browser claims handoff");

  await request(browser, `/api/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
  sessionId = undefined;
  console.log("handoff smoke passed");
} catch (error) {
  if (sessionId) {
    await request(browser, `/api/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE", expectOk: false }).catch(() => undefined);
    await request(agent, `/api/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE", expectOk: false }).catch(() => undefined);
  }
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
