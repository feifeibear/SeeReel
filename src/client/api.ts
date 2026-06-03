import type {
  Asset,
  AssetImageModel,
  AdminAgentPlanStatus,
  AgentPlanCredentialStatus,
  CreateSessionPayload,
  ExpandAssetPromptResult,
  NarrationStrategy,
  PromptComposition,
  SessionWithShots,
  Shot,
  StoryPlan,
  StoreSnapshot,
  SubStoryboardModel,
  WorkflowExecutionPlan
} from "../shared/types";
import { networkDownMessage } from "./i18n";

/**
 * Wrapper around fetch with three resilience features:
 *
 *  1. **Network-error retry**: a "Failed to fetch" / TypeError (server restart, brief Vite HMR
 *     blip, transient TCP reset) used to surface to the user as a hard error toast. We now retry
 *     once after a 600ms backoff for safe-idempotent verbs (GET / HEAD); other verbs still bubble
 *     up so the user sees what their action did or didn't do.
 *  2. **Banner event**: on a network-level failure (not a 4xx/5xx — those are real server-side
 *     decisions) we emit `window`-level `api-network-down` / `api-network-up` events so a banner
 *     in the shell can show "服务端不可达" and auto-clear when it comes back.
 *  3. **Better error messages**: `Failed to fetch` becomes "网络中断 / 服务端可能挂了 — 重启后再试一次"
 *     so the user knows the action is to restart the dev server, not retry the same click.
 */
const ACCESS_TOKEN_STORAGE_KEY = "reelyai_access_token";

function readAccessToken() {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(ACCESS_TOKEN_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

/**
 * Prompt the operator once for the shared access token and persist it. Used only when the backend
 * has `REELYAI_ACCESS_TOKEN` configured and answers 401; local dev without the env never hits this.
 */
function promptForAccessToken() {
  if (typeof window === "undefined") return "";
  const entered = window.prompt("需要访问令牌（access token）才能继续。请粘贴部署方提供的 token：")?.trim() || "";
  if (entered) {
    try {
      window.localStorage.setItem(ACCESS_TOKEN_STORAGE_KEY, entered);
    } catch {
      /* ignore storage failures */
    }
  }
  return entered;
}

function accessHeaders(): Record<string, string> {
  const token = readAccessToken();
  return token ? { "x-reelyai-access": token } : {};
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const method = (options?.method || "GET").toUpperCase();
  const idempotent = method === "GET" || method === "HEAD";
  let lastErr: unknown;
  let promptedForToken = false;
  for (let attempt = 0; attempt < (idempotent ? 2 : 1); attempt++) {
    try {
      const response = await fetch(url, {
        ...options,
        headers: {
          "Content-Type": "application/json",
          ...accessHeaders(),
          ...(options?.headers ?? {})
        }
      });
      // We got a response — server is alive even if it returned 5xx. Clear any down-banner.
      if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("api-network-up"));
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        // The shared access gate rejected us: prompt once for the token and retry this request.
        if (response.status === 401 && body?.code === "access_token_required" && !promptedForToken) {
          promptedForToken = true;
          if (promptForAccessToken()) {
            attempt -= 1;
            continue;
          }
        }
        throw new Error(body.error || `${response.status} ${response.statusText}`);
      }
      return response.json() as Promise<T>;
    } catch (err) {
      lastErr = err;
      // TypeError on fetch is "network down / server crashed / Vite HMR mid-restart". For
      // idempotent verbs we wait briefly and try once more before giving up. Non-idempotent verbs
      // (POST / PATCH / PUT / DELETE) skip retry — re-running them might double-create resources.
      const isNetworkError = err instanceof TypeError;
      if (isNetworkError) {
        if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("api-network-down"));
        if (idempotent && attempt === 0) {
          await new Promise((r) => setTimeout(r, 600));
          continue;
        }
        throw new Error(networkDownMessage());
      }
      throw err;
    }
  }
  throw lastErr;
}

