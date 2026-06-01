import { useEffect, useRef, useState } from "react";
import type { Asset, Shot, SessionWithShots, StitchJob, PromptComposition, ImageReviewVerdict, VideoReviewVerdict } from "../../shared/types";
import { api } from "../api";
import type { FlowNodeData } from "./buildGraph";
import { emitDownloadToast } from "./nodes";
import { Lightbox } from "./Lightbox";
import { MentionTextarea, type MentionOption } from "./MentionTextarea";
import { usePendingGenerationActions } from "./PendingGenerations";

/**
 * Click-to-zoom preview for use inside Inspector. The thumbnail is rendered as a button so
 * keyboard users can also trigger it; clicking opens a full-screen Lightbox at native resolution.
 * Replaces the older pattern where the node thumbnail itself was the zoom target — node clicks
 * are now reserved for opening this Inspector.
 */
function ZoomablePreview({
  url,
  mediaKind,
  title,
  downloadUrl,
  downloadFilename,
  generatedAt,
  generatedLabel = "生成时间",
  fallbackAt,
  fallbackLabel = "创建时间"
}: {
  url: string;
  mediaKind: "image" | "video";
  title: string;
  downloadUrl?: string;
  downloadFilename?: string;
  generatedAt?: string;
  generatedLabel?: string;
  fallbackAt?: string;
  fallbackLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const generatedTime = formatMediaTime(generatedAt);
  const fallbackTime = generatedTime ? undefined : formatMediaTime(fallbackAt);
  const timeLabel = generatedTime ? generatedLabel : fallbackTime ? fallbackLabel : "";
  const timeText = generatedTime || fallbackTime;
  return (
    <>
      <button
        type="button"
        className="inspector-preview-button"
        onClick={() => setOpen(true)}
        title="点击查看完整尺寸"
      >
        {mediaKind === "image" ? (
          <img className="inspector-preview" src={url} alt={title} />
        ) : (
          <video key={url} className="inspector-preview" src={url} muted preload="metadata" />
        )}
      </button>
      {timeText && <div className="inspector-hint">{timeLabel}：{timeText}</div>}
      {open && (
        <Lightbox
          url={url}
          mediaKind={mediaKind}
          title={title}
          downloadUrl={downloadUrl}
          downloadFilename={downloadFilename}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function assetPreviewUrl(asset: { mediaUrl?: string; imageUrl?: string; referenceImageUrl?: string }) {
  return asset.mediaUrl || asset.imageUrl || asset.referenceImageUrl;
}

function formatMediaTime(value?: string) {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toLocaleString();
}

function VideoReviewCard({ verdict, status, error, stale }: {
  verdict?: VideoReviewVerdict;
  status?: string;
  error?: string;
  stale?: boolean;
}) {
  if (status === "running") return <div className="inspector-review-card">VLM 审片中…正在按多帧标准检查人物、场景、节奏和伪影。</div>;
  if (status === "error") return <div className="inspector-error">VLM 审核失败：{error || "未知错误"}</div>;
  if (!verdict) return <div className="inspector-hint">尚未进行 VLM 审片。</div>;
  const pass = verdict.ok;
  return (
    <div className="inspector-review-card">
      <div className="inspector-review-head">
        <strong className={pass ? "review-score-pass" : "review-score-fail"}>
          {pass ? "通过" : "需修"} · {Math.round(verdict.score)}
        </strong>
        <span>{verdict.model} · {new Date(verdict.reviewedAt).toLocaleString()} · {verdict.frameCount} 帧</span>
      </div>
      {stale && <div className="inspector-review-fatal">终审已过期：完整片已重新拼接，请重新 VLM 终审。</div>}
      {verdict.summary && <p>{verdict.summary}</p>}
      {verdict.fatalIssues.length > 0 && (
        <div className="inspector-review-fatal">
          <strong>致命问题</strong>
          <ul>{verdict.fatalIssues.map((item, i) => <li key={i}>{item}</li>)}</ul>
        </div>
      )}
      {verdict.reasons.length > 0 && (
        <details className="inspector-fold" open>
          <summary>主要原因</summary>
          <ul>{verdict.reasons.map((item, i) => <li key={i}>{item}</li>)}</ul>
        </details>
      )}
      {verdict.fixes.length > 0 && (
        <details className="inspector-fold" open>
          <summary>建议修复</summary>
          <ul>{verdict.fixes.map((fix, i) => <li key={i}>{fix.shot ? `镜头 ${fix.shot}：` : ""}{fix.frame ? `帧 ${fix.frame}：` : ""}{fix.action}</li>)}</ul>
        </details>
      )}
      {verdict.criteria.length > 0 && (
        <details className="inspector-fold">
          <summary>评分维度</summary>
          <div className="inspector-review-criteria">
            {verdict.criteria.map((item) => (
              <div key={item.key}>
                <strong>{item.label}</strong>
                <span>{item.score}/4</span>
                <small>{item.reason}</small>
              </div>
            ))}
          </div>
        </details>
      )}
      {verdict.rawText && (
        <details className="inspector-fold">
          <summary>原始 VLM JSON</summary>
          <pre className="inspector-pre">{verdict.rawText}</pre>
        </details>
      )}
    </div>
  );
}

function ImageReviewCard({ verdict, status, error }: {
  verdict?: ImageReviewVerdict;
  status?: string;
  error?: string;
}) {
  if (status === "running") return <div className="inspector-review-card">VLM 审图中…正在检查画面质量、主体结构、prompt 对齐和参考图一致性。</div>;
  if (status === "error") return <div className="inspector-error">VLM 审图失败：{error || "未知错误"}</div>;
  if (!verdict) return <div className="inspector-hint">尚未进行 VLM 审图。点击「VLM 评分」可只审核当前图片，不会重新出图。</div>;
  const pass = verdict.ok;
  return (
    <div className="inspector-review-card">
      <div className="inspector-review-head">
        <strong className={pass ? "review-score-pass" : "review-score-fail"}>
          {pass ? "通过" : "需修"} · {Math.round(verdict.score)}
        </strong>
        <span>{verdict.model} · {new Date(verdict.reviewedAt).toLocaleString()}</span>
      </div>
      {verdict.summary && <p>{verdict.summary}</p>}
      {verdict.fatalIssues.length > 0 && (
        <div className="inspector-review-fatal">
          <strong>致命问题</strong>
          <ul>{verdict.fatalIssues.map((item, i) => <li key={i}>{item}</li>)}</ul>
        </div>
      )}
      {verdict.reasons.length > 0 && (
        <details className="inspector-fold" open>
          <summary>主要原因</summary>
          <ul>{verdict.reasons.map((item, i) => <li key={i}>{item}</li>)}</ul>
        </details>
      )}
      {verdict.fixes.length > 0 && (
        <details className="inspector-fold" open>
          <summary>建议修复</summary>
          <ul>{verdict.fixes.map((fix, i) => <li key={i}>{fix.action}</li>)}</ul>
        </details>
      )}
      {verdict.criteria.length > 0 && (
        <details className="inspector-fold">
          <summary>评分维度</summary>
          <div className="inspector-review-criteria">
            {verdict.criteria.map((item) => (
              <div key={item.key}>
                <strong>{item.label}</strong>
                <span>{item.score}/4</span>
                <small>{item.reason}</small>
              </div>
            ))}
          </div>
        </details>
      )}
      {verdict.rawText && (
        <details className="inspector-fold">
          <summary>原始 VLM JSON</summary>
          <pre className="inspector-pre">{verdict.rawText}</pre>
        </details>
      )}
    </div>
  );
}

interface InspectorProps {
  selected: FlowNodeData | undefined;
  session: SessionWithShots | undefined;
  allAssets: Asset[];
  visionReviewEnabled: boolean;
  onMutated: () => Promise<void> | void;
  onDeleteCanvasAsset?: (asset: Asset) => Promise<boolean> | boolean;
  onDeleteCanvasShot?: (shot: Shot) => Promise<boolean> | boolean;
  onClose: () => void;
}

export function Inspector({ selected, session, allAssets, visionReviewEnabled, onMutated, onDeleteCanvasAsset, onDeleteCanvasShot, onClose }: InspectorProps) {
  if (!selected) return null;
  if (selected.kind === "asset") {
    return <AssetInspector asset={selected.asset} session={session} allAssets={allAssets} onMutated={onMutated} onDeleteCanvasAsset={onDeleteCanvasAsset} onClose={onClose} visionReviewEnabled={visionReviewEnabled} />;
  }
  if (selected.kind === "storyboard") {
    return <StoryboardInspector shot={selected.shot} asset={selected.asset} session={session} allAssets={allAssets} onMutated={onMutated} onClose={onClose} visionReviewEnabled={visionReviewEnabled} />;
  }
  if (selected.kind === "shot") {
    return <ShotInspector shot={selected.shot} session={session} allAssets={allAssets} onMutated={onMutated} onDeleteCanvasShot={onDeleteCanvasShot} onClose={onClose} visionReviewEnabled={visionReviewEnabled} />;
  }
  if (selected.kind === "stitch") {
    return <StitchInspector session={selected.session} job={selected.job} legacy={selected.legacy} onMutated={onMutated} onClose={onClose} />;
  }
  if (selected.kind === "referenceVideo") {
    return <ReferenceVideoInspector asset={selected.asset} session={session} onMutated={onMutated} onDeleteCanvasAsset={onDeleteCanvasAsset} onClose={onClose} />;
  }
  if (selected.kind === "videoProcessor") {
    return <VideoProcessorInspector asset={selected.asset} sourceAsset={selected.sourceAsset} session={session} onMutated={onMutated} onDeleteCanvasAsset={onDeleteCanvasAsset} onClose={onClose} />;
  }
  if (selected.kind === "tailframe") {
    return <AssetInspector asset={selected.asset} session={session} allAssets={allAssets} onMutated={onMutated} onDeleteCanvasAsset={onDeleteCanvasAsset} onClose={onClose} visionReviewEnabled={visionReviewEnabled} />;
  }
  return null;
}

// ============================================================================
// Asset inspector
// ============================================================================

function AssetInspector({ asset, onMutated, onDeleteCanvasAsset, onClose, visionReviewEnabled }: {
  asset: Asset;
  session?: SessionWithShots;
  allAssets: Asset[];
  visionReviewEnabled: boolean;
  onMutated: () => Promise<void> | void;
  onDeleteCanvasAsset?: (asset: Asset) => Promise<boolean> | boolean;
  onClose: () => void;
}) {
  const [name, setName] = useState(asset.name);
  const [prompt, setPrompt] = useState(asset.prompt || "");
  const [description, setDescription] = useState(asset.description || "");
  const [composedDraft, setComposedDraft] = useState(asset.composedPromptDraft || "");
  const [busy, setBusy] = useState<"" | "save" | "preview" | "generate" | "review" | "delete" | "repair">("");
  const [error, setError] = useState<string>("");
  // "saved / saving / dirty" status badge for the topbar of the Inspector. Drives the auto-save
  // badge so the user can see "✓ 已保存" turn into "保存中…" turn back into "✓ 已保存" without
  // having to click a button. Only renders to give signal — does not block any action.
  const [saveStatus, setSaveStatus] = useState<"saved" | "saving" | "dirty">("saved");
  const pending = usePendingGenerationActions();

  // Re-sync local state when a different asset is selected. Reset the dirty flag too — switching
  // assets should NOT count as the user editing the new asset.
  useEffect(() => {
    setName(asset.name);
    setPrompt(asset.prompt || "");
    setDescription(asset.description || "");
    setComposedDraft(asset.composedPromptDraft || "");
    setError("");
    setSaveStatus("saved");
    pendingFlushRef.current = null;
  }, [asset.id]);

  /**
   * Auto-save: every textarea / input change is debounced (~600 ms) and PATCH-saved automatically.
   * The user no longer has to click "保存" before "AI 扩写" or "出图". The dirty flag toggles to
   * "保存中…" → "✓ 已保存" so they can see it happen.
   *
   * `pendingFlushRef` lets action handlers (扩写 / 出图) **flush** any in-flight pending edit
   * synchronously before they call the server — that's what fixes "扩写 prompt 跟我写的没关系":
   * server reads asset.prompt from the DB, and without flush-first the DB still has yesterday's
   * text.
   */
  const pendingFlushRef = useRef<{ flush: () => Promise<void> } | null>(null);
  const lastSavedRef = useRef<{ name: string; prompt: string; description: string; composedDraft: string }>({
    name: asset.name,
    prompt: asset.prompt || "",
    description: asset.description || "",
    composedDraft: asset.composedPromptDraft || ""
  });

  useEffect(() => {
    // Compare with last-saved snapshot. If nothing changed, do nothing (avoids gratuitous PATCHes
    // when the asset re-renders for an unrelated reason).
    const current = { name, prompt, description, composedDraft };
    const last = lastSavedRef.current;
    if (
      current.name === last.name &&
      current.prompt === last.prompt &&
      current.description === last.description &&
      current.composedDraft === last.composedDraft
    ) return;

    setSaveStatus("dirty");
    let cancelled = false;
    let resolveFlush: () => void = () => {};
    const flushed = new Promise<void>((r) => { resolveFlush = r; });
    const doSave = async () => {
      if (cancelled) return;
      setSaveStatus("saving");
      try {
        await api.saveAsset({
          id: asset.id,
          name,
          prompt,
          description,
          // Keep empty-string clears. `undefined` is omitted by JSON.stringify, which left stale
          // drafts on the server and made "出图" keep using an old ② after the user cleared it.
          composedPromptDraft: composedDraft
        });
        if (cancelled) return;
        lastSavedRef.current = current;
        setSaveStatus("saved");
        await onMutated();
      } catch (err) {
        if (cancelled) return;
        setSaveStatus("dirty");
        setError(err instanceof Error ? err.message : "自动保存失败");
      } finally {
        resolveFlush();
      }
    };
    const timer = window.setTimeout(doSave, 600);
    pendingFlushRef.current = {
      flush: async () => {
        // Action button asks "is there an unsaved edit? if so save now and wait for it"
        if (cancelled) return;
        window.clearTimeout(timer);
        await doSave();
        await flushed;
      }
    };
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      // resolve pending flush so awaiters don't hang on stale promise
      resolveFlush();
    };
  }, [name, prompt, description, composedDraft, asset.id, onMutated]);

  /** Save anything still pending. Called before AI 扩写 / 出图 so the server reads fresh text. */
  const flushPendingSave = async () => {
    if (pendingFlushRef.current) {
      await pendingFlushRef.current.flush();
      pendingFlushRef.current = null;
    }
  };

  const handlePromptChange = (value: string) => {
    setPrompt(value);
    // ② is derived from ①. If ① changes after an AI expansion, the old derived prompt is now stale
    // and can contradict the user's current description (e.g. old "male" draft overriding new
    // "woman" prompt). Clear it so the next 出图 recomposes from the fresh ① unless the user writes
    // a new manual ②.
    if (composedDraft) setComposedDraft("");
  };

  const previewSeedreamPrompt = async () => {
    setBusy("preview"); setError("");
    try {
      // CRITICAL: flush pending auto-save first. Without this, the next generate call may still
      // see an old composedPromptDraft. The expansion request itself sends the current local fields
      // too, so the preview is tied to exactly what the user sees in the Inspector.
      await flushPendingSave();
      const result = await api.expandAssetPrompt({
        id: asset.id,
        type: asset.type,
        name,
        prompt,
        description
      });
      setComposedDraft(result.prompt);
    } catch (err) {
      setError(err instanceof Error ? err.message : "预览失败");
    } finally { setBusy(""); }
  };

  const regenerate = async () => {
    setBusy("generate"); setError("");
    // Same fix here: flush before kicking off Seedream so the server has latest text.
    try {
      await flushPendingSave();
    } catch (err) {
      setBusy("");
      setError(err instanceof Error ? err.message : "保存失败");
      return;
    }
    // Free the local Inspector busy state immediately so the user can navigate to other nodes /
    // edit other inspectors / kick off a parallel generation. The Seedream call continues in the
    // background; the canvas-level "生成中" overlay (driven by usePendingGeneration) shows the
    // user that this node is still working even after they leave its Inspector.
    setBusy("");
    void pending.run(asset.id, async () => {
      try {
        await api.generateAsset(asset.id, asset.generationModel || "seedream-4-5", {
          visionReview: visionReviewEnabled && asset.vlmReviewEnabled !== false,
          composedPrompt: composedDraft || undefined
        });
        await onMutated();
      } catch (err) {
        // Surface error via a window event so a transient banner can pick it up; the original
        // Inspector may already be unmounted by the time the request resolves.
        const msg = err instanceof Error ? err.message : "生成失败";
        if (typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent<string>("flow-download", { detail: `❌ ${asset.name || "资产"} 生成失败：${msg}` }));
        }
      }
    });
  };

  const reviewAssetImage = async () => {
    setBusy("review"); setError("");
    try {
      await flushPendingSave();
      await api.reviewAssetImage(asset.id);
      await onMutated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "VLM 评分失败");
      await onMutated();
    } finally { setBusy(""); }
  };

  return (
    <aside className="inspector">
      <header>
        <span className="inspector-tag">资产 · {asset.type}</span>
        <button onClick={onClose} className="inspector-close">×</button>
      </header>
      <label>名称<input value={name} onChange={(e) => setName(e.target.value)} /></label>

      {/*
       * Two-stage prompt model (intentionally two fields, not four):
       *
       *   ①「我写的描述」  user's free-text intent. What you want the image to be.
       *   ②「AI 扩写后的 prompt」  the composed text actually sent to Seedream. The server takes
       *      ① as input, runs an LLM expansion, and prepends template wording (画幅/光线/胶片质感
       *      /禁止文字 …). You can edit ② before "出图" — the edited version is what gets submitted.
       *
       * The "上次提交记录" fold below shows the historical `composedPrompt` for audit. The legacy
       * `description` field is kept as optional metadata under a fold for back-compat with assets
       * that already have it filled in.
       */}
      <div className="inspector-stage">
        <div className="inspector-stage-head">
          <span className="inspector-stage-num">①</span>
          <strong>我写的描述</strong>
          <small>用自由文字描述你想要这个 {asset.type === "character" ? "角色" : asset.type === "scene" ? "场景" : "资产"} 长什么样</small>
        </div>
        <textarea
          rows={6}
          value={prompt}
          onChange={(e) => handlePromptChange(e.target.value)}
          placeholder={asset.type === "character"
            ? "例：35 岁中年男性，黄仁勋本人，黑色皮夹克，温和坚定的眼神…"
            : "例：硅谷晚间会议室，落地窗外灯火，桌上摆着 GPU 模型…"}
        />
      </div>

      <div className="inspector-stage">
        <div className="inspector-stage-head">
          <span className="inspector-stage-num">②</span>
          <strong>AI 扩写后的 prompt</strong>
          <small>
            ① 经 AI + 系统模板（画幅 / 光影 / 胶片质感 / 禁字幕 …）扩写后的最终版，<em>送给 Seedream 用的就是这个</em>。可以改。
          </small>
        </div>
        <textarea
          rows={10}
          value={composedDraft}
          onChange={(e) => setComposedDraft(e.target.value)}
          placeholder="点下方「AI 扩写」从 ① 生成；非空时下次出图就用这一份原样提交"
        />
        <div className="inspector-stage-hint">
          {composedDraft
            ? <>✅ 已有扩写稿，下次出图就用这份。要改请直接编辑；想重做点「AI 扩写」覆盖。</>
            : <>⚠ 还没扩写。可以直接在 ① 写完点「出图」走默认扩写，或先点「AI 扩写」预览后再改。</>}
        </div>
      </div>

      <label className="vision-review-toggle" title="勾选后，出图时启用 VLM 审核；审核失败可按反馈修资产 prompt。">
        <input
          type="checkbox"
          checked={asset.vlmReviewEnabled !== false}
          onChange={async (e) => {
            await api.saveAsset({ id: asset.id, vlmReviewEnabled: e.target.checked });
            await onMutated();
          }}
        />
        VLM 审核此图片节点
      </label>

      <div className="inspector-actions">
        <button onClick={previewSeedreamPrompt} disabled={Boolean(busy)} title="用 ① 跑一遍 AI 扩写，结果填到 ② 里给你看">
          {busy === "preview" ? "..." : "AI 扩写 →②"}
        </button>
        <button onClick={regenerate} disabled={Boolean(busy)} className="primary" title="② 非空就用②原样提交；② 为空就 ① 走默认扩写后提交。点击前会自动保存当前编辑。">
          {busy === "generate" ? "..." : "出图"}
        </button>
        <button onClick={reviewAssetImage} disabled={Boolean(busy) || !assetPreviewUrl(asset)} title="只对当前图片做 VLM 打分，不会重新出图">
          {busy === "review" ? "..." : "VLM 评分"}
        </button>
        <button
          onClick={async () => {
            if (!window.confirm(`删除资产「${asset.name || asset.id}」？删除后可在画布顶部「↶ 撤销」恢复。`)) return;
            setBusy("delete"); setError("");
            try {
              if (onDeleteCanvasAsset) {
                const deleted = await onDeleteCanvasAsset(asset);
                if (!deleted) return;
                await onMutated();
              } else {
                await api.deleteAsset(asset.id);
                await onMutated();
              }
              onClose();
            } catch (err) {
              setError(err instanceof Error ? err.message : "删除失败");
            } finally { setBusy(""); }
          }}
          disabled={Boolean(busy)}
          className="danger"
          title="删除这个资产节点（可撤销）"
        >
          {busy === "delete" ? "..." : "删除"}
        </button>
        <span className="inspector-save-status" data-status={saveStatus}>
          {saveStatus === "saved" && "✓ 已保存"}
          {saveStatus === "saving" && "保存中…"}
          {saveStatus === "dirty" && "● 未保存（即将自动保存）"}
        </span>
      </div>
      {assetPreviewUrl(asset) && (
        <a
          className="inspector-download"
          href={api.downloadAssetUrl(asset.id)}
          download={`${asset.name}.png`}
          onClick={() => emitDownloadToast(`${asset.name}.png`)}
        >
          ⬇ 下载原图
        </a>
      )}
      {assetPreviewUrl(asset) && (
        <details className="inspector-fold" open>
          <summary>当前图片预览（点开看大图）</summary>
          <ZoomablePreview
            url={assetPreviewUrl(asset) as string}
            mediaKind="image"
            title={asset.name}
            downloadUrl={api.downloadAssetUrl(asset.id)}
            downloadFilename={`${asset.name}.png`}
            generatedAt={asset.generatedAt}
            generatedLabel="图片生成时间"
            fallbackAt={asset.createdAt}
            fallbackLabel="创建时间"
          />
        </details>
      )}
      <details className="inspector-fold" open>
        <summary>VLM 图片评分</summary>
        <ImageReviewCard
          verdict={asset.imageReview}
          status={asset.imageReviewStatus}
          error={asset.imageReviewError}
        />
      </details>
      <details className="inspector-fold">
        <summary>更多元数据 / 备注</summary>
        <label>原始备注（可选；不送给 AI，仅供 asset 列表查看）
          <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
      </details>
      {asset.composedPrompt && (
        <details className="inspector-fold">
          <summary>上次实际送出的 prompt（审计）</summary>
          <pre className="inspector-pre">{asset.composedPrompt}</pre>
        </details>
      )}
      {asset.reviewNote && (
        <details className="inspector-fold">
          <summary>自审重试记录（重试 {asset.reviewAttempts ?? 0} 次）</summary>
          <pre className="inspector-pre">{asset.reviewNote}</pre>
        </details>
      )}
      {error && <div className="inspector-error">{error}</div>}
    </aside>
  );
}

// ============================================================================
// Storyboard inspector
// ============================================================================

/**
 * Best-effort client-side beat splitter — mirror of the server's `splitScenePromptIntoBeats` so
 * the user can preview which beat each panel will get when sequential mode is on. Falls back to
 * duplicating the whole prompt for missing slots, exactly like the server.
 */
function beatMarkerRegex() {
  return /(Beat\s*([A-Z])|[Bb]eat\s*(\d+)|beat\s*([A-Z])|节拍\s*(\d+)|Frame\s*(\d+)|帧\s*(\d+)|第\s*(\d+)\s*[帧拍])\s*[:：]?\s*/g;
}

function storyboardSlotFromMarker(match: RegExpExecArray) {
  if (match[2]) return match[2].charCodeAt(0) - "A".charCodeAt(0);
  if (match[4]) return match[4].charCodeAt(0) - "A".charCodeAt(0);
  if (match[3]) return Number(match[3]) - 1;
  if (match[5]) return Number(match[5]) - 1;
  if (match[6]) return Number(match[6]) - 1;
  if (match[7]) return Number(match[7]) - 1;
  if (match[8]) return Number(match[8]) - 1;
  return -1;
}

function inferStoryboardPanelCount(prompt: string, fallback?: number) {
  const markerRe = beatMarkerRegex();
  let maxSlot = -1;
  let markerCount = 0;
  let m: RegExpExecArray | null;
  while ((m = markerRe.exec(prompt)) !== null) {
    const slot = storyboardSlotFromMarker(m);
    if (slot >= 0 && slot < 16) {
      markerCount += 1;
      maxSlot = Math.max(maxSlot, slot);
    }
  }
  if (maxSlot >= 1) return Math.max(2, Math.min(16, maxSlot + 1));
  if (markerCount >= 2) return Math.max(2, Math.min(16, markerCount));
  return Math.max(2, Math.min(16, fallback ?? 9));
}

function inferStoryboardLayout(panelCount: number) {
  if (panelCount <= 4) return "2x2";
  if (panelCount <= 6) return "3x2";
  if (panelCount <= 8) return "4x2";
  if (panelCount === 9) return "3x3";
  if (panelCount <= 12) return "4x3";
  return "4x4";
}

function splitScenePromptForPanels(prompt: string, panelCount: number): string[] {
  const result = new Array<string>(panelCount).fill(prompt);
  if (!prompt || panelCount <= 0) return result;
  const markerRe = beatMarkerRegex();
  const hits: Array<{ slot: number; start: number; bodyStart: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = markerRe.exec(prompt)) !== null) {
    const slot = storyboardSlotFromMarker(m);
    if (slot >= 0 && slot < panelCount) {
      hits.push({ slot, start: m.index, bodyStart: m.index + m[0].length });
    }
  }
  if (hits.length === 0) return result;
  hits.sort((a, b) => a.start - b.start);
  const preface = prompt.slice(0, hits[0].start).trim();
  for (let i = 0; i < hits.length; i += 1) {
    const cur = hits[i];
    const next = hits[i + 1];
    const body = prompt.slice(cur.bodyStart, next ? next.start : prompt.length).trim();
    const composed = preface ? `${preface}\n\n${body}` : body;
    if (composed) result[cur.slot] = composed;
  }
  return result;
}

function buildStoryboardMentionOptions(shot: Shot, allAssets: Asset[], session: SessionWithShots | undefined): MentionOption[] {
  const handle = (asset: Asset) => asset.name.replace(/\s*\/\s*/g, "/").replace(/\s+/g, "");
  const tagFor = (asset: Asset) => {
    const typeZh: Record<string, string> = { character: "角色", scene: "场景", prop: "道具", style: "风格" };
    return typeZh[asset.type] || "资产";
  };
  const isVisible = (asset: Asset) => {
    if (asset.ownerShotId && asset.ownerShotId !== shot.id) return false;
    if (asset.ownerSessionId && session && asset.ownerSessionId !== session.id) return false;
    return true;
  };
  const isStoryboardReferenceCandidate = (asset: Asset) =>
    ["character", "scene", "prop", "style"].includes(asset.type) && isVisible(asset);

  const options: MentionOption[] = [];
  const seen = new Set<string>();
  const add = (asset: Asset, wired: boolean) => {
    if (seen.has(asset.id) || !isStoryboardReferenceCandidate(asset)) return;
    seen.add(asset.id);
    options.push({ id: asset.id, handle: handle(asset), label: asset.name, tag: tagFor(asset), wired });
  };

  (shot.assetIds || [])
    .map((id) => allAssets.find((asset) => asset.id === id))
    .filter((asset): asset is Asset => Boolean(asset))
    .forEach((asset) => add(asset, true));

  allAssets.forEach((asset) => add(asset, false));
  return options;
}

function StoryboardInspector({ shot, asset, session, allAssets, visionReviewEnabled, onMutated, onClose }: {
  shot: Shot;
  asset?: Asset;
  session?: SessionWithShots;
  allAssets: Asset[];
  visionReviewEnabled: boolean;
  onMutated: () => Promise<void> | void;
  onClose: () => void;
}) {
  // Anchor candidates: this session's character/scene/style/prop assets (auto-pre-checks wired ones).
  const anchorCandidates = allAssets.filter((a) =>
    ["character", "scene", "prop", "style"].includes(a.type) &&
    !a.ownerShotId &&
    (!a.ownerSessionId || a.ownerSessionId === session?.id)
  );
  const initialRefs = (asset?.referenceAssetIds && asset.referenceAssetIds.length
    ? asset.referenceAssetIds
    : (shot.assetIds || []).filter((id) => anchorCandidates.some((a) => a.id === id))
  );

  const [scenePrompt, setScenePrompt] = useState((asset?.prompt || shot.rawPrompt || shot.prompt || "").trim());
  const [refIds, setRefIds] = useState<string[]>(initialRefs);
  const [composedDraft, setComposedDraft] = useState<string>(shot.composedSeedreamPromptDraft || "");
  // Sequential mode toggle. Off (default) means one Seedream group call → fast but panel order
  // can scramble. On means N single-image calls + ffmpeg tile → slow (~10s × N) but the order is
  // guaranteed to follow each Beat marker in scenePrompt. Recommended whenever the timeline matters
  // (falling object, choreography, plot beats that must read 1→N).
  const [sequentialMode, setSequentialMode] = useState<boolean>(false);
  const [busy, setBusy] = useState<"" | "preview" | "generate">("");
  const pending = usePendingGenerationActions();
  const [error, setError] = useState<string>("");
  const panelCount = inferStoryboardPanelCount(scenePrompt, shot.subShotPanelCount ?? 9);
  const layout = inferStoryboardLayout(panelCount);

  useEffect(() => {
    setScenePrompt((asset?.prompt || shot.rawPrompt || shot.prompt || "").trim());
    setRefIds(asset?.referenceAssetIds && asset.referenceAssetIds.length
      ? asset.referenceAssetIds
      : (shot.assetIds || []).filter((id) => anchorCandidates.some((a) => a.id === id)));
    setComposedDraft(shot.composedSeedreamPromptDraft || "");
    setError("");
  }, [shot.id, asset?.id]);

  const previewSeedreamGrid = async () => {
    setBusy("preview"); setError("");
    try {
      const result = await api.subStoryboardDryRun(shot.id, {
        scenePrompt,
        panelCount,
        layout,
        referenceAssetIds: refIds
      });
      setComposedDraft(result.composedPrompt);
    } catch (err) {
      setError(err instanceof Error ? err.message : "预览失败");
    } finally { setBusy(""); }
  };

  const regenerate = async () => {
    setBusy("generate"); setError("");
    // Brief local busy to prevent double-click; release immediately after kicking off so the
    // user can navigate away / edit other nodes while this Seedream call runs in the background.
    setTimeout(() => setBusy(""), 0);
    // Use shot.id as the pending key so the canvas overlay marks the storyboard node (not the
    // owning shot — they're rendered as separate nodes in buildGraph). The buildGraph storyboard
    // node id is `storyboard-${shot.id}`; we key on the bare shot.id and the StoryboardNode
    // reads `usePendingGeneration(shot.id)` accordingly.
    void pending.run(shot.id, async () => {
      try {
        // In sequential mode, split scenePrompt into per-panel beats by recognized markers
        // (Beat A/B/C..., Frame 1/2/3..., 节拍 1/2/3...). Mirrors the server's splitter so the
        // user can preview what we send. If the splitter doesn't find enough markers, fall back
        // to the same body shape (server will run its own split).
        const panelsForApi = sequentialMode
          ? splitScenePromptForPanels(scenePrompt, panelCount).map((p) => ({ prompt: p }))
          : undefined;
        await api.subStoryboardGenerate(shot.id, {
          scenePrompt,
          panelCount,
          layout,
          referenceAssetIds: refIds,
          composedPrompt: composedDraft || undefined,
          model: shot.subStoryboardModel,
          ...(sequentialMode
            ? { mode: "sequential" as const, panels: panelsForApi, panelSize: "1440x2560" }
            : {})
        });
        await onMutated();
      } catch (err) {
        const msg = err instanceof Error ? err.message : "出图失败";
        if (typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent<string>("flow-download", { detail: `❌ Shot ${shot.index} 分镜板生成失败：${msg}` }));
        }
      }
    });
  };

  const toggleRef = (id: string) => {
    setRefIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  };

  const referenceAssets = refIds
    .map((id) => allAssets.find((a) => a.id === id))
    .filter((a): a is Asset => Boolean(a));

  return (
    <aside className="inspector">
      <header>
        <span className="inspector-tag">分镜板 · Shot {shot.index}</span>
        <button onClick={onClose} className="inspector-close">×</button>
      </header>
      <label>场景描述（支持 @ 角色/资产；会喂给 Seedream 的故事板组合 prompt）
        <MentionTextarea
          rows={8}
          value={scenePrompt}
          onChange={setScenePrompt}
          options={buildStoryboardMentionOptions(shot, allAssets, session)}
          placeholder="输入 @ 选择角色 / 场景 / 道具 / 风格资产；被 @ 的公开图片会作为 Seedream 4.5 参考图"
        />
      </label>
      <div className="inspector-hint">
        自动推算：{panelCount} 个面板 · {layout.replace("x", "×")} 布局。可在描述里用 `Beat 1:` / `Beat 2:` / `Frame 3:` 标出节拍，系统会按最大编号自动决定面板数。
      </div>

      <label className="inspector-row" style={{ alignItems: "flex-start", gap: 8 }}>
        <input
          type="checkbox"
          checked={sequentialMode}
          onChange={(e) => setSequentialMode(e.target.checked)}
          style={{ marginTop: 4 }}
        />
        <span>
          <strong>严格按时间顺序生成（sequential 模式）</strong>
          <small style={{ display: "block", color: "var(--muted, #888)", marginTop: 2 }}>
            勾上后每个 panel 都用一次 Seedream（耗时 ~10s × {panelCount} 张）+ ffmpeg 拼网格。每张以前一张为参考，**Beat 顺序硬保证**——TL→TR→BL→BR 严格对应你写的 Beat 1/2/3。
            建议在「场景描述」里用 `Beat 1: …` `Beat 2: …` 显式分段；不勾就走默认 group call 一次出图，更快但 Seedream 偶尔会乱序。
          </small>
        </span>
      </label>

      <div className="inspector-section">
        <strong>参考资产（跨分镜身份锚定）</strong>
        <div className="inspector-hint">勾选=固定带去 Seedream；也可以在上面的场景描述里输入 @ 选择资产，server 会自动把被 @ 的公开图片作为 Seedream 4.5 参考图。未发布的本地 /media 图不会直接传给远端模型。</div>
        <div className="inspector-ref-list">
          {anchorCandidates.length === 0 && <div className="inspector-empty">本 session 还没有可作为参考的资产，先去左列建一个角色 / 场景资产。</div>}
          {anchorCandidates.map((a) => {
            const checked = refIds.includes(a.id);
            const thumb = a.mediaUrl || a.imageUrl || a.referenceImageUrl;
            return (
              <label key={a.id} className={`inspector-ref-item ${checked ? "active" : ""}`}>
                <input type="checkbox" checked={checked} onChange={() => toggleRef(a.id)} />
                {thumb ? <img src={thumb} alt={a.name} /> : <div className="inspector-ref-empty">无图</div>}
                <div className="inspector-ref-meta">
                  <strong>{a.name}</strong>
                  <small>{a.type}</small>
                </div>
              </label>
            );
          })}
        </div>
        {referenceAssets.length > 0 && (
          <div className="inspector-hint">已选 {referenceAssets.length} 张：{referenceAssets.map((a) => a.name).join("、")}</div>
        )}
      </div>

      <details className="inspector-fold" open={Boolean(composedDraft)}>
        <summary>送给 Seedream 的最终 prompt（草稿，可改）</summary>
        <textarea rows={10} value={composedDraft} onChange={(e) => setComposedDraft(e.target.value)} placeholder="点「预览组装」拉取一份默认值，再改" />
        <div className="inspector-hint">空表示走默认组装；非空则下次「重新出图」原样使用这一份</div>
      </details>

      <div className="inspector-actions">
        <button onClick={previewSeedreamGrid} disabled={Boolean(busy)}>
          {busy === "preview" ? "..." : "预览组装"}
        </button>
        <button onClick={regenerate} disabled={Boolean(busy)} className="primary">
          {busy === "generate" ? "..." : asset ? "重新出图" : "生成分镜板"}
        </button>
      </div>
      {asset && assetPreviewUrl(asset) && (
        <a
          className="inspector-download"
          href={api.downloadAssetUrl(asset.id)}
          download={`storyboard-${shot.title || `shot-${shot.index}`}.png`}
          onClick={() => emitDownloadToast(`storyboard-${shot.title || `shot-${shot.index}`}.png`)}
        >
          ⬇ 下载分镜板原图
        </a>
      )}
      {asset && assetPreviewUrl(asset) && (
        <details className="inspector-fold" open>
          <summary>当前分镜板预览（点开看大图）</summary>
          <ZoomablePreview
            url={assetPreviewUrl(asset) as string}
            mediaKind="image"
            title={`${shot.title || `Shot ${shot.index}`} · 分镜板`}
            downloadUrl={api.downloadAssetUrl(asset.id)}
            downloadFilename={`storyboard-${shot.title || `shot-${shot.index}`}.png`}
            generatedAt={asset.generatedAt}
            generatedLabel="分镜板生成时间"
            fallbackAt={asset.createdAt}
            fallbackLabel="创建时间"
          />
        </details>
      )}

      {asset?.composedPrompt && (
        <details className="inspector-fold">
          <summary>上次实际送出的 prompt（审计）</summary>
          <pre className="inspector-pre">{asset.composedPrompt}</pre>
        </details>
      )}
      {asset?.referenceImageUrls?.length ? (
        <details className="inspector-fold">
          <summary>上次实际带去的参考图 ({asset.referenceImageUrls.length})</summary>
          <div className="inspector-ref-thumbs">
            {asset.referenceImageUrls.map((url, i) => (
              <img key={i} src={url} alt={`ref-${i}`} />
            ))}
          </div>
        </details>
      ) : null}
      {error && <div className="inspector-error">{error}</div>}
    </aside>
  );
}

