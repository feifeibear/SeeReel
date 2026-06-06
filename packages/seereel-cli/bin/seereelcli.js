#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_BASE_URL =
  process.env.SEEREEL_AGENT_BASE_URL ||
  process.env.CINEMA_AGENT_BASE_URL ||
  "https://seereel.studio";

const CONFIG_DIR = process.env.SEEREEL_CLI_HOME || path.join(os.homedir(), ".seereel");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SEEREEL_CLI_SKILL = path.join(PACKAGE_ROOT, "skills", "seereel-cli", "SKILL.md");
const DEFAULT_POLL_INTERVAL_MS = 3000;
const DEFAULT_TIMEOUT_MS = 45 * 60 * 1000;

const HELP = `
SeeReel CLI

Create visible SeeReel canvas workflows from natural language, then let a human
review or take over in the web app.

Usage:
  seereelcli workflow "a 60s cyberpunk short about ..." [options]
  seereelcli node <get|update-prompt|generate|poll|tailframe|review|repair> --id <nodeId> [options]
  seereelcli publish-storyboards --session <sessionId|latest>
  seereelcli final-review --session <sessionId|latest> [--repair]
  seereelcli render --session <sessionId> [options]
  seereelcli stitch --session <sessionId> [options]
  seereelcli download --session <sessionId|latest> --output ./final.mp4
  seereelcli handoff --session <sessionId|latest> [--open]
  seereelcli skill <install|print|path> [options]
  seereelcli status [options]
  seereelcli configure [options]
  seereelcli open --session <sessionId> [options]

Aliases:
  workflow: new, create, plan

Global options:
  --base-url <url>              SeeReel server. Default: env or https://seereel.studio
  --access-token <token>        Shared deployment token, also read from SEEREEL_ACCESS_TOKEN
  --api-key <key>               Standard Ark API key, also read from BP_ARK_API_KEY / BP_SEEDANCE_API_KEY / CN_ARK_API_KEY / CN_SEEDANCE_API_KEY
  --api-key-route <route>       Standard API route: byteplus or volcengine-cn. Default: byteplus
  --agent-plan-token <token>    Browser-scoped Agent Plan key for model generation
  --json                        Print machine-readable JSON
  --jsonl                       Print newline-delimited progress events; final result is a complete event
  --progress                    Print human-readable progress events to stderr

workflow options:
  --title <title>               Session title
  --duration <sec>              Target duration. Default: 60
  --shots <count>               Shot count. Default: ceil(duration / 15)
  --style <text>                Visual style
  --language <zh|en>            Session UI/script language. Default: zh
  --cloud-only                  Treat local files as user input only; generate intermediates through SeeReel server APIs
  --reference-image <path|url>  Upload a user reference image into the session before planning/rendering
  --reference-name <text>       Display name for --reference-image
  --generate-storyboards        Generate server-side sub-storyboard assets before rendering
  --no-script                   Skip /script/generate
  --no-storyboard               Skip /storyboard
  --render                      Continue into shot generation after storyboard
  --stitch                      Stitch after render, or after storyboard if shots are ready
  --stitch-partial              Stitch ready shots even when some shots failed or were skipped
  --output <path>               After --stitch, download the final cloud video to this local path
  --open                        Open the created session in the browser

render options:
  --session <sessionId|latest>  Session to render. Default: latest
  --mode <missing|all>          Workflow plan mode. Default: missing
  --max-parallel-shots <n>      Max parallel independent shots. Default: 1
  --stitch                      Stitch after shots are ready
  --stitch-partial              Stitch ready shots even when some shots failed or were skipped
  --repair-policy <none|safe-retry>
                                Retry policy failures with a safer prompt. Default: none
  --max-attempts <n>            Max attempts per shot when --repair-policy safe-retry is set. Default: 1

status options:
  --session <sessionId|latest>  Show one session. Use with --deep for shot/render details
  --deep                        Include shots, renders, errors, stitch state, and download URL

download options:
  --session <sessionId|latest>  Session to download. Default: latest
  --output <path>               Local output file. Default: ./seereel-<sessionId>.mp4

handoff options:
  --session <sessionId|latest>  Session to transfer to the current browser user. Default: latest
  --open                        Open the one-time handoff link in the browser

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
                                Install bundled seereel-cli skill. Default: all

Examples:
  npm install -g seereelcli
  seereelcli skill install --agent all
  seereelcli configure --base-url https://seereel.studio --access-token "$SEEREEL_ACCESS_TOKEN"
  seereelcli workflow "一个失眠导演在午夜便利店遇见未来的自己" --duration 60 --style "neo-noir, rain"
  seereelcli workflow "上海航拍" --cloud-only --reference-image ./route.png --duration 30 --render --stitch --output ./final.mp4
  seereelcli node update-prompt --id shot_xxx --prompt "new Seedance prompt"
  seereelcli node tailframe --id shot_xxx --publish-tos --canvas-node
  seereelcli node review --id shot_xxx --frame-count 8
  seereelcli render --session latest --stitch --progress
  seereelcli status --session latest --deep --json
  seereelcli download --session latest --output ./final.mp4
  seereelcli handoff --session latest --open
`;

class CliError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.name = "CliError";
    this.code = code;
  }
}

function createReporter(options) {
  const jsonl = Boolean(options.jsonl);
  const progress = Boolean(options.progress);
  return {
    event(event, payload = {}) {
      if (!jsonl && !progress) return;
      const line = { event, at: new Date().toISOString(), ...payload };
      if (jsonl) console.log(JSON.stringify(line));
      if (progress) console.error(formatProgressLine(line));
    },
    complete(result) {
      if (jsonl) this.event("complete", { result });
    }
  };
}

