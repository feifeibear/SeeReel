import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const cli = "packages/reelyai-cli/bin/reelyai.js";
const baseUrl = process.env.SEEREEL_SMOKE_BASE_URL || process.env.REELYAI_SMOKE_BASE_URL || "http://localhost:5174";

async function runCli(args) {
  const { stdout, stderr } = await execFileAsync(process.execPath, [cli, ...args], {
    env: {
      ...process.env,
      SEEREEL_CLI_HOME: process.env.SEEREEL_CLI_HOME || process.env.REELYAI_CLI_HOME || "/tmp/seereel-cli-smoke"
    },
    maxBuffer: 5 * 1024 * 1024
  });
  return { stdout, stderr };
}

async function main() {
  const help = await runCli(["--help"]);
  assert.match(help.stdout, /--progress/);
  assert.match(help.stdout, /--jsonl/);
  assert.match(help.stdout, /--stitch-partial/);
  assert.match(help.stdout, /--repair-policy <none\|safe-retry>/);
  assert.match(help.stdout, /--max-attempts <n>/);
  assert.match(help.stdout, /seereelcli download --session <sessionId\|latest> --output \.\/final\.mp4/);
  assert.match(help.stdout, /seereelcli handoff --session <sessionId\|latest> \[--open\]/);
  assert.match(help.stdout, /Default: \.\/seereel-<sessionId>\.mp4/);

  const status = await runCli(["status", "--base-url", baseUrl, "--session", "latest", "--deep", "--json"]);
  const parsed = JSON.parse(status.stdout);
  assert.equal(parsed.action, "status");
  assert.equal(parsed.deep, true);
  assert.ok(parsed.session || parsed.sessions?.length === 0);
  if (parsed.session) {
    assert.ok(Array.isArray(parsed.session.shots), "deep status includes shot details");
    assert.ok("downloadUrl" in parsed.session, "deep status includes final download URL field");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