// ============================================================================
// Shot (video) inspector
// ============================================================================

/**
 * Build the MentionOption list passed into MentionTextarea. Wired references (assets / refvideo /
 * storyboard already connected to this shot via canvas edges) come first and are tagged `wired`;
 * other session-scope visible assets follow so the user can also @-mention something they
 * haven't wired yet (the server's getAssetsForShot will pick it up via name match).
 */
function buildShotMentionOptions(shot: Shot, allAssets: Asset[], session: SessionWithShots | undefined): MentionOption[] {
  const handle = (asset: Asset) => asset.name.replace(/\s*\/\s*/g, "/").replace(/\s+/g, "");
  const shotHandle = (s: Shot) => (s.title || `Shot${s.index}`).replace(/\s*\/\s*/g, "/").replace(/\s+/g, "");
  const isVisible = (asset: Asset) => {
    if (asset.ownerShotId && asset.ownerShotId !== shot.id) return false;
    if (asset.ownerSessionId && session && asset.ownerSessionId !== session.id) return false;
    return true;
  };

  const options: MentionOption[] = [];
  const seen = new Set<string>();
  const add = (assetId: string | undefined, tag: string, wired: boolean) => {
    if (!assetId || seen.has(assetId)) return;
    const asset = allAssets.find((a) => a.id === assetId);
    if (!asset || !isVisible(asset)) return;
    seen.add(assetId);
    options.push({ id: assetId, handle: handle(asset), label: asset.name, tag, wired });
  };

  (shot.assetIds || []).forEach((id) => add(id, "资产", true));
  add(shot.referenceVideoAssetId, "参考视频", true);
  (shot.subShotStoryboardAssetIds || []).forEach((id) => add(id, "分镜板", true));
  if (shot.subShotStoryboardAssetId) add(shot.subShotStoryboardAssetId, "分镜板", true);

  // Cross-shot reference video — the source is another shot in this session, not an asset row.
  // Surface it as a mention option so the user can @-reference it in the prompt and see the
  // wiring without leaving the textarea. Pinned-wired so it floats to the top of the popup.
  if (shot.referenceVideoFromShotId && session) {
    const sourceShot = (session.shots || []).find((s) => s.id === shot.referenceVideoFromShotId);
    if (sourceShot) {
      // Use a stable id that won't collide with assets (assets are `asset_xxx`, shots `shot_xxx`).
      const optionId = `shot:${sourceShot.id}`;
      if (!seen.has(optionId)) {
        seen.add(optionId);
        options.unshift({
          id: optionId,
          handle: shotHandle(sourceShot),
          label: `${sourceShot.title || `Shot ${sourceShot.index}`}（视频）`,
          tag: "上一镜视频",
          wired: true
        });
      }
    }
  }

  // Append every other visible asset in the session so @-autocomplete reaches the full library.
  for (const asset of allAssets) {
    if (seen.has(asset.id)) continue;
    if (!isVisible(asset)) continue;
    if (asset.ownerShotId) continue; // shot-scoped sketches / per-shot grids stay private
    const tagLabel = asset.type === "character" ? "角色"
      : asset.type === "scene" ? "场景"
      : asset.type === "prop" ? "道具"
      : asset.type === "style" ? "风格"
      : asset.mediaKind === "video" ? "视频"
      : "其它";
    options.push({ id: asset.id, handle: handle(asset), label: asset.name, tag: tagLabel, wired: false });
    seen.add(asset.id);
  }

  return options;
}

