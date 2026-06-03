import { memo, useEffect, useRef, useState } from "react";
import { Download } from "lucide-react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { api } from "../api";
import { Lightbox } from "./Lightbox";
import { usePendingGeneration } from "./PendingGenerations";
import { useI18n, type Dictionary } from "../i18n";
import type { AssetImageModel, SeedanceVariant, SubStoryboardModel } from "../../shared/types";
import type {
  AssetNodeData,
  ReferenceVideoNodeData,
  StoryboardNodeData,
  ShotNodeData,
  StitchNodeData,
  TailframeNodeData,
  VideoProcessorNodeData
} from "./buildGraph";

/**
 * Compact in-node `<select>` for model variant picking. Stops every conceivable propagation so
 * clicking it does not select the node, doesn't open Inspector, and doesn't kick off a drag-to-
 * connect on the surrounding canvas. Persists the choice via the `onChange` async callback the
 * caller wires to `api.saveAsset` / `api.updateShot`.
 */
function NodeModelPicker<T extends string>({ value, options, onChange, title }: {
  value: T | undefined;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => Promise<void> | void;
  title?: string;
}) {
  const { t } = useI18n();
  return (
    <select
      className="flow-node-model"
      value={value ?? options[0]?.value}
      onChange={(e) => {
        e.stopPropagation();
        void onChange(e.target.value as T);
      }}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      title={title || t.nodes.modelPickerTitle}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  );
}

const ASSET_MODEL_OPTIONS: Array<{ value: AssetImageModel; label: string }> = [
  { value: "seedream-4-5", label: "Seedream 4.5" },
  { value: "seedream-5-lite", label: "Seedream 5 Lite (Agent Plan)" },
  { value: "seedream-4", label: "Seedream 4" },
  { value: "gpt-image-2", label: "GPT-Image-2" }
];
const STORYBOARD_MODEL_OPTIONS: Array<{ value: SubStoryboardModel; label: string }> = [
  { value: "seedream-4-5", label: "Seedream 4.5" },
  { value: "seedream-5-lite", label: "Seedream 5 Lite (Agent Plan)" },
  { value: "seedream-4", label: "Seedream 4" }
];
const SEEDANCE_OPTIONS: Array<{ value: SeedanceVariant; label: string }> = [
  { value: "standard", label: "Seedance 2.0" },
  { value: "fast", label: "Seedance 2.0 Fast" }
];

function effectiveAssetImageModel(asset: { generationModel?: AssetImageModel; generationModelActual?: string }, fallback?: AssetImageModel): AssetImageModel | undefined {
  const actual = asset?.generationModelActual;
  if (actual?.includes("seedream-5.0-lite") || actual?.includes("seedream-5-lite")) return "seedream-5-lite";
  if (actual?.includes("seedream-4-5")) return "seedream-4-5";
  if (actual?.includes("seedream-4-0") || actual?.includes("seedream-4")) return "seedream-4";
  return asset.generationModel || fallback;
}

function effectiveSubStoryboardModel(asset: { generationModel?: string; generationModelActual?: string } | undefined, shotModel?: SubStoryboardModel, fallback?: AssetImageModel): SubStoryboardModel | undefined {
  const actual = asset?.generationModelActual;
  if (actual?.includes("seedream-5.0-lite") || actual?.includes("seedream-5-lite")) return "seedream-5-lite";
  if (actual?.includes("seedream-4-5")) return "seedream-4-5";
  if (actual?.includes("seedream-4-0") || actual?.includes("seedream-4")) return "seedream-4";
  return shotModel || (fallback === "seedream-5-lite" ? "seedream-5-lite" : undefined);
}

type AssetFlowNode = Node<AssetNodeData, "assetNode">;
type StoryboardFlowNode = Node<StoryboardNodeData, "storyboardNode">;
type ShotFlowNode = Node<ShotNodeData, "shotNode">;
type StitchFlowNode = Node<StitchNodeData, "stitchNode">;
type ReferenceVideoFlowNode = Node<ReferenceVideoNodeData, "referenceVideoNode">;
type VideoProcessorFlowNode = Node<VideoProcessorNodeData, "videoProcessorNode">;
type TailframeFlowNode = Node<TailframeNodeData, "tailframeNode">;

// Shared visual constants. Each node is roughly the same size so the auto-layout in buildGraph.ts
// keeps a clean grid.
const NODE_WIDTH = 320;

function assetThumbUrl(asset: { mediaUrl?: string; imageUrl?: string; referenceImageUrl?: string }) {
  return asset.mediaUrl || asset.imageUrl || asset.referenceImageUrl;
}

