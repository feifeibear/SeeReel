import { fetchWithRetry } from "../src/server/fetchWithRetry";

async function timed<T>(label: string, fn: () => Promise<T>) {
  const t0 = Date.now();
  try {
    const result = await fn();
    console.log(`[ok ${Date.now() - t0}ms] ${label}`);
    return { ok: true as const, result };
  } catch (err) {
    console.log(`[fail ${Date.now() - t0}ms] ${label}: ${err instanceof Error ? err.message : err}`);
    return { ok: false as const, err };
  }
}

async function main() {
  console.log("=== smoke 1: ECONNREFUSED on GET (idempotent) — should retry 3× then fail ===");
  await timed("GET localhost:1 (refused)", () =>
    fetchWithRetry("http://localhost:1/probe", {
      method: "GET",
      retries: 3,
      initialBackoffMs: 200,
      maxBackoffMs: 1500,
      timeoutMs: 1000,
      tag: "smoke-refused-get"
    })
  );

  console.log("\n=== smoke 2: ECONNREFUSED on POST (non-idempotent) — should still retry on network errors ===");
  await timed("POST localhost:1 (refused)", () =>
    fetchWithRetry("http://localhost:1/probe", {
      method: "POST",
      retries: 3,
      initialBackoffMs: 200,
      maxBackoffMs: 1500,
      timeoutMs: 1000,
      tag: "smoke-refused-post"
    })
  );

  console.log("\n=== smoke 3: timeout on GET — should retry on our-side timeout because GET is idempotent ===");
  await timed("GET 10.255.255.1 (blackhole, will timeout)", () =>
    fetchWithRetry("http://10.255.255.1:81/probe", {
      method: "GET",
      retries: 2,
      initialBackoffMs: 200,
      maxBackoffMs: 800,
      timeoutMs: 600,
      tag: "smoke-timeout-get"
    })
  );

  console.log("\n=== smoke 4: timeout on POST — should NOT retry (server may have started processing) ===");
  await timed("POST 10.255.255.1 (blackhole)", () =>
    fetchWithRetry("http://10.255.255.1:81/probe", {
      method: "POST",
      retries: 3,
      initialBackoffMs: 200,
      maxBackoffMs: 800,
      timeoutMs: 600,
      tag: "smoke-timeout-post"
    })
  );

  console.log("\n=== smoke 5: happy path against local server (should return 200, no retries) ===");
  await timed("GET localhost:5174/api/state", () =>
    fetchWithRetry("http://localhost:5174/api/state", {
      method: "GET",
      retries: 3,
      initialBackoffMs: 200,
      maxBackoffMs: 1000,
      timeoutMs: 5000,
      tag: "smoke-happy"
    }).then((r) => r.text().then(() => r.status))
  );
}

main().catch((err) => {
  console.error("FATAL", err);
  process.exit(1);
});