/**
 * Short chip row showing every reference the user has wired into this Shot via the canvas, with
 * the `@<handle>` label that matches what the server-side @-mention parser will accept. Clicking
 * a chip appends the alias to the prompt textarea so the user doesn't have to remember names.
 *
 * Sources of references (mirrors what the server collects in /generate):
 *   - shot.assetIds                   — anchor character / scene / prop / style assets
 *   - shot.referenceVideoAssetId      — uploaded reference video (Seedance reference_video)
 *   - shot.subShotStoryboardAssetIds  — storyboard grids feeding this shot (own + cross-shot)
 *
 * Aliases are normalized the same way the server's `normalizeMentionText` does — strip whitespace
 * and slashes — so what the user clicks matches what the parser will recognize.
 */
function ShotMentionChips({ shot, allAssets, session, onPick }: {
  shot: Shot;
  allAssets: Asset[];
  session?: SessionWithShots;
  onPick: (handle: string) => void;
}) {
  const handle = (asset: Asset) => asset.name.replace(/\s*\/\s*/g, "/").replace(/\s+/g, "");
  const shotHandle = (s: Shot) => (s.title || `Shot${s.index}`).replace(/\s*\/\s*/g, "/").replace(/\s+/g, "");

  const items: Array<{ id: string; label: string; handle: string; tag: string }> = [];
  const seen = new Set<string>();
  const push = (assetId: string | undefined, tag: string) => {
    if (!assetId || seen.has(assetId)) return;
    const asset = allAssets.find((a) => a.id === assetId);
    if (!asset) return;
    seen.add(assetId);
    items.push({ id: assetId, label: asset.name, handle: handle(asset), tag });
  };
  (shot.assetIds || []).forEach((id) => push(id, "资产"));
  push(shot.referenceVideoAssetId, "参考视频");
  (shot.subShotStoryboardAssetIds || []).forEach((id) => push(id, "分镜板"));
  if (shot.subShotStoryboardAssetId) push(shot.subShotStoryboardAssetId, "分镜板");

  // Cross-shot reference video: surface the source shot as a chip even though it's not an Asset
  // row. Same handle the @-popup uses, so clicking and typing both insert the same alias.
  if (shot.referenceVideoFromShotId && session) {
    const sourceShot = (session.shots || []).find((s) => s.id === shot.referenceVideoFromShotId);
    if (sourceShot) {
      const optionId = `shot:${sourceShot.id}`;
      if (!seen.has(optionId)) {
        seen.add(optionId);
        items.push({
          id: optionId,
          label: sourceShot.title || `Shot ${sourceShot.index}`,
          handle: shotHandle(sourceShot),
          tag: "上一镜视频"
        });
      }
    }
  }

  if (!items.length) {
    return (
      <div className="inspector-mention-chips empty">
        没有连进来的引用 — 从画布拖一根线到这个 Shot，或者直接 @-mention session 里的资产名。
      </div>
    );
  }

  return (
    <div className="inspector-mention-chips">
      <span className="inspector-mention-chips-label">可 @ 引用：</span>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          className="inspector-mention-chip"
          onClick={() => onPick(item.handle)}
          title={`点一下把 @${item.handle}（${item.tag}）加进 prompt`}
        >
          @{item.handle}
          <small>{item.tag}</small>
        </button>
      ))}
    </div>
  );
}

