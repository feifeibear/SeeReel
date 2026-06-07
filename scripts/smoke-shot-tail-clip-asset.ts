import { strict as assert } from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import ffmpeg from "@ffmpeg-installer/ffmpeg";

const PORT = process.env.SEEREEL_TAIL_CLIP_SMOKE_PORT || "5192";
const baseUrl = `http://127.0.0.1:${PORT}`;
const mediaDir = path.resolve(process.cwd(), "data", "media");
let cookieHeader = "";

type Session = { id: string; shots?: Shot[] };
type Shot = { id: string; sessionId: string; videoUrl?: string; status?: string };
type Asset = {
  id: string;
  ownerSessionId?: string;
  mediaKind: string;
  mediaUrl?: string;
  referenceImageUrl?: string;
  tags: string[];
  clipDurationSec?: number;
};

function rememberCookies(headers: Headers) {
  const raw = headers.get("set-cookie");
  if (!raw) return;
  cookieHeader = raw
    .split(/,(?=[^;,]+=)/)
    .map((item) => item.split(";")[0].trim())
    .filter(Boolean)
    .join("; ");
}

async function request<T>(pathName: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${baseUrl}${pathName}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      ...(init?.headers || {})
    }
  });
  rememberCookies(res.headers);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${init?.method || "GET"} ${pathName} failed: ${res.status} ${res.statusText} ${text}`);
  }
  return res.json() as Promise<T>;
}

async function isServerReachable() {
  try {
    const res = await fetch(`${baseUrl}/api/healthz`);
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForServer(timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isServerReachable()) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Server did not become ready at ${baseUrl}`);
}

function terminateServer(child: ChildProcess) {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") child.kill("SIGTERM");
    else process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

async function withServer<T>(fn: () => Promise<T>): Promise<T> {
  if (await isServerReachable()) {
    throw new Error(`Port ${PORT} already in use; stop the server there so this smoke can boot a controlled instance.`);
  }

  const child: ChildProcess = spawn("npm", ["run", "dev"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT, SEEREEL_SKIP_SKILL_INSTALL: "1" },
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout?.on("data", (chunk) => process.stdout.write(`[server] ${chunk}`));
  child.stderr?.on("data", (chunk) => process.stderr.write(`[server] ${chunk}`));

  try {
    await waitForServer();
    return await fn();
  } finally {
    terminateServer(child);
  }
}

async function runFfmpeg(args: string[]) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpeg.path, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with ${code}: ${stderr.slice(-1000)}`));
    });
  });
}

async function createSyntheticVideo(name: string) {
  const outputPath = path.join(mediaDir, name);
  await mkdir(mediaDir, { recursive: true });
  await runFfmpeg([
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=128x128:rate=24:duration=3",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    outputPath
  ]);
  return outputPath;
}

async function main() {
  const videoName = `tail-clip-smoke-${Date.now()}.mp4`;
  const videoPath = await createSyntheticVideo(videoName);
  let sessionId = "";
  let tailClipLocalPath = "";

  try {
    await withServer(async () => {
      const session = await request<Session>("/api/sessions", {
        method: "POST",
        body: JSON.stringify({ title: "Tail clip Smoke", logline: "tail clip", style: "test", targetDurationSec: 3, shotCount: 0 })
      });
      sessionId = session.id;
      try {
        const appended = await request<{ shot: Shot }>(`/api/sessions/${session.id}/shots`, {
          method: "POST",
          body: JSON.stringify({ title: "Tail Clip Source", durationSec: 3, rawPrompt: "synthetic" })
        });
        const shot = await request<Shot>(`/api/shots/${appended.shot.id}`, {
          method: "PATCH",
          body: JSON.stringify({ videoUrl: `/media/${videoName}`, status: "ready" })
        });
        assert.equal(shot.videoUrl, `/media/${videoName}`);

        const result = await request<{ asset: Asset }>(`/api/shots/${shot.id}/tail-clip`, {
          method: "POST",
          body: JSON.stringify({ durationSec: 2, publishToTos: false })
        });

        assert.equal(result.asset.ownerSessionId, session.id, "tail clip asset should stay session-scoped");
        assert.equal(result.asset.mediaKind, "video", "tail clip asset should be a video");
        assert.ok(result.asset.mediaUrl?.startsWith("/media/"), "tail clip should keep a local preview URL in smoke");
        assert.equal(result.asset.referenceImageUrl, result.asset.mediaUrl, "tail clip local preview should be retained");
        assert.equal(result.asset.clipDurationSec, 2, "tail clip should record the requested duration");
        assert.ok(result.asset.tags.includes("reference-video"), "tail clip should be bindable as a reference-video node");
        assert.ok(result.asset.tags.includes("tail-clip"), "tail clip should be distinguishable from uploads");
        assert.ok(result.asset.tags.includes(`source-shot:${shot.id}`), "tail clip should remember its source shot");
        tailClipLocalPath = path.join(mediaDir, path.basename(result.asset.mediaUrl || ""));
      } finally {
        if (sessionId) await request<{ ok: true }>(`/api/sessions/${sessionId}`, { method: "DELETE" }).catch(() => undefined);
      }
    });
  } finally {
    await rm(videoPath, { force: true });
    if (tailClipLocalPath) await rm(tailClipLocalPath, { force: true });
  }
  console.log("shot tail clip asset smoke passed");
}

main().catch((err) => {
  console.error(`[fail] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
