import { useEffect } from "react";
import { Download, X } from "lucide-react";
import { useI18n } from "../i18n";

interface LightboxProps {
  url: string;
  /** "image" or "video". When undefined, sniff by extension. */
  mediaKind?: "image" | "video";
  title?: string;
  /** Optional download URL — when provided shows a "下载原图" button. */
  downloadUrl?: string;
  downloadFilename?: string;
  /**
   * Seek the video to this timestamp (seconds) on open. Used by the canvas thumbnail to resume
   * playback from where the inline preview was — avoids re-fetching from byte 0 and gives the
   * "instant playback" feel the user expects after a hover-prefetch.
   */
  startTimeSec?: number;
  onClose: () => void;
}

/**
 * Full-screen lightbox for inspecting a single node's media at native resolution. Click anywhere
 * on the dark backdrop OR press Escape to dismiss. Stops scroll-through on the body while open.
 *
 * Used by node thumbnails (click the image/video → see uncropped detail) and by Inspector
 * preview-buttons. Independent of xyflow.
 */
export function Lightbox({ url, mediaKind, title, downloadUrl, downloadFilename, startTimeSec, onClose }: LightboxProps) {
  const { t } = useI18n();
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const kind = mediaKind || (/\.(mp4|webm|mov|m4v)(?:[?#].*)?$/i.test(url) ? "video" : "image");

  return (
    <div className="lightbox-backdrop" onClick={onClose} role="dialog" aria-modal="true" aria-label={title || t.lightbox.preview}>
      <div className="lightbox-panel" onClick={(e) => e.stopPropagation()}>
        <header className="lightbox-head">
          <strong title={title}>{title || t.lightbox.preview}</strong>
          <div className="lightbox-actions">
            {downloadUrl && (
              <a
                className="lightbox-btn"
                href={downloadUrl}
                download={downloadFilename}
                title={t.lightbox.downloadOriginal}
              >
                <Download size={14} /> {t.lightbox.download}
              </a>
            )}
            <button type="button" className="lightbox-btn" onClick={onClose} aria-label={t.lightbox.close}>
              <X size={14} /> {t.lightbox.close}
            </button>
          </div>
        </header>
        <div className="lightbox-body">
          {kind === "video" ? (
            <video
              src={url}
              controls
              autoPlay
              preload="auto"
              onLoadedMetadata={(e) => {
                // Seek to the inline thumbnail's playhead. Doing it on `loadedmetadata` (not at
                // construction) is the only reliable hook — setting currentTime before metadata
                // is loaded is a no-op in most browsers.
                if (typeof startTimeSec === "number" && startTimeSec > 0) {
                  try { e.currentTarget.currentTime = startTimeSec; } catch { /* ignore */ }
                }
              }}
              onError={(e) => {
                // Browser refused inline playback (CORS/expiry/codec). Fall back to a tab nav so
                // the user at least sees / saves the video instead of a black box.
                const target = e.currentTarget;
                target.style.display = "none";
                const fallback = target.parentElement?.querySelector(".lightbox-error") as HTMLElement | null;
                if (fallback) fallback.style.display = "flex";
              }}
            />
          ) : (
            <img src={url} alt={title || ""} />
          )}
          {kind === "video" && (
            <div className="lightbox-error" style={{ display: "none" }}>
              <p>{t.lightbox.videoFailed}</p>
              <a href={url} target="_blank" rel="noreferrer">{t.lightbox.openNewTab}</a>
              {downloadUrl && <a href={downloadUrl} download={downloadFilename}>{t.lightbox.downloadLocal}</a>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
