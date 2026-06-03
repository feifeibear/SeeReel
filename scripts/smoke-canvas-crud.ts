import { strict as assert } from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";

const baseUrl = process.env.REELYAI_BASE_URL || "http://127.0.0.1:5173";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers || {})
    }
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${init?.method || "GET"} ${path} failed: ${res.status} ${res.statusText} ${text}`);
  }
  return res.json() as Promise<T>;
}

type Asset = {
  id: string;
  name: string;
  type: "character" | "scene" | "prop" | "style" | "other";
  mediaKind: "image" | "video" | "none";
  description: string;
  prompt: string;
  ownerSessionId?: string;
  ownerShotId?: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
};

type Shot = {
  id: string;
  sessionId: string;
  index: number;
  title: string;
  script: string;
  camera: string;
  durationSec: number;
  assetIds: string[];
  prompt: string;
  status: string;
  createdAt: string;
  updatedAt: string;
};

type Session = {
  id: string;
  title: string;
  logline: string;
  style: string;
  targetDurationSec: number;
  createdAt: string;
  updatedAt: string;
  shots: Shot[];
};

type Snapshot = { assets: Asset[]; sessions: Array<Omit<Session, "shots">>; shots: Shot[] };

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
  if (await isServerReachable()) return fn();

  const child: ChildProcess = spawn("npm", ["run", "dev"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: new URL(baseUrl).port || "5173" },
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
    if (process.platform === "win32") {
      child.kill("SIGTERM");
    } else {
      process.kill(-child.pid, "SIGTERM");
    }
  } catch {
    child.kill("SIGTERM");
  }
}

async function main() {
  const session = await request<Session>("/api/sessions", {
    method: "POST",
    body: JSON.stringify({
      title: "Canvas CRUD Smoke",
      logline: "Smoke-test session for create/delete/undo restore semantics.",
      style: "test",
      targetDurationSec: 30,
      shotCount: 0
    })
  });
  assert.ok(session.id, "session id should exist");

  const asset = await request<Asset>("/api/assets", {
    method: "POST",
    body: JSON.stringify({
      name: "Smoke Character",
      type: "character",
      description: "smoke asset",
      prompt: "",
      ownerSessionId: session.id,
      tags: ["anchor", "character", "smoke"]
    })
  });
  assert.ok(asset.id, "asset id should exist");

  const appended = await request<{ shot: Shot; session: Session }>(`/api/sessions/${session.id}/shots`, {
    method: "POST",
    body: JSON.stringify({ title: "Smoke Shot" })
  });
  assert.ok(appended.shot.id, "shot id should exist");

  const wired = await request<Shot>(`/api/shots/${appended.shot.id}`, {
    method: "PATCH",
    body: JSON.stringify({ assetIds: [asset.id] })
  });
  assert.deepEqual(wired.assetIds, [asset.id], "asset should wire to shot");

  await request<{ ok: true }>(`/api/assets/${asset.id}`, { method: "DELETE" });
  let snapshot = await request<Snapshot>("/api/state");
  assert.equal(snapshot.assets.some((a) => a.id === asset.id), false, "asset should be deleted");
  assert.equal(
    snapshot.shots.find((s) => s.id === appended.shot.id)?.assetIds.includes(asset.id),
    false,
    "asset delete should clear shot.assetIds"
  );

  const restoredAsset = await request<Asset>("/api/assets/restore", {
    method: "POST",
    body: JSON.stringify({ asset })
  });
  assert.equal(restoredAsset.id, asset.id, "asset restore should preserve id");

  const relinked = await request<Shot>(`/api/shots/${appended.shot.id}`, {
    method: "PATCH",
    body: JSON.stringify({ assetIds: [asset.id] })
  });
  assert.deepEqual(relinked.assetIds, [asset.id], "restored asset should relink to shot");

  const ownedAssetsBeforeShotDelete = (await request<Snapshot>("/api/state")).assets.filter((a) => a.ownerShotId === appended.shot.id);
  await request<{ ok: true; shotId: string }>(`/api/shots/${appended.shot.id}`, { method: "DELETE" });
  snapshot = await request<Snapshot>("/api/state");
  assert.equal(snapshot.shots.some((s) => s.id === appended.shot.id), false, "shot should be deleted");

  const restoredShot = await request<{ shot: Shot; session: Session; assets: Asset[] }>("/api/shots/restore", {
    method: "POST",
    body: JSON.stringify({ shot: appended.shot, assets: ownedAssetsBeforeShotDelete })
  });
  assert.equal(restoredShot.shot.id, appended.shot.id, "shot restore should preserve id");

  await request<{ ok: true }>(`/api/sessions/${session.id}`, { method: "DELETE" });
  console.log("canvas CRUD smoke passed", { sessionId: session.id, assetId: asset.id, shotId: appended.shot.id });
}

withServer(main).catch((err) => {
  console.error(err);
  process.exit(1);
});