function seedancePhaseLabel(phase: Shot["seedancePhase"] | undefined) {
  if (phase === "queued") return "Seedance 排队中";
  if (phase === "running") return "Seedance 渲染中";
  return "生成中";
}

function useInspectorElapsedLabel(startedAt: string | null | undefined, active: boolean): string | undefined {
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

function ShotInspector({ shot, session, allAssets, visionReviewEnabled, onMutated, onDeleteCanvasShot, onClose }: {
  shot: Shot;
  session?: SessionWithShots;
  allAssets: Asset[];
  visionReviewEnabled: boolean;
  onMutated: () => Promise<void> | void;
  onDeleteCanvasShot?: (shot: Shot) => Promise<boolean> | boolean;
  onClose: () => void;
}) {
  const [rawPrompt, setRawPrompt] = useState(shot.rawPrompt || shot.prompt || "");
  const [durationSec, setDurationSec] = useState<number>(shot.durationSec || 12);
  const [composedDraft, setComposedDraft] = useState<string>(shot.composedSeedancePromptDraft || "");
  const [title, setTitle] = useState<string>(shot.title || "");
  const [busy, setBusy] = useState<"" | "preview" | "save" | "generate" | "rename" | "derive-switch" | "restore" | "delete-render" | "review" | "tailframe">("");
  const [error, setError] = useState<string>("");
  const [showFailedHistory, setShowFailedHistory] = useState(false);
  // The rawPrompt value as it was when composedDraft (#2) was last regenerated. Used to detect
  // staleness — when #1 (rawPrompt) has been edited since #2 was composed, the user could be
  // about to regenerate with a stale text content. We surface a warning near #2 then.
  const [composedDraftBasis, setComposedDraftBasis] = useState<string>(shot.rawPrompt || shot.prompt || "");

  useEffect(() => {
    setRawPrompt(shot.rawPrompt || shot.prompt || "");
    setDurationSec(shot.durationSec || 12);
    setComposedDraft(shot.composedSeedancePromptDraft || "");
    setTitle(shot.title || "");
    setComposedDraftBasis(shot.rawPrompt || shot.prompt || "");
    setError("");
  }, [shot.id]);

  // #2 is stale when (a) the user has typed something into #2 (or auto-composed it via "预览组装")
  // AND (b) their #1 has diverged from the snapshot taken at the moment #2 was set. Whitespace-
  // trimmed compare so trailing spaces don't fire false positives.
  const composedDraftStale = Boolean(composedDraft.trim()) && rawPrompt.trim() !== composedDraftBasis.trim();
  const currentRender = (shot.renders || []).find((render) => render.videoUrl === shot.videoUrl || render.remoteVideoUrl === shot.videoUrl);
  const videoCacheKey = currentRender?.id || shot.videoUrl;
  const tailframeAssets = allAssets
    .filter((asset) => asset.ownerSessionId === shot.sessionId && (asset.tags || []).includes("tailframe") && (asset.tags || []).includes(`source-shot:${shot.id}`))
    .sort((a, b) => new Date(b.generatedAt || b.createdAt || b.updatedAt).getTime() - new Date(a.generatedAt || a.createdAt || a.updatedAt).getTime());
  const latestTailframe = tailframeAssets[0];
  const frameCandidateIds = Array.from(new Set([
    ...(shot.assetIds || []),
    shot.firstFrameAssetId,
    shot.lastFrameAssetId,
    ...allAssets
      .filter((asset) => asset.ownerSessionId === shot.sessionId && (asset.tags || []).includes("tailframe"))
      .map((asset) => asset.id)
  ].filter(Boolean) as string[]));
  const frameCandidates = frameCandidateIds
    .map((id) => allAssets.find((asset) => asset.id === id))
    .filter((asset): asset is Asset => Boolean(asset && (asset.mediaKind === "image" || asset.imageUrl || asset.mediaUrl)));
  const firstLastModeEnabled = Boolean(shot.firstFrameAssetId || shot.lastFrameAssetId);

  const saveTitle = async () => {
    const trimmed = title.trim();
    if (trimmed === (shot.title || "")) return;
    setBusy("rename"); setError("");
    try {
      await api.updateShot(shot.id, { title: trimmed });
      await onMutated();
    } catch (err) { setError(err instanceof Error ? err.message : "改名失败"); }
    finally { setBusy(""); }
  };

  // Detect the structured "reference video too long" 400 the server emits via the prefix sentinel
  // (see generators.ts decorateSeedanceError). When set, ShotInspector surfaces a one-click "派生
  // 15s 剪裁版并切换" button — calls derive-clip on the bound asset, then swaps the shot's
  // referenceVideoAssetId to the new derivative. User must click; we never auto-retry.
  const REF_VIDEO_TOO_LONG = "[REFERENCE_VIDEO_TOO_LONG]";
  const refVideoTooLong = Boolean(shot.error && shot.error.startsWith(REF_VIDEO_TOO_LONG));
  const deriveAndSwitch = async () => {
    if (!shot.referenceVideoAssetId) {
      setError("找不到绑定的参考视频 asset id;请先确认已绑定。");
      return;
    }
    setBusy("derive-switch"); setError("");
    try {
      const result = await api.deriveClip(shot.referenceVideoAssetId, "trim");
      await api.updateShot(shot.id, {
        referenceVideoAssetId: result.asset.id,
        error: undefined,
        status: "draft"
      });
      await onMutated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "派生 + 切换失败");
    } finally { setBusy(""); }
  };

  const save = async () => {
    setBusy("save"); setError("");
    try {
      await api.updateShot(shot.id, { rawPrompt, prompt: rawPrompt, durationSec, composedSeedancePromptDraft: composedDraft });
      await onMutated();
    } catch (err) { setError(err instanceof Error ? err.message : "保存失败"); }
    finally { setBusy(""); }
  };

  const previewSeedancePrompt = async () => {
    setBusy("preview"); setError("");
    try {
      // Persist edits first so the dry-run sees them.
      await api.updateShot(shot.id, { rawPrompt, prompt: rawPrompt, durationSec });
      const composition = await api.dryRunShotSeedancePrompt(shot.id);
      setComposedDraft(composition.composedPrompt);
      // The fresh composedDraft was computed from the current rawPrompt — anchor the basis here
      // so the staleness warning clears immediately.
      setComposedDraftBasis(rawPrompt);
      await onMutated();
    } catch (err) { setError(err instanceof Error ? err.message : "预览失败"); }
    finally { setBusy(""); }
  };

  const regenerate = async () => {
    setBusy("generate"); setError("");
    try {
      await api.updateShot(shot.id, { rawPrompt, prompt: rawPrompt, durationSec, composedSeedancePromptDraft: composedDraft });
      await api.generateShot(shot.id, {
        visionReview: visionReviewEnabled,
        composedPrompt: composedDraft || undefined
      });
      // After a successful submit, the composedDraft (whether user-edited or empty) is the truth
      // for "what was just sent". Anchor the basis to current rawPrompt so the warning resets.
      setComposedDraftBasis(rawPrompt);
      await onMutated();
    } catch (err) { setError(err instanceof Error ? err.message : "出片失败"); }
    finally { setBusy(""); }
  };

  const reviewShot = async () => {
    setBusy("review"); setError("");
    try {
      await api.reviewShotVideo(shot.id);
      await onMutated();
    } catch (err) { setError(err instanceof Error ? err.message : "VLM 审片失败"); }
    finally { setBusy(""); }
  };

  const createTailframe = async () => {
    setBusy("tailframe"); setError("");
    try {
      await api.createShotTailFrame(shot.id, { publishToTos: true, canvasNode: true });
      await onMutated();
    } catch (err) { setError(err instanceof Error ? err.message : "生成尾帧失败"); }
    finally { setBusy(""); }
  };

  const updateFirstLastFrameMode = async (enabled: boolean) => {
    setBusy("save"); setError("");
    try {
      await api.updateShot(shot.id, enabled
        ? {
            referenceVideoAssetId: "",
            referenceVideoFromShotId: "",
            referenceClipUrl: null,
            referenceAudioUrl: null,
            usePreviousShotClip: false
          }
        : {
            firstFrameAssetId: "",
            lastFrameAssetId: ""
          });
      await onMutated();
    } catch (err) { setError(err instanceof Error ? err.message : "切换首尾帧模式失败"); }
    finally { setBusy(""); }
  };

  const updateFrameAnchor = async (field: "firstFrameAssetId" | "lastFrameAssetId", value: string) => {
    setBusy("save"); setError("");
    try {
      await api.updateShot(shot.id, {
        [field]: value,
        ...(value ? {
          referenceVideoAssetId: "",
          referenceVideoFromShotId: "",
          referenceClipUrl: null,
          referenceAudioUrl: null,
          usePreviousShotClip: false
        } : {})
      });
      await onMutated();
    } catch (err) { setError(err instanceof Error ? err.message : "设置首尾帧失败"); }
    finally { setBusy(""); }
  };

  const status = shot.status;
  const generating = status === "generating";
  const pendingRender = generating
    ? (shot.renders || []).find((r) => r.status === "generating" || Boolean(r.generationTaskId))
    : undefined;
  const generatingLabel = seedancePhaseLabel(pendingRender?.seedancePhase || shot.seedancePhase);
  const generatingElapsed = useInspectorElapsedLabel(
    pendingRender?.generationStartedAt || shot.generationStartedAt || undefined,
    generating
  );
  const currentVideoReady = Boolean(shot.videoUrl) && !generating;

  return (
    <aside className="inspector">
      <header>
        <span className="inspector-tag">视频 · Shot {shot.index}</span>
        <button onClick={onClose} className="inspector-close">×</button>
      </header>
      <label>分镜名称
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={saveTitle}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
          disabled={busy === "rename"}
          placeholder={`Shot ${shot.index}`}
        />
      </label>
      {refVideoTooLong && (
        <div className="inspector-section" style={{ borderLeft: "3px solid #fbbf24", paddingLeft: 10 }}>
          <strong>⚠️ 参考视频超过 Seedance 15.2s 上限</strong>
          <div className="inspector-hint">
            绑定的参考视频时长超出限制,Seedance 拒绝了上次提交。点下面的按钮会:产出一个截前 15s 的派生剪裁节点,并把本分镜的参考视频切到新派生上。原参考视频不动。
          </div>
          <div className="inspector-actions">
            <button onClick={deriveAndSwitch} disabled={Boolean(busy)} className="primary">
              {busy === "derive-switch" ? "..." : "派生 15s 剪裁版并切换"}
            </button>
          </div>
          <details className="inspector-fold">
            <summary>原始错误</summary>
            <pre style={{ whiteSpace: "pre-wrap", fontSize: 11 }}>{shot.error}</pre>
          </details>
        </div>
      )}
      <label>场景描述 / 6 字段动作 prompt
        <MentionTextarea
          value={rawPrompt}
          onChange={setRawPrompt}
          rows={10}
          options={buildShotMentionOptions(shot, allAssets, session)}
          placeholder="@-mention 资产 / 参考视频 / 分镜板，输入 @ 弹出补全"
        />
      </label>
      {/* Compact reminder of which references are wired in. The autocomplete (typing @ inside the
          textarea) is the primary input method; chips here just signal "what's connected". */}
      <ShotMentionChips
        shot={shot}
        allAssets={allAssets}
        session={session}
        onPick={(handle) => {
          const insert = `@${handle} `;
          setRawPrompt((prev) => (prev.endsWith(" ") || prev.length === 0 ? prev + insert : prev + " " + insert));
        }}
      />
      <div className="inspector-row">
        <label>时长 (秒)<input type="number" min={1} max={15} value={durationSec} onChange={(e) => setDurationSec(Number(e.target.value) || 12)} /></label>
        <label>状态<input value={status} disabled /></label>
      </div>
      <div className="inspector-section">
        <label className="vision-review-toggle" title="勾选后，这个视频用 first_frame / last_frame 模式；不勾选则走默认参考图 / 参考视频模式。">
          <input
            type="checkbox"
            checked={firstLastModeEnabled}
            disabled={Boolean(busy)}
            onChange={(e) => { void updateFirstLastFrameMode(e.target.checked); }}
          />
          使用首尾帧模式（不勾选=默认参考图/参考视频）
        </label>
        {firstLastModeEnabled && (
          <div className="inspector-row">
            <label>首帧参考
              <select
                value={shot.firstFrameAssetId || ""}
                disabled={Boolean(busy)}
                onChange={(e) => { void updateFrameAnchor("firstFrameAssetId", e.target.value); }}
              >
                <option value="">未选择</option>
                {frameCandidates.map((asset) => (
                  <option key={asset.id} value={asset.id}>{asset.name}</option>
                ))}
              </select>
            </label>
            <label>尾帧参考
              <select
                value={shot.lastFrameAssetId || ""}
                disabled={Boolean(busy)}
                onChange={(e) => { void updateFrameAnchor("lastFrameAssetId", e.target.value); }}
              >
                <option value="">未选择</option>
                {frameCandidates.map((asset) => (
                  <option key={asset.id} value={asset.id}>{asset.name}</option>
                ))}
              </select>
            </label>
          </div>
        )}
        <div className="inspector-hint">
          连接进这个视频节点的尾帧/帧锚点会出现在候选里；拖尾帧节点到视频节点会自动设为首帧。
        </div>
      </div>
      <label className="vision-review-toggle" title="勾选后，这个视频节点参与 VLM 审核；审核失败可一键修当前/前序依赖 prompt。">
        <input
          type="checkbox"
          checked={shot.vlmReviewEnabled !== false}
          onChange={async (e) => {
            await api.updateShot(shot.id, { vlmReviewEnabled: e.target.checked });
            await onMutated();
          }}
        />
        VLM 审核此节点
      </label>
      <details className="inspector-fold" open={Boolean(composedDraft) || composedDraftStale}>
        <summary>
          送给 Seedance 的最终 prompt（草稿，可改）
          {composedDraftStale && <span className="inspector-stale-tag">⚠ 与 #1 不同步</span>}
        </summary>
        {composedDraftStale && (
          <div className="inspector-stale-warn">
            <span>
              你改了上面的「场景描述」，但这份组装结果还是旧版本——下次「出片」会用这份旧的 text 内容。
              （@-mention 的参考图 / 视频按 #1 实时生效，**只有文字描述部分**会沿用旧版本。）
            </span>
            <div className="inspector-stale-actions">
              <button
                onClick={previewSeedancePrompt}
                disabled={Boolean(busy)}
                title="按当前 #1 重新组装一份新的 #2"
              >
                {busy === "preview" ? "..." : "重新组装"}
              </button>
              <button
                onClick={() => {
                  setComposedDraft("");
                  setComposedDraftBasis(rawPrompt);
                }}
                title="清空 #2，下次出片让 server 自动按 #1 现场组装"
              >
                清空 #2（走自动）
              </button>
            </div>
          </div>
        )}
        <textarea rows={12} value={composedDraft} onChange={(e) => setComposedDraft(e.target.value)} placeholder="点「预览组装」拉取一份完整的中文组装结果，再改" />
        <div className="inspector-hint">空表示走默认组装；非空则下次「出片」原样使用这一份</div>
      </details>
      <div className="inspector-actions">
        <button onClick={previewSeedancePrompt} disabled={Boolean(busy)}>
          {busy === "preview" ? "..." : "预览组装"}
        </button>
        <button onClick={save} disabled={Boolean(busy)}>
          {busy === "save" ? "..." : "保存"}
        </button>
        <button onClick={regenerate} disabled={Boolean(busy) || generating} className="primary">
          {busy === "generate" || generating ? "生成中..." : shot.videoUrl ? "重生" : "出片"}
        </button>
        <button onClick={reviewShot} disabled={Boolean(busy) || generating || !shot.videoUrl}>
          {busy === "review" ? "审片中..." : "VLM 审片"}
        </button>
        <button
          onClick={async () => {
            setBusy("review"); setError("");
            try {
              await api.repairShotPromptsFromReview(shot.id);
              await onMutated();
            } catch (err) { setError(err instanceof Error ? err.message : "修 prompt 失败"); }
            finally { setBusy(""); }
          }}
          disabled={Boolean(busy) || generating || !(shot.videoReview || (shot.renders || []).some((r) => r.videoReview))}
        >
          修 Prompt
        </button>
        {/*
         * Explicit "delete shot" button. Canvas-keyboard delete (Delete / Backspace) also works,
         * but the Inspector button keeps destructive intent discoverable and mirrors the same
         * generating-shot guard as the canvas path.
         */}
        <button
          onClick={async () => {
            if (shot.status === "generating") {
              window.alert("该分镜正在生成中，完成或取消后再删除。");
              return;
            }
            if (!window.confirm(`删除「${shot.title || `Shot ${shot.index}`}」？删除后可在画布顶部「↶ 撤销」恢复。`)) return;
            setBusy("delete-render"); setError("");
            try {
              if (onDeleteCanvasShot) {
                // Prefer the canvas-level handler when available — it pushes an undo entry so the
                // user can recover via the toolbar undo button. Falls back to a direct delete if
                // the prop wasn't wired (defensive — same end-state, just no undo).
                const deleted = await onDeleteCanvasShot(shot);
                if (!deleted) return;
                await onMutated();
              } else {
                await api.deleteShot(shot.id);
                await onMutated();
              }
              onClose();
            } catch (err) {
              setError(err instanceof Error ? err.message : "删除失败");
            } finally { setBusy(""); }
          }}
          disabled={Boolean(busy) || shot.status === "generating"}
          className="danger"
          title={shot.status === "generating" ? "生成中不能删除，先取消或等完成" : "删除这一镜（可撤销）"}
        >
          {busy === "delete-render" ? "..." : "删除"}
        </button>
      </div>
      {/* Opt-in to sub-storyboard mode: only emit the StoryboardNode placeholder once the user
          asks for it. Sets subShotPanelCount=9 → buildGraph picks up showStoryboardNode → the
          slot appears on the canvas with empty thumbnail; clicking it opens StoryboardInspector. */}
      {!shot.subShotStoryboardAssetId && !(shot.subShotStoryboardAssetIds && shot.subShotStoryboardAssetIds.length) && (!shot.subShotPanelCount || shot.subShotPanelCount <= 1) && (
        <button
          className="ghost-action"
          onClick={async () => {
            await api.updateShot(shot.id, { subShotPanelCount: 9 });
            await onMutated();
          }}
          title="为这个 shot 启用「分镜板」工作流：打开后画布会出现一个空白分镜板节点，点开能编辑参数 + 出图"
        >
          + 启用分镜板（3×3）
        </button>
      )}
      {currentVideoReady && (
        <a
          className="inspector-download"
          href={api.downloadShotUrl(shot.id)}
          download={`${shot.title || `shot-${shot.index}`}.mp4`}
          onClick={() => emitDownloadToast(`${shot.title || `shot-${shot.index}`}.mp4`)}
        >
          ⬇ 下载本镜 mp4
        </a>
      )}
      {currentVideoReady && (
        <button
          className="ghost-action"
          onClick={createTailframe}
          disabled={Boolean(busy)}
          title="从当前视频最后一帧抽图，生成一个可拖线连接到后续视频的尾帧节点"
        >
          {busy === "tailframe" ? "..." : "+ 生成尾帧节点"}
        </button>
      )}
      {latestTailframe && assetPreviewUrl(latestTailframe) && (
        <details className="inspector-fold">
          <summary>最近尾帧节点预览</summary>
          <ZoomablePreview
            url={assetPreviewUrl(latestTailframe) as string}
            mediaKind="image"
            title={latestTailframe.name}
            downloadUrl={api.downloadAssetUrl(latestTailframe.id)}
            downloadFilename={`${latestTailframe.name}.png`}
            generatedAt={latestTailframe.generatedAt}
            generatedLabel="尾帧生成时间"
            fallbackAt={latestTailframe.createdAt}
            fallbackLabel="创建时间"
          />
          <div className="inspector-hint">画布上可把这个尾帧节点拖线连接到后续视频节点，作为该视频的首帧参考。</div>
        </details>
      )}
      {generating ? (
        <details className="inspector-fold" open>
          <summary>当前视频（点开放大播放）</summary>
          <div className="inspector-generating-preview" role="status" aria-live="polite">
            <span className="flow-empty-spinner" aria-hidden />
            <strong>{generatingLabel}…</strong>
            {generatingElapsed && <small>已用时 {generatingElapsed}</small>}
            {shot.videoUrl && <p>新视频还没完成，暂不显示旧视频，避免误判新旧结果。</p>}
          </div>
        </details>
      ) : currentVideoReady ? (
        <details className="inspector-fold" open>
          <summary>当前视频（点开放大播放）</summary>
          <ZoomablePreview
            url={api.shotStreamUrl(shot.id, videoCacheKey)}
            mediaKind="video"
            title={`${shot.title || `Shot ${shot.index}`} · 视频`}
            downloadUrl={api.downloadShotUrl(shot.id)}
            downloadFilename={`${shot.title || `shot-${shot.index}`}.mp4`}
            generatedAt={currentRender?.videoGeneratedAt || shot.videoGeneratedAt}
            generatedLabel="视频生成时间"
            fallbackAt={currentRender?.createdAt}
            fallbackLabel="提交时间"
          />
        </details>
      ) : null}
      {currentVideoReady && (() => {
        const latestRender = (shot.renders || []).find((r) => r.videoUrl === shot.videoUrl || r.remoteVideoUrl === shot.videoUrl);
        return (
          <details className="inspector-fold" open>
            <summary>VLM 审片结果</summary>
            <VideoReviewCard
              verdict={latestRender?.videoReview || shot.videoReview}
              status={latestRender?.videoReviewStatus || shot.videoReviewStatus}
              error={latestRender?.videoReviewError || shot.videoReviewError}
            />
          </details>
        );
      })()}
      {(() => {
        const latestRender = (shot.renders || []).find((r) => r.videoUrl === shot.videoUrl || r.remoteVideoUrl === shot.videoUrl);
        if (generating || !latestRender?.composedPrompt) return null;
        return (
          <details className="inspector-fold">
            <summary>上次实际送出的 prompt（审计）</summary>
            <pre className="inspector-pre">{latestRender.composedPrompt}</pre>
          </details>
        );
      })()}
      {(() => {
        // History panel — every regenerate prepends a ShotRender snapshot. The shot's
        // current videoUrl is whichever render is at the front; here we expose the rest so
        // the user can play, audit, restore, or delete prior versions.
        const allRenders = shot.renders || [];
        const currentRenderId = currentVideoReady
          ? allRenders.find((r) => (r.videoUrl && r.videoUrl === shot.videoUrl) || (r.remoteVideoUrl && r.remoteVideoUrl === shot.videoUrl))?.id
          : undefined;
        const previous = currentRenderId ? allRenders.filter((r) => r.id !== currentRenderId) : allRenders;
        const visible = showFailedHistory ? previous : previous.filter((r) => r.videoUrl);
        if (!previous.length) return null;
        const hiddenFailedCount = previous.length - previous.filter((r) => r.videoUrl).length;
        const restoreRender = async (renderId: string) => {
          if (!window.confirm("用这个历史版本覆盖当前结果？\n（当前 videoUrl 仍保留在历史里，可随时再切回。）")) return;
          setBusy("restore"); setError("");
          try {
            await api.restoreShotRender(shot.id, renderId);
            await onMutated();
          } catch (err) {
            setError(err instanceof Error ? err.message : "恢复失败");
          } finally { setBusy(""); }
        };
        const deleteRender = async (renderId: string) => {
          if (!window.confirm("删除这一条历史版本？此操作不可撤销。")) return;
          setBusy("delete-render"); setError("");
          try {
            await api.deleteShotRender(shot.id, renderId);
            await onMutated();
          } catch (err) {
            setError(err instanceof Error ? err.message : "删除失败");
          } finally { setBusy(""); }
        };
        return (
          <details className="inspector-fold">
            <summary>历史版本（{visible.length}{hiddenFailedCount && !showFailedHistory ? ` · 隐藏失败 ${hiddenFailedCount}` : ""}）</summary>
            {hiddenFailedCount > 0 && (
              <label className="inspector-hint" style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
                <input
                  type="checkbox"
                  checked={showFailedHistory}
                  onChange={(e) => setShowFailedHistory(e.target.checked)}
                />
                显示失败/未完成的记录
              </label>
            )}
            {visible.length === 0 && (
              <div className="inspector-hint">暂无历史版本。</div>
            )}
            {visible.map((render) => {
              const tsSource = render.videoGeneratedAt || render.createdAt;
              const ts = formatMediaTime(tsSource) || "";
              const tsLabel = render.videoGeneratedAt ? "生成时间" : "提交时间";
              const playable = Boolean(render.videoUrl);
              return (
                <div key={render.id} className="inspector-history-item">
                  <div className="inspector-history-meta">
                    <span>{ts ? `${tsLabel}：${ts}` : ""}</span>
                    <span className="inspector-history-model">{render.model || "seedance"}</span>
                    {render.status && render.status !== "ready" && (
                      <span className="inspector-history-status">{render.status}</span>
                    )}
                  </div>
                  {playable && (
                    <ZoomablePreview
                      url={api.shotStreamUrl(shot.id, render.id)}
                      mediaKind="video"
                      title={`${shot.title || `Shot ${shot.index}`} · ${ts || "历史版本"}`}
                      downloadUrl={api.downloadShotUrl(shot.id)}
                      downloadFilename={`${shot.title || `shot-${shot.index}`}-${render.id}.mp4`}
                      generatedAt={render.videoGeneratedAt}
                      generatedLabel="生成时间"
                      fallbackAt={render.createdAt}
                      fallbackLabel="提交时间"
                    />
                  )}
                  {render.composedPrompt && (
                    <details>
                      <summary>查看送出的 prompt</summary>
                      <pre className="inspector-pre">{render.composedPrompt}</pre>
                    </details>
                  )}
                  {(render.videoReview || render.videoReviewStatus || render.videoReviewError) && (
                    <details>
                      <summary>VLM 审片</summary>
                      <VideoReviewCard verdict={render.videoReview} status={render.videoReviewStatus} error={render.videoReviewError} />
                    </details>
                  )}
                  {render.error && <div className="inspector-error">{render.error}</div>}
                  <div className="inspector-history-actions">
                    {playable && (
                      <button
                        type="button"
                        onClick={() => restoreRender(render.id)}
                        disabled={Boolean(busy)}
                        title="把这一条历史版本切换为当前结果"
                      >
                        {busy === "restore" ? "..." : "恢复此版本"}
                      </button>
                    )}
                    <button
                      type="button"
                      className="ghost-action"
                      onClick={() => deleteRender(render.id)}
                      disabled={Boolean(busy)}
                    >
                      {busy === "delete-render" ? "..." : "删除"}
                    </button>
                  </div>
                </div>
              );
            })}
          </details>
        );
      })()}
      {shot.error && <div className="inspector-error">{shot.error}</div>}
      {error && <div className="inspector-error">{error}</div>}
    </aside>
  );
}

// ============================================================================
// Stitch inspector
// ============================================================================

function StitchInspector({ session, job, legacy, onMutated, onClose }: {
  session: SessionWithShots;
  job: StitchJob;
  legacy?: boolean;
  onMutated: () => Promise<void> | void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState<"" | "stitch" | "review" | "repair" | "order">("");
  const [error, setError] = useState<string>("");

  const orderedShots = (session.shots || []).slice().sort((a, b) => a.index - b.index);
  const explicitIds = job.shotIds || [];
  const explicitMode = explicitIds.length > 0;
  const stitchShots = explicitMode
    ? explicitIds.map((id) => orderedShots.find((s) => s.id === id)).filter((s): s is Shot => Boolean(s))
    : orderedShots;
  const defaultReady = orderedShots.length > 0 && orderedShots.every((s) => s.videoUrl);
  const explicitReady = explicitMode && stitchShots.length > 0 && stitchShots.every((s) => s.videoUrl);
  const canStitch = explicitMode ? explicitReady : defaultReady;
  const isStitching = job.status === "running";
  const finalCacheKey = job.finalVideoGeneratedAt || job.finalVideoUrl || job.finalVideoSignature || job.updatedAt;
  const jobId = legacy ? undefined : job.id;
  const title = job.name || "完整视频";

  const saveOrder = async (nextIds: string[]) => {
    setBusy("order"); setError("");
    try {
      if (legacy) {
        await api.updateSession(session.id, {
          stitchShotIds: nextIds,
          stitchStatus: "idle",
          stitchError: "",
          stitchProgress: ""
        });
      } else {
        await api.updateStitchJob(session.id, job.id, {
          shotIds: nextIds,
          status: "idle",
          error: "",
          progress: ""
        });
      }
      await onMutated();
    } catch (err) { setError(err instanceof Error ? err.message : "保存拼接顺序失败"); }
    finally { setBusy(""); }
  };

  const move = (index: number, delta: -1 | 1) => {
    const nextIndex = index + delta;
    if (nextIndex < 0 || nextIndex >= explicitIds.length) return;
    const next = [...explicitIds];
    [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
    void saveOrder(next);
  };

  const stitch = async () => {
    setBusy("stitch"); setError("");
    try {
      await api.stitch(session.id, { force: explicitMode, jobId });
      await onMutated();
    } catch (err) { setError(err instanceof Error ? err.message : "拼接失败"); }
    finally { setBusy(""); }
  };

  const reviewFinal = async () => {
    setBusy("review"); setError("");
    try {
      await api.reviewFinalVideo(session.id, jobId);
      await onMutated();
    } catch (err) { setError(err instanceof Error ? err.message : "VLM 终审失败"); }
    finally { setBusy(""); }
  };

  const repairFinalPrompts = async () => {
    setBusy("repair"); setError("");
    try {
      await api.repairFinalPromptsFromReview(session.id, jobId);
      await onMutated();
    } catch (err) { setError(err instanceof Error ? err.message : "终审修 Prompt 失败"); }
    finally { setBusy(""); }
  };

  return (
    <aside className="inspector">
      <header>
        <span className="inspector-tag">拼接 · {title}</span>
        <button onClick={onClose} className="inspector-close">×</button>
      </header>
      <div className="inspector-section">
        <div>共 {session.shots?.length || 0} 个分镜，目标 {session.targetDurationSec}s。</div>
        <div className="inspector-hint">
          {explicitMode ? "将按连接到这个拼接节点的顺序合成视频。" : "未连接视频时，将按分镜顺序拼接全片。"}
        </div>
      </div>
      <div className="inspector-section">
        <strong>拼接顺序</strong>
        {!explicitMode ? (
          <>
            <div className="inspector-hint">拖拽视频节点连接到这个拼接节点即可自定义顺序。多个拼接节点互不影响。</div>
            <button
              type="button"
              className="ghost-action"
              onClick={() => saveOrder(orderedShots.map((s) => s.id))}
              disabled={Boolean(busy) || orderedShots.length === 0}
            >
              用当前分镜建立顺序
            </button>
          </>
        ) : (
          <div className="inspector-history-list">
            {explicitIds.map((shotId, index) => {
              const shot = orderedShots.find((s) => s.id === shotId);
              if (!shot) return null;
              return (
                <div key={`${shotId}-${index}`} className="inspector-history-item">
                  <div className="inspector-history-meta">
                    <strong>{index + 1}. {shot.title || `Shot ${shot.index}`}</strong>
                    <span className="inspector-history-status">{shot.videoUrl ? "已生成" : "未生成"}</span>
                  </div>
                  <div className="inspector-history-actions">
                    <button type="button" onClick={() => move(index, -1)} disabled={Boolean(busy) || index === 0}>上移</button>
                    <button type="button" onClick={() => move(index, 1)} disabled={Boolean(busy) || index === explicitIds.length - 1}>下移</button>
                    <button
                      type="button"
                      className="ghost-action"
                      onClick={() => saveOrder(explicitIds.filter((_, i) => i !== index))}
                      disabled={Boolean(busy)}
                    >
                      移除
                    </button>
                  </div>
                </div>
              );
            })}
            <div className="inspector-actions">
              <button type="button" onClick={() => saveOrder(orderedShots.map((s) => s.id))} disabled={Boolean(busy)}>
                重置为分镜顺序
              </button>
              <button type="button" className="ghost-action" onClick={() => saveOrder([])} disabled={Boolean(busy)}>
                清空连接顺序
              </button>
            </div>
          </div>
        )}
      </div>
      <div className="inspector-actions">
        <button onClick={stitch} disabled={Boolean(busy) || !canStitch} className="primary">
          {busy === "stitch" ? "..." : explicitMode ? "按连接顺序拼接" : (job.finalVideoUrl ? "重新拼接" : "按分镜顺序拼接全片")}
        </button>
        <button onClick={reviewFinal} disabled={Boolean(busy) || !job.finalVideoUrl || isStitching}>
          {busy === "review" ? "终审中..." : "VLM 终审"}
        </button>
        <button onClick={repairFinalPrompts} disabled={Boolean(busy) || !job.finalVideoReview}>
          {busy === "repair" ? "修复中..." : "按终审修 Prompt"}
        </button>
      </div>
      {!canStitch && (
        <div className="inspector-hint">
          {explicitMode ? "已连接的视频中还有未生成的镜头。" : "还有分镜没生成视频。"}
        </div>
      )}
      {job.finalVideoUrl && !isStitching && (
        <a
          className="inspector-download"
          href={api.downloadSessionUrl(session.id, jobId)}
          download={`${session.title || session.id}-${title}.mp4`}
          onClick={() => emitDownloadToast(`${session.title || session.id}-${title}.mp4`)}
        >
          ⬇ 下载完整片
        </a>
      )}
      {job.finalVideoUrl && !isStitching && (
        <details className="inspector-fold" open>
          <summary>当前完整视频（点开放大播放）</summary>
          <ZoomablePreview
            url={api.sessionStreamUrl(session.id, finalCacheKey, jobId)}
            mediaKind="video"
            title={`${session.title} · ${title}`}
            downloadUrl={api.downloadSessionUrl(session.id, jobId)}
            downloadFilename={`${session.title || session.id}-${title}.mp4`}
            generatedAt={job.finalVideoGeneratedAt}
            generatedLabel="最终视频生成时间"
            fallbackAt={job.updatedAt}
            fallbackLabel="最近拼接更新时间"
          />
        </details>
      )}
      {job.finalVideoUrl && !isStitching && (
        <details className="inspector-fold" open>
          <summary>VLM 终审结果</summary>
          <VideoReviewCard
            verdict={job.finalVideoReview}
            status={job.finalVideoReviewStatus}
            error={job.finalVideoReviewError}
            stale={Boolean(job.finalVideoReviewBuiltForSignature && job.finalVideoSignature && job.finalVideoReviewBuiltForSignature !== job.finalVideoSignature)}
          />
        </details>
      )}
      {job.error && <div className="inspector-error">{job.error}</div>}
      {error && <div className="inspector-error">{error}</div>}
    </aside>
  );
}

// ============================================================================
// Reference-video inspector — drives the upload → analyze → apply-to-shot workflow.
// Shows the parsed shot table and lets the user apply any row to a target session shot's
// rawPrompt, so analyzed reference footage can become editable prompt drafts.
// ============================================================================

function ReferenceVideoInspector({ asset, session, onMutated, onDeleteCanvasAsset, onClose }: {
  asset: Asset;
  session?: SessionWithShots;
  onMutated: () => Promise<void> | void;
  onDeleteCanvasAsset?: (asset: Asset) => Promise<boolean> | boolean;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState<"" | "reanalyze" | "apply" | "save" | "reclip" | "derive" | "delete">("");
  const [error, setError] = useState<string>("");
  const [name, setName] = useState(asset.name);

  useEffect(() => {
    setName(asset.name);
    setError("");
  }, [asset.id]);

  const saveName = async () => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === asset.name) return;
    setBusy("save"); setError("");
    try {
      await api.saveAsset({ id: asset.id, name: trimmed });
      await onMutated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally { setBusy(""); }
  };

  const reclip = async (strategy: "sample-concat" | "trim" | "speedup") => {
    if (asset.clipStrategy === strategy) return;
    setBusy("reclip"); setError("");
    try {
      await api.reclipReferenceVideo(asset.id, strategy);
      await onMutated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "重新裁剪失败");
    } finally { setBusy(""); }
  };

  const reanalyze = async () => {
    setBusy("reanalyze"); setError("");
    try {
      const res = await fetch(`/api/assets/${asset.id}/analyze-video`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({})
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `${res.status} ${res.statusText}`);
      }
      await onMutated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "重新解析失败");
    } finally { setBusy(""); }
  };

  // Build a 6-field-style rawPrompt from one parsed entry. Used when the user clicks "应用到 Shot N":
  // we keep the existing shot's rawPrompt as a header (so prior intent isn't blown away) and
  // append a clearly-marked "from reference video" block. The user can edit afterwards in the
  // Shot inspector before the next "重新出图" / "出片".
  const composeRefDraft = (entry: NonNullable<typeof asset.parsedShots>[number]) => {
    const blocks: string[] = [];
    if (entry.sceneContent) blocks.push(`主体：${entry.sceneContent}`);
    if (entry.imagePrompt) blocks.push(`画面：${entry.imagePrompt}`);
    if (entry.cameraPrompt) blocks.push(`镜头：${entry.cameraPrompt}`);
    if (entry.shotType) blocks.push(`景别：${entry.shotType}`);
    if (entry.styleNotes) blocks.push(`风格：${entry.styleNotes}`);
    blocks.push(`参考来源：${asset.name} 第 ${entry.index} 镜（${entry.timeStart.toFixed(1)}-${entry.timeEnd.toFixed(1)}s）`);
    return blocks.join("\n");
  };

  const applyToShot = async (entry: NonNullable<typeof asset.parsedShots>[number], targetShotId: string) => {
    setBusy("apply"); setError("");
    try {
      const draft = composeRefDraft(entry);
      await api.updateShot(targetShotId, { rawPrompt: draft, prompt: draft });
      await onMutated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "应用失败");
    } finally { setBusy(""); }
  };

  const status = asset.parseStatus || "idle";
  const shotsForApply = (session?.shots || []).slice().sort((a, b) => a.index - b.index);

  return (
    <aside className="inspector">
      <header>
        <span className="inspector-tag">参考视频</span>
        <button onClick={onClose} className="inspector-close">×</button>
      </header>
      <div className="inspector-section">
        <label>
          名称
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={saveName}
            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
            disabled={busy === "save"}
            placeholder="参考视频名称"
          />
        </label>
        {asset.description && <small className="inspector-hint">{asset.description}</small>}
        <div className="inspector-hint">
          状态：
          <span style={{
            color: status === "ready" ? "#34d399" :
                   status === "parsing" ? "#60a5fa" :
                   status === "error" ? "#f87171" : "#9ca3af"
          }}>
            {status === "ready" ? `已解析 ${asset.parsedShots?.length ?? 0} 镜` :
             status === "parsing" ? "解析中…可能需要 30-60 秒" :
             status === "error" ? "解析失败" : "待解析"}
          </span>
        </div>
        {asset.parseError && <div className="inspector-error">{asset.parseError}</div>}
        <div className="inspector-actions">
          <button
            onClick={async () => {
              if (!window.confirm(`删除参考视频「${asset.name || asset.id}」？删除后可在画布顶部「↶ 撤销」恢复。`)) return;
              setBusy("delete"); setError("");
              try {
                if (onDeleteCanvasAsset) {
                  const deleted = await onDeleteCanvasAsset(asset);
                  if (!deleted) return;
                  await onMutated();
                } else {
                  await api.deleteAsset(asset.id);
                  await onMutated();
                }
                onClose();
              } catch (err) {
                setError(err instanceof Error ? err.message : "删除失败");
              } finally { setBusy(""); }
            }}
            disabled={Boolean(busy)}
            className="danger"
          >
            {busy === "delete" ? "..." : "删除参考视频"}
          </button>
        </div>
      </div>

      {(asset.mediaUrl || asset.imageUrl) && (
        <details className="inspector-fold" open>
          <summary>视频预览</summary>
          <ZoomablePreview
            url={api.assetStreamUrl(asset.id, asset.generatedAt || asset.updatedAt || asset.id)}
            mediaKind="video"
            title={asset.name}
            downloadUrl={api.downloadAssetUrl(asset.id)}
            downloadFilename={`${asset.name}.mp4`}
            generatedAt={asset.generatedAt}
            generatedLabel="处理时间"
            fallbackAt={asset.createdAt}
            fallbackLabel="上传时间"
          />
        </details>
      )}

      {/*
       * Reference-video clip strategy. Seedance r2v rejects sources > 15.2s, so on upload we
       * auto-condense via one of three strategies. Switcher lets the user A/B between them on
       * an already-uploaded asset — server endpoint /api/assets/:id/reclip re-runs ffmpeg on the
       * preserved local original and re-publishes to TOS. Clipping only relevant for video assets
       * that needed processing (i.e. originalDurationSec > 15s); for short sources we hide the
       * panel to avoid UI noise.
       */}
      {asset.originalDurationSec !== undefined && asset.originalDurationSec > 15.2 && (
        <div className="inspector-section">
          <strong>15s 裁剪策略</strong>
          <div className="inspector-hint">
            原片 {asset.originalDurationSec.toFixed(1)}s 超过 Seedance r2v 的 15.2s 上限，已按下面的策略压到 ≤15s。
            {asset.clipDurationSec !== undefined && (
              <> 当前产出 <strong>{asset.clipDurationSec.toFixed(1)}s</strong>。</>
            )}
          </div>
          <div className="clip-strategy-buttons" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {([
              { id: "sample-concat", label: "多段拼接", hint: "4 段 ×3s 时序采样,覆盖全片但有硬切" },
              { id: "trim", label: "截前 15s", hint: "原速运动,丢弃后段" },
              { id: "speedup", label: "整体加速", hint: "全帧覆盖,运动会变快" }
            ] as const).map((opt) => {
              const active = asset.clipStrategy === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  disabled={Boolean(busy) || active}
                  onClick={() => reclip(opt.id)}
                  title={opt.hint}
                  className={active ? "primary" : ""}
                >
                  {busy === "reclip" && !active ? "..." : opt.label}{active && " ✓"}
                </button>
              );
            })}
          </div>
          <small className="inspector-hint">
            切换策略会重新 ffmpeg 处理本地原片并重新 publish 到 TOS — 处理时间 5–30 秒。已绑定本 asset 的 shot 下次出片自动用新版本。
          </small>
        </div>
      )}

      {/*
       * Reference-video remake: bind the whole video as Seedance's `reference_video` for a target
       * shot. This is mode-exclusive — when set, the shot's first/last-frame and sub-shot modes
       * are dropped server-side. The user typically combines this with a strong text prompt
       * change ("主角变成兔子") to drive the remake.
       */}
      <div className="inspector-section">
        <strong>用作视频参考（Seedance reference_video）</strong>
        <div className="inspector-hint">
          选一个分镜把整段参考视频喂给 Seedance — 它会参考镜头语言/光影/运镜/节奏，并按你写的新 prompt 生成主体与风格。需要 TOS 公网 URL（上传时已自动 publish）。
        </div>
        {!asset.tosObjectKey && asset.mediaUrl?.startsWith("/media/") && (
          <div className="inspector-hint" style={{ color: "#fbbf24" }}>
            ⚠️ 此视频还没 publish 到公网（TOS 未配置或 publish 失败），Seedance 抓不到，绑了也无效。
          </div>
        )}
        {(() => {
          const sortedShots = (session?.shots || []).slice().sort((a, b) => a.index - b.index);
          if (!sortedShots.length) {
            return <div className="inspector-empty">本 session 还没有分镜。先点顶部「+ 分镜」加一个。</div>;
          }
          return (
            <div className="ref-bind-list">
              {sortedShots.map((s) => {
                const bound = s.referenceVideoAssetId === asset.id;
                return (
                  <label key={s.id} className={`ref-bind-row ${bound ? "active" : ""}`}>
                    <input
                      type="checkbox"
                      checked={bound}
                      disabled={Boolean(busy)}
                      onChange={async () => {
                        setBusy("apply"); setError("");
                        try {
                          await api.updateShot(s.id, {
                            // Toggle: bound now → clear; not bound → set + clear conflicting modes.
                            referenceVideoAssetId: bound ? "" : asset.id,
                            ...(bound ? {} : {
                              firstFrameAssetId: "",
                              lastFrameAssetId: "",
                              referenceVideoFromShotId: "",
                              referenceClipUrl: null,
                              referenceAudioUrl: null,
                              subShotPanelCount: 0,
                              subShotStoryboardAssetId: "",
                              subShotStoryboardAssetIds: [],
                              usePreviousShotClip: false
                            })
                          });
                          await onMutated();
                        } catch (err) {
                          setError(err instanceof Error ? err.message : "绑定失败");
                        } finally { setBusy(""); }
                      }}
                    />
                    <span><strong>Shot {s.index}</strong> {s.title || ""}</span>
                    {bound && <span className="ref-bind-badge">已绑定</span>}
                  </label>
                );
              })}
            </div>
          );
        })()}
      </div>

      {Array.isArray(asset.parsedShots) && asset.parsedShots.length > 0 && (
        <div className="inspector-section">
          <strong>分镜表（共 {asset.parsedShots.length} 镜）</strong>
          <div className="inspector-hint">从下表挑一条 → 选「应用到 Shot N」，会把这条的画面/运镜/景别/风格组合成 6 字段 rawPrompt 写到目标分镜。</div>
          <div className="ref-shot-list">
            {asset.parsedShots.map((entry) => (
              <article key={entry.index} className="ref-shot-row">
                <header>
                  <strong>#{entry.index}</strong>
                  <span className="ref-shot-time">{entry.timeStart.toFixed(1)}–{entry.timeEnd.toFixed(1)}s</span>
                  <span className="ref-shot-type">{entry.shotType || "—"}</span>
                </header>
                {entry.sceneContent && <p className="ref-shot-content">{entry.sceneContent}</p>}
                <details>
                  <summary>展开 prompt 字段</summary>
                  {entry.imagePrompt && <div className="ref-shot-field"><label>imagePrompt</label><pre>{entry.imagePrompt}</pre></div>}
                  {entry.cameraPrompt && <div className="ref-shot-field"><label>cameraPrompt</label><pre>{entry.cameraPrompt}</pre></div>}
                  {entry.styleNotes && <div className="ref-shot-field"><label>styleNotes</label><pre>{entry.styleNotes}</pre></div>}
                </details>
                <div className="ref-shot-apply">
                  <select
                    defaultValue=""
                    disabled={Boolean(busy) || shotsForApply.length === 0}
                    onChange={(e) => {
                      const targetId = e.target.value;
                      if (!targetId) return;
                      void applyToShot(entry, targetId);
                      e.target.value = "";
                    }}
                  >
                    <option value="">应用到分镜…</option>
                    {shotsForApply.map((s) => (
                      <option key={s.id} value={s.id}>Shot {s.index} · {s.title || ""}</option>
                    ))}
                  </select>
                </div>
              </article>
            ))}
          </div>
        </div>
      )}

      <div className="inspector-actions">
        <button onClick={reanalyze} disabled={Boolean(busy) || status === "parsing"}>
          {busy === "reanalyze" ? "..." : status === "ready" ? "重新解析" : status === "parsing" ? "解析中…" : "开始解析"}
        </button>
      </div>

      {(asset.mediaUrl || asset.imageUrl) && (
        <a
          className="inspector-download"
          href={api.downloadAssetUrl(asset.id)}
          download={`${asset.name}.mp4`}
          onClick={() => emitDownloadToast(`${asset.name}.mp4`)}
        >
          ⬇ 下载参考视频
        </a>
      )}

      {/*
       * Derive-clip entry: spawn a NEW asset that is a clipped derivative of this source. The
       * derivative shows up as a videoProcessor node on the canvas downstream. Useful when the
       * user wants to keep the original full-length asset around (e.g. for analyze-video) AND
       * have a separately-bindable 15s clip — instead of mutating this asset's mediaUrl in place
       * via the strategy switcher above.
       */}
      <div className="inspector-section">
        <strong>派生剪裁节点</strong>
        <div className="inspector-hint">
          产出一个独立的视频处理节点（不影响本 asset），默认按"截前 15s"剪裁。在 canvas 上拖到分镜即可作为参考视频。
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {(["trim", "speedup", "sample-concat"] as const).map((strat) => (
            <button
              key={strat}
              type="button"
              disabled={Boolean(busy)}
              onClick={async () => {
                setBusy("derive"); setError("");
                try {
                  await api.deriveClip(asset.id, strat);
                  await onMutated();
                } catch (err) {
                  setError(err instanceof Error ? err.message : "派生失败");
                } finally { setBusy(""); }
              }}
            >
              {busy === "derive" ? "..." : `+ ${strat === "trim" ? "截前 15s" : strat === "speedup" ? "整体加速" : "多段拼接"}`}
            </button>
          ))}
        </div>
      </div>

      {error && <div className="inspector-error">{error}</div>}
    </aside>
  );
}

