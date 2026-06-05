import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const packageDir = "packages/seereel-cli";
const packageJsonPath = path.join(packageDir, "package.json");
const cliPath = path.join(packageDir, "bin", "seereelcli.js");
const skillPath = path.join(packageDir, "skills", "seereel-cli", "SKILL.md");
const legacyBrandPattern = new RegExp(["reel", "yai"].join(""), "i");
const legacyCliPattern = new RegExp(["reel", "yaicli"].join(""), "i");
const legacyPackageDir = path.join("packages", ["reel", "yai-cli"].join(""));

assert.ok(fs.existsSync(packageJsonPath), "SeeReel CLI package directory should be packages/seereel-cli");
assert.ok(fs.existsSync(cliPath), "SeeReel CLI binary should be bin/seereelcli.js");
assert.ok(fs.existsSync(skillPath), "Bundled CLI skill should live under skills/seereel-cli");
assert.equal(fs.existsSync(legacyPackageDir), false, "legacy CLI package directory should be removed");

const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
assert.equal(packageJson.name, "seereelcli");
assert.equal(packageJson.bin?.seereelcli, "bin/seereelcli.js");
assert.equal(packageJson.scripts?.smoke, "node bin/seereelcli.js --help");

const skill = fs.readFileSync(skillPath, "utf8");
assert.match(skill, /^name: seereel-cli$/m);
assert.doesNotMatch(skill, legacyBrandPattern);
assert.doesNotMatch(skill, legacyCliPattern);

const help = spawnSync(process.execPath, [cliPath, "--help"], { encoding: "utf8" });
assert.equal(help.status, 0, help.stderr || help.stdout);
assert.match(help.stdout, /SeeReel CLI/);
assert.match(help.stdout, /seereelcli workflow/);
assert.doesNotMatch(help.stdout + help.stderr, legacyBrandPattern);
assert.doesNotMatch(help.stdout + help.stderr, legacyCliPattern);

console.log("smoke-seereel-cli: ok");
