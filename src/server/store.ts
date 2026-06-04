import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Asset, CreateSessionPayload, Session, Shot, ShotRender, StitchJob, StoreSnapshot, TokenUsageEvent } from "../shared/types";
import { observeStoreSave } from "./metrics";

export const DATA_DIR = path.resolve(process.cwd(), "data");
export const STORE_FILE = path.join(DATA_DIR, "cinema-store.json");

const now = () => new Date().toISOString();
const id = (prefix: string) => `${prefix}_${crypto.randomUUID().slice(0, 8)}`;

const emptyStore = (): StoreSnapshot => ({
  assets: [],
  sessions: [],
  shots: []
});

export class CinemaStore {
  private data: StoreSnapshot = emptyStore();
  private writeQueue: Promise<void> = Promise.resolve();

  async load() {
    await mkdir(DATA_DIR, { recursive: true });
    try {
      this.data = JSON.parse(await readFile(STORE_FILE, "utf8")) as StoreSnapshot;
    } catch {
      this.data = emptyStore();
    }
  }

  snapshot(): StoreSnapshot {
    return structuredClone(this.data);
  }

  snapshotForOwner(ownerUserId: string, includeLegacyPublic = false): StoreSnapshot {
    const sessions = this.data.sessions.filter((session) => {
      if (session.ownerUserId) return session.ownerUserId === ownerUserId;
      return includeLegacyPublic;
    });
    const sessionIds = new Set(sessions.map((session) => session.id));
    const shots = this.data.shots.filter((shot) => sessionIds.has(shot.sessionId));
    const shotIds = new Set(shots.map((shot) => shot.id));
    const assets = this.data.assets.filter((asset) => {
      if (asset.ownerShotId) return shotIds.has(asset.ownerShotId);
      if (asset.ownerSessionId) return sessionIds.has(asset.ownerSessionId);
      if (asset.ownerUserId) return asset.ownerUserId === ownerUserId;
      return includeLegacyPublic;
    });
    return structuredClone({ sessions, shots, assets });
  }

  private ownerUserIdForAssetScope(asset: Partial<Asset>) {
    if (asset.ownerUserId) return asset.ownerUserId;
    if (asset.ownerSessionId) {
      return this.data.sessions.find((session) => session.id === asset.ownerSessionId)?.ownerUserId;
    }
    if (asset.ownerShotId) {
      const shot = this.data.shots.find((item) => item.id === asset.ownerShotId);
      return shot ? this.data.sessions.find((session) => session.id === shot.sessionId)?.ownerUserId : undefined;
    }
    return undefined;
  }

  async save() {
    const started = performance.now();
    const payload = JSON.stringify(this.data, null, 2);
    const tmpFile = `${STORE_FILE}.${process.pid}.${Date.now()}.${crypto.randomUUID().slice(0, 8)}.tmp`;
    const write = this.writeQueue.then(async () => {
      await mkdir(DATA_DIR, { recursive: true });
      await writeFile(tmpFile, payload, "utf8");
      await rename(tmpFile, STORE_FILE);
    });
    this.writeQueue = write.catch(() => undefined);
    try {
      await write;
      observeStoreSave("ok", (performance.now() - started) / 1000);
    } catch (error) {
      observeStoreSave("error", (performance.now() - started) / 1000);
      throw error;
    }
  }

