import { Archive, BarChart3, CircleHelp, KeyRound, Loader2, Plus, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import type { AdminAgentPlanStatus, AdminSecurityStatus, AdminUserAgentPlanCredentialList, AgentPlanCredentialStatus, Asset, AssetType, CreateSessionPayload, Session, Shot, StitchJob, StoreSnapshot, TokenUsageEvent, TokenUsageModelFamily } from "../shared/types";
import { PendingGenerationsProvider } from "./flow/PendingGenerations";
import { useUndoKeyboardShortcut, useUndoStack } from "./flow/useUndoStack";
import { useI18n } from "./i18n";
import { resolveRefreshSelectedSessionId } from "./sessionSelection";

const FlowView = lazy(() =>
  import("./flow/FlowView").then((module) => ({ default: memo(module.FlowView) }))
);

const clientBuildStamp = "speed-20260604-state-first-canvas";

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

function formatAdminDate(value: string | undefined) {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString();
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

const rowSignatureCache = new WeakMap<object, string>();

function rowSignature(value: object): string {
  const cached = rowSignatureCache.get(value);
  if (cached !== undefined) return cached;
  const signature = JSON.stringify(value);
  rowSignatureCache.set(value, signature);
  return signature;
}

/**
 * Cheap structural-equality check used by `mergeStateById` to decide whether two same-id rows
 * are content-equal. `/api/state` returns fresh objects on every poll, so recursive field walks
 * can get expensive on sessions with large render/review histories. Cache a JSON row signature
 * per immutable state object instead; unchanged previous rows are compared from the WeakMap.
 */
function rowEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  return rowSignature(a) === rowSignature(b);
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
  const sessions = stableArr(prev.sessions, next.sessions);
  const shots = stableArr(prev.shots, next.shots);
  const assets = stableArr(prev.assets, next.assets);
  const runtime = prev.runtime && next.runtime && rowEqual(prev.runtime, next.runtime) ? prev.runtime : next.runtime;
  if (sessions === prev.sessions && shots === prev.shots && assets === prev.assets && runtime === prev.runtime) {
    return prev;
  }
  return {
    ...next,
    sessions,
    shots,
    assets,
    runtime
  };
}

function mergeStateForDisplay({
  prev,
  next,
  selectedSessionId,
  pendingCreates,
  pendingDeletes
}: {
  prev: StoreSnapshot;
  next: StoreSnapshot;
  selectedSessionId: string;
  pendingCreates: ReadonlySet<string>;
  pendingDeletes: ReadonlySet<string>;
}): StoreSnapshot {
  const merged = mergeStateById(prev, next);
  const keepSessionIds = new Set<string>();
  prev.sessions.forEach((session) => {
    const missingFromSnapshot = !merged.sessions.some((item) => item.id === session.id);
    if (!missingFromSnapshot || pendingDeletes.has(session.id)) return;
    if (pendingCreates.has(session.id) || session.id === selectedSessionId) keepSessionIds.add(session.id);
  });
  const keptSessions = prev.sessions.filter((session) => keepSessionIds.has(session.id));
  const sessions = [...keptSessions, ...merged.sessions].filter((session) => !pendingDeletes.has(session.id));
  const sessionIds = new Set(sessions.map((session) => session.id));
  const mergedShotIds = new Set(merged.shots.map((shot) => shot.id));
  const keptShots = prev.shots.filter((shot) =>
    keepSessionIds.has(shot.sessionId) && !mergedShotIds.has(shot.id)
  );
  const mergedAssetIds = new Set(merged.assets.map((asset) => asset.id));
  const keptAssets = prev.assets.filter((asset) =>
    asset.ownerSessionId
    && keepSessionIds.has(asset.ownerSessionId)
    && !mergedAssetIds.has(asset.id)
  );
  return {
    ...merged,
    sessions,
    shots: [...keptShots, ...merged.shots].filter((shot) => sessionIds.has(shot.sessionId) && !pendingDeletes.has(shot.sessionId)),
    assets: [...keptAssets, ...merged.assets].filter((asset) => {
      if (asset.ownerSessionId && pendingDeletes.has(asset.ownerSessionId)) return false;
      return true;
    })
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

function clientId(prefix: string) {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
  }
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function makeLocalSession(payload: CreateSessionPayload & { id: string; language: Session["language"] }): Session {
  const now = new Date().toISOString();
  return {
    id: payload.id,
    title: payload.title?.trim() || "unnamed session",
    logline: payload.logline?.trim() || "",
    style: payload.style?.trim() || "cinematic, emotionally grounded, coherent visual continuity",
    language: payload.language,
    targetDurationSec: Math.max(15, Number(payload.targetDurationSec) || 60),
    tokenUsageEvents: [],
    createdAt: now,
    updatedAt: now
  };
}

function useStableEvent<T extends (...args: any[]) => any>(fn: T): T {
  const fnRef = useRef(fn);
  useEffect(() => {
    fnRef.current = fn;
  }, [fn]);
  return useCallback(((...args: Parameters<T>) => fnRef.current(...args)) as T, []);
}

export function App() {
  const { lang, toggleLang, t } = useI18n();
  const [state, setState] = useState<StoreSnapshot>({ assets: [], sessions: [], shots: [] });
  const stateRef = useRef(state);
  useEffect(() => { stateRef.current = state; }, [state]);
  const pendingSessionCreatesRef = useRef<Set<string>>(new Set());
  const pendingSessionDeletesRef = useRef<Set<string>>(new Set());
  // Session id is mirrored to URL hash (#/s/ses_xxx) so each session has a shareable link. Reading
  // it on init means a paste-into-browser of "http://localhost:5173/#/s/ses_abc" boots straight
  // into that session, even before /api/state has loaded.
  const [selectedSessionId, setSelectedSessionId] = useState<string>(() => readSessionFromHash());
  const selectedSessionIdRef = useRef(selectedSessionId);
  useEffect(() => { selectedSessionIdRef.current = selectedSessionId; }, [selectedSessionId]);
  const [stateLoaded, setStateLoaded] = useState(false);
  const [sessionTitleDraft, setSessionTitleDraft] = useState("");
  const [showArchivedSessions, setShowArchivedSessions] = useState(false);
  const [showTokenUsage, setShowTokenUsage] = useState(false);
  const [showAgentPlanKey, setShowAgentPlanKey] = useState(false);
  const [agentPlanDraft, setAgentPlanDraft] = useState("");
  const [showAdminPanel, setShowAdminPanel] = useState(false);
  const [adminUsernameDraft, setAdminUsernameDraft] = useState("");
  const [adminPasswordDraft, setAdminPasswordDraft] = useState("");
  const [adminAgentPlanDraft, setAdminAgentPlanDraft] = useState("");
  const [adminNewUsernameDraft, setAdminNewUsernameDraft] = useState("");
  const [adminNewPasswordDraft, setAdminNewPasswordDraft] = useState("");
  const [adminAgentPlanStatus, setAdminAgentPlanStatus] = useState<AdminAgentPlanStatus | undefined>();
  const [adminSecurityStatus, setAdminSecurityStatus] = useState<AdminSecurityStatus | undefined>();
  const [adminUserAgentPlanKeys, setAdminUserAgentPlanKeys] = useState<AdminUserAgentPlanCredentialList | undefined>();
  const [adminLoggedIn, setAdminLoggedIn] = useState(false);
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
  const [optimisticAssets, setOptimisticAssets] = useState<Asset[]>([]);
  const [optimisticShots, setOptimisticShots] = useState<Shot[]>([]);
  const [optimisticStitchJobs, setOptimisticStitchJobs] = useState<Array<{ sessionId: string; job: StitchJob }>>([]);
  const optimisticStitchJobsRef = useRef(optimisticStitchJobs);
  useEffect(() => { optimisticStitchJobsRef.current = optimisticStitchJobs; }, [optimisticStitchJobs]);
  const optimisticIdRef = useRef(0);
  const pendingSessionCreatePromisesRef = useRef<Map<string, Promise<void>>>(new Map());

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

  const refresh = useCallback(async () => {
    const next = await api.state();
    const fromHash = readSessionFromHash();
    const pendingDeletesSnapshot = new Set(pendingSessionDeletesRef.current);
    setState((prev) => {
      return mergeStateForDisplay({
        prev,
        next,
        selectedSessionId: selectedSessionIdRef.current,
        pendingCreates: pendingSessionCreatesRef.current,
        pendingDeletes: pendingSessionDeletesRef.current
      });
    });
    setStateLoaded(true);
    setSelectedSessionId((current) => {
      const availableSessionIds = next.sessions.map((session) => session.id);
      return resolveRefreshSelectedSessionId({
        current,
        fromHash,
        availableSessionIds,
        deletedSessionIds: [...pendingDeletesSnapshot]
      });
    });
  }, []);

  useEffect(() => {
    refresh().catch((err: Error) => {
      setStateLoaded(true);
      setError(err.message);
    });
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
  const agentPlanCredential = state.runtime?.agentPlanCredential;
  const freeTrial = state.runtime?.freeTrial;
  const latestSession = sessions[0];
  const archivedSessions = sessions.slice(1);
  const selectedSession = sessions.find((session) => session.id === selectedSessionId);
  const optimisticSession = useMemo<Session | undefined>(() => {
    if (selectedSession || !selectedSessionId) return undefined;
    if (stateLoaded && selectedSessionId !== readSessionFromHash()) return undefined;
    const ts = new Date(0).toISOString();
    return {
      id: selectedSessionId,
      title: selectedSessionId,
      logline: "",
      style: "",
      language: lang,
      targetDurationSec: 60,
      tokenUsageEvents: [],
      createdAt: ts,
      updatedAt: ts
    };
  }, [lang, selectedSession, selectedSessionId, stateLoaded]);
  const visibleSelectedSession = selectedSession || optimisticSession;
  // /api/state is normalized: session rows do not embed shots. Join the selected session's
  // top-level shots explicitly before handing it to the canvas/inspector components.
  const selectedSessionShots = useMemo(
    () => {
      const persisted = state.shots.filter((shot) => shot.sessionId === selectedSessionId);
      const optimistic = optimisticShots.filter((shot) => shot.sessionId === selectedSessionId && !persisted.some((item) => item.id === shot.id));
      return [...persisted, ...optimistic].sort((a, b) => a.index - b.index);
    },
    [optimisticShots, state.shots, selectedSessionId]
  );
  const selectedSessionStitchJobs = useMemo(() => {
    const persisted = visibleSelectedSession?.stitchJobs || [];
    const persistedIds = new Set(persisted.map((job) => job.id));
    const optimistic = optimisticStitchJobs
      .filter((item) => item.sessionId === selectedSessionId && !persistedIds.has(item.job.id))
      .map((item) => item.job);
    return [...persisted, ...optimistic];
  }, [optimisticStitchJobs, selectedSessionId, visibleSelectedSession?.stitchJobs]);
  const selectedSessionWithShots = useMemo(
    () => visibleSelectedSession ? { ...visibleSelectedSession, shots: selectedSessionShots, stitchJobs: selectedSessionStitchJobs } : undefined,
    [selectedSessionShots, selectedSessionStitchJobs, visibleSelectedSession]
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
        setState((prev) => mergeStateForDisplay({
          prev,
          next,
          selectedSessionId: selectedSessionIdRef.current,
          pendingCreates: pendingSessionCreatesRef.current,
          pendingDeletes: pendingSessionDeletesRef.current
        }));
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

  const createSession = () => {
    const id = clientId("ses");
    const payload = { ...initialSession, id, language: lang };
    const localSession = makeLocalSession(payload);
    pendingSessionCreatesRef.current.add(id);
    setError("");
    setBusy("create-session");
    setState((prev) => ({
      ...prev,
      sessions: [localSession, ...prev.sessions.filter((session) => session.id !== id)]
    }));
    setSelectedSessionId(id);
    setShowArchivedSessions(false);
    const createPromise = (async () => {
      try {
        const session = await api.createSession(payload);
        pendingSessionCreatesRef.current.delete(id);
        setState((prev) => ({
          ...prev,
          sessions: [stripShots(session), ...prev.sessions.filter((item) => item.id !== id && item.id !== session.id)],
          shots: [...prev.shots.filter((shot) => shot.sessionId !== id && shot.sessionId !== session.id), ...session.shots]
        }));
        setSelectedSessionId(session.id);
      } catch (err) {
        pendingSessionCreatesRef.current.delete(id);
        setError(err instanceof Error ? err.message : t.errors.operationFailed);
        throw err;
      } finally {
        pendingSessionCreatePromisesRef.current.delete(id);
        setBusy((current) => (current === "create-session" ? "" : current));
      }
    })();
    pendingSessionCreatePromisesRef.current.set(id, createPromise);
    void createPromise.catch(() => undefined);
  };

  const waitForSessionCreate = useStableEvent(async (sessionId: string) => {
    const pending = pendingSessionCreatePromisesRef.current.get(sessionId);
    if (pending) await pending;
  });

  const deleteSession = (session: Session) => {
    const confirmed = window.confirm(t.app.deleteSessionConfirm(session.title || session.id));
    if (!confirmed) return;
    const deletedId = session.id;
    pendingSessionDeletesRef.current.add(deletedId);
    setError("");
    setBusy(`delete-session-${deletedId}`);
    setState((prev) => {
      const sessions = prev.sessions.filter((item) => item.id !== deletedId);
      const sessionIds = new Set(sessions.map((item) => item.id));
      return {
        ...prev,
        sessions,
        shots: prev.shots.filter((shot) => shot.sessionId !== deletedId && sessionIds.has(shot.sessionId)),
        assets: prev.assets.filter((asset) => asset.ownerSessionId !== deletedId)
      };
    });
    setOptimisticShots((prev) => prev.filter((shot) => shot.sessionId !== deletedId));
    setOptimisticAssets((prev) => prev.filter((asset) => asset.ownerSessionId !== deletedId));
    setOptimisticStitchJobs((prev) => prev.filter((item) => item.sessionId !== deletedId));
    setSelectedSessionId((current) => {
      if (current !== deletedId) return current;
      return stateRef.current.sessions.find((item) => item.id !== deletedId)?.id || "";
    });
    void (async () => {
      try {
        await api.deleteSession(deletedId);
      } catch (err) {
        pendingSessionDeletesRef.current.delete(deletedId);
        setError(err instanceof Error ? err.message : t.errors.operationFailed);
        await refresh();
      } finally {
        setBusy((current) => (current === `delete-session-${deletedId}` ? "" : current));
      }
    })();
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

  const updateAgentPlanStatus = (status: AgentPlanCredentialStatus) => {
    setState((prev) => ({
      ...prev,
      runtime: {
        ...prev.runtime,
        agentPlanCredential: status,
        seedreamCredentialSource: status.configured ? "agent-plan" : prev.runtime?.seedreamCredentialSource,
        seedreamDefaultModel: status.configured ? "seedream-5-lite" : prev.runtime?.seedreamDefaultModel
      }
    }));
  };

  const saveAgentPlanKey = () => {
    const apiKey = agentPlanDraft.trim();
    if (!apiKey) return;
    run("save-agent-plan-key", async () => {
      const status = await api.saveAgentPlanCredential(apiKey);
      updateAgentPlanStatus(status);
      setAgentPlanDraft("");
      setShowAgentPlanKey(false);
      await refresh();
    });
  };

  const clearAgentPlanKey = () => {
    run("clear-agent-plan-key", async () => {
      const status = await api.clearAgentPlanCredential();
      updateAgentPlanStatus(status);
      setAgentPlanDraft("");
      await refresh();
    });
  };

  const loginAdmin = () => {
    run("admin-login", async () => {
      const result = await api.adminLogin({ username: adminUsernameDraft.trim(), password: adminPasswordDraft });
      setAdminLoggedIn(true);
      setAdminAgentPlanStatus(result.adminAgentPlan);
      setAdminSecurityStatus(result.adminSecurity);
      setAdminUserAgentPlanKeys(await api.adminAgentPlanKeys());
      setAdminPasswordDraft("");
      setAdminAgentPlanDraft("");
      setAdminNewUsernameDraft("");
      setAdminNewPasswordDraft("");
    });
  };

  const refreshAdminAgentPlanKeys = () => {
    run("refresh-admin-agent-plan-keys", async () => {
      setAdminUserAgentPlanKeys(await api.adminAgentPlanKeys());
    });
  };

  const saveAdminAgentPlanKey = () => {
    const apiKey = adminAgentPlanDraft.trim();
    if (!apiKey) return;
    run("save-admin-agent-plan-key", async () => {
      const result = await api.saveAdminAgentPlan(apiKey);
      setAdminAgentPlanStatus(result.adminAgentPlan);
      setAdminAgentPlanDraft("");
      await refresh();
    });
  };

  const saveAdminSecurity = () => {
    const password = adminNewPasswordDraft;
    if (!password) return;
    run("save-admin-security", async () => {
      const result = await api.saveAdminSecurity({
        username: adminNewUsernameDraft.trim() || undefined,
        password
      });
      setAdminSecurityStatus(result.adminSecurity);
      setAdminNewUsernameDraft("");
      setAdminNewPasswordDraft("");
    });
  };

  const clearAdminAgentPlanKey = () => {
    run("clear-admin-agent-plan-key", async () => {
      const result = await api.clearAdminAgentPlan();
      setAdminAgentPlanStatus(result.adminAgentPlan);
      await refresh();
    });
  };

  const logoutAdmin = () => {
    run("admin-logout", async () => {
      await api.adminLogout();
      setAdminLoggedIn(false);
      setAdminAgentPlanStatus(undefined);
      setAdminSecurityStatus(undefined);
      setAdminUserAgentPlanKeys(undefined);
      setAdminAgentPlanDraft("");
      setAdminPasswordDraft("");
      setAdminNewUsernameDraft("");
      setAdminNewPasswordDraft("");
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
        referenceAudioUrl: shot.referenceVideoAssetId === assetId ? null : shot.referenceAudioUrl,
        referenceClipPreviewUrl: shot.referenceVideoAssetId === assetId ? null : shot.referenceClipPreviewUrl,
        referenceAudioPreviewUrl: shot.referenceVideoAssetId === assetId ? null : shot.referenceAudioPreviewUrl,
        firstFrameAssetId: shot.firstFrameAssetId === assetId ? undefined : shot.firstFrameAssetId,
        lastFrameAssetId: shot.lastFrameAssetId === assetId ? undefined : shot.lastFrameAssetId,
        renders: (shot.renders || []).map((render) => ({
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
        }))
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

  const upsertSessionInState = (session: Session & { shots?: Shot[] }) => {
    setState((prev) => {
      const incomingShots = session.shots || [];
      const incomingShotIds = new Set(incomingShots.map((shot) => shot.id));
      return {
        ...prev,
        sessions: prev.sessions.some((item) => item.id === session.id)
          ? prev.sessions.map((item) => (item.id === session.id ? stripShots(session) : item))
          : [stripShots(session), ...prev.sessions],
        shots: incomingShots.length
          ? [...prev.shots.filter((shot) => !incomingShotIds.has(shot.id)), ...incomingShots]
          : prev.shots
      };
    });
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
          referenceAudioUrl: shot.referenceAudioUrl ?? null,
          referenceClipPreviewUrl: shot.referenceClipPreviewUrl ?? null,
          referenceAudioPreviewUrl: shot.referenceAudioPreviewUrl ?? null,
          firstFrameAssetId: shot.firstFrameAssetId,
          lastFrameAssetId: shot.lastFrameAssetId
        } satisfies Partial<Shot>
      }));
    await api.deleteAsset(asset.id);
    removeAssetFromState(asset.id);
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
            merged.referenceAudioUrl = patch.referenceAudioUrl;
            merged.referenceClipPreviewUrl = patch.referenceClipPreviewUrl;
            merged.referenceAudioPreviewUrl = patch.referenceAudioPreviewUrl;
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
              merged.referenceAudioUrl = patch.referenceAudioUrl;
              merged.referenceClipPreviewUrl = patch.referenceClipPreviewUrl;
              merged.referenceAudioPreviewUrl = patch.referenceAudioPreviewUrl;
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

  const flowSnapshot = useMemo(() => {
    if (!pendingUploads.length && !optimisticAssets.length && !optimisticShots.length) return state;
    const assetIds = new Set(state.assets.map((asset) => asset.id));
    const shotIds = new Set(state.shots.map((shot) => shot.id));
    return {
      ...state,
      assets: [
        ...state.assets,
        ...optimisticAssets.filter((asset) => !assetIds.has(asset.id)),
        ...pendingUploads.filter((asset) => !assetIds.has(asset.id))
      ],
      shots: [...state.shots, ...optimisticShots.filter((shot) => !shotIds.has(shot.id))]
    };
  }, [optimisticAssets, optimisticShots, pendingUploads, state]);

  const handleFlowMutated = useStableEvent(() => refresh());

  const handleCreateAnchorAsset = useStableEvent(async (kind: AnchorKind) => {
    if (!visibleSelectedSession) return undefined;
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
    const sessionForCreate = visibleSelectedSession;
    if (!sessionForCreate) return undefined;
    const payload: Partial<Asset> = {
      name: seedNames[kind],
      type: kind as AssetType,
      description: seedDescriptions[kind],
      prompt: "",
      ownerSessionId: sessionForCreate.id,
      tags: ["anchor", kind]
    };
    const now = new Date().toISOString();
    const tempId = `asset_pending_${Date.now()}_${optimisticIdRef.current++}`;
    const tempAsset: Asset = {
      id: tempId,
      name: payload.name || seedNames[kind],
      type: kind as AssetType,
      mediaKind: "none",
      description: payload.description || "",
      prompt: "",
      ownerSessionId: sessionForCreate.id,
      tags: ["anchor", kind, "client-pending-create"],
      createdAt: now,
      updatedAt: now
    };
    setOptimisticAssets((prev) => [...prev, tempAsset]);
    void (async () => {
      try {
        await waitForSessionCreate(sessionForCreate.id);
        const asset = await api.saveAsset(payload);
        upsertAssetInState(asset);
        setOptimisticAssets((prev) => prev.filter((item) => item.id !== tempId));
        pushAssetCreateUndo(lang === "en" ? `Create ${kind}` : `新建${seedNames[kind].replace("未命名", "")}`, payload, asset);
      } catch (err) {
        setOptimisticAssets((prev) => prev.filter((item) => item.id !== tempId));
        setError(err instanceof Error ? err.message : t.errors.unknown);
      }
    })();
    return tempAsset;
  });

  const handleCreateShot = useStableEvent(async () => {
    const sessionForCreate = selectedSessionWithShots || visibleSelectedSession;
    if (!sessionForCreate) return undefined;
    const now = new Date().toISOString();
    const nextIndex = selectedSessionShots.length + 1;
    const tempId = clientId("shot");
    const tempShot: Shot = {
      id: tempId,
      sessionId: sessionForCreate.id,
      index: nextIndex,
      title: `Shot ${nextIndex}`,
      script: "",
      camera: "",
      durationSec: Math.max(4, Math.round((sessionForCreate.targetDurationSec || 60) / Math.max(1, nextIndex))),
      assetIds: [],
      rawPrompt: "",
      prompt: "",
      debugNote: "",
      seedanceVariant: "standard",
      usePreviousShotClip: false,
      renders: [],
      status: "draft",
      createdAt: now,
      updatedAt: now
    };
    setOptimisticShots((prev) => [...prev, tempShot]);
    void (async () => {
      try {
        await waitForSessionCreate(sessionForCreate.id);
        const result = await api.appendShot(sessionForCreate.id, { id: tempId });
        upsertShotAndSessionInState(result.shot, result.session);
        setOptimisticShots((prev) => prev.filter((item) => item.id !== tempId));
        pushShotCreateUndo(result.shot);
      } catch (err) {
        setOptimisticShots((prev) => prev.filter((item) => item.id !== tempId));
        setError(err instanceof Error ? err.message : t.errors.unknown);
      }
    })();
    return tempShot;
  });

  const handleCreateStitchJob = useStableEvent(() => {
    const sessionForCreate = selectedSessionWithShots || visibleSelectedSession;
    if (!sessionForCreate) return undefined;
    const now = new Date().toISOString();
    const existingCount = (sessionForCreate.stitchJobs || []).length
      + optimisticStitchJobs.filter((item) => item.sessionId === sessionForCreate.id).length;
    const tempId = `stitch_pending_${Date.now()}_${optimisticIdRef.current++}`;
    const tempJob: StitchJob = {
      id: tempId,
      name: `拼接 ${existingCount + 1}`,
      shotIds: [],
      status: "idle",
      createdAt: now,
      updatedAt: now
    };
    setOptimisticStitchJobs((prev) => [...prev, { sessionId: sessionForCreate.id, job: tempJob }]);
    void (async () => {
      try {
        await waitForSessionCreate(sessionForCreate.id);
        const latestTempJob = optimisticStitchJobsRef.current.find((item) => item.job.id === tempId)?.job || tempJob;
        const updated = await api.createStitchJob(sessionForCreate.id, {
          name: latestTempJob.name,
          shotIds: latestTempJob.shotIds,
          status: "idle"
        });
        upsertSessionInState(updated);
        setOptimisticStitchJobs((prev) => prev.filter((item) => item.job.id !== tempId));
      } catch (err) {
        setOptimisticStitchJobs((prev) => prev.filter((item) => item.job.id !== tempId));
        setError(err instanceof Error ? err.message : t.errors.unknown);
      }
    })();
    return tempJob;
  });

  const handleConnectStitchShot = useStableEvent((shotId: string, jobId: string, legacy?: boolean) => {
    if (!visibleSelectedSession) return;
    const sessionId = visibleSelectedSession.id;
    if (legacy) {
      setState((prev) => ({
        ...prev,
        sessions: prev.sessions.map((session) => session.id === sessionId ? {
          ...session,
          stitchShotIds: Array.from(new Set([...(session.stitchShotIds || []), shotId])),
          stitchStatus: "idle",
          stitchError: "",
          stitchProgress: ""
        } : session)
      }));
      return;
    }
    if (jobId.startsWith("stitch_pending")) {
      setOptimisticStitchJobs((prev) => prev.map((item) => {
        if (item.sessionId !== sessionId || item.job.id !== jobId) return item;
        return {
          ...item,
          job: {
            ...item.job,
            shotIds: Array.from(new Set([...(item.job.shotIds || []), shotId])),
            status: "idle",
            error: "",
            progress: ""
          }
        };
      }));
      return;
    }
    setState((prev) => ({
      ...prev,
      sessions: prev.sessions.map((session) => {
        if (session.id !== sessionId) return session;
        return {
          ...session,
          stitchJobs: (session.stitchJobs || []).map((job) => job.id === jobId ? {
            ...job,
            shotIds: Array.from(new Set([...(job.shotIds || []), shotId])),
            status: "idle",
            error: "",
            progress: ""
          } : job)
        };
      })
    }));
  });

  const handleSetStitchOrder = useStableEvent((jobId: string, shotIds: string[], legacy?: boolean) => {
    if (!visibleSelectedSession) return;
    const sessionId = visibleSelectedSession.id;
    const nextIds = Array.from(new Set(shotIds));
    if (legacy) {
      setState((prev) => ({
        ...prev,
        sessions: prev.sessions.map((session) => session.id === sessionId ? {
          ...session,
          stitchShotIds: nextIds,
          stitchStatus: "idle",
          stitchError: "",
          stitchProgress: ""
        } : session)
      }));
      return;
    }
    if (jobId.startsWith("stitch_pending")) {
      setOptimisticStitchJobs((prev) => prev.map((item) => {
        if (item.sessionId !== sessionId || item.job.id !== jobId) return item;
        return {
          ...item,
          job: {
            ...item.job,
            shotIds: nextIds,
            status: "idle",
            error: "",
            progress: ""
          }
        };
      }));
      return;
    }
    setState((prev) => ({
      ...prev,
      sessions: prev.sessions.map((session) => {
        if (session.id !== sessionId) return session;
        return {
          ...session,
          stitchJobs: (session.stitchJobs || []).map((job) => job.id === jobId ? {
            ...job,
            shotIds: nextIds,
            status: "idle",
            error: "",
            progress: ""
          } : job)
        };
      })
    }));
  });

  const handleUploadImageAsset = useStableEvent(async (file: File, kind: "character" | "scene") => {
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
  });

  const handleDeleteCanvasAsset = useStableEvent(deleteCanvasAsset);
  const handleDeleteCanvasShot = useStableEvent(deleteCanvasShot);
  const handleUploadReferenceVideo = useStableEvent(uploadReferenceVideo);

  const handleStitch = useStableEvent(async (options?: { force?: boolean }) => {
    if (!selectedSession) return;
    await api.stitch(selectedSession.id, { force: options?.force === true });
    await refresh();
  });

  return (
    <PendingGenerationsProvider>
    <main className="app-shell" data-build={clientBuildStamp}>
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
            <a
              className="ai-use-me-link"
              href="/ai-use-me.html"
              target="_blank"
              rel="noreferrer"
              title="CLI guide for AI agents"
            >
              <CircleHelp size={16} />
              AI use me
            </a>
            <div className="agent-plan-control">
              <button
                type="button"
                className={`agent-plan-button ${agentPlanCredential?.configured ? "configured" : ""}`}
                onClick={() => setShowAgentPlanKey((value) => !value)}
                title={agentPlanCredential?.configured
                  ? t.app.agentPlanConfiguredTitle(agentPlanCredential.fingerprint || "")
                  : t.app.agentPlanMissingTitle}
              >
                <KeyRound size={16} />
                {agentPlanCredential?.configured ? t.app.agentPlanReady : t.app.agentPlanSet}
              </button>
              {!agentPlanCredential?.configured && freeTrial?.enabled && (
                <span className={`free-trial-pill ${freeTrial.remaining <= 0 ? "depleted" : ""}`}>
                  {freeTrial.remaining <= 0
                    ? t.app.freeTrialDepleted
                    : t.app.freeTrialRemaining(freeTrial.remaining, freeTrial.limit)}
                </span>
              )}
              {showAgentPlanKey && (
                <form
                  className="agent-plan-popover"
                  onSubmit={(event) => {
                    event.preventDefault();
                    saveAgentPlanKey();
                  }}
                >
                  <div className="agent-plan-status">
                    <div>
                      <strong>{agentPlanCredential?.configured ? t.app.agentPlanReady : t.app.agentPlanSet}</strong>
                      <small>{t.app.agentPlanHelpText}</small>
                    </div>
                    <a
                      className="agent-plan-help-link"
                      href="https://www.volcengine.com/activity/agentplan"
                      target="_blank"
                      rel="noreferrer"
                      title={t.app.agentPlanOpenTitle}
                      aria-label={t.app.agentPlanOpenTitle}
                    >
                      <CircleHelp size={16} />
                    </a>
                    {agentPlanCredential?.fingerprint && <span>{t.app.agentPlanFingerprint(agentPlanCredential.fingerprint)}</span>}
                  </div>
                  <input
                    type="password"
                    autoComplete="off"
                    value={agentPlanDraft}
                    onChange={(event) => setAgentPlanDraft(event.target.value)}
                    placeholder={t.app.agentPlanPlaceholder}
                    aria-label={t.app.agentPlanPlaceholder}
                  />
                  <div className="button-row agent-plan-actions">
                    <button
                      type="submit"
                      className="primary"
                      disabled={busy === "save-agent-plan-key" || !agentPlanDraft.trim()}
                    >
                      {busy === "save-agent-plan-key" ? <Loader2 size={16} className="spin" /> : <KeyRound size={16} />}
                      {t.app.agentPlanSave}
                    </button>
                    <button
                      type="button"
                      className="danger"
                      onClick={clearAgentPlanKey}
                      disabled={busy === "clear-agent-plan-key" || !agentPlanCredential?.configured}
                    >
                      {t.app.agentPlanClear}
                    </button>
                  </div>
                </form>
              )}
            </div>
            <div className="admin-control">
              <button
                type="button"
                className={`admin-button ${adminLoggedIn ? "configured" : ""}`}
                onClick={async () => {
                  const next = !showAdminPanel;
                  setShowAdminPanel(next);
                  if (next && adminLoggedIn) {
                    try {
                      const result = await api.adminSettings();
                      setAdminAgentPlanStatus(result.adminAgentPlan);
                      setAdminSecurityStatus(result.adminSecurity);
                      setAdminUserAgentPlanKeys(await api.adminAgentPlanKeys());
                    } catch {
                      setAdminLoggedIn(false);
                    }
                  }
                }}
                title={t.app.adminButtonTitle}
                aria-label={t.app.adminButtonTitle}
              >
                {t.app.adminButton}
              </button>
              {showAdminPanel && (
                <form
                  className="admin-popover"
                  onSubmit={(event) => {
                    event.preventDefault();
                    adminLoggedIn ? saveAdminAgentPlanKey() : loginAdmin();
                  }}
                >
                  {!adminLoggedIn ? (
                    <>
                      <div className="admin-status">
                        <strong>{t.app.adminLoginTitle}</strong>
                        <small>{t.app.adminLoginHint}</small>
                      </div>
                      <input
                        value={adminUsernameDraft}
                        onChange={(event) => setAdminUsernameDraft(event.target.value)}
                        placeholder={t.app.adminUsernamePlaceholder}
                        autoComplete="username"
                      />
                      <input
                        type="password"
                        value={adminPasswordDraft}
                        onChange={(event) => setAdminPasswordDraft(event.target.value)}
                        placeholder={t.app.adminPasswordPlaceholder}
                        autoComplete="current-password"
                      />
                      <button className="primary" type="submit" disabled={busy === "admin-login"}>
                        {busy === "admin-login" ? <Loader2 size={16} className="spin" /> : <ShieldCheck size={16} />}
                        {t.app.adminLogin}
                      </button>
                    </>
                  ) : (
                    <>
                      <div className="admin-status">
                        <strong>{t.app.adminConsoleTitle}</strong>
                        <small>
                          {adminSecurityStatus?.configured
                            ? t.app.adminSecurityConfigured(adminSecurityStatus.source)
                            : t.app.adminSecurityMissing}
                        </small>
                      </div>
                      <div className="admin-section">
                        <div className="admin-section-heading">
                          <strong>{t.app.adminTrialTitle}</strong>
                          <small>
                            {adminAgentPlanStatus?.configured
                              ? t.app.adminTrialConfigured(adminAgentPlanStatus.fingerprint, adminAgentPlanStatus.source)
                              : t.app.adminTrialMissing}
                          </small>
                        </div>
                        <input
                          type="password"
                          autoComplete="off"
                          value={adminAgentPlanDraft}
                          onChange={(event) => setAdminAgentPlanDraft(event.target.value)}
                          placeholder={t.app.adminAgentPlanPlaceholder}
                        />
                        <div className="button-row admin-actions">
                          <button
                            type="submit"
                            className="primary"
                            disabled={busy === "save-admin-agent-plan-key" || !adminAgentPlanDraft.trim()}
                          >
                            {busy === "save-admin-agent-plan-key" ? <Loader2 size={16} className="spin" /> : <KeyRound size={16} />}
                            {t.app.adminSave}
                          </button>
                          <button
                            type="button"
                            className="danger"
                            disabled={busy === "clear-admin-agent-plan-key" || !adminAgentPlanStatus?.configured}
                            onClick={clearAdminAgentPlanKey}
                          >
                            {t.app.adminClear}
                          </button>
                        </div>
                      </div>
                      <div className="admin-section">
                        <div className="admin-section-heading">
                          <strong>{t.app.adminSecurityTitle}</strong>
                          <small>{t.app.adminSecurityHelp}</small>
                        </div>
                        <input
                          value={adminNewUsernameDraft}
                          onChange={(event) => setAdminNewUsernameDraft(event.target.value)}
                          placeholder={t.app.adminNewUsernamePlaceholder}
                          autoComplete="off"
                        />
                        <input
                          type="password"
                          value={adminNewPasswordDraft}
                          onChange={(event) => setAdminNewPasswordDraft(event.target.value)}
                          placeholder={t.app.adminNewPasswordPlaceholder}
                          autoComplete="new-password"
                        />
                        <div className="button-row admin-actions">
                          <button
                            type="button"
                            className="primary"
                            onClick={saveAdminSecurity}
                            disabled={busy === "save-admin-security" || !adminNewPasswordDraft}
                          >
                            {busy === "save-admin-security" ? <Loader2 size={16} className="spin" /> : <ShieldCheck size={16} />}
                            {t.app.adminSecuritySave}
                          </button>
                          <button type="button" onClick={logoutAdmin} disabled={busy === "admin-logout"}>
                            {t.app.adminLogout}
                          </button>
                        </div>
                      </div>
                      <div className="admin-user-keys">
                        <div className="admin-user-keys-header">
                          <strong>{t.app.adminUserKeysTitle}</strong>
                          <button
                            type="button"
                            className="icon-button"
                            onClick={refreshAdminAgentPlanKeys}
                            disabled={busy === "refresh-admin-agent-plan-keys"}
                            title={t.app.adminUserKeysRefresh}
                            aria-label={t.app.adminUserKeysRefresh}
                          >
                            {busy === "refresh-admin-agent-plan-keys" ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />}
                          </button>
                        </div>
                        <small className={`admin-user-keys-storage ${adminUserAgentPlanKeys?.storage.mode || "memory"}`}>
                          {t.app.adminUserKeysStorage(
                            adminUserAgentPlanKeys?.storage.mode || "memory",
                            Boolean(adminUserAgentPlanKeys?.storage.databaseConfigured),
                            Boolean(adminUserAgentPlanKeys?.storage.encryptionConfigured)
                          )}
                        </small>
                        {adminUserAgentPlanKeys?.storage.error && (
                          <small className="admin-user-keys-error">{adminUserAgentPlanKeys.storage.error}</small>
                        )}
                        {adminUserAgentPlanKeys?.credentials.length ? (
                          <div className="admin-user-keys-list">
                            {adminUserAgentPlanKeys.credentials.map((credential) => (
                              <div className="admin-user-key-row" key={credential.userId}>
                                <div className="admin-user-key-meta">
                                  <span>{credential.fingerprint}</span>
                                  <time dateTime={credential.updatedAt}>{formatAdminDate(credential.updatedAt)}</time>
                                </div>
                                <code>{credential.apiKey}</code>
                                <small>{credential.userId}</small>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <p className="admin-user-keys-empty">{t.app.adminUserKeysEmpty}</p>
                        )}
                      </div>
                    </>
                  )}
                </form>
              )}
            </div>
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

        <Suspense fallback={<div className="flow-loading" role="status">{lang === "en" ? "Loading canvas..." : "正在加载画布..."}</div>}>
          <FlowView
            snapshot={flowSnapshot}
            session={selectedSessionWithShots}
            visionReviewEnabled={visionReviewEnabled}
            defaultImageModel={state.runtime?.seedreamDefaultModel}
            onMutated={handleFlowMutated}
            undo={undoStack.undo}
            redo={undoStack.redo}
            canUndo={undoStack.canUndo}
            canRedo={undoStack.canRedo}
            undoDescription={undoStack.lastDescription}
            redoDescription={undoStack.nextDescription}
            onPushUndo={undoStack.push}
            onCreateAnchorAsset={handleCreateAnchorAsset}
            onCreateShot={handleCreateShot}
            onCreateStitchJob={handleCreateStitchJob}
            onConnectStitchShot={handleConnectStitchShot}
            onSetStitchOrder={handleSetStitchOrder}
            onDeleteCanvasAsset={handleDeleteCanvasAsset}
            onDeleteCanvasShot={handleDeleteCanvasShot}
            onUploadImageAsset={handleUploadImageAsset}
            onUploadReferenceVideo={handleUploadReferenceVideo}
            onStitch={handleStitch}
          />
        </Suspense>
      </section>
    </main>
    </PendingGenerationsProvider>
  );
}
