import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/server/index.ts", import.meta.url), "utf8");

const bulkRoute = 'app.post("/api/sessions/bulk-delete"';
const firstDynamicSessionRoute = 'app.post("/api/sessions/:sessionId';
const apiClientRoute = '"/api/sessions/bulk-delete"';

const bulkIndex = source.indexOf(bulkRoute);
const dynamicIndex = source.indexOf(firstDynamicSessionRoute);

if (bulkIndex < 0) throw new Error("bulk delete route is missing");
if (dynamicIndex < 0) throw new Error("dynamic session route marker is missing");
if (bulkIndex > dynamicIndex) {
  throw new Error("bulk delete route must be registered before dynamic /api/sessions/:sessionId routes");
}

const apiClient = readFileSync(new URL("../src/client/api.ts", import.meta.url), "utf8");
if (!apiClient.includes(apiClientRoute)) throw new Error("client bulk delete API path is missing");

console.log("session bulk delete route smoke passed");
