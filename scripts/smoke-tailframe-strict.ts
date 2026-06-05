import { strict as assert } from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import ffmpeg from "@ffmpeg-installer/ffmpeg";

const PORT = process.env.REELYAI_TAILFRAME_SMOKE_PORT || "5188";
const baseUrl = `http://127.0.0.1:${PORT}`;
const mediaDir = path.resolve(process.cwd(), "data", "media");
let cookieHeader = "";

type Session = { id: string; shots?: Shot[] };
type Shot = { id: string; sessionId: string; index: number; videoUrl?: string; status?: string };
type TailframeResponse = { asset: { id: string; mediaUrl?: string; imageUrl?: string } };

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

async function withServer<T>(fn: () => Promise<T>): Promise<T> {
  if (await isServerReachable()) {
    throw new Error(`Port ${PORT} already in use; stop the server there so this smoke can boot a controlled instance.`);
  }

  const child: ChildProcess = spawn("npm", ["run", "dev"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT, REELYAI_SKIP_SKILL_INSTALL: "1" },
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

function terminateServer(child: ChildProcess) {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") child.kill("SIGTERM");
    else process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
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
    "color=c=blue:s=64x64:r=30:d=1.966667",
    "-f",
    "lavfi",
    "-i",
    "color=c=red:s=64x64:r=30:d=0.033333",
    "-filter_complex",
    "[0:v][1:v]concat=n=2:v=1:a=0,format=yuv420p[v]",
    "-map",
    "[v]",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    outputPath
  ]);
  return outputPath;
}

async function readCenterRgb(imagePath: string) {
  const rawPath = `${imagePath}.center.rgb`;
  await runFfmpeg([
    "-y",
    "-i",
    imagePath,
    "-vf",
    "format=rgb24,crop=1:1:32:32",
    "-frames:v",
    "1",
    "-f",
    "rawvideo",
    rawPath
  ]);
  const bytes = await readFile(rawPath);
  await rm(rawPath, { force: true });
  return { r: bytes[0], g: bytes[1], b: bytes[2] };
}

async function main() {
  const videoName = `tailframe-strict-${Date.now()}.mp4`;
  const videoPath = await createSyntheticVideo(videoName);
  let tailframePath = "";

  try {
    await withServer(async () => {
      const session = await request<Session>("/api/sessions", {
        method: "POST",
        body: JSON.stringify({ title: "Tailframe Strict Smoke", logline: "strict last frame", style: "test", targetDurationSec: 2, shotCount: 0 })
      });
      try {
        const appended = await request<{ shot: Shot }>(`/api/sessions/${session.id}/shots`, {
          method: "POST",
          body: JSON.stringify({ title: "Strict Tailframe Source", durationSec: 2, rawPrompt: "synthetic" })
        });
        const shot = await request<Shot>(`/api/shots/${appended.shot.id}`, {
          method: "PATCH",
          body: JSON.stringify({ videoUrl: `/media/${videoName}`, status: "ready" })
        });
        assert.equal(shot.videoUrl, `/media/${videoName}`);

        const result = await request<TailframeResponse>(`/api/shots/${shot.id}/tailframe`, {
          method: "POST",
          body: JSON.stringify({ publishToTos: false, canvasNode: true })
        });
        const imageUrl = result.asset.mediaUrl || result.asset.imageUrl || "";
        assert.ok(imageUrl.startsWith("/media/"), `tailframe should be local media, got ${imageUrl}`);

        tailframePath = path.join(mediaDir, path.basename(imageUrl));
        const rgb = await readCenterRgb(tailframePath);
        assert.ok(rgb.r > 180 && rgb.g < 80 && rgb.b < 80, `tailframe must be the strict final red frame, got rgb=${JSON.stringify(rgb)}`);
      } finally {
        await request<{ ok: true }>(`/api/sessions/${session.id}`, { method: "DELETE" }).catch(() => undefined);
      }
    });
  } finally {
    await rm(videoPath, { force: true });
    if (tailframePath) await rm(tailframePath, { force: true });
  }
  console.log("tailframe strict smoke passed");
}

main().catch((err) => {
  console.error(`[fail] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
