import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const cli = "packages/seereel-cli/bin/seereelcli.js";
const baseUrl = process.env.SEEREEL_SMOKE_BASE_URL || "http://localhost:5174";
const defaultCliHome = process.env.SEEREEL_CLI_HOME || "/tmp/seereel-cli-smoke";

async function runCli(args, env = {}) {
  const { stdout, stderr } = await execFileAsync(process.execPath, [cli, ...args], {
    env: {
      ...process.env,
      SEEREEL_CLI_HOME: defaultCliHome,
      ...env
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
  assert.match(help.stdout, /--cloud-only/);
  assert.match(help.stdout, /--api-key <key>/);
  assert.match(help.stdout, /--reference-image <path\|url>/);
  assert.match(help.stdout, /--output <path>/);
  assert.match(help.stdout, /--repair-policy <none\|safe-retry>/);
  assert.match(help.stdout, /--max-attempts <n>/);
  assert.match(help.stdout, /seereelcli download --session <sessionId\|latest> --output \.\/final\.mp4/);
  assert.match(help.stdout, /seereelcli handoff --session <sessionId\|latest> \[--open\]/);
  assert.match(help.stdout, /Default: \.\/seereel-<sessionId>\.mp4/);

  const tempCliHome = await mkdtemp(path.join(os.tmpdir(), "seereel-cli-api-key-smoke-"));
  try {
    const configured = await runCli([
      "configure",
      "--base-url",
      baseUrl,
      "--api-key",
      "smoke-standard-api-key",
      "--agent-plan-token",
      "smoke-agent-plan-key",
      "--json"
    ], { SEEREEL_CLI_HOME: tempCliHome });
    const parsedConfig = JSON.parse(configured.stdout);
    assert.equal(parsedConfig.apiKeyConfigured, true);
    assert.equal(parsedConfig.agentPlanTokenConfigured, true);
    assert.ok(!configured.stdout.includes("smoke-standard-api-key"), "configure output must not reveal API key");
    assert.ok(!configured.stdout.includes("smoke-agent-plan-key"), "configure output must not reveal Agent Plan key");
  } finally {
    await rm(tempCliHome, { recursive: true, force: true });
  }

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
