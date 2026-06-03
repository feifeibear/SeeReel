import { fetchWithRetry } from "../src/server/fetchWithRetry";
import { createServer } from "node:http";

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

  console.log("\n=== smoke 5: happy path against temporary local server (should return 200, no retries) ===");
  const server = createServer((_, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Temporary smoke server did not bind to a TCP port");
  try {
    await timed(`GET 127.0.0.1:${address.port}/api/state`, () =>
      fetchWithRetry(`http://127.0.0.1:${address.port}/api/state`, {
        method: "GET",
        retries: 3,
        initialBackoffMs: 200,
        maxBackoffMs: 1000,
        timeoutMs: 5000,
        tag: "smoke-happy"
      }).then((r) => r.text().then(() => r.status))
    );
  } finally {
    server.close();
  }
}

main().catch((err) => {
  console.error("FATAL", err);
  process.exit(1);
});