export const api = {
  state: () => request<StoreSnapshot>("/api/state"),
  agentPlanCredential: () => request<AgentPlanCredentialStatus>("/api/credentials/agent-plan"),
  saveAgentPlanCredential: (apiKey: string) =>
    request<AgentPlanCredentialStatus>("/api/credentials/agent-plan", {
      method: "POST",
      body: JSON.stringify({ apiKey })
    }),
  clearAgentPlanCredential: () =>
    request<AgentPlanCredentialStatus>("/api/credentials/agent-plan", { method: "DELETE" }),
  adminLogin: (payload: { username: string; password: string }) =>
    request<{ ok: true; adminAgentPlan: AdminAgentPlanStatus }>("/api/admin/login", {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  adminSettings: () =>
    request<{ adminAgentPlan: AdminAgentPlanStatus }>("/api/admin/settings"),
  saveAdminAgentPlan: (apiKey: string) =>
    request<{ adminAgentPlan: AdminAgentPlanStatus }>("/api/admin/settings/agent-plan", {
      method: "PUT",
      body: JSON.stringify({ apiKey })
    }),
  clearAdminAgentPlan: () =>
    request<{ adminAgentPlan: AdminAgentPlanStatus }>("/api/admin/settings/agent-plan", { method: "DELETE" }),
  adminLogout: () => request<{ ok: true }>("/api/admin/logout", { method: "POST" }),
  createSession: (payload: CreateSessionPayload) =>
    request<SessionWithShots>("/api/sessions", { method: "POST", body: JSON.stringify(payload) }),
  updateSession: (sessionId: string, patch: Partial<SessionWithShots>) =>
    request<SessionWithShots>(`/api/sessions/${sessionId}`, { method: "PATCH", body: JSON.stringify(patch) }),
  clearTokenUsage: (sessionId: string) =>
    request<SessionWithShots>(`/api/sessions/${sessionId}/token-usage`, { method: "DELETE" }),
  createStitchJob: (sessionId: string, job?: Partial<import("../shared/types").StitchJob>) =>
    request<SessionWithShots>(`/api/sessions/${sessionId}/stitch-jobs`, {
      method: "POST",
      body: JSON.stringify(job || {})
    }),
  updateStitchJob: (sessionId: string, jobId: string, patch: Partial<import("../shared/types").StitchJob>) =>
    request<SessionWithShots>(`/api/sessions/${sessionId}/stitch-jobs/${jobId}`, {
      method: "PATCH",
      body: JSON.stringify(patch)
    }),
  deleteStitchJob: (sessionId: string, jobId: string) =>
    request<SessionWithShots>(`/api/sessions/${sessionId}/stitch-jobs/${jobId}`, { method: "DELETE" }),
  promoteSession: (sessionId: string) =>
    request<SessionWithShots>(`/api/sessions/${sessionId}/promote`, { method: "POST" }),
  generateScript: (sessionId: string) =>
    request<SessionWithShots>(`/api/sessions/${sessionId}/script/generate`, { method: "POST" }),
  saveScript: (sessionId: string, story: StoryPlan) =>
    request<SessionWithShots>(`/api/sessions/${sessionId}/script`, { method: "PATCH", body: JSON.stringify({ story }) }),
  generateCast: (sessionId: string, payload?: { characters?: string[] }) =>
    request<{ session: SessionWithShots; assets: Asset[] }>(`/api/sessions/${sessionId}/cast`, {
      method: "POST",
      body: JSON.stringify(payload || {})
    }),
  deleteSession: (sessionId: string) => request<{ ok: true }>(`/api/sessions/${sessionId}`, { method: "DELETE" }),
  saveAsset: (asset: Partial<Asset>) =>
    request<Asset>(asset.id ? `/api/assets/${asset.id}` : "/api/assets", {
      method: asset.id ? "PATCH" : "POST",
      body: JSON.stringify(asset)
    }),
  deleteAsset: (assetId: string) => request<{ ok: true }>(`/api/assets/${assetId}`, { method: "DELETE" }),
  uploadImageAsset: (file: File, payload: { ownerSessionId?: string; name?: string; tags?: string[] }) => {
    const params = new URLSearchParams();
    if (payload.ownerSessionId) params.set("ownerSessionId", payload.ownerSessionId);
    params.set("filename", file.name);
    if (payload.name) params.set("name", payload.name);
    if (payload.tags?.length) params.set("tags", payload.tags.join(","));
    return request<Asset>(`/api/assets/upload-image?${params.toString()}`, {
      method: "POST",
      headers: { "Content-Type": file.type || "application/octet-stream" },
      body: file
    });
  },
  restoreAsset: (asset: Asset) =>
    request<Asset>("/api/assets/restore", { method: "POST", body: JSON.stringify({ asset }) }),
  deleteShot: (shotId: string) => request<{ ok: true; shotId: string }>(`/api/shots/${shotId}`, { method: "DELETE" }),
  restoreShot: (shot: Shot, assets?: Asset[]) =>
    request<{ shot: Shot; session: SessionWithShots; assets: Asset[] }>("/api/shots/restore", {
      method: "POST",
      body: JSON.stringify({ shot, assets: assets || [] })
    }),
  downloadAssetUrl: (assetId: string) => `/api/assets/${assetId}/download`,
  /** Re-condense a reference-video asset with a new strategy (trim / speedup / sample-concat). */
  reclipReferenceVideo: (assetId: string, strategy: "sample-concat" | "trim" | "speedup") =>
    request<{ asset: Asset; note: string }>(`/api/assets/${assetId}/reclip`, {
      method: "POST",
      body: JSON.stringify({ strategy })
    }),
  /** Create a NEW asset that is a clipped derivative of an existing reference-video asset. */
  deriveClip: (sourceAssetId: string, strategy: "sample-concat" | "trim" | "speedup" = "trim") =>
    request<{ asset: Asset; note: string }>(`/api/assets/${sourceAssetId}/derive-clip`, {
      method: "POST",
      body: JSON.stringify({ strategy })
    }),
  // Promote a session-scoped asset to global. Returns the updated asset row.
  promoteAsset: (assetId: string) =>
    request<Asset>(`/api/assets/${assetId}/promote`, { method: "POST" }),
  repairAssetPromptFromReview: (assetId: string) =>
    request<Asset>(`/api/assets/${assetId}/review/repair-prompt`, { method: "POST" }),
  reviewAssetImage: (assetId: string) =>
    request<Asset>(`/api/assets/${assetId}/review`, { method: "POST" }),
  copyAssetToSession: (sessionId: string, assetId: string) =>
    request<Asset>(`/api/sessions/${sessionId}/assets/${assetId}/copy`, { method: "POST" }),
  expandAssetPrompt: (asset: Partial<Asset>) =>
    request<ExpandAssetPromptResult>("/api/assets/expand-prompt", {
      method: "POST",
      body: JSON.stringify({ asset })
    }),
  generateAsset: (
    assetId: string,
    model?: AssetImageModel,
    opts?: { visionReview?: boolean; composedPrompt?: string }
  ) =>
    request<Asset>(`/api/assets/${assetId}/generate`, {
      method: "POST",
      body: JSON.stringify({ model, ...(opts ?? {}) })
    }),
  /** Returns the Seedream prompt the server WOULD assemble for this asset, without calling Seedream. */
  dryRunAssetSeedreamPrompt: (assetId: string) =>
    request<PromptComposition>(`/api/assets/${assetId}/generate`, {
      method: "POST",
      body: JSON.stringify({ dryRun: true })
    }),
  updateShot: (shotId: string, patch: Partial<Shot>) =>
    request<Shot>(`/api/shots/${shotId}`, { method: "PATCH", body: JSON.stringify(patch) }),
  /** Append a single shot to an existing session — used by the canvas "新建分镜镜头" flow. */
  appendShot: (sessionId: string, payload?: { title?: string; durationSec?: number; rawPrompt?: string }) =>
    request<{ shot: Shot; session: SessionWithShots }>(`/api/sessions/${sessionId}/shots`, {
      method: "POST",
      body: JSON.stringify(payload || {})
    }),
  deleteShotRender: (shotId: string, renderId: string) =>
    request<Shot>(`/api/shots/${shotId}/renders/${renderId}`, { method: "DELETE" }),
  restoreShotRender: (shotId: string, renderId: string) =>
    request<Shot>(`/api/shots/${shotId}/renders/${renderId}/restore`, { method: "POST" }),
  createShotTailFrame: (shotId: string, opts?: { publishToTos?: boolean; canvasNode?: boolean }) =>
    request<{ asset: Asset }>(`/api/shots/${shotId}/tailframe`, {
      method: "POST",
      body: JSON.stringify(opts || {})
    }),
  // Generate 1+ shot-scoped sketch assets (private to this shot, cascaded on shot delete).
  generateShotSketches: (
    shotId: string,
    payload?: { prompt?: string; model?: AssetImageModel; count?: number; name?: string; visionReview?: boolean }
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
  planWorkflow: (sessionId: string, opts?: { mode?: "missing" | "all"; maxParallelShots?: number }) =>
    request<WorkflowExecutionPlan>(`/api/sessions/${sessionId}/workflow/plan`, {
      method: "POST",
      body: JSON.stringify(opts || {})
    }),
  generateShot: (
    shotId: string,
    opts?: { visionReview?: boolean; composedPrompt?: string }
  ) =>
    request<Shot>(`/api/shots/${shotId}/generate`, {
      method: "POST",
      body: JSON.stringify(opts ?? {})
    }),
  /** Dry-run the Seedance text content this shot would submit. */
  dryRunShotSeedancePrompt: (shotId: string) =>
    request<PromptComposition>(`/api/shots/${shotId}/generate`, {
      method: "POST",
      body: JSON.stringify({ dryRun: true })
    }),
  /** Generate the sub-storyboard grid (single composite image) for one shot. */
  subStoryboardGenerate: (
    shotId: string,
    opts: {
      scenePrompt: string;
      panelCount?: number;
      layout?: string;
      size?: string;
      referenceAssetIds?: string[];
      composedPrompt?: string;
      /** Optional Seedream variant: "seedream-4", "seedream-4-5", or "seedream-5-lite". Defaults to the shot's saved variant. */
      model?: SubStoryboardModel;
      /**
       * `composite` (default) — one Seedream group call returns ONE composite image with N
       * panels. Fast, cheaper, but Seedream chooses cell→beat assignment so order can shuffle.
       * `sequential` — N separate single-image calls (each conditioning on the previous panel),
       * then ffmpeg-tile into a composite. N× the Seedream cost; guarantees beat order = panels[i].
       */
      mode?: "composite" | "sequential";
      /**
       * Per-panel beat prompts. Required when `mode === "sequential"`. When omitted in sequential
       * mode the server splits `scenePrompt` by Beat A/B/C / Frame 1/2/3 / 节拍 markers.
       */
      panels?: Array<{ prompt: string }>;
      /** Server-side panel size for sequential mode (must be WxH at ≥3,686,400 pixels for Seedream). */
      panelSize?: string;
    }
  ) =>
    request<{
      shot: Shot;
      asset: Asset;
      grid: { panelCount: number; layout: string; size: string; model: string; usage?: unknown; mode?: string; panelUrls?: string[] };
      composedPrompt: string;
      referenceImageUrls: string[];
      referenceAssetIds?: string[];
      skippedReferences?: Array<{ assetId: string; name: string; reason: string; url?: string }>;
    }>(`/api/shots/${shotId}/sub-storyboard`, {
      method: "POST",
      body: JSON.stringify(opts)
    }),
  /** Dry-run a sub-storyboard call: returns the Seedream prompt + the resolved reference image list. */
  subStoryboardDryRun: (
    shotId: string,
    opts: {
      scenePrompt: string;
      panelCount?: number;
      layout?: string;
      referenceAssetIds?: string[];
    }
  ) =>
    request<PromptComposition & {
      referenceImageUrls: string[];
      referenceAssetIds: string[];
      skippedReferences?: Array<{ assetId: string; name: string; reason: string; url?: string }>;
    }>(
      `/api/shots/${shotId}/sub-storyboard`,
      {
        method: "POST",
        body: JSON.stringify({ ...opts, dryRun: true })
      }
    ),
  cancelShot: (shotId: string) => request<Shot>(`/api/shots/${shotId}/cancel`, { method: "POST" }),
  reviewShotVideo: (shotId: string) => request<Shot>(`/api/shots/${shotId}/review`, { method: "POST" }),
  repairShotPromptsFromReview: (shotId: string) =>
    request<{ shot: Shot; plan: unknown }>(`/api/shots/${shotId}/review/repair-prompts`, { method: "POST" }),
  pollShot: (shotId: string) => request<Shot>(`/api/shots/${shotId}/poll`, { method: "POST" }),
  downloadShotUrl: (shotId: string) => `/api/shots/${shotId}/download`,
  downloadSessionUrl: (sessionId: string, jobId?: string) =>
    `/api/sessions/${sessionId}/download${jobId ? `?jobId=${encodeURIComponent(jobId)}` : ""}`,
  /** Lazy first-frame JPEG for a shot's video (server caches after first call). */
  shotPosterUrl: (shotId: string, version?: string) => `/api/shots/${shotId}/poster.jpg${version ? `?v=${encodeURIComponent(version)}` : ""}`,
  /** Lazy first-frame JPEG for the session's stitched final video. */
  sessionPosterUrl: (sessionId: string, version?: string, jobId?: string) => {
    const params = new URLSearchParams();
    if (version) params.set("v", version);
    if (jobId) params.set("jobId", jobId);
    const suffix = params.toString();
    return `/api/sessions/${sessionId}/poster.jpg${suffix ? `?${suffix}` : ""}`;
  },
  /** Inline-streaming video URLs for `<video>` elements. Always same-origin and Range-friendly,
   * which avoids the cross-origin / CORS / presigned-URL-expiry pitfalls of TOS / Seedance URLs. */
  shotStreamUrl: (shotId: string, version?: string) => `/api/shots/${shotId}/stream.mp4${version ? `?v=${encodeURIComponent(version)}` : ""}`,
  sessionStreamUrl: (sessionId: string, version?: string, jobId?: string) => {
    const params = new URLSearchParams();
    if (version) params.set("v", version);
    if (jobId) params.set("jobId", jobId);
    const suffix = params.toString();
    return `/api/sessions/${sessionId}/stream.mp4${suffix ? `?${suffix}` : ""}`;
  },
  assetPosterUrl: (assetId: string, version?: string) => `/api/assets/${assetId}/poster.jpg${version ? `?v=${encodeURIComponent(version)}` : ""}`,
  assetStreamUrl: (assetId: string, version?: string) => `/api/assets/${assetId}/stream.mp4${version ? `?v=${encodeURIComponent(version)}` : ""}`,
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
    options?: { force?: boolean; jobId?: string },
    onProgress?: (snapshot: SessionWithShots) => void
  ): Promise<SessionWithShots> => {
    const initial = await request<SessionWithShots>(`/api/sessions/${sessionId}/stitch`, {
      method: "POST",
      body: JSON.stringify({ force: options?.force === true, jobId: options?.jobId })
    });
    onProgress?.(initial);
    const getJob = (snapshot: SessionWithShots) => options?.jobId
      ? snapshot.stitchJobs?.find((job) => job.id === options.jobId)
      : undefined;
    const initialJob = getJob(initial);
    if (initialJob) {
      if (initialJob.status === "ready") return initial;
      if (initialJob.status === "error") throw new Error(initialJob.error || "Stitch failed");
    } else {
      if (initial.stitchStatus === "ready") return initial;
      if (initial.stitchStatus === "error") {
        throw new Error(initial.stitchError || "Stitch failed");
      }
    }
    return await pollStitch(sessionId, options?.jobId, onProgress);
  },
  pollStitchOnce: (sessionId: string) =>
    request<SessionWithShots>(`/api/sessions/${sessionId}/stitch/poll`, { method: "POST" }),
  reviewFinalVideo: (sessionId: string, jobId?: string) =>
    request<SessionWithShots>(`/api/sessions/${sessionId}/final-review`, {
      method: "POST",
      body: JSON.stringify({ jobId })
    }),
  repairFinalPromptsFromReview: (sessionId: string, jobId?: string) =>
    request<SessionWithShots>(`/api/sessions/${sessionId}/final-review/repair-prompts`, {
      method: "POST",
      body: JSON.stringify({ jobId })
    }),
  /**
   * Kick off a voiceover-only narration job. Mirrors stitch shape: fire-and-forget on the server,
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
  downloadNarrationVideoUrl: (sessionId: string) => `/api/sessions/${sessionId}/narration/download?kind=video`
};

async function pollStitch(
  sessionId: string,
  jobId?: string,
  onProgress?: (snapshot: SessionWithShots) => void
): Promise<SessionWithShots> {
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const snapshot = await request<SessionWithShots>(`/api/sessions/${sessionId}/stitch/poll`, { method: "POST" });
    onProgress?.(snapshot);
    if (jobId) {
      const job = snapshot.stitchJobs?.find((item) => item.id === jobId);
      if (job?.status === "ready") return snapshot;
      if (job?.status === "error") throw new Error(job.error || "Stitch failed");
      continue;
    }
    if (snapshot.stitchStatus === "ready") return snapshot;
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
