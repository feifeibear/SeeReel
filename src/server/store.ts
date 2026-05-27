import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Asset, CreateSessionPayload, Session, Shot, ShotRender, StoreSnapshot } from "../shared/types";

const DATA_DIR = path.resolve(process.cwd(), "data");
const STORE_FILE = path.join(DATA_DIR, "cinema-store.json");

const now = () => new Date().toISOString();
const id = (prefix: string) => `${prefix}_${crypto.randomUUID().slice(0, 8)}`;

const emptyStore = (): StoreSnapshot => ({
  assets: [],
  sessions: [],
  shots: []
});

export class CinemaStore {
  private data: StoreSnapshot = emptyStore();

  async load() {
    await mkdir(DATA_DIR, { recursive: true });
    try {
      this.data = JSON.parse(await readFile(STORE_FILE, "utf8")) as StoreSnapshot;
    } catch {
      this.data = emptyStore();
      await this.save();
    }
  }

  snapshot(): StoreSnapshot {
    return structuredClone(this.data);
  }

  async save() {
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(STORE_FILE, JSON.stringify(this.data, null, 2), "utf8");
  }

  async createSession(payload: CreateSessionPayload) {
    const ts = now();
    const targetDurationSec = Math.max(15, Number(payload.targetDurationSec) || 60);
    const shotCount = Math.max(1, Math.min(20, Number(payload.shotCount) || 4));
    const session: Session = {
      id: id("ses"),
      title: normalizeSessionTitle(payload.title, this.data.sessions),
      logline: payload.logline?.trim() || "",
      style: payload.style?.trim() || "cinematic, emotionally grounded, coherent visual continuity",
      targetDurationSec,
      createdAt: ts,
      updatedAt: ts
    };

    const perShot = Math.max(4, Math.round(targetDurationSec / shotCount));
    const shots: Shot[] = Array.from({ length: shotCount }, (_, index) => ({
      id: id("shot"),
      sessionId: session.id,
      index: index + 1,
      title: `Shot ${index + 1}`,
      script: "",
      camera: "",
      durationSec: perShot,
      assetIds: [],
      rawPrompt: "",
      prompt: "",
      debugNote: "",
      seedanceVariant: "standard",
      usePreviousShotClip: false,
      renders: [],
      status: "draft",
      createdAt: ts,
      updatedAt: ts
    }));

    this.data.sessions.unshift(session);
    this.data.shots.push(...shots);
    await this.save();
    return { ...session, shots };
  }

  async updateSession(sessionId: string, patch: Partial<Session>) {
    const session = this.data.sessions.find((item) => item.id === sessionId);
    if (!session) return undefined;
    Object.assign(session, patch, { id: session.id, updatedAt: now() });
    await this.save();
    return this.getSession(session.id);
  }

  async promoteSession(sessionId: string) {
    const index = this.data.sessions.findIndex((item) => item.id === sessionId);
    if (index < 0) return undefined;
    const [session] = this.data.sessions.splice(index, 1);
    session.updatedAt = now();
    this.data.sessions.unshift(session);
    await this.save();
    return this.getSession(session.id);
  }

  async deleteSession(sessionId: string) {
    const existing = this.data.sessions.find((item) => item.id === sessionId);
    if (!existing) return false;

    // Collect owning shot ids first so we can cascade-delete their private (shot-scoped) sketch
    // assets before dropping the shot rows themselves.
    const owningShotIds = new Set(
      this.data.shots.filter((shot) => shot.sessionId === sessionId).map((shot) => shot.id)
    );
    this.data.assets = this.data.assets.filter((asset) => {
      // Drop shot-scoped sketches belonging to this session's shots.
      if (asset.ownerShotId && owningShotIds.has(asset.ownerShotId)) return false;
      // Drop session-scoped assets owned by this session. They were never promoted to global,
      // so the user's intent was "this is throw-away material for that one session".
      if (asset.ownerSessionId === sessionId) return false;
      return true;
    });
    this.data.sessions = this.data.sessions.filter((session) => session.id !== sessionId);
    this.data.shots = this.data.shots.filter((shot) => shot.sessionId !== sessionId);
    await this.save();
    return true;
  }

