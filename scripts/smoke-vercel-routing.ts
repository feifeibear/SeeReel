import { readFileSync } from "node:fs";

function assertEqual<T>(actual: T, expected: T, label: string) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

const config = JSON.parse(readFileSync(new URL("../deploy/vercel-static-frontend.json", import.meta.url), "utf8")) as {
  rewrites?: Array<{ source?: string; destination?: string }>;
};

const rewrites = config.rewrites || [];
const metrics = rewrites.find((rewrite) => rewrite.source === "/metrics");
const api = rewrites.find((rewrite) => rewrite.source === "/api/:path*");
const media = rewrites.find((rewrite) => rewrite.source === "/media/:path*");

assertEqual(metrics?.destination, "https://complement-arrested-batteries-believed.trycloudflare.com/metrics", "Vercel metrics path is routed to Caddy for blocking");
assertEqual(api?.destination, "https://complement-arrested-batteries-believed.trycloudflare.com/api/:path*", "Vercel API rewrite uses the currently reachable production tunnel");
assertEqual(media?.destination, "https://complement-arrested-batteries-believed.trycloudflare.com/media/:path*", "Vercel media rewrite uses the currently reachable production tunnel");

console.log("vercel routing smoke passed");
