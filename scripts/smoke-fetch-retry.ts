import { fetchWithRetry } from "../src/server/fetchWithRetry";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";

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

async function withTemporaryServer<T>(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  fn: (url: string) => Promise<T>
): Promise<T> {
  const server = createServer(handler);
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Temporary smoke server did not bind to a TCP port");
  try {
    return await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
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
  await withTemporaryServer(
    () => {
      // Intentionally keep the socket open so fetchWithRetry hits its own timeout path.
    },
    (url) =>
      timed("GET local hanging server (will timeout)", () =>
        fetchWithRetry(`${url}/probe`, {
          method: "GET",
          retries: 2,
          initialBackoffMs: 200,
          maxBackoffMs: 800,
          timeoutMs: 600,
          tag: "smoke-timeout-get"
        })
      )
  );

  console.log("\n=== smoke 4: timeout on POST — should NOT retry (server may have started processing) ===");
  await withTemporaryServer(
    () => {
      // Intentionally keep the socket open so fetchWithRetry hits its own timeout path.
    },
    (url) =>
      timed("POST local hanging server", () =>
        fetchWithRetry(`${url}/probe`, {
          method: "POST",
          retries: 3,
          initialBackoffMs: 200,
          maxBackoffMs: 800,
          timeoutMs: 600,
          tag: "smoke-timeout-post"
        })
      )
  );

  console.log("\n=== smoke 5: happy path against temporary local server (should return 200, no retries) ===");
  await withTemporaryServer(
    (_, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    },
    (url) =>
      timed(`GET ${url}/api/state`, () =>
        fetchWithRetry(`${url}/api/state`, {
          method: "GET",
          retries: 3,
          initialBackoffMs: 200,
          maxBackoffMs: 1000,
          timeoutMs: 5000,
          tag: "smoke-happy"
        }).then((r) => r.text().then(() => r.status))
      )
  );
}

main().catch((err) => {
  console.error("FATAL", err);
  process.exit(1);
});