  getSession(sessionId: string) {
    const session = this.data.sessions.find((item) => item.id === sessionId);
    if (!session) return undefined;
    const shots = this.data.shots
      .filter((shot) => shot.sessionId === sessionId)
      .sort((a, b) => a.index - b.index);
    return { ...structuredClone(session), shots: structuredClone(shots) };
  }

  async upsertAsset(asset: Partial<Asset>) {
    const ts = now();
    if (asset.id) {
      const existing = this.data.assets.find((item) => item.id === asset.id);
      if (!existing) return undefined;
      const mediaKind = asset.mediaKind ?? existing.mediaKind ?? (asset.imageUrl || asset.mediaUrl ? "image" : "none");
      const mediaUrl = asset.mediaUrl ?? asset.imageUrl ?? existing.mediaUrl ?? existing.imageUrl;
      // Honour explicit clear-to-empty for scope fields so the UI can demote a session asset to
      // global (or vice-versa) by sending "" / null. Object.assign happens after this so the
      // value below survives unless `asset` also sets the same key explicitly.
      const scopePatch: Partial<Asset> = {};
      if (Object.hasOwn(asset, "ownerSessionId")) {
        scopePatch.ownerSessionId = (asset.ownerSessionId as string | undefined)?.trim() || undefined;
      }
      if (Object.hasOwn(asset, "ownerShotId")) {
        scopePatch.ownerShotId = (asset.ownerShotId as string | undefined)?.trim() || undefined;
      }
      Object.assign(existing, asset, scopePatch, {
        id: existing.id,
        mediaKind,
        mediaUrl,
        imageUrl: mediaKind === "image" ? mediaUrl : asset.imageUrl ?? existing.imageUrl,
        updatedAt: ts
      });
      await this.save();
      return structuredClone(existing);
    }

    const created: Asset = {
      id: id("asset"),
      name: asset.name?.trim() || "未命名资产",
      type: asset.type ?? "other",
      mediaKind: asset.mediaKind ?? (asset.imageUrl ? "image" : "none"),
      description: asset.description ?? "",
      prompt: asset.prompt ?? "",
      mediaUrl: asset.mediaUrl ?? asset.imageUrl,
      imageUrl: asset.imageUrl,
      referenceImageUrl: asset.referenceImageUrl,
      tags: asset.tags ?? [],
      parentAssetId: asset.parentAssetId || undefined,
      ownerShotId: asset.ownerShotId || undefined,
      ownerSessionId: asset.ownerSessionId || undefined,
      createdAt: ts,
      updatedAt: ts
    };
    this.data.assets.unshift(created);
    await this.save();
    return structuredClone(created);
  }

  async deleteAsset(assetId: string) {
    this.data.assets = this.data.assets.filter((asset) => asset.id !== assetId);
    this.data.shots.forEach((shot) => {
      shot.assetIds = shot.assetIds.filter((id) => id !== assetId);
    });
    await this.save();
  }

  async updateShot(shotId: string, patch: Partial<Shot>) {
    const shot = this.data.shots.find((item) => item.id === shotId);
    if (!shot) return undefined;
    Object.assign(shot, patch, { id: shot.id, sessionId: shot.sessionId, updatedAt: now() });
    await this.save();
    return structuredClone(shot);
  }

  /**
   * Remove a shot and cascade-delete any private (shot-scoped) sketch assets it owns.
   * Returns the deleted shot (clone) if it existed, otherwise undefined.
   */
  async deleteShot(shotId: string) {
    const shot = this.data.shots.find((item) => item.id === shotId);
    if (!shot) return undefined;
    const snapshot = structuredClone(shot);
    this.data.shots = this.data.shots.filter((item) => item.id !== shotId);
    this.data.assets = this.data.assets.filter((asset) => asset.ownerShotId !== shotId);
    await this.save();
    return snapshot;
  }

  async updateShotRender(shotId: string, renderId: string, patch: Partial<ShotRender>) {
    const shot = this.data.shots.find((item) => item.id === shotId);
    if (!shot) return undefined;
    const render = (shot.renders || []).find((item) => item.id === renderId);
    if (!render) return structuredClone(shot);
    Object.assign(render, patch, { id: render.id });
    shot.updatedAt = now();
    await this.save();
    return structuredClone(shot);
  }