function formatProgressLine(event) {
  const parts = [event.event];
  if (event.sessionId) parts.push(`session=${event.sessionId}`);
  if (event.shotId) parts.push(`shot=${event.shotId}`);
  if (event.index !== undefined) parts.push(`index=${event.index}`);
  if (event.status) parts.push(`status=${event.status}`);
  if (event.taskId) parts.push(`task=${event.taskId}`);
  if (event.attempt !== undefined) parts.push(`attempt=${event.attempt}`);
  if (event.reason) parts.push(`reason=${event.reason}`);
  return `[seereelcli] ${parts.join(" ")}`;
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
    String(options.baseUrl || process.env.SEEREEL_AGENT_BASE_URL || process.env.CINEMA_AGENT_BASE_URL || config.baseUrl || DEFAULT_BASE_URL)
  );
  const bpApiKey = process.env.BP_ARK_API_KEY || process.env.BP_SEEDANCE_API_KEY || "";
  const cnApiKey = process.env.CN_ARK_API_KEY || process.env.CN_SEEDANCE_API_KEY || "";
  const apiKey =
    stringOption(options.apiKey) ||
    bpApiKey ||
    cnApiKey ||
    config.apiKey ||
    "";
  const apiKeyRoute = normalizeApiKeyRoute(
    stringOption(options.apiKeyRoute) ||
    process.env.SEEREEL_API_KEY_ROUTE ||
    process.env.SEEDANCE_API_KEY_ROUTE ||
    config.apiKeyRoute ||
    (bpApiKey ? "byteplus" : cnApiKey ? "volcengine-cn" : "")
  );
  return {
    baseUrl,
    accessToken:
      stringOption(options.accessToken) ||
      process.env.SEEREEL_ACCESS_TOKEN ||
      process.env.SEEREEL_CLI_ACCESS_TOKEN ||
      config.accessToken ||
      "",
    apiKey,
    apiKeyRoute,
    agentPlanToken:
      stringOption(options.agentPlanToken) ||
      process.env.SEEREEL_AGENT_PLAN_TOKEN ||
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
    ...(runtime.accessToken ? { "x-seereel-access": runtime.accessToken } : {}),
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
      throw new CliError(`${message}. Pass --access-token or set SEEREEL_ACCESS_TOKEN.`);
    }
    throw new CliError(`${route} failed: ${message}`);
  }
  return body;
}

async function rawApi(runtime, route, body, init = {}) {
  const headers = {
    Accept: "application/json",
    ...(runtime.accessToken ? { "x-seereel-access": runtime.accessToken } : {}),
    ...(cookieHeader(runtime) ? { Cookie: cookieHeader(runtime) } : {}),
    ...(init.headers || {})
  };
  const res = await fetch(`${runtime.baseUrl}${route}`, { ...init, body, headers });
  const changedCookies = rememberCookies(runtime, res.headers);
  if (changedCookies) {
    const config = await readConfig();
    config.cookies = runtime.cookies;
    await writeConfig(config);
  }

  const text = await res.text();
  let parsed = text;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    // Keep plain text.
  }
  if (!res.ok) {
    const message = parsed?.error || parsed?.message || text || `${res.status} ${res.statusText}`;
    throw new CliError(`${route} failed: ${message}`);
  }
  return parsed;
}

async function downloadToFile(runtime, route, outputPath) {
  const headers = {
    ...(runtime.accessToken ? { "x-seereel-access": runtime.accessToken } : {}),
    ...(cookieHeader(runtime) ? { Cookie: cookieHeader(runtime) } : {})
  };
  const res = await fetch(`${runtime.baseUrl}${route}`, { headers });
  const changedCookies = rememberCookies(runtime, res.headers);
  if (changedCookies) {
    const config = await readConfig();
    config.cookies = runtime.cookies;
    await writeConfig(config);
  }
  if (!res.ok) {
    const text = await res.text();
    throw new CliError(`${route} download failed: ${text || `${res.status} ${res.statusText}`}`);
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, bytes);
  return { bytes: bytes.length };
}

async function ensureAgentPlan(runtime, options = {}) {
  const status = await api(runtime, "/api/credentials/agent-plan");
  if (status?.configured) return status;
  if (runtime.agentPlanToken) {
    const configured = await api(runtime, "/api/credentials/agent-plan", {
      method: "POST",
      body: JSON.stringify({ apiKey: runtime.agentPlanToken })
    });
    options.reporter?.event("agent_plan_configured", { fingerprint: configured?.fingerprint });
    return configured;
  }
  if (options.required) {
    throw new CliError(
      "Agent Plan token is not configured for this CLI/browser scope. Run `seereelcli configure --agent-plan-token \"<AGENT_PLAN_API_KEY>\"`, or set SEEREEL_AGENT_PLAN_TOKEN / ARK_AGENT_PLAN_KEY before render/review commands."
    );
  }
  return status;
}

async function ensureModelCredential(runtime, options = {}) {
  const apiKeyStatus = await api(runtime, "/api/credentials/api-key");
  if (apiKeyStatus?.configured) return { source: "standard", apiKey: apiKeyStatus };
  if (runtime.apiKey) {
    const configured = await api(runtime, "/api/credentials/api-key", {
      method: "POST",
      body: JSON.stringify({ apiKey: runtime.apiKey, route: runtime.apiKeyRoute })
    });
    options.reporter?.event("api_key_configured", { fingerprint: configured?.fingerprint });
    return { source: "standard", apiKey: configured };
  }

  const agentPlan = await ensureAgentPlan(runtime, options);
  if (agentPlan?.configured) return { source: "agent-plan", agentPlan };
  if (options.required) {
    throw new CliError(
      "API Keys are not configured for this CLI/browser scope. Prefer `seereelcli configure --api-key \"<BP_ARK_API_KEY>\"`; or use `--agent-plan-token \"<AGENT_PLAN_API_KEY>\"` / SEEREEL_AGENT_PLAN_TOKEN."
    );
  }
  return { source: "missing", agentPlan };
}

