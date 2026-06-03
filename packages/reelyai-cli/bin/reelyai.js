#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_BASE_URL =
  process.env.REELYAI_AGENT_BASE_URL ||
  process.env.CINEMA_AGENT_BASE_URL ||
  "https://reelyai.app";

const CONFIG_DIR = process.env.REELYAI_CLI_HOME || path.join(os.homedir(), ".reelyai");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REELYAI_CLI_SKILL = path.join(PACKAGE_ROOT, "skills", "reelyai-cli", "SKILL.md");
const DEFAULT_POLL_INTERVAL_MS = 3000;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

const HELP = `
ReelyAI CLI

Create visible ReelyAI canvas workflows from natural language, then let a human
review or take over in the web app.

Usage:
  reelyai workflow "a 60s cyberpunk short about ..." [options]
  reelyai node <get|update-prompt|generate|poll|tailframe|review|repair> --id <nodeId> [options]
  reelyai publish-storyboards --session <sessionId|latest>
  reelyai final-review --session <sessionId|latest> [--repair]
  reelyai render --session <sessionId> [options]
  reelyai stitch --session <sessionId> [options]
  reelyai skill <install|print|path> [options]
  reelyai status [options]
  reelyai configure [options]
  reelyai open --session <sessionId> [options]

Aliases:
  workflow: new, create, plan

Global options:
  --base-url <url>              ReelyAI server. Default: env or https://reelyai.app
  --access-token <token>        Shared deployment token, also read from REELYAI_ACCESS_TOKEN
  --agent-plan-token <token>    Browser-scoped Agent Plan key for model generation
  --json                        Print machine-readable JSON

workflow options:
  --title <title>               Session title
  --duration <sec>              Target duration. Default: 60
  --shots <count>               Shot count. Default: ceil(duration / 15)
  --style <text>                Visual style
  --language <zh|en>            Session UI/script language. Default: zh
  --no-script                   Skip /script/generate
  --no-storyboard               Skip /storyboard
  --render                      Continue into shot generation after storyboard
  --stitch                      Stitch after render, or after storyboard if shots are ready
  --open                        Open the created session in the browser

render options:
  --session <sessionId|latest>  Session to render. Default: latest
  --mode <missing|all>          Workflow plan mode. Default: missing
  --max-parallel-shots <n>      Max parallel independent shots. Default: 1
  --stitch                      Stitch after shots are ready

node options:
  --id <nodeId>                 Shot, asset, or session id. Also accepts --shot / --asset
  --prompt <text>               New prompt for update-prompt
  --title <text>                Optional shot title for update-prompt
  --duration <sec>              Optional shot duration for update-prompt
  --wait                        Poll after starting shot generation
  --publish-tos                 Publish a shot tailframe to TOS for Seedance references
  --canvas-node                 Save tailframe as a session-scoped visible canvas node
  --frame-count <n>             VLM review frame count
  --model <model>               Asset image model for asset generate

skill options:
  --agent <all|codex,claude,cursor,agents>
                                Install bundled reelyai-cli skill. Default: all

Examples:
  npm install -g reelyai
  reelyai skill install --agent all
  reelyai configure --base-url https://reelyai.app --access-token "$REELYAI_ACCESS_TOKEN"
  reelyai workflow "一个失眠导演在午夜便利店遇见未来的自己" --duration 60 --style "neo-noir, rain"
  reelyai node update-prompt --id shot_xxx --prompt "new Seedance prompt"
  reelyai node tailframe --id shot_xxx --publish-tos --canvas-node
  reelyai node review --id shot_xxx --frame-count 8
  reelyai render --session latest --stitch
`;

class CliError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.name = "CliError";
    this.code = code;
  }
}

function parseArgs(argv) {
  const args = [...argv];
  const command = args[0]?.startsWith("-") ? "help" : args.shift() || "help";
  const positionals = [];
  const options = {};

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--") {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    if (arg.startsWith("--no-")) {
      options[toCamel(arg.slice(5))] = false;
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq >= 0) {
      options[toCamel(arg.slice(2, eq))] = arg.slice(eq + 1);
      continue;
    }
    const key = toCamel(arg.slice(2));
    const next = args[i + 1];
    if (next && !next.startsWith("--")) {
      options[key] = next;
      i += 1;
    } else {
      options[key] = true;
    }
  }
  return { command, positionals, options };
}

function toCamel(value) {
  return value.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
}

