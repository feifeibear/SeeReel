#!/usr/bin/env node
import { cp, mkdir, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const skillsRoot = path.join(repoRoot, "skills");
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const postinstall = args.includes("--postinstall");
const agentArg = valueAfter("--agent") || "all";
const skillArg = valueAfter("--skill") || "all";

if (postinstall && (process.env.CI || process.env.REELYAI_SKIP_SKILL_INSTALL === "1")) {
  console.log("Skipping ReelyAI skill installation during postinstall.");
  process.exit(0);
}

const skillNames = await resolveSkillNames(skillArg);

const targetRoots = {
  codex: path.join(os.homedir(), ".codex", "skills"),
  cursor: path.join(os.homedir(), ".cursor", "skills"),
  agents: path.join(os.homedir(), ".agents", "skills")
};

// Skills that Cursor must auto-load from inside the repo (project-scoped). They are
// regenerated here from skills/ so that skills/ stays the single source of truth and the
// repo's .cursor/skills/ copy never has to be hand-maintained.
const cursorProjectSkills = new Set(["reelyai-agent-session"]);
const repoCursorSkillsRoot = path.join(repoRoot, ".cursor", "skills");

const selected = agentArg === "all" ? Object.keys(targetRoots) : splitList(agentArg);

for (const key of selected) {
  const targetRoot = targetRoots[key];
  if (!targetRoot) {
    throw new Error(`Unknown agent target "${key}". Use --agent codex,cursor,agents or --agent all.`);
  }
  for (const skillName of skillNames) {
    const sourceDir = path.join(skillsRoot, skillName);
    const target = path.join(targetRoot, skillName);
    if (dryRun) {
      console.log(`[dry-run] ${sourceDir} -> ${target}`);
      continue;
    }
    await mkdir(path.dirname(target), { recursive: true });
    await rm(target, { recursive: true, force: true });
    await cp(sourceDir, target, { recursive: true });
    console.log(`Installed ${skillName} -> ${target}`);
  }
}

for (const skillName of skillNames) {
  if (!cursorProjectSkills.has(skillName)) continue;
  const sourceDir = path.join(skillsRoot, skillName);
  const target = path.join(repoCursorSkillsRoot, skillName);
  if (dryRun) {
    console.log(`[dry-run] ${sourceDir} -> ${target}`);
    continue;
  }
  await mkdir(path.dirname(target), { recursive: true });
  await rm(target, { recursive: true, force: true });
  await cp(sourceDir, target, { recursive: true });
  console.log(`Synced ${skillName} -> ${target} (Cursor project skill)`);
}

function valueAfter(flag) {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  return args[index + 1];
}

function splitList(value) {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

async function resolveSkillNames(value) {
  const requested = value === "all" ? await listProjectSkills() : splitList(value);
  if (!requested.length) throw new Error("No skills selected.");
  for (const skillName of requested) {
    await readFile(path.join(skillsRoot, skillName, "SKILL.md"), "utf8").catch(() => {
      throw new Error(`Skill "${skillName}" does not exist under ${skillsRoot}.`);
    });
  }
  return requested;
}

async function listProjectSkills() {
  const entries = await readdir(skillsRoot, { withFileTypes: true }).catch(() => []);
  const names = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillName = entry.name;
    await readFile(path.join(skillsRoot, skillName, "SKILL.md"), "utf8")
      .then(() => names.push(skillName))
      .catch(() => undefined);
  }
  return names.sort();
}