/**
 * Fire-and-forget toast bridge: nodes call `emitDownloadToast(filename)` from inside the
 * download click handler; FlowView mounts <DownloadToast/> once and subscribes via window
 * 'flow-download' events. Decoupling keeps the thumbnail buttons dumb (no prop drilling) and
 * still gives the user a transient "已开始下载 xxx" confirmation.
 */
export function emitDownloadToast(filename: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<string>("flow-download", { detail: filename }));
}

/**
 * Fire-and-forget mutate notifier: in-node controls (model picker, anything that PATCHes the
 * underlying record) emit this event after their API call so FlowView can pull a fresh snapshot.
 * Without it, picker `value` reads from stale snapshot and the dropdown visually snaps back.
 */
export function emitFlowMutated() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("flow-mutated"));
}

/**
 * Tiny in-node download button. Stops propagation so clicking it doesn't also select the node.
 * The href hits one of the existing server-side proxied download routes:
 *   /api/assets/:id/download   — storyboard panels, character / scene / prop / style anchors
 *   /api/shots/:id/download    — shot video render
 *   /api/sessions/:id/download — final stitch
 * The server proxy gives us a clean filename + Content-Disposition; direct cross-origin TOS URLs
 * would also work but the browser ignores `download=` on cross-origin resources.
 */