async function readConfig() {
  try {
    return JSON.parse(await readFile(CONFIG_FILE, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
}

async function writeConfig(config) {
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await writeFile(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

function resolveRuntime(config, options) {
  const baseUrl = normalizeBaseUrl(
    String(options.baseUrl || process.env.REELYAI_AGENT_BASE_URL || process.env.CINEMA_AGENT_BASE_URL || config.baseUrl || DEFAULT_BASE_URL)
  );
  return {
    baseUrl,
    accessToken:
      stringOption(options.accessToken) ||
      process.env.REELYAI_ACCESS_TOKEN ||
      process.env.REELYAI_CLI_ACCESS_TOKEN ||
      config.accessToken ||
      "",
    agentPlanToken:
      stringOption(options.agentPlanToken) ||
      process.env.REELYAI_AGENT_PLAN_TOKEN ||
      process.env.ARK_AGENT_PLAN_KEY ||
      config.agentPlanToken ||
      "",
    cookies: config.cookies || {}
  };
}

function stringOption(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function normalizeBaseUrl(value) {
  const url = value.trim();
  if (!/^https?:\/\//i.test(url)) throw new CliError(`Invalid --base-url: ${value}`);
  return url.replace(/\/+$/, "");
}

function originFor(baseUrl) {
  return new URL(baseUrl).origin;
}

function cookieHeader(runtime) {
  const jar = runtime.cookies?.[originFor(runtime.baseUrl)] || {};
  return Object.entries(jar)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join("; ");
}

function rememberCookies(runtime, headers) {
  const setCookies =
    typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : splitSetCookie(headers.get("set-cookie") || "");
  if (!setCookies.length) return false;

  const origin = originFor(runtime.baseUrl);
  runtime.cookies ||= {};
  runtime.cookies[origin] ||= {};
  for (const line of setCookies) {
    const [pair] = line.split(";");
    const index = pair.indexOf("=");
    if (index <= 0) continue;
    const name = pair.slice(0, index).trim();
    const value = decodeURIComponent(pair.slice(index + 1).trim());
    if (value) runtime.cookies[origin][name] = value;
    else delete runtime.cookies[origin][name];
  }
  return true;
}

function splitSetCookie(value) {
  if (!value) return [];
  return value.split(/,(?=[^;,]+=)/).map((item) => item.trim()).filter(Boolean);
}

async function api(runtime, route, init = {}) {
  const headers = {
    Accept: "application/json",
    ...(init.body ? { "Content-Type": "application/json" } : {}),
    ...(runtime.accessToken ? { "x-reelyai-access": runtime.accessToken } : {}),
    ...(cookieHeader(runtime) ? { Cookie: cookieHeader(runtime) } : {}),
    ...(init.headers || {})
  };
  const res = await fetch(`${runtime.baseUrl}${route}`, { ...init, headers });
  const changedCookies = rememberCookies(runtime, res.headers);
  if (changedCookies) {
    const config = await readConfig();
    config.cookies = runtime.cookies;
    await writeConfig(config);
  }

  const text = await res.text();
  let body = text;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    // Keep plain-text body.
  }
  if (!res.ok) {
    const message = body?.error || body?.message || text || `${res.status} ${res.statusText}`;
    if (body?.code === "access_token_required") {
      throw new CliError(`${message}. Pass --access-token or set REELYAI_ACCESS_TOKEN.`);
    }
    throw new CliError(`${route} failed: ${message}`);
  }
  return body;
}

async function ensureAgentPlan(runtime) {
  if (!runtime.agentPlanToken) return undefined;
  const status = await api(runtime, "/api/credentials/agent-plan");
  if (status?.configured) return status;
  return api(runtime, "/api/credentials/agent-plan", {
    method: "POST",
    body: JSON.stringify({ apiKey: runtime.agentPlanToken })
  });
}

function sessionUrl(baseUrl, sessionId) {
  return `${baseUrl}/#/s/${encodeURIComponent(sessionId)}`;
}

function downloadUrl(baseUrl, sessionId) {
  return `${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/download`;
}

function clampInt(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function inferTitle(prompt, explicit) {
  if (explicit) return explicit;
  const compact = prompt.replace(/\s+/g, " ").trim();
  return compact.slice(0, 28) || "ReelyAI Workflow";
}

async function readPrompt(positionals) {
  const prompt = positionals.join(" ").trim();
  if (prompt) return prompt;
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString("utf8").trim();
  }
  throw new CliError("Missing natural-language prompt. Example: reelyai workflow \"a 60s short...\"");
}

function summarizeShots(shots = []) {
  return shots
    .slice()
    .sort((a, b) => (a.index || 0) - (b.index || 0))
    .map((shot) => ({
      index: shot.index,
      id: shot.id,
      title: shot.title,
      durationSec: shot.durationSec,
      status: shot.status,
      videoUrl: shot.videoUrl
    }));
}

function summarizeAsset(asset) {
  if (!asset) return undefined;
  return {
    id: asset.id,
    name: asset.name,
    type: asset.type,
    mediaKind: asset.mediaKind,
    mediaUrl: asset.mediaUrl,
    imageUrl: asset.imageUrl,
    ownerSessionId: asset.ownerSessionId,
    ownerShotId: asset.ownerShotId,
    imageReviewStatus: asset.imageReviewStatus
  };
}

function summarizeShot(shot) {
  if (!shot) return undefined;
  return {
    id: shot.id,
    sessionId: shot.sessionId,
    index: shot.index,
    title: shot.title,
    durationSec: shot.durationSec,
    status: shot.status,
    videoUrl: shot.videoUrl,
    firstFrameAssetId: shot.firstFrameAssetId,
    lastFrameAssetId: shot.lastFrameAssetId,
    usePreviousShotClip: shot.usePreviousShotClip,
    referenceVideoAssetId: shot.referenceVideoAssetId,
    videoReviewStatus: shot.videoReviewStatus,
    rawPrompt: shot.rawPrompt,
    prompt: shot.prompt
  };
}

async function commandWorkflow(runtime, positionals, options) {
  await api(runtime, "/api/healthz");
  const agentPlan = await ensureAgentPlan(runtime);
  const prompt = await readPrompt(positionals);
  const duration = clampInt(options.duration, 60, { min: 1, max: 3600 });
  const shotCount = clampInt(options.shots, Math.ceil(duration / 15), { min: 1, max: 120 });
  const title = inferTitle(prompt, stringOption(options.title));
  const style = stringOption(options.style) || "cinematic short drama, coherent multi-shot continuity";
  const language = options.language === "en" ? "en" : "zh";

  const session = await api(runtime, "/api/sessions", {
    method: "POST",
    body: JSON.stringify({
      title,
      logline: prompt,
      style,
      language,
      targetDurationSec: duration,
      shotCount
    })
  });

  let currentSession = session;
  let storyboard;
  if (options.script !== false) {
    currentSession = await api(runtime, `/api/sessions/${session.id}/script/generate`, { method: "POST" });
  }
  if (options.storyboard !== false) {
    storyboard = await api(runtime, `/api/sessions/${session.id}/storyboard`, { method: "POST" });
    currentSession = storyboard.session || currentSession;
  }

  let renderResult;
  if (options.render) {
    renderResult = await renderSession(runtime, session.id, {
      mode: "missing",
      maxParallelShots: clampInt(options.maxParallelShots, 1, { min: 1, max: 8 }),
      stitch: Boolean(options.stitch),
      timeoutMs: clampInt(options.timeoutMs, DEFAULT_TIMEOUT_MS, { min: 10_000 }),
      pollIntervalMs: clampInt(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS, { min: 1000 })
    });
  } else if (options.stitch) {
    renderResult = { stitched: await stitchSession(runtime, session.id, options) };
  }

  const result = {
    baseUrl: runtime.baseUrl,
    sessionId: session.id,
    title: currentSession.title || title,
    webUrl: sessionUrl(runtime.baseUrl, session.id),
    agentPlan,
    story: currentSession.story,
    shots: summarizeShots(storyboard?.shots || currentSession.shots || session.shots || []),
    render: renderResult
  };

  if (options.open) openUrl(result.webUrl);
  return result;
}

async function commandRender(runtime, options) {
  await api(runtime, "/api/healthz");
  await ensureAgentPlan(runtime);
  const sessionId = await resolveSessionId(runtime, options.session || "latest");
  return renderSession(runtime, sessionId, {
    mode: options.mode === "all" ? "all" : "missing",
    maxParallelShots: clampInt(options.maxParallelShots, 1, { min: 1, max: 8 }),
    stitch: Boolean(options.stitch),
    timeoutMs: clampInt(options.timeoutMs, DEFAULT_TIMEOUT_MS, { min: 10_000 }),
    pollIntervalMs: clampInt(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS, { min: 1000 })
  });
}

async function commandNode(runtime, positionals, options, forcedKind) {
  await api(runtime, "/api/healthz");
  const action = positionals[0] || "get";
  const id = resolveNodeArg(positionals, options);
  const node = await resolveNode(runtime, id, forcedKind);

  if (action === "get" || action === "show") {
    return nodeResult(runtime, node, { action });
  }

  if (action === "update-prompt" || action === "prompt" || action === "update") {
    const prompt = stringOption(options.prompt) || (positionals.length > 2 ? positionals.slice(2).join(" ").trim() : "");
    if (!prompt) throw new CliError("Missing --prompt for node update-prompt.");
    if (node.kind === "shot") {
      const patch = { rawPrompt: prompt, prompt };
      if (options.title) patch.title = String(options.title);
      if (options.duration) patch.durationSec = clampInt(options.duration, node.value.durationSec || 15, { min: 1, max: 15 });
      const updated = await api(runtime, `/api/shots/${node.id}`, { method: "PATCH", body: JSON.stringify(patch) });
      return nodeResult(runtime, { kind: "shot", id: updated.id, value: updated }, { action: "update-prompt" });
    }
    if (node.kind === "asset") {
      const updated = await api(runtime, `/api/assets/${node.id}`, {
        method: "PATCH",
        body: JSON.stringify({ prompt, description: stringOption(options.description) || node.value.description })
      });
      return nodeResult(runtime, { kind: "asset", id: updated.id, value: updated }, { action: "update-prompt" });
    }
    throw new CliError("update-prompt supports shot and asset nodes.");
  }

  if (action === "generate") {
    await ensureAgentPlan(runtime);
    if (node.kind === "shot") {
      const generated = await api(runtime, `/api/shots/${node.id}/generate`, { method: "POST" });
      if (!options.wait) return nodeResult(runtime, { kind: "shot", id: generated.id, value: generated }, { action: "generate" });
      const rendered = await waitForShot(runtime, node.id, {
        timeoutMs: clampInt(options.timeoutMs, DEFAULT_TIMEOUT_MS, { min: 10_000 }),
        pollIntervalMs: clampInt(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS, { min: 1000 })
      });
      return { action: "generate", kind: "shot", webUrl: sessionUrl(runtime.baseUrl, rendered.sessionId || node.value.sessionId), shot: summarizeShot(rendered) };
    }
    if (node.kind === "asset") {
      const generated = await api(runtime, `/api/assets/${node.id}/generate`, {
        method: "POST",
        body: JSON.stringify({
          model: stringOption(options.model) || undefined,
          visionReview: options.visionReview === true ? true : undefined,
          maxReviewAttempts: options.maxReviewAttempts ? clampInt(options.maxReviewAttempts, 1, { min: 1, max: 5 }) : undefined
        })
      });
      return nodeResult(runtime, { kind: "asset", id: generated.id, value: generated }, { action: "generate" });
    }
    throw new CliError("generate supports shot and asset nodes.");
  }

  if (action === "poll") {
    if (node.kind !== "shot") throw new CliError("poll only supports shot nodes.");
    const shot = await api(runtime, `/api/shots/${node.id}/poll`, { method: "POST" });
    return nodeResult(runtime, { kind: "shot", id: shot.id, value: shot }, { action: "poll" });
  }

  if (action === "tailframe") {
    if (node.kind !== "shot") throw new CliError("tailframe only supports shot nodes with rendered video.");
    const result = await api(runtime, `/api/shots/${node.id}/tailframe`, {
      method: "POST",
      body: JSON.stringify({
        publishToTos: Boolean(options.publishTos),
        canvasNode: Boolean(options.canvasNode)
      })
    });
    return {
      action: "tailframe",
      kind: "shot",
      shotId: node.id,
      webUrl: sessionUrl(runtime.baseUrl, node.value.sessionId),
      asset: summarizeAsset(result.asset)
    };
  }

  if (action === "review" || action === "vlm") {
    await ensureAgentPlan(runtime);
    if (node.kind === "shot") {
      const reviewed = await api(runtime, `/api/shots/${node.id}/review`, {
        method: "POST",
        body: JSON.stringify({ frameCount: clampInt(options.frameCount, 8, { min: 1, max: 32 }) })
      });
      return nodeResult(runtime, { kind: "shot", id: reviewed.id, value: reviewed }, { action: "review" });
    }
    if (node.kind === "asset") {
      const reviewed = await api(runtime, `/api/assets/${node.id}/review`, { method: "POST" });
      return nodeResult(runtime, { kind: "asset", id: reviewed.id, value: reviewed }, { action: "review" });
    }
    if (node.kind === "session") {
      return commandFinalReview(runtime, { ...options, session: node.id });
    }
    throw new CliError("review supports shot, asset, and session nodes.");
  }

  if (action === "repair" || action === "repair-prompts") {
    await ensureAgentPlan(runtime);
    if (node.kind === "shot") {
      const repaired = await api(runtime, `/api/shots/${node.id}/review/repair-prompts`, { method: "POST" });
      return nodeResult(runtime, { kind: "shot", id: repaired.id, value: repaired }, { action: "repair" });
    }
    if (node.kind === "session") {
      return commandFinalReview(runtime, { ...options, session: node.id, repair: true });
    }
    throw new CliError("repair supports shot and session nodes.");
  }

  throw new CliError(`Unknown node action: ${action}`);
}

async function commandPublishStoryboards(runtime, options) {
  await api(runtime, "/api/healthz");
  const sessionId = await resolveSessionId(runtime, options.session || "latest");
  const result = await api(runtime, `/api/sessions/${sessionId}/storyboards/publish-tos`, { method: "POST" });
  return {
    action: "publish-storyboards",
    sessionId,
    webUrl: sessionUrl(runtime.baseUrl, sessionId),
    assets: (result.assets || []).map(summarizeAsset),
    shots: summarizeShots(result.session?.shots || [])
  };
}

async function commandFinalReview(runtime, options) {
  await api(runtime, "/api/healthz");
  await ensureAgentPlan(runtime);
  const sessionId = await resolveSessionId(runtime, options.session || "latest");
  const route = options.repair ? `/api/sessions/${sessionId}/final-review/repair-prompts` : `/api/sessions/${sessionId}/final-review`;
  const result = await api(runtime, route, {
    method: "POST",
    body: JSON.stringify({
      jobId: stringOption(options.jobId) || undefined,
      frameCount: options.frameCount ? clampInt(options.frameCount, 10, { min: 1, max: 32 }) : undefined
    })
  });
  return {
    action: options.repair ? "final-review-repair" : "final-review",
    sessionId,
    webUrl: sessionUrl(runtime.baseUrl, sessionId),
    session: {
      id: result.id,
      title: result.title,
      finalVideoReviewStatus: result.finalVideoReviewStatus,
      finalVideoReview: result.finalVideoReview,
      finalVideoReviewRepairPlan: result.finalVideoReviewRepairPlan
    }
  };
}

async function renderSession(runtime, sessionId, options) {
  const plan = await api(runtime, `/api/sessions/${sessionId}/workflow/plan`, {
    method: "POST",
    body: JSON.stringify({ mode: options.mode, maxParallelShots: options.maxParallelShots })
  });
  const layerResults = [];
  for (const layer of plan.layers || []) {
    const rendered = await Promise.all(layer.map((item) => renderShot(runtime, item, options)));
    layerResults.push(rendered);
  }
  const state = await api(runtime, "/api/state");
  const shots = state.shots?.filter((shot) => shot.sessionId === sessionId) || [];
  const failed = shots.filter((shot) => shot.status === "error" || shot.status === "cancelled" || !shot.videoUrl);
  const stitched = options.stitch && failed.length === 0 ? await stitchSession(runtime, sessionId, options) : undefined;
  return {
    baseUrl: runtime.baseUrl,
    sessionId,
    webUrl: sessionUrl(runtime.baseUrl, sessionId),
    planSummary: plan.summary,
    layers: layerResults,
    shots: summarizeShots(shots),
    failed: summarizeShots(failed),
    stitched
  };
}

async function renderShot(runtime, item, options) {
  const shotId = item.shotId || item.id;
  if (!shotId) throw new CliError(`Workflow item is missing shot id: ${JSON.stringify(item)}`);
  if (item.index > 1 && item.action !== "skip") {
    await api(runtime, `/api/shots/${shotId}`, {
      method: "PATCH",
      body: JSON.stringify({ usePreviousShotClip: true, previousShotClipSec: 2 })
    });
  }
  await api(runtime, `/api/shots/${shotId}/generate`, { method: "POST" });
  return waitForShot(runtime, shotId, options);
}

async function waitForShot(runtime, shotId, options) {
  const started = Date.now();
  let snapshot;
  while (Date.now() - started < options.timeoutMs) {
    snapshot = await api(runtime, `/api/shots/${shotId}/poll`, { method: "POST" });
    if (["ready", "error", "cancelled"].includes(snapshot.status)) {
      return {
        id: snapshot.id,
        index: snapshot.index,
        title: snapshot.title,
        status: snapshot.status,
        videoUrl: snapshot.videoUrl,
        error: snapshot.error
      };
    }
    await sleep(options.pollIntervalMs);
  }
  throw new CliError(`Timed out waiting for shot ${shotId}`);
}

function resolveNodeArg(positionals, options) {
  const id = stringOption(options.id) || stringOption(options.shot) || stringOption(options.asset) || stringOption(options.session) || positionals[1];
  if (!id || id === true) throw new CliError("Missing node id. Use --id shot_xxx / --id asset_xxx / --id ses_xxx.");
  return String(id);
}

async function resolveNode(runtime, id, forcedKind) {
  const state = await api(runtime, "/api/state");
  if (forcedKind === "shot" || (!forcedKind && id.startsWith("shot_"))) {
    const shot = (state.shots || []).find((item) => item.id === id);
    if (!shot) throw new CliError(`Shot not found: ${id}`);
    return { kind: "shot", id, value: shot };
  }
  if (forcedKind === "asset" || (!forcedKind && id.startsWith("asset_"))) {
    const asset = (state.assets || []).find((item) => item.id === id);
    if (!asset) throw new CliError(`Asset not found: ${id}`);
    return { kind: "asset", id, value: asset };
  }
  if (forcedKind === "session" || (!forcedKind && id.startsWith("ses_"))) {
    const session = (state.sessions || []).find((item) => item.id === id);
    if (!session) throw new CliError(`Session not found: ${id}`);
    return { kind: "session", id, value: session };
  }
  const shot = (state.shots || []).find((item) => item.id === id);
  if (shot) return { kind: "shot", id, value: shot };
  const asset = (state.assets || []).find((item) => item.id === id);
  if (asset) return { kind: "asset", id, value: asset };
  const session = (state.sessions || []).find((item) => item.id === id);
  if (session) return { kind: "session", id, value: session };
  throw new CliError(`Node not found: ${id}`);
}

function nodeResult(runtime, node, extra = {}) {
  const sessionId = node.kind === "shot" ? node.value.sessionId : node.kind === "asset" ? node.value.ownerSessionId : node.value.id;
  return {
    ...extra,
    kind: node.kind,
    id: node.id,
    webUrl: sessionId ? sessionUrl(runtime.baseUrl, sessionId) : undefined,
    shot: node.kind === "shot" ? summarizeShot(node.value) : undefined,
    asset: node.kind === "asset" ? summarizeAsset(node.value) : undefined,
    session: node.kind === "session" ? {
      id: node.value.id,
      title: node.value.title,
      finalVideoUrl: node.value.finalVideoUrl,
      stitchStatus: node.value.stitchStatus,
      finalVideoReviewStatus: node.value.finalVideoReviewStatus
    } : undefined
  };
}

async function stitchSession(runtime, sessionId, options) {
  let session = await api(runtime, `/api/sessions/${sessionId}/stitch`, {
    method: "POST",
    body: JSON.stringify({ force: Boolean(options.force) })
  });
  const started = Date.now();
  const timeoutMs = clampInt(options.timeoutMs, DEFAULT_TIMEOUT_MS, { min: 10_000 });
  const pollIntervalMs = clampInt(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS, { min: 1000 });
  while (session.stitchStatus === "running" && Date.now() - started < timeoutMs) {
    await sleep(pollIntervalMs);
    session = await api(runtime, `/api/sessions/${sessionId}/stitch/poll`, { method: "POST" });
  }
  return {
    sessionId,
    status: session.stitchStatus,
    progress: session.stitchProgress,
    error: session.stitchError,
    finalVideoUrl: session.finalVideoUrl,
    webUrl: sessionUrl(runtime.baseUrl, sessionId),
    downloadUrl: session.finalVideoUrl ? downloadUrl(runtime.baseUrl, sessionId) : undefined
  };
}

async function resolveSessionId(runtime, value) {
  if (value && value !== true && value !== "latest") return String(value);
  const state = await api(runtime, "/api/state");
  const latest = state.sessions?.[0];
  if (!latest) throw new CliError("No sessions found.");
  return latest.id;
}

async function commandStatus(runtime, options) {
  const health = await api(runtime, "/api/healthz");
  const agentPlan = await ensureAgentPlan(runtime);
  const state = await api(runtime, "/api/state");
  return {
    baseUrl: runtime.baseUrl,
    health,
    agentPlan,
    sessions: (state.sessions || []).slice(0, clampInt(options.limit, 10, { min: 1, max: 100 })).map((session) => ({
      id: session.id,
      title: session.title,
      webUrl: sessionUrl(runtime.baseUrl, session.id),
      finalVideoUrl: session.finalVideoUrl,
      stitchStatus: session.stitchStatus
    }))
  };
}

async function commandConfigure(config, options) {
  const next = { ...config };
  const baseUrl = flagValue(options, "baseUrl");
  const accessToken = flagValue(options, "accessToken");
  const agentPlanToken = flagValue(options, "agentPlanToken");
  if (baseUrl) next.baseUrl = normalizeBaseUrl(baseUrl);
  if (accessToken) next.accessToken = accessToken;
  if (agentPlanToken) next.agentPlanToken = agentPlanToken;
  if (options.clearAccessToken) delete next.accessToken;
  if (options.clearAgentPlanToken) delete next.agentPlanToken;
  if (options.clearCookies) delete next.cookies;

  const changed =
    baseUrl ||
    accessToken ||
    agentPlanToken ||
    options.clearAccessToken ||
    options.clearAgentPlanToken ||
    options.clearCookies;
  if (changed) await writeConfig(next);

  return {
    configFile: CONFIG_FILE,
    baseUrl: next.baseUrl || DEFAULT_BASE_URL,
    accessTokenConfigured: Boolean(next.accessToken),
    agentPlanTokenConfigured: Boolean(next.agentPlanToken),
    cookieOrigins: Object.keys(next.cookies || {})
  };
}

async function commandSkill(positionals, options) {
  const action = positionals[0] || "install";
  const skillText = await readFile(REELYAI_CLI_SKILL, "utf8");
  if (action === "print" || action === "show") {
    return { action: "skill-print", rawText: skillText, skillPath: REELYAI_CLI_SKILL };
  }
  if (action === "path") {
    return { action: "skill-path", skillPath: REELYAI_CLI_SKILL };
  }
  if (action !== "install") throw new CliError(`Unknown skill action: ${action}`);

  const targets = resolveSkillTargets(options.agent);
  const installed = [];
  for (const target of targets) {
    const dir = path.join(os.homedir(), target.root, "skills", "reelyai-cli");
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, "SKILL.md");
    await writeFile(file, skillText);
    installed.push({ agent: target.name, file });
  }
  return { action: "skill-install", skillPath: REELYAI_CLI_SKILL, installed };
}

function resolveSkillTargets(value) {
  const all = [
    { name: "codex", root: ".codex" },
    { name: "claude", root: ".claude" },
    { name: "cursor", root: ".cursor" },
    { name: "agents", root: ".agents" }
  ];
  const raw = stringOption(value) || "all";
  if (raw === "all") return all;
  const names = raw.split(",").map((item) => item.trim()).filter(Boolean);
  const selected = all.filter((target) => names.includes(target.name));
  const missing = names.filter((name) => !all.some((target) => target.name === name));
  if (missing.length) throw new CliError(`Unknown --agent target: ${missing.join(", ")}`);
  return selected;
}

function flagValue(options, key) {
  const value = options[key];
  if (value === undefined || value === false) return "";
  if (value === true) throw new CliError(`--${key.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`)} requires a value`);
  return String(value).trim();
}

async function commandOpen(runtime, options) {
  const sessionId = await resolveSessionId(runtime, options.session || "latest");
  const webUrl = sessionUrl(runtime.baseUrl, sessionId);
  openUrl(webUrl);
  return { webUrl };
}

function openUrl(url) {
  const command =
    process.platform === "darwin" ? "open" :
    process.platform === "win32" ? "cmd" :
    "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printHuman(result, command) {
  if (result?.rawText) {
    console.log(result.rawText);
    return;
  }
  if (command === "configure") {
    console.log(`Config: ${result.configFile}`);
    console.log(`Base URL: ${result.baseUrl}`);
    console.log(`Access token: ${result.accessTokenConfigured ? "configured" : "not configured"}`);
    console.log(`Agent Plan token: ${result.agentPlanTokenConfigured ? "configured" : "not configured"}`);
    if (result.cookieOrigins.length) console.log(`Cookie origins: ${result.cookieOrigins.join(", ")}`);
    return;
  }
  if (command === "status") {
    console.log(`ReelyAI: ${result.baseUrl}`);
    console.log(`Health: ${result.health?.ok ? "ok" : "unknown"}`);
    console.log(`Agent Plan: ${result.agentPlan?.configured ? `configured (${result.agentPlan.fingerprint})` : "not configured"}`);
    for (const session of result.sessions) {
      console.log(`- ${session.title || session.id} [${session.id}] ${session.webUrl}`);
    }
    return;
  }
  if (result?.kind || result?.action) {
    console.log(`Action: ${result.action || command}`);
    if (result.skillPath) console.log(`Skill: ${result.skillPath}`);
    if (Array.isArray(result.installed)) {
      for (const item of result.installed) console.log(`Installed ${item.agent}: ${item.file}`);
    }
    if (result.kind) console.log(`Node: ${result.kind} ${result.id || ""}`.trim());
    if (result.webUrl) console.log(`Web: ${result.webUrl}`);
    if (result.shot) {
      console.log(`Shot: ${result.shot.index || ""} ${result.shot.title || result.shot.id} - ${result.shot.status || "unknown"}`.trim());
      if (result.shot.videoUrl) console.log(`Video: ${result.shot.videoUrl}`);
      if (result.shot.videoReviewStatus) console.log(`VLM: ${result.shot.videoReviewStatus}`);
    }
    if (result.asset) {
      console.log(`Asset: ${result.asset.name || result.asset.id} - ${result.asset.mediaKind || "unknown"}`);
      if (result.asset.mediaUrl) console.log(`Media: ${result.asset.mediaUrl}`);
      if (result.asset.imageReviewStatus) console.log(`VLM: ${result.asset.imageReviewStatus}`);
    }
    if (result.session) {
      console.log(`Session: ${result.session.title || result.session.id}`);
      if (result.session.finalVideoReviewStatus) console.log(`Final VLM: ${result.session.finalVideoReviewStatus}`);
    }
    if (Array.isArray(result.assets) && result.assets.length) console.log(`Assets: ${result.assets.length}`);
    return;
  }
  console.log(`Session: ${result.title || result.sessionId} [${result.sessionId}]`);
  console.log(`Web: ${result.webUrl}`);
  if (result.story?.premise) console.log(`Premise: ${result.story.premise}`);
  if (result.planSummary) console.log(`Plan: ${result.planSummary}`);
  if (Array.isArray(result.shots) && result.shots.length) {
    console.log("Shots:");
    for (const shot of result.shots) {
      console.log(`  ${shot.index}. ${shot.title || shot.id} - ${shot.status || "draft"}${shot.durationSec ? ` - ${shot.durationSec}s` : ""}`);
    }
  }
  if (result.stitched?.downloadUrl) console.log(`Download: ${result.stitched.downloadUrl}`);
  if (result.render?.stitched?.downloadUrl) console.log(`Download: ${result.render.stitched.downloadUrl}`);
  if (result.failed?.length) console.log(`Failed shots: ${result.failed.map((shot) => shot.id).join(", ")}`);
}

async function main() {
  const { command: rawCommand, positionals, options } = parseArgs(process.argv.slice(2));
  const command = rawCommand === "new" || rawCommand === "create" || rawCommand === "plan" ? "workflow" : rawCommand;
  if (options.help || command === "help" || command === "--help" || command === "-h") {
    console.log(HELP.trim());
    return;
  }

  const config = await readConfig();
  const runtime = resolveRuntime(config, options);
  let result;
  if (command === "configure" || command === "config") {
    result = await commandConfigure(config, options);
  } else if (command === "workflow") {
    result = await commandWorkflow(runtime, positionals, options);
  } else if (command === "node") {
    result = await commandNode(runtime, positionals, options);
  } else if (command === "shot") {
    result = await commandNode(runtime, positionals, options, "shot");
  } else if (command === "asset") {
    result = await commandNode(runtime, positionals, options, "asset");
  } else if (command === "session") {
    result = await commandNode(runtime, positionals, options, "session");
  } else if (command === "publish-storyboards") {
    result = await commandPublishStoryboards(runtime, options);
  } else if (command === "final-review") {
    result = await commandFinalReview(runtime, options);
  } else if (command === "render") {
    result = await commandRender(runtime, options);
  } else if (command === "stitch") {
    const sessionId = await resolveSessionId(runtime, options.session || "latest");
    result = await stitchSession(runtime, sessionId, options);
  } else if (command === "skill") {
    result = await commandSkill(positionals, options);
  } else if (command === "status") {
    result = await commandStatus(runtime, options);
  } else if (command === "open") {
    result = await commandOpen(runtime, options);
  } else {
    throw new CliError(`Unknown command: ${rawCommand}\n\n${HELP.trim()}`);
  }

  if (options.json) console.log(JSON.stringify(result, null, 2));
  else printHuman(result, command);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`reelyai: ${message}`);
  process.exit(error instanceof CliError ? error.code : 1);
});
