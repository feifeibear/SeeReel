import { readFileSync } from "node:fs";

const blockedHosts = [
  "bnpm.byted.org"
];

const lock = JSON.parse(readFileSync("package-lock.json", "utf8")) as {
  packages?: Record<string, { resolved?: string }>;
};

const blocked = Object.entries(lock.packages || {})
  .flatMap(([name, meta]) => {
    const resolved = meta.resolved || "";
    const host = blockedHosts.find((item) => resolved.includes(item));
    return host ? [{ name, resolved, host }] : [];
  });

if (blocked.length > 0) {
  console.error("package-lock.json contains non-public registry URLs:");
  for (const item of blocked) {
    console.error(`- ${item.name}: ${item.resolved}`);
  }
  process.exit(1);
}

console.log("lock registry smoke passed");
