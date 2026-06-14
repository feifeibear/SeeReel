import { memo, useEffect, useRef, useState } from "react";
import { Download } from "lucide-react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { api } from "../api";
import { usePendingGeneration } from "./PendingGenerations";
import { useI18n, type Dictionary } from "../i18n";
import { assetThumbUrl, tailframeThumbUrl } from "./mediaUrls";
import { selectedShotPendingRender } from "../../shared/shotGenerationState";
import { voicePresetForId } from "../../shared/voicePresets";
import { normalizeSubStoryboardModel } from "../../shared/imageModels";
import type { SubStoryboardModel } from "../../shared/types";
import type {
  AudioTrackNodeData,
  AssetNodeData,
  MusicNodeData,
  ReferenceVideoNodeData,
  StoryboardNodeData,
  ShotNodeData,
  StitchNodeData,
  TailframeNodeData,
  VoiceNodeData,
  VideoAssetNodeData,
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

const STORYBOARD_MODEL_OPTIONS: Array<{ value: SubStoryboardModel; label: string }> = [
  { value: "seedream-4-5", label: "Seedream 4.5" },
  { value: "seedream-5-lite", label: "Seedream 5.0 Lite" },
  { value: "seedream-4", label: "Seedream 4" }
];
function effectiveSubStoryboardModel(asset: { generationModel?: string; generationModelActual?: string } | undefined, shotModel?: SubStoryboardModel, fallback?: string): SubStoryboardModel | undefined {
  const actual = normalizeSubStoryboardModel(asset?.generationModelActual);
  if (actual) return actual;
  return shotModel || (fallback === "seedream-5-lite" ? "seedream-5-lite" : undefined);
}

type AssetFlowNode = Node<AssetNodeData, "assetNode" | "imageNode" | "moodboardNode">;
type StoryboardFlowNode = Node<StoryboardNodeData, "storyboardNode">;
type ShotFlowNode = Node<ShotNodeData, "shotNode">;
type StitchFlowNode = Node<StitchNodeData, "stitchNode">;
type AudioTrackFlowNode = Node<AudioTrackNodeData, "audioTrackNode">;
type VoiceFlowNode = Node<VoiceNodeData, "voiceNode">;
type MusicFlowNode = Node<MusicNodeData, "musicNode">;
type ReferenceVideoFlowNode = Node<ReferenceVideoNodeData, "referenceVideoNode">;
type VideoAssetFlowNode = Node<VideoAssetNodeData, "videoAssetNode">;
type VideoProcessorFlowNode = Node<VideoProcessorNodeData, "videoProcessorNode">;
type TailframeFlowNode = Node<TailframeNodeData, "tailframeNode">;

// Shared visual constants. Each node is roughly the same size so the auto-layout in buildGraph.ts
// keeps a clean grid.
const NODE_WIDTH = 320;

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
 * In-node video player. The node itself still opens the Inspector from non-player chrome, while
 * the player area opts out of canvas drag/pan so the user can play, pause, and scrub directly in
 * the canvas.
 *
 * Prefetch: once the player is in viewport for ~800 ms, upgrade preload to "auto" so playback
 * feels instant when the user asks for it.
 */
function RobustVideoThumb({ streamSrc, posterSrc, downloadUrl, downloadFilename, title }: {
  streamSrc: string;
  posterSrc?: string;
  downloadUrl?: string;
  downloadFilename?: string;
  title?: string;
}) {
  const { t } = useI18n();
  const [errored, setErrored] = useState(false);
  void downloadUrl;
  void downloadFilename;
  // Promote preload from metadata to auto once we're confident the user will likely play. Driven
  // by an IntersectionObserver-with-debounce so off-screen thumbs don't burn bandwidth.
  const [eager, setEager] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

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
  }, [streamSrc, posterSrc]);

  const stopCanvasGesture = (e: React.MouseEvent | React.PointerEvent) => e.stopPropagation();

  return (
    <div
      ref={wrapperRef}
      className="flow-thumb-preview flow-video-player"
      title={title || t.nodes.playVideoTitle}
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
          className="flow-video-element nodrag nopan"
          key={streamSrc}
          src={streamSrc}
          muted
          preload={eager ? "auto" : "metadata"}
          playsInline
          controls
          poster={posterSrc}
          onMouseDown={(e) => e.stopPropagation()}
          onPointerDown={stopCanvasGesture}
          onClick={stopCanvasGesture}
          onDoubleClick={stopCanvasGesture}
          onError={() => setErrored(true)}
        />
      )}
    </div>
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

