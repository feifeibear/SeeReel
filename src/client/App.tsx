import { Archive, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import type { Asset, AssetType, CreateSessionPayload, Session, Shot, StoreSnapshot } from "../shared/types";
import { FlowView } from "./flow/FlowView";
import { PendingGenerationsProvider } from "./flow/PendingGenerations";
import { useUndoKeyboardShortcut, useUndoStack } from "./flow/useUndoStack";

type AnchorKind = Extract<AssetType, "character" | "scene" | "prop" | "style">;

const initialSession: CreateSessionPayload = {
  title: "",
  logline: "",
  style: "",
  targetDurationSec: 60,
  // 0 → empty canvas; user adds shots via "+ 分镜" / canvas right-click menu.
  shotCount: 0
};

const stripShots = (session: Session & { shots?: Shot[] }): Session => {
  const { shots: _shots, ...rest } = session;
  void _shots;
  return rest;
};

/**
 * Cheap structural-equality check used by `mergeStateById` to decide whether two same-id rows
 * are content-equal. We deep-compare keys but bail early on first miss; for nested arrays we
 * compare by JSON stringify (assets/shots are tiny and rarely have circular refs). This is
 * intentionally NOT a generic deepEqual — it's tuned to the cinema_agent state shape.
 */
function rowEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) if (!rowEqual(a[i], b[i])) return false;
    return true;
  }
  const ak = Object.keys(a as Record<string, unknown>);
  const bk = Object.keys(b as Record<string, unknown>);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!rowEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  }
  return true;
}

/**
 * Take a freshly-fetched `next` snapshot and merge it into `prev`, REUSING the row references
 * from `prev` for every row whose content is unchanged. The arrays themselves are always new
 * (so React sees the top-level state mutation), but unchanged rows keep their identity, which
 * lets node-level React.memo skip rendering and avoids re-mounting <video> / <img> children
 * across polls. Without this, every poll busts every memo and the canvas flickers.
 */
function mergeStateById(prev: StoreSnapshot, next: StoreSnapshot): StoreSnapshot {
  const stableArr = <T extends { id: string }>(prevArr: T[], nextArr: T[]): T[] => {
    const prevById = new Map(prevArr.map((row) => [row.id, row]));
    let changed = prevArr.length !== nextArr.length;
    const out: T[] = nextArr.map((row, i) => {
      const old = prevById.get(row.id);
      if (old && rowEqual(old, row)) return old;
      changed = changed || old !== row;
      return row;
    });
    return changed ? out : prevArr;
  };
  return {
    ...next,
    sessions: stableArr(prev.sessions, next.sessions),
    shots: stableArr(prev.shots, next.shots),
    assets: stableArr(prev.assets, next.assets)
  };
}

const hasPendingShotRender = (shot: Shot) =>
  shot.status === "generating" || (shot.renders || []).some((r) => r.status === "generating");

/**
 * URL-hash-driven session selection. Format: `#/s/<sessionId>`.
 *
 * Why hash and not path: the dev server runs through Vite middleware which doesn't auto-fallback
 * unknown paths to index.html, and we want zero-risk shareable URLs. Hash routing is also
 * server-agnostic — production static export works the same way.
 *
 * `readSessionFromHash` is safe to call during initial state init (returns "" on SSR / no hash).
 * `writeSessionToHash` uses replaceState during the initial sync (so we don't pollute history
 * with the boot-time auto-select) and pushState afterwards (so back/forward navigates between
 * sessions). Caller decides which mode via the `replace` flag.
 */
