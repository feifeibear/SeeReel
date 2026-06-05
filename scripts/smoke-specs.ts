import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = process.cwd();
const specsDir = join(repoRoot, "specs");
const allowedStatuses = new Set(["draft", "active", "implemented", "superseded"]);
const requiredHeadings = [
  "## Purpose",
  "## Scope",
  "## Non-Goals",
  "## Product Rules",
  "## Acceptance Criteria",
  "## Verification",
  "## Change Policy",
];

let failures = 0;

function fail(file: string, message: string) {
  failures += 1;
  console.error(`${file}: ${message}`);
}

const files = readdirSync(specsDir)
  .filter((file) => file.endsWith(".md"))
  .filter((file) => file !== "README.md" && !file.startsWith("_"))
  .sort();

if (files.length === 0) {
  fail("specs/", "expected at least one product spec");
}

for (const file of files) {
  const path = join(specsDir, file);
  const text = readFileSync(path, "utf8");
  const statusMatch = text.match(/^Status:\s*([a-z-]+)\s*$/m);

  if (!statusMatch) {
    fail(file, "missing `Status: <draft|active|implemented|superseded>`");
  } else if (!allowedStatuses.has(statusMatch[1])) {
    fail(file, `invalid status \`${statusMatch[1]}\``);
  }

  for (const heading of requiredHeadings) {
    if (!text.includes(`${heading}\n`)) {
      fail(file, `missing required heading \`${heading}\``);
    }
  }

  if (!/^Last Reviewed:\s*\d{4}-\d{2}-\d{2}\s*$/m.test(text)) {
    fail(file, "missing `Last Reviewed: YYYY-MM-DD`");
  }

  if (!/## Acceptance Criteria\n[\s\S]*-\s+\[[ x]\]\s+/i.test(text)) {
    fail(file, "acceptance criteria must include checklist items");
  }

  if (!/## Verification\n[\s\S]*`npm run verify:offline`/.test(text)) {
    fail(file, "verification must mention `npm run verify:offline`");
  }
}

if (failures > 0) {
  console.error(`spec smoke failed with ${failures} issue(s)`);
  process.exit(1);
}

console.log(`spec smoke passed (${files.length} spec files)`);
