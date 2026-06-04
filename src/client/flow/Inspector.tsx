import { useEffect, useRef, useState } from "react";
import type { Asset, AssetImageModel, Shot, SessionWithShots, StitchJob, ImageReviewVerdict, VideoReviewVerdict } from "../../shared/types";
import { api } from "../api";
import type { FlowNodeData } from "./buildGraph";
import { emitDownloadToast } from "./nodes";
import { Lightbox } from "./Lightbox";
import { MentionTextarea, type MentionOption } from "./MentionTextarea";
import { usePendingGenerationActions } from "./PendingGenerations";
import { useI18n } from "../i18n";

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
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  generatedLabel = generatedLabel === "生成时间" ? t.inspector.generatedAt : generatedLabel;
  fallbackLabel = fallbackLabel === "创建时间" ? t.inspector.createdAt : fallbackLabel;
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
        title={t.inspector.openFullSize}
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

function normalizeReviewPrompt(value?: string | null) {
  return (value || "").replace(/\s+/g, " ").trim();
}

function reviewPromptChanged(builtForPrompt: string | undefined, currentPrompt: string | undefined) {
  if (!builtForPrompt) return false;
  return normalizeReviewPrompt(builtForPrompt) !== normalizeReviewPrompt(currentPrompt);
}

function formatMediaTime(value?: string) {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toLocaleString();
}

function formatActualImageModel(asset?: { generationModelActual?: string; generationCredentialSource?: string }) {
  const actual = asset?.generationModelActual;
  if (!actual) return undefined;
  const source = asset.generationCredentialSource === "agent-plan" ? " / Agent Plan" : "";
  if (actual.includes("seedream-5.0-lite") || actual.includes("seedream-5-lite")) return `Seedream 5 Lite${source} (${actual})`;
  if (actual.includes("seedream-4-5")) return `Seedream 4.5 (${actual})`;
  if (actual.includes("seedream-4-0") || actual.includes("seedream-4")) return `Seedream 4 (${actual})`;
  return actual;
}

function effectiveAssetGenerateModel(asset: Asset, fallback?: AssetImageModel): AssetImageModel {
  const actual = asset.generationModelActual;
  if (actual?.includes("seedream-5.0-lite") || actual?.includes("seedream-5-lite")) return "seedream-5-lite";
  if (actual?.includes("seedream-4-5")) return "seedream-4-5";
  if (actual?.includes("seedream-4-0") || actual?.includes("seedream-4")) return "seedream-4";
  return asset.generationModel || fallback || "seedream-4-5";
}

type ReviewSummarySource = {
  verdict?: VideoReviewVerdict | ImageReviewVerdict;
  status?: string;
  error?: string;
  reviewNote?: string;
  label: string;
};

function latestReviewNoteReasons(reviewNote?: string) {
  if (!reviewNote) return [];
  const attempts = reviewNote
    .split("\n")
    .map((line) => line.match(/^attempt\s+(\d+):\s*(.*)$/i))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .map((match) => ({
      attempt: Number(match[1]),
      reasons: match[2].split(";").map((item) => item.trim()).filter(Boolean)
    }))
    .filter((item) => Number.isFinite(item.attempt) && item.reasons.length);
  return attempts.sort((a, b) => b.attempt - a.attempt)[0]?.reasons || [];
}

function ReviewSummaryCard({ verdict, status, error, reviewNote, label }: ReviewSummarySource) {
  const { t } = useI18n();
  const noteReasons = latestReviewNoteReasons(reviewNote);
  if (status === "running") {
    return (
      <div className="inspector-review-summary is-running">
        <div className="inspector-review-summary-head">
          <strong>{label}</strong>
          <span>{t.inspector.reviewing}</span>
        </div>
        <p>{t.inspector.reviewRunningText}</p>
      </div>
    );
  }
  if (status === "error") {
    return (
      <div className="inspector-review-summary is-fail">
        <div className="inspector-review-summary-head">
          <strong>{label}</strong>
          <span>{t.inspector.reviewFailed}</span>
        </div>
        <p>{error || t.errors.unknown}</p>
      </div>
    );
  }
  if (!verdict && noteReasons.length === 0) return null;

  const pass = verdict?.ok;
  const reasons = verdict
    ? [...verdict.fatalIssues, ...verdict.reasons].filter(Boolean).slice(0, 3)
    : noteReasons.slice(0, 3);
  const fixes = verdict?.fixes.map((fix) => [
    fix.shot ? t.inspector.shotPrefix(fix.shot) : "",
    fix.frame ? t.inspector.framePrefix(fix.frame) : "",
    fix.action
  ].filter(Boolean).join("：")).filter(Boolean).slice(0, 3) || [];
  const reviewedAt = verdict?.reviewedAt ? formatMediaTime(verdict.reviewedAt) : undefined;

  return (
    <div className={`inspector-review-summary ${pass ? "is-pass" : "is-fail"}`}>
      <div className="inspector-review-summary-head">
        <strong>{label}</strong>
        <span>{verdict ? `${pass ? t.inspector.pass : t.inspector.needsFix} · ${Math.round(verdict.score)}` : t.inspector.selfReviewIssue}</span>
      </div>
      {verdict?.summary ? <p>{verdict.summary}</p> : <p>{t.inspector.selfReviewIssueText}</p>}
      {reasons.length > 0 && (
        <div>
          <small>{t.inspector.mainIssues}</small>
          <ul>{reasons.map((item, i) => <li key={i}>{item}</li>)}</ul>
        </div>
      )}
      {fixes.length > 0 ? (
        <div>
          <small>{t.inspector.suggestedFixes}</small>
          <ul>{fixes.map((item, i) => <li key={i}>{item}</li>)}</ul>
        </div>
      ) : !pass && reasons.length > 0 ? (
        <div>
          <small>{t.inspector.suggestedFixes}</small>
          <ul>
            <li>{t.inspector.addIssuesToPrompt}</li>
            <li>{t.inspector.reconnectReferences}</li>
          </ul>
        </div>
      ) : null}
      {(verdict?.model || reviewedAt) && (
        <div className="inspector-review-summary-meta">
          {verdict?.model}{verdict?.model && reviewedAt ? " · " : ""}{reviewedAt}
        </div>
      )}
    </div>
  );
}

function VideoReviewCard({ verdict, status, error, stale, staleMessage }: {
  verdict?: VideoReviewVerdict;
  status?: string;
  error?: string;
  stale?: boolean;
  staleMessage?: string;
}) {
  const { t } = useI18n();
  if (status === "running") return <div className="inspector-review-card">{t.inspector.videoReviewRunning}</div>;
  if (status === "error") return <div className="inspector-error">{t.inspector.videoReviewFailed(error || t.errors.unknown)}</div>;
  if (!verdict) return <div className="inspector-hint">{t.inspector.videoReviewEmpty}</div>;
  const pass = verdict.ok;
  return (
    <div className="inspector-review-card">
      <div className="inspector-review-head">
        <strong className={pass ? "review-score-pass" : "review-score-fail"}>
          {pass ? t.inspector.pass : t.inspector.needsFix} · {Math.round(verdict.score)}
        </strong>
        <span>{verdict.model} · {new Date(verdict.reviewedAt).toLocaleString()} · {t.inspector.frameCount(verdict.frameCount)}</span>
      </div>
      {stale && <div className="inspector-review-fatal">{staleMessage || t.inspector.reviewPromptStale}</div>}
      {verdict.summary && <p>{verdict.summary}</p>}
      {verdict.fatalIssues.length > 0 && (
        <div className="inspector-review-fatal">
          <strong>{t.inspector.fatalIssues}</strong>
          <ul>{verdict.fatalIssues.map((item, i) => <li key={i}>{item}</li>)}</ul>
        </div>
      )}
      {verdict.reasons.length > 0 && (
        <details className="inspector-fold" open>
          <summary>{t.inspector.reasons}</summary>
          <ul>{verdict.reasons.map((item, i) => <li key={i}>{item}</li>)}</ul>
        </details>
      )}
      {verdict.fixes.length > 0 && (
        <details className="inspector-fold" open>
          <summary>{t.inspector.fixes}</summary>
          <ul>{verdict.fixes.map((fix, i) => <li key={i}>{fix.shot ? `${t.inspector.shotPrefix(fix.shot)}：` : ""}{fix.frame ? `${t.inspector.framePrefix(fix.frame)}：` : ""}{fix.action}</li>)}</ul>
        </details>
      )}
      {verdict.criteria.length > 0 && (
        <details className="inspector-fold">
          <summary>{t.inspector.criteria}</summary>
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
          <summary>{t.inspector.rawVlmJson}</summary>
          <pre className="inspector-pre">{verdict.rawText}</pre>
        </details>
      )}
    </div>
  );
}

