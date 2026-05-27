import type {
  Asset,
  AssetImageModel,
  CreateSessionPayload,
  ExpandAssetPromptResult,
  NarrationStrategy,
  SessionWithShots,
  Shot,
  StoryPlan,
  StoreSnapshot
} from "../shared/types";

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options?.headers ?? {})
    }
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<T>;
}

export const api = {
  state: () => request<StoreSnapshot>("/api/state"),
  createSession: (payload: CreateSessionPayload) =>
    request<SessionWithShots>("/api/sessions", { method: "POST", body: JSON.stringify(payload) }),
  updateSession: (sessionId: string, patch: Partial<SessionWithShots>) =>
    request<SessionWithShots>(`/api/sessions/${sessionId}`, { method: "PATCH", body: JSON.stringify(patch) }),
  promoteSession: (sessionId: string) =>
    request<SessionWithShots>(`/api/sessions/${sessionId}/promote`, { method: "POST" }),
  generateScript: (sessionId: string) =>
    request<SessionWithShots>(`/api/sessions/${sessionId}/script/generate`, { method: "POST" }),
  saveScript: (sessionId: string, story: StoryPlan) =>
    request<SessionWithShots>(`/api/sessions/${sessionId}/script`, { method: "PATCH", body: JSON.stringify({ story }) }),
  deleteSession: (sessionId: string) => request<{ ok: true }>(`/api/sessions/${sessionId}`, { method: "DELETE" }),
  saveAsset: (asset: Partial<Asset>) =>
    request<Asset>(asset.id ? `/api/assets/${asset.id}` : "/api/assets", {
      method: asset.id ? "PATCH" : "POST",
      body: JSON.stringify(asset)
    }),
  deleteAsset: (assetId: string) => request<{ ok: true }>(`/api/assets/${assetId}`, { method: "DELETE" }),
  // Promote a session-scoped asset to global. Returns the updated asset row.
  promoteAsset: (assetId: string) =>
    request<Asset>(`/api/assets/${assetId}/promote`, { method: "POST" }),
  expandAssetPrompt: (asset: Partial<Asset>) =>
    request<ExpandAssetPromptResult>("/api/assets/expand-prompt", {
      method: "POST",
      body: JSON.stringify({ asset })
    }),
  generateAsset: (assetId: string, model?: AssetImageModel) =>
    request<Asset>(`/api/assets/${assetId}/generate`, {
      method: "POST",
      body: JSON.stringify({ model })
    }),
  updateShot: (shotId: string, patch: Partial<Shot>) =>
    request<Shot>(`/api/shots/${shotId}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteShotRender: (shotId: string, renderId: string) =>
    request<Shot>(`/api/shots/${shotId}/renders/${renderId}`, { method: "DELETE" }),
  // Generate 1+ shot-scoped sketch assets (private to this shot, cascaded on shot delete).
  generateShotSketches: (
    shotId: string,
    payload?: { prompt?: string; model?: AssetImageModel; count?: number; name?: string }
  ) =>
    request<{ shot: Shot; sketches: Asset[] }>(`/api/shots/${shotId}/sketches`, {
      method: "POST",
      body: JSON.stringify(payload || {})
    }),
  importShotSketch: (
    shotId: string,
    payload: { name?: string; prompt?: string; imageDataUrl?: string; imageUrl?: string }
  ) =>
    request<{ shot: Shot; sketch: Asset }>(`/api/shots/${shotId}/sketches/import`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  publishShotSketchesToTos: (shotId: string) =>
    request<{ shot: Shot; sketches: Asset[] }>(`/api/shots/${shotId}/sketches/publish-tos`, { method: "POST" }),
  publishShotSketchToTos: (shotId: string, assetId: string) =>
    request<{ shot: Shot; sketch: Asset }>(`/api/shots/${shotId}/sketches/${assetId}/publish-tos`, { method: "POST" }),
  publishSessionStoryboardsToTos: (sessionId: string) =>
    request<{ session: SessionWithShots; assets: Asset[] }>(`/api/sessions/${sessionId}/storyboards/publish-tos`, { method: "POST" }),
  deleteShotSketch: (shotId: string, assetId: string) =>
    request<{ ok: true; shot: Shot }>(`/api/shots/${shotId}/sketches/${assetId}`, { method: "DELETE" }),
  storyboard: (sessionId: string) =>
    request<{ session: SessionWithShots; shots: Shot[] }>(`/api/sessions/${sessionId}/storyboard`, { method: "POST" }),
  generateShot: (shotId: string) => request<Shot>(`/api/shots/${shotId}/generate`, { method: "POST" }),
  cancelShot: (shotId: string) => request<Shot>(`/api/shots/${shotId}/cancel`, { method: "POST" }),
  pollShot: (shotId: string) => request<Shot>(`/api/shots/${shotId}/poll`, { method: "POST" }),
  downloadShotUrl: (shotId: string) => `/api/shots/${shotId}/download`,
  downloadSessionUrl: (sessionId: string) => `/api/sessions/${sessionId}/download`,
  /**
   * Triggers a stitch job and resolves only when it terminates (`ready` or `error`).
   *
   * The server `POST /stitch` route is now fire-and-forget: it returns immediately with the
   * current session snapshot (status will typically be `running`). The actual ffmpeg work
   * happens in a background worker that survives any client disconnection. This wrapper polls
   * `POST /stitch/poll` every 3s so existing UI code can keep awaiting a single promise as
   * before, but a transient network hiccup or page navigation no longer aborts the underlying
   * job - the next poll just picks up where the server left off.
   */
  stitch: async (
    sessionId: string,
    onProgress?: (snapshot: SessionWithShots) => void
  ): Promise<SessionWithShots> => {
    const initial = await request<SessionWithShots>(`/api/sessions/${sessionId}/stitch`, { method: "POST" });
    onProgress?.(initial);
    if (initial.stitchStatus === "ready" || initial.finalVideoUrl) return initial;
    if (initial.stitchStatus === "error") {
      throw new Error(initial.stitchError || "Stitch failed");
    }
    return await pollStitch(sessionId, onProgress);
  },
  pollStitchOnce: (sessionId: string) =>
    request<SessionWithShots>(`/api/sessions/${sessionId}/stitch/poll`, { method: "POST" }),
  /**
   * Kick off a narration + subtitle job. Mirrors stitch shape: fire-and-forget on the server,
   * we poll `/narration/poll` every 3s until status leaves `running`.
   */
  narrate: async (
    sessionId: string,
    payload: { script: string; voice?: string; strategy?: NarrationStrategy },
    onProgress?: (snapshot: SessionWithShots) => void
  ): Promise<SessionWithShots> => {
    const initial = await request<SessionWithShots>(`/api/sessions/${sessionId}/narration`, {
      method: "POST",
      body: JSON.stringify(payload)
    });
    onProgress?.(initial);
    if (initial.narrationStatus === "ready") return initial;
    if (initial.narrationStatus === "error") {
      throw new Error(initial.narrationError || "Narration failed");
    }
    return await pollNarration(sessionId, onProgress);
  },
  pollNarrationOnce: (sessionId: string) =>
    request<SessionWithShots>(`/api/sessions/${sessionId}/narration/poll`, { method: "POST" }),
  downloadNarrationVideoUrl: (sessionId: string) => `/api/sessions/${sessionId}/narration/download?kind=video`,
  downloadNarrationSubtitleUrl: (sessionId: string) => `/api/sessions/${sessionId}/narration/download?kind=srt`
};

async function pollStitch(
  sessionId: string,
  onProgress?: (snapshot: SessionWithShots) => void
): Promise<SessionWithShots> {
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const snapshot = await request<SessionWithShots>(`/api/sessions/${sessionId}/stitch/poll`, { method: "POST" });
    onProgress?.(snapshot);
    if (snapshot.stitchStatus === "ready" || snapshot.finalVideoUrl) return snapshot;
    if (snapshot.stitchStatus === "error") {
      throw new Error(snapshot.stitchError || "Stitch failed");
    }
  }
}

async function pollNarration(
  sessionId: string,
  onProgress?: (snapshot: SessionWithShots) => void
): Promise<SessionWithShots> {
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const snapshot = await request<SessionWithShots>(`/api/sessions/${sessionId}/narration/poll`, { method: "POST" });
    onProgress?.(snapshot);
    if (snapshot.narrationStatus === "ready") return snapshot;
    if (snapshot.narrationStatus === "error") {
      throw new Error(snapshot.narrationError || "Narration failed");
    }
  }
}
