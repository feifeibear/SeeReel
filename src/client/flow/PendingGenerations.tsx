import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

/**
 * Tracks which assets / shots / etc are currently mid-generation, **on the client side**.
 * The set is independent from the server-side asset record — Seedream image gen is
 * synchronous on the server (no persisted "status" field on Asset like Shot has), so we
 * can't read it from /api/state. We mark the id in this set the moment the user clicks
 * "出图", clear it when the request resolves, and surface it in two places:
 *
 *  1. **Canvas node overlay**: AssetNode / StoryboardNode render a "生成中" spinner over
 *     the thumbnail when their id is in the set. The user can see at a glance that
 *     this node is still working — even after they've navigated to another node.
 *  2. **Inspector decoupling**: AssetInspector / StoryboardInspector kick off the
 *     `api.generateAsset(...)` call as fire-and-forget so the Inspector doesn't lock up
 *     for the whole duration. The user can edit other nodes / kick off another
 *     generation in parallel — the server handles them concurrently.
 *
 * Why a Set keyed by id rather than booleans-per-component: the user's whole complaint is
 * "one node blocks others". Centralized state means "multiple gens in flight" is the
 * natural representation; per-component booleans would re-introduce the lock.
 */

interface PendingGenerationsValue {
  /** Stable identity Set so consumers can early-return if their id isn't in it. */
  ids: Set<string>;
  /** Map id → ms-since-epoch when generation started. Used to render mm:ss elapsed on nodes. */
  startedAt: Map<string, number>;
  /** Mark a generation as starting (call once, before kicking off the request). */
  begin: (id: string) => void;
  /** Mark a generation as done (call in `finally`). Idempotent. */
  end: (id: string) => void;
  /** Convenience: wraps an async fn with begin/end and surfaces errors via the returned promise. */
  run: (id: string, fn: () => Promise<unknown>) => Promise<void>;
}

const PendingGenerationsContext = createContext<PendingGenerationsValue | null>(null);

export function PendingGenerationsProvider({ children }: { children: ReactNode }) {
  const [ids, setIds] = useState<Set<string>>(() => new Set());
  const [startedAt, setStartedAt] = useState<Map<string, number>>(() => new Map());
  const begin = useCallback((id: string) => {
    setIds((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
    setStartedAt((prev) => {
      if (prev.has(id)) return prev;
      const next = new Map(prev);
      next.set(id, Date.now());
      return next;
    });
  }, []);
  const end = useCallback((id: string) => {
    setIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setStartedAt((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }, []);
  const run = useCallback(async (id: string, fn: () => Promise<unknown>) => {
    begin(id);
    try {
      await fn();
    } finally {
      end(id);
    }
  }, [begin, end]);
  const value = useMemo<PendingGenerationsValue>(() => ({ ids, startedAt, begin, end, run }), [ids, startedAt, begin, end, run]);
  return (
    <PendingGenerationsContext.Provider value={value}>{children}</PendingGenerationsContext.Provider>
  );
}

/**
 * Read-only hook for nodes — returns whether `id` is currently generating PLUS a live mm:ss
 * elapsed string that re-renders every 5s while active. The ticker auto-stops when end() fires.
 */
export function usePendingGeneration(id: string): { active: boolean; elapsed?: string } {
  const ctx = useContext(PendingGenerationsContext);
  const active = Boolean(ctx?.ids.has(id));
  const start = ctx?.startedAt.get(id);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active || !start) return;
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(t);
  }, [active, start]);
  if (!active || !start) return { active };
  const sec = Math.max(0, Math.floor((now - start) / 1000));
  const mm = Math.floor(sec / 60);
  const ss = String(sec % 60).padStart(2, "0");
  return { active, elapsed: `${mm}:${ss}` };
}

/** Full-access hook for inspectors / handlers that need to mark begin / end. */
export function usePendingGenerationActions(): Pick<PendingGenerationsValue, "begin" | "end" | "run"> {
  const ctx = useContext(PendingGenerationsContext);
  if (!ctx) {
    // Provider not mounted — nodes will silently no-op rather than crash.
    return { begin: () => {}, end: () => {}, run: async (_id, fn) => { await fn(); } };
  }
  return { begin: ctx.begin, end: ctx.end, run: ctx.run };
}