function ImageReviewCard({ verdict, status, error, stale }: {
  verdict?: ImageReviewVerdict;
  status?: string;
  error?: string;
  stale?: boolean;
}) {
  const { t } = useI18n();
  if (status === "running") return <div className="inspector-review-card">{t.inspector.imageReviewRunning}</div>;
  if (status === "error") return <div className="inspector-error">{t.inspector.imageReviewFailed(error || t.errors.unknown)}</div>;
  if (!verdict) return <div className="inspector-hint">{t.inspector.imageReviewEmpty}</div>;
  const pass = verdict.ok;
  return (
    <div className="inspector-review-card">
      <div className="inspector-review-head">
        <strong className={pass ? "review-score-pass" : "review-score-fail"}>
          {pass ? t.inspector.pass : t.inspector.needsFix} · {Math.round(verdict.score)}
        </strong>
        <span>{verdict.model} · {new Date(verdict.reviewedAt).toLocaleString()}</span>
      </div>
      {stale && <div className="inspector-review-fatal">{t.inspector.reviewPromptStale}</div>}
      {verdict.summary && <p>{verdict.summary}</p>}
      {verdict.fatalIssues.length > 0 && (
        <div className="inspector-review-fatal">
          <strong>{t.inspector.fatalIssues}</strong>
          <ul>{verdict.fatalIssues.map((item, i) => <li key={i}>{item}</li>)}</ul>
        </div>
      )}
      {verdict.reasons.length > 0 && (
        <details className="inspector-fold" open>
          <summary>{t.inspector.reasons}</summary>
          <ul>{verdict.reasons.map((item, i) => <li key={i}>{item}</li>)}</ul>
        </details>
      )}
      {verdict.fixes.length > 0 && (
        <details className="inspector-fold" open>
          <summary>{t.inspector.fixes}</summary>
          <ul>{verdict.fixes.map((fix, i) => <li key={i}>{fix.action}</li>)}</ul>
        </details>
      )}
      {verdict.criteria.length > 0 && (
        <details className="inspector-fold">
          <summary>{t.inspector.criteria}</summary>
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
          <summary>{t.inspector.rawVlmJson}</summary>
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
  defaultImageModel?: AssetImageModel;
  onMutated: () => Promise<void> | void;
  onSetStitchOrder: (jobId: string, shotIds: string[], legacy?: boolean) => Promise<void> | void;
  onDeleteCanvasAsset?: (asset: Asset) => Promise<boolean> | boolean;
  onDeleteCanvasShot?: (shot: Shot) => Promise<boolean> | boolean;
  onClose: () => void;
}

export function Inspector({ selected, session, allAssets, visionReviewEnabled, defaultImageModel, onMutated, onSetStitchOrder, onDeleteCanvasAsset, onDeleteCanvasShot, onClose }: InspectorProps) {
  if (!selected) return null;
  if (selected.kind === "asset") {
    return <AssetInspector asset={selected.asset} session={session} allAssets={allAssets} onMutated={onMutated} onDeleteCanvasAsset={onDeleteCanvasAsset} onClose={onClose} visionReviewEnabled={visionReviewEnabled} defaultImageModel={defaultImageModel} />;
  }
  if (selected.kind === "storyboard") {
    return <StoryboardInspector shot={selected.shot} asset={selected.asset} session={session} allAssets={allAssets} onMutated={onMutated} onClose={onClose} />;
  }
  if (selected.kind === "shot") {
    return <ShotInspector shot={selected.shot} session={session} allAssets={allAssets} onMutated={onMutated} onDeleteCanvasShot={onDeleteCanvasShot} onClose={onClose} visionReviewEnabled={visionReviewEnabled} />;
  }
  if (selected.kind === "stitch") {
    return <StitchInspector session={selected.session} job={selected.job} legacy={selected.legacy} onMutated={onMutated} onSetStitchOrder={onSetStitchOrder} onClose={onClose} />;
  }
  if (selected.kind === "referenceVideo") {
    return <ReferenceVideoInspector asset={selected.asset} session={session} onMutated={onMutated} onDeleteCanvasAsset={onDeleteCanvasAsset} onClose={onClose} />;
  }
  if (selected.kind === "videoProcessor") {
    return <VideoProcessorInspector asset={selected.asset} sourceAsset={selected.sourceAsset} session={session} onMutated={onMutated} onDeleteCanvasAsset={onDeleteCanvasAsset} onClose={onClose} />;
  }
  if (selected.kind === "tailframe") {
    return <AssetInspector asset={selected.asset} session={session} allAssets={allAssets} onMutated={onMutated} onDeleteCanvasAsset={onDeleteCanvasAsset} onClose={onClose} visionReviewEnabled={visionReviewEnabled} defaultImageModel={defaultImageModel} />;
  }
  return null;
}

// ============================================================================
// Asset inspector
// ============================================================================

function AssetInspector({ asset, onMutated, onDeleteCanvasAsset, onClose, visionReviewEnabled, defaultImageModel }: {
  asset: Asset;
  session?: SessionWithShots;
  allAssets: Asset[];
  visionReviewEnabled: boolean;
  onMutated: () => Promise<void> | void;
  onDeleteCanvasAsset?: (asset: Asset) => Promise<boolean> | boolean;
  onClose: () => void;
  defaultImageModel?: AssetImageModel;
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
  const { t } = useI18n();

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
        setError(err instanceof Error ? err.message : t.inspector.autoSaveFailed);
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

  const imageReviewStale = reviewPromptChanged(
    asset.imageReviewBuiltForPrompt,
    asset.composedPrompt || prompt || description || name
  );

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
      setError(err instanceof Error ? err.message : t.inspector.previewFailed);
    } finally { setBusy(""); }
  };

  const regenerate = async () => {
    setBusy("generate"); setError("");
    // Same fix here: flush before kicking off Seedream so the server has latest text.
    try {
      await flushPendingSave();
    } catch (err) {
      setBusy("");
      setError(err instanceof Error ? err.message : t.inspector.saveFailed);
      return;
    }
    // Free the local Inspector busy state immediately so the user can navigate to other nodes /
    // edit other inspectors / kick off a parallel generation. The Seedream call continues in the
    // background; the canvas-level "生成中" overlay (driven by usePendingGeneration) shows the
    // user that this node is still working even after they leave its Inspector.
    setBusy("");
    void pending.run(asset.id, async () => {
      try {
        await api.generateAsset(asset.id, effectiveAssetGenerateModel(asset, defaultImageModel), {
          visionReview: visionReviewEnabled && asset.vlmReviewEnabled !== false,
          composedPrompt: composedDraft || undefined
        });
        await onMutated();
      } catch (err) {
        // Surface error via a window event so a transient banner can pick it up; the original
        // Inspector may already be unmounted by the time the request resolves.
        const msg = err instanceof Error ? err.message : t.inspector.generateFailed;
        if (typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent<string>("flow-download", { detail: t.inspector.assetGenerateFailedToast(asset.name, msg) }));
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
      setError(err instanceof Error ? err.message : t.inspector.vlmScoreFailed);
      await onMutated();
    } finally { setBusy(""); }
  };

  return (
    <aside className="inspector">
      <header>
        <span className="inspector-tag">{t.inspector.assetTag(asset.type)}</span>
        <button onClick={onClose} className="inspector-close" title={t.inspector.close}>×</button>
      </header>
      <label>{t.inspector.name}<input value={name} onChange={(e) => setName(e.target.value)} /></label>

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
          <strong>{t.inspector.myDescription}</strong>
          <small>{t.inspector.assetDescriptionHint(t.inspector.assetTypeName(asset.type))}</small>
        </div>
        <textarea
          rows={6}
          value={prompt}
          onChange={(e) => handlePromptChange(e.target.value)}
          placeholder={asset.type === "character"
            ? t.inspector.promptPlaceholderCharacter
            : t.inspector.promptPlaceholderScene}
        />
      </div>

      <div className="inspector-stage">
        <div className="inspector-stage-head">
          <span className="inspector-stage-num">②</span>
          <strong>{t.inspector.promptExpanded}</strong>
          <small>{t.inspector.promptExpandedHint}</small>
        </div>
        <textarea
          rows={10}
          value={composedDraft}
          onChange={(e) => setComposedDraft(e.target.value)}
          placeholder={t.inspector.composedPlaceholder}
        />
        <div className="inspector-stage-hint">
          {composedDraft ? t.inspector.composedReady : t.inspector.composedMissing}
        </div>
      </div>

      <label className="vision-review-toggle" title={t.inspector.vlmImageToggleTitle}>
        <input
          type="checkbox"
          checked={asset.vlmReviewEnabled !== false}
          onChange={async (e) => {
            await api.saveAsset({ id: asset.id, vlmReviewEnabled: e.target.checked });
            await onMutated();
          }}
        />
        {t.inspector.vlmImageToggle}
      </label>

      <div className="inspector-actions">
        <button onClick={previewSeedreamPrompt} disabled={Boolean(busy)} title={t.inspector.expandPromptTitle}>
          {busy === "preview" ? "..." : t.inspector.expandPrompt}
        </button>
        <button onClick={regenerate} disabled={Boolean(busy)} className="primary" title={t.inspector.generateImageTitle}>
          {busy === "generate" ? "..." : t.inspector.generateImage}
        </button>
        <button onClick={reviewAssetImage} disabled={Boolean(busy) || !assetPreviewUrl(asset)} title={t.inspector.vlmScoreTitle}>
          {busy === "review" ? "..." : t.inspector.vlmScore}
        </button>
        <button
          onClick={async () => {
            if (!window.confirm(t.inspector.deleteAssetConfirm(asset.name || asset.id))) return;
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
              setError(err instanceof Error ? err.message : t.inspector.deleteFailed);
            } finally { setBusy(""); }
          }}
          disabled={Boolean(busy)}
          className="danger"
          title={t.inspector.deleteAssetTitle}
        >
          {busy === "delete" ? "..." : t.inspector.delete}
        </button>
        <span className="inspector-save-status" data-status={saveStatus}>
          {saveStatus === "saved" && t.inspector.saved}
          {saveStatus === "saving" && t.inspector.saving}
          {saveStatus === "dirty" && t.inspector.dirty}
        </span>
      </div>
      {assetPreviewUrl(asset) && (
        <a
          className="inspector-download"
          href={api.downloadAssetUrl(asset.id)}
          download={`${asset.name}.png`}
          onClick={() => emitDownloadToast(`${asset.name}.png`)}
        >
          {t.inspector.downloadOriginalImage}
        </a>
      )}
      {assetPreviewUrl(asset) && (
        <details className="inspector-fold" open>
          <summary>{t.inspector.currentImagePreview}</summary>
          <ZoomablePreview
            url={assetPreviewUrl(asset) as string}
            mediaKind="image"
            title={asset.name}
            downloadUrl={api.downloadAssetUrl(asset.id)}
            downloadFilename={`${asset.name}.png`}
            generatedAt={asset.generatedAt}
            generatedLabel={t.inspector.imageGeneratedAt}
            fallbackAt={asset.createdAt}
            fallbackLabel={t.inspector.createdAt}
          />
        </details>
      )}
      <details className="inspector-fold" open>
        <summary>{t.inspector.vlmImageScore}</summary>
        <ReviewSummaryCard
          label={t.inspector.latestImageReview}
          verdict={asset.imageReview}
          status={asset.imageReviewStatus}
          error={asset.imageReviewError}
          reviewNote={asset.reviewNote}
        />
        <ImageReviewCard
          verdict={asset.imageReview}
          status={asset.imageReviewStatus}
          error={asset.imageReviewError}
          stale={imageReviewStale}
        />
      </details>
      <details className="inspector-fold">
        <summary>{t.inspector.moreMetadata}</summary>
        {formatActualImageModel(asset) && (
          <div className="inspector-hint">{t.inspector.actualModel(formatActualImageModel(asset) as string)}</div>
        )}
        <label>{t.inspector.rawNote}
          <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
      </details>
      {asset.composedPrompt && (
        <details className="inspector-fold">
          <summary>{t.inspector.lastPromptAudit}</summary>
          <pre className="inspector-pre">{asset.composedPrompt}</pre>
        </details>
      )}
      {asset.reviewNote && (
        <details className="inspector-fold">
          <summary>{t.inspector.retryLog(asset.reviewAttempts ?? 0)}</summary>
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

function StoryboardInspector({ shot, asset, session, allAssets, onMutated, onClose }: {
  shot: Shot;
  asset?: Asset;
  session?: SessionWithShots;
  allAssets: Asset[];
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
  const { t } = useI18n();
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
      setError(err instanceof Error ? err.message : t.inspector.previewFailed);
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
        const msg = err instanceof Error ? err.message : t.inspector.imageGenerateFailed;
        if (typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent<string>("flow-download", { detail: t.inspector.storyboardGenerateFailed(shot.index, msg) }));
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
        <span className="inspector-tag">{t.inspector.storyboardTag(shot.index)}</span>
        <button onClick={onClose} className="inspector-close" title={t.inspector.close}>×</button>
      </header>
      <label>{t.inspector.storyboardSceneLabel}
        <MentionTextarea
          rows={8}
          value={scenePrompt}
          onChange={setScenePrompt}
          options={buildStoryboardMentionOptions(shot, allAssets, session)}
          placeholder={t.inspector.storyboardScenePlaceholder}
        />
      </label>
      <div className="inspector-hint">
        {t.inspector.storyboardAutoLayout(panelCount, layout.replace("x", "×"))}
      </div>

      <label className="inspector-row" style={{ alignItems: "flex-start", gap: 8 }}>
        <input
          type="checkbox"
          checked={sequentialMode}
          onChange={(e) => setSequentialMode(e.target.checked)}
          style={{ marginTop: 4 }}
        />
        <span>
          <strong>{t.inspector.storyboardSequential}</strong>
          <small style={{ display: "block", color: "var(--muted, #888)", marginTop: 2 }}>
            {t.inspector.storyboardSequentialHint(panelCount)}
          </small>
        </span>
      </label>

      <div className="inspector-section">
        <strong>{t.inspector.referenceAssets}</strong>
        <div className="inspector-hint">{t.inspector.referenceAssetsHint}</div>
        <div className="inspector-ref-list">
          {anchorCandidates.length === 0 && <div className="inspector-empty">{t.inspector.noReferenceAssets}</div>}
          {anchorCandidates.map((a) => {
            const checked = refIds.includes(a.id);
            const thumb = a.mediaUrl || a.imageUrl || a.referenceImageUrl;
            return (
              <label key={a.id} className={`inspector-ref-item ${checked ? "active" : ""}`}>
                <input type="checkbox" checked={checked} onChange={() => toggleRef(a.id)} />
                {thumb ? <img src={thumb} alt={a.name} /> : <div className="inspector-ref-empty">{t.inspector.noImage}</div>}
                <div className="inspector-ref-meta">
                  <strong>{a.name}</strong>
                  <small>{a.type}</small>
                </div>
              </label>
            );
          })}
        </div>
        {referenceAssets.length > 0 && (
          <div className="inspector-hint">{t.inspector.selectedReferenceImages(referenceAssets.length, referenceAssets.map((a) => a.name).join("、"))}</div>
        )}
      </div>

      <details className="inspector-fold" open={Boolean(composedDraft)}>
        <summary>{t.inspector.seedreamFinalPrompt}</summary>
        <textarea rows={10} value={composedDraft} onChange={(e) => setComposedDraft(e.target.value)} placeholder={t.inspector.previewComposePlaceholder} />
        <div className="inspector-hint">{t.inspector.defaultComposeHint}</div>
      </details>

      <div className="inspector-actions">
        <button onClick={previewSeedreamGrid} disabled={Boolean(busy)}>
          {busy === "preview" ? "..." : t.inspector.previewCompose}
        </button>
        <button onClick={regenerate} disabled={Boolean(busy)} className="primary">
          {busy === "generate" ? "..." : asset ? t.inspector.regenerateImage : t.inspector.generateStoryboard}
        </button>
      </div>
      {asset && assetPreviewUrl(asset) && (
        <a
          className="inspector-download"
          href={api.downloadAssetUrl(asset.id)}
          download={`storyboard-${shot.title || `shot-${shot.index}`}.png`}
          onClick={() => emitDownloadToast(`storyboard-${shot.title || `shot-${shot.index}`}.png`)}
        >
          {t.inspector.downloadStoryboard}
        </a>
      )}
      {asset && assetPreviewUrl(asset) && (
        <details className="inspector-fold" open>
          <summary>{t.inspector.currentStoryboardPreview}</summary>
          <ZoomablePreview
            url={assetPreviewUrl(asset) as string}
            mediaKind="image"
            title={t.inspector.storyboardTitle(shot.title || `Shot ${shot.index}`)}
            downloadUrl={api.downloadAssetUrl(asset.id)}
            downloadFilename={`storyboard-${shot.title || `shot-${shot.index}`}.png`}
            generatedAt={asset.generatedAt}
            generatedLabel={t.inspector.storyboardGeneratedAt}
            fallbackAt={asset.createdAt}
            fallbackLabel={t.inspector.createdAt}
          />
        </details>
      )}

      {asset?.composedPrompt && (
        <details className="inspector-fold">
          <summary>{t.inspector.lastPromptAudit}{formatActualImageModel(asset) ? ` · ${formatActualImageModel(asset)}` : ""}</summary>
          <pre className="inspector-pre">{asset.composedPrompt}</pre>
        </details>
      )}
      {asset?.referenceImageUrls?.length ? (
        <details className="inspector-fold">
          <summary>{t.inspector.lastReferenceImages(asset.referenceImageUrls.length)}</summary>
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
  const { lang, t } = useI18n();
  const tr = (zh: string, en: string) => (lang === "en" ? en : zh);
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
  const inFlightPromptEdited = Boolean(
    pendingRender?.editedRawPrompt
    || pendingRender?.editedPrompt
    || pendingRender?.editedComposedPrompt
  );
  const currentVideoReady = Boolean(shot.videoUrl) && !generating;
  const latestRenderForReview = (shot.renders || []).find((r) => r.videoUrl === shot.videoUrl || r.remoteVideoUrl === shot.videoUrl);
  const latestVideoReview = latestRenderForReview?.videoReview || shot.videoReview;
  const latestVideoReviewStatus = latestRenderForReview?.videoReviewStatus || shot.videoReviewStatus;
  const latestVideoReviewError = latestRenderForReview?.videoReviewError || shot.videoReviewError;
  const latestReviewNote = latestRenderForReview?.reviewNote;
  const latestVideoReviewBuiltForPrompt = latestRenderForReview?.videoReviewBuiltForPrompt || shot.videoReviewBuiltForPrompt;
  const latestRenderPrompt = latestRenderForReview?.editedComposedPrompt || latestRenderForReview?.editedRawPrompt || latestRenderForReview?.editedPrompt || latestRenderForReview?.composedPrompt || latestRenderForReview?.rawPrompt || latestRenderForReview?.prompt || "";
  const latestRenderRawPrompt = latestRenderForReview?.editedRawPrompt || latestRenderForReview?.rawPrompt || latestRenderForReview?.prompt || "";
  const currentShotPromptEdited = latestRenderForReview
    ? normalizeReviewPrompt(rawPrompt) !== normalizeReviewPrompt(latestRenderRawPrompt)
    : false;
  const latestVideoReviewStale =
    reviewPromptChanged(latestVideoReviewBuiltForPrompt, latestRenderPrompt) || currentShotPromptEdited;

  return (
    <aside className="inspector">
      <header>
        <span className="inspector-tag">{tr("视频", "Video")} · Shot {shot.index}</span>
        <button onClick={onClose} className="inspector-close" title={t.inspector.close}>×</button>
      </header>
      <label>{tr("分镜名称", "Shot name")}
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
          <strong>{tr("⚠️ 参考视频超过 Seedance 15.2s 上限", "⚠️ Reference video exceeds Seedance's 15.2s limit")}</strong>
          <div className="inspector-hint">
            {tr("绑定的参考视频时长超出限制,Seedance 拒绝了上次提交。点下面的按钮会:产出一个截前 15s 的派生剪裁节点,并把本分镜的参考视频切到新派生上。原参考视频不动。", "The bound reference video is too long and Seedance rejected the last submission. The button below creates a derived first-15s clip and switches this shot to that derivative. The original reference video is untouched.")}
          </div>
          <div className="inspector-actions">
            <button onClick={deriveAndSwitch} disabled={Boolean(busy)} className="primary">
              {busy === "derive-switch" ? "..." : tr("派生 15s 剪裁版并切换", "Derive 15s clip and switch")}
            </button>
          </div>
          <details className="inspector-fold">
            <summary>{tr("原始错误", "Raw error")}</summary>
            <pre style={{ whiteSpace: "pre-wrap", fontSize: 11 }}>{shot.error}</pre>
          </details>
        </div>
      )}
      <label>{tr("场景描述 / 6 字段动作 prompt", "Scene description / 6-field action prompt")}
        <MentionTextarea
          value={rawPrompt}
          onChange={setRawPrompt}
          rows={10}
          options={buildShotMentionOptions(shot, allAssets, session)}
          placeholder={(lang === "en" ? [
            "Write the action prompt for this shot.",
            "Tip: image assets connected to the Shot are automatically used as Seedance reference images; a reference video must be @-mentioned in the prompt to be sent as reference_video.",
            "First/last-frame or storyboard mode overrides ordinary reference images. Type @ to choose assets / reference videos / storyboards."
          ] : [
            "写这一镜的动作 prompt。",
            "提示: 连到 Shot 的图片资产会自动作为 Seedance 参考图; 参考视频需要在 prompt 里 @ 它才会作为 reference_video 传入。",
            "启用首尾帧或分镜板模式时,普通参考图会被覆盖。输入 @ 可选择资产 / 参考视频 / 分镜板。"
          ]).join("\n")}
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
      {generating && (
        <div className="inspector-hint">
          {inFlightPromptEdited
            ? tr("已保存生成中的 prompt 修改；当前已提交任务不变，VLM 审核和后续自动重试会使用新 prompt。", "In-flight prompt edits saved. The already-submitted task is unchanged; VLM review and later auto-retry will use the new prompt.")
            : tr("生成中也可以继续改 prompt 并保存；当前已提交任务不变，保存后 VLM 审核和后续自动重试会使用新 prompt。", "You can keep editing and saving the prompt while generating. The already-submitted task is unchanged; after saving, VLM review and later auto-retry will use the new prompt.")}
        </div>
      )}
      <div className="inspector-row">
        <label>{tr("时长 (秒)", "Duration (sec)")}<input type="number" min={1} max={15} value={durationSec} onChange={(e) => setDurationSec(Number(e.target.value) || 12)} /></label>
        <label>{tr("状态", "Status")}<input value={status} disabled /></label>
      </div>
      <div className="inspector-section">
        <label className="vision-review-toggle" title={tr("勾选后，这个视频用 first_frame / last_frame 模式；不勾选则走默认参考图 / 参考视频模式。", "When checked, this video uses first_frame / last_frame mode; unchecked uses default reference-image / reference-video mode.")}>
          <input
            type="checkbox"
            checked={firstLastModeEnabled}
            disabled={Boolean(busy)}
            onChange={(e) => { void updateFirstLastFrameMode(e.target.checked); }}
          />
          {tr("使用首尾帧模式（不勾选=默认参考图/参考视频）", "Use first/last-frame mode (unchecked = default references)")}
        </label>
        {firstLastModeEnabled && (
          <div className="inspector-row">
            <label>{tr("首帧参考", "First-frame reference")}
              <select
                value={shot.firstFrameAssetId || ""}
                disabled={Boolean(busy)}
                onChange={(e) => { void updateFrameAnchor("firstFrameAssetId", e.target.value); }}
              >
                <option value="">{tr("未选择", "None")}</option>
                {frameCandidates.map((asset) => (
                  <option key={asset.id} value={asset.id}>{asset.name}</option>
                ))}
              </select>
            </label>
            <label>{tr("尾帧参考", "Last-frame reference")}
              <select
                value={shot.lastFrameAssetId || ""}
                disabled={Boolean(busy)}
                onChange={(e) => { void updateFrameAnchor("lastFrameAssetId", e.target.value); }}
              >
                <option value="">{tr("未选择", "None")}</option>
                {frameCandidates.map((asset) => (
                  <option key={asset.id} value={asset.id}>{asset.name}</option>
                ))}
              </select>
            </label>
          </div>
        )}
        <div className="inspector-hint">
          {tr("连接进这个视频节点的尾帧/帧锚点会出现在候选里；拖尾帧节点到视频节点会自动设为首帧。", "Tail-frame/frame-anchor nodes connected to this video appear as candidates; dragging a tail-frame node to a video node sets it as the first-frame reference.")}
        </div>
      </div>
      <label className="vision-review-toggle" title={tr("勾选后，这个视频节点参与 VLM 审核；审核失败可一键修当前/前序依赖 prompt。", "When checked, this video node participates in VLM review; failed review can repair current/upstream prompts.")}>
        <input
          type="checkbox"
          checked={shot.vlmReviewEnabled !== false}
          onChange={async (e) => {
            await api.updateShot(shot.id, { vlmReviewEnabled: e.target.checked });
            await onMutated();
          }}
        />
        {tr("VLM 审核此节点", "VLM review this node")}
      </label>
      <ReviewSummaryCard
        label={tr("最近一次 VLM 审片", "Latest VLM video review")}
        verdict={latestVideoReview}
        status={latestVideoReviewStatus}
        error={latestVideoReviewError}
        reviewNote={latestReviewNote}
      />
      <details className="inspector-fold" open={Boolean(composedDraft) || composedDraftStale}>
        <summary>
          {tr("送给 Seedance 的最终 prompt（草稿，可改）", "Final prompt sent to Seedance (draft, editable)")}
          {composedDraftStale && <span className="inspector-stale-tag">{tr("⚠ 与 #1 不同步", "⚠ Out of sync with #1")}</span>}
        </summary>
        {composedDraftStale && (
          <div className="inspector-stale-warn">
            <span>
              {tr("你改了上面的「场景描述」，但这份组装结果还是旧版本——下次「出片」会用这份旧的 text 内容。（@-mention 的参考图 / 视频按 #1 实时生效，只有文字描述部分会沿用旧版本。）", "You changed the scene description above, but this composition is still the old version. The next generation will use this old text. @-mentioned image/video references still update from #1; only the written description remains old.")}
            </span>
            <div className="inspector-stale-actions">
              <button
                onClick={previewSeedancePrompt}
                disabled={Boolean(busy)}
                title={tr("按当前 #1 重新组装一份新的 #2", "Recompose a new #2 from the current #1")}
              >
                {busy === "preview" ? "..." : tr("重新组装", "Recompose")}
              </button>
              <button
                onClick={() => {
                  setComposedDraft("");
                  setComposedDraftBasis(rawPrompt);
                }}
                title={tr("清空 #2，下次出片让 server 自动按 #1 现场组装", "Clear #2; next generation lets the server compose from #1 automatically")}
              >
                {tr("清空 #2（走自动）", "Clear #2 (auto)")}
              </button>
            </div>
          </div>
        )}
        <textarea rows={12} value={composedDraft} onChange={(e) => setComposedDraft(e.target.value)} placeholder={tr("点「预览组装」拉取一份完整的中文组装结果，再改", "Click “Preview composition” to fetch a complete composed result, then edit it")} />
        <div className="inspector-hint">
          {generating
            ? tr("空表示走默认组装；非空则保存后用于本轮 VLM 审核 / 自动重试，以及下次手动出片", "Empty means default composition; non-empty text is used after saving for this run's VLM review / auto-retry and the next manual generation")
            : tr("空表示走默认组装；非空则下次「出片」原样使用这一份", "Empty means default composition; non-empty means the next generation uses this text verbatim")}
        </div>
      </details>
      <div className="inspector-actions">
        <button onClick={previewSeedancePrompt} disabled={Boolean(busy)}>
          {busy === "preview" ? "..." : t.inspector.previewCompose}
        </button>
        <button onClick={save} disabled={Boolean(busy)}>
          {busy === "save" ? "..." : generating ? tr("保存生成中修改", "Save in-flight edits") : tr("保存", "Save")}
        </button>
        <button onClick={regenerate} disabled={Boolean(busy) || generating} className="primary">
          {busy === "generate" || generating ? t.nodes.generating + "..." : shot.videoUrl ? tr("重生", "Regenerate") : tr("出片", "Generate video")}
        </button>
        <button onClick={reviewShot} disabled={Boolean(busy) || generating || !shot.videoUrl}>
          {busy === "review" ? tr("审片中...", "Reviewing...") : tr("VLM 审片", "VLM review")}
        </button>
        <button
          onClick={async () => {
            setBusy("review"); setError("");
            try {
              await api.repairShotPromptsFromReview(shot.id);
              await onMutated();
            } catch (err) { setError(err instanceof Error ? err.message : tr("修 prompt 失败", "Prompt repair failed")); }
            finally { setBusy(""); }
          }}
          disabled={Boolean(busy) || generating || !(shot.videoReview || (shot.renders || []).some((r) => r.videoReview))}
        >
          {tr("修 Prompt", "Repair prompt")}
        </button>
        {/*
         * Explicit "delete shot" button. Canvas-keyboard delete (Delete / Backspace) also works,
         * but the Inspector button keeps destructive intent discoverable and mirrors the same
         * generating-shot guard as the canvas path.
         */}
        <button
          onClick={async () => {
            if (shot.status === "generating") {
              window.alert(tr("该分镜正在生成中，完成或取消后再删除。", "This shot is generating. Delete it after it completes or is cancelled."));
              return;
            }
            if (!window.confirm(tr(`删除「${shot.title || `Shot ${shot.index}`}」？删除后可在画布顶部「↶ 撤销」恢复。`, `Delete “${shot.title || `Shot ${shot.index}`}”? You can restore it with “↶ Undo” in the canvas toolbar.`))) return;
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
              setError(err instanceof Error ? err.message : t.inspector.deleteFailed);
            } finally { setBusy(""); }
          }}
          disabled={Boolean(busy) || shot.status === "generating"}
          className="danger"
          title={shot.status === "generating" ? tr("生成中不能删除，先取消或等完成", "Cannot delete while generating; cancel or wait for completion") : tr("删除这一镜（可撤销）", "Delete this shot (undoable)")}
        >
          {busy === "delete-render" ? "..." : t.inspector.delete}
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
          title={tr("为这个 shot 启用「分镜板」工作流：打开后画布会出现一个空白分镜板节点，点开能编辑参数 + 出图", "Enable the storyboard workflow for this shot: an empty storyboard node appears on the canvas; open it to edit parameters and generate")}
        >
          {tr("+ 启用分镜板（3×3）", "+ Enable storyboard (3×3)")}
        </button>
      )}
      {currentVideoReady && (
        <a
          className="inspector-download"
          href={api.downloadShotUrl(shot.id)}
          download={`${shot.title || `shot-${shot.index}`}.mp4`}
          onClick={() => emitDownloadToast(`${shot.title || `shot-${shot.index}`}.mp4`)}
        >
          {tr("⬇ 下载本镜 mp4", "⬇ Download this shot mp4")}
        </a>
      )}
      {currentVideoReady && (
        <button
          className="ghost-action"
          onClick={createTailframe}
          disabled={Boolean(busy)}
          title={tr("从当前视频最后一帧抽图，生成一个可拖线连接到后续视频的尾帧节点", "Extract the current video's final frame and create a tail-frame node that can connect to later videos")}
        >
          {busy === "tailframe" ? "..." : tr("+ 生成尾帧节点", "+ Generate tail-frame node")}
        </button>
      )}
      {latestTailframe && assetPreviewUrl(latestTailframe) && (
        <details className="inspector-fold">
          <summary>{tr("最近尾帧节点预览", "Latest tail-frame node preview")}</summary>
          <ZoomablePreview
            url={assetPreviewUrl(latestTailframe) as string}
            mediaKind="image"
            title={latestTailframe.name}
            downloadUrl={api.downloadAssetUrl(latestTailframe.id)}
            downloadFilename={`${latestTailframe.name}.png`}
            generatedAt={latestTailframe.generatedAt}
            generatedLabel={tr("尾帧生成时间", "Tail frame generated at")}
            fallbackAt={latestTailframe.createdAt}
            fallbackLabel={t.inspector.createdAt}
          />
          <div className="inspector-hint">{tr("画布上可把这个尾帧节点拖线连接到后续视频节点，作为该视频的首帧参考。", "On the canvas, drag this tail-frame node to a later video node to use it as that video's first-frame reference.")}</div>
        </details>
      )}
      {generating ? (
        <details className="inspector-fold" open>
          <summary>{tr("当前视频（点开放大播放）", "Current video (click to enlarge)")}</summary>
          <div className="inspector-generating-preview" role="status" aria-live="polite">
            <span className="flow-empty-spinner" aria-hidden />
            <strong>{generatingLabel}…</strong>
            {generatingElapsed && <small>{t.nodes.elapsed(generatingElapsed)}</small>}
            {shot.videoUrl && <p>{tr("新视频还没完成，暂不显示旧视频，避免误判新旧结果。", "The new video is not ready yet, so the old video is hidden to avoid confusing old and new results.")}</p>}
          </div>
        </details>
      ) : currentVideoReady ? (
        <details className="inspector-fold" open>
          <summary>{tr("当前视频（点开放大播放）", "Current video (click to enlarge)")}</summary>
          <ZoomablePreview
            url={api.shotStreamUrl(shot.id, videoCacheKey)}
            mediaKind="video"
            title={`${shot.title || `Shot ${shot.index}`} · ${t.nodes.video}`}
            downloadUrl={api.downloadShotUrl(shot.id)}
            downloadFilename={`${shot.title || `shot-${shot.index}`}.mp4`}
            generatedAt={currentRender?.videoGeneratedAt || shot.videoGeneratedAt}
            generatedLabel={tr("视频生成时间", "Video generated at")}
            fallbackAt={currentRender?.createdAt}
            fallbackLabel={tr("提交时间", "Submitted at")}
          />
        </details>
      ) : null}
      {currentVideoReady && (() => {
        return (
          <details className="inspector-fold" open>
            <summary>{tr("VLM 审片结果", "VLM video review result")}</summary>
            <VideoReviewCard
              verdict={latestVideoReview}
              status={latestVideoReviewStatus}
              error={latestVideoReviewError}
              stale={latestVideoReviewStale}
            />
          </details>
        );
      })()}
      {(() => {
        const latestRender = (shot.renders || []).find((r) => r.videoUrl === shot.videoUrl || r.remoteVideoUrl === shot.videoUrl);
        if (generating || !latestRender?.composedPrompt) return null;
        return (
          <details className="inspector-fold">
            <summary>{t.inspector.lastPromptAudit}</summary>
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
          if (!window.confirm(tr("用这个历史版本覆盖当前结果？\n（当前 videoUrl 仍保留在历史里，可随时再切回。）", "Restore this history version as the current result?\nThe current videoUrl stays in history and can be switched back later."))) return;
          setBusy("restore"); setError("");
          try {
            await api.restoreShotRender(shot.id, renderId);
            await onMutated();
          } catch (err) {
            setError(err instanceof Error ? err.message : tr("恢复失败", "Restore failed"));
          } finally { setBusy(""); }
        };
        const deleteRender = async (renderId: string) => {
          if (!window.confirm(tr("删除这一条历史版本？此操作不可撤销。", "Delete this history version? This cannot be undone."))) return;
          setBusy("delete-render"); setError("");
          try {
            await api.deleteShotRender(shot.id, renderId);
            await onMutated();
          } catch (err) {
            setError(err instanceof Error ? err.message : t.inspector.deleteFailed);
          } finally { setBusy(""); }
        };
        return (
          <details className="inspector-fold">
            <summary>{tr("历史版本", "History")}（{visible.length}{hiddenFailedCount && !showFailedHistory ? ` · ${tr("隐藏失败", "hidden failed")} ${hiddenFailedCount}` : ""}）</summary>
            {hiddenFailedCount > 0 && (
              <label className="inspector-hint" style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
                <input
                  type="checkbox"
                  checked={showFailedHistory}
                  onChange={(e) => setShowFailedHistory(e.target.checked)}
                />
                {tr("显示失败/未完成的记录", "Show failed/incomplete records")}
              </label>
            )}
            {visible.length === 0 && (
              <div className="inspector-hint">{tr("暂无历史版本。", "No history versions yet.")}</div>
            )}
            {visible.map((render) => {
              const tsSource = render.videoGeneratedAt || render.createdAt;
              const ts = formatMediaTime(tsSource) || "";
              const tsLabel = render.videoGeneratedAt ? tr("生成时间", "Generated at") : tr("提交时间", "Submitted at");
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
                      title={`${shot.title || `Shot ${shot.index}`} · ${ts || tr("历史版本", "History version")}`}
                      downloadUrl={api.downloadShotUrl(shot.id)}
                      downloadFilename={`${shot.title || `shot-${shot.index}`}-${render.id}.mp4`}
                      generatedAt={render.videoGeneratedAt}
                      generatedLabel={tr("生成时间", "Generated at")}
                      fallbackAt={render.createdAt}
                      fallbackLabel={tr("提交时间", "Submitted at")}
                    />
                  )}
                  {render.composedPrompt && (
                    <details>
                      <summary>{tr("查看送出的 prompt", "View submitted prompt")}</summary>
                      <pre className="inspector-pre">{render.composedPrompt}</pre>
                    </details>
                  )}
                  {(render.videoReview || render.videoReviewStatus || render.videoReviewError) && (
                    <details>
                      <summary>{tr("VLM 审片", "VLM review")}</summary>
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
                        title={tr("把这一条历史版本切换为当前结果", "Switch this history version to the current result")}
                      >
                        {busy === "restore" ? "..." : tr("恢复此版本", "Restore this version")}
                      </button>
                    )}
                    <button
                      type="button"
                      className="ghost-action"
                      onClick={() => deleteRender(render.id)}
                      disabled={Boolean(busy)}
                    >
                      {busy === "delete-render" ? "..." : t.inspector.delete}
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

function StitchInspector({ session, job, legacy, onMutated, onSetStitchOrder, onClose }: {
  session: SessionWithShots;
  job: StitchJob;
  legacy?: boolean;
  onMutated: () => Promise<void> | void;
  onSetStitchOrder: (jobId: string, shotIds: string[], legacy?: boolean) => Promise<void> | void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState<"" | "stitch" | "review" | "repair" | "order">("");
  const [error, setError] = useState<string>("");
  const { lang, t } = useI18n();
  const tr = (zh: string, en: string) => (lang === "en" ? en : zh);

  const orderedShots = (session.shots || []).slice().sort((a, b) => a.index - b.index);
  const shotById = new Map(orderedShots.map((shot) => [shot.id, shot]));
  const explicitIds = job.shotIds || [];
  const explicitMode = explicitIds.length > 0;
  const missingShotIds = explicitMode ? explicitIds.filter((id) => !shotById.has(id)) : [];
  const stitchShots = explicitMode
    ? explicitIds.map((id) => shotById.get(id)).filter((s): s is Shot => Boolean(s))
    : orderedShots;
  const defaultReady = orderedShots.length > 0 && orderedShots.every((s) => s.videoUrl);
  const explicitReady = explicitMode && !missingShotIds.length && stitchShots.length > 0 && stitchShots.every((s) => s.videoUrl);
  const canStitch = explicitMode ? explicitReady : defaultReady;
  const isStitching = job.status === "running";
  const finalCacheKey = job.finalVideoGeneratedAt || job.finalVideoUrl || job.finalVideoSignature || job.updatedAt;
  const jobId = legacy ? undefined : job.id;
  const title = job.name || t.nodes.fullVideo;

  const saveOrder = async (nextIds: string[]) => {
    setBusy("order"); setError("");
    onSetStitchOrder(job.id, nextIds, legacy);
    try {
      if (job.id.startsWith("stitch_pending")) return;
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
    } catch (err) { setError(err instanceof Error ? err.message : tr("保存拼接顺序失败", "Failed to save stitch order")); }
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
    } catch (err) { setError(err instanceof Error ? err.message : tr("拼接失败", "Stitch failed")); }
    finally { setBusy(""); }
  };

  const reviewFinal = async () => {
    setBusy("review"); setError("");
    try {
      await api.reviewFinalVideo(session.id, jobId);
      await onMutated();
    } catch (err) { setError(err instanceof Error ? err.message : tr("VLM 终审失败", "Final VLM review failed")); }
    finally { setBusy(""); }
  };

  const repairFinalPrompts = async () => {
    setBusy("repair"); setError("");
    try {
      await api.repairFinalPromptsFromReview(session.id, jobId);
      await onMutated();
    } catch (err) { setError(err instanceof Error ? err.message : tr("终审修 Prompt 失败", "Final-review prompt repair failed")); }
    finally { setBusy(""); }
  };

  return (
    <aside className="inspector">
      <header>
        <span className="inspector-tag">{t.nodes.stitch} · {title}</span>
        <button onClick={onClose} className="inspector-close" title={t.inspector.close}>×</button>
      </header>
      <div className="inspector-section">
        <div>{tr(`共 ${session.shots?.length || 0} 个分镜，目标 ${session.targetDurationSec}s。`, `${session.shots?.length || 0} shots · target ${session.targetDurationSec}s.`)}</div>
        <div className="inspector-hint">
          {explicitMode ? tr("将按连接到这个拼接节点的顺序合成视频。", "The video will be stitched in the order connected to this stitch node.") : tr("未连接视频时，将按分镜顺序拼接全片。", "With no connected videos, the full film is stitched by shot order.")}
        </div>
      </div>
      <div className="inspector-section">
        <strong>{tr("拼接顺序", "Stitch order")}</strong>
        {!explicitMode ? (
          <>
            <div className="inspector-hint">{tr("拖拽视频节点连接到这个拼接节点即可自定义顺序。多个拼接节点互不影响。", "Drag video nodes into this stitch node to customize order. Multiple stitch nodes are independent.")}</div>
            {missingShotIds.length > 0 && (
              <div className="inspector-error">
                {tr(`存在 ${missingShotIds.length} 个失效镜头引用：${missingShotIds.join(", ")}`, `${missingShotIds.length} invalid shot references: ${missingShotIds.join(", ")}`)}
                <button
                  type="button"
                  className="ghost-action"
                  onClick={() => saveOrder(explicitIds.filter((id) => !missingShotIds.includes(id)))}
                  disabled={Boolean(busy)}
                >
                  {tr("移除失效引用", "Remove invalid references")}
                </button>
              </div>
            )}
            <button
              type="button"
              className="ghost-action"
              onClick={() => saveOrder(orderedShots.map((s) => s.id))}
              disabled={Boolean(busy) || orderedShots.length === 0}
            >
              {tr("用当前分镜建立顺序", "Build order from current shots")}
            </button>
          </>
        ) : (
          <div className="inspector-history-list">
            {missingShotIds.length > 0 && (
              <div className="inspector-error">
                {tr(`存在 ${missingShotIds.length} 个失效镜头引用：${missingShotIds.join(", ")}`, `${missingShotIds.length} invalid shot references: ${missingShotIds.join(", ")}`)}
                <button
                  type="button"
                  className="ghost-action"
                  onClick={() => saveOrder(explicitIds.filter((id) => !missingShotIds.includes(id)))}
                  disabled={Boolean(busy)}
                >
                  {tr("移除失效引用", "Remove invalid references")}
                </button>
              </div>
            )}
            {explicitIds.map((shotId, index) => {
              const shot = shotById.get(shotId);
              if (!shot) {
                return (
                  <div key={`${shotId}-${index}`} className="inspector-history-item">
                    <div className="inspector-history-meta">
                      <strong>{index + 1}. {tr(`失效镜头引用：${shotId}`, `Invalid shot reference: ${shotId}`)}</strong>
                      <span className="inspector-history-status">{tr("已删除/已替换", "Deleted/replaced")}</span>
                    </div>
                    <div className="inspector-history-actions">
                      <button
                        type="button"
                        className="ghost-action"
                        onClick={() => saveOrder(explicitIds.filter((_, i) => i !== index))}
                        disabled={Boolean(busy)}
                      >
                        {tr("移除", "Remove")}
                      </button>
                    </div>
                  </div>
                );
              }
              return (
                <div key={`${shotId}-${index}`} className="inspector-history-item">
                  <div className="inspector-history-meta">
                    <strong>{index + 1}. {shot.title || `Shot ${shot.index}`}</strong>
                    <span className="inspector-history-status">{shot.videoUrl ? t.nodes.statusReady : t.nodes.notGenerated}</span>
                  </div>
                  <div className="inspector-history-actions">
                    <button type="button" onClick={() => move(index, -1)} disabled={Boolean(busy) || index === 0}>{tr("上移", "Move up")}</button>
                    <button type="button" onClick={() => move(index, 1)} disabled={Boolean(busy) || index === explicitIds.length - 1}>{tr("下移", "Move down")}</button>
                    <button
                      type="button"
                      className="ghost-action"
                      onClick={() => saveOrder(explicitIds.filter((_, i) => i !== index))}
                      disabled={Boolean(busy)}
                    >
                      {tr("移除", "Remove")}
                    </button>
                  </div>
                </div>
              );
            })}
            <div className="inspector-actions">
              <button type="button" onClick={() => saveOrder(orderedShots.map((s) => s.id))} disabled={Boolean(busy)}>
                {tr("重置为分镜顺序", "Reset to shot order")}
              </button>
              <button type="button" className="ghost-action" onClick={() => saveOrder([])} disabled={Boolean(busy)}>
                {tr("清空连接顺序", "Clear connected order")}
              </button>
            </div>
          </div>
        )}
      </div>
      <div className="inspector-actions">
        <button onClick={stitch} disabled={Boolean(busy) || !canStitch} className="primary">
          {busy === "stitch" ? "..." : explicitMode ? t.flow.stitchByConnections : (job.finalVideoUrl ? tr("重新拼接", "Restitch") : tr("按分镜顺序拼接全片", "Stitch full film by shot order"))}
        </button>
        <button onClick={reviewFinal} disabled={Boolean(busy) || !job.finalVideoUrl || isStitching}>
          {busy === "review" ? tr("终审中...", "Final reviewing...") : t.nodes.finalReview}
        </button>
        <button onClick={repairFinalPrompts} disabled={Boolean(busy) || !job.finalVideoReview}>
          {busy === "repair" ? tr("修复中...", "Repairing...") : tr("按终审修 Prompt", "Repair prompts from final review")}
        </button>
      </div>
      {!canStitch && (
        <div className="inspector-hint">
          {missingShotIds.length > 0
            ? tr("拼接顺序里有已删除/已替换的镜头引用，请先移除失效引用。", "The stitch order contains deleted/replaced shot references. Remove invalid references first.")
            : explicitMode ? tr("已连接的视频中还有未生成的镜头。", "Some connected videos have not been generated yet.") : tr("还有分镜没生成视频。", "Some shots have not generated videos yet.")}
        </div>
      )}
      {job.finalVideoUrl && !isStitching && (
        <a
          className="inspector-download"
          href={api.downloadSessionUrl(session.id, jobId)}
          download={`${session.title || session.id}-${title}.mp4`}
          onClick={() => emitDownloadToast(`${session.title || session.id}-${title}.mp4`)}
        >
          {tr("⬇ 下载完整片", "⬇ Download full film")}
        </a>
      )}
      {job.finalVideoUrl && !isStitching && (
        <details className="inspector-fold" open>
          <summary>{tr("当前完整视频（点开放大播放）", "Current full video (click to enlarge)")}</summary>
          <ZoomablePreview
            url={api.sessionStreamUrl(session.id, finalCacheKey, jobId)}
            mediaKind="video"
            title={`${session.title} · ${title}`}
            downloadUrl={api.downloadSessionUrl(session.id, jobId)}
            downloadFilename={`${session.title || session.id}-${title}.mp4`}
            generatedAt={job.finalVideoGeneratedAt}
            generatedLabel={tr("最终视频生成时间", "Final video generated at")}
            fallbackAt={job.updatedAt}
            fallbackLabel={tr("最近拼接更新时间", "Last stitch updated at")}
          />
        </details>
      )}
      {job.finalVideoUrl && !isStitching && (
        <ReviewSummaryCard
          label={tr("最近一次 VLM 终审", "Latest final VLM review")}
          verdict={job.finalVideoReview}
          status={job.finalVideoReviewStatus}
          error={job.finalVideoReviewError}
        />
      )}
      {job.finalVideoUrl && !isStitching && (
        <details className="inspector-fold" open>
          <summary>{tr("VLM 终审结果", "Final VLM review result")}</summary>
          <VideoReviewCard
            verdict={job.finalVideoReview}
            status={job.finalVideoReviewStatus}
            error={job.finalVideoReviewError}
            stale={Boolean(job.finalVideoReviewBuiltForSignature && job.finalVideoSignature && job.finalVideoReviewBuiltForSignature !== job.finalVideoSignature)}
            staleMessage={t.inspector.finalReviewStale}
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
  const { lang, t } = useI18n();
  const tr = (zh: string, en: string) => (lang === "en" ? en : zh);

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
      setError(err instanceof Error ? err.message : t.inspector.saveFailed);
    } finally { setBusy(""); }
  };

  const reclip = async (strategy: "sample-concat" | "trim" | "speedup") => {
    if (asset.clipStrategy === strategy) return;
    setBusy("reclip"); setError("");
    try {
      await api.reclipReferenceVideo(asset.id, strategy);
      await onMutated();
    } catch (err) {
      setError(err instanceof Error ? err.message : tr("重新裁剪失败", "Reclip failed"));
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
      setError(err instanceof Error ? err.message : tr("重新解析失败", "Reanalysis failed"));
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
      setError(err instanceof Error ? err.message : tr("应用失败", "Apply failed"));
    } finally { setBusy(""); }
  };

  const status = asset.parseStatus || "idle";
  const shotsForApply = (session?.shots || []).slice().sort((a, b) => a.index - b.index);

  return (
    <aside className="inspector">
      <header>
        <span className="inspector-tag">{t.nodes.referenceVideo}</span>
        <button onClick={onClose} className="inspector-close" title={t.inspector.close}>×</button>
      </header>
      <div className="inspector-section">
        <label>
          {t.inspector.name}
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={saveName}
            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
            disabled={busy === "save"}
            placeholder={t.nodes.referenceVideo}
          />
        </label>
        {asset.description && <small className="inspector-hint">{asset.description}</small>}
        <div className="inspector-hint">
          {tr("状态：", "Status: ")}
          <span style={{
            color: status === "ready" ? "#34d399" :
                   status === "parsing" ? "#60a5fa" :
                   status === "error" ? "#f87171" : "#9ca3af"
          }}>
            {status === "ready" ? t.nodes.parsedShots(asset.parsedShots?.length ?? 0) :
             status === "parsing" ? tr("解析中…可能需要 30-60 秒", "Parsing… may take 30–60 seconds") :
             status === "error" ? t.nodes.parseFailed : t.nodes.parsePending}
          </span>
        </div>
        {asset.parseError && <div className="inspector-error">{asset.parseError}</div>}
        <div className="inspector-actions">
          <button
            onClick={async () => {
              if (!window.confirm(tr(`删除参考视频「${asset.name || asset.id}」？删除后可在画布顶部「↶ 撤销」恢复。`, `Delete reference video “${asset.name || asset.id}”? You can restore it with “↶ Undo” in the canvas toolbar.`))) return;
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
                setError(err instanceof Error ? err.message : t.inspector.deleteFailed);
              } finally { setBusy(""); }
            }}
            disabled={Boolean(busy)}
            className="danger"
          >
            {busy === "delete" ? "..." : tr("删除参考视频", "Delete reference video")}
          </button>
        </div>
      </div>

      {(asset.mediaUrl || asset.imageUrl) && (
        <details className="inspector-fold" open>
          <summary>{tr("视频预览", "Video preview")}</summary>
          <ZoomablePreview
            url={api.assetStreamUrl(asset.id, asset.generatedAt || asset.updatedAt || asset.id)}
            mediaKind="video"
            title={asset.name}
            downloadUrl={api.downloadAssetUrl(asset.id)}
            downloadFilename={`${asset.name}.mp4`}
            generatedAt={asset.generatedAt}
            generatedLabel={tr("处理时间", "Processed at")}
            fallbackAt={asset.createdAt}
            fallbackLabel={tr("上传时间", "Uploaded at")}
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
          <strong>{tr("15s 裁剪策略", "15s clipping strategy")}</strong>
          <div className="inspector-hint">
            {tr(`原片 ${asset.originalDurationSec.toFixed(1)}s 超过 Seedance r2v 的 15.2s 上限，已按下面的策略压到 ≤15s。`, `Original ${asset.originalDurationSec.toFixed(1)}s exceeds Seedance r2v's 15.2s limit and has been compressed to ≤15s using the strategy below.`)}
            {asset.clipDurationSec !== undefined && (
              <> {tr("当前产出", "Current output")} <strong>{asset.clipDurationSec.toFixed(1)}s</strong>.</>
            )}
          </div>
          <div className="clip-strategy-buttons" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {([
              { id: "sample-concat", label: t.nodes.sampleConcat, hint: tr("4 段 ×3s 时序采样,覆盖全片但有硬切", "4 × 3s temporal samples, covers the full clip but has hard cuts") },
              { id: "trim", label: t.nodes.trim15, hint: tr("原速运动,丢弃后段", "Original-speed motion, discards later part") },
              { id: "speedup", label: t.nodes.speedup, hint: tr("全帧覆盖,运动会变快", "Covers all frames, motion becomes faster") }
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
            {tr("切换策略会重新 ffmpeg 处理本地原片并重新 publish 到 TOS — 处理时间 5–30 秒。已绑定本 asset 的 shot 下次出片自动用新版本。", "Switching strategy reruns ffmpeg on the local original and republishes to TOS — usually 5–30 seconds. Shots bound to this asset use the new version next time.")}
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
        <strong>{tr("用作视频参考（Seedance reference_video）", "Use as video reference (Seedance reference_video)")}</strong>
        <div className="inspector-hint">
          {tr("选一个分镜把整段参考视频喂给 Seedance — 它会参考镜头语言/光影/运镜/节奏，并按你写的新 prompt 生成主体与风格。需要 TOS 公网 URL（上传时已自动 publish）。", "Choose a shot to feed the whole reference video to Seedance. It follows motion/framing/lighting/pacing while your prompt controls subject and style. Requires a public TOS URL, auto-published on upload.")}
        </div>
        {!asset.tosObjectKey && asset.mediaUrl?.startsWith("/media/") && (
          <div className="inspector-hint" style={{ color: "#fbbf24" }}>
            {tr("⚠️ 此视频还没 publish 到公网（TOS 未配置或 publish 失败），Seedance 抓不到，绑了也无效。", "⚠️ This video is not published publicly yet (TOS missing or publish failed), so Seedance cannot fetch it even if bound.")}
          </div>
        )}
        {(() => {
          const sortedShots = (session?.shots || []).slice().sort((a, b) => a.index - b.index);
          if (!sortedShots.length) {
            return <div className="inspector-empty">{tr("本 session 还没有分镜。先点顶部「+ 分镜」加一个。", "This session has no shots yet. Click “+ Shot” at the top first.")}</div>;
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
                          setError(err instanceof Error ? err.message : tr("绑定失败", "Binding failed"));
                        } finally { setBusy(""); }
                      }}
                    />
                    <span><strong>Shot {s.index}</strong> {s.title || ""}</span>
                    {bound && <span className="ref-bind-badge">{tr("已绑定", "Bound")}</span>}
                  </label>
                );
              })}
            </div>
          );
        })()}
      </div>

      {Array.isArray(asset.parsedShots) && asset.parsedShots.length > 0 && (
        <div className="inspector-section">
          <strong>{tr(`分镜表（共 ${asset.parsedShots.length} 镜）`, `Shot table (${asset.parsedShots.length} shots)`)}</strong>
          <div className="inspector-hint">{tr("从下表挑一条 → 选「应用到 Shot N」，会把这条的画面/运镜/景别/风格组合成 6 字段 rawPrompt 写到目标分镜。", "Pick a row below and choose “Apply to Shot N”; its visual/camera/shot-size/style fields become a 6-field rawPrompt on the target shot.")}</div>
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
                  <summary>{tr("展开 prompt 字段", "Expand prompt fields")}</summary>
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
                    <option value="">{tr("应用到分镜…", "Apply to shot…")}</option>
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
          {busy === "reanalyze" ? "..." : status === "ready" ? tr("重新解析", "Reanalyze") : status === "parsing" ? tr("解析中…", "Parsing…") : tr("开始解析", "Start analysis")}
        </button>
      </div>

      {(asset.mediaUrl || asset.imageUrl) && (
        <a
          className="inspector-download"
          href={api.downloadAssetUrl(asset.id)}
          download={`${asset.name}.mp4`}
          onClick={() => emitDownloadToast(`${asset.name}.mp4`)}
        >
          {tr("⬇ 下载参考视频", "⬇ Download reference video")}
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
        <strong>{tr("派生剪裁节点", "Derive clipped node")}</strong>
        <div className="inspector-hint">
          {tr("产出一个独立的视频处理节点（不影响本 asset），默认按\"截前 15s\"剪裁。在 canvas 上拖到分镜即可作为参考视频。", "Create an independent video-processor node without changing this asset. Defaults to the first-15s trim; drag it to a shot on the canvas to use as reference video.")}
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
                  setError(err instanceof Error ? err.message : tr("派生失败", "Derive failed"));
                } finally { setBusy(""); }
              }}
            >
              {busy === "derive" ? "..." : `+ ${strat === "trim" ? t.nodes.trim15 : strat === "speedup" ? t.nodes.speedup : t.nodes.sampleConcat}`}
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
  const { lang, t } = useI18n();
  const tr = (zh: string, en: string) => (lang === "en" ? en : zh);

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
      setError(err instanceof Error ? err.message : t.inspector.saveFailed);
    } finally { setBusy(""); }
  };

  const reclip = async (strategy: "sample-concat" | "trim" | "speedup") => {
    if (asset.clipStrategy === strategy) return;
    setBusy("reclip"); setError("");
    try {
      await api.reclipReferenceVideo(asset.id, strategy);
      await onMutated();
    } catch (err) {
      setError(err instanceof Error ? err.message : tr("重新裁剪失败", "Reclip failed"));
    } finally { setBusy(""); }
  };

  const removeDerivative = async () => {
    if (!confirm(tr(`删除剪裁节点 "${asset.name}"？源参考视频 ${sourceAsset?.name || ""} 不受影响，可用撤销恢复。`, `Delete clipped node "${asset.name}"? Source reference video ${sourceAsset?.name || ""} is not affected and this can be undone.`))) return;
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
      setError(err instanceof Error ? err.message : t.inspector.deleteFailed);
    } finally { setBusy(""); }
  };

  const sortedShots = (session?.shots || []).slice().sort((a, b) => a.index - b.index);

  return (
    <aside className="inspector">
      <header>
        <span className="inspector-tag">{t.nodes.videoProcessor}</span>
        <button onClick={onClose} className="inspector-close" title={t.inspector.close}>×</button>
      </header>
      <div className="inspector-section">
        <label>
          {t.inspector.name}
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={saveName}
            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
            disabled={busy === "save"}
            placeholder={t.nodes.videoProcessor}
          />
        </label>
        {sourceAsset && (
          <small className="inspector-hint">
            {tr("源：", "Source: ")}<strong>{sourceAsset.name}</strong>
          </small>
        )}
      </div>

      <div className="inspector-section">
        <strong>{tr("15s 裁剪策略", "15s clipping strategy")}</strong>
        {asset.originalDurationSec !== undefined && asset.clipDurationSec !== undefined && (
          <div className="inspector-hint">
            {tr(`原片 ${asset.originalDurationSec.toFixed(1)}s → 当前产出 `, `Original ${asset.originalDurationSec.toFixed(1)}s → current output `)}<strong>{asset.clipDurationSec.toFixed(1)}s</strong>
          </div>
        )}
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {([
            { id: "sample-concat", label: t.nodes.sampleConcat, hint: tr("4 段 ×3s 时序采样", "4 × 3s temporal samples") },
            { id: "trim", label: t.nodes.trim15, hint: tr("原速运动,丢后段", "Original-speed motion, drops later part") },
            { id: "speedup", label: t.nodes.speedup, hint: tr("全帧覆盖,运动加快", "Covers all frames, speeds up motion") }
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
          <summary>{tr("裁剪结果预览", "Clipped result preview")}</summary>
          <ZoomablePreview
            url={api.assetStreamUrl(asset.id, asset.generatedAt || asset.updatedAt || asset.id)}
            mediaKind="video"
            title={asset.name}
            downloadUrl={api.downloadAssetUrl(asset.id)}
            downloadFilename={`${asset.name}.mp4`}
            generatedAt={asset.generatedAt}
            generatedLabel={tr("处理时间", "Processed at")}
            fallbackAt={asset.createdAt}
            fallbackLabel={t.inspector.createdAt}
          />
        </details>
      )}

      <div className="inspector-section">
        <strong>{tr("绑定到分镜", "Bind to shot")}</strong>
        <div className="inspector-hint">{tr("把本剪裁节点作为 Seedance reference_video 喂给某个分镜。一个分镜同时只能绑一个参考视频。", "Feed this clipped node to a shot as Seedance reference_video. A shot can bind only one reference video at a time.")}</div>
        {!sortedShots.length ? (
          <div className="inspector-empty">{tr("本 session 还没有分镜。", "This session has no shots yet.")}</div>
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
                        setError(err instanceof Error ? err.message : tr("绑定失败", "Binding failed"));
                      } finally { setBusy(""); }
                    }}
                  />
                  <span><strong>Shot {s.index}</strong> {s.title || ""}</span>
                  {bound && <span className="ref-bind-badge">{tr("已绑定", "Bound")}</span>}
                </label>
              );
            })}
          </div>
        )}
      </div>

      <div className="inspector-actions">
        <button onClick={removeDerivative} disabled={Boolean(busy)} className="danger">
          {busy === "delete" ? "..." : tr("删除剪裁节点", "Delete clipped node")}
        </button>
      </div>

      {error && <div className="inspector-error">{error}</div>}
    </aside>
  );
}
