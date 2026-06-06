import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const repoRoot = process.cwd();
const tmp = path.join(os.tmpdir(), `seereel-portable-${process.pid}-${Date.now()}`);
await rm(tmp, { recursive: true, force: true });
await mkdir(path.join(tmp, "data", "media"), { recursive: true });
await writeFile(path.join(tmp, "data", "media", "ref.png"), Buffer.from("portable-media"));
process.chdir(tmp);

const storeModule = await import(`${pathToFileURL(path.join(repoRoot, "src/server/store.ts")).href}?portable=${Date.now()}`);
const { CinemaStore } = storeModule as typeof import("../src/server/store");

const store = new CinemaStore();
await store.load();
const created = await store.createSession({
  title: "Portable test",
  logline: "Move a visible workflow to another machine",
  style: "audit-friendly",
  targetDurationSec: 30,
  shotCount: 1
}, "owner-a");
const sourceSessionId = created.id;
const shot = created.shots[0];
const asset = await store.upsertAsset({
  ownerUserId: "owner-a",
  ownerSessionId: sourceSessionId,
  name: "Reference image",
  type: "scene",
  mediaKind: "image",
  description: "local preview",
  prompt: "river skyline",
  mediaUrl: "/media/ref.png",
  imageUrl: "/media/ref.png",
  tags: ["reference"]
});
assert(asset, "asset was created");
const updatedShot = await store.updateShot(shot.id, {
  assetIds: [asset.id],
  firstFrameAssetId: asset.id,
  videoUrl: "/media/ref.png",
  status: "generating",
  generationTaskId: "cgt_should_not_survive_running_import"
});
assert(updatedShot, "shot was updated");
const stitchSession = await store.createStitchJob(sourceSessionId, {
  name: "Final stitch",
  shotIds: [shot.id],
  status: "running"
});
assert(stitchSession, "stitch job was created");

const packData = store.buildSessionPackageData(sourceSessionId);
assert(packData, "package data exists");
assert(packData.session.ownerUserId === undefined, "export strips session ownerUserId");
assert(packData.assets.every((item) => item.ownerUserId === undefined), "export strips asset ownerUserId");
assert(JSON.stringify(packData).includes("/media/ref.png"), "export keeps local media references for packaging");
assert(!/ARK_|API_KEY|AGENT_PLAN|access-token/i.test(JSON.stringify(packData)), "export data contains no obvious credential material");

const imported = await store.importSessionPackageData(packData, "owner-b");
assert(imported, "import returned a session");
assert(imported.id !== sourceSessionId, "import creates a new session id");
assert(imported.ownerUserId === "owner-b", "import assigns the current owner");
assert(imported.shots.length === 1, "import keeps shots");
assert(imported.shots[0].id !== shot.id, "import remaps shot ids");
assert(imported.shots[0].assetIds[0] !== asset.id, "import remaps shot asset ids");
assert(imported.shots[0].firstFrameAssetId === imported.shots[0].assetIds[0], "import remaps first-frame asset link");
assert(imported.shots[0].status === "ready", "running shots with a saved video import as ready shots");
assert(!imported.shots[0].generationTaskId, "running generation task id is cleared on import");
assert(imported.stitchJobs?.[0]?.id !== stitchSession.stitchJobs?.[0]?.id, "import remaps stitch job ids");
assert(imported.stitchJobs?.[0]?.shotIds[0] === imported.shots[0].id, "import remaps stitch shot links");
assert(imported.stitchJobs?.[0]?.status === "idle", "running stitch jobs import as idle");

await rm(tmp, { recursive: true, force: true });
console.log("session portability smoke passed");