function sessionUrl(baseUrl, sessionId) {
  return `${baseUrl}/canvas/${encodeURIComponent(sessionId)}`;
}

function downloadUrl(baseUrl, sessionId) {
  return `${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/download`;
}

function handoffUrl(baseUrl, token) {
  return `${baseUrl}/api/handoff/${encodeURIComponent(token)}`;
}

async function createSessionHandoff(runtime, sessionId) {
  const handoff = await api(runtime, `/api/sessions/${encodeURIComponent(sessionId)}/handoff`, { method: "POST" });
  if (handoff?.handoffToken) {
    return { ...handoff, handoffUrl: handoffUrl(runtime.baseUrl, handoff.handoffToken) };
  }
  return handoff;
}

function clampInt(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function inferTitle(prompt, explicit) {
  if (explicit) return explicit;
  const compact = prompt.replace(/\s+/g, " ").trim();
  return compact.slice(0, 28) || "SeeReel Workflow";
}

async function readPrompt(positionals) {
  const prompt = positionals.join(" ").trim();
  if (prompt) return prompt;
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString("utf8").trim();
  }
  throw new CliError("Missing natural-language prompt. Example: seereelcli workflow \"a 60s short...\"");
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

function summarizeCloudOnlyArtifact(artifact) {
  if (!artifact) return undefined;
  return {
    id: artifact.id,
    name: artifact.name,
    mediaKind: artifact.mediaKind,
    mediaUrl: artifact.mediaUrl,
    ownerSessionId: artifact.ownerSessionId,
    ownerShotId: artifact.ownerShotId
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

function summarizeRender(render) {
  if (!render) return undefined;
  return {
    id: render.id,
    status: render.status,
    seedancePhase: render.seedancePhase,
    generationTaskId: render.generationTaskId,
    taskAgeSec: ageSec(render.generationStartedAt),
    durationSec: render.durationSec,
    videoUrl: render.videoUrl,
    remoteVideoUrl: render.remoteVideoUrl,
    error: render.error,
    model: render.model,
    createdAt: render.createdAt,
    generationStartedAt: render.generationStartedAt,
    videoGeneratedAt: render.videoGeneratedAt
  };
}

function summarizeDeepShot(shot) {
  const selectedRender = Array.isArray(shot.renders) ? shot.renders[0] : undefined;
  return {
    ...summarizeShot(shot),
    seedancePhase: shot.seedancePhase,
    generationTaskId: shot.generationTaskId || selectedRender?.generationTaskId,
    taskAgeSec: ageSec(shot.generationStartedAt || selectedRender?.generationStartedAt),
    error: shot.error || selectedRender?.error,
    selectedRenderId: selectedRender?.id,
    renderCount: Array.isArray(shot.renders) ? shot.renders.length : 0,
    renders: (shot.renders || []).map(summarizeRender)
  };
}

function summarizeDeepSession(runtime, session, state) {
  const shots = (state.shots || [])
    .filter((shot) => shot.sessionId === session.id)
    .sort((a, b) => (a.index || 0) - (b.index || 0));
  const readyShots = shots.filter((shot) => Boolean(shot.videoUrl));
  const failedShots = shots.filter((shot) => shot.status === "error" || shot.status === "cancelled" || !shot.videoUrl);
  return {
    id: session.id,
    title: session.title,
    webUrl: sessionUrl(runtime.baseUrl, session.id),
    finalVideoUrl: session.finalVideoUrl,
    downloadUrl: session.finalVideoUrl ? downloadUrl(runtime.baseUrl, session.id) : undefined,
    stitchStatus: session.stitchStatus,
    stitchProgress: session.stitchProgress,
    stitchError: session.stitchError,
    stitchShotIds: session.stitchShotIds,
    finalVideoReviewStatus: session.finalVideoReviewStatus,
    finalVideoReview: session.finalVideoReview,
    readyShotCount: readyShots.length,
    failedShotCount: failedShots.length,
    skippedShots: summarizeShots(failedShots),
    stitchJobs: session.stitchJobs || [],
    shots: shots.map(summarizeDeepShot)
  };
}

function ageSec(value) {
  if (!value) return undefined;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return undefined;
  return Math.max(0, Math.round((Date.now() - time) / 1000));
}

async function commandWorkflow(runtime, positionals, options) {
  await api(runtime, "/api/healthz");
  const credential = await ensureModelCredential(runtime, { required: Boolean(options.render || options.generateStoryboards), reporter: options.reporter });
  const prompt = await readPrompt(positionals);
  const duration = clampInt(options.duration, 60, { min: 1, max: 3600 });
  const shotCount = clampInt(options.shots, Math.ceil(duration / 15), { min: 1, max: 120 });
  const title = inferTitle(prompt, stringOption(options.title));
  const style = stringOption(options.style) || "cinematic short drama, coherent multi-shot continuity";
  const language = options.language === "en" ? "en" : "zh";
  const cloudOnly = Boolean(options.cloudOnly);
  if (cloudOnly && options.storyboard === false) {
    throw new CliError("--cloud-only requires the server storyboard planning step; remove --no-storyboard.");
  }
  if (stringOption(options.output) && !options.stitch) {
    throw new CliError("--output requires --stitch so the final cloud video exists before download.");
  }

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
  options.reporter?.event("session_created", { sessionId: session.id, title });

  let currentSession = session;
  const referenceAssets = [];
  if (options.referenceImage) {
    const asset = await uploadReferenceImage(runtime, session.id, options.referenceImage, {
      name: stringOption(options.referenceName)
    });
    referenceAssets.push(asset);
    options.reporter?.event("reference_uploaded", { sessionId: session.id, assetId: asset.id, source: cloudOnly ? "user-input" : "reference-image" });
  }
  let storyboard;
  if (options.script !== false) {
    options.reporter?.event("script_generating", { sessionId: session.id });
    currentSession = await api(runtime, `/api/sessions/${session.id}/script/generate`, { method: "POST" });
    options.reporter?.event("script_ready", { sessionId: session.id });
  }
  if (options.storyboard !== false) {
    options.reporter?.event("storyboard_generating", { sessionId: session.id });
    storyboard = await api(runtime, `/api/sessions/${session.id}/storyboard`, { method: "POST" });
    currentSession = storyboard.session || currentSession;
    options.reporter?.event("storyboard_ready", { sessionId: session.id, shotCount: (storyboard?.shots || currentSession.shots || []).length });
  }
  if (referenceAssets.length) {
    currentSession = await attachReferenceAssetsToSessionShots(runtime, session.id, referenceAssets.map((asset) => asset.id));
    options.reporter?.event("reference_attached", { sessionId: session.id, assetIds: referenceAssets.map((asset) => asset.id) });
  }

  const shouldGenerateStoryboards = Boolean(options.generateStoryboards) || (cloudOnly && Boolean(options.render));
  let storyboardAssets = [];
  if (shouldGenerateStoryboards) {
    storyboardAssets = await generateServerStoryboards(runtime, session.id, {
      panelCount: options.storyboardPanels,
      model: stringOption(options.storyboardModel),
      reporter: options.reporter
    });
    options.reporter?.event("server_storyboards_ready", { sessionId: session.id, assetCount: storyboardAssets.length });
  }

  let renderResult;
  if (options.render) {
    renderResult = await renderSession(runtime, session.id, {
      mode: "missing",
      maxParallelShots: clampInt(options.maxParallelShots, 1, { min: 1, max: 8 }),
      stitch: Boolean(options.stitch),
      stitchPartial: Boolean(options.stitchPartial),
      repairPolicy: normalizeRepairPolicy(options.repairPolicy),
      maxAttempts: clampInt(options.maxAttempts, 1, { min: 1, max: 5 }),
      timeoutMs: clampInt(options.timeoutMs, DEFAULT_TIMEOUT_MS, { min: 10_000 }),
      pollIntervalMs: clampInt(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS, { min: 1000 }),
      reporter: options.reporter
    });
  } else if (options.stitch) {
    renderResult = { stitched: await stitchSession(runtime, session.id, options) };
  }
  let downloadResult;
  if (stringOption(options.output)) {
    const output = path.resolve(stringOption(options.output));
    const result = await downloadToFile(runtime, `/api/sessions/${session.id}/download`, output);
    downloadResult = {
      action: "download",
      sessionId: session.id,
      output,
      bytes: result.bytes,
      webUrl: sessionUrl(runtime.baseUrl, session.id)
    };
    options.reporter?.event("final_downloaded", { sessionId: session.id, output, bytes: result.bytes });
  }

  const handoff = await createSessionHandoff(runtime, session.id);
  const result = {
    baseUrl: runtime.baseUrl,
    sessionId: session.id,
    title: currentSession.title || title,
    webUrl: sessionUrl(runtime.baseUrl, session.id),
    webUrlVisibleInBrowser: false,
    handoffUrl: handoff.handoffUrl,
    handoffExpiresAt: handoff.handoffExpiresAt,
    cloudOnly,
    credential,
    agentPlan: credential.agentPlan,
    referenceAssets: referenceAssets.map(summarizeCloudOnlyArtifact),
    storyboardAssets: storyboardAssets.map(summarizeCloudOnlyArtifact),
    story: currentSession.story,
    shots: summarizeShots(storyboard?.shots || currentSession.shots || session.shots || []),
    render: renderResult,
    download: downloadResult
  };

  if (options.open) openUrl(result.handoffUrl || result.webUrl);
  return result;
}

async function uploadReferenceImage(runtime, sessionId, source, options = {}) {
  const value = String(source || "").trim();
  if (!value) throw new CliError("--reference-image requires a local path or http(s) URL.");
  const name = stringOption(options.name) || inferReferenceName(value);
  if (/^https?:\/\//i.test(value)) {
    return api(runtime, "/api/assets", {
      method: "POST",
      body: JSON.stringify({
        ownerSessionId: sessionId,
        type: "scene",
        mediaKind: "image",
        name,
        description: "User-provided cloud reference image for this SeeReel workflow.",
        prompt: "",
        mediaUrl: value,
        imageUrl: value,
        referenceImageUrl: value,
        tags: ["reference-image", "user-input", "cloud-only"]
      })
    });
  }

  const filePath = path.resolve(value);
  const bytes = await readFile(filePath);
  const params = new URLSearchParams({
    ownerSessionId: sessionId,
    filename: path.basename(filePath),
    name,
    tags: "reference-image,user-input,cloud-only"
  });
  return rawApi(runtime, `/api/assets/upload-image?${params.toString()}`, bytes, {
    method: "POST",
    headers: { "Content-Type": contentTypeForImage(filePath) }
  });
}

function inferReferenceName(value) {
  try {
    const parsed = new URL(value);
    const tail = path.basename(parsed.pathname || "reference-image");
    return tail.replace(/\.[^.]+$/, "") || "Reference image";
  } catch {
    return path.basename(value).replace(/\.[^.]+$/, "") || "Reference image";
  }
}

function contentTypeForImage(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "image/jpeg";
}

async function attachReferenceAssetsToSessionShots(runtime, sessionId, assetIds) {
  const state = await api(runtime, "/api/state");
  const shots = (state.shots || []).filter((shot) => shot.sessionId === sessionId);
  let latestSession = (state.sessions || []).find((session) => session.id === sessionId);
  for (const shot of shots) {
    const nextAssetIds = Array.from(new Set([...(shot.assetIds || []), ...assetIds]));
    await api(runtime, `/api/shots/${shot.id}`, {
      method: "PATCH",
      body: JSON.stringify({ assetIds: nextAssetIds })
    });
  }
  const refreshed = await api(runtime, "/api/state");
  latestSession = (refreshed.sessions || []).find((session) => session.id === sessionId) || latestSession;
  return latestSession;
}

async function generateServerStoryboards(runtime, sessionId, options = {}) {
  const state = await api(runtime, "/api/state");
  const shots = (state.shots || [])
    .filter((shot) => shot.sessionId === sessionId)
    .sort((a, b) => (a.index || 0) - (b.index || 0));
  const assets = [];
  for (const shot of shots) {
    const scenePrompt = buildSubStoryboardScenePrompt(shot);
    if (!scenePrompt) continue;
    options.reporter?.event("server_storyboard_started", { sessionId, shotId: shot.id, index: shot.index });
    const body = {
      scenePrompt,
      panelCount: clampInt(options.panelCount, 4, { min: 2, max: 16 }),
      referenceAssetIds: shot.assetIds || []
    };
    if (options.model) body.model = options.model;
    const result = await api(runtime, `/api/shots/${shot.id}/sub-storyboard`, {
      method: "POST",
      body: JSON.stringify(body)
    });
    if (result?.asset) assets.push(result.asset);
    options.reporter?.event("server_storyboard_ready", { sessionId, shotId: shot.id, index: shot.index, assetId: result?.asset?.id });
  }
  return assets;
}

function buildSubStoryboardScenePrompt(shot) {
  return [
    shot.title ? `Shot title: ${shot.title}` : "",
    shot.script ? `Story action: ${shot.script}` : "",
    shot.camera ? `Camera: ${shot.camera}` : "",
    shot.rawPrompt || shot.prompt ? `Video prompt: ${shot.rawPrompt || shot.prompt}` : ""
  ].filter(Boolean).join("\n").trim();
}

async function commandRender(runtime, options) {
  await api(runtime, "/api/healthz");
  await ensureModelCredential(runtime, { required: true, reporter: options.reporter });
  const sessionId = await resolveSessionId(runtime, options.session || "latest");
  return renderSession(runtime, sessionId, {
    mode: options.mode === "all" ? "all" : "missing",
    maxParallelShots: clampInt(options.maxParallelShots, 1, { min: 1, max: 8 }),
    stitch: Boolean(options.stitch),
    stitchPartial: Boolean(options.stitchPartial),
    repairPolicy: normalizeRepairPolicy(options.repairPolicy),
    maxAttempts: clampInt(options.maxAttempts, 1, { min: 1, max: 5 }),
    timeoutMs: clampInt(options.timeoutMs, DEFAULT_TIMEOUT_MS, { min: 10_000 }),
    pollIntervalMs: clampInt(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS, { min: 1000 }),
    reporter: options.reporter
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
    await ensureModelCredential(runtime, { required: true, reporter: options.reporter });
    if (node.kind === "shot") {
      options.reporter?.event("shot_submitted", { shotId: node.id, index: node.value.index, attempt: 1 });
      const generated = await api(runtime, `/api/shots/${node.id}/generate`, { method: "POST" });
      reportShotTask(options.reporter, "task_id", generated);
      if (!options.wait) return nodeResult(runtime, { kind: "shot", id: generated.id, value: generated }, { action: "generate" });
      const rendered = await waitForShot(runtime, node.id, {
        timeoutMs: clampInt(options.timeoutMs, DEFAULT_TIMEOUT_MS, { min: 10_000 }),
        pollIntervalMs: clampInt(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS, { min: 1000 }),
        reporter: options.reporter
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
    await ensureModelCredential(runtime, { required: true, reporter: options.reporter });
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
    await ensureModelCredential(runtime, { required: true, reporter: options.reporter });
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
  await ensureModelCredential(runtime, { required: true, reporter: options.reporter });
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
  options.reporter?.event("render_plan_requested", { sessionId, mode: options.mode });
  const plan = await api(runtime, `/api/sessions/${sessionId}/workflow/plan`, {
    method: "POST",
    body: JSON.stringify({ mode: options.mode, maxParallelShots: options.maxParallelShots })
  });
  options.reporter?.event("render_plan_ready", { sessionId, summary: plan.summary, layerCount: (plan.layers || []).length });
  const layerResults = [];
  for (let layerIndex = 0; layerIndex < (plan.layers || []).length; layerIndex += 1) {
    const layer = plan.layers[layerIndex];
    options.reporter?.event("render_layer_started", { sessionId, layerIndex, shotCount: layer.length });
    const rendered = await Promise.all(layer.map((item) => renderShot(runtime, item, options)));
    layerResults.push(rendered);
    options.reporter?.event("render_layer_finished", { sessionId, layerIndex });
  }
  const state = await api(runtime, "/api/state");
  const shots = state.shots?.filter((shot) => shot.sessionId === sessionId) || [];
  const failed = shots.filter((shot) => shot.status === "error" || shot.status === "cancelled" || !shot.videoUrl);
  const ready = shots.filter((shot) => shot.videoUrl);
  let stitched;
  if (options.stitch && (failed.length === 0 || options.stitchPartial) && ready.length > 0) {
    stitched = await stitchSession(runtime, sessionId, options);
  } else if (options.stitch && failed.length > 0) {
    options.reporter?.event("stitch_skipped", {
      sessionId,
      reason: "failed_or_missing_shots",
      skippedShotIds: failed.map((shot) => shot.id)
    });
  }
  return {
    baseUrl: runtime.baseUrl,
    sessionId,
    webUrl: sessionUrl(runtime.baseUrl, sessionId),
    planSummary: plan.summary,
    layers: layerResults,
    shots: summarizeShots(shots),
    failed: summarizeShots(failed),
    skippedShots: summarizeShots(failed),
    stitched
  };
}

async function renderShot(runtime, item, options) {
  const shotId = item.shotId || item.id;
  if (!shotId) throw new CliError(`Workflow item is missing shot id: ${JSON.stringify(item)}`);
  const maxAttempts = options.repairPolicy === "safe-retry" ? Math.max(1, options.maxAttempts || 1) : 1;
  let lastResult;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (item.index > 1 && item.action !== "skip") {
      await api(runtime, `/api/shots/${shotId}`, {
        method: "PATCH",
        body: JSON.stringify({ usePreviousShotClip: true, previousShotClipSec: 2 })
      });
    }
    options.reporter?.event("shot_submitted", { shotId, index: item.index, attempt });
    const submitted = await api(runtime, `/api/shots/${shotId}/generate`, { method: "POST" });
    reportShotTask(options.reporter, "task_id", submitted, { attempt });
    let rendered;
    try {
      rendered = await waitForShot(runtime, shotId, options);
    } catch (error) {
      if (attempt >= maxAttempts || options.repairPolicy !== "safe-retry") throw error;
      const state = await api(runtime, "/api/state");
      const current = (state.shots || []).find((shot) => shot.id === shotId) || submitted;
      const patch = buildSafeRetryPatch(current);
      options.reporter?.event("retrying", {
        shotId,
        index: current.index || item.index,
        attempt: attempt + 1,
        reason: error instanceof Error ? error.message : String(error),
        durationSec: patch.durationSec
      });
      await api(runtime, `/api/shots/${shotId}/cancel`, { method: "POST" }).catch(() => undefined);
      await api(runtime, `/api/shots/${shotId}`, { method: "PATCH", body: JSON.stringify(patch) });
      continue;
    }
    lastResult = rendered;
    if (rendered.status !== "error" && rendered.status !== "cancelled") return rendered;
    if (attempt >= maxAttempts || !isSafeRetryableShotError(rendered.error)) return rendered;
    const patch = buildSafeRetryPatch(rendered);
    options.reporter?.event("retrying", {
      shotId,
      index: rendered.index,
      attempt: attempt + 1,
      reason: rendered.error,
      durationSec: patch.durationSec
    });
    await api(runtime, `/api/shots/${shotId}/cancel`, { method: "POST" }).catch(() => undefined);
    await api(runtime, `/api/shots/${shotId}`, {
      method: "PATCH",
      body: JSON.stringify(patch)
    });
  }
  return lastResult;
}

async function waitForShot(runtime, shotId, options) {
  const started = Date.now();
  let snapshot;
  while (Date.now() - started < options.timeoutMs) {
    snapshot = await api(runtime, `/api/shots/${shotId}/poll`, { method: "POST" });
    options.reporter?.event("poll_status", {
      shotId,
      index: snapshot.index,
      status: snapshot.status,
      phase: snapshot.seedancePhase,
      taskId: snapshot.generationTaskId || latestRender(snapshot)?.generationTaskId,
      elapsedSec: Math.round((Date.now() - started) / 1000)
    });
    if (["ready", "error", "cancelled"].includes(snapshot.status)) {
      return {
        id: snapshot.id,
        sessionId: snapshot.sessionId,
        index: snapshot.index,
        title: snapshot.title,
        durationSec: snapshot.durationSec,
        status: snapshot.status,
        videoUrl: snapshot.videoUrl,
        error: snapshot.error || latestRender(snapshot)?.error,
        rawPrompt: snapshot.rawPrompt,
        prompt: snapshot.prompt
      };
    }
    await sleep(options.pollIntervalMs);
  }
  await api(runtime, `/api/shots/${shotId}/cancel`, { method: "POST" }).catch(() => undefined);
  throw new CliError(`Timed out waiting for shot ${shotId}`);
}

function latestRender(shot) {
  return Array.isArray(shot?.renders) ? shot.renders[0] : undefined;
}

function reportShotTask(reporter, event, shot, extra = {}) {
  const render = latestRender(shot);
  const taskId = shot?.generationTaskId || render?.generationTaskId;
  if (!taskId) return;
  reporter?.event(event, {
    shotId: shot.id,
    index: shot.index,
    taskId,
    status: shot.status,
    ...extra
  });
}

function normalizeRepairPolicy(value) {
  const raw = stringOption(value) || "none";
  if (raw === "none" || raw === "safe-retry") return raw;
  throw new CliError(`Unknown --repair-policy: ${raw}. Expected none or safe-retry.`);
}

function isSafeRetryableShotError(error) {
  const text = String(error || "");
  return /SensitiveContent|PolicyViolation|content.*policy|sensitive|risk|violation|审核|敏感|安全|策略/i.test(text);
}

function buildSafeRetryPatch(shot) {
  const original = shot.rawPrompt || shot.prompt || "";
  const prompt = safeRetryPrompt(original);
  const currentDuration = Number(shot.durationSec) || 15;
  return {
    rawPrompt: prompt,
    prompt,
    durationSec: Math.max(3, Math.min(8, currentDuration > 8 ? 8 : currentDuration))
  };
}

function safeRetryPrompt(prompt) {
  const replacements = [
    [/台北\s*101|taipei\s*101/gi, "一座虚构现代城市地标高楼"],
    [/纽约|new\s*york|东京|tokyo|巴黎|paris|北京|beijing|上海|shanghai|台北|taipei/gi, "虚构现代城市"],
    [/apple|iphone|tesla|bytedance|tiktok|douyin|volcengine|openai|google|microsoft|meta|nvidia/gi, "虚构科技品牌"],
    [/苹果|特斯拉|字节跳动|抖音|火山引擎|谷歌|微软|英伟达/gi, "虚构科技品牌"],
    [/logo|商标|品牌标识/gi, "无可识别品牌标识"]
  ];
  let next = prompt;
  for (const [pattern, replacement] of replacements) next = next.replace(pattern, replacement);
  const safety = "安全重试约束：使用虚构地点、虚构建筑和虚构品牌；不要出现真实品牌、真实地名、可识别商标、政治符号、血腥暴力、危险行为或敏感标识；保持电影感和原镜头意图。";
  return next.includes("安全重试约束") ? next : `${next.trim()}\n${safety}`;
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
  const beforeState = await api(runtime, "/api/state");
  const sessionShots = (beforeState.shots || []).filter((shot) => shot.sessionId === sessionId);
  const skippedShots = sessionShots.filter((shot) => !shot.videoUrl);
  options.reporter?.event("stitch_started", {
    sessionId,
    readyShotCount: sessionShots.length - skippedShots.length,
    skippedShotIds: skippedShots.map((shot) => shot.id)
  });
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
    options.reporter?.event("stitch_poll", {
      sessionId,
      status: session.stitchStatus,
      progress: session.stitchProgress
    });
  }
  options.reporter?.event("stitch_ready", {
    sessionId,
    status: session.stitchStatus,
    finalVideoUrl: session.finalVideoUrl,
    downloadUrl: session.finalVideoUrl ? downloadUrl(runtime.baseUrl, sessionId) : undefined
  });
  return {
    sessionId,
    status: session.stitchStatus,
    progress: session.stitchProgress,
    error: session.stitchError,
    finalVideoUrl: session.finalVideoUrl,
    webUrl: sessionUrl(runtime.baseUrl, sessionId),
    downloadUrl: session.finalVideoUrl ? downloadUrl(runtime.baseUrl, sessionId) : undefined,
    skippedShots: summarizeShots(skippedShots)
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
  const credential = await ensureModelCredential(runtime, { reporter: options.reporter });
  const state = await api(runtime, "/api/state");
  const limit = clampInt(options.limit, 10, { min: 1, max: 100 });
  const sessions = (state.sessions || []).slice(0, limit);
  const sessionId = options.deep || options.session ? await resolveSessionIdFromState(runtime, state, options.session || "latest") : undefined;
  const session = sessionId ? (state.sessions || []).find((item) => item.id === sessionId) : undefined;
  return {
    action: "status",
    baseUrl: runtime.baseUrl,
    health,
    credential,
    apiKey: credential.apiKey,
    agentPlan: credential.agentPlan,
    deep: Boolean(options.deep),
    session: session && options.deep ? summarizeDeepSession(runtime, session, state) : undefined,
    sessions: sessions.map((session) => ({
      id: session.id,
      title: session.title,
      webUrl: sessionUrl(runtime.baseUrl, session.id),
      finalVideoUrl: session.finalVideoUrl,
      downloadUrl: session.finalVideoUrl ? downloadUrl(runtime.baseUrl, session.id) : undefined,
      stitchStatus: session.stitchStatus,
      readyShotCount: (state.shots || []).filter((shot) => shot.sessionId === session.id && shot.videoUrl).length,
      failedShotCount: (state.shots || []).filter((shot) => shot.sessionId === session.id && (shot.status === "error" || shot.status === "cancelled")).length
    }))
  };
}

async function commandDownload(runtime, options) {
  await api(runtime, "/api/healthz");
  const sessionId = await resolveSessionId(runtime, options.session || "latest");
  const output = path.resolve(stringOption(options.output) || `seereel-${sessionId}.mp4`);
  const result = await downloadToFile(runtime, `/api/sessions/${sessionId}/download`, output);
  return {
    action: "download",
    sessionId,
    output,
    bytes: result.bytes,
    webUrl: sessionUrl(runtime.baseUrl, sessionId)
  };
}

async function resolveSessionIdFromState(runtime, state, value) {
  if (value && value !== true && value !== "latest") return String(value);
  const latest = state.sessions?.[0];
  if (!latest) return undefined;
  return latest.id;
}

async function commandConfigure(config, options) {
  const next = { ...config };
  const baseUrl = flagValue(options, "baseUrl");
  const accessToken = flagValue(options, "accessToken");
  const apiKey = flagValue(options, "apiKey");
  const apiKeyRoute = flagValue(options, "apiKeyRoute");
  const agentPlanToken = flagValue(options, "agentPlanToken");
  if (baseUrl) next.baseUrl = normalizeBaseUrl(baseUrl);
  if (accessToken) next.accessToken = accessToken;
  if (apiKey) next.apiKey = apiKey;
  if (apiKeyRoute) next.apiKeyRoute = normalizeApiKeyRoute(apiKeyRoute);
  if (agentPlanToken) next.agentPlanToken = agentPlanToken;
  if (options.clearAccessToken) delete next.accessToken;
  if (options.clearApiKey) delete next.apiKey;
  if (options.clearAgentPlanToken) delete next.agentPlanToken;
  if (options.clearCookies) delete next.cookies;

  const changed =
    baseUrl ||
    accessToken ||
    apiKey ||
    apiKeyRoute ||
    agentPlanToken ||
    options.clearAccessToken ||
    options.clearApiKey ||
    options.clearAgentPlanToken ||
    options.clearCookies;
  if (changed) await writeConfig(next);

  return {
    configFile: CONFIG_FILE,
    baseUrl: next.baseUrl || DEFAULT_BASE_URL,
    accessTokenConfigured: Boolean(next.accessToken),
    apiKeyConfigured: Boolean(next.apiKey),
    apiKeyRoute: normalizeApiKeyRoute(next.apiKeyRoute),
    agentPlanTokenConfigured: Boolean(next.agentPlanToken),
    cookieOrigins: Object.keys(next.cookies || {})
  };
}

async function commandSkill(positionals, options) {
  const action = positionals[0] || "install";
  const skillText = await readFile(SEEREEL_CLI_SKILL, "utf8");
  if (action === "print" || action === "show") {
    return { action: "skill-print", rawText: skillText, skillPath: SEEREEL_CLI_SKILL };
  }
  if (action === "path") {
    return { action: "skill-path", skillPath: SEEREEL_CLI_SKILL };
  }
  if (action !== "install") throw new CliError(`Unknown skill action: ${action}`);

  const targets = resolveSkillTargets(options.agent);
  const installed = [];
  for (const target of targets) {
    const dir = path.join(os.homedir(), target.root, "skills", "seereel-cli");
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, "SKILL.md");
    await writeFile(file, skillText);
    installed.push({ agent: target.name, file });
  }
  return { action: "skill-install", skillPath: SEEREEL_CLI_SKILL, installed };
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

function normalizeApiKeyRoute(value) {
  return value === "volcengine-cn" || value === "cn" || value === "volcengine" ? "volcengine-cn" : "byteplus";
}

async function commandOpen(runtime, options) {
  const sessionId = await resolveSessionId(runtime, options.session || "latest");
  const webUrl = sessionUrl(runtime.baseUrl, sessionId);
  openUrl(webUrl);
  return { webUrl };
}

async function commandHandoff(runtime, options) {
  await api(runtime, "/api/healthz");
  const sessionId = await resolveSessionId(runtime, options.session || "latest");
  const handoff = await createSessionHandoff(runtime, sessionId);
  const result = {
    action: "handoff",
    sessionId,
    webUrl: sessionUrl(runtime.baseUrl, sessionId),
    webUrlVisibleInBrowser: false,
    handoffUrl: handoff.handoffUrl,
    handoffExpiresAt: handoff.handoffExpiresAt
  };
  if (options.open) openUrl(result.handoffUrl);
  return result;
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
    console.log(`API key: ${result.apiKeyConfigured ? `configured (${result.apiKeyRoute})` : "not configured"}`);
    console.log(`Agent Plan token: ${result.agentPlanTokenConfigured ? "configured" : "not configured"}`);
    if (result.cookieOrigins.length) console.log(`Cookie origins: ${result.cookieOrigins.join(", ")}`);
    return;
  }
  if (command === "status") {
    console.log(`SeeReel: ${result.baseUrl}`);
    console.log(`Health: ${result.health?.ok ? "ok" : "unknown"}`);
    console.log(`API key: ${result.apiKey?.configured ? `configured (${result.apiKey.fingerprint})` : "not configured"}`);
    console.log(`Agent Plan: ${result.agentPlan?.configured ? `configured (${result.agentPlan.fingerprint})` : "not configured"}`);
    if (result.session) {
      console.log(`Session: ${result.session.title || result.session.id} [${result.session.id}]`);
      console.log(`Web: ${result.session.webUrl}`);
      console.log(`Shots: ${result.session.readyShotCount} ready / ${result.session.failedShotCount} failed-or-missing`);
      console.log(`Stitch: ${result.session.stitchStatus || "idle"}${result.session.stitchProgress ? ` (${result.session.stitchProgress})` : ""}`);
      if (result.session.downloadUrl) console.log(`Download: ${result.session.downloadUrl}`);
      for (const shot of result.session.shots || []) {
        const age = shot.taskAgeSec !== undefined ? ` age=${shot.taskAgeSec}s` : "";
        const task = shot.generationTaskId ? ` task=${shot.generationTaskId}` : "";
        const error = shot.error ? ` error=${shot.error}` : "";
        console.log(`  ${shot.index}. ${shot.title || shot.id} - ${shot.status || "draft"}${task}${age}${error}`);
      }
      return;
    }
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
    if (result.webUrlVisibleInBrowser === false) console.log("Web visible in normal browser: no (use Handoff)");
    if (result.handoffUrl) console.log(`Handoff: ${result.handoffUrl}`);
    if (result.handoffExpiresAt) console.log(`Handoff expires: ${result.handoffExpiresAt}`);
    if (result.output) console.log(`Output: ${result.output}${result.bytes ? ` (${result.bytes} bytes)` : ""}`);
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
  if (result.webUrlVisibleInBrowser === false) console.log("Web visible in normal browser: no (use Handoff)");
  if (result.handoffUrl) console.log(`Handoff: ${result.handoffUrl}`);
  if (result.handoffExpiresAt) console.log(`Handoff expires: ${result.handoffExpiresAt}`);
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
  if (result.download?.output) console.log(`Saved: ${result.download.output}${result.download.bytes ? ` (${result.download.bytes} bytes)` : ""}`);
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
  options.reporter = createReporter(options);
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
  } else if (command === "download") {
    result = await commandDownload(runtime, options);
  } else if (command === "handoff") {
    result = await commandHandoff(runtime, options);
  } else if (command === "open") {
    result = await commandOpen(runtime, options);
  } else {
    throw new CliError(`Unknown command: ${rawCommand}\n\n${HELP.trim()}`);
  }

  if (options.jsonl) options.reporter.complete(result);
  else if (options.json) console.log(JSON.stringify(result, null, 2));
  else printHuman(result, command);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`seereelcli: ${message}`);
  process.exit(error instanceof CliError ? error.code : 1);
});