  async createSession(payload: CreateSessionPayload, ownerUserId?: string) {
    const ts = now();
    const targetDurationSec = Math.max(15, Number(payload.targetDurationSec) || 60);
    // Allow 0 — a fresh session is intentionally empty (canvas-first product flow). The user
    // grows it by adding shots / anchor assets / reference videos via the toolbar or
    // double-click menu. Hard cap at 20 to keep the auto-laid-out canvas legible.
    const shotCount = Math.max(0, Math.min(20, Math.floor(Number(payload.shotCount ?? 0))));
    const requestedId = typeof payload.id === "string" && /^ses_[A-Za-z0-9_-]+$/.test(payload.id)
      ? payload.id
      : "";
    const session: Session = {
      id: requestedId && !this.data.sessions.some((item) => item.id === requestedId) ? requestedId : id("ses"),
      ownerUserId,
      title: normalizeSessionTitle(payload.title, this.data.sessions),
      logline: payload.logline?.trim() || "",
      style: payload.style?.trim() || "cinematic, emotionally grounded, coherent visual continuity",
      language: payload.language === "en" ? "en" : "zh",
      targetDurationSec,
      tokenUsageEvents: [],
      createdAt: ts,
      updatedAt: ts
    };

    const perShot = shotCount > 0 ? Math.max(4, Math.round(targetDurationSec / shotCount)) : 0;
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

  /**
   * Append a single shot to an existing session. Used by the canvas "新建分镜镜头" flow:
   * double-clicking empty space lets the user add one more shot without creating a new session.
   * The new shot gets the next available index, an empty rawPrompt, and the same default
   * durationSec the session was created with (or `Math.round(target/count)` as a sane default).
   */
  async appendShot(sessionId: string, partial?: Partial<Shot>) {
    const session = this.data.sessions.find((item) => item.id === sessionId);
    if (!session) return undefined;
    const ts = now();
    const existing = this.data.shots.filter((s) => s.sessionId === sessionId);
    const nextIndex = existing.length ? Math.max(...existing.map((s) => s.index)) + 1 : 1;
    const fallbackDuration = existing.length
      ? existing[0].durationSec
      : Math.max(4, Math.round(session.targetDurationSec / Math.max(nextIndex, 1)));
    const requestedId = typeof partial?.id === "string" && /^shot_[A-Za-z0-9_-]+$/.test(partial.id)
      ? partial.id
      : "";
    const shot: Shot = {
      id: requestedId && !this.data.shots.some((item) => item.id === requestedId) ? requestedId : id("shot"),
      sessionId: session.id,
      index: nextIndex,
      title: partial?.title || `Shot ${nextIndex}`,
      script: partial?.script ?? "",
      camera: partial?.camera ?? "",
      durationSec: Math.max(1, Math.min(15, partial?.durationSec || fallbackDuration)),
      assetIds: partial?.assetIds ?? [],
      rawPrompt: partial?.rawPrompt ?? "",
      prompt: partial?.prompt ?? partial?.rawPrompt ?? "",
      debugNote: "",
      seedanceVariant: partial?.seedanceVariant || "standard",
      usePreviousShotClip: false,
      renders: [],
      status: "draft",
      createdAt: ts,
      updatedAt: ts
    };
    this.data.shots.push(shot);
    session.updatedAt = ts;
    await this.save();
    return structuredClone(shot);
  }

  async updateSession(sessionId: string, patch: Partial<Session>) {
    const session = this.data.sessions.find((item) => item.id === sessionId);
    if (!session) return undefined;
    Object.assign(session, patch, { id: session.id, updatedAt: now() });
    await this.save();
    return this.getSession(session.id);
  }

  async createStitchJob(sessionId: string, partial?: Partial<StitchJob>) {
    const session = this.data.sessions.find((item) => item.id === sessionId);
    if (!session) return undefined;
    const ts = now();
    const jobs = session.stitchJobs || [];
    const job: StitchJob = {
      id: partial?.id || id("stitch"),
      name: partial?.name || `拼接 ${jobs.length + 1}`,
      shotIds: partial?.shotIds || [],
      status: partial?.status || "idle",
      createdAt: partial?.createdAt || ts,
      updatedAt: ts
    };
    session.stitchJobs = [...jobs, job];
    session.updatedAt = ts;
    await this.save();
    return this.getSession(session.id);
  }

  async updateStitchJob(sessionId: string, jobId: string, patch: Partial<StitchJob>) {
    const session = this.data.sessions.find((item) => item.id === sessionId);
    if (!session) return undefined;
    const job = (session.stitchJobs || []).find((item) => item.id === jobId);
    if (!job) return undefined;
    Object.assign(job, patch, { id: job.id, updatedAt: now() });
    session.updatedAt = now();
    await this.save();
    return this.getSession(session.id);
  }

  async deleteStitchJob(sessionId: string, jobId: string) {
    const session = this.data.sessions.find((item) => item.id === sessionId);
    if (!session) return undefined;
    session.stitchJobs = (session.stitchJobs || []).filter((item) => item.id !== jobId);
    session.updatedAt = now();
    await this.save();
    return this.getSession(session.id);
  }

  async addTokenUsage(sessionId: string, event: Omit<TokenUsageEvent, "id" | "sessionId" | "createdAt"> & Partial<Pick<TokenUsageEvent, "id" | "createdAt">>) {
    const session = this.data.sessions.find((item) => item.id === sessionId);
    if (!session) return undefined;
    if (!Number.isFinite(event.totalTokens) || event.totalTokens <= 0) return this.getSession(session.id);
    const ts = now();
    const row: TokenUsageEvent = {
      id: event.id || id("tok"),
      sessionId,
      nodeId: event.nodeId,
      nodeType: event.nodeType,
      nodeLabel: event.nodeLabel,
      operation: event.operation,
      provider: event.provider,
      model: event.model,
      modelFamily: event.modelFamily,
      note: event.note,
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      totalTokens: Math.max(0, Math.round(event.totalTokens)),
      rawUsage: event.rawUsage,
      createdAt: event.createdAt || ts
    };
    session.tokenUsageEvents = [...(session.tokenUsageEvents || []), row];
    session.updatedAt = ts;
    await this.save();
    return this.getSession(session.id);
  }

  async clearSessionTokenUsage(sessionId: string) {
    const session = this.data.sessions.find((item) => item.id === sessionId);
    if (!session) return undefined;
    session.tokenUsageEvents = [];
    session.updatedAt = now();
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
        ownerUserId: existing.ownerUserId || this.ownerUserIdForAssetScope(asset),
        mediaKind,
        mediaUrl,
        imageUrl: mediaKind === "image" ? mediaUrl : asset.imageUrl ?? existing.imageUrl,
        updatedAt: ts
      });
      await this.save();
      return structuredClone(existing);
    }

    // Shallow-merge the partial first so newer fields (composedPrompt / composedPromptDraft /
    // parsedShots / parseStatus / parseError etc.) flow through automatically without explicitly
    // listing every one. The explicit defaults below override id, timestamps, and validate the
    // few fields that need normalization (name trimmed, tags array, scope undefined-coerce).
    const created: Asset = {
      ...(asset as Partial<Asset>),
      id: id("asset"),
      ownerUserId: this.ownerUserIdForAssetScope(asset),
      name: asset.name?.trim() || "未命名资产",
      type: asset.type ?? "other",
      mediaKind: asset.mediaKind ?? (asset.imageUrl ? "image" : "none"),
      description: asset.description ?? "",
      prompt: asset.prompt ?? "",
      mediaUrl: asset.mediaUrl ?? asset.imageUrl,
      imageUrl: asset.imageUrl,
      referenceImageUrl: asset.referenceImageUrl,
      tosObjectKey: asset.tosObjectKey,
      tosPublishedAt: asset.tosPublishedAt,
      referenceAssetIds: asset.referenceAssetIds,
      referenceImageUrls: asset.referenceImageUrls,
      generationModel: asset.generationModel,
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

  async restoreAsset(asset: Asset) {
    const restored = structuredClone(asset);
    const index = this.data.assets.findIndex((item) => item.id === restored.id);
    if (index >= 0) this.data.assets[index] = restored;
    else this.data.assets.unshift(restored);
    await this.save();
    return structuredClone(restored);
  }

  async restoreShot(shot: Shot, assets: Asset[] = []) {
    const session = this.data.sessions.find((item) => item.id === shot.sessionId);
    if (!session) return undefined;
    const restoredShot = structuredClone(shot);
    const existingShotIndex = this.data.shots.findIndex((item) => item.id === restoredShot.id);
    if (existingShotIndex >= 0) this.data.shots[existingShotIndex] = restoredShot;
    else this.data.shots.push(restoredShot);

    const restoredAssets: Asset[] = [];
    for (const asset of assets) {
      const restoredAsset = structuredClone(asset);
      const existingAssetIndex = this.data.assets.findIndex((item) => item.id === restoredAsset.id);
      if (existingAssetIndex >= 0) this.data.assets[existingAssetIndex] = restoredAsset;
      else this.data.assets.unshift(restoredAsset);
      restoredAssets.push(structuredClone(restoredAsset));
    }

    session.updatedAt = now();
    await this.save();
    return { session: this.getSession(session.id), assets: restoredAssets };
  }

  async copyGlobalAssetToSession(assetId: string, sessionId: string) {
    const session = this.data.sessions.find((item) => item.id === sessionId);
    if (!session) return undefined;
    const source = this.data.assets.find((item) => item.id === assetId);
    if (!source || source.ownerShotId || source.ownerSessionId) return undefined;

    const existing = this.data.assets.find(
      (item) => !item.ownerShotId && item.ownerSessionId === sessionId && item.parentAssetId === source.id
    );
    if (existing) return structuredClone(existing);

    return this.upsertAsset({
      name: source.name,
      type: source.type,
      mediaKind: source.mediaKind,
      description: source.description,
      prompt: source.prompt,
      mediaUrl: source.mediaUrl,
      imageUrl: source.imageUrl,
      referenceImageUrl: source.referenceImageUrl,
      tosObjectKey: source.tosObjectKey,
      tosPublishedAt: source.tosPublishedAt,
      tags: [...(source.tags ?? [])],
      parentAssetId: source.id,
      referenceAssetIds: source.referenceAssetIds ? [...source.referenceAssetIds] : undefined,
      referenceImageUrls: source.referenceImageUrls ? [...source.referenceImageUrls] : undefined,
      generationModel: source.generationModel,
      generationModelActual: source.generationModelActual,
      generationCredentialSource: source.generationCredentialSource,
      ownerUserId: session.ownerUserId || source.ownerUserId,
      ownerSessionId: sessionId
    });
  }

  async deleteAsset(assetId: string) {
    this.data.assets = this.data.assets.filter((asset) => asset.id !== assetId);
    this.data.shots.forEach((shot) => {
      shot.assetIds = (shot.assetIds || []).filter((id) => id !== assetId);
      shot.subShotStoryboardAssetIds = (shot.subShotStoryboardAssetIds || []).filter((id) => id !== assetId);
      if (shot.subShotStoryboardAssetId === assetId) shot.subShotStoryboardAssetId = undefined;
      if (shot.referenceVideoAssetId === assetId) {
        shot.referenceVideoAssetId = undefined;
        shot.referenceClipUrl = null;
        shot.referenceAudioUrl = null;
        shot.referenceClipPreviewUrl = null;
        shot.referenceAudioPreviewUrl = null;
      }
      if (shot.firstFrameAssetId === assetId) shot.firstFrameAssetId = undefined;
      if (shot.lastFrameAssetId === assetId) shot.lastFrameAssetId = undefined;
      shot.renders = (shot.renders || []).map((render) => ({
        ...render,
        assetIds: (render.assetIds || []).filter((id) => id !== assetId),
        subShotStoryboardAssetId: render.subShotStoryboardAssetId === assetId ? undefined : render.subShotStoryboardAssetId,
        subShotStoryboardAssetIds: (render.subShotStoryboardAssetIds || []).filter((id) => id !== assetId),
        referenceVideoAssetId: render.referenceVideoAssetId === assetId ? undefined : render.referenceVideoAssetId,
        referenceClipUrl: render.referenceVideoAssetId === assetId ? undefined : render.referenceClipUrl,
        referenceAudioUrl: render.referenceVideoAssetId === assetId ? undefined : render.referenceAudioUrl,
        referenceClipPreviewUrl: render.referenceVideoAssetId === assetId ? undefined : render.referenceClipPreviewUrl,
        referenceAudioPreviewUrl: render.referenceVideoAssetId === assetId ? undefined : render.referenceAudioPreviewUrl,
        firstFrameAssetId: render.firstFrameAssetId === assetId ? undefined : render.firstFrameAssetId,
        lastFrameAssetId: render.lastFrameAssetId === assetId ? undefined : render.lastFrameAssetId
      }));
    });
    await this.save();
  }

  async updateShot(shotId: string, patch: Partial<Shot>) {
    const shot = this.data.shots.find((item) => item.id === shotId);
    if (!shot) return undefined;
    // Auto-clear seedancePhase whenever generationTaskId is being cleared OR status leaves the
    // generating state — this keeps the queue/running sub-phase from sticking on the UI after a
    // terminal transition (ready / error / cancelled) without forcing every call site to remember
    // to pass `seedancePhase: undefined` alongside.
    const clearingTask = Object.hasOwn(patch, "generationTaskId") && !patch.generationTaskId;
    const leavingGenerating = Object.hasOwn(patch, "status") && patch.status !== "generating";
    if ((clearingTask || leavingGenerating) && !Object.hasOwn(patch, "seedancePhase")) {
      (patch as Partial<Shot>).seedancePhase = undefined;
    }
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
    const deletedAssetIds = new Set(
      this.data.assets.filter((asset) => asset.ownerShotId === shotId).map((asset) => asset.id)
    );
    const ownerSession = this.data.sessions.find((session) => session.id === shot.sessionId);
    if (ownerSession) {
      let sessionTouched = false;
      if (ownerSession.stitchShotIds?.includes(shotId)) {
        ownerSession.stitchShotIds = ownerSession.stitchShotIds.filter((id) => id !== shotId);
        ownerSession.stitchStatus = "idle";
        ownerSession.stitchError = undefined;
        ownerSession.stitchProgress = "";
        ownerSession.stitchRunningSignature = undefined;
        sessionTouched = true;
      }
      if (ownerSession.stitchJobs?.length) {
        ownerSession.stitchJobs = ownerSession.stitchJobs.map((job) => {
          if (!job.shotIds?.includes(shotId)) return job;
          sessionTouched = true;
          return {
            ...job,
            shotIds: job.shotIds.filter((id) => id !== shotId),
            status: "idle",
            error: undefined,
            progress: "",
            runningSignature: undefined,
            updatedAt: now()
          };
        });
      }
      if (sessionTouched) ownerSession.updatedAt = now();
    }
    this.data.shots = this.data.shots.filter((item) => item.id !== shotId);
    this.data.assets = this.data.assets.filter((asset) => asset.ownerShotId !== shotId);
    this.data.shots.forEach((survivor) => {
      if (survivor.referenceVideoFromShotId === shotId) {
        survivor.referenceVideoFromShotId = undefined;
        survivor.referenceClipUrl = null;
        survivor.referenceAudioUrl = null;
        survivor.referenceClipPreviewUrl = null;
        survivor.referenceAudioPreviewUrl = null;
      }
      survivor.renders = (survivor.renders || []).map((render) => ({
        ...render,
        referenceVideoFromShotId: render.referenceVideoFromShotId === shotId ? undefined : render.referenceVideoFromShotId,
        referenceClipUrl: render.referenceVideoFromShotId === shotId ? undefined : render.referenceClipUrl,
        referenceAudioUrl: render.referenceVideoFromShotId === shotId ? undefined : render.referenceAudioUrl,
        referenceClipPreviewUrl: render.referenceVideoFromShotId === shotId ? undefined : render.referenceClipPreviewUrl,
        referenceAudioPreviewUrl: render.referenceVideoFromShotId === shotId ? undefined : render.referenceAudioPreviewUrl
      }));
      if (!deletedAssetIds.size) return;
      survivor.assetIds = (survivor.assetIds || []).filter((id) => !deletedAssetIds.has(id));
      survivor.subShotStoryboardAssetIds = (survivor.subShotStoryboardAssetIds || []).filter((id) => !deletedAssetIds.has(id));
      if (survivor.subShotStoryboardAssetId && deletedAssetIds.has(survivor.subShotStoryboardAssetId)) {
        survivor.subShotStoryboardAssetId = survivor.subShotStoryboardAssetIds?.[0];
      }
      if (survivor.referenceVideoAssetId && deletedAssetIds.has(survivor.referenceVideoAssetId)) {
        survivor.referenceVideoAssetId = undefined;
        survivor.referenceClipUrl = null;
        survivor.referenceAudioUrl = null;
        survivor.referenceClipPreviewUrl = null;
        survivor.referenceAudioPreviewUrl = null;
      }
      if (survivor.firstFrameAssetId && deletedAssetIds.has(survivor.firstFrameAssetId)) survivor.firstFrameAssetId = undefined;
      if (survivor.lastFrameAssetId && deletedAssetIds.has(survivor.lastFrameAssetId)) survivor.lastFrameAssetId = undefined;
      survivor.renders = (survivor.renders || []).map((render) => ({
        ...render,
        assetIds: (render.assetIds || []).filter((id) => !deletedAssetIds.has(id)),
        subShotStoryboardAssetId: render.subShotStoryboardAssetId && deletedAssetIds.has(render.subShotStoryboardAssetId)
          ? undefined
          : render.subShotStoryboardAssetId,
        subShotStoryboardAssetIds: (render.subShotStoryboardAssetIds || []).filter((id) => !deletedAssetIds.has(id)),
        referenceVideoAssetId: render.referenceVideoAssetId && deletedAssetIds.has(render.referenceVideoAssetId)
          ? undefined
          : render.referenceVideoAssetId,
        referenceClipUrl: render.referenceVideoAssetId && deletedAssetIds.has(render.referenceVideoAssetId) ? undefined : render.referenceClipUrl,
        referenceAudioUrl: render.referenceVideoAssetId && deletedAssetIds.has(render.referenceVideoAssetId) ? undefined : render.referenceAudioUrl,
        referenceClipPreviewUrl: render.referenceVideoAssetId && deletedAssetIds.has(render.referenceVideoAssetId) ? undefined : render.referenceClipPreviewUrl,
        referenceAudioPreviewUrl: render.referenceVideoAssetId && deletedAssetIds.has(render.referenceVideoAssetId) ? undefined : render.referenceAudioPreviewUrl,
        firstFrameAssetId: render.firstFrameAssetId && deletedAssetIds.has(render.firstFrameAssetId) ? undefined : render.firstFrameAssetId,
        lastFrameAssetId: render.lastFrameAssetId && deletedAssetIds.has(render.lastFrameAssetId) ? undefined : render.lastFrameAssetId
      }));
    });
    await this.save();
    return snapshot;
  }

  async updateShotRender(shotId: string, renderId: string, patch: Partial<ShotRender>) {
    const shot = this.data.shots.find((item) => item.id === shotId);
    if (!shot) return undefined;
    const render = (shot.renders || []).find((item) => item.id === renderId);
    if (!render) return structuredClone(shot);
    // Mirror the auto-clear on render: terminal transitions drop seedancePhase.
    const clearingTask = Object.hasOwn(patch, "generationTaskId") && !patch.generationTaskId;
    const leavingGenerating = Object.hasOwn(patch, "status") && patch.status !== "generating";
    if ((clearingTask || leavingGenerating) && !Object.hasOwn(patch, "seedancePhase")) {
      (patch as Partial<ShotRender>).seedancePhase = undefined;
    }
    Object.assign(render, patch, { id: render.id });
    shot.updatedAt = now();
    await this.save();
    return structuredClone(shot);
  }

  async restoreShotRender(shotId: string, renderId: string) {
    const shot = this.data.shots.find((item) => item.id === shotId);
    if (!shot) return undefined;

    const renders = shot.renders || [];
    const target = renders.find((render) => render.id === renderId);
    if (!target) return structuredClone(shot);
    if (!target.videoUrl) {
      throw new Error("Render has no video to restore");
    }

    // Move the target render to the front so the "newest is current" invariant holds.
    shot.renders = [target, ...renders.filter((render) => render.id !== renderId)];
    Object.assign(shot, shotPatchFromRender(target));
    // Restoring an old result clears any in-flight task state.
    shot.generationTaskId = undefined;
    shot.generationStartedAt = undefined;
    shot.error = undefined;

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
        shot.videoGeneratedAt = undefined;
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
    const matchedAssets: Asset[] = [];
    this.data.assets.forEach((asset) => {
      if (!isVisible(asset)) return;
      const aliases = [asset.name, ...(asset.tags ?? [])]
        .map((value) => normalizeMentionText(value))
        .filter(Boolean);
      if (aliases.some((alias) => prompt.includes(`@${alias}`))) matchedAssets.push(asset);
    });
    preferSessionAssets(matchedAssets, shot.sessionId).forEach((asset) => wanted.add(asset.id));
    return structuredClone(this.data.assets.filter((asset) => wanted.has(asset.id)));
  }
}

