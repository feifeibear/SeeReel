import { useEffect, useState } from "react";
import { Download, RotateCcw, RotateCw } from "lucide-react";

interface ToastEntry {
  id: number;
  text: string;
  /** Visual variant — only the icon and accent color differ. */
  kind: "download" | "undo" | "redo";
}

const TOAST_TTL_MS = 2400;

/**
 * Listens to window 'flow-download' AND 'flow-undo-toast' CustomEvents and shows a small
 * auto-dismissing toast in the top-right of the canvas. Decoupled from the buttons that emit
 * the events — anywhere in the tree can dispatch them and this single mounted instance flashes
 * the confirmation. See `emitDownloadToast` (nodes.tsx) and `useUndoStack.emit` for senders.
 */
export function DownloadToast() {
  const [entries, setEntries] = useState<ToastEntry[]>([]);

  useEffect(() => {
    const onDownload = (event: Event) => {
      const detail = (event as CustomEvent<string>).detail;
      const filename = typeof detail === "string" ? detail : "已开始下载";
      const id = Date.now() + Math.random();
      setEntries((prev) => [...prev, { id, text: filename, kind: "download" }]);
      window.setTimeout(() => setEntries((prev) => prev.filter((e) => e.id !== id)), TOAST_TTL_MS);
    };
    const onUndoRedo = (event: Event) => {
      const detail = (event as CustomEvent<{ kind: "undo" | "redo"; description: string }>).detail;
      const id = Date.now() + Math.random();
      const kind = detail?.kind === "redo" ? "redo" : "undo";
      const text = detail?.description || (kind === "undo" ? "已撤销" : "已恢复");
      setEntries((prev) => [...prev, { id, text, kind }]);
      window.setTimeout(() => setEntries((prev) => prev.filter((e) => e.id !== id)), TOAST_TTL_MS);
    };
    window.addEventListener("flow-download", onDownload);
    window.addEventListener("flow-undo-toast", onUndoRedo);
    return () => {
      window.removeEventListener("flow-download", onDownload);
      window.removeEventListener("flow-undo-toast", onUndoRedo);
    };
  }, []);

  if (!entries.length) return null;
  return (
    <div className="download-toast-stack" aria-live="polite">
      {entries.map((entry) => (
        <div key={entry.id} className={`download-toast download-toast-${entry.kind}`}>
          {entry.kind === "download" && <Download size={13} />}
          {entry.kind === "undo" && <RotateCcw size={13} />}
          {entry.kind === "redo" && <RotateCw size={13} />}
          <span>
            {entry.kind === "download" ? "已开始下载" : entry.kind === "undo" ? "已撤销" : "已恢复"}
          </span>
          <strong>{entry.text}</strong>
        </div>
      ))}
    </div>
  );
}