function readSessionFromHash(): string {
  if (typeof window === "undefined") return "";
  const m = window.location.hash.match(/^#\/s\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : "";
}
function writeSessionToHash(sessionId: string, replace: boolean) {
  if (typeof window === "undefined") return;
  const target = sessionId ? `#/s/${sessionId}` : "";
  // Avoid no-op writes — they trigger a redundant hashchange event we'd then bounce through.
  if (window.location.hash === target) return;
  const url = `${window.location.pathname}${window.location.search}${target}`;
  if (replace) window.history.replaceState(null, "", url);
  else window.history.pushState(null, "", url);
}

export function App() {
  const [state, setState] = useState<StoreSnapshot>({ assets: [], sessions: [], shots: [] });
  const stateRef = useRef(state);
  useEffect(() => { stateRef.current = state; }, [state]);
  // Session id is mirrored to URL hash (#/s/ses_xxx) so each session has a shareable link. Reading
  // it on init means a paste-into-browser of "http://localhost:5173/#/s/ses_abc" boots straight
  // into that session, even before /api/state has loaded.
  const [selectedSessionId, setSelectedSessionId] = useState<string>(() => readSessionFromHash());
  const [sessionTitleDraft, setSessionTitleDraft] = useState("");
  const [showArchivedSessions, setShowArchivedSessions] = useState(false);
  const [busy, setBusy] = useState<string>("");
  const [error, setError] = useState<string>("");
  // Network-status banner: flips to true when api.ts emits "api-network-down" (a fetch threw a
  // TypeError, i.e. the dev server crashed / is restarting / Vite HMR broke the bridge). Cleared
  // by either a successful subsequent request OR our own healthz heartbeat coming back.
  const [serverDown, setServerDown] = useState(false);
  // Client-only optimistic placeholders for in-flight reference-video uploads. They appear on the
  // canvas immediately (so the user sees the node spawn the moment they drop the file) and are
  // removed when the real asset comes back via /state, or on upload error. The placeholder asset
  // carries `tags: ["reference-video", "client-pending-upload"]` so buildGraph routes it to the
  // refvideo pile and ReferenceVideoNode renders an "上传中…" badge instead of "待解析".
  const [pendingUploads, setPendingUploads] = useState<Asset[]>([]);

  // Vision-review (self-critique + retry) is opt-out: default on, persisted in localStorage so the
  // user only flips it once. Off → server skips review entirely; max 5 retries when on.
  const [visionReviewEnabled, setVisionReviewEnabled] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    return window.localStorage.getItem("visionReviewEnabled") !== "false";
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem("visionReviewEnabled", visionReviewEnabled ? "true" : "false");
  }, [visionReviewEnabled]);

  // Canvas-level undo / redo for structural mutations. Cmd+Z / Cmd+Shift+Z are wired below.
  const undoStack = useUndoStack();
  useUndoKeyboardShortcut(undoStack.undo, undoStack.redo);

  const refresh = async () => {
    const next = await api.state();
    setState((prev) => mergeStateById(prev, next));
    setSelectedSessionId((current) => {
      // 1) keep current selection if it still exists (most common path)
      if (current && next.sessions.some((s) => s.id === current)) return current;
      // 2) try the URL hash — covers paste-link-into-browser before state loaded
      const fromHash = readSessionFromHash();
      if (fromHash && next.sessions.some((s) => s.id === fromHash)) return fromHash;
      // 3) fall back to most recent
      return next.sessions[0]?.id || "";
    });
  };

  useEffect(() => {
    refresh().catch((err: Error) => setError(err.message));
  }, []);

  // Mirror selectedSessionId ↔ URL hash so every session has a shareable link.
  // - When the user clicks a session in the sidebar, write hash with pushState (back-button works).
  // - When the user navigates back/forward, hashchange fires and we sync state.
  // The first write after boot uses replaceState so the boot URL doesn't end up as a back-stack entry.
  const initialHashSyncedRef = useRef(false);
  useEffect(() => {
    writeSessionToHash(selectedSessionId, !initialHashSyncedRef.current);
    initialHashSyncedRef.current = true;
  }, [selectedSessionId]);
  useEffect(() => {
    const onHashChange = () => {
      const fromHash = readSessionFromHash();
      if (!fromHash) return;
      setSelectedSessionId((current) => (current === fromHash ? current : fromHash));
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const sessions = state.sessions;
  const latestSession = sessions[0];
  const archivedSessions = sessions.slice(1);
  const selectedSession = sessions.find((session) => session.id === selectedSessionId);
  const shots = useMemo(
    () => state.shots.filter((shot) => shot.sessionId === selectedSessionId).sort((a, b) => a.index - b.index),
    [state.shots, selectedSessionId]
  );

  useEffect(() => {
    setSessionTitleDraft(selectedSession?.title || "");
  }, [selectedSession?.id, selectedSession?.title]);

  const pollShotIdsRef = useRef<string[]>([]);
  const pollInflightRef = useRef<Set<string>>(new Set());
  const generatingIdsKey = useMemo(
    () => state.shots
      .filter((shot) => hasPendingShotRender(shot) || Boolean(shot.generationTaskId))
      .map((shot) => shot.id)
      .sort()
      .join(","),
    [state.shots]
  );

  // Lightweight poll for shots that are mid-generation. Stops automatically once nothing is busy.
  useEffect(() => {
    pollShotIdsRef.current = generatingIdsKey ? generatingIdsKey.split(",") : [];
  }, [generatingIdsKey]);

  useEffect(() => {
    if (!generatingIdsKey) return;
    const tick = () => {
      pollShotIdsRef.current.forEach((shotId) => {
        if (pollInflightRef.current.has(shotId)) return;
        pollInflightRef.current.add(shotId);
        api
          .pollShot(shotId)
          .then((shot) => {
            setState((prev) => ({ ...prev, shots: prev.shots.map((item) => (item.id === shot.id ? shot : item)) }));
          })
          .catch((err: Error) => setError(err.message))
          .finally(() => pollInflightRef.current.delete(shotId));
      });
    };
    tick();
    const timer = window.setInterval(tick, 5000);
    return () => window.clearInterval(timer);
  }, [generatingIdsKey]);

  // Global background snapshot poll — covers everything pollShot doesn't:
  //   - asset image generation that finishes asynchronously (storyboard panels, sketches)
  //   - tail-frame assets created by /api/shots/:id/tailframe
  //   - sub-storyboard regen completing from a different agent / browser tab
  //   - shots in OTHER sessions becoming ready (so when the user switches sessions it's fresh)
  //   - vision-review side effects that don't bump the polled shot itself
  //
  // 5s cadence + visibility gate: when the tab is hidden we pause to avoid burning bandwidth on
  // an unattended tab. mergeStateById preserves row references for unchanged content so this
  // poll doesn't bust node-level memo equality.
  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const tick = async () => {
      if (cancelled) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      try {
        const next = await api.state();
        if (cancelled) return;
        setState((prev) => mergeStateById(prev, next));
      } catch {
        // Network errors flip the api-network-down banner via api.ts; we don't surface here.
      }
    };
    timer = window.setInterval(tick, 5000);
    const onVisible = () => {
      if (document.visibilityState === "visible") void tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  // Network-status banner driver.
  // 1. Listen to api.ts events: a single TypeError (network failure) flips the banner on; any
  //    successful response flips it off. Banner survives across components.
  // 2. While the banner is on, ping /api/healthz every 4s so we recover the moment the dev server
  //    comes back, without the user having to click anything.
  useEffect(() => {
    const onDown = () => setServerDown(true);
    const onUp = () => setServerDown(false);
    window.addEventListener("api-network-down", onDown);
    window.addEventListener("api-network-up", onUp);
    return () => {
      window.removeEventListener("api-network-down", onDown);
      window.removeEventListener("api-network-up", onUp);
    };
  }, []);
  useEffect(() => {
    if (!serverDown) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch("/api/healthz");
        if (!cancelled && r.ok) setServerDown(false);
      } catch {
        // still down, keep polling
      }
    };
    tick();
    const id = window.setInterval(tick, 4000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [serverDown]);

  const run = async (label: string, action: () => Promise<void>) => {
    setBusy(label);
    setError("");
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : "操作失败");
    } finally {
      setBusy("");
    }
  };

  const createSession = () =>
    run("create-session", async () => {
      const session = await api.createSession(initialSession);
      setState((prev) => ({
        ...prev,
        sessions: [stripShots(session), ...prev.sessions],
        shots: [...prev.shots, ...session.shots]
      }));
      setSelectedSessionId(session.id);
      setShowArchivedSessions(false);
    });

  const deleteSession = (session: Session) => {
    const confirmed = window.confirm(`删除 session「${session.title || session.id}」？此操作不可撤销。`);
    if (!confirmed) return;
    run(`delete-session-${session.id}`, async () => {
      await api.deleteSession(session.id);
      await refresh();
    });
  };

  const promoteSession = (session: Session) =>
    run(`promote-session-${session.id}`, async () => {
      const updated = await api.promoteSession(session.id);
      setState((prev) => ({
        ...prev,
        sessions: [stripShots(updated), ...prev.sessions.filter((item) => item.id !== updated.id)]
      }));
      setSelectedSessionId(updated.id);
      setShowArchivedSessions(false);
    });

  const saveSessionTitle = () => {
    if (!selectedSession) return;
    const title = sessionTitleDraft.trim() || selectedSession.title;
    setSessionTitleDraft(title);
    if (title === selectedSession.title) return;
    run(`rename-session-${selectedSession.id}`, async () => {
      const updated = await api.updateSession(selectedSession.id, { title });
      setState((prev) => ({
        ...prev,
        sessions: prev.sessions.map((item) => (item.id === updated.id ? stripShots(updated) : item))
      }));
    });
  };

  const upsertAssetInState = (asset: Asset) => {
    setState((prev) => ({
      ...prev,
      assets: [asset, ...prev.assets.filter((item) => item.id !== asset.id)]
    }));
  };

  const upsertAssetsInState = (assets: Asset[]) => {
    if (!assets.length) return;
    setState((prev) => {
      const incoming = new Map(assets.map((asset) => [asset.id, asset]));
      return {
        ...prev,
        assets: [...assets, ...prev.assets.filter((item) => !incoming.has(item.id))]
      };
    });
  };

  const removeAssetFromState = (assetId: string) => {
    setState((prev) => ({
      ...prev,
      assets: prev.assets.filter((asset) => asset.id !== assetId),
      shots: prev.shots.map((shot) => ({
        ...shot,
        assetIds: (shot.assetIds || []).filter((id) => id !== assetId),
        subShotStoryboardAssetId: shot.subShotStoryboardAssetId === assetId ? undefined : shot.subShotStoryboardAssetId,
        subShotStoryboardAssetIds: (shot.subShotStoryboardAssetIds || []).filter((id) => id !== assetId),
        referenceVideoAssetId: shot.referenceVideoAssetId === assetId ? undefined : shot.referenceVideoAssetId,
        referenceClipUrl: shot.referenceVideoAssetId === assetId ? null : shot.referenceClipUrl,
        firstFrameAssetId: shot.firstFrameAssetId === assetId ? undefined : shot.firstFrameAssetId,
        lastFrameAssetId: shot.lastFrameAssetId === assetId ? undefined : shot.lastFrameAssetId
      }))
    }));
  };

  const upsertShotAndSessionInState = (shot: Shot, session?: Session & { shots?: Shot[] }) => {
    setState((prev) => ({
      ...prev,
      sessions: session
        ? prev.sessions.map((item) => (item.id === session.id ? stripShots(session) : item))
        : prev.sessions,
      shots: prev.shots.some((item) => item.id === shot.id)
        ? prev.shots.map((item) => (item.id === shot.id ? shot : item))
        : [...prev.shots, shot]
    }));
  };

  const removeShotFromState = (shotId: string) => {
    setState((prev) => ({
      ...prev,
      shots: prev.shots.filter((shot) => shot.id !== shotId),
      assets: prev.assets.filter((asset) => asset.ownerShotId !== shotId)
    }));
  };

  const pushAssetCreateUndo = (description: string, payload: Partial<Asset>, created: Asset) => {
    let currentAsset = created;
    undoStack.push({
      description,
      undo: async () => {
        await api.deleteAsset(currentAsset.id);
        removeAssetFromState(currentAsset.id);
        await refresh();
      },
      redo: async () => {
        currentAsset = await api.restoreAsset(currentAsset);
        upsertAssetInState(currentAsset);
        await refresh();
      }
    });
  };

  const pushShotCreateUndo = (created: Shot) => {
    let currentShot = created;
    undoStack.push({
      description: "新建分镜",
      undo: async () => {
        await api.deleteShot(currentShot.id);
        removeShotFromState(currentShot.id);
        await refresh();
      },
      redo: async () => {
        const restored = await api.restoreShot(currentShot);
        currentShot = restored.shot;
        upsertShotAndSessionInState(restored.shot, restored.session);
        await refresh();
      }
    });
  };

  const deleteCanvasAsset = async (asset: Asset) => {
    const label = asset.name || asset.id;
    await api.deleteAsset(asset.id);
    removeAssetFromState(asset.id);
    let deletedAsset = asset;
    const touchedShotPatches = stateRef.current.shots
      .filter((shot) =>
        (shot.assetIds || []).includes(asset.id)
        || shot.subShotStoryboardAssetId === asset.id
        || (shot.subShotStoryboardAssetIds || []).includes(asset.id)
        || shot.referenceVideoAssetId === asset.id
        || shot.firstFrameAssetId === asset.id
        || shot.lastFrameAssetId === asset.id
      )
      .map((shot) => ({
        id: shot.id,
        patch: {
          assetIds: [...(shot.assetIds || [])],
          subShotStoryboardAssetId: shot.subShotStoryboardAssetId,
          subShotStoryboardAssetIds: shot.subShotStoryboardAssetIds ? [...shot.subShotStoryboardAssetIds] : undefined,
          referenceVideoAssetId: shot.referenceVideoAssetId,
          referenceClipUrl: shot.referenceClipUrl ?? null,
          firstFrameAssetId: shot.firstFrameAssetId,
          lastFrameAssetId: shot.lastFrameAssetId
        } satisfies Partial<Shot>
      }));
    undoStack.push({
      description: `删除${label}`,
      undo: async () => {
        deletedAsset = await api.restoreAsset(deletedAsset);
        upsertAssetInState(deletedAsset);
        await Promise.all(touchedShotPatches.map(({ id, patch }) => {
          const current = stateRef.current.shots.find((shot) => shot.id === id);
          const merged: Partial<Shot> = {
            assetIds: Array.from(new Set([...(current?.assetIds || []), ...(patch.assetIds || []).filter((assetId) => assetId === deletedAsset.id)])),
            subShotStoryboardAssetIds: Array.from(new Set([
              ...(current?.subShotStoryboardAssetIds || []),
              ...(patch.subShotStoryboardAssetIds || []).filter((assetId) => assetId === deletedAsset.id)
            ]))
          };
          if (!current?.subShotStoryboardAssetId && patch.subShotStoryboardAssetId === deletedAsset.id) {
            merged.subShotStoryboardAssetId = deletedAsset.id;
          }
          if (!current?.referenceVideoAssetId && patch.referenceVideoAssetId === deletedAsset.id) {
            merged.referenceVideoAssetId = deletedAsset.id;
            merged.referenceClipUrl = patch.referenceClipUrl;
          }
          if (!current?.firstFrameAssetId && patch.firstFrameAssetId === deletedAsset.id) merged.firstFrameAssetId = deletedAsset.id;
          if (!current?.lastFrameAssetId && patch.lastFrameAssetId === deletedAsset.id) merged.lastFrameAssetId = deletedAsset.id;
          return api.updateShot(id, merged);
        }));
        setState((prev) => ({
          ...prev,
          shots: prev.shots.map((shot) => {
            const restored = touchedShotPatches.find((item) => item.id === shot.id);
            if (!restored) return shot;
            const patch = restored.patch;
            const merged: Shot = {
              ...shot,
              assetIds: Array.from(new Set([...(shot.assetIds || []), ...(patch.assetIds || []).filter((assetId) => assetId === deletedAsset.id)])),
              subShotStoryboardAssetIds: Array.from(new Set([
                ...(shot.subShotStoryboardAssetIds || []),
                ...(patch.subShotStoryboardAssetIds || []).filter((assetId) => assetId === deletedAsset.id)
              ]))
            };
            if (!shot.subShotStoryboardAssetId && patch.subShotStoryboardAssetId === deletedAsset.id) merged.subShotStoryboardAssetId = deletedAsset.id;
            if (!shot.referenceVideoAssetId && patch.referenceVideoAssetId === deletedAsset.id) {
              merged.referenceVideoAssetId = deletedAsset.id;
              merged.referenceClipUrl = patch.referenceClipUrl;
            }
            if (!shot.firstFrameAssetId && patch.firstFrameAssetId === deletedAsset.id) merged.firstFrameAssetId = deletedAsset.id;
            if (!shot.lastFrameAssetId && patch.lastFrameAssetId === deletedAsset.id) merged.lastFrameAssetId = deletedAsset.id;
            return merged;
          })
        }));
        await refresh();
      },
      redo: async () => {
        await api.deleteAsset(deletedAsset.id);
        removeAssetFromState(deletedAsset.id);
        await refresh();
      }
    });
    return true;
  };

  const deleteCanvasShot = async (shot: Shot) => {
    if (shot.status === "generating") {
      window.alert("该分镜正在生成中，完成或取消后再删除。");
      return false;
    }
    const label = shot.title || `Shot ${shot.index}`;
    const ownedAssets = state.assets.filter((asset) => asset.ownerShotId === shot.id);
    await api.deleteShot(shot.id);
    removeShotFromState(shot.id);
    let deletedShot = shot;
    let deletedAssets = ownedAssets;
    undoStack.push({
      description: `删除${label}`,
      undo: async () => {
        const restored = await api.restoreShot(deletedShot, deletedAssets);
        deletedShot = restored.shot;
        deletedAssets = restored.assets;
        upsertShotAndSessionInState(restored.shot, restored.session);
        upsertAssetsInState(restored.assets);
        await refresh();
      },
      redo: async () => {
        await api.deleteShot(deletedShot.id);
        removeShotFromState(deletedShot.id);
        await refresh();
      }
    });
    return true;
  };

  // Upload a video file → POST raw bytes to /api/assets/upload-video, then immediately kick off
  // analysis. The asset will be picked up by the next /state refresh and shown as a refvideo node.
  // We also push a synthetic placeholder asset into `pendingUploads` BEFORE the upload starts so
  // the canvas renders a refvideo node immediately — the upload itself can take many seconds for
  // a large mp4 and silently sitting on the file picker is bad UX. The placeholder carries the
  // local object URL as mediaUrl so the user even gets a thumbnail / playable preview while the
  // bytes stream up.
  const uploadReferenceVideo = (file: File) => {
    if (!selectedSession) return undefined;
    setError("");
    const tempId = `pending-ref-video-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const objectUrl = URL.createObjectURL(file);
    const now = new Date().toISOString();
    const placeholder: Asset = {
      id: tempId,
      name: file.name.replace(/\.[^/.]+$/, "") || "上传中视频",
      type: "other",
      mediaKind: "video",
      description: "上传中…",
      prompt: "",
      mediaUrl: objectUrl,
      ownerSessionId: selectedSession.id,
      tags: ["reference-video", "client-pending-upload"],
      parseStatus: "idle",
      createdAt: now,
      updatedAt: now
    };
    setPendingUploads((prev) => [...prev, placeholder]);
    const cleanupPlaceholder = () => {
      setPendingUploads((prev) => prev.filter((a) => a.id !== tempId));
      URL.revokeObjectURL(objectUrl);
    };

    void (async () => {
      try {
        const params = new URLSearchParams({ ownerSessionId: selectedSession.id, filename: file.name });
        const res = await fetch(`/api/assets/upload-video?${params.toString()}`, {
          method: "POST",
          headers: { "Content-Type": file.type || "video/mp4" },
          body: file
        });
        if (!res.ok) {
          const message = await res.text();
          setError(`上传失败：${message}`);
          return;
        }
        const asset = (await res.json()) as Asset;
        // Fire-and-forget analyze; UI shows parseStatus via refresh polling.
        fetch(`/api/assets/${asset.id}/analyze-video`, { method: "POST" }).catch(() => undefined);
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "上传失败");
      } finally {
        // Always drop the placeholder once we've awaited refresh — either the real asset is now in
        // state, or we've already shown the error and the user can retry. Object URL is revoked too
        // so we don't leak the blob across many uploads.
        cleanupPlaceholder();
      }
    })();

    return placeholder;
  };

  return (
    <PendingGenerationsProvider>
    <main className="app-shell">
      {serverDown && (
        <div className="server-down-banner" role="alert">
          <strong>⚠ 服务端不可达</strong>
          <span>后端 dev server 没响应。检查终端是否还在跑 <code>npm run dev</code>，必要时重启。这条会在后端恢复时自动消失。</span>
        </div>
      )}
      <aside className="sidebar">
        <div className="brand">
          <strong>ReelyAI</strong>
          <span>短剧 Agent 工坊</span>
        </div>
        <button className="primary" onClick={createSession} disabled={busy === "create-session"}>
          {busy === "create-session" ? <Loader2 size={16} className="spin" /> : <Plus size={16} />}
          新建 Session
        </button>
        <div className="session-dock">
          <div className="session-list">
            {latestSession && (
              <div className="session-row">
                <button
                  className={`session ${latestSession.id === selectedSessionId ? "active" : ""}`}
                  onClick={() => setSelectedSessionId(latestSession.id)}
                >
                  <span>📽</span>
                  <span>{latestSession.title || "未命名"}</span>
                  <small>{state.shots.filter((s) => s.sessionId === latestSession.id).length} 镜</small>
                </button>
                <button
                  className="session-delete danger"
                  onClick={() => deleteSession(latestSession)}
                  title="删除 session（不可撤销）"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            )}
            {archivedSessions.length > 0 && (
              <button
                className="archive-toggle"
                onClick={() => setShowArchivedSessions((v) => !v)}
              >
                <Archive size={14} />
                <span>历史 session</span>
                <small>{archivedSessions.length}</small>
              </button>
            )}
            {showArchivedSessions && archivedSessions.map((session) => (
              <div key={session.id} className="session-row">
                <button
                  className={`session ${session.id === selectedSessionId ? "active" : ""}`}
                  onClick={() => setSelectedSessionId(session.id)}
                >
                  <span>📂</span>
                  <span>{session.title || "未命名"}</span>
                  <small>{state.shots.filter((s) => s.sessionId === session.id).length} 镜</small>
                </button>
                <button
                  className="session-oneclick"
                  onClick={() => promoteSession(session)}
                  title="置顶到当前"
                  disabled={busy === `promote-session-${session.id}`}
                >
                  ↑
                </button>
                <button
                  className="session-delete danger"
                  onClick={() => deleteSession(session)}
                  title="删除"
                  disabled={busy === `delete-session-${session.id}`}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
            {sessions.length === 0 && <div className="empty-session">点上方「新建 Session」开工</div>}
          </div>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            {selectedSession ? (
              <>
                <input
                  aria-label="Session 名称"
                  className="session-title-input"
                  value={sessionTitleDraft}
                  onChange={(event) => setSessionTitleDraft(event.target.value)}
                  onBlur={saveSessionTitle}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                    if (event.key === "Escape") {
                      setSessionTitleDraft(selectedSession.title);
                      event.currentTarget.blur();
                    }
                  }}
                />
                {/* Shareable per-session link. Copies `<origin>/#/s/<id>` to clipboard so the user
                    can paste it to a teammate / AI agent and they boot directly into this session. */}
                <button
                  type="button"
                  className="session-share"
                  title="复制本 session 的可分享链接"
                  onClick={async () => {
                    const url = `${window.location.origin}${window.location.pathname}#/s/${selectedSession.id}`;
                    try {
                      await navigator.clipboard.writeText(url);
                      setError("");
                      window.dispatchEvent(new CustomEvent<string>("flow-download", { detail: `已复制链接：${url}` }));
                    } catch {
                      window.prompt("复制下面的链接：", url);
                    }
                  }}
                >
                  🔗 复制链接
                </button>
              </>
            ) : (
              <h1>创建一个短片项目</h1>
            )}
          </div>
          <div className="top-actions">
            <label
              className="vision-review-toggle"
              title="开启后：每张资产/分镜图、每条分镜视频生成完会用 vision 模型自审，违背 prompt/参考图就重生，最多 5 次。会消耗额外 token。"
            >
              <input
                type="checkbox"
                checked={visionReviewEnabled}
                onChange={(event) => setVisionReviewEnabled(event.target.checked)}
              />
              <span>自审重试</span>
            </label>
            <button onClick={() => refresh()} title="刷新">
              <RefreshCw size={16} />
            </button>
          </div>
        </header>

        {error && <div className="error">{error}</div>}

        <FlowView
          snapshot={pendingUploads.length ? { ...state, assets: [...state.assets, ...pendingUploads] } : state}
          session={selectedSession ? { ...selectedSession, shots } : undefined}
          visionReviewEnabled={visionReviewEnabled}
          onMutated={() => refresh()}
          undo={undoStack.undo}
          redo={undoStack.redo}
          canUndo={undoStack.canUndo}
          canRedo={undoStack.canRedo}
          undoDescription={undoStack.lastDescription}
          redoDescription={undoStack.nextDescription}
          onPushUndo={undoStack.push}
          onCreateAnchorAsset={async (kind: AnchorKind) => {
            if (!selectedSession) return undefined;
            const seedNames: Record<string, string> = {
              character: "未命名角色",
              scene: "未命名场景",
              prop: "未命名道具",
              style: "未命名风格"
            };
            const seedDescriptions: Record<string, string> = {
              character: "在右侧 Inspector 写清角色身份/外形/服装；先「重新出图」生成参考图，然后从画布拖一根线连到要用它的分镜板。",
              scene: "在右侧 Inspector 写清场景元素/光线/布景；先「重新出图」生成参考图，然后从画布拖一根线连到要用它的分镜板。",
              prop: "在右侧 Inspector 写清道具的造型/材质/关键细节；先「重新出图」生成道具基准图，然后从画布拖一根线连到要用它的分镜板。",
              style: "在右侧 Inspector 写清画面风格/色调/笔触/质感关键词；先「重新出图」生成风格基准图，然后从画布拖一根线连到要用它的分镜板。"
            };
            const payload: Partial<Asset> = {
              name: seedNames[kind],
              type: kind as AssetType,
              description: seedDescriptions[kind],
              prompt: "",
              ownerSessionId: selectedSession.id,
              tags: ["anchor", kind]
            };
            const asset = await api.saveAsset(payload);
            // No auto-attach: user (or AI) decides which shots reference this asset by dragging.
            upsertAssetInState(asset);
            pushAssetCreateUndo(`新建${seedNames[kind].replace("未命名", "")}`, payload, asset);
            return asset;
          }}
          onCreateShot={async () => {
            if (!selectedSession) return undefined;
            const result = await api.appendShot(selectedSession.id);
            upsertShotAndSessionInState(result.shot, result.session);
            pushShotCreateUndo(result.shot);
            return result.shot;
          }}
          onDeleteCanvasAsset={deleteCanvasAsset}
          onDeleteCanvasShot={deleteCanvasShot}
          onUploadImageAsset={async (file, kind) => {
            if (!selectedSession) return undefined;
            const name = file.name.replace(/\.[^/.]+$/, "") || (kind === "character" ? "上传角色" : "上传场景");
            const tags = ["anchor", "uploaded", kind];
            const asset = await api.uploadImageAsset(file, {
              ownerSessionId: selectedSession.id,
              name,
              tags
            });
            const patched = await api.saveAsset({
              id: asset.id,
              type: kind as AssetType,
              description: `从本地拖入的图片，作为${kind === "character" ? "角色" : "场景"}锚使用`,
              tags
            });
            upsertAssetInState(patched);
            pushAssetCreateUndo(kind === "character" ? "上传角色图" : "上传场景图", {
              name,
              type: kind as AssetType,
              description: `从本地拖入的图片，作为${kind === "character" ? "角色" : "场景"}锚使用`,
              prompt: "",
              mediaKind: "image",
              ownerSessionId: selectedSession.id,
              tags
            }, patched);
            return patched;
          }}
          onUploadReferenceVideo={uploadReferenceVideo}
          onStitch={async (options) => {
            if (!selectedSession) return;
            await api.stitch(selectedSession.id, { force: options?.force === true });
            await refresh();
          }}
        />
      </section>
    </main>
    </PendingGenerationsProvider>
  );
}
