import { Archive, BarChart3, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import type { Asset, AssetType, CreateSessionPayload, Session, Shot, StitchJob, StoreSnapshot, TokenUsageEvent, TokenUsageModelFamily } from "../shared/types";
import { FlowView } from "./flow/FlowView";
import { PendingGenerationsProvider } from "./flow/PendingGenerations";
import { useUndoKeyboardShortcut, useUndoStack } from "./flow/useUndoStack";
import { useI18n } from "./i18n";

type AnchorKind = Extract<AssetType, "character" | "scene" | "prop" | "style">;

type TokenUsageNodeSummary = {
  nodeId: string;
  nodeType: TokenUsageEvent["nodeType"];
  nodeLabel: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  events: TokenUsageEvent[];
};

type TrackedTokenUsageModelFamily = Extract<TokenUsageModelFamily, "seedream-4" | "seedream-4-5" | "seedream-5-lite" | "seedance-2-0" | "seedance-2-0-fast">;

type TokenUsageFamilyTotal = {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  events: number;
};

const tokenUsageFamilies: Array<{ key: TrackedTokenUsageModelFamily; label: string }> = [
  { key: "seedream-4", label: "Seedream 4" },
  { key: "seedream-4-5", label: "Seedream 4.5" },
  { key: "seedream-5-lite", label: "Seedream 5 Lite" },
  { key: "seedance-2-0", label: "Seedance 2.0" },
  { key: "seedance-2-0-fast", label: "Seedance 2.0 Fast" }
];

type CapturedStitchRefs = {
  legacy?: string[];
  jobs: Array<{ id: string; shotIds: string[] }>;
};

function captureStitchRefs(session: Session | undefined, shotId: string): CapturedStitchRefs {
  return {
    legacy: session?.stitchShotIds?.includes(shotId) ? [...session.stitchShotIds] : undefined,
    jobs: (session?.stitchJobs || [])
      .filter((job) => job.shotIds?.includes(shotId))
      .map((job) => ({ id: job.id, shotIds: [...job.shotIds] }))
  };
}

async function restoreStitchRefs(sessionId: string, refs: CapturedStitchRefs) {
  const updates: Promise<unknown>[] = [];
  if (refs.legacy) {
    updates.push(api.updateSession(sessionId, {
      stitchShotIds: refs.legacy,
      stitchStatus: "idle",
      stitchError: "",
      stitchProgress: ""
    }));
  }
  refs.jobs.forEach((job) => {
    updates.push(api.updateStitchJob(sessionId, job.id, {
      shotIds: job.shotIds,
      status: "idle",
      error: "",
      progress: ""
    } as Partial<StitchJob>));
  });
  await Promise.all(updates);
}

function formatMTokens(tokens: number) {
  const value = tokens / 1_000_000;
  if (value === 0) return "0.000 M";
  if (value < 0.001) return "<0.001 M";
  return `${value.toFixed(value >= 1 ? 2 : 3)} M`;
}

function summarizeTokenUsage(events: TokenUsageEvent[] | undefined): TokenUsageNodeSummary[] {
  const map = new Map<string, TokenUsageNodeSummary>();
  (events || []).forEach((event) => {
    const key = `${event.nodeType}:${event.nodeId}`;
    const existing = map.get(key) || {
      nodeId: event.nodeId,
      nodeType: event.nodeType,
      nodeLabel: event.nodeLabel || event.nodeId,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      events: []
    };
    existing.totalTokens += event.totalTokens || 0;
    existing.inputTokens += event.inputTokens || 0;
    existing.outputTokens += event.outputTokens || 0;
    existing.events.push(event);
    map.set(key, existing);
  });
  return [...map.values()].sort((a, b) => b.totalTokens - a.totalTokens);
}

function emptyTokenUsageFamilyTotals() {
  return Object.fromEntries(tokenUsageFamilies.map((family) => [
    family.key,
    { totalTokens: 0, inputTokens: 0, outputTokens: 0, events: 0 }
  ])) as Record<TrackedTokenUsageModelFamily, TokenUsageFamilyTotal>;
}

function inferTokenUsageFamily(event: TokenUsageEvent): TokenUsageModelFamily {
  if (event.modelFamily) return event.modelFamily;
  const model = (event.model || "").toLowerCase();
  const provider = (event.provider || "").toLowerCase();
  if (
    model.includes("seedream-5-lite") ||
    model.includes("seedream_5_lite") ||
    model.includes("seedream-5.0-lite") ||
    model.includes("seedream5lite") ||
    model.includes("doubao-seedream-5.0-lite")
  ) return "seedream-5-lite";
  if (model.includes("seedream-4-5") || model.includes("seedream_4_5") || model.includes("seedream4.5")) return "seedream-4-5";
  if (model.includes("seedream-4") || model.includes("seedream_4") || model.includes("seedream4") || provider === "seedream") return "seedream-4";
  if (model.includes("fast") && (model.includes("seedance") || provider === "seedance")) return "seedance-2-0-fast";
  if (model.includes("seedance") || provider === "seedance") return "seedance-2-0";
  return "other";
}

function summarizeTokenUsageFamilies(events: TokenUsageEvent[] | undefined) {
  const totals = emptyTokenUsageFamilyTotals();
  (events || []).forEach((event) => {
    const family = inferTokenUsageFamily(event);
    if (!tokenUsageFamilies.some((item) => item.key === family)) return;
    const item = totals[family as TrackedTokenUsageModelFamily];
    item.totalTokens += event.totalTokens || 0;
    item.inputTokens += event.inputTokens || 0;
    item.outputTokens += event.outputTokens || 0;
    item.events += 1;
  });
  return totals;
}

function trackedTokenTotal(events: TokenUsageEvent[] | undefined) {
  const totals = summarizeTokenUsageFamilies(events);
  return tokenUsageFamilies.reduce((sum, family) => sum + totals[family.key].totalTokens, 0);
}

function TokenUsagePanel({
  events,
  sessions,
  selectedSessionId,
  onClear,
  busy
}: {
  events?: TokenUsageEvent[];
  sessions: Session[];
  selectedSessionId?: string;
  onClear: () => void;
  busy: boolean;
}) {
  const { t } = useI18n();
  const summaries = summarizeTokenUsage(events);
  const familyTotals = summarizeTokenUsageFamilies(events);
  const trackedInput = tokenUsageFamilies.reduce((sum, family) => sum + familyTotals[family.key].inputTokens, 0);
  const trackedOutput = tokenUsageFamilies.reduce((sum, family) => sum + familyTotals[family.key].outputTokens, 0);
  const trackedEvents = tokenUsageFamilies.reduce((sum, family) => sum + familyTotals[family.key].events, 0);
  const sessionRows = sessions
    .map((session) => ({
      session,
      families: summarizeTokenUsageFamilies(session.tokenUsageEvents),
      totalTokens: trackedTokenTotal(session.tokenUsageEvents)
    }))
    .filter((row) => row.totalTokens > 0 || row.session.id === selectedSessionId)
    .sort((a, b) => Number(b.session.id === selectedSessionId) - Number(a.session.id === selectedSessionId) || b.totalTokens - a.totalTokens);
  return (
    <div className="token-usage-panel">
      <div className="token-usage-head">
        <div>
          <strong>{formatMTokens(trackedTokenTotal(events))} tracked tokens</strong>
          <small>{t.token.summary(formatMTokens(trackedInput), formatMTokens(trackedOutput), trackedEvents)}</small>
        </div>
        <button
          type="button"
          className="danger"
          onClick={onClear}
          disabled={busy || !events?.length}
          title={t.token.clearTitle}
        >
          {t.token.clear}
        </button>
      </div>
      <div className="token-family-grid">
        {tokenUsageFamilies.map((family) => {
          const item = familyTotals[family.key];
          return (
            <div className="token-family-card" key={family.key}>
              <small>{family.label}</small>
              <strong>{formatMTokens(item.totalTokens)}</strong>
              <span>{t.token.calls(item.events)}</span>
            </div>
          );
        })}
      </div>
      <div className="token-session-table-wrap">
        <table className="token-session-table">
          <thead>
            <tr>
              <th>Session</th>
              {tokenUsageFamilies.map((family) => <th key={family.key}>{family.label}</th>)}
              <th>{t.token.total}</th>
            </tr>
          </thead>
          <tbody>
            {sessionRows.length ? sessionRows.map((row) => (
              <tr key={row.session.id} className={row.session.id === selectedSessionId ? "active" : ""}>
                <td>{row.session.title || row.session.id}</td>
                {tokenUsageFamilies.map((family) => (
                  <td key={family.key}>{formatMTokens(row.families[family.key].totalTokens)}</td>
                ))}
                <td>{formatMTokens(row.totalTokens)}</td>
              </tr>
            )) : (
              <tr>
                <td colSpan={tokenUsageFamilies.length + 2}>{t.token.noTrackedFamilies}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {summaries.length ? (
        <div className="token-usage-list">
          {summaries.map((item) => {
            const latest = item.events[item.events.length - 1];
            return (
              <div className="token-usage-row" key={`${item.nodeType}:${item.nodeId}`}>
                <div>
                  <strong>{item.nodeLabel}</strong>
                  <small>{item.nodeType} · {t.token.recentOp(item.events.length, latest.operation)}{latest.model ? ` · ${latest.model}` : ""}</small>
                </div>
                <span>{formatMTokens(item.totalTokens)}</span>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="token-usage-empty">{t.token.noUsage}</div>
      )}
    </div>
  );
}

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
  const { lang, toggleLang, t } = useI18n();
  const [state, setState] = useState<StoreSnapshot>({ assets: [], sessions: [], shots: [] });
  const stateRef = useRef(state);
  useEffect(() => { stateRef.current = state; }, [state]);
  // Session id is mirrored to URL hash (#/s/ses_xxx) so each session has a shareable link. Reading
  // it on init means a paste-into-browser of "http://localhost:5173/#/s/ses_abc" boots straight
  // into that session, even before /api/state has loaded.
  const [selectedSessionId, setSelectedSessionId] = useState<string>(() => readSessionFromHash());
  const [sessionTitleDraft, setSessionTitleDraft] = useState("");
  const [showArchivedSessions, setShowArchivedSessions] = useState(false);
  const [showTokenUsage, setShowTokenUsage] = useState(false);
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
  const undoStack = useUndoStack({
    undoFailed: t.toast.undoFailed,
    redoFailed: t.toast.redoFailed,
    unknownError: t.errors.unknown
  });
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
  // /api/state is normalized: session rows do not embed shots. Join the selected session's
  // top-level shots explicitly before handing it to the canvas/inspector components.
  const selectedSessionShots = useMemo(
    () => state.shots.filter((shot) => shot.sessionId === selectedSessionId).sort((a, b) => a.index - b.index),
    [state.shots, selectedSessionId]
  );
  const selectedSessionWithShots = useMemo(
    () => selectedSession ? { ...selectedSession, shots: selectedSessionShots } : undefined,
    [selectedSession, selectedSessionShots]
  );

  useEffect(() => {
    setSessionTitleDraft(selectedSession?.title || "");
  }, [selectedSession?.id, selectedSession?.title]);

  const languageSyncRef = useRef("");
  useEffect(() => {
    if (!selectedSession) return;
    if ((selectedSession.language || "zh") === lang) return;
    const key = `${selectedSession.id}:${lang}`;
    if (languageSyncRef.current === key) return;
    languageSyncRef.current = key;
    api.updateSession(selectedSession.id, { language: lang })
      .then((updated) => {
        setState((prev) => ({
          ...prev,
          sessions: prev.sessions.map((item) => (item.id === updated.id ? stripShots(updated) : item))
        }));
      })
      .catch((err: Error) => setError(err.message || t.errors.operationFailed))
      .finally(() => {
        if (languageSyncRef.current === key) languageSyncRef.current = "";
      });
  }, [lang, selectedSession?.id, selectedSession?.language, t.errors.operationFailed]);

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
      setError(err instanceof Error ? err.message : t.errors.operationFailed);
    } finally {
      setBusy("");
    }
  };

  const createSession = () =>
    run("create-session", async () => {
      const session = await api.createSession({ ...initialSession, language: lang });
      setState((prev) => ({
        ...prev,
        sessions: [stripShots(session), ...prev.sessions],
        shots: [...prev.shots, ...session.shots]
      }));
      setSelectedSessionId(session.id);
      setShowArchivedSessions(false);
    });

  const deleteSession = (session: Session) => {
    const confirmed = window.confirm(t.app.deleteSessionConfirm(session.title || session.id));
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

  const clearTokenUsage = () => {
    if (!selectedSession) return;
    const confirmed = window.confirm(t.app.clearTokenUsageConfirm(selectedSession.title || selectedSession.id));
    if (!confirmed) return;
    run(`clear-token-usage-${selectedSession.id}`, async () => {
      const updated = await api.clearTokenUsage(selectedSession.id);
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
      description: t.app.createShotUndo,
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
      description: t.app.deleteUndo(label),
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
      window.alert(lang === "en" ? "This shot is currently generating. Delete it after it completes or is cancelled." : "该分镜正在生成中，完成或取消后再删除。");
      return false;
    }
    const label = shot.title || `Shot ${shot.index}`;
    const ownedAssets = state.assets.filter((asset) => asset.ownerShotId === shot.id);
    const stitchRefs = captureStitchRefs(selectedSession, shot.id);
    await api.deleteShot(shot.id);
    removeShotFromState(shot.id);
    let deletedShot = shot;
    let deletedAssets = ownedAssets;
    undoStack.push({
      description: t.app.deleteUndo(label),
      undo: async () => {
        const restored = await api.restoreShot(deletedShot, deletedAssets);
        deletedShot = restored.shot;
        deletedAssets = restored.assets;
        upsertShotAndSessionInState(restored.shot, restored.session);
        upsertAssetsInState(restored.assets);
        await restoreStitchRefs(restored.session.id, stitchRefs);
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
      name: file.name.replace(/\.[^/.]+$/, "") || t.app.pendingVideoName,
      type: "other",
      mediaKind: "video",
      description: t.app.pendingUpload,
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
          setError(t.app.uploadFailedWithMessage(message));
          return;
        }
        const asset = (await res.json()) as Asset;
        // Fire-and-forget analyze; UI shows parseStatus via refresh polling.
        fetch(`/api/assets/${asset.id}/analyze-video`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ lang })
        }).catch(() => undefined);
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : t.app.uploadFailed);
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
          <strong>{t.app.serverDownTitle}</strong>
          <span>{t.app.serverDownBody.includes("npm run dev") ? <>{t.app.serverDownBody.split("npm run dev")[0]}<code>npm run dev</code>{t.app.serverDownBody.split("npm run dev")[1]}</> : t.app.serverDownBody}</span>
        </div>
      )}
      <aside className="sidebar">
        <div className="brand">
          <img className="brand-logo" src="/reelyai-mark.png" alt="" aria-hidden="true" />
          <div className="brand-copy">
            <strong>ReelyAI</strong>
            <span>{t.app.brandSubtitle}</span>
          </div>
        </div>
        <button className="primary" onClick={createSession} disabled={busy === "create-session"}>
          {busy === "create-session" ? <Loader2 size={16} className="spin" /> : <Plus size={16} />}
          {t.app.newSession}
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
                  <span>{latestSession.title || t.app.unnamed}</span>
                  <small>{t.app.shotCount(state.shots.filter((s) => s.sessionId === latestSession.id).length)}</small>
                </button>
                <button
                  className="session-delete danger"
                  onClick={() => deleteSession(latestSession)}
                  title={t.app.deleteSessionTitle}
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
                <span>{t.app.archiveSessions}</span>
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
                  <span>{session.title || t.app.unnamed}</span>
                  <small>{t.app.shotCount(state.shots.filter((s) => s.sessionId === session.id).length)}</small>
                </button>
                <button
                  className="session-oneclick"
                  onClick={() => promoteSession(session)}
                  title={t.app.promoteSessionTitle}
                  disabled={busy === `promote-session-${session.id}`}
                >
                  ↑
                </button>
                <button
                  className="session-delete danger"
                  onClick={() => deleteSession(session)}
                  title={t.app.delete}
                  disabled={busy === `delete-session-${session.id}`}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
            {sessions.length === 0 && <div className="empty-session">{t.app.emptySession}</div>}
          </div>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            {selectedSession ? (
              <>
                <input
                  aria-label={t.app.sessionNameAria}
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
                  title={t.app.shareTitle}
                  onClick={async () => {
                    const url = `${window.location.origin}${window.location.pathname}#/s/${selectedSession.id}`;
                    try {
                      await navigator.clipboard.writeText(url);
                      setError("");
                      window.dispatchEvent(new CustomEvent<string>("flow-download", { detail: t.app.copiedLink(url) }));
                    } catch {
                      window.prompt(t.app.copyPrompt, url);
                    }
                  }}
                >
                  {t.app.copyLink}
                </button>
              </>
            ) : (
              <h1>{t.app.createProjectTitle}</h1>
            )}
          </div>
          <div className="top-actions">
            <button
              type="button"
              className="language-toggle"
              onClick={toggleLang}
              title={t.app.languageToggleTitle}
              aria-label={t.app.languageToggleTitle}
            >
              <span className={lang === "zh" ? "active" : "muted"}>{t.app.zhLabel}</span>
              <span>/</span>
              <span className={lang === "en" ? "active" : "muted"}>{t.app.enLabel}</span>
            </button>
            <label
              className="vision-review-toggle"
              title={t.app.visionReviewTitle}
            >
              <input
                type="checkbox"
                checked={visionReviewEnabled}
                onChange={(event) => setVisionReviewEnabled(event.target.checked)}
              />
              <span>{t.app.visionReview}</span>
            </label>
            <button onClick={() => refresh()} title={t.app.refresh}>
              <RefreshCw size={16} />
            </button>
            {selectedSession && (
              <button
                onClick={() => setShowTokenUsage((value) => !value)}
                title={t.app.usageTitle}
              >
                <BarChart3 size={16} />
                {t.app.usage}
              </button>
            )}
          </div>
        </header>

        {error && <div className="error">{error}</div>}
        {selectedSession && showTokenUsage && (
          <TokenUsagePanel
            events={selectedSession.tokenUsageEvents}
            sessions={sessions}
            selectedSessionId={selectedSession.id}
            busy={busy === `clear-token-usage-${selectedSession.id}`}
            onClear={clearTokenUsage}
          />
        )}

        <FlowView
          snapshot={pendingUploads.length ? { ...state, assets: [...state.assets, ...pendingUploads] } : state}
          session={selectedSessionWithShots}
          visionReviewEnabled={visionReviewEnabled}
          defaultImageModel={state.runtime?.seedreamDefaultModel}
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
            const seedNames: Record<string, string> = lang === "en" ? {
              character: "Untitled character",
              scene: "Untitled scene",
              prop: "Untitled prop",
              style: "Untitled style"
            } : {
              character: "未命名角色",
              scene: "未命名场景",
              prop: "未命名道具",
              style: "未命名风格"
            };
            const seedDescriptions: Record<string, string> = lang === "en" ? {
              character: "Describe the character identity, appearance, and wardrobe in the Inspector; generate a reference image, then drag a canvas edge to the storyboard that should use it.",
              scene: "Describe the scene elements, lighting, and set dressing in the Inspector; generate a reference image, then drag a canvas edge to the storyboard that should use it.",
              prop: "Describe the prop shape, material, and key details in the Inspector; generate a baseline prop image, then drag a canvas edge to the storyboard that should use it.",
              style: "Describe the visual style, color palette, brush/texture keywords in the Inspector; generate a style reference, then drag a canvas edge to the storyboard that should use it."
            } : {
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
            pushAssetCreateUndo(lang === "en" ? `Create ${kind}` : `新建${seedNames[kind].replace("未命名", "")}`, payload, asset);
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
            const name = file.name.replace(/\.[^/.]+$/, "") || (kind === "character" ? (lang === "en" ? "Uploaded character" : "上传角色") : (lang === "en" ? "Uploaded scene" : "上传场景"));
            const tags = ["anchor", "uploaded", kind];
            const asset = await api.uploadImageAsset(file, {
              ownerSessionId: selectedSession.id,
              name,
              tags
            });
            const uploadedDescription = lang === "en"
              ? `Image imported from local disk and used as a ${kind === "character" ? "character" : "scene"} anchor`
              : `从本地拖入的图片，作为${kind === "character" ? "角色" : "场景"}锚使用`;
            const patched = await api.saveAsset({
              id: asset.id,
              type: kind as AssetType,
              description: uploadedDescription,
              tags
            });
            upsertAssetInState(patched);
            pushAssetCreateUndo(kind === "character" ? (lang === "en" ? "Upload character image" : "上传角色图") : (lang === "en" ? "Upload scene image" : "上传场景图"), {
              name,
              type: kind as AssetType,
              description: uploadedDescription,
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
