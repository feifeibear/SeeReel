#!/usr/bin/env node
import { access, cp, mkdir, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const home = os.homedir();

// Single, framework-neutral source of truth: the cross-platform standard `.agents/skills/`
// directory. Codex / Gemini / OpenCode read it as a project skill directly; the other
// frameworks get a copy via the targets below so no runtime is special-cased in git.
const skillsRoot = path.join(repoRoot, ".agents", "skills");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const postinstall = args.includes("--postinstall");
const agentArg = valueAfter("--agent"); // undefined / "auto" => detect installed runtimes
const skillArg = valueAfter("--skill") || "all";

if (postinstall && (process.env.CI || process.env.SEEREEL_SKIP_SKILL_INSTALL === "1" || process.env.REELYAI_SKIP_SKILL_INSTALL === "1")) {
  console.log("Skipping SeeReel skill installation during postinstall.");
  process.exit(0);
}

// Per-framework targets.
// - `detect`: home config dir whose presence means the runtime is installed on this machine.
// - `global`: home-level skills dir, shared across all that user's projects.
// - `projectMirror`: in-repo, gitignored copy for runtimes that do NOT natively read
//   `.agents/skills/`. Codex/agents read the committed source directly, so they skip this.
const frameworks = {
  codex: {
    detect: path.join(home, ".codex"),
    global: path.join(home, ".codex", "skills")
  },
  claude: {
    detect: path.join(home, ".claude"),
    global: path.join(home, ".claude", "skills"),
    projectMirror: path.join(repoRoot, ".claude", "skills")
  },
  cursor: {
    detect: path.join(home, ".cursor"),
    global: path.join(home, ".cursor", "skills"),
    projectMirror: path.join(repoRoot, ".cursor", "skills")
  },
  agents: {
    detect: path.join(home, ".agents"),
    global: path.join(home, ".agents", "skills")
  }
};

const skillNames = await resolveSkillNames(skillArg);
const selected = await resolveFrameworks(agentArg);

for (const key of selected) {
  const fw = frameworks[key];
  for (const skillName of skillNames) {
    const sourceDir = path.join(skillsRoot, skillName);
    await installCopy(sourceDir, path.join(fw.global, skillName), `${key} global`);
    if (fw.projectMirror) {
      await installCopy(sourceDir, path.join(fw.projectMirror, skillName), `${key} project mirror`);
    }
  }
}

async function installCopy(sourceDir, target, label) {
  if (dryRun) {
    console.log(`[dry-run] ${sourceDir} -> ${target} (${label})`);
    return;
  }
  await mkdir(path.dirname(target), { recursive: true });
  await rm(target, { recursive: true, force: true });
  await cp(sourceDir, target, { recursive: true });
  console.log(`Installed ${path.basename(sourceDir)} -> ${target} (${label})`);
}

async function resolveFrameworks(value) {
  const all = Object.keys(frameworks);
  if (value === "all") return all;
  if (value && value !== "auto") {
    const list = splitList(value);
    for (const key of list) {
      if (!frameworks[key]) {
        throw new Error(`Unknown agent target "${key}". Use --agent ${all.join(",")} or --agent all.`);
      }
    }
    return list;
  }
  // Auto-detect: only touch runtimes that exist on this machine; fall back to all.
  const detected = [];
  for (const key of all) {
    if (await exists(frameworks[key].detect)) detected.push(key);
  }
  if (detected.length) {
    console.log(`Detected agent runtimes: ${detected.join(", ")}`);
    return detected;
  }
  console.log("No agent runtimes detected; installing to all known targets.");
  return all;
}

function exists(target) {
  return access(target).then(() => true).catch(() => false);
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
    await readFile(path.join(skillsRoot, entry.name, "SKILL.md"), "utf8")
      .then(() => names.push(entry.name))
      .catch(() => undefined);
  }
  return names.sort();
}