function normalizeSessionTitle(title: string | undefined, sessions: Session[]) {
  const trimmed = title?.trim();
  if (trimmed) return trimmed;

  const used = new Set<number>();
  sessions.forEach((session) => {
    const match = session.title.trim().match(/^un(?:n)?amed session\s+(\d+)$/i);
    if (match) used.add(Number(match[1]));
  });

  let index = 1;
  while (used.has(index)) index += 1;
  return `unnamed session ${index}`;
}

function normalizeMentionText(value: string) {
  return value.toLowerCase().replace(/\s+/g, "").replace(/／/g, "/").trim();
}

function assetAliases(asset: Asset) {
  return [asset.name, ...(asset.tags ?? [])].map((value) => normalizeMentionText(value)).filter(Boolean);
}

function preferSessionAssets(assets: Asset[], sessionId: string) {
  const sessionAliases = new Set(
    assets
      .filter((asset) => asset.ownerSessionId === sessionId)
      .flatMap((asset) => assetAliases(asset))
  );
  if (!sessionAliases.size) return assets;
  return assets.filter((asset) => asset.ownerSessionId || !assetAliases(asset).some((alias) => sessionAliases.has(alias)));
}

function shotPatchFromRender(render: ShotRender): Partial<Shot> {
  const patch: Partial<Shot> = {
    title: render.title,
    durationSec: render.durationSec,
    seedanceVariant: render.seedanceVariant,
    assetIds: render.assetIds,
    rawPrompt: render.editedRawPrompt || render.rawPrompt,
    prompt: render.editedPrompt || render.editedRawPrompt || render.prompt,
    debugNote: render.note || "",
    videoUrl: render.videoUrl,
    videoGeneratedAt: render.videoGeneratedAt || render.createdAt,
    usePreviousShotClip: render.usePreviousShotClip,
    previousShotClipSec: render.previousShotClipSec,
    previousShotClipSecOverride: render.previousShotClipSecOverride,
    referenceClipUrl: render.referenceClipUrl,
    referenceAudioUrl: render.referenceAudioUrl,
    referenceClipPreviewUrl: render.referenceClipPreviewUrl,
    referenceAudioPreviewUrl: render.referenceAudioPreviewUrl,
    firstFrameAssetId: render.firstFrameAssetId,
    lastFrameAssetId: render.lastFrameAssetId,
    subShotPanelCount: render.subShotPanelCount,
    subShotStoryboardAssetId: render.subShotStoryboardAssetId,
    subShotStoryboardAssetIds: render.subShotStoryboardAssetIds,
    referenceVideoAssetId: render.referenceVideoAssetId,
    referenceVideoFromShotId: render.referenceVideoFromShotId,
    videoReviewStatus: render.videoReviewStatus,
    videoReview: render.videoReview,
    videoReviewError: render.videoReviewError,
    videoReviewUpdatedAt: render.videoReviewUpdatedAt,
    videoReviewBuiltForPrompt: render.videoReviewBuiltForPrompt,
    status: "ready"
  };
  if (render.editedComposedPrompt !== undefined) {
    patch.composedSeedancePromptDraft = render.editedComposedPrompt;
  }
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as Partial<Shot>;
}