function formatDurationLabel(durationSec: number | undefined | null) {
  if (durationSec === undefined || durationSec === null || !Number.isFinite(durationSec) || durationSec <= 0) return "";
  const total = Math.max(1, Math.round(durationSec));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function VideoDurationBadge({ seconds }: { seconds?: number | null }) {
  const label = formatDurationLabel(seconds);
  if (!label) return null;
  return <span className="flow-node-duration-badge" title={`Duration ${label}`}>{label}</span>;
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
  const referenceAssets = (data.referenceAssets || []).filter((item) => tailframeThumbUrl(item));
  const thumb = tailframeThumbUrl(asset);
  const { active: isGenerating, elapsed: pendingElapsed } = usePendingGeneration(asset.id);
  const { t } = useI18n();
  const typeLabel = t.nodes.assetTypes as Record<string, string>;
  const isMoodboard = asset.tags?.includes("moodboard");
  const tagKey = isMoodboard ? "moodboard" : asset.type;
  const tag = typeLabel[tagKey] ?? tagKey;
  const reviewInfo = reviewBadge(t, asset.imageReviewStatus, asset.imageReview?.score);
  const showReviewBadge = asset.imageReviewStatus === "running" || asset.imageReviewStatus === "error" || Boolean(asset.imageReview);
  const isUploading = asset.tags?.includes("client-pending-upload");
  return (
    <div className={`flow-node asset-node ${selected ? "selected" : ""} ${(isGenerating || isUploading) ? "generating" : ""}`} style={{ width: NODE_WIDTH }}>
      <Handle type="target" position={Position.Left} id="in" />
      <div className="flow-node-head">
        <span className={`flow-tag tag-${tagKey}`}>{tag}</span>
        <strong className="flow-node-title" title={asset.name}>{asset.name}</strong>
        {isUploading && (
          <span className="flow-node-pending-badge" title={t.app.pendingUpload}>
            {t.app.pendingUpload}
          </span>
        )}
        {isGenerating && (
          <span className="flow-node-pending-badge" title={t.nodes.pendingAssetTitle}>
            {t.nodes.generating}{pendingElapsed ? ` · ${pendingElapsed}` : "…"}
          </span>
        )}
        {thumb && !isUploading && (
          <ReviewButton
            label="VLM"
            title={t.nodes.reviewImageTitle}
            onClick={async () => {
              await api.reviewAssetImage(asset.id);
              emitFlowMutated();
            }}
          />
        )}
        {thumb && !isUploading && (
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
        {isUploading && (
          <div className="flow-node-pending-overlay">
            <span className="flow-empty-spinner" aria-hidden />
            {t.app.pendingUpload}
          </div>
        )}
      </div>
      <div className="flow-node-foot">
        {showReviewBadge && (
          <small className="flow-review-badge" style={{ color: reviewInfo.color }}>{reviewInfo.label}</small>
        )}
        {asset.reviewAttempts && asset.reviewAttempts > 0 ? (
          <small className="flow-node-warn">{t.nodes.reviewAttempts(asset.reviewAttempts)}</small>
        ) : null}
      </div>
      {referenceAssets.length > 0 && (
        <div className="flow-node-reference-strip" title="可 @ 引用的连线参考图">
          <span>可 @</span>
          {referenceAssets.slice(0, 4).map((reference) => {
            const url = tailframeThumbUrl(reference) as string;
            return <img key={reference.id} src={url} alt={reference.name} loading="lazy" decoding="async" />;
          })}
          {referenceAssets.length > 4 && <small>+{referenceAssets.length - 4}</small>}
        </div>
      )}
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
  // While a generation is in flight (status === "generating") the previous successful video
  // would visually "pretend" the new render is already done. Hide the old preview during the
  // generation window so the user sees a clear "renewing" state.
  const isGenerating = shot.status === "generating";
  const selectedRender = selectedShotRender(shot);
  const videoUrl = isGenerating ? undefined : shot.videoUrl;
  // Live elapsed-since-submit label for the in-flight render. Falls back to the shot's own
  // generationStartedAt when the latest pending render hasn't been picked yet (e.g. immediately
  // after submission, before the first /poll lands and stamps the render row).
  const pendingRender = selectedShotPendingRender(shot);
  const videoCacheKey = selectedRender?.id || videoUrl;
  const startedAt = pendingRender?.generationStartedAt || shot.generationStartedAt || undefined;
  const elapsed = useElapsedLabel(startedAt, isGenerating);
  const durationSec = selectedRender?.durationSec ?? shot.durationSec;
  return (
    <div className={`flow-node shot-node ${selected ? "selected" : ""}`} style={{ width: NODE_WIDTH }}>
      <Handle type="target" position={Position.Left} id="in" />
      <div className="flow-node-head">
        <span className="flow-tag tag-shot">{t.nodes.video}</span>
        <strong className="flow-node-title" title={shot.title}>{shot.title || `Shot ${shot.index}`}</strong>
        <VideoDurationBadge seconds={durationSec} />
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
            title={shot.title || `Shot ${shot.index}`}
          />
        ) : (
          <div className="flow-empty">{t.nodes.notGenerated}</div>
        )}
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
  const finalVideoStale = Boolean(job.finalVideoStale || (legacy && session.finalVideoStale));
  const label = finalVideoStale && final ? "源视频已更新" : status === "ready" ? t.nodes.stitched : status === "running" ? t.nodes.stitching : status === "error" ? t.nodes.stitchError : t.nodes.notStitched;
  const color = finalVideoStale && final ? "#f59e0b" : status === "ready" ? "#34d399" : status === "running" ? "#60a5fa" : status === "error" ? "#f87171" : "#6b7280";
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
      <Handle type="source" position={Position.Right} id="out" />
    </div>
  );
}

// ============================================================================
// AudioTrackNode — post-stitch narration / audio-mix output
// ============================================================================

function AudioTrackNodeImpl({ data, selected }: NodeProps<AudioTrackFlowNode>) {
  const { session, job } = data;
  const status = session.narrationStatus || "idle";
  const separationStatus = session.audioSeparationStatus || "idle";
  const isRunning = status === "running";
  const videoUrl = isRunning ? undefined : session.narrationVideoUrl;
  const isMusic = session.audioTrackMode === "music";
  const resultSuffix = isMusic ? "含音乐" : "含旁白";
  const resultTitle = isMusic ? "下载带音乐视频" : "下载带旁白视频";
  const label = status === "ready" ? "音轨已完成" : status === "running" ? "添加音轨中" : status === "error" ? "音轨失败" : "待添加音轨";
  const color = status === "ready" ? "#34d399" : status === "running" ? "#60a5fa" : status === "error" ? "#f87171" : "#6b7280";
  const subtitleLabel = isMusic
    ? (session.musicTaskId ? `音乐任务 · ${session.musicTaskId}` : "音乐模式")
    : session.narrationSubtitleMode === "burn"
    ? `烧录字幕 · ${session.narrationSubtitlePosition === "top" ? "顶部" : session.narrationSubtitlePosition === "middle" ? "中部" : "底部"}`
    : "不加字幕";
  const separationLabel = separationStatus === "ready"
    ? "已分离人声/背景"
    : separationStatus === "running"
    ? "分离人声/背景中"
    : separationStatus === "error"
    ? "分离失败"
    : "";
  const cacheKey = session.narrationUpdatedAt || session.narrationSignature || session.narrationVideoUrl || session.id;
  return (
    <div className={`flow-node audio-track-node ${selected ? "selected" : ""}`} style={{ width: NODE_WIDTH }}>
      <Handle type="target" position={Position.Left} id="in" />
      <div className="flow-node-head">
        <span className="flow-tag tag-audio">音轨</span>
        <strong className="flow-node-title">添加音轨</strong>
        {videoUrl && (
          <DownloadButton
            href={api.downloadNarrationVideoUrl(session.id)}
            filename={`${session.title || session.id}-${resultSuffix}.mp4`}
            title={resultTitle}
            onTriggered={() => emitDownloadToast(`${session.title || session.id}-${resultSuffix}.mp4`)}
          />
        )}
      </div>
      <div className="flow-node-thumb fit-contain">
        {isRunning ? (
          <div className="flow-empty flow-empty-generating">
            <span className="flow-empty-spinner" aria-hidden /> 添加音轨中…
          </div>
        ) : videoUrl ? (
          <RobustVideoThumb
            streamSrc={`${videoUrl}${videoUrl.includes("?") ? "&" : "?"}v=${encodeURIComponent(cacheKey)}`}
            downloadUrl={api.downloadNarrationVideoUrl(session.id)}
            downloadFilename={`${session.title || session.id}-${resultSuffix}.mp4`}
            title={`${session.title || session.id} · 添加音轨`}
          />
        ) : (
          <div className="flow-empty">{job.finalVideoUrl ? "点节点配置旁白或音乐" : "先完成完整视频"}</div>
        )}
      </div>
      <div className="flow-node-foot">
        <span className="flow-status" style={{ color }}>● {label}</span>
        <small>{subtitleLabel}</small>
        {session.narrationProgress && <small>{session.narrationProgress}</small>}
        {separationLabel && <small>{separationLabel}</small>}
        {session.audioSeparationProgress && <small>{session.audioSeparationProgress}</small>}
      </div>
    </div>
  );
}

// ============================================================================
// VoiceNode — reusable TTS / voice identity for consistent dialogue or narration
// ============================================================================

function VoiceNodeImpl({ data, selected }: NodeProps<VoiceFlowNode>) {
  const { lang } = useI18n();
  const { asset } = data;
  const audioUrl = asset.voicePreviewAudioUrl || asset.mediaUrl;
  const status = asset.voicePreviewStatus || (audioUrl ? "ready" : "idle");
  const color = status === "ready" ? "#34d399" : status === "generating" ? "#60a5fa" : status === "error" ? "#f87171" : "#6b7280";
  const label = status === "ready" ? "声音已试听" : status === "generating" ? "生成试听中" : status === "error" ? "试听失败" : "待生成试听";
  const preset = voicePresetForId(asset.voicePresetId || asset.voiceId);
  const presetLabel = preset
    ? (lang === "en" ? preset.labelEn : preset.labelZh)
    : asset.voiceId
      ? "自定义音色"
      : "选择音色";
  const presetDescription = preset
    ? (lang === "en" ? preset.descriptionEn : preset.descriptionZh)
    : asset.voicePrompt || asset.description || "在 Inspector 选择音色并生成试听";
  return (
    <div className={`flow-node voice-node ${selected ? "selected" : ""}`} style={{ width: NODE_WIDTH }}>
      <Handle type="target" position={Position.Left} id="in" />
      <div className="flow-node-head">
        <span className="flow-tag tag-audio">声音</span>
        <strong className="flow-node-title">{asset.name || "声音节点"}</strong>
      </div>
      <div className="flow-node-thumb voice-node-body">
        <div className="voice-node-preset">
          <span className="voice-node-wave" aria-hidden="true">
            <span />
            <span />
            <span />
            <span />
            <span />
          </span>
          <strong>{presetLabel}</strong>
          <small>{presetDescription}</small>
          {audioUrl ? (
            <audio
              controls
              src={`${audioUrl}${audioUrl.includes("?") ? "&" : "?"}v=${encodeURIComponent(asset.voiceGeneratedAt || asset.updatedAt || asset.id)}`}
            />
          ) : (
            <em>在 Inspector 生成试听</em>
          )}
        </div>
      </div>
      <div className="flow-node-foot">
        <span className="flow-status" style={{ color }}>● {label}</span>
        <small>{preset?.voiceId || asset.voiceId || "默认声音"}</small>
      </div>
      <Handle type="source" position={Position.Right} id="out" />
    </div>
  );
}

// ============================================================================
// MusicNode — reusable generated BGM/song audio
// ============================================================================

function MusicNodeImpl({ data, selected }: NodeProps<MusicFlowNode>) {
  const { lang } = useI18n();
  const { asset } = data;
  const audioUrl = asset.musicLocalAudioUrl || asset.mediaUrl || asset.musicAudioUrl;
  const status = asset.musicStatus || (audioUrl ? "ready" : "idle");
  const color = status === "ready" ? "#34d399" : status === "generating" ? "#60a5fa" : status === "error" ? "#f87171" : "#6b7280";
  const label = status === "ready"
    ? (lang === "en" ? "Music ready" : "音乐已生成")
    : status === "generating"
      ? (lang === "en" ? "Generating music" : "音乐生成中")
      : status === "error"
        ? (lang === "en" ? "Music failed" : "音乐失败")
        : (lang === "en" ? "Ready to generate" : "待生成音乐");
  const modeLabel = asset.musicKind === "song" ? (lang === "en" ? "Song" : "歌曲") : (lang === "en" ? "BGM" : "BGM");
  const prompt = asset.musicPrompt || asset.description || asset.prompt || (lang === "en" ? "Write a music prompt in Inspector" : "在 Inspector 写音乐提示词");
  return (
    <div className={`flow-node music-node ${selected ? "selected" : ""}`} style={{ width: NODE_WIDTH }}>
      <Handle type="target" position={Position.Left} id="in" />
      <div className="flow-node-head">
        <span className="flow-tag tag-audio">音乐</span>
        <strong className="flow-node-title">{asset.name || (lang === "en" ? "Music node" : "音乐节点")}</strong>
        {audioUrl && (
          <DownloadButton
            href={api.downloadAssetUrl(asset.id)}
            filename={`${asset.name || asset.id}.mp3`}
            onTriggered={() => emitDownloadToast(`${asset.name || asset.id}.mp3`)}
          />
        )}
      </div>
      <div className="flow-node-thumb music-node-body">
        <div className="music-node-card">
          <span className="music-node-bars" aria-hidden="true">
            <span />
            <span />
            <span />
            <span />
            <span />
            <span />
          </span>
          <strong>{modeLabel}</strong>
          <small>{prompt}</small>
          {audioUrl ? (
            <audio
              controls
              src={`${audioUrl}${audioUrl.includes("?") ? "&" : "?"}v=${encodeURIComponent(asset.musicGeneratedAt || asset.updatedAt || asset.id)}`}
            />
          ) : (
            <em>{lang === "en" ? "Generate music in Inspector" : "在 Inspector 生成音乐"}</em>
          )}
        </div>
      </div>
      <div className="flow-node-foot">
        <span className="flow-status" style={{ color }}>● {label}</span>
        <small>{asset.musicDurationSec ? `${asset.musicDurationSec}s` : modeLabel}</small>
        {asset.musicProgress && <small>{asset.musicProgress}</small>}
      </div>
      <Handle type="source" position={Position.Right} id="out" />
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
        <VideoDurationBadge seconds={asset.clipDurationSec ?? asset.originalDurationSec} />
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
// VideoAssetNode — standalone video asset, e.g. the final 2s tail video from a Shot.
// ============================================================================

function VideoAssetNodeImpl({ data, selected }: NodeProps<VideoAssetFlowNode>) {
  const { t } = useI18n();
  const { asset } = data;
  const videoUrl = asset.mediaUrl || asset.imageUrl;
  const posterHref = videoUrl ? api.assetPosterUrl(asset.id, asset.updatedAt || asset.id) : undefined;
  return (
    <div className={`flow-node shot-node ${selected ? "selected" : ""}`} style={{ width: NODE_WIDTH }}>
      <Handle type="target" position={Position.Left} id="in" />
      <div className="flow-node-head">
        <span className="flow-tag tag-shot">{t.nodes.video}</span>
        <strong className="flow-node-title" title={asset.name}>{asset.name}</strong>
        <VideoDurationBadge seconds={asset.clipDurationSec ?? asset.originalDurationSec} />
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
          <div className="flow-empty">{t.nodes.notGenerated}</div>
        )}
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
        <VideoDurationBadge seconds={asset.clipDurationSec ?? asset.originalDurationSec} />
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
  const { asset, sourceShot, targetShots, frameRole } = data;
  const thumb = assetThumbUrl(asset);
  const label = frameRole === "first" ? t.nodes.firstFrame : t.nodes.tailframe;
  const targetLabel = targetShots.length
    ? t.nodes.usedBy(targetShots.map((shot) => shot.title || `Shot ${shot.index}`).join("、"))
    : t.nodes.dragToVideo;
  return (
    <div className={`flow-node asset-node ${selected ? "selected" : ""}`} style={{ width: NODE_WIDTH }}>
      <Handle type="target" position={Position.Left} id="in" />
      <div className="flow-node-head">
        <span className="flow-tag tag-scene">{label}</span>
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
export const AudioTrackNode = memo(AudioTrackNodeImpl, (prev, next) =>
  prev.selected === next.selected
  && prev.data.session === next.data.session
  && prev.data.job === next.data.job
  && prev.data.legacy === next.data.legacy
);
export const VoiceNode = memo(VoiceNodeImpl, (prev, next) =>
  prev.selected === next.selected && prev.data.asset === next.data.asset
);
export const MusicNode = memo(MusicNodeImpl, (prev, next) =>
  prev.selected === next.selected && prev.data.asset === next.data.asset
);
export const ReferenceVideoNode = memo(ReferenceVideoNodeImpl, (prev, next) =>
  prev.selected === next.selected && prev.data.asset === next.data.asset
);
export const VideoAssetNode = memo(VideoAssetNodeImpl, (prev, next) =>
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
