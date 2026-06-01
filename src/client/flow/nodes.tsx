import { memo, useEffect, useRef, useState } from "react";
import { Download } from "lucide-react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { api } from "../api";
import { Lightbox } from "./Lightbox";
import { usePendingGeneration } from "./PendingGenerations";
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
      title={title || "选择模型版本"}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  );
}

const ASSET_MODEL_OPTIONS: Array<{ value: AssetImageModel; label: string }> = [
  { value: "seedream-4-5", label: "Seedream 4.5" },
  { value: "seedream-4", label: "Seedream 4" },
  { value: "gpt-image-2", label: "GPT-Image-2" }
];
const STORYBOARD_MODEL_OPTIONS: Array<{ value: SubStoryboardModel; label: string }> = [
  { value: "seedream-4-5", label: "Seedream 4.5" },
  { value: "seedream-4", label: "Seedream 4" }
];
const SEEDANCE_OPTIONS: Array<{ value: SeedanceVariant; label: string }> = [
  { value: "standard", label: "Seedance 2.0" },
  { value: "fast", label: "Seedance 2.0 Fast" }
];

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
  return (
    <a
      className="flow-node-download"
      href={href}
      download={filename}
      title={title || "下载"}
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
 * In-node video thumbnail. The thumb is ALWAYS clickable — clicking opens a full-page Lightbox
 * playing through the server-proxy stream URL (range-aware, correct content-type, no TOS
 * download-vs-play surprise).
 *
 * Performance UX: clicking the lightbox should feel instant. We achieve that with two tricks:
 *
 *   1. **In-viewport prefetch.** Once the thumbnail enters the viewport for ~800 ms (a debounce
 *      that protects bandwidth during rapid pan/zoom), we upgrade the inline `<video>` from
 *      `preload="metadata"` to `preload="auto"`. The browser starts buffering the actual bytes
 *      while the user is still reading the canvas — by the time they click, most of the file is
 *      in HTTP cache.
 *   2. **Resume from currentTime.** When the inline video has been buffering / playing on hover,
 *      we capture its `currentTime` before opening the lightbox and pass it along so the lightbox
 *      seeks straight to that point — no double-fetch from byte 0, no black-frame flicker.
 *
 * On video load error — TOS expired URL, network blip, codec issue — we collapse to the
 * poster image (still clickable, still opens the lightbox which has its own deeper fallback).
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
  const [errored, setErrored] = useState(false);
  const [open, setOpen] = useState(false);
  // Promote preload from metadata → auto once we're confident the user will likely click. Driven
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

  const stopAndOpen = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    // Snapshot inline playhead before unmounting so the lightbox can seek to it. Also pause the
    // inline element so the two players don't fight over decoder.
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
        className="flow-thumb-clickable"
        role="button"
        tabIndex={0}
        title="点击放大查看 / 播放（已在后台预加载）"
        onClick={stopAndOpen}
        onMouseDown={(e) => e.stopPropagation()}
        onMouseEnter={() => setEager(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") stopAndOpen(e as unknown as React.MouseEvent);
        }}
      >
        {errored ? (
          posterSrc ? (
            <img src={posterSrc} alt={title || "video poster"} loading="lazy" decoding="async" />
          ) : (
            <div className="flow-empty">▶ 点击播放</div>
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
        <span className="flow-thumb-play" aria-hidden>▶</span>
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

function statusBadge(status: string | undefined, phase?: string) {
  if (!status || status === "draft") return { color: "#6b7280", label: "草稿" };
  if (status === "scripted") return { color: "#fbbf24", label: "已写脚本" };
  if (status === "generating") {
    // Sub-phase tells the user whether the Seedance task is still queued at BytePlus (idle, can
    // sit for many minutes during peak hours) vs. actively rendering on a GPU. Surfaced because
    // queued time is not the user's fault and not something a re-submit fixes.
    if (phase === "queued") return { color: "#fbbf24", label: "Seedance 排队中" };
    if (phase === "running") return { color: "#60a5fa", label: "Seedance 渲染中" };
    return { color: "#60a5fa", label: "生成中" };
  }
  if (status === "ready") return { color: "#34d399", label: "已完成" };
  if (status === "error") return { color: "#f87171", label: "出错" };
  if (status === "cancelled") return { color: "#9ca3af", label: "已取消" };
  return { color: "#6b7280", label: status };
}

function selectedShotRender(shot: ShotNodeData["shot"]) {
  return (shot.renders || []).find((render) => render.videoUrl === shot.videoUrl || render.remoteVideoUrl === shot.videoUrl);
}

function reviewBadge(status?: string, score?: number, stale?: boolean) {
  if (stale) return { color: "#fbbf24", label: "VLM 已过期" };
  if (status === "running") return { color: "#60a5fa", label: "VLM 审核中" };
  if (status === "error") return { color: "#f87171", label: "VLM 失败" };
  if (typeof score === "number") {
    return score >= 80
      ? { color: "#34d399", label: `VLM ${Math.round(score)} ✓` }
      : { color: "#f87171", label: `VLM ${Math.round(score)} 需修` };
  }
  return { color: "#9ca3af", label: "VLM 未审" };
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
  const typeLabel: Record<string, string> = {
    character: "角色",
    scene: "场景",
    prop: "道具",
    style: "风格",
    other: "其它"
  };
  const tag = typeLabel[asset.type] ?? asset.type;
  const reviewInfo = reviewBadge(asset.imageReviewStatus, asset.imageReview?.score);
  const showReviewBadge = asset.imageReviewStatus === "running" || asset.imageReviewStatus === "error" || Boolean(asset.imageReview);
  return (
    <div className={`flow-node asset-node ${selected ? "selected" : ""} ${isGenerating ? "generating" : ""}`} style={{ width: NODE_WIDTH }}>
      <div className="flow-node-head">
        <span className={`flow-tag tag-${asset.type}`}>{tag}</span>
        <strong className="flow-node-title" title={asset.name}>{asset.name}</strong>
        {isGenerating && (
          <span className="flow-node-pending-badge" title="自审重试 + Seedream 单轮 ≈ 30-40s，最多 5 轮">
            生成中{pendingElapsed ? ` · ${pendingElapsed}` : "…"}
          </span>
        )}
        {thumb && (
          <ReviewButton
            label="VLM"
            title="对当前图片做 VLM 评分"
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
            title={`下载 ${asset.name} 原图`}
            onTriggered={() => emitDownloadToast(`${asset.name}.png`)}
          />
        )}
      </div>
      <div className="flow-node-thumb fit-contain">
        {thumb ? <img src={thumb} alt={asset.name} loading="lazy" decoding="async" /> : <div className="flow-empty">未生成</div>}
        {isGenerating && (
          <div className="flow-node-pending-overlay">
            <span className="flow-empty-spinner" aria-hidden />
            生成中{pendingElapsed ? ` · ${pendingElapsed}` : "…"}
            <small style={{ opacity: 0.65, marginTop: 4 }}>Seedream + 自审重试，最长 ~3 分钟</small>
          </div>
        )}
      </div>
      <div className="flow-node-foot">
        <NodeModelPicker<AssetImageModel>
          value={asset.generationModel}
          options={ASSET_MODEL_OPTIONS}
          onChange={async (model) => {
            await api.saveAsset({ id: asset.id, generationModel: model });
            emitFlowMutated();
          }}
          title="该资产下次「重新出图」使用的模型"
        />
        {showReviewBadge && (
          <small className="flow-review-badge" style={{ color: reviewInfo.color }}>{reviewInfo.label}</small>
        )}
        {asset.reviewAttempts && asset.reviewAttempts > 0 ? (
          <small className="flow-node-warn">自审重试 {asset.reviewAttempts}</small>
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
  return (
    <div className={`flow-node storyboard-node ${selected ? "selected" : ""} ${isGenerating ? "generating" : ""}`} style={{ width: NODE_WIDTH }}>
      <Handle type="target" position={Position.Left} id="in" />
      <div className="flow-node-head">
        <span className="flow-tag tag-storyboard">分镜板</span>
        <strong className="flow-node-title" title={shot.title}>{shot.title || `Shot ${shot.index}`}</strong>
        {isGenerating && (
          <span className="flow-node-pending-badge" title="Seedream 生成分镜板 + 自审，可能 30s-2min">
            生成中{pendingElapsed ? ` · ${pendingElapsed}` : "…"}
          </span>
        )}
        {thumb && asset && (
          <DownloadButton
            href={api.downloadAssetUrl(asset.id)}
            filename={`storyboard-${shot.title || `shot-${shot.index}`}.png`}
            title="下载分镜板原图"
            onTriggered={() => emitDownloadToast(`storyboard-${shot.title || `shot-${shot.index}`}.png`)}
          />
        )}
      </div>
      <div className="flow-node-thumb fit-contain">
        {thumb ? (
          <img src={thumb} alt={`storyboard ${shot.index}`} loading="lazy" decoding="async" />
        ) : (
          <div className="flow-empty">未生成 · 点开右侧编辑</div>
        )}
        {isGenerating && (
          <div className="flow-node-pending-overlay">
            <span className="flow-empty-spinner" aria-hidden />
            生成中{pendingElapsed ? ` · ${pendingElapsed}` : "…"}
            <small style={{ opacity: 0.65, marginTop: 4 }}>Seedream 分镜板，最长 ~2 分钟</small>
          </div>
        )}
      </div>
      <div className="flow-node-foot">
        <NodeModelPicker<SubStoryboardModel>
          value={shot.subStoryboardModel}
          options={STORYBOARD_MODEL_OPTIONS}
          onChange={async (model) => {
            await api.updateShot(shot.id, { subStoryboardModel: model });
            emitFlowMutated();
          }}
          title="该分镜板下次「重新出图」使用的 Seedream 版本"
        />
        <small>{panelCount} 面板</small>
        {asset?.referenceImageUrls?.length ? (
          <small className="flow-node-info">参考图 {asset.referenceImageUrls.length}</small>
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
  const { shot } = data;
  const status = statusBadge(shot.status, shot.seedancePhase);
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
  const reviewInfo = reviewBadge(reviewStatus, review?.score);
  const startedAt = pendingRender?.generationStartedAt || shot.generationStartedAt || undefined;
  const elapsed = useElapsedLabel(startedAt, isGenerating);
  return (
    <div className={`flow-node shot-node ${selected ? "selected" : ""}`} style={{ width: NODE_WIDTH }}>
      <Handle type="target" position={Position.Left} id="in" />
      <div className="flow-node-head">
        <span className="flow-tag tag-shot">视频</span>
        <strong className="flow-node-title" title={shot.title}>{shot.title || `Shot ${shot.index}`}</strong>
        {videoUrl && (
          <ReviewButton
            label="VLM"
            title="用多帧 VLM 标准审核这一镜"
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
            title="下载这一镜的 mp4"
            onTriggered={() => emitDownloadToast(`${shot.title || `shot-${shot.index}`}.mp4`)}
          />
        )}
        {videoUrl && (
          <ReviewButton
            label="尾帧"
            title="从当前视频抽取尾帧，在画布上生成可连接的尾帧节点"
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
            <span className="flow-empty-spinner" aria-hidden /> 生成中…
            {elapsed && <small className="flow-elapsed">已用时 {elapsed}</small>}
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
          <div className="flow-empty">未生成</div>
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
          title="该镜头下次「生成视频」使用的 Seedance 版本"
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
  const { session, job, legacy } = data;
  const status = job.status;
  // Same reasoning as ShotNode: while a stitch is running we hide the previous final so the
  // user doesn't think the old version is the new one.
  const isStitching = status === "running";
  const final = isStitching ? undefined : job.finalVideoUrl;
  const label = status === "ready" ? "已拼接" : status === "running" ? "拼接中" : status === "error" ? "出错" : "未拼接";
  const color = status === "ready" ? "#34d399" : status === "running" ? "#60a5fa" : status === "error" ? "#f87171" : "#6b7280";
  const reviewStale = Boolean(job.finalVideoReviewBuiltForSignature && job.finalVideoSignature && job.finalVideoReviewBuiltForSignature !== job.finalVideoSignature);
  const finalReviewInfo = reviewBadge(job.finalVideoReviewStatus, job.finalVideoReview?.score, reviewStale);
  const finalCacheKey = job.finalVideoGeneratedAt || job.finalVideoUrl || job.finalVideoSignature || job.updatedAt;
  const stitchCount = job.shotIds?.length || 0;
  const stitchHint = stitchCount > 0 ? `已连接 ${stitchCount} 段，点开按顺序拼接` : "连接视频到这里，或点开按分镜顺序拼接";
  const jobId = legacy ? undefined : job.id;
  const title = job.name || "完整视频";
  return (
    <div className={`flow-node stitch-node ${selected ? "selected" : ""}`} style={{ width: NODE_WIDTH }}>
      <Handle type="target" position={Position.Left} id="in" />
      <div className="flow-node-head">
        <span className="flow-tag tag-stitch">拼接</span>
        <strong className="flow-node-title">{title}</strong>
        {final && (
          <ReviewButton
            label="终审"
            title="用多帧 VLM 标准审核完整片"
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
            title="下载完整片"
            onTriggered={() => emitDownloadToast(`${session.title || session.id}-${title}.mp4`)}
          />
        )}
      </div>
      <div className="flow-node-thumb fit-contain">
        {isStitching ? (
          <div className="flow-empty flow-empty-generating">
            <span className="flow-empty-spinner" aria-hidden /> 拼接中…
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
        <small>{session.targetDurationSec}s 目标</small>
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
  const { asset } = data;
  const videoUrl = asset.mediaUrl || asset.imageUrl;
  // Reuse the lazy poster route — it works for any /media/*.mp4, regardless of which route created
  // the asset. We synthesize a stable cache key from the asset id so re-uploads invalidate.
  const posterHref = videoUrl ? api.assetPosterUrl(asset.id, asset.updatedAt || asset.id) : undefined;
  const status = asset.parseStatus || "idle";
  const { color, label } = (() => {
    if (status === "parsing") return { color: "#60a5fa", label: "解析中" };
    if (status === "ready") return { color: "#34d399", label: `已解析 ${asset.parsedShots?.length ?? 0} 镜` };
    if (status === "error") return { color: "#f87171", label: "解析失败" };
    return { color: "#9ca3af", label: "待解析" };
  })();
  return (
    <div className={`flow-node refvideo-node ${selected ? "selected" : ""}`} style={{ width: NODE_WIDTH }}>
      <div className="flow-node-head">
        <span className="flow-tag tag-refvideo">参考视频</span>
        <strong className="flow-node-title" title={asset.name}>{asset.name}</strong>
        {videoUrl && (
          <DownloadButton
            href={api.downloadAssetUrl(asset.id)}
            filename={`${asset.name}.mp4`}
            title="下载参考视频"
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
          <div className="flow-empty">未上传</div>
        )}
      </div>
      <div className="flow-node-foot">
        <span className="flow-status" style={{ color }}>● {label}</span>
        <small>从这里把镜头分析"应用到"右侧某条 shot</small>
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
  const { asset, sourceAsset } = data;
  const videoUrl = asset.mediaUrl || asset.imageUrl;
  const posterHref = videoUrl ? api.assetPosterUrl(asset.id, asset.updatedAt || asset.id) : undefined;
  const strategyLabel = asset.clipStrategy === "trim" ? "截前 15s"
    : asset.clipStrategy === "speedup" ? "整体加速"
    : asset.clipStrategy === "sample-concat" ? "多段拼接"
    : "未裁剪";
  const durationLabel = asset.originalDurationSec !== undefined && asset.clipDurationSec !== undefined
    ? `${asset.originalDurationSec.toFixed(1)}s → ${asset.clipDurationSec.toFixed(1)}s`
    : asset.clipDurationSec !== undefined
      ? `${asset.clipDurationSec.toFixed(1)}s`
      : "";
  return (
    <div className={`flow-node videoproc-node ${selected ? "selected" : ""}`} style={{ width: NODE_WIDTH }}>
      <Handle type="target" position={Position.Left} id="in" />
      <div className="flow-node-head">
        <span className="flow-tag tag-videoproc">视频处理</span>
        <strong className="flow-node-title" title={asset.name}>{asset.name}</strong>
        {videoUrl && (
          <DownloadButton
            href={api.downloadAssetUrl(asset.id)}
            filename={`${asset.name}.mp4`}
            title="下载裁剪结果"
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
          <div className="flow-empty">未生成</div>
        )}
      </div>
      <div className="flow-node-foot">
        <span className="flow-status" style={{ color: "#60a5fa" }}>● {strategyLabel}</span>
        {durationLabel && <small>{durationLabel}</small>}
        {sourceAsset && <small style={{ opacity: 0.7 }}>源：{sourceAsset.name}</small>}
      </div>
      <Handle type="source" position={Position.Right} id="out" />
    </div>
  );
}

// ============================================================================
// TailframeNode — extracted last frame from a shot video, draggable as first_frame anchor
// ============================================================================

function TailframeNodeImpl({ data, selected }: NodeProps<TailframeFlowNode>) {
  const { asset, sourceShot, targetShots } = data;
  const thumb = assetThumbUrl(asset);
  const targetLabel = targetShots.length
    ? `用于 ${targetShots.map((shot) => shot.title || `Shot ${shot.index}`).join("、")}`
    : "拖到视频节点作为首帧";
  return (
    <div className={`flow-node asset-node ${selected ? "selected" : ""}`} style={{ width: NODE_WIDTH }}>
      <Handle type="target" position={Position.Left} id="in" />
      <div className="flow-node-head">
        <span className="flow-tag tag-scene">尾帧</span>
        <strong className="flow-node-title" title={asset.name}>{asset.name}</strong>
        {thumb && (
          <DownloadButton
            href={api.downloadAssetUrl(asset.id)}
            filename={`${asset.name}.png`}
            title="下载尾帧"
            onTriggered={() => emitDownloadToast(`${asset.name}.png`)}
          />
        )}
      </div>
      <div className="flow-node-thumb fit-contain">
        {thumb ? <img src={thumb} alt={asset.name} loading="lazy" decoding="async" /> : <div className="flow-empty">未抽取</div>}
      </div>
      <div className="flow-node-foot">
        <span className="flow-status" style={{ color: "#38bdf8" }}>● 帧锚点</span>
        {sourceShot && <small>来自 {sourceShot.title || `Shot ${sourceShot.index}`}</small>}
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