// ============================================================================
// VideoProcessorInspector — for the videoProcessor node (a clipped derivative asset). Lets the
// user rename, switch strategy (re-runs ffmpeg in place via reclip), bind to shots, and delete
// the derivative. The source asset stays untouched.
// ============================================================================

function VideoProcessorInspector({ asset, sourceAsset, session, onMutated, onDeleteCanvasAsset, onClose }: {
  asset: Asset;
  sourceAsset?: Asset;
  session?: SessionWithShots;
  onMutated: () => Promise<void> | void;
  onDeleteCanvasAsset?: (asset: Asset) => Promise<boolean> | boolean;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState<"" | "save" | "reclip" | "bind" | "delete">("");
  const [error, setError] = useState<string>("");
  const [name, setName] = useState(asset.name);

  useEffect(() => {
    setName(asset.name);
    setError("");
  }, [asset.id]);

  const saveName = async () => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === asset.name) return;
    setBusy("save"); setError("");
    try {
      await api.saveAsset({ id: asset.id, name: trimmed });
      await onMutated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally { setBusy(""); }
  };

  const reclip = async (strategy: "sample-concat" | "trim" | "speedup") => {
    if (asset.clipStrategy === strategy) return;
    setBusy("reclip"); setError("");
    try {
      await api.reclipReferenceVideo(asset.id, strategy);
      await onMutated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "重新裁剪失败");
    } finally { setBusy(""); }
  };

  const removeDerivative = async () => {
    if (!confirm(`删除剪裁节点 "${asset.name}"？源参考视频 ${sourceAsset?.name || ""} 不受影响，可用撤销恢复。`)) return;
    setBusy("delete"); setError("");
    try {
      if (onDeleteCanvasAsset) {
        const deleted = await onDeleteCanvasAsset(asset);
        if (!deleted) return;
        await onMutated();
      } else {
        await api.deleteAsset(asset.id);
        await onMutated();
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "删除失败");
    } finally { setBusy(""); }
  };

  const sortedShots = (session?.shots || []).slice().sort((a, b) => a.index - b.index);

  return (
    <aside className="inspector">
      <header>
        <span className="inspector-tag">视频处理</span>
        <button onClick={onClose} className="inspector-close">×</button>
      </header>
      <div className="inspector-section">
        <label>
          名称
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={saveName}
            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
            disabled={busy === "save"}
            placeholder="视频处理节点名称"
          />
        </label>
        {sourceAsset && (
          <small className="inspector-hint">
            源：<strong>{sourceAsset.name}</strong>
          </small>
        )}
      </div>

      <div className="inspector-section">
        <strong>15s 裁剪策略</strong>
        {asset.originalDurationSec !== undefined && asset.clipDurationSec !== undefined && (
          <div className="inspector-hint">
            原片 {asset.originalDurationSec.toFixed(1)}s → 当前产出 <strong>{asset.clipDurationSec.toFixed(1)}s</strong>
          </div>
        )}
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {([
            { id: "sample-concat", label: "多段拼接", hint: "4 段 ×3s 时序采样" },
            { id: "trim", label: "截前 15s", hint: "原速运动,丢后段" },
            { id: "speedup", label: "整体加速", hint: "全帧覆盖,运动加快" }
          ] as const).map((opt) => {
            const active = asset.clipStrategy === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                disabled={Boolean(busy) || active}
                onClick={() => reclip(opt.id)}
                title={opt.hint}
                className={active ? "primary" : ""}
              >
                {busy === "reclip" && !active ? "..." : opt.label}{active && " ✓"}
              </button>
            );
          })}
        </div>
      </div>

      {(asset.mediaUrl || asset.imageUrl) && (
        <details className="inspector-fold" open>
          <summary>裁剪结果预览</summary>
          <ZoomablePreview
            url={api.assetStreamUrl(asset.id, asset.generatedAt || asset.updatedAt || asset.id)}
            mediaKind="video"
            title={asset.name}
            downloadUrl={api.downloadAssetUrl(asset.id)}
            downloadFilename={`${asset.name}.mp4`}
            generatedAt={asset.generatedAt}
            generatedLabel="处理时间"
            fallbackAt={asset.createdAt}
            fallbackLabel="创建时间"
          />
        </details>
      )}

      <div className="inspector-section">
        <strong>绑定到分镜</strong>
        <div className="inspector-hint">把本剪裁节点作为 Seedance reference_video 喂给某个分镜。一个分镜同时只能绑一个参考视频。</div>
        {!sortedShots.length ? (
          <div className="inspector-empty">本 session 还没有分镜。</div>
        ) : (
          <div className="ref-bind-list">
            {sortedShots.map((s) => {
              const bound = s.referenceVideoAssetId === asset.id;
              return (
                <label key={s.id} className={`ref-bind-row ${bound ? "active" : ""}`}>
                  <input
                    type="checkbox"
                    checked={bound}
                    disabled={Boolean(busy)}
                    onChange={async () => {
                      setBusy("bind"); setError("");
                      try {
                        await api.updateShot(s.id, {
                          referenceVideoAssetId: bound ? "" : asset.id,
                          ...(bound ? {} : {
                            firstFrameAssetId: "",
                            lastFrameAssetId: "",
                            referenceVideoFromShotId: "",
                            referenceClipUrl: null,
                            referenceAudioUrl: null,
                            subShotPanelCount: 0,
                            subShotStoryboardAssetId: "",
                            subShotStoryboardAssetIds: [],
                            usePreviousShotClip: false
                          })
                        });
                        await onMutated();
                      } catch (err) {
                        setError(err instanceof Error ? err.message : "绑定失败");
                      } finally { setBusy(""); }
                    }}
                  />
                  <span><strong>Shot {s.index}</strong> {s.title || ""}</span>
                  {bound && <span className="ref-bind-badge">已绑定</span>}
                </label>
              );
            })}
          </div>
        )}
      </div>

      <div className="inspector-actions">
        <button onClick={removeDerivative} disabled={Boolean(busy)} className="danger">
          {busy === "delete" ? "..." : "删除剪裁节点"}
        </button>
      </div>

      {error && <div className="inspector-error">{error}</div>}
    </aside>
  );
}
