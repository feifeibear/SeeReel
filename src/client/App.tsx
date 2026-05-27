import {
  Archive,
  Ban,
  BookOpen,
  ChevronDown,
  ChevronRight,
  Clapperboard,
  Download,
  FileText,
  Film,
  Globe,
  ImagePlus,
  Library,
  Loader2,
  Mic,
  Plus,
  RefreshCw,
  Save,
  Scissors,
  Sparkles,
  Subtitles,
  Trash2,
  Upload
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import type { Asset, AssetImageModel, AssetType, CreateSessionPayload, Session, Shot, ShotRender, StoreSnapshot, StoryBeat, StoryPlan } from "../shared/types";

const assetTypes: AssetType[] = ["character", "scene", "prop", "style", "other"];

const blankAsset: Partial<Asset> = {
  name: "",
  type: "character",
  mediaKind: "image",
  description: "",
  prompt: "",
  tags: []
};

const initialSession: CreateSessionPayload = {
  title: "",
  logline: "",
  style: "",
  targetDurationSec: 60,
  shotCount: 4
};

export function App() {
  const [state, setState] = useState<StoreSnapshot>({ assets: [], sessions: [], shots: [] });
  const [selectedSessionId, setSelectedSessionId] = useState<string>("");
  const [selectedShotId, setSelectedShotId] = useState<string>("");
  const [assetDraft, setAssetDraft] = useState<Partial<Asset>>(blankAsset);
  // Scope for a newly-created asset: "global" keeps it cross-session, "session" binds it to the
  // currently-open session so it gets cascade-deleted when that session is deleted. Only matters
  // for new assets (asset.id is unset); when editing an existing asset we derive scope from the
  // asset row itself.
  const [assetCreateScope, setAssetCreateScope] = useState<"global" | "session">("global");
  const [assetImageModel, setAssetImageModel] = useState<AssetImageModel>("seedream-4-5");
  const [sessionTitleDraft, setSessionTitleDraft] = useState("");
  const [showArchivedSessions, setShowArchivedSessions] = useState(false);
  const [busy, setBusy] = useState<string>("");
  const [assetGenerating, setAssetGenerating] = useState(false);
  const [error, setError] = useState<string>("");
  const [stitchStatus, setStitchStatus] = useState<{ sessionId?: string; status: "idle" | "running" | "error"; message?: string }>({
    status: "idle"
  });
  const [narrationStatus, setNarrationStatus] = useState<{ sessionId?: string; status: "idle" | "running" | "error"; message?: string }>({
    status: "idle"
  });

  const refresh = async () => {
    const next = await api.state();
    setState(next);
    setSelectedSessionId((current) =>
      current && next.sessions.some((session) => session.id === current) ? current : next.sessions[0]?.id || ""
    );
  };

  useEffect(() => {
    refresh().catch((err: Error) => setError(err.message));
  }, []);

  const sessions = state.sessions;
  const latestSession = sessions[0];
  const archivedSessions = sessions.slice(1);
  const selectedSession = sessions.find((session) => session.id === selectedSessionId);
  const shots = useMemo(
    () => state.shots.filter((shot) => shot.sessionId === selectedSessionId).sort((a, b) => a.index - b.index),
    [state.shots, selectedSessionId]
  );
  const selectedShot = shots.find((shot) => shot.id === selectedShotId) || shots[0];

  useEffect(() => {
    setSessionTitleDraft(selectedSession?.title || "");
  }, [selectedSession?.id, selectedSession?.title]);

  useEffect(() => {
    if (!selectedShotId && shots[0]) setSelectedShotId(shots[0].id);
    if (selectedShotId && shots.every((shot) => shot.id !== selectedShotId)) setSelectedShotId(shots[0]?.id || "");
  }, [shots, selectedShotId]);

  useEffect(() => {
    const generatingIds = state.shots
      .filter((shot) => hasPendingShotRender(shot) || Boolean(shot.generationTaskId))
      .map((shot) => shot.id);
    if (!generatingIds.length) return;

    const timer = window.setInterval(() => {
      generatingIds.forEach((shotId) => {
        api
          .pollShot(shotId)
          .then((shot) => {
            setState((prev) => ({ ...prev, shots: prev.shots.map((item) => (item.id === shot.id ? shot : item)) }));
          })
          .catch((err: Error) => setError(err.message));
      });
    }, 5000);

    return () => window.clearInterval(timer);
  }, [state.shots]);

  const run = async (label: string, action: () => Promise<void>, onError?: (message: string) => void) => {
    setBusy(label);
    setError("");
    try {
      await action();
    } catch (err) {
      const message = err instanceof Error ? err.message : "操作失败";
      setError(message);
      onError?.(message);
    } finally {
      setBusy("");
    }
  };

  const mergeShot = (shot: Shot) => {
    setState((prev) => ({ ...prev, shots: prev.shots.map((item) => (item.id === shot.id ? shot : item)) }));
  };

  const mergeSession = (session: Session & { shots?: Shot[] }) => {
    setState((prev) => ({
      ...prev,
      sessions: prev.sessions.map((item) => (item.id === session.id ? stripShots(session) : item))
    }));
  };

  const mergeAsset = (asset: Asset) => {
    setState((prev) => ({
      ...prev,
      assets: [asset, ...prev.assets.filter((item) => item.id !== asset.id)]
    }));
    setAssetDraft(asset);
  };

  const createSession = () =>
    run("create-session", async () => {
      const session = await api.createSession(initialSession);
      setState((prev) => ({
        ...prev,
        sessions: [stripShots(session), ...prev.sessions],
        shots: [...prev.shots, ...session.shots]
      }));
      setSelectedSessionId(session.id);
      setSelectedShotId(session.shots[0]?.id || "");
      setShowArchivedSessions(false);
    });

  // When creating a brand-new asset, fold the user-picked scope into the payload so the server
  // tags it with the right ownerSessionId. When editing an existing asset we leave scope alone —
  // changing scope on an existing asset goes through the promote button instead, which is more
  // explicit (and avoids accidental demote-to-session if the user opens a global asset while a
  // session is selected).
  const applyCreateScope = (payload: Partial<Asset>): Partial<Asset> => {
    if (payload.id) return payload;
    if (assetCreateScope === "session" && selectedSessionId) {
      return { ...payload, ownerSessionId: selectedSessionId };
    }
    return payload;
  };

  const saveAsset = () =>
    run("save-asset", async () => {
      mergeAsset(await api.saveAsset(applyCreateScope(normalizeAssetPayload(assetDraft))));
    });

  const generateAssetFromDraft = () =>
    run("asset-gen", async () => {
      setAssetGenerating(true);
      try {
        const saved = await api.saveAsset(applyCreateScope(normalizeAssetPayload(assetDraft)));
        mergeAsset(await api.generateAsset(saved.id, assetImageModel));
      } finally {
        setAssetGenerating(false);
      }
    });

  const promoteAsset = (assetId: string) =>
    run(`promote-${assetId}`, async () => {
      mergeAsset(await api.promoteAsset(assetId));
    });

  const expandAssetDraftPrompt = () =>
    run("asset-expand", async () => {
      const result = await api.expandAssetPrompt(assetDraft);
      setAssetDraft((current) => ({ ...current, prompt: result.prompt }));
    });

  const loadAssetReferenceImage = async (file?: File) => {
    if (!file) return;
    const referenceImageUrl = await readFileAsDataUrl(file);
    setAssetDraft((current) => ({
      ...current,
      referenceImageUrl,
      mediaKind: "image",
      mediaUrl: current.mediaUrl || current.imageUrl || referenceImageUrl,
      imageUrl: current.imageUrl || referenceImageUrl,
      name: current.name || file.name.replace(/\.[^.]+$/, "")
    }));
  };

  const deleteAsset = (assetId: string) =>
    run(`delete-${assetId}`, async () => {
      await api.deleteAsset(assetId);
      await refresh();
      if (assetDraft.id === assetId) setAssetDraft(blankAsset);
    });

  const deleteSession = (session: Session) => {
    const confirmed = window.confirm(`删除「${session.title}」及其全部分镜？资产库不会被删除。`);
    if (!confirmed) return;

    run(`delete-session-${session.id}`, async () => {
      await api.deleteSession(session.id);
      await refresh();
      if (selectedSessionId === session.id) setSelectedShotId("");
    });
  };

  const downloadUrl = (label: string, url: string, fallbackName: string) =>
    run(label, async () => {
      await downloadFile(url, fallbackName);
    });

  const promoteSession = (session: Session) =>
    run(`promote-session-${session.id}`, async () => {
      const updated = await api.promoteSession(session.id);
      setState((prev) => ({
        ...prev,
        sessions: [stripShots(updated), ...prev.sessions.filter((item) => item.id !== updated.id)]
      }));
      setSelectedSessionId(updated.id);
      setSelectedShotId("");
      setShowArchivedSessions(false);
    });

  const saveSessionTitle = () => {
    if (!selectedSession) return;
    const title = sessionTitleDraft.trim() || selectedSession.title;
    setSessionTitleDraft(title);
    if (title === selectedSession.title) return;

    run(`session-title-${selectedSession.id}`, async () => {
      const updated = await api.updateSession(selectedSession.id, { title });
      setState((prev) => ({
        ...prev,
        sessions: prev.sessions.map((item) => (item.id === updated.id ? stripShots(updated) : item))
      }));
      setSessionTitleDraft(updated.title);
    });
  };

  const updateShot = (shotId: string, patch: Partial<Shot>) =>
    run(`shot-${shotId}`, async () => {
      mergeShot(await api.updateShot(shotId, patch));
    });

  const generateScript = (session: Session) =>
    run("script-generate", async () => {
      mergeSession(await api.generateScript(session.id));
    });

  const saveScript = (session: Session, story: StoryPlan) =>
    run("script-save", async () => {
      mergeSession(await api.saveScript(session.id, story));
    });

  const generateStoryboard = (session: Session) =>
    run("storyboard", async () => {
      const result = await api.storyboard(session.id);
      setState((prev) => ({
        ...prev,
        sessions: prev.sessions.map((item) => (item.id === result.session.id ? stripShots(result.session) : item)),
        shots: prev.shots.map((shot) => result.shots.find((item) => item?.id === shot.id) || shot)
      }));
      setSelectedShotId(result.shots[0]?.id || selectedShotId);
    });

  const publishSessionStoryboardsToTos = (session: Session) =>
    run(`publish-session-tos-${session.id}`, async () => {
      const result = await api.publishSessionStoryboardsToTos(session.id);
      setState((prev) => ({
        ...prev,
        sessions: prev.sessions.map((item) => (item.id === result.session.id ? stripShots(result.session) : item)),
        shots: prev.shots.map((shot) => result.session.shots.find((item) => item.id === shot.id) || shot),
        assets: [
          ...result.assets,
          ...prev.assets.filter((asset) => !result.assets.some((updated) => updated.id === asset.id))
        ]
      }));
    });

  const toggleShotAsset = (shot: Shot, assetId: string) => {
    const next = shot.assetIds.includes(assetId)
      ? shot.assetIds.filter((id) => id !== assetId)
      : [...shot.assetIds, assetId];
    updateShot(shot.id, { assetIds: next });
  };

  const generateShotSketches = (shot: Shot, payload?: { prompt?: string; count?: number; model?: AssetImageModel }) =>
    run(`sketches-${shot.id}`, async () => {
      const result = await api.generateShotSketches(shot.id, payload);
      setState((prev) => ({
        ...prev,
        shots: prev.shots.map((item) => (item.id === result.shot.id ? result.shot : item)),
        assets: [
          ...result.sketches,
          ...prev.assets.filter((a) => !result.sketches.some((s) => s.id === a.id))
        ]
      }));
    });

  const importShotSketch = (shot: Shot, file?: File) =>
    run(`import-sketch-${shot.id}`, async () => {
      if (!file) return;
      const imageDataUrl = await readFileAsDataUrl(file);
      const result = await api.importShotSketch(shot.id, {
        name: file.name.replace(/\.[^.]+$/, "") || `${shot.title || `Shot ${shot.index}`} Codex 故事板`,
        prompt: shot.rawPrompt || shot.prompt,
        imageDataUrl
      });
      setState((prev) => ({
        ...prev,
        shots: prev.shots.map((item) => (item.id === result.shot.id ? result.shot : item)),
        assets: [result.sketch, ...prev.assets.filter((asset) => asset.id !== result.sketch.id)]
      }));
    });

  const deleteShotSketch = (shot: Shot, assetId: string) =>
    run(`delete-sketch-${assetId}`, async () => {
      const result = await api.deleteShotSketch(shot.id, assetId);
      setState((prev) => ({
        ...prev,
        shots: prev.shots.map((item) => (item.id === result.shot.id ? result.shot : item)),
        assets: prev.assets.filter((a) => a.id !== assetId)
      }));
    });

  const publishShotSketchToTos = (shot: Shot, assetId: string) =>
    run(`publish-sketch-${assetId}`, async () => {
      const result = await api.publishShotSketchToTos(shot.id, assetId);
      setState((prev) => ({
        ...prev,
        shots: prev.shots.map((item) => (item.id === result.shot.id ? result.shot : item)),
        assets: [result.sketch, ...prev.assets.filter((asset) => asset.id !== result.sketch.id)]
      }));
    });

  const publishShotSketchesToTos = (shot: Shot) =>
    run(`publish-sketches-tos-${shot.id}`, async () => {
      const result = await api.publishShotSketchesToTos(shot.id);
      setState((prev) => ({
        ...prev,
        shots: prev.shots.map((item) => (item.id === result.shot.id ? result.shot : item)),
        assets: [
          ...result.sketches,
          ...prev.assets.filter((asset) => !result.sketches.some((sketch) => sketch.id === asset.id))
        ]
      }));
    });

  const runNarration = (session: Session, payload: { script: string; voice: string }) =>
    run(`narrate-${session.id}`, async () => {
      setNarrationStatus({ sessionId: session.id, status: "running", message: "排队中" });
      const updated = await api.narrate(session.id, payload, (snapshot) => {
        if (snapshot.narrationStatus === "running") {
          setNarrationStatus({
            sessionId: session.id,
            status: "running",
            message: snapshot.narrationProgress || "正在生成解说"
          });
        }
      });
      setState((prev) => ({
        ...prev,
        sessions: prev.sessions.map((item) => (item.id === updated.id ? stripShots(updated) : item))
      }));
      setNarrationStatus({ sessionId: session.id, status: "idle" });
    }, (message) => setNarrationStatus({ sessionId: session.id, status: "error", message }));

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <Clapperboard size={24} />
          <div>
            <strong>reelyai-agent</strong>
            <span>AI 视频工作台</span>
          </div>
        </div>

        <section className="panel compact">
          <button data-testid="create-session" className="primary" onClick={createSession} disabled={busy === "create-session"}>
            <Plus size={16} />
            新建 Session
          </button>
        </section>

        <section className="session-dock">
          <div className="session-group-title">最新 Session</div>
          {latestSession ? (
            <SessionButton
              session={latestSession}
              active={latestSession.id === selectedSessionId}
              busy={busy === `delete-session-${latestSession.id}`}
              onSelect={() => {
                setSelectedSessionId(latestSession.id);
                setSelectedShotId("");
              }}
              onPromote={() => promoteSession(latestSession)}
              onDelete={() => deleteSession(latestSession)}
            />
          ) : (
            <div className="empty-session">还没有 session</div>
          )}

          <button
            className="archive-toggle"
            onClick={() => setShowArchivedSessions((open) => !open)}
            disabled={!archivedSessions.length}
          >
            {showArchivedSessions ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            <span>历史 Session</span>
            <small>{archivedSessions.length}</small>
          </button>

          {showArchivedSessions && archivedSessions.length > 0 && (
            <div className="session-list">
              {archivedSessions.map((session) => (
                <SessionButton
                  key={session.id}
                  session={session}
                  active={session.id === selectedSessionId}
                  busy={busy === `delete-session-${session.id}`}
                  onSelect={() => {
                    setSelectedSessionId(session.id);
                    setSelectedShotId("");
                  }}
                  onPromote={() => promoteSession(session)}
                  onDelete={() => deleteSession(session)}
                />
              ))}
            </div>
          )}
        </section>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <p>
              {selectedSession ? (selectedSession.id === latestSession?.id ? "最新 Session" : "历史 Session") : "Session"}
            </p>
            {selectedSession ? (
              <input
                aria-label="Session 名称"
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
            ) : (
              <h1>创建一个短片项目</h1>
            )}
          </div>
          <div className="top-actions">
            <button onClick={() => refresh()} title="刷新">
              <RefreshCw size={16} />
            </button>
            <button
              disabled={!selectedSession || busy === "storyboard"}
              onClick={() => selectedSession && generateStoryboard(selectedSession)}
            >
              {busy === "storyboard" ? <Loader2 className="spin" size={16} /> : <Sparkles size={16} />}
              自动分镜
            </button>
            <button
              disabled={!selectedSession || busy === `publish-session-tos-${selectedSession.id}`}
              onClick={() => selectedSession && publishSessionStoryboardsToTos(selectedSession)}
              title="上传本 session 的 Codex 故事板到火山 TOS"
            >
              {selectedSession && busy === `publish-session-tos-${selectedSession.id}` ? <Loader2 className="spin" size={16} /> : <Globe size={16} />}
              故事板 TOS
            </button>
            <button
              className="primary"
              disabled={!selectedSession || Boolean(busy)}
              onClick={() =>
                selectedSession &&
                run("stitch", async () => {
                  setStitchStatus({ sessionId: selectedSession.id, status: "running", message: "排队中" });
                  const updated = await api.stitch(selectedSession.id, (snapshot) => {
                    if (snapshot.stitchStatus === "running") {
                      setStitchStatus({
                        sessionId: selectedSession.id,
                        status: "running",
                        message: snapshot.stitchProgress || "正在拼接完整视频"
                      });
                    }
                  });
                  setState((prev) => ({
                    ...prev,
                    sessions: prev.sessions.map((item) => (item.id === updated.id ? stripShots(updated) : item))
                  }));
                  setStitchStatus({ sessionId: selectedSession.id, status: "idle" });
                }, (message) => setStitchStatus({ sessionId: selectedSession.id, status: "error", message }))
              }
            >
              <Scissors size={16} />
              拼接
            </button>
          </div>
        </header>

        {error && <div className="error">{error}</div>}

        {selectedSession && (
          <SessionFinalVideo
            session={selectedSession}
            stitchStatus={stitchStatus.sessionId === selectedSession.id ? stitchStatus : { status: "idle" }}
            downloadBusy={busy === `download-session-${selectedSession.id}`}
            onDownload={() =>
              downloadUrl(
                `download-session-${selectedSession.id}`,
                api.downloadSessionUrl(selectedSession.id),
                `${selectedSession.title || selectedSession.id}-完整视频.mp4`
              )
            }
          />
        )}

        {selectedSession && (
          <NarrationPanel
            session={selectedSession}
            busy={busy === `narrate-${selectedSession.id}`}
            narrationStatus={narrationStatus.sessionId === selectedSession.id ? narrationStatus : { status: "idle" }}
            onSubmit={(payload) => runNarration(selectedSession, payload)}
            onDownloadVideo={() =>
              downloadUrl(
                `download-narration-${selectedSession.id}`,
                api.downloadNarrationVideoUrl(selectedSession.id),
                `${selectedSession.title || selectedSession.id}-含字幕.mp4`
              )
            }
            onDownloadSubtitle={() =>
              downloadUrl(
                `download-narration-srt-${selectedSession.id}`,
                api.downloadNarrationSubtitleUrl(selectedSession.id),
                `${selectedSession.title || selectedSession.id}-字幕.srt`
              )
            }
            downloadVideoBusy={busy === `download-narration-${selectedSession.id}`}
            downloadSubtitleBusy={busy === `download-narration-srt-${selectedSession.id}`}
          />
        )}

        {selectedSession && (
          <StoryPanel
            session={selectedSession}
            busy={busy}
            onGenerate={() => generateScript(selectedSession)}
            onSave={(story) => saveScript(selectedSession, story)}
            onStoryboard={() => generateStoryboard(selectedSession)}
          />
        )}

        <div className="main-grid">
          <section className="panel shots-panel">
            <div className="panel-title">
              <Clapperboard size={18} />
              <span>分镜</span>
            </div>
            <div className="shot-strip">
              {shots.map((shot) => (
                <button
                  key={shot.id}
                  className={shot.id === selectedShot?.id ? "shot-pill active" : "shot-pill"}
                  onClick={() => setSelectedShotId(shot.id)}
                >
                  <strong>{shot.index}</strong>
                  <span>{shot.title}</span>
                  <small>{shot.status}</small>
                </button>
              ))}
            </div>

            {selectedShot ? (
              <ShotEditor
                shot={selectedShot}
                previousShot={shots.find((item) => item.index === selectedShot.index - 1)}
                assets={state.assets}
                busy={busy}
                onPatch={(patch) => updateShot(selectedShot.id, patch)}
                onGenerate={(draft) =>
                  run(`generate-${selectedShot.id}`, async () => {
                    mergeShot(await api.updateShot(selectedShot.id, draft));
                    mergeShot(await api.generateShot(selectedShot.id));
                  })
                }
                onCancelGeneration={() =>
                  run(`cancel-${selectedShot.id}`, async () => {
                    mergeShot(await api.cancelShot(selectedShot.id));
                  })
                }
                onDeleteRender={(renderId) =>
                  run(`delete-render-${renderId}`, async () => {
                    mergeShot(await api.deleteShotRender(selectedShot.id, renderId));
                  })
                }
                onDownloadShot={() =>
                  downloadUrl(
                    `download-shot-${selectedShot.id}`,
                    api.downloadShotUrl(selectedShot.id),
                    `${String(selectedShot.index).padStart(2, "0")}-${selectedShot.title || selectedShot.id}.mp4`
                  )
                }
                onGenerateSketches={(payload) => generateShotSketches(selectedShot, payload)}
                onImportSketch={(file) => importShotSketch(selectedShot, file)}
                onDeleteSketch={(assetId) => deleteShotSketch(selectedShot, assetId)}
                onPublishSketchToTos={(assetId) => publishShotSketchToTos(selectedShot, assetId)}
                onPublishSketchesToTos={() => publishShotSketchesToTos(selectedShot)}
              />
            ) : (
              <div className="empty">还没有分镜</div>
            )}
          </section>

          <section className="panel asset-panel">
            <div className="panel-title">
              <Library size={18} />
              <span>资产库</span>
              <small className="panel-note">全局资产跨 Session 复用，Session 资产随 Session 删除而清除</small>
              <button className="icon-action" onClick={() => setAssetDraft(blankAsset)} title="新资产">
                <Plus size={16} />
              </button>
            </div>

            <section className="asset-preview-shell">
              <div className="result-head">
                <div>
                  <strong>{assetDraft.id ? assetDraft.name || "未命名资产" : "参考图"}</strong>
                  {assetDraft.parentAssetId && (
                    <small className="asset-parent-line">
                      衍生自 ← {state.assets.find((item) => item.id === assetDraft.parentAssetId)?.name || "已删除资产"}
                    </small>
                  )}
                </div>
                <small>{assetDraft.id ? `${assetDraft.type || "other"} / ${assetDraft.mediaKind || "image"}` : "选择一个资产"}</small>
              </div>
              <div className="asset-preview">{assetGenerating ? <GeneratingPreview /> : renderAssetMedia(assetDraft)}</div>
            </section>

            <div className="asset-form">
              <input
                data-testid="asset-name"
                placeholder="资产名称"
                value={assetDraft.name || ""}
                onChange={(e) => setAssetDraft({ ...assetDraft, name: e.target.value })}
              />
              <select
                data-testid="asset-type"
                value={assetDraft.type || "other"}
                onChange={(e) => setAssetDraft({ ...assetDraft, type: e.target.value as AssetType })}
              >
                {assetTypes.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
              <label className="asset-reference-upload">
                参考图片
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif,image/bmp,image/tiff"
                  onChange={(event) => {
                    loadAssetReferenceImage(event.target.files?.[0]).catch((err: Error) => setError(err.message));
                    event.currentTarget.value = "";
                  }}
                />
                <small>生成资产时尽量保留原图主体、姿态、表情、色彩和构图；低清图会先增强清晰度。</small>
              </label>
              <textarea
                data-testid="asset-description"
                placeholder={assetDraft.type === "character" ? "原始 Prompt：简单写角色是谁、年龄、气质、服装、道具等" : "原始 Prompt：简单描述资产外观、材质、用途、风格"}
                rows={4}
                value={assetDraft.description || ""}
                onChange={(e) => setAssetDraft({ ...assetDraft, description: e.target.value })}
              />
              <button
                type="button"
                onClick={expandAssetDraftPrompt}
                disabled={busy === "asset-expand" || !hasAssetRawPrompt(assetDraft)}
              >
                {busy === "asset-expand" ? <Loader2 className="spin" size={16} /> : <Sparkles size={16} />}
                扩写
              </button>
              <textarea
                data-testid="asset-prompt"
                placeholder={assetDraft.type === "character" ? "扩写后 Prompt：可直接微调后生成最终角色三视图" : "扩写后 Prompt：可直接微调后生成最终资产图"}
                rows={assetDraft.type === "character" ? 9 : 6}
                value={assetDraft.prompt || ""}
                onChange={(e) => setAssetDraft({ ...assetDraft, prompt: e.target.value })}
              />
              {assetDraft.type === "character" && (
                <span className="field-hint">点击“扩写”会用 Doubao Seed 把原始 Prompt 补成同一角色正面、侧面、背面全身三视图。生图只使用扩写后 Prompt。</span>
              )}
              <label>
                父资产（可选，生图时会把父资产的图作为面孔参考）
                <select
                  value={assetDraft.parentAssetId || ""}
                  onChange={(e) => setAssetDraft({ ...assetDraft, parentAssetId: e.target.value || undefined })}
                >
                  <option value="">无（独立资产）</option>
                  {state.assets
                    .filter((asset) => asset.id !== assetDraft.id && asset.type === "character")
                    .map((asset) => (
                      <option key={asset.id} value={asset.id}>
                        {asset.name}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                生图模型
                <select value={assetImageModel} onChange={(e) => setAssetImageModel(e.target.value as AssetImageModel)}>
                  <option value="seedream-4-5">Seedream 4.5（默认）</option>
                  <option value="seedream-4">Seedream 4</option>
                  <option value="gpt-image-2">GPT Image 2</option>
                </select>
              </label>
              {!assetDraft.id && (
                <label>
                  归属范围（仅新建时可选，已存在的资产用列表里的「升为全局」按钮迁移）
                  <select
                    data-testid="asset-create-scope"
                    value={assetCreateScope}
                    onChange={(e) => setAssetCreateScope(e.target.value as "global" | "session")}
                    disabled={!selectedSession && assetCreateScope === "global"}
                  >
                    <option value="global">全局资产（所有 Session 都可 @）</option>
                    <option value="session" disabled={!selectedSession}>
                      {selectedSession
                        ? `仅本 Session 使用（删除「${selectedSession.title}」会一起清除）`
                        : "仅本 Session 使用（请先选中一个 Session）"}
                    </option>
                  </select>
                </label>
              )}
              {assetDraft.id && (
                <span className="field-hint">
                  当前作用域：
                  {assetDraft.ownerShotId
                    ? "Shot 私有素描（仅来源分镜可见，分镜删除自动清除）"
                    : assetDraft.ownerSessionId
                      ? `仅 Session 内（${
                          sessions.find((session) => session.id === assetDraft.ownerSessionId)?.title || "已删除 Session"
                        }）`
                      : "全局资产"}
                </span>
              )}
              <div className="button-row">
                <button data-testid="save-asset" className="primary" onClick={saveAsset} disabled={busy === "save-asset"}>
                  <Save size={16} />
                  保存
                </button>
                <button
                  disabled={busy === "asset-gen" || !hasAssetGenerationPrompt(assetDraft)}
                  onClick={generateAssetFromDraft}
                >
                  <ImagePlus size={16} />
                  生图
                </button>
              </div>
            </div>

            <AssetLibraryList
              allAssets={state.assets}
              activeAssetId={assetDraft.id}
              selectedSession={selectedSession}
              busy={busy}
              onSelect={(asset) => setAssetDraft(normalizeAssetForDraft(asset))}
              onDelete={deleteAsset}
              onPromote={promoteAsset}
            />
          </section>
        </div>
      </section>
    </main>
  );
}

function SessionFinalVideo({
  session,
  stitchStatus,
  downloadBusy,
  onDownload
}: {
  session: Session;
  stitchStatus: { status: "idle" | "running" | "error"; message?: string };
  downloadBusy: boolean;
  onDownload: () => void;
}) {
  if (!session.finalVideoUrl && stitchStatus.status === "idle") return null;

  return (
    <section className="panel session-output">
      <div className="result-head">
        <div>
          <strong>完整视频</strong>
          <small>{stitchStatus.status === "running" ? "正在拼接" : stitchStatus.status === "error" ? "拼接失败" : "当前 Session 的已选择分镜版本"}</small>
        </div>
        {session.finalVideoUrl && (
          <button type="button" className="result-link" onClick={onDownload} disabled={downloadBusy}>
            {downloadBusy ? <Loader2 className="spin" size={16} /> : <Download size={16} />}
            下载完整视频
          </button>
        )}
      </div>
      {stitchStatus.status === "running" ? (
        <div className="session-output-status">
          <Loader2 className="spin" size={18} />
          <span>{stitchStatus.message || "正在拼接完整视频"}</span>
        </div>
      ) : stitchStatus.status === "error" ? (
        <div className="session-output-status error-state">
          <span>{stitchStatus.message || "拼接失败"}</span>
        </div>
      ) : session.finalVideoUrl && isVideoUrl(session.finalVideoUrl) ? (
        <video controls playsInline preload="metadata" src={session.finalVideoUrl} />
      ) : (
        <span>{session.finalVideoUrl || "还没有完整视频"}</span>
      )}
    </section>
  );
}

type VoiceOption = { value: string; label: string; group: "中文" | "English" };

const VOICE_OPTIONS: VoiceOption[] = [
  { value: "zh_male_M392_conversation_wvae_bigtts", label: "男声 · 沉稳解说 (默认)", group: "中文" },
  { value: "zh_female_zhixingnvsheng_mars_bigtts", label: "女声 · 知性解说", group: "中文" },
  { value: "zh_male_beijingxiaoye_moon_bigtts", label: "男声 · 京腔旁白", group: "中文" },
  { value: "zh_male_jieshuonansheng_mars_bigtts", label: "男声 · 纪录片解说", group: "中文" },
  { value: "zh_female_shuangkuaisisi_moon_bigtts", label: "女声 · 爽快利落", group: "中文" },
  { value: "zh_female_wanwanxiaohe_moon_bigtts", label: "女声 · 温柔慢叙", group: "中文" },
  { value: "en_male_jason_conversation_wvae_bigtts", label: "Male · Documentary (default)", group: "English" },
  { value: "en_male_adam_mars_bigtts", label: "Male · Conversational", group: "English" },
  { value: "en_male_dryw_mars_bigtts", label: "Male · Warm narrator", group: "English" },
  { value: "en_male_smith_mars_bigtts", label: "Male · Newsy", group: "English" },
  { value: "en_female_anna_mars_bigtts", label: "Female · Calm", group: "English" },
  { value: "en_female_sarah_mars_bigtts", label: "Female · Bright", group: "English" }
];

function detectScriptLanguage(text: string): "en" | "zh" {
  const sample = text.slice(0, 500);
  const cjkCount = (sample.match(/[\u4e00-\u9fff]/g) || []).length;
  const latinCount = (sample.match(/[A-Za-z]/g) || []).length;
  return latinCount > cjkCount * 1.5 ? "en" : "zh";
}

function pickDefaultVoiceForScript(text: string): string {
  const lang = detectScriptLanguage(text);
  return VOICE_OPTIONS.find((opt) => (lang === "en" ? opt.group === "English" : opt.group === "中文"))!.value;
}

function NarrationPanel({
  session,
  busy,
  narrationStatus,
  onSubmit,
  onDownloadVideo,
  onDownloadSubtitle,
  downloadVideoBusy,
  downloadSubtitleBusy
}: {
  session: Session;
  busy: boolean;
  narrationStatus: { status: "idle" | "running" | "error"; message?: string };
  onSubmit: (payload: { script: string; voice: string }) => void;
  onDownloadVideo: () => void;
  onDownloadSubtitle: () => void;
  downloadVideoBusy: boolean;
  downloadSubtitleBusy: boolean;
}) {
  const initialVoice = session.narrationVoice || VOICE_OPTIONS[0].value;
  const [scriptDraft, setScriptDraft] = useState(session.narrationScript || "");
  const [voiceDraft, setVoiceDraft] = useState(initialVoice);
  // Track the script language we most recently auto-aligned the voice to. We only override the
  // voice when the *detected language flips* (e.g. 中文 → English) so that:
  //   - pasting/typing English always switches to the default English voice, even if the user had
  //     manually picked a Chinese voice before
  //   - within the same language the user can still pick a different speaker (male/female/etc.)
  //     and that choice sticks across further edits in the same language
  const [autoLang, setAutoLang] = useState<"en" | "zh" | null>(() =>
    session.narrationScript ? detectScriptLanguage(session.narrationScript) : null
  );

  useEffect(() => {
    setScriptDraft(session.narrationScript || "");
    setVoiceDraft(session.narrationVoice || VOICE_OPTIONS[0].value);
    setAutoLang(session.narrationScript ? detectScriptLanguage(session.narrationScript) : null);
  }, [session.id]);

  useEffect(() => {
    const trimmed = scriptDraft.trim();
    if (!trimmed) return;
    const lang = detectScriptLanguage(trimmed);
    if (lang === autoLang) return;
    setAutoLang(lang);
    setVoiceDraft(pickDefaultVoiceForScript(trimmed));
  }, [scriptDraft, autoLang]);

  // Show the user a one-line hint about what language we auto-detected.
  const detectedLang: "en" | "zh" | null = scriptDraft.trim() ? detectScriptLanguage(scriptDraft) : null;
  const voiceMatchesLang =
    !detectedLang || VOICE_OPTIONS.find((opt) => opt.value === voiceDraft)?.group === (detectedLang === "en" ? "English" : "中文");

  const stitchReady = Boolean(session.finalVideoUrl);
  const stale =
    Boolean(session.narrationBuiltForFinalVideoSignature) &&
    session.narrationBuiltForFinalVideoSignature !== session.finalVideoSignature;
  const disabled = !stitchReady || busy || narrationStatus.status === "running" || !scriptDraft.trim();

  const showVideo =
    Boolean(session.narrationVideoUrl) &&
    !stale &&
    narrationStatus.status !== "running" &&
    narrationStatus.status !== "error";

  const groupedVoices: Record<VoiceOption["group"], VoiceOption[]> = { 中文: [], English: [] };
  for (const opt of VOICE_OPTIONS) groupedVoices[opt.group].push(opt);

  return (
    <section className="panel narration-panel">
      <div className="result-head">
        <div>
          <strong>解说与字幕</strong>
          <small>
            {!stitchReady
              ? "请先完成「拼接」生成完整视频，再来配解说和字幕"
              : narrationStatus.status === "running"
                ? "正在合成解说与字幕"
                : narrationStatus.status === "error"
                  ? "解说生成失败"
                  : stale
                    ? "完整视频已重新拼接 — 当前解说与新视频不再匹配，请重新生成"
                    : "用脚本驱动 Doubao TTS + 自动字幕，旁白与原环境音混合。视频长度不变；若脚本过长会自动加速最高 1.3x，仍放不下则裁掉末尾几句。"}
          </small>
        </div>
        <div className="narration-actions">
          {session.narrationVideoUrl && (
            <button
              type="button"
              className="result-link"
              onClick={onDownloadVideo}
              disabled={downloadVideoBusy || stale}
              title={stale ? "完整视频已更新，请重新生成解说" : "下载含字幕视频"}
            >
              {downloadVideoBusy ? <Loader2 className="spin" size={16} /> : <Download size={16} />}
              下载 mp4
            </button>
          )}
          {session.narrationSubtitleUrl && (
            <button
              type="button"
              className="result-link"
              onClick={onDownloadSubtitle}
              disabled={downloadSubtitleBusy || stale}
              title={stale ? "完整视频已更新，请重新生成解说" : "下载字幕 srt"}
            >
              {downloadSubtitleBusy ? <Loader2 className="spin" size={16} /> : <FileText size={16} />}
              下载 srt
            </button>
          )}
        </div>
      </div>

      <div className="narration-form">
        <label className="narration-field">
          <span>
            <Subtitles size={14} /> 解说脚本（自动按 。！？/ . ! ? / 段落切句；中英文都行）
          </span>
          <textarea
            value={scriptDraft}
            onChange={(event) => setScriptDraft(event.target.value)}
            placeholder={"贴上脚本：\n  · 中文：『紫禁城的清晨笼罩在薄雾中…』\n  · English: 'Pumas are large, cat-like animals…'\n\n会自动按句切字幕；视频长度不变，旁白会自适应贴到时间轴上。"}
            rows={6}
          />
        </label>
        <label className="narration-field narration-voice">
          <span>
            <Mic size={14} /> 旁白音色
            {detectedLang && (
              <em className="lang-hint">
                {" "}
                · 检测到{detectedLang === "en" ? "英文 → 自动 English voice" : "中文 → 自动中文音色"}
                {!voiceMatchesLang && "（当前不匹配，将自动切换）"}
              </em>
            )}
          </span>
          <select value={voiceDraft} onChange={(event) => setVoiceDraft(event.target.value)}>
            {(Object.keys(groupedVoices) as Array<VoiceOption["group"]>).map((group) => (
              <optgroup key={group} label={group}>
                {groupedVoices[group].map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        <div className="narration-form-actions">
          <button
            type="button"
            className="primary"
            disabled={disabled}
            onClick={() => onSubmit({ script: scriptDraft, voice: voiceDraft })}
          >
            {busy || narrationStatus.status === "running" ? (
              <Loader2 className="spin" size={16} />
            ) : (
              <Mic size={16} />
            )}
            {session.narrationVideoUrl && !stale ? "重新生成解说+字幕" : "生成解说+字幕"}
          </button>
        </div>
      </div>

      {narrationStatus.status === "running" ? (
        <div className="session-output-status">
          <Loader2 className="spin" size={18} />
          <span>{narrationStatus.message || "正在生成解说"}</span>
        </div>
      ) : narrationStatus.status === "error" ? (
        <div className="session-output-status error-state">
          <span>{narrationStatus.message || "解说生成失败"}</span>
        </div>
      ) : showVideo && session.narrationVideoUrl && isVideoUrl(session.narrationVideoUrl) ? (
        <video controls playsInline preload="metadata" src={session.narrationVideoUrl} />
      ) : null}
    </section>
  );
}

function SessionButton({
  session,
  active,
  busy,
  onSelect,
  onPromote,
  onDelete
}: {
  session: Session;
  active: boolean;
  busy: boolean;
  onSelect: () => void;
  onPromote: () => void;
  onDelete: () => void;
}) {
  return (
    <article className="session-row">
      <button className={active ? "session active" : "session"} onClick={onSelect} onDoubleClick={onPromote}>
        <Archive size={15} />
        <span>{session.title}</span>
        <small>{formatDuration(session.targetDurationSec)}</small>
      </button>
      <button className="danger session-delete" onClick={onDelete} disabled={busy} title="删除 Session">
        {busy ? <Loader2 className="spin" size={15} /> : <Trash2 size={15} />}
      </button>
    </article>
  );
}

function StoryPanel({
  session,
  busy,
  onGenerate,
  onSave,
  onStoryboard
}: {
  session: Session;
  busy: string;
  onGenerate: () => void;
  onSave: (story: StoryPlan) => void;
  onStoryboard: () => void;
}) {
  const [open, setOpen] = useState(true);
  const [draft, setDraft] = useState<StoryPlan>(() => createStoryDraft(session));

  useEffect(() => {
    setDraft(createStoryDraft(session));
  }, [session.id, session.story]);

  const updateBeat = (index: number, patch: Partial<StoryBeat>) => {
    setDraft({
      ...draft,
      beats: draft.beats.map((beat, beatIndex) => (beatIndex === index ? { ...beat, ...patch } : beat))
    });
  };

  return (
    <section className="panel story-panel">
      <div className="panel-title story-title">
        <BookOpen size={18} />
        <span>剧本</span>
        <small className="panel-note">{draft.beats.length ? `${draft.beats.length} 个节拍` : "短片大纲 + 节拍表"}</small>
        <button type="button" className="ghost-action" onClick={() => setOpen((value) => !value)}>
          {open ? "收起" : "展开"}
        </button>
      </div>
      {open && (
        <div className="story-body">
          <div className="story-grid">
            <label>
              Premise
              <input value={draft.premise} onChange={(event) => setDraft({ ...draft, premise: event.target.value })} />
            </label>
            <label>
              Theme
              <input value={draft.theme} onChange={(event) => setDraft({ ...draft, theme: event.target.value })} />
            </label>
          </div>
          <label>
            Synopsis
            <textarea rows={4} value={draft.synopsis} onChange={(event) => setDraft({ ...draft, synopsis: event.target.value })} />
          </label>
          <label>
            Tone
            <input value={draft.tone} onChange={(event) => setDraft({ ...draft, tone: event.target.value })} />
          </label>
          <label className="story-lock">
            <input type="checkbox" checked={draft.locked} onChange={(event) => setDraft({ ...draft, locked: event.target.checked })} />
            <span>锁定剧本</span>
          </label>
          <div className="story-beats">
            {draft.beats.map((beat, index) => (
              <article key={`${beat.index}-${index}`} className="story-beat">
                <div className="story-beat-head">
                  <strong>{String(beat.index).padStart(2, "0")}</strong>
                  <input value={beat.title} onChange={(event) => updateBeat(index, { title: event.target.value })} />
                  <input
                    type="number"
                    min={1}
                    max={15}
                    value={beat.durationSec}
                    onChange={(event) => updateBeat(index, { durationSec: Number(event.target.value) })}
                  />
                </div>
                <div className="story-beat-grid">
                  <label>
                    Purpose
                    <textarea rows={2} value={beat.purpose} onChange={(event) => updateBeat(index, { purpose: event.target.value })} />
                  </label>
                  <label>
                    Emotion
                    <textarea rows={2} value={beat.emotion} onChange={(event) => updateBeat(index, { emotion: event.target.value })} />
                  </label>
                </div>
                <label>
                  Plot
                  <textarea rows={3} value={beat.plot} onChange={(event) => updateBeat(index, { plot: event.target.value })} />
                </label>
                <label>
                  Visual
                  <textarea rows={2} value={beat.visual} onChange={(event) => updateBeat(index, { visual: event.target.value })} />
                </label>
                <label>
                  Asset Mentions
                  <input
                    value={beat.assetMentions.join(" ")}
                    placeholder="@男主角/顾沉 @午夜便利店"
                    onChange={(event) => updateBeat(index, { assetMentions: splitMentionInput(event.target.value) })}
                  />
                </label>
              </article>
            ))}
          </div>
          <div className="button-row">
            <button type="button" onClick={onGenerate} disabled={busy === "script-generate"}>
              {busy === "script-generate" ? <Loader2 className="spin" size={16} /> : <Sparkles size={16} />}
              生成剧本
            </button>
            <button type="button" className="primary" onClick={() => onSave(normalizeStoryDraft(draft))} disabled={busy === "script-save"}>
              <Save size={16} />
              保存剧本
            </button>
            <button type="button" onClick={onStoryboard} disabled={busy === "storyboard" || !draft.beats.length}>
              {busy === "storyboard" ? <Loader2 className="spin" size={16} /> : <Clapperboard size={16} />}
              从剧本生成分镜
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function ShotEditor({
  shot,
  previousShot,
  assets,
  busy,
  onPatch,
  onGenerate,
  onCancelGeneration,
  onDeleteRender,
  onDownloadShot,
  onGenerateSketches,
  onImportSketch,
  onDeleteSketch,
  onPublishSketchToTos,
  onPublishSketchesToTos
}: {
  shot: Shot;
  previousShot?: Shot;
  assets: Asset[];
  busy: string;
  onPatch: (patch: Partial<Shot>) => void;
  onGenerate: (draft: Shot) => void;
  onCancelGeneration: () => void;
  onDeleteRender: (renderId: string) => void;
  onDownloadShot: () => void;
  onGenerateSketches: (payload?: { prompt?: string; count?: number; model?: AssetImageModel }) => void;
  onImportSketch: (file?: File) => void;
  onDeleteSketch: (assetId: string) => void;
  onPublishSketchToTos: (assetId: string) => void;
  onPublishSketchesToTos: () => void;
}) {
  const [draft, setDraft] = useState(shot);
  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const durationInvalid = !Number.isFinite(draft.durationSec) || draft.durationSec < 1;
  const previousContinuity = getPreviousContinuity(previousShot);
  const previousClipMaxSec = previousContinuity.durationSec;
  const previousClipSec = clampPreviousShotClipSec(
    draft.previousShotClipSecOverride ? draft.previousShotClipSec : undefined,
    previousClipMaxSec
  );
  const renders = shot.renders || [];
  const pendingRender = renders.find((render) => isPendingRender(render));
  const hasPendingRender = Boolean(pendingRender);
  const selectedRenderId = renders.find((render) => render.videoUrl === shot.videoUrl)?.id || "";
  const rawPromptValue = draft.rawPrompt ?? draft.prompt ?? "";
  // Assets visible to THIS shot = all global assets (no ownerShotId) + this shot's own private
  // sketches. Other shots' private sketches are hidden from @mention/first-frame UI.
  const visibleAssets = useMemo(
    () => assets.filter((asset) => !asset.ownerShotId || asset.ownerShotId === shot.id),
    [assets, shot.id]
  );
  const sketches = useMemo(
    () => assets.filter((asset) => asset.ownerShotId === shot.id),
    [assets, shot.id]
  );
  const sketchBusy = busy === `sketches-${shot.id}`;
  const mentionedAssets = useMemo(() => findMentionedAssets(rawPromptValue, visibleAssets), [rawPromptValue, visibleAssets]);
  const mentionOptions = useMemo(() => {
    if (!mention) return [];
    const query = normalizeMention(mention.query);
    return visibleAssets
      .filter((asset) => {
        const name = normalizeMention(formatAssetMention(asset));
        const rawName = normalizeMention(asset.name);
        return !query || name.includes(query) || rawName.includes(query);
      })
      .slice(0, 8);
  }, [visibleAssets, mention]);

  useEffect(() => setDraft(shot), [shot]);

  const selectRender = (renderId: string) => {
    const render = renders.find((item) => item.id === renderId);
    if (!render?.videoUrl) return;
    const patch: Partial<Shot> = {
      title: render.title || draft.title,
      durationSec: render.durationSec ?? draft.durationSec,
      seedanceVariant: render.seedanceVariant || inferSeedanceVariant(render.model) || draft.seedanceVariant,
      assetIds: render.assetIds || draft.assetIds,
      rawPrompt: render.rawPrompt ?? draft.rawPrompt,
      prompt: render.prompt,
      debugNote: render.note || "",
      videoUrl: render.videoUrl,
      usePreviousShotClip: render.usePreviousShotClip ?? draft.usePreviousShotClip,
      previousShotClipSec: render.previousShotClipSec ?? (draft.usePreviousShotClip ? previousClipSec : draft.previousShotClipSec),
      previousShotClipSecOverride: render.previousShotClipSecOverride ?? draft.previousShotClipSecOverride,
      referenceClipUrl: render.referenceClipUrl || null,
      referenceAudioUrl: render.referenceAudioUrl || null,
      firstFrameAssetId: render.firstFrameAssetId ?? draft.firstFrameAssetId,
      status: "ready",
      generationTaskId: null,
      generationStartedAt: null,
      error: null
    };
    setDraft({ ...draft, ...patch });
    onPatch(patch);
  };

  const updateRawPrompt = (value: string, cursor: number | null) => {
    setDraft({ ...draft, rawPrompt: value, prompt: value, assetIds: findMentionedAssets(value, visibleAssets).map((asset) => asset.id) });
    setMention(cursor === null ? null : detectMention(value, cursor));
  };

  const insertMention = (asset: Asset) => {
    if (!mention || !promptRef.current) return;
    const basePrompt = rawPromptValue;
    const cursor = promptRef.current.selectionStart ?? basePrompt.length;
    const label = `@${formatAssetMention(asset)} `;
    const nextPrompt = `${basePrompt.slice(0, mention.start)}${label}${basePrompt.slice(cursor)}`;
    const nextCursor = mention.start + label.length;
    setDraft({
      ...draft,
      rawPrompt: nextPrompt,
      prompt: nextPrompt,
      assetIds: mergeAssetIds(draft.assetIds || [], [asset.id])
    });
    setMention(null);
    window.requestAnimationFrame(() => {
      promptRef.current?.focus();
      promptRef.current?.setSelectionRange(nextCursor, nextCursor);
    });
  };

  const directPromptDraft = () => ({
    ...draft,
    previousShotClipSec: draft.usePreviousShotClip ? previousClipSec : draft.previousShotClipSec,
    previousShotClipSecOverride: draft.usePreviousShotClip ? Boolean(draft.previousShotClipSecOverride) : draft.previousShotClipSecOverride,
    rawPrompt: rawPromptValue,
    prompt: rawPromptValue,
    assetIds: mentionedAssets.map((asset) => asset.id)
  });

  return (
    <div className="shot-editor">
      <div className="shot-fields">
        <div className="shot-entry-grid">
          <label>
            分镜名
            <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
          </label>
          <label>
            秒数 *（1-15）
            <input
              type="number"
              min={1}
              max={15}
              required
              value={draft.durationSec}
              onChange={(e) => setDraft({ ...draft, durationSec: Number(e.target.value) })}
            />
          </label>
          <label>
            模型
            <select
              value={draft.seedanceVariant || "standard"}
              onChange={(e) => setDraft({ ...draft, seedanceVariant: e.target.value as Shot["seedanceVariant"] })}
            >
              <option value="standard">Seedance 2.0</option>
              <option value="fast">Seedance 2.0 Fast</option>
            </select>
          </label>
        </div>
        <label className="continuity-toggle clip-toggle">
          <input
            type="checkbox"
            checked={Boolean(draft.usePreviousShotClip)}
            disabled={draft.index <= 1 || !previousContinuity.canSubmit || Boolean(draft.firstFrameAssetId)}
            onChange={(e) =>
              setDraft({
                ...draft,
                usePreviousShotClip: e.target.checked,
                referenceClipUrl: e.target.checked ? draft.referenceClipUrl : null,
                referenceAudioUrl: e.target.checked ? draft.referenceAudioUrl : null,
                previousShotClipSec: e.target.checked ? previousClipMaxSec : draft.previousShotClipSec,
                previousShotClipSecOverride: e.target.checked ? false : draft.previousShotClipSecOverride
              })
            }
          />
          <span>
            <strong>参考上一个分镜</strong>
            <small>
              {draft.firstFrameAssetId
                ? "已启用首帧资产，与续接前镜互斥"
                : previousContinuity.message}
            </small>
          </span>
          <span className="clip-seconds">
            参考
            <input
              type="number"
              min={1}
              max={previousClipMaxSec}
              value={draft.usePreviousShotClip ? previousClipSec : previousClipMaxSec}
              disabled={!draft.usePreviousShotClip || draft.index <= 1 || !previousContinuity.canSubmit || Boolean(draft.firstFrameAssetId)}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  previousShotClipSec: clampPreviousShotClipSec(Number(e.target.value), previousClipMaxSec),
                  previousShotClipSecOverride: true
                })
              }
            />
            <small>/ {previousClipMaxSec}s</small>
          </span>
        </label>
        <FirstFrameRow
          shot={draft}
          assets={visibleAssets}
          disabled={Boolean(draft.usePreviousShotClip)}
          onChange={(assetId) =>
            setDraft({
              ...draft,
              firstFrameAssetId: assetId || undefined,
              // First-frame mode is mutually exclusive with previous-shot continuity.
              usePreviousShotClip: assetId ? false : draft.usePreviousShotClip,
              referenceClipUrl: assetId ? null : draft.referenceClipUrl,
              referenceAudioUrl: assetId ? null : draft.referenceAudioUrl
            })
          }
        />
        <ShotSketchPanel
          shot={shot}
          sketches={sketches}
          busy={sketchBusy}
          importBusy={busy === `import-sketch-${shot.id}`}
          publishBusy={busy === `publish-sketches-tos-${shot.id}`}
          publishBusyAssetId={busy.startsWith("publish-sketch-") ? busy.replace("publish-sketch-", "") : undefined}
          deleteBusyAssetId={busy.startsWith("delete-sketch-") ? busy.replace("delete-sketch-", "") : undefined}
          onGenerate={(count) => onGenerateSketches({ count })}
          onImport={onImportSketch}
          onDelete={onDeleteSketch}
          onPublish={onPublishSketchToTos}
          onPublishAll={onPublishSketchesToTos}
          onSetAsFirstFrame={(assetId) =>
            setDraft({
              ...draft,
              firstFrameAssetId: assetId,
              usePreviousShotClip: false,
              referenceClipUrl: null,
              referenceAudioUrl: null
            })
          }
        />
        <label className="prompt-entry">
          Prompt
          <small className="field-hint">写你的核心想法和 @资产；运行 Seedance 时直接使用这里的内容。</small>
          <textarea
            className="raw-prompt-textarea"
            ref={promptRef}
            rows={6}
            value={rawPromptValue}
            onBlur={() => window.setTimeout(() => setMention(null), 120)}
            onKeyUp={(e) => setMention(detectMention(e.currentTarget.value, e.currentTarget.selectionStart ?? e.currentTarget.value.length))}
            onClick={(e) => setMention(detectMention(e.currentTarget.value, e.currentTarget.selectionStart ?? e.currentTarget.value.length))}
            onChange={(e) => updateRawPrompt(e.target.value, e.target.selectionStart)}
          />
          {mention && mentionOptions.length > 0 && (
            <div className="mention-menu">
              {mentionOptions.map((asset) => (
                <button type="button" key={asset.id} onMouseDown={(event) => event.preventDefault()} onClick={() => insertMention(asset)}>
                  {renderAssetThumb(asset)}
                  <span>
                    <strong>@{formatAssetMention(asset)}</strong>
                    <small>{asset.type} / {asset.mediaKind || "image"}</small>
                  </span>
                </button>
              ))}
            </div>
          )}
          {mentionedAssets.length > 0 && (
            <div className="mentioned-assets">
              {mentionedAssets.map((asset) => (
                <span key={asset.id}>
                  @{formatAssetMention(asset)}
                </span>
              ))}
            </div>
          )}
        </label>
        <div className="button-row">
          <button className="primary" onClick={() => onPatch(directPromptDraft())} disabled={busy === `shot-${shot.id}` || durationInvalid}>
            <Save size={16} />
            保存
          </button>
          <button onClick={() => onGenerate(directPromptDraft())} disabled={busy === `generate-${shot.id}` || durationInvalid || hasPendingRender}>
            {busy === `generate-${shot.id}` ? <Loader2 className="spin" size={16} /> : <Film size={16} />}
            {hasPendingRender ? "运行中" : "运行"}
          </button>
          {hasPendingRender && (
            <button className="danger cancel-generation" onClick={onCancelGeneration} disabled={busy === `cancel-${shot.id}`}>
              {busy === `cancel-${shot.id}` ? <Loader2 className="spin" size={16} /> : <Ban size={16} />}
              取消
            </button>
          )}
        </div>
      </div>

      <div className="shot-side">
        <ShotResult
          shot={shot}
          pendingRender={pendingRender}
          onCancelGeneration={onCancelGeneration}
          cancelBusy={busy === `cancel-${shot.id}`}
          onDownload={onDownloadShot}
          downloadBusy={busy === `download-shot-${shot.id}`}
        />
        <section className="render-history" aria-label="生成历史">
          <div className="history-head">
            <strong>生成历史</strong>
            <small>{renders.length ? `${renders.length} 个版本` : "暂无历史"}</small>
          </div>
          {renders.length > 0 ? (
            <div className="history-list">
              {renders.map((render, index) => {
                const active = render.id === selectedRenderId;
                const pending = isPendingRender(render);
                const failed = render.status === "error";
                const cancelled = render.status === "cancelled";
                return (
                  <div className={["render", active ? "active" : "", pending ? "pending" : "", failed ? "failed" : "", cancelled ? "cancelled" : ""].filter(Boolean).join(" ")} key={render.id}>
                    <button className="render-select" type="button" onClick={() => selectRender(render.id)} disabled={!render.videoUrl}>
                      <span>{formatRenderLabel(render, index)}</span>
                      <small>{render.error || render.prompt}</small>
                    </button>
                    <button
                      className="danger render-delete"
                      type="button"
                      onClick={() => (pending ? onCancelGeneration() : onDeleteRender(render.id))}
                      disabled={pending ? busy === `cancel-${shot.id}` : busy === `delete-render-${render.id}`}
                      title={pending ? "取消任务" : "删除版本"}
                    >
                      {pending && busy === `cancel-${shot.id}` ? (
                        <Loader2 className="spin" size={15} />
                      ) : pending ? (
                        <Ban size={15} />
                      ) : busy === `delete-render-${render.id}` ? (
                        <Loader2 className="spin" size={15} />
                      ) : (
                        <Trash2 size={15} />
                      )}
                    </button>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="empty small">暂无生成历史</div>
          )}
        </section>
        {shot.error && <div className="error small">{shot.error}</div>}
      </div>
    </div>
  );
}

function ShotResult({
  shot,
  pendingRender,
  onCancelGeneration,
  cancelBusy,
  onDownload,
  downloadBusy
}: {
  shot: Shot;
  pendingRender?: ShotRender;
  onCancelGeneration: () => void;
  cancelBusy: boolean;
  onDownload: () => void;
  downloadBusy: boolean;
}) {
  const isVideo = shot.videoUrl ? isVideoUrl(shot.videoUrl) : false;
  const pendingTaskId = pendingRender?.generationTaskId || shot.generationTaskId;
  const generationStartedAt = pendingRender?.generationStartedAt || shot.generationStartedAt;
  const [elapsedNow, setElapsedNow] = useState(() => Date.now());

  useEffect(() => {
    if (!pendingTaskId?.startsWith("cgt-")) return;
    setElapsedNow(Date.now());
    const timer = window.setInterval(() => setElapsedNow(Date.now()), 60 * 1000);
    return () => window.clearInterval(timer);
  }, [pendingTaskId, generationStartedAt]);

  const elapsedLabel =
    pendingTaskId?.startsWith("cgt-") && generationStartedAt ? formatElapsedTime(generationStartedAt, elapsedNow) : "";

  return (
    <section className="result-panel">
      <div className="result-head">
        <strong>视频结果</strong>
        <small>{pendingRender ? "generating" : shot.videoUrl ? "ready" : shot.status}</small>
      </div>
      {shot.referenceClipUrl && (
        <div className="reference-clip-preview">
          <span>实际提交给 Seedance 的参考视频</span>
          <video muted controls playsInline preload="metadata" src={shot.referenceClipUrl} />
        </div>
      )}
      <div className="preview">
        {shot.videoUrl ? (
          isVideo ? (
            <video controls playsInline preload="metadata" src={shot.videoUrl} />
          ) : (
            <img src={shot.videoUrl} alt="shot result" />
          )
        ) : pendingRender ? (
          <span className="preview-status">
            <Loader2 className="spin" size={16} />
            视频生成中
          </span>
        ) : (
          <span>{shot.status}</span>
        )}
      </div>
      {shot.videoUrl && (
        <button type="button" className="result-link" onClick={onDownload} disabled={downloadBusy}>
          {downloadBusy ? <Loader2 className="spin" size={16} /> : <Download size={16} />}
          下载视频
        </button>
      )}
      {pendingTaskId && (
        <div className="task-line">
          <Loader2 className="spin" size={14} />
          <span>
            {pendingTaskId}
            {elapsedLabel && <em>已用 {elapsedLabel}</em>}
          </span>
          <button className="danger task-cancel" onClick={onCancelGeneration} disabled={cancelBusy} title="取消任务">
            {cancelBusy ? <Loader2 className="spin" size={14} /> : <Ban size={14} />}
          </button>
        </div>
      )}
    </section>
  );
}

function formatRenderLabel(render: ShotRender, index: number) {
  const time = new Date(render.createdAt).toLocaleString([], {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
  const duration = render.durationSec ? `${render.durationSec}s` : "--s";
  const status =
    render.status === "generating"
      ? "生成中"
      : render.status === "error"
        ? "失败"
        : render.status === "cancelled"
          ? "已取消"
          : `V${index + 1}`;
  return `${status} / ${time} / ${duration} / ${render.model}`;
}

function formatElapsedTime(startedAt: string, now: number) {
  const started = new Date(startedAt).getTime();
  if (!Number.isFinite(started)) return "";
  const elapsedMs = Math.max(0, now - started);
  const totalMinutes = Math.max(1, Math.floor(elapsedMs / 60000));
  if (totalMinutes < 60) return `${totalMinutes} 分钟`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes ? `${hours} 小时 ${minutes} 分钟` : `${hours} 小时`;
}

function isPendingRender(render: ShotRender) {
  return render.status === "generating" || Boolean(render.generationTaskId);
}

function hasPendingShotRender(shot: Shot) {
  return Boolean((shot.renders || []).some((render) => isPendingRender(render)));
}

function getPreviousContinuity(previousShot?: Shot) {
  const durationSec = getReferenceDurationSec(previousShot);
  if (!previousShot?.videoUrl) {
    return { canSubmit: false, durationSec, message: "前一个分镜生成后可用" };
  }
  const selectedRender = (previousShot.renders || []).find(
    (render) => render.videoUrl === previousShot.videoUrl || render.remoteVideoUrl === previousShot.videoUrl
  );
  const referenceUrl = [selectedRender?.remoteVideoUrl, selectedRender?.videoUrl, previousShot.videoUrl].find(isRemoteReferenceUrl);
  if (!referenceUrl) {
    return {
      canSubmit: false,
      durationSec,
      message: "Seedance 需要公网视频 URL，当前只能本地预览，不能作为 reference_video 提交"
    };
  }
  return {
    canSubmit: true,
    durationSec: getReferenceDurationSec(previousShot, selectedRender),
    message: "默认参考上一分镜完整时长；手动填写时不会超过上一分镜时长"
  };
}

function getReferenceDurationSec(previousShot?: Shot, selectedRender?: ShotRender) {
  const duration = Number(selectedRender?.durationSec ?? previousShot?.durationSec);
  if (!Number.isFinite(duration)) return 1;
  return Math.min(Math.max(Math.round(duration), 1), 15);
}

function clampPreviousShotClipSec(seconds: unknown, maxSeconds: number) {
  const max = Math.min(Math.max(Math.round(Number(maxSeconds)) || 1, 1), 15);
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return max;
  return Math.min(Math.max(Math.round(value), 1), max);
}

function isRemoteReferenceUrl(url?: string | null) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return ["http:", "https:"].includes(parsed.protocol) && !["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

function inferSeedanceVariant(model: string): Shot["seedanceVariant"] | undefined {
  const normalized = model.toLowerCase();
  if (normalized.includes("fast")) return "fast";
  if (normalized.includes("seedance")) return "standard";
  return undefined;
}

function detectMention(value: string, cursor: number) {
  const beforeCursor = value.slice(0, cursor);
  const match = beforeCursor.match(/(^|\s)@([^\s@]*)$/u);
  if (!match) return null;
  return {
    start: beforeCursor.length - match[2].length - 1,
    query: match[2]
  };
}

function formatAssetMention(asset: Pick<Asset, "name">) {
  return asset.name.replace(/\s*\/\s*/g, "/").replace(/\s+/g, "");
}

function isUsableFirstFrameAsset(asset: Asset) {
  if ((asset.mediaKind || (asset.imageUrl ? "image" : "none")) !== "image") return false;
  const url = asset.mediaUrl || asset.imageUrl;
  if (!url) return false;
  // Seedance requires a public http(s) URL for reference media (see generators.ts payload filter).
  return /^https?:\/\//.test(url) && !url.includes("placehold.co");
}

function isSeedanceReferenceAsset(asset: Asset) {
  if ((asset.mediaKind || (asset.imageUrl ? "image" : "none")) !== "image") return false;
  const url = asset.mediaUrl || asset.imageUrl;
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return ["http:", "https:"].includes(parsed.protocol) && !["localhost", "127.0.0.1", "::1"].includes(parsed.hostname) && !url.includes("placehold.co");
  } catch {
    return false;
  }
}

function ShotSketchPanel({
  shot,
  sketches,
  busy,
  importBusy,
  publishBusy,
  publishBusyAssetId,
  deleteBusyAssetId,
  onGenerate,
  onImport,
  onDelete,
  onPublish,
  onPublishAll,
  onSetAsFirstFrame
}: {
  shot: Shot;
  sketches: Asset[];
  busy: boolean;
  importBusy: boolean;
  publishBusy: boolean;
  publishBusyAssetId?: string;
  deleteBusyAssetId?: string;
  onGenerate: (count: number) => void;
  onImport: (file?: File) => void;
  onDelete: (assetId: string) => void;
  onPublish: (assetId: string) => void;
  onPublishAll: () => void;
  onSetAsFirstFrame: (assetId: string) => void;
}) {
  const localOnlySketches = sketches.filter((sketch) => !isSeedanceReferenceAsset(sketch));
  return (
    <section className="shot-sketches">
      <div className="shot-sketches-head">
        <div>
          <strong>分镜草图</strong>
          <small>仅本分镜可见，生成/导入后会作为 Seedance 参考图；删除本分镜时一并清理。</small>
        </div>
        <div className="shot-sketches-actions">
          <label className={importBusy ? "sketch-import is-busy" : "sketch-import"}>
            {importBusy ? <Loader2 className="spin" size={14} /> : <Upload size={14} />}
            导入 Codex 故事板
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              disabled={importBusy}
              onChange={(event) => {
                onImport(event.currentTarget.files?.[0]);
                event.currentTarget.value = "";
              }}
            />
          </label>
          <button type="button" onClick={() => onGenerate(1)} disabled={busy}>
            {busy ? <Loader2 className="spin" size={14} /> : <ImagePlus size={14} />}
            再画一张
          </button>
          <button
            type="button"
            onClick={onPublishAll}
            disabled={publishBusy || localOnlySketches.length === 0}
            title={localOnlySketches.length === 0 ? "当前草图已经是公网地址" : "上传本分镜本地草图到火山 TOS"}
          >
            {publishBusy ? <Loader2 className="spin" size={14} /> : <Globe size={14} />}
            发布到 TOS
          </button>
          <button
            type="button"
            onClick={() => onGenerate(2)}
            disabled={busy}
            title="一次生成 2 张供挑选"
          >
            +2
          </button>
        </div>
      </div>
      {localOnlySketches.length > 0 && (
        <div className="shot-sketch-warning">
          {localOnlySketches.length} 张草图当前只有本地地址；配置 PUBLIC_MEDIA_BASE_URL / APP_PUBLIC_URL，或发布到 TOS 后，Seedance 才能把它们当作 reference_image 下载。
        </div>
      )}
      {sketches.length === 0 ? (
        <div className="shot-sketches-empty">还没有草图。可以导入 Codex imagegen 故事板，或点「再画一张」让 Seedream 生成参考图。</div>
      ) : (
        <div className="shot-sketches-grid">
          {sketches.map((sketch) => {
            const isFirstFrame = shot.firstFrameAssetId === sketch.id;
            const usableForFirstFrame = isUsableFirstFrameAsset(sketch);
            const usableAsReference = isSeedanceReferenceAsset(sketch);
            return (
              <article key={sketch.id} className={isFirstFrame ? "shot-sketch is-first-frame" : "shot-sketch"}>
                <div className="shot-sketch-thumb">{renderAssetThumb(sketch)}</div>
                <small className="shot-sketch-label" title={sketch.name}>
                  {sketch.name}
                  {isFirstFrame && <em> · 首帧</em>}
                  {!usableAsReference && <em> · 本地预览</em>}
                </small>
                <div className="shot-sketch-actions">
                  {!usableAsReference && (
                    <button
                      type="button"
                      onClick={() => onPublish(sketch.id)}
                      disabled={publishBusyAssetId === sketch.id}
                      title="上传到火山 TOS，生成公网 reference_image"
                    >
                      {publishBusyAssetId === sketch.id ? <Loader2 className="spin" size={13} /> : <Globe size={13} />}
                      TOS
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => onSetAsFirstFrame(sketch.id)}
                    disabled={isFirstFrame || !usableForFirstFrame}
                    title={!usableForFirstFrame ? "等图片生成完毕后可作为首帧" : isFirstFrame ? "已为首帧" : "设为首帧"}
                  >
                    {isFirstFrame ? "已为首帧" : "设为首帧"}
                  </button>
                  <button
                    className="danger"
                    type="button"
                    onClick={() => onDelete(sketch.id)}
                    disabled={deleteBusyAssetId === sketch.id}
                    title="删除草图"
                  >
                    {deleteBusyAssetId === sketch.id ? <Loader2 className="spin" size={13} /> : <Trash2 size={13} />}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function FirstFrameRow({
  shot,
  assets,
  disabled,
  onChange
}: {
  shot: Shot;
  assets: Asset[];
  disabled: boolean;
  onChange: (assetId: string) => void;
}) {
  const options = useMemo(() => assets.filter(isUsableFirstFrameAsset), [assets]);
  const selectedAsset = shot.firstFrameAssetId ? assets.find((asset) => asset.id === shot.firstFrameAssetId) : undefined;
  const hasOptions = options.length > 0;
  const selectDisabled = disabled || !hasOptions;
  const helperText = !hasOptions
    ? "需要先在资产库为图像类资产生成公网图片，才能作为首帧"
    : selectedAsset
      ? `首帧 = @${formatAssetMention(selectedAsset)}（启用后忽略续接前镜与 @ 资产参考图）`
      : "选一个 image 资产作为本分镜的首帧（典型用法：第一个分镜）";

  return (
    <label className="continuity-toggle first-frame-row">
      <span className="first-frame-thumb">
        {selectedAsset ? (
          renderAssetThumb(selectedAsset)
        ) : (
          <div className="thumb other" aria-hidden>
            1F
          </div>
        )}
      </span>
      <span>
        <strong>首帧资产</strong>
        <small>{helperText}</small>
      </span>
      <span className="clip-seconds">
        <select
          value={shot.firstFrameAssetId || ""}
          disabled={selectDisabled}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">无</option>
          {options.map((asset) => (
            <option key={asset.id} value={asset.id}>
              @{formatAssetMention(asset)}
            </option>
          ))}
        </select>
      </span>
    </label>
  );
}

function normalizeMention(value: string) {
  return value.toLowerCase().replace(/\s+/g, "").replace(/／/g, "/").trim();
}

function findMentionedAssets(prompt: string, assets: Asset[]) {
  const normalizedPrompt = normalizeMention(prompt);
  return assets.filter((asset) => {
    const aliases = [formatAssetMention(asset), asset.name, ...(asset.tags || [])].map(normalizeMention).filter(Boolean);
    return aliases.some((alias) => normalizedPrompt.includes(`@${alias}`));
  });
}

function mergeAssetIds(current: string[], next: string[]) {
  return Array.from(new Set([...(current || []), ...next]));
}

function renderAssetThumb(asset: Partial<Asset>) {
  const mediaKind = asset.mediaKind || (asset.imageUrl ? "image" : "none");
  const mediaUrl = asset.mediaUrl || asset.imageUrl || asset.referenceImageUrl;
  if (mediaKind === "image" && mediaUrl) return <img src={mediaUrl} alt="" />;
  if (mediaKind === "video" && mediaUrl) return <video muted playsInline preload="metadata" src={mediaUrl} />;
  return <div className={`thumb ${asset.type || "other"}`}>{asset.type?.[0] || "a"}</div>;
}

interface AssetLibraryListProps {
  allAssets: Asset[];
  activeAssetId: string | undefined;
  selectedSession: Session | undefined;
  busy: string;
  onSelect: (asset: Asset) => void;
  onDelete: (assetId: string) => void;
  onPromote: (assetId: string) => void;
}

function AssetLibraryList({
  allAssets,
  activeAssetId,
  selectedSession,
  busy,
  onSelect,
  onDelete,
  onPromote
}: AssetLibraryListProps) {
  // Three buckets:
  //   - global = no ownerShotId AND no ownerSessionId
  //   - sessionScoped = ownerSessionId === selectedSession.id
  //   - shot sketches + other-session assets are filtered out (sketches surface in the Shot
  //     panel; other sessions' assets are intentionally hidden so the Library reflects only
  //     what's actually @-mentionable from the currently-open session).
  const globalAssets = useMemo(
    () => allAssets.filter((asset) => !asset.ownerShotId && !asset.ownerSessionId),
    [allAssets]
  );
  const sessionAssets = useMemo(
    () =>
      selectedSession
        ? allAssets.filter((asset) => !asset.ownerShotId && asset.ownerSessionId === selectedSession.id)
        : [],
    [allAssets, selectedSession]
  );

  const renderAsset = (asset: Asset, scope: "global" | "session") => {
    const parent = asset.parentAssetId ? allAssets.find((item) => item.id === asset.parentAssetId) : undefined;
    return (
      <article key={asset.id} className={asset.id === activeAssetId ? "asset-item active" : "asset-item"}>
        <button type="button" className="asset-main" data-asset-id={asset.id} onClick={() => onSelect(asset)}>
          {renderAssetThumb(asset)}
          <span>
            <strong>{asset.name}</strong>
            <small>
              {asset.type} / {asset.mediaKind || (asset.imageUrl ? "image" : "none")}
              {parent && <em className="asset-parent-tag"> · ← {parent.name}</em>}
            </small>
          </span>
        </button>
        {scope === "session" && (
          <button
            type="button"
            className="ghost"
            onClick={() => onPromote(asset.id)}
            disabled={busy === `promote-${asset.id}`}
            title="升为全局资产（不再随本 Session 一起被删除）"
          >
            {busy === `promote-${asset.id}` ? <Loader2 className="spin" size={14} /> : <Globe size={14} />}
          </button>
        )}
        <button type="button" className="danger" onClick={() => onDelete(asset.id)} title="删除">
          <Trash2 size={15} />
        </button>
      </article>
    );
  };

  return (
    <div className="asset-library">
      <section className="asset-group">
        <header className="asset-group-head">
          <Globe size={14} />
          <span>全局资产</span>
          <small>{globalAssets.length}</small>
        </header>
        {globalAssets.length > 0 ? (
          <div className="asset-list">{globalAssets.map((asset) => renderAsset(asset, "global"))}</div>
        ) : (
          <div className="asset-group-empty">暂无全局资产，可通过新建表单或将下方 Session 资产升级而来。</div>
        )}
      </section>

      <section className="asset-group">
        <header className="asset-group-head">
          <BookOpen size={14} />
          <span>Session 资产</span>
          <small>{selectedSession ? selectedSession.title : "未选中 Session"}</small>
          {selectedSession && <em className="asset-group-count">{sessionAssets.length}</em>}
        </header>
        {selectedSession ? (
          sessionAssets.length > 0 ? (
            <div className="asset-list">{sessionAssets.map((asset) => renderAsset(asset, "session"))}</div>
          ) : (
            <div className="asset-group-empty">该 Session 暂无私有资产。新建资产时把「归属范围」选成「仅本 Session」即可。</div>
          )
        ) : (
          <div className="asset-group-empty">选中左侧任意 Session 即可看到该 Session 的私有资产。</div>
        )}
      </section>
    </div>
  );
}

function normalizeAssetForDraft(asset: Asset): Asset {
  const mediaKind = asset.mediaKind || (asset.imageUrl || asset.mediaUrl || asset.referenceImageUrl ? "image" : "none");
  const mediaUrl = asset.mediaUrl || asset.imageUrl || asset.referenceImageUrl;
  return {
    ...asset,
    mediaKind,
    mediaUrl,
    imageUrl: mediaKind === "image" ? mediaUrl : asset.imageUrl
  };
}

function renderAssetMedia(asset: Partial<Asset>) {
  const mediaKind = asset.mediaKind || (asset.imageUrl || asset.referenceImageUrl ? "image" : "none");
  const mediaUrl = asset.mediaUrl || asset.imageUrl || asset.referenceImageUrl;
  if (mediaKind === "image" && mediaUrl) return <img src={mediaUrl} alt="asset preview" />;
  if (mediaKind === "video" && mediaUrl) return <video controls playsInline preload="metadata" src={mediaUrl} />;
  return (
    <div className={`asset-empty-preview ${asset.type || "other"}`}>
      <strong>{asset.name || "未命名资产"}</strong>
      <span>{asset.type || "other"} / no media</span>
    </div>
  );
}

function GeneratingPreview() {
  return (
    <div className="asset-generating">
      <Loader2 className="spin" size={22} />
      <strong>正在生成中</strong>
      <span>图片准备好后会自动显示在这里</span>
    </div>
  );
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("参考图片读取失败"));
    reader.readAsDataURL(file);
  });
}

async function downloadFile(url: string, fallbackName: string) {
  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.json().catch(() => undefined);
    throw new Error(body?.error || `${response.status} ${response.statusText}`);
  }

  const blob = await response.blob();
  const filename = filenameFromContentDisposition(response.headers.get("content-disposition")) || fallbackName;
  const objectUrl = window.URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => window.URL.revokeObjectURL(objectUrl), 1000);
}

function filenameFromContentDisposition(value: string | null) {
  if (!value) return "";
  const encoded = value.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) return decodeURIComponent(encoded);
  const quoted = value.match(/filename="([^"]+)"/i)?.[1];
  if (quoted) return quoted;
  return value.match(/filename=([^;]+)/i)?.[1]?.trim() || "";
}

function isVideoUrl(url: string) {
  const cleanUrl = url.split("?")[0].toLowerCase();
  return (
    url.startsWith("/media/") ||
    cleanUrl.endsWith(".mp4") ||
    cleanUrl.endsWith(".webm") ||
    cleanUrl.endsWith(".mov") ||
    cleanUrl.endsWith(".m4v") ||
    cleanUrl.endsWith(".m3u8") ||
    url.includes("dreamina-seedance") ||
    url.includes("video")
  );
}

function createStoryDraft(session: Session): StoryPlan {
  const beats = session.story?.beats?.length
    ? session.story.beats
    : Array.from({ length: Math.max(1, Math.ceil(session.targetDurationSec / 15) || 4) }, (_, index) => ({
        index: index + 1,
        title: `Beat ${index + 1}`,
        purpose: "",
        plot: session.logline || "",
        emotion: "",
        visual: "",
        assetMentions: [],
        durationSec: Math.min(15, Math.max(1, Math.round(session.targetDurationSec / Math.max(Math.ceil(session.targetDurationSec / 15), 1))))
      }));

  return {
    premise: session.story?.premise || session.logline || "",
    synopsis: session.story?.synopsis || "",
    theme: session.story?.theme || "",
    tone: session.story?.tone || session.style || "",
    characters: session.story?.characters || [],
    beats,
    locked: Boolean(session.story?.locked),
    updatedAt: session.story?.updatedAt,
    model: session.story?.model
  };
}

function normalizeStoryDraft(story: StoryPlan): StoryPlan {
  return {
    ...story,
    premise: story.premise.trim(),
    synopsis: story.synopsis.trim(),
    theme: story.theme.trim(),
    tone: story.tone.trim(),
    characters: story.characters.map((character) => ({
      ...character,
      name: character.name.trim(),
      role: character.role.trim(),
      arc: character.arc.trim(),
      assetId: character.assetId?.trim() || undefined,
      assetMention: character.assetMention?.trim() || undefined
    })),
    beats: story.beats.map((beat, index) => ({
      ...beat,
      index: Number(beat.index) || index + 1,
      title: beat.title.trim() || `Beat ${index + 1}`,
      purpose: beat.purpose.trim(),
      plot: beat.plot.trim(),
      emotion: beat.emotion.trim(),
      visual: beat.visual.trim(),
      assetMentions: splitMentionInput(beat.assetMentions.join(" ")),
      durationSec: Math.min(Math.max(Number(beat.durationSec) || 1, 1), 15)
    })),
    updatedAt: new Date().toISOString()
  };
}

function splitMentionInput(value: string) {
  return Array.from(
    new Set(
      value
        .split(/[\s,，]+/u)
        .map((item) => item.trim())
        .filter(Boolean)
        .map((item) => (item.startsWith("@") ? item : `@${item}`))
        .map((item) => item.replace(/\s*\/\s*/g, "/").replace(/\s+/g, ""))
    )
  );
}

function stripShots(session: Session & { shots?: Shot[] }): Session {
  const { shots: _shots, ...rest } = session;
  return rest;
}

function normalizeAssetPayload(asset: Partial<Asset>): Partial<Asset> {
  const prompt = (asset.prompt || "").trim();
  const mediaKind = asset.mediaKind || (asset.mediaUrl || asset.imageUrl || asset.referenceImageUrl ? "image" : "image");
  const mediaUrl = asset.mediaUrl || asset.imageUrl || asset.referenceImageUrl;
  return {
    ...asset,
    prompt,
    description: asset.description || "",
    mediaKind,
    mediaUrl,
    imageUrl: mediaKind === "image" ? mediaUrl : asset.imageUrl,
    referenceImageUrl: asset.referenceImageUrl,
    tags: normalizeTags(asset.tags)
  };
}

function hasAssetRawPrompt(asset: Partial<Asset>) {
  return Boolean((asset.description || asset.name || "").trim());
}

function hasAssetGenerationPrompt(asset: Partial<Asset>) {
  return Boolean((asset.prompt || asset.description || asset.name || asset.referenceImageUrl || "").trim());
}

function normalizeTags(tags: unknown) {
  if (Array.isArray(tags)) return tags.map(String).map((tag) => tag.trim()).filter(Boolean);
  if (typeof tags === "string") return tags.split(",").map((tag) => tag.trim()).filter(Boolean);
  return [];
}

function formatDuration(seconds: number) {
  const min = Math.floor(seconds / 60);
  const sec = seconds % 60;
  return `${min}:${String(sec).padStart(2, "0")}`;
}