function DownloadButton({ href, filename, title, onTriggered }: { href: string; filename?: string; title?: string; onTriggered?: () => void }) {
  const { t } = useI18n();
  return (
    <a
      className="flow-node-download"
      href={href}
      download={filename}
      title={title || t.nodes.download}
      onClick={(e) => {
        e.stopPropagation();
        onTriggered?.();
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <Download size={13} />
    </a>
  );
}

/**
 * In-node video thumbnail preview. Clicking the thumbnail selects the node and opens the
 * Inspector on the right; only the bottom-right ▶ button opens the full-page Lightbox player.
 *
 * Prefetch: once the thumbnail is in viewport for ~800 ms, upgrade preload to "auto" so the
 * lightbox play button feels instant when the user asks for playback.
 */
function RobustVideoThumb({ streamSrc, posterSrc, downloadUrl, downloadFilename, title }: {
  streamSrc: string;
  posterSrc?: string;
  /** Used by the lightbox download button. Defaults to streamSrc when not given. */
  downloadUrl?: string;
  downloadFilename?: string;
  /** Lightbox header title. */
  title?: string;
}) {
  const { t } = useI18n();
  const [errored, setErrored] = useState(false);
  const [open, setOpen] = useState(false);
  // Promote preload from metadata → auto once we're confident the user will likely play. Driven
  // by an IntersectionObserver-with-debounce so off-screen thumbs don't burn bandwidth.
  const [eager, setEager] = useState(false);
  const [resumeFromSec, setResumeFromSec] = useState(0);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    if (!wrapperRef.current || eager) return;
    let timer: number | undefined;
    const io = new IntersectionObserver((entries) => {
      const visible = entries.some((e) => e.isIntersecting);
      if (visible) {
        // Debounce — protects against pan/zoom flickering many thumbs in/out per frame.
        timer = window.setTimeout(() => setEager(true), 800);
      } else if (timer) {
        window.clearTimeout(timer);
        timer = undefined;
      }
    }, { threshold: 0.25 });
    io.observe(wrapperRef.current);
    return () => {
      io.disconnect();
      if (timer) window.clearTimeout(timer);
    };
  }, [eager]);

  useEffect(() => {
    setErrored(false);
    setResumeFromSec(0);
  }, [streamSrc, posterSrc]);

  const openLightbox = (e: React.MouseEvent) => {
    e.preventDefault();
    const v = videoRef.current;
    if (v) {
      setResumeFromSec(Number.isFinite(v.currentTime) ? v.currentTime : 0);
      try { v.pause(); } catch { /* ignore */ }
    }
    setOpen(true);
  };
  return (
    <>
      <div
        ref={wrapperRef}
        className="flow-thumb-preview"
        onMouseEnter={() => setEager(true)}
      >
        {errored ? (
          posterSrc ? (
            <img src={posterSrc} alt={title || "video poster"} loading="lazy" decoding="async" />
          ) : (
            <div className="flow-empty">{t.nodes.clickNodeForInspector}</div>
          )
        ) : (
          <video
            key={streamSrc}
            ref={videoRef}
            src={streamSrc}
            muted
            preload={eager ? "auto" : "metadata"}
            playsInline
            controls={false}
            poster={posterSrc}
            onError={() => setErrored(true)}
          />
        )}
        <button
          type="button"
          className="flow-thumb-play"
          title={t.nodes.playVideoTitle}
          aria-label={t.nodes.playVideoTitle}
          onClick={openLightbox}
          onMouseDown={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          ▶
        </button>
      </div>
      {open && (
        <Lightbox
          url={streamSrc}
          mediaKind="video"
          title={title}
          downloadUrl={downloadUrl || streamSrc}
          downloadFilename={downloadFilename}
          startTimeSec={resumeFromSec > 0.5 ? resumeFromSec : undefined}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function statusBadge(status: string | undefined, phase: string | undefined, t: Dictionary) {
  if (!status || status === "draft") return { color: "#6b7280", label: t.nodes.statusDraft };
  if (status === "scripted") return { color: "#fbbf24", label: t.nodes.statusScripted };
  if (status === "generating") {
    // Sub-phase tells the user whether the Seedance task is still queued at BytePlus (idle, can
    // sit for many minutes during peak hours) vs. actively rendering on a GPU. Surfaced because
    // queued time is not the user's fault and not something a re-submit fixes.
    if (phase === "queued") return { color: "#fbbf24", label: t.nodes.statusQueued };
    if (phase === "running") return { color: "#60a5fa", label: t.nodes.statusRunning };
    return { color: "#60a5fa", label: t.nodes.statusGenerating };
  }
  if (status === "ready") return { color: "#34d399", label: t.nodes.statusReady };
  if (status === "error") return { color: "#f87171", label: t.nodes.statusError };
  if (status === "cancelled") return { color: "#9ca3af", label: t.nodes.statusCancelled };
  return { color: "#6b7280", label: status };
}

function selectedShotRender(shot: ShotNodeData["shot"]) {
  return (shot.renders || []).find((render) => render.videoUrl === shot.videoUrl || render.remoteVideoUrl === shot.videoUrl);
}

function reviewBadge(t: Dictionary, status?: string, score?: number, stale?: boolean) {
  if (stale) return { color: "#fbbf24", label: t.nodes.reviewStale };
  if (status === "running") return { color: "#60a5fa", label: t.nodes.reviewRunning };
  if (status === "error") return { color: "#f87171", label: t.nodes.reviewError };
  if (typeof score === "number") {
    return score >= 80
      ? { color: "#34d399", label: t.nodes.reviewPass(score) }
      : { color: "#f87171", label: t.nodes.reviewNeedsFix(score) };
  }
  return { color: "#9ca3af", label: t.nodes.reviewNotRun };
}

function ReviewButton({ label, title, onClick }: { label: string; title: string; onClick: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="flow-review-button"
      title={title}
      disabled={busy}
      onClick={(e) => {
        e.stopPropagation();
        setBusy(true);
        void onClick().finally(() => setBusy(false));
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {busy ? "..." : label}
    </button>
  );
}

/**
 * Live mm:ss timer that re-renders every 10 seconds while the shot is generating. Returns
 * `undefined` when there's no startedAt (e.g. status flipped to ready/error). Kept as a custom
 * hook so each ShotNode owns its own ticker — no global timer fan-out.
 *
 * The 10-second cadence is intentional: video gen takes minutes, the user just needs minute-level
 * precision, and ticking faster would re-render every node every second for no UX gain.
 */
function useElapsedLabel(startedAt: string | null | undefined, active: boolean): string | undefined {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active || !startedAt) return;
    const tick = () => setNow(Date.now());
    tick();
    const id = window.setInterval(tick, 10_000);
    return () => window.clearInterval(id);
  }, [active, startedAt]);
  if (!startedAt) return undefined;
  const startMs = new Date(startedAt).getTime();
  if (!Number.isFinite(startMs)) return undefined;
  const elapsedSec = Math.max(0, Math.floor((now - startMs) / 1000));
  const min = Math.floor(elapsedSec / 60);
  const sec = elapsedSec % 60;
  return `${min}:${String(sec).padStart(2, "0")}`;
}

// ============================================================================
// AssetNode — col 0, anchor character / scene / prop / style
// ============================================================================

function AssetNodeImpl({ data, selected }: NodeProps<AssetFlowNode>) {
  const { asset } = data;
  const thumb = assetThumbUrl(asset);
  const { active: isGenerating, elapsed: pendingElapsed } = usePendingGeneration(asset.id);
  const { t } = useI18n();
  const typeLabel = t.nodes.assetTypes as Record<string, string>;
  const tag = typeLabel[asset.type] ?? asset.type;
  const reviewInfo = reviewBadge(t, asset.imageReviewStatus, asset.imageReview?.score);
  const showReviewBadge = asset.imageReviewStatus === "running" || asset.imageReviewStatus === "error" || Boolean(asset.imageReview);
  return (
    <div className={`flow-node asset-node ${selected ? "selected" : ""} ${isGenerating ? "generating" : ""}`} style={{ width: NODE_WIDTH }}>
      <div className="flow-node-head">
        <span className={`flow-tag tag-${asset.type}`}>{tag}</span>
        <strong className="flow-node-title" title={asset.name}>{asset.name}</strong>
        {isGenerating && (
          <span className="flow-node-pending-badge" title={t.nodes.pendingAssetTitle}>
            {t.nodes.generating}{pendingElapsed ? ` · ${pendingElapsed}` : "…"}
          </span>
        )}
        {thumb && (
          <ReviewButton
            label="VLM"
            title={t.nodes.reviewImageTitle}
            onClick={async () => {
              await api.reviewAssetImage(asset.id);
              emitFlowMutated();
            }}
          />
        )}
        {thumb && (
          <DownloadButton
            href={api.downloadAssetUrl(asset.id)}
            filename={`${asset.name}.png`}
            title={t.nodes.downloadOriginalImage(asset.name)}
            onTriggered={() => emitDownloadToast(`${asset.name}.png`)}
          />
        )}
      </div>
      <div className="flow-node-thumb fit-contain">
        {thumb ? <img src={thumb} alt={asset.name} loading="lazy" decoding="async" /> : <div className="flow-empty">{t.nodes.notGenerated}</div>}
        {isGenerating && (
          <div className="flow-node-pending-overlay">
            <span className="flow-empty-spinner" aria-hidden />
            {t.nodes.generating}{pendingElapsed ? ` · ${pendingElapsed}` : "…"}
            <small style={{ opacity: 0.65, marginTop: 4 }}>{t.nodes.seedreamReviewHint}</small>
          </div>
        )}
      </div>
      <div className="flow-node-foot">
        <NodeModelPicker<AssetImageModel>
          value={effectiveAssetImageModel(asset, data.defaultImageModel)}
          options={ASSET_MODEL_OPTIONS}
          onChange={async (model) => {
            await api.saveAsset({ id: asset.id, generationModel: model });
            emitFlowMutated();
          }}
          title={t.nodes.nextAssetModelTitle}
        />
        {showReviewBadge && (
          <small className="flow-review-badge" style={{ color: reviewInfo.color }}>{reviewInfo.label}</small>
        )}
        {asset.reviewAttempts && asset.reviewAttempts > 0 ? (
          <small className="flow-node-warn">{t.nodes.reviewAttempts(asset.reviewAttempts)}</small>
        ) : null}
      </div>
      <Handle type="source" position={Position.Right} id="out" />
    </div>
  );
}

// ============================================================================
// StoryboardNode — col 1, per-shot sub-storyboard 3x3 grid
// ============================================================================

function StoryboardNodeImpl({ data, selected }: NodeProps<StoryboardFlowNode>) {
  const { shot, asset } = data;
  const thumb = asset ? assetThumbUrl(asset) : undefined;
  const panelCount = shot.subShotPanelCount ?? 9;
  const { active: isGenerating, elapsed: pendingElapsed } = usePendingGeneration(shot.id);
  const { t } = useI18n();
  return (
    <div className={`flow-node storyboard-node ${selected ? "selected" : ""} ${isGenerating ? "generating" : ""}`} style={{ width: NODE_WIDTH }}>
      <Handle type="target" position={Position.Left} id="in" />
      <div className="flow-node-head">
        <span className="flow-tag tag-storyboard">{t.nodes.storyboard}</span>
        <strong className="flow-node-title" title={shot.title}>{shot.title || `Shot ${shot.index}`}</strong>
        {isGenerating && (
          <span className="flow-node-pending-badge" title={t.nodes.storyboardPendingTitle}>
            {t.nodes.generating}{pendingElapsed ? ` · ${pendingElapsed}` : "…"}
          </span>
        )}
        {thumb && asset && (
          <DownloadButton
            href={api.downloadAssetUrl(asset.id)}
            filename={`storyboard-${shot.title || `shot-${shot.index}`}.png`}
            title={t.nodes.downloadStoryboard}
            onTriggered={() => emitDownloadToast(`storyboard-${shot.title || `shot-${shot.index}`}.png`)}
          />
        )}
      </div>
      <div className="flow-node-thumb fit-contain">
        {thumb ? (
          <img src={thumb} alt={`storyboard ${shot.index}`} loading="lazy" decoding="async" />
        ) : (
          <div className="flow-empty">{t.nodes.storyboardEmpty}</div>
        )}
        {isGenerating && (
          <div className="flow-node-pending-overlay">
            <span className="flow-empty-spinner" aria-hidden />
            {t.nodes.generating}{pendingElapsed ? ` · ${pendingElapsed}` : "…"}
            <small style={{ opacity: 0.65, marginTop: 4 }}>{t.nodes.storyboardHint}</small>
          </div>
        )}
      </div>
      <div className="flow-node-foot">
        <NodeModelPicker<SubStoryboardModel>
          value={effectiveSubStoryboardModel(asset, shot.subStoryboardModel, data.defaultImageModel)}
          options={STORYBOARD_MODEL_OPTIONS}
          onChange={async (model) => {
            await api.updateShot(shot.id, { subStoryboardModel: model });
            emitFlowMutated();
          }}
          title={t.nodes.nextStoryboardModelTitle}
        />
        <small>{t.nodes.panelCount(panelCount)}</small>
        {asset?.referenceImageUrls?.length ? (
          <small className="flow-node-info">{t.nodes.refImageCount(asset.referenceImageUrls.length)}</small>
        ) : null}
      </div>
      <Handle type="source" position={Position.Right} id="out" />
    </div>
  );
}

// ============================================================================
// ShotNode — col 2, video render
// ============================================================================

function ShotNodeImpl({ data, selected }: NodeProps<ShotFlowNode>) {
  const { t } = useI18n();
  const { shot } = data;
  const status = statusBadge(shot.status, shot.seedancePhase, t);
  // While a generation is in flight (status === "generating") the previous successful video
  // would visually "pretend" the new render is already done. Hide the old preview during the
  // generation window so the user sees a clear "renewing" state.
  const isGenerating = shot.status === "generating";
  const selectedRender = selectedShotRender(shot);
  const videoUrl = isGenerating ? undefined : shot.videoUrl;
  // Live elapsed-since-submit label for the in-flight render. Falls back to the shot's own
  // generationStartedAt when the latest pending render hasn't been picked yet (e.g. immediately
  // after submission, before the first /poll lands and stamps the render row).
  const pendingRender = isGenerating
    ? (shot.renders || []).find((r) => r.status === "generating" || Boolean(r.generationTaskId))
    : undefined;
  const videoCacheKey = selectedRender?.id || videoUrl;
  const review = selectedRender?.videoReview || shot.videoReview;
  const reviewStatus = selectedRender?.videoReviewStatus || shot.videoReviewStatus;
  const reviewInfo = reviewBadge(t, reviewStatus, review?.score);
  const startedAt = pendingRender?.generationStartedAt || shot.generationStartedAt || undefined;
  const elapsed = useElapsedLabel(startedAt, isGenerating);
  return (
    <div className={`flow-node shot-node ${selected ? "selected" : ""}`} style={{ width: NODE_WIDTH }}>
      <Handle type="target" position={Position.Left} id="in" />
      <div className="flow-node-head">
        <span className="flow-tag tag-shot">{t.nodes.video}</span>
        <strong className="flow-node-title" title={shot.title}>{shot.title || `Shot ${shot.index}`}</strong>
        {videoUrl && (
          <ReviewButton
            label="VLM"
            title={t.nodes.reviewShotTitle}
            onClick={async () => {
              await api.reviewShotVideo(shot.id);
              emitFlowMutated();
            }}
          />
        )}
        {videoUrl && (
          <DownloadButton
            href={api.downloadShotUrl(shot.id)}
            filename={`${shot.title || `shot-${shot.index}`}.mp4`}
            title={t.nodes.downloadShot}
            onTriggered={() => emitDownloadToast(`${shot.title || `shot-${shot.index}`}.mp4`)}
          />
        )}
        {videoUrl && (
          <ReviewButton
            label={t.nodes.tailframe}
            title={t.nodes.tailframeTitle}
            onClick={async () => {
              await api.createShotTailFrame(shot.id, { publishToTos: true, canvasNode: true });
              emitFlowMutated();
            }}
          />
        )}
      </div>
      <div className="flow-node-thumb fit-contain">
        {isGenerating ? (
          <div className="flow-empty flow-empty-generating">
            <span className="flow-empty-spinner" aria-hidden /> {t.nodes.generating}…
            {elapsed && <small className="flow-elapsed">{t.nodes.elapsed(elapsed)}</small>}
          </div>
        ) : videoUrl ? (
          <RobustVideoThumb
            streamSrc={api.shotStreamUrl(shot.id, videoCacheKey)}
            posterSrc={api.shotPosterUrl(shot.id, videoCacheKey)}
            downloadUrl={api.downloadShotUrl(shot.id)}
            downloadFilename={`${shot.title || `shot-${shot.index}`}.mp4`}
            title={shot.title || `Shot ${shot.index}`}
          />
        ) : (
          <div className="flow-empty">{t.nodes.notGenerated}</div>
        )}
      </div>
      <div className="flow-node-foot">
        <NodeModelPicker<SeedanceVariant>
          value={shot.seedanceVariant}
          options={SEEDANCE_OPTIONS}
          onChange={async (variant) => {
            await api.updateShot(shot.id, { seedanceVariant: variant });
            emitFlowMutated();
          }}
          title={t.nodes.nextSeedanceModelTitle}
        />
        <span className="flow-status" style={{ color: status.color }}>
          ● {status.label}{isGenerating && elapsed ? ` · ${elapsed}` : ""}
        </span>
        {videoUrl && <small className="flow-review-badge" style={{ color: reviewInfo.color }}>{reviewInfo.label}</small>}
        <small>{shot.durationSec || 0}s</small>
      </div>
      <Handle type="source" position={Position.Right} id="out" />
    </div>
  );
}

// ============================================================================
// StitchNode — col 3, single output for the whole session
// ============================================================================

function StitchNodeImpl({ data, selected }: NodeProps<StitchFlowNode>) {
  const { t } = useI18n();
  const { session, job, legacy } = data;
  const status = job.status;
  // Same reasoning as ShotNode: while a stitch is running we hide the previous final so the
  // user doesn't think the old version is the new one.
  const isStitching = status === "running";
  const final = isStitching ? undefined : job.finalVideoUrl;
  const label = status === "ready" ? t.nodes.stitched : status === "running" ? t.nodes.stitching : status === "error" ? t.nodes.stitchError : t.nodes.notStitched;
  const color = status === "ready" ? "#34d399" : status === "running" ? "#60a5fa" : status === "error" ? "#f87171" : "#6b7280";
  const reviewStale = Boolean(job.finalVideoReviewBuiltForSignature && job.finalVideoSignature && job.finalVideoReviewBuiltForSignature !== job.finalVideoSignature);
  const finalReviewInfo = reviewBadge(t, job.finalVideoReviewStatus, job.finalVideoReview?.score, reviewStale);
  const finalCacheKey = job.finalVideoGeneratedAt || job.finalVideoUrl || job.finalVideoSignature || job.updatedAt;
  const stitchCount = job.shotIds?.length || 0;
  const stitchHint = stitchCount > 0 ? t.nodes.connectedSegmentsHint(stitchCount) : t.nodes.stitchEmptyHint;
  const jobId = legacy ? undefined : job.id;
  const title = job.name || t.nodes.fullVideo;
  return (
    <div className={`flow-node stitch-node ${selected ? "selected" : ""}`} style={{ width: NODE_WIDTH }}>
      <Handle type="target" position={Position.Left} id="in" />
      <div className="flow-node-head">
        <span className="flow-tag tag-stitch">{t.nodes.stitch}</span>
        <strong className="flow-node-title">{title}</strong>
        {final && (
          <ReviewButton
            label={t.nodes.finalReview}
            title={t.nodes.finalReviewTitle}
            onClick={async () => {
              await api.reviewFinalVideo(session.id, jobId);
              emitFlowMutated();
            }}
          />
        )}
        {final && (
          <DownloadButton
            href={api.downloadSessionUrl(session.id, jobId)}
            filename={`${session.title || session.id}-${title}.mp4`}
            title={t.nodes.downloadFinal}
            onTriggered={() => emitDownloadToast(`${session.title || session.id}-${title}.mp4`)}
          />
        )}
      </div>
      <div className="flow-node-thumb fit-contain">
        {isStitching ? (
          <div className="flow-empty flow-empty-generating">
            <span className="flow-empty-spinner" aria-hidden /> {t.nodes.stitching}…
          </div>
        ) : final ? (
          <RobustVideoThumb
            streamSrc={api.sessionStreamUrl(session.id, finalCacheKey, jobId)}
            posterSrc={api.sessionPosterUrl(session.id, finalCacheKey, jobId)}
            downloadUrl={api.downloadSessionUrl(session.id, jobId)}
            downloadFilename={`${session.title || session.id}-${title}.mp4`}
            title={`${session.title || session.id} · ${title}`}
          />
        ) : (
          <div className="flow-empty">{stitchHint}</div>
        )}
      </div>
      <div className="flow-node-foot">
        <span className="flow-status" style={{ color }}>● {label}</span>
        {final && <small className="flow-review-badge" style={{ color: finalReviewInfo.color }}>{finalReviewInfo.label}</small>}
        <small>{t.nodes.targetDuration(session.targetDurationSec)}</small>
      </div>
    </div>
  );
}

// ============================================================================
// ReferenceVideoNode — col 0 (below anchors), uploaded reference video that the user wants the
// session to imitate. Its real output is the parsed shot table inside Inspector; on the canvas it
// just shows a poster + parse status badge. Has a source handle so the Inspector can offer
// "Apply parsed shot to <session shot>" picks (semantic edge: parsed-shot → target-shot prompt).
// ============================================================================

function ReferenceVideoNodeImpl({ data, selected }: NodeProps<ReferenceVideoFlowNode>) {
  const { t } = useI18n();
  const { asset } = data;
  const videoUrl = asset.mediaUrl || asset.imageUrl;
  // Reuse the lazy poster route — it works for any /media/*.mp4, regardless of which route created
  // the asset. We synthesize a stable cache key from the asset id so re-uploads invalidate.
  const posterHref = videoUrl ? api.assetPosterUrl(asset.id, asset.updatedAt || asset.id) : undefined;
  const status = asset.parseStatus || "idle";
  const { color, label } = (() => {
    if (status === "parsing") return { color: "#60a5fa", label: t.nodes.parsing };
    if (status === "ready") return { color: "#34d399", label: t.nodes.parsedShots(asset.parsedShots?.length ?? 0) };
    if (status === "error") return { color: "#f87171", label: t.nodes.parseFailed };
    return { color: "#9ca3af", label: t.nodes.parsePending };
  })();
  return (
    <div className={`flow-node refvideo-node ${selected ? "selected" : ""}`} style={{ width: NODE_WIDTH }}>
      <div className="flow-node-head">
        <span className="flow-tag tag-refvideo">{t.nodes.referenceVideo}</span>
        <strong className="flow-node-title" title={asset.name}>{asset.name}</strong>
        {videoUrl && (
          <DownloadButton
            href={api.downloadAssetUrl(asset.id)}
            filename={`${asset.name}.mp4`}
            title={t.nodes.downloadReferenceVideo}
            onTriggered={() => emitDownloadToast(`${asset.name}.mp4`)}
          />
        )}
      </div>
      <div className="flow-node-thumb fit-contain">
        {videoUrl ? (
          <RobustVideoThumb
            streamSrc={api.assetStreamUrl(asset.id, asset.updatedAt || asset.id)}
            posterSrc={posterHref}
            downloadUrl={api.downloadAssetUrl(asset.id)}
            downloadFilename={`${asset.name}.mp4`}
            title={asset.name}
          />
        ) : (
          <div className="flow-empty">{t.nodes.notUploaded}</div>
        )}
      </div>
      <div className="flow-node-foot">
        <span className="flow-status" style={{ color }}>● {label}</span>
        <small>{t.nodes.applyParsedHint}</small>
      </div>
      <Handle type="source" position={Position.Right} id="out" />
    </div>
  );
}

// ============================================================================
// VideoProcessorNode — col 1, between RefVideo (col 0) and Storyboard (col 2). Represents a
// derivative asset produced by `POST /api/assets/:sourceId/derive-clip`. The node displays the
// current clip strategy + duration metric and exposes a thumbnail of the derivative output. It
// has a target handle (left) connected to the source RefVideo by a structural blue edge, and a
// source handle (right) the user drags to a Shot to bind it as Seedance reference_video.
// ============================================================================

function VideoProcessorNodeImpl({ data, selected }: NodeProps<VideoProcessorFlowNode>) {
  const { t } = useI18n();
  const { asset, sourceAsset } = data;
  const videoUrl = asset.mediaUrl || asset.imageUrl;
  const posterHref = videoUrl ? api.assetPosterUrl(asset.id, asset.updatedAt || asset.id) : undefined;
  const strategyLabel = asset.clipStrategy === "trim" ? t.nodes.trim15
    : asset.clipStrategy === "speedup" ? t.nodes.speedup
    : asset.clipStrategy === "sample-concat" ? t.nodes.sampleConcat
    : t.nodes.unclipped;
  const durationLabel = asset.originalDurationSec !== undefined && asset.clipDurationSec !== undefined
    ? `${asset.originalDurationSec.toFixed(1)}s → ${asset.clipDurationSec.toFixed(1)}s`
    : asset.clipDurationSec !== undefined
      ? `${asset.clipDurationSec.toFixed(1)}s`
      : "";
  return (
    <div className={`flow-node videoproc-node ${selected ? "selected" : ""}`} style={{ width: NODE_WIDTH }}>
      <Handle type="target" position={Position.Left} id="in" />
      <div className="flow-node-head">
        <span className="flow-tag tag-videoproc">{t.nodes.videoProcessor}</span>
        <strong className="flow-node-title" title={asset.name}>{asset.name}</strong>
        {videoUrl && (
          <DownloadButton
            href={api.downloadAssetUrl(asset.id)}
            filename={`${asset.name}.mp4`}
            title={t.nodes.downloadClip}
            onTriggered={() => emitDownloadToast(`${asset.name}.mp4`)}
          />
        )}
      </div>
      <div className="flow-node-thumb fit-contain">
        {videoUrl ? (
          <RobustVideoThumb
            streamSrc={api.assetStreamUrl(asset.id, asset.updatedAt || asset.id)}
            posterSrc={posterHref}
            downloadUrl={api.downloadAssetUrl(asset.id)}
            downloadFilename={`${asset.name}.mp4`}
            title={asset.name}
          />
        ) : (
          <div className="flow-empty">{t.nodes.notGenerated}</div>
        )}
      </div>
      <div className="flow-node-foot">
        <span className="flow-status" style={{ color: "#60a5fa" }}>● {strategyLabel}</span>
        {durationLabel && <small>{durationLabel}</small>}
        {sourceAsset && <small style={{ opacity: 0.7 }}>{t.nodes.source(sourceAsset.name)}</small>}
      </div>
      <Handle type="source" position={Position.Right} id="out" />
    </div>
  );
}

// ============================================================================
// TailframeNode — extracted last frame from a shot video, draggable as first_frame anchor
// ============================================================================

function TailframeNodeImpl({ data, selected }: NodeProps<TailframeFlowNode>) {
  const { t } = useI18n();
  const { asset, sourceShot, targetShots } = data;
  const thumb = assetThumbUrl(asset);
  const targetLabel = targetShots.length
    ? t.nodes.usedBy(targetShots.map((shot) => shot.title || `Shot ${shot.index}`).join("、"))
    : t.nodes.dragToVideo;
  return (
    <div className={`flow-node asset-node ${selected ? "selected" : ""}`} style={{ width: NODE_WIDTH }}>
      <Handle type="target" position={Position.Left} id="in" />
      <div className="flow-node-head">
        <span className="flow-tag tag-scene">{t.nodes.tailframe}</span>
        <strong className="flow-node-title" title={asset.name}>{asset.name}</strong>
        {thumb && (
          <DownloadButton
            href={api.downloadAssetUrl(asset.id)}
            filename={`${asset.name}.png`}
            title={t.nodes.downloadOriginalImage(asset.name)}
            onTriggered={() => emitDownloadToast(`${asset.name}.png`)}
          />
        )}
      </div>
      <div className="flow-node-thumb fit-contain">
        {thumb ? <img src={thumb} alt={asset.name} loading="lazy" decoding="async" /> : <div className="flow-empty">{t.nodes.notExtracted}</div>}
      </div>
      <div className="flow-node-foot">
        <span className="flow-status" style={{ color: "#38bdf8" }}>● {t.nodes.frameAnchor}</span>
        {sourceShot && <small>{t.nodes.fromShot(sourceShot.title || `Shot ${sourceShot.index}`)}</small>}
        <small>{targetLabel}</small>
      </div>
      <Handle type="source" position={Position.Right} id="out" />
    </div>
  );
}

// ============================================================================
// Memo wrappers — re-render a node only when its meaningful data changed.
// ============================================================================
//
// ReactFlow rebuilds `nodes` array on every snapshot poll, so each node receives a *new* `data`
// object reference even when content didn't change. Without memo, every Node component (and its
// children — RobustVideoThumb, image thumbnails, etc.) re-renders on every poll. With memo +
// shallow ref-compare on the inner state row(s), we skip render for nodes whose underlying shot/
// asset/session reference is unchanged. Combined with the structural-merge in App.refresh(),
// the only nodes that re-render are the ones that actually got new data.

export const AssetNode = memo(AssetNodeImpl, (prev, next) =>
  prev.selected === next.selected && prev.data.asset === next.data.asset
);
export const StoryboardNode = memo(StoryboardNodeImpl, (prev, next) =>
  prev.selected === next.selected
  && prev.data.shot === next.data.shot
  && prev.data.asset === next.data.asset
);
export const ShotNode = memo(ShotNodeImpl, (prev, next) =>
  prev.selected === next.selected && prev.data.shot === next.data.shot
);
export const StitchNode = memo(StitchNodeImpl, (prev, next) =>
  prev.selected === next.selected
  && prev.data.session === next.data.session
  && prev.data.job === next.data.job
  && prev.data.legacy === next.data.legacy
);
export const ReferenceVideoNode = memo(ReferenceVideoNodeImpl, (prev, next) =>
  prev.selected === next.selected && prev.data.asset === next.data.asset
);
export const VideoProcessorNode = memo(VideoProcessorNodeImpl, (prev, next) =>
  prev.selected === next.selected
  && prev.data.asset === next.data.asset
  && prev.data.sourceAsset === next.data.sourceAsset
);
export const TailframeNode = memo(TailframeNodeImpl, (prev, next) =>
  prev.selected === next.selected
  && prev.data.asset === next.data.asset
  && prev.data.sourceShot === next.data.sourceShot
  && prev.data.targetShots === next.data.targetShots
);