  async deleteShotRender(shotId: string, renderId: string) {
    const shot = this.data.shots.find((item) => item.id === shotId);
    if (!shot) return undefined;

    const renders = shot.renders || [];
    const deleted = renders.find((render) => render.id === renderId);
    if (!deleted) return structuredClone(shot);

    const remaining = renders.filter((render) => render.id !== renderId);
    shot.renders = remaining;

    if (deleted.videoUrl && shot.videoUrl === deleted.videoUrl) {
      const nextRender = remaining.find((render) => render.videoUrl);
      if (nextRender) {
        Object.assign(shot, shotPatchFromRender(nextRender));
      } else {
        shot.videoUrl = undefined;
        shot.referenceClipUrl = undefined;
        shot.referenceAudioUrl = undefined;
        shot.status = shot.prompt ? "scripted" : "draft";
      }
      shot.generationTaskId = undefined;
      shot.generationStartedAt = undefined;
      shot.error = undefined;
    }

    shot.updatedAt = now();
    await this.save();
    return structuredClone(shot);
  }

  getShot(shotId: string) {
    return structuredClone(this.data.shots.find((item) => item.id === shotId));
  }

  getAssets(assetIds: string[]) {
    const wanted = new Set(assetIds);
    return structuredClone(this.data.assets.filter((asset) => wanted.has(asset.id)));
  }

  getAssetsForShot(shot: Pick<Shot, "id" | "sessionId" | "assetIds" | "prompt" | "rawPrompt">) {
    // Visibility rules for an asset relative to this shot:
    //   - ownerShotId set & !== shot.id  → another shot's private sketch, hidden
    //   - ownerSessionId set & !== shot.sessionId → another session's session-scoped asset, hidden
    //   - otherwise (global, or owned by this shot, or owned by this session) → visible
    const isVisible = (asset: Asset) => {
      if (asset.ownerShotId && asset.ownerShotId !== shot.id) return false;
      if (asset.ownerSessionId && asset.ownerSessionId !== shot.sessionId) return false;
      return true;
    };

    const wanted = new Set<string>();
    (shot.assetIds ?? []).forEach((assetId) => {
      const asset = this.data.assets.find((item) => item.id === assetId);
      if (!asset) return;
      if (!isVisible(asset)) return;
      wanted.add(assetId);
    });
    const prompt = normalizeMentionText(`${shot.rawPrompt || ""}\n${shot.prompt || ""}`);
    this.data.assets.forEach((asset) => {
      if (!isVisible(asset)) return;
      const aliases = [asset.name, ...(asset.tags ?? [])]
        .map((value) => normalizeMentionText(value))
        .filter(Boolean);
      if (aliases.some((alias) => prompt.includes(`@${alias}`))) wanted.add(asset.id);
    });
    return structuredClone(this.data.assets.filter((asset) => wanted.has(asset.id)));
  }
}

function normalizeSessionTitle(title: string | undefined, sessions: Session[]) {
  const trimmed = title?.trim();
  if (trimmed) return trimmed;

  const used = new Set<number>();
  sessions.forEach((session) => {
    const match = session.title.trim().match(/^unamed session\s+(\d+)$/i);
    if (match) used.add(Number(match[1]));
  });

  let index = 1;
  while (used.has(index)) index += 1;
  return `unamed session ${index}`;
}

function normalizeMentionText(value: string) {
  return value.toLowerCase().replace(/\s+/g, "").replace(/／/g, "/").trim();
}

function shotPatchFromRender(render: ShotRender): Partial<Shot> {
  const patch: Partial<Shot> = {
    title: render.title,
    durationSec: render.durationSec,
    seedanceVariant: render.seedanceVariant,
    assetIds: render.assetIds,
    prompt: render.prompt,
    debugNote: render.note || "",
    videoUrl: render.videoUrl,
    usePreviousShotClip: render.usePreviousShotClip,
    previousShotClipSec: render.previousShotClipSec,
    previousShotClipSecOverride: render.previousShotClipSecOverride,
    referenceClipUrl: render.referenceClipUrl,
    referenceAudioUrl: render.referenceAudioUrl,
    referenceClipPreviewUrl: render.referenceClipPreviewUrl,
    referenceAudioPreviewUrl: render.referenceAudioPreviewUrl,
    firstFrameAssetId: render.firstFrameAssetId,
    status: "ready"
  };
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as Partial<Shot>;
}
