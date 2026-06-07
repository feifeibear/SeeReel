#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import http from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const cli = "packages/seereel-cli/bin/seereelcli.js";

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function json(res, body, status = 200, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function text(res, body, status = 200, headers = {}) {
  res.writeHead(status, { "Content-Type": "text/plain", ...headers });
  res.end(body);
}

async function main() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "seereel-cloud-only-smoke-"));
  const inputImage = path.join(tempRoot, "route.png");
  const outputVideo = path.join(tempRoot, "final.mp4");
  const cliHome = path.join(tempRoot, "cli-home");
  await mkdir(cliHome, { recursive: true });
  await writeFile(inputImage, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

  const calls = [];
  const finalBytes = Buffer.from("cloud-final-video");
  let pollCount = 0;
  const session = {
    id: "ses_cloudonly",
    title: "Cloud-only smoke",
    targetDurationSec: 30,
    finalVideoUrl: "/media/final.mp4",
    stitchStatus: "ready"
  };
  const shots = [
    { id: "shot_one", sessionId: session.id, index: 1, title: "Shot 1", durationSec: 15, status: "draft", assetIds: [] },
    { id: "shot_two", sessionId: session.id, index: 2, title: "Shot 2", durationSec: 15, status: "draft", assetIds: [] }
  ];
  const referenceAsset = {
    id: "asset_reference",
    name: "Route reference",
    type: "scene",
    mediaKind: "image",
    mediaUrl: "https://cdn.example.test/route.png",
    imageUrl: "https://cdn.example.test/route.png",
    ownerSessionId: session.id
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    calls.push({ method: req.method, path: url.pathname });
    if (req.method === "GET" && url.pathname === "/api/healthz") return json(res, { ok: true });
    if (req.method === "GET" && url.pathname === "/api/credentials/api-key") return json(res, { configured: false });
    if (req.method === "POST" && url.pathname === "/api/credentials/api-key") {
      await readBody(req);
      return json(res, { configured: true, fingerprint: "api-smoke" });
    }
    if (req.method === "GET" && url.pathname === "/api/credentials/agent-plan") return json(res, { configured: true, fingerprint: "smoke" });
    if (req.method === "GET" && url.pathname === "/api/state") {
      return json(res, { sessions: [session], shots, assets: [referenceAsset] });
    }
    if (req.method === "POST" && url.pathname === "/api/sessions") {
      await readBody(req);
      return json(res, { ...session, shots });
    }
    if (req.method === "POST" && url.pathname === `/api/assets/upload-image`) {
      const body = await readBody(req);
      assert.ok(body.length > 0, "reference image should be uploaded as raw bytes");
      return json(res, referenceAsset);
    }
    if (req.method === "POST" && url.pathname === `/api/sessions/${session.id}/script/generate`) {
      return json(res, { ...session, story: { premise: "cloud only", beats: [], characters: [], locked: false }, shots });
    }
    if (req.method === "POST" && url.pathname === `/api/sessions/${session.id}/storyboard`) {
      return json(res, { session: { ...session, shots }, shots });
    }
    const shotPatch = url.pathname.match(/^\/api\/shots\/([^/]+)$/);
    if (req.method === "PATCH" && shotPatch) {
      const shot = shots.find((item) => item.id === shotPatch[1]);
      assert.ok(shot, "patched shot exists");
      const patch = JSON.parse((await readBody(req)).toString("utf8"));
      Object.assign(shot, patch);
      return json(res, shot);
    }
    const subStoryboard = url.pathname.match(/^\/api\/shots\/([^/]+)\/sub-storyboard$/);
    if (req.method === "POST" && subStoryboard) {
      const shot = shots.find((item) => item.id === subStoryboard[1]);
      assert.ok(shot, "storyboard shot exists");
      const asset = { id: `asset_storyboard_${shot.index}`, ownerShotId: shot.id, mediaKind: "image", mediaUrl: `https://cdn.example.test/storyboard-${shot.index}.png` };
      Object.assign(shot, {
        subShotPanelCount: 4,
        subShotStoryboardAssetId: asset.id,
        subShotStoryboardAssetIds: [asset.id]
      });
      return json(res, { shot, asset });
    }
    if (req.method === "POST" && url.pathname === `/api/sessions/${session.id}/workflow/plan`) {
      return json(res, {
        sessionId: session.id,
        summary: "cloud-only plan",
        layers: [[{ shotId: "shot_one", index: 1, action: "generate" }], [{ shotId: "shot_two", index: 2, action: "generate" }]],
        skipped: [],
        stitchTargets: []
      });
    }
    const generate = url.pathname.match(/^\/api\/shots\/([^/]+)\/generate$/);
    if (req.method === "POST" && generate) {
      const shot = shots.find((item) => item.id === generate[1]);
      Object.assign(shot, { status: "generating", generationTaskId: `task_${shot.id}` });
      return json(res, shot);
    }
    const poll = url.pathname.match(/^\/api\/shots\/([^/]+)\/poll$/);
    if (req.method === "POST" && poll) {
      const shot = shots.find((item) => item.id === poll[1]);
      Object.assign(shot, { status: "ready", videoUrl: `/media/${shot.id}.mp4`, renders: [{ id: `render_${shot.id}`, status: "ready", videoUrl: `/media/${shot.id}.mp4` }] });
      return json(res, shot);
    }
    if (req.method === "POST" && url.pathname === `/api/sessions/${session.id}/stitch`) {
      pollCount = 0;
      Object.assign(session, { stitchStatus: "running", stitchProgress: "queued" });
      return json(res, session);
    }
    if (req.method === "POST" && url.pathname === `/api/sessions/${session.id}/stitch/poll`) {
      pollCount += 1;
      Object.assign(session, pollCount > 0 ? { stitchStatus: "ready", finalVideoUrl: "/media/final.mp4" } : { stitchStatus: "running" });
      return json(res, session);
    }
    if (req.method === "POST" && url.pathname === `/api/sessions/${session.id}/handoff`) {
      return json(res, { handoffToken: "tok_cloud", handoffUrl: `http://127.0.0.1/api/handoff/tok_cloud`, handoffExpiresAt: "2030-01-01T00:00:00.000Z" });
    }
    if (req.method === "GET" && url.pathname === `/api/sessions/${session.id}/download`) {
      res.writeHead(200, { "Content-Type": "video/mp4" });
      res.end(finalBytes);
      return;
    }
    text(res, "not found", 404);
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const { stdout } = await execFileAsync(process.execPath, [
      cli,
      "workflow",
      "cloud-only smoke route",
      "--base-url",
      baseUrl,
      "--cloud-only",
      "--reference-image",
      inputImage,
      "--render",
      "--stitch",
      "--output",
      outputVideo,
      "--poll-interval-ms",
      "1000",
      "--json"
    ], {
      cwd: process.cwd(),
      env: { ...process.env, SEEREEL_CLI_HOME: cliHome },
      maxBuffer: 10 * 1024 * 1024
    });
    const result = JSON.parse(stdout);
    assert.equal(result.cloudOnly, true);
    assert.equal(result.webUrl, `${baseUrl}/canvas/${session.id}`);
    assert.equal(result.webUrlVisibleInBrowser, true);
    assert.equal(result.handoffUrl, undefined);
    assert.equal(result.referenceAssets?.[0]?.id, referenceAsset.id);
    assert.equal(result.storyboardAssets?.length, 2);
    assert.equal(result.download?.output, path.resolve(outputVideo));
    assert.equal(await readFile(outputVideo, "utf8"), finalBytes.toString("utf8"));
    assert.ok(calls.some((call) => call.method === "POST" && call.path === "/api/assets/upload-image"), "reference upload endpoint should be called");
    assert.equal(calls.filter((call) => call.path.endsWith("/sub-storyboard")).length, 2, "server-side storyboard should be generated per shot");
    assert.equal(calls.filter((call) => /^\/api\/shots\/[^/]+\/generate$/.test(call.path)).length, 2, "shot renders should be generated by server endpoints");
    assert.ok(calls.some((call) => call.path === `/api/sessions/${session.id}/stitch`), "server-side stitch should be requested");
    assert.ok(calls.some((call) => call.path === `/api/sessions/${session.id}/download`), "final cloud artifact should be downloaded");
    assert.equal(calls.some((call) => call.path === `/api/sessions/${session.id}/handoff`), false, "localhost workflow should not create encrypted handoff tokens");
    console.log("cloud-only CLI smoke passed");
  } finally {
    server.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
