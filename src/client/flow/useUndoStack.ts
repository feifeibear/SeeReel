import { useCallback, useEffect, useRef, useState } from "react";

/**
 * One undoable user action. The pair of `undo` / `redo` callbacks must be **inverse round-trips**
 * to the server so the canvas stays in sync after either direction. They typically:
 *   - undo: tell the server to delete the thing the action just created (or restore a prior value)
 *   - redo: re-create the thing (or re-apply the changed value)
 * The pair runs sequentially and the caller is responsible for refreshing the snapshot afterwards
 * (we expose `lastError` so the UI can show a toast if undo / redo fails).
 */
export interface UndoableAction {
  description: string;
  undo: () => Promise<void> | void;
  redo: () => Promise<void> | void;
}

const MAX_STACK = 50;

/**
 * Tiny stack-based undo / redo for canvas-level structural mutations (create node, append shot,
 * apply parsed shot prompt, …). Generation calls aren't tracked — they burn tokens and the
 * artifact is the source of truth, not an undoable state.
 *
 * Ergonomics:
 *   - `push(action)` immediately after a successful mutation; clears the redo branch
 *   - `undo()` / `redo()` are no-ops when stack is empty or busy
 *   - emits `flow-undo-toast` window events with `{kind: "undo"|"redo", description}` so a
 *     single global toast component can show feedback without prop-drilling
 */
export function useUndoStack() {
  const pastRef = useRef<UndoableAction[]>([]);
  const futureRef = useRef<UndoableAction[]>([]);
  const [, setVersion] = useState(0);
  const [busy, setBusyState] = useState(false);
  const busyRef = useRef(false);

  const setBusy = useCallback((value: boolean) => {
    busyRef.current = value;
    setBusyState(value);
  }, []);

  const sync = useCallback(() => setVersion((v) => v + 1), []);

  const push = useCallback((action: UndoableAction) => {
    const next = [...pastRef.current, action];
    pastRef.current = next.length > MAX_STACK ? next.slice(next.length - MAX_STACK) : next;
    futureRef.current = [];
    sync();
  }, [sync]);

  const emit = (kind: "undo" | "redo", description: string) => {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent("flow-undo-toast", { detail: { kind, description } }));
  };

  const undo = useCallback(async () => {
    if (busyRef.current) return;
    const popped = pastRef.current[pastRef.current.length - 1];
    if (!popped) return;
    pastRef.current = pastRef.current.slice(0, -1);
    sync();
    setBusy(true);
    try {
      await popped.undo();
      futureRef.current = [popped, ...futureRef.current].slice(0, MAX_STACK);
      emit("undo", popped.description);
    } catch (error) {
      // On failure, push the action back onto past so the user can retry; surface a toast that
      // shows the error so they know something went wrong.
      pastRef.current = [...pastRef.current, popped].slice(-MAX_STACK);
      emit("undo", `撤销失败：${error instanceof Error ? error.message : "未知错误"}`);
    } finally {
      setBusy(false);
      sync();
    }
  }, [setBusy, sync]);

  const redo = useCallback(async () => {
    if (busyRef.current) return;
    const next = futureRef.current[0];
    if (!next) return;
    futureRef.current = futureRef.current.slice(1);
    sync();
    setBusy(true);
    try {
      await next.redo();
      pastRef.current = [...pastRef.current, next].slice(-MAX_STACK);
      emit("redo", next.description);
    } catch (error) {
      futureRef.current = [next, ...futureRef.current].slice(0, MAX_STACK);
      emit("redo", `恢复失败：${error instanceof Error ? error.message : "未知错误"}`);
    } finally {
      setBusy(false);
      sync();
    }
  }, [setBusy, sync]);

  const past = pastRef.current;
  const future = futureRef.current;

  return {
    push,
    undo,
    redo,
    canUndo: !busy && past.length > 0,
    canRedo: !busy && future.length > 0,
    busy,
    lastDescription: past[past.length - 1]?.description,
    nextDescription: future[0]?.description,
    pendingCount: past.length
  };
}

/**
 * Global keyboard binding for Cmd+Z / Cmd+Shift+Z (Ctrl on Linux/Windows). Skipped while the
 * focused element is an editable input — the browser's native undo is more useful there.
 */
export function useUndoKeyboardShortcut(undo: () => void, redo: () => void) {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select" || target?.isContentEditable) return;

      const meta = event.metaKey || event.ctrlKey;
      if (!meta || event.key.toLowerCase() !== "z") return;
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [undo, redo]);
}
