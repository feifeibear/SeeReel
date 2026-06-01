import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  type Connection,
  type Edge,
  type Node,
  type OnNodesChange,
  type OnEdgesChange,
  type OnBeforeDelete,
  type ReactFlowInstance,
  type XYPosition,
  applyNodeChanges,
  applyEdgeChanges
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { api } from "../api";
import type { Asset, AssetType, SessionWithShots, Shot, StoreSnapshot } from "../../shared/types";
import { buildSessionGraph, type FlowNodeData } from "./buildGraph";
import { AssetNode, ReferenceVideoNode, VideoProcessorNode, StoryboardNode, ShotNode, StitchNode, TailframeNode } from "./nodes";
import { Inspector } from "./Inspector";
import { DownloadToast } from "./DownloadToast";
import { CreateNodeMenu, type CreateMenuOption } from "./CreateNodeMenu";
import type { UndoableAction } from "./useUndoStack";

type AnchorKind = Extract<AssetType, "character" | "scene" | "prop" | "style">;

const nodeTypes = {
  assetNode: AssetNode,
  storyboardNode: StoryboardNode,
  shotNode: ShotNode,
  stitchNode: StitchNode,
  referenceVideoNode: ReferenceVideoNode,
  videoProcessorNode: VideoProcessorNode,
  tailframeNode: TailframeNode
};

export interface FlowViewProps {
  snapshot: StoreSnapshot;
  session: SessionWithShots | undefined;
  visionReviewEnabled: boolean;
  onMutated: () => Promise<void> | void;
  onCreateAnchorAsset: (kind: AnchorKind) => Promise<Asset | undefined> | Asset | undefined;
  onCreateShot: () => Promise<{ id: string } | undefined> | { id: string } | undefined;
  onDeleteCanvasAsset: (asset: Asset) => Promise<boolean> | boolean;
  onDeleteCanvasShot: (shot: Shot) => Promise<boolean> | boolean;
  onUploadImageAsset: (file: File, kind: "character" | "scene") => Promise<Asset | undefined> | Asset | undefined;
  /** Drop a video file onto the canvas → upload + auto-trigger reference-video analysis. */
  onUploadReferenceVideo: (file: File) => Promise<Asset | undefined> | Asset | undefined;
  onPushUndo?: (action: UndoableAction) => void;
  onStitch: (options?: { force?: boolean }) => Promise<void> | void;
  /** Canvas-level undo / redo wired to the App-level useUndoStack. Disabled when stack is empty. */
  undo?: () => Promise<void> | void;
  redo?: () => Promise<void> | void;
  canUndo?: boolean;
  canRedo?: boolean;
  undoDescription?: string;
  redoDescription?: string;
}

export function FlowView({ snapshot, session, visionReviewEnabled, onMutated, onCreateAnchorAsset, onCreateShot, onDeleteCanvasAsset, onDeleteCanvasShot, onUploadImageAsset, onUploadReferenceVideo, onPushUndo, onStitch, undo, redo, canUndo, canRedo, undoDescription, redoDescription }: FlowViewProps) {
  const allAssets = snapshot.assets;
  const { nodes: derivedNodes, edges: derivedEdges } = useMemo(() => {
    if (!session) return { nodes: [] as Node<FlowNodeData>[], edges: [] as Edge[] };
    return buildSessionGraph(snapshot, session);
  }, [snapshot, session]);

  const [nodes, setNodes] = useState<Node<FlowNodeData>[]>(derivedNodes);
  const [edges, setEdges] = useState<Edge[]>(derivedEdges);
  const [selectedNodeId, setSelectedNodeId] = useState<string | undefined>();
  // Floating "新建节点" menu position. Right-click summons it; null hides it.
  const [createMenu, setCreateMenu] = useState<{ x: number; y: number; flowPosition?: XYPosition } | null>(null);
  // Hidden file input pulled from the canvas surface for the "上传图" menu option and drop-on-canvas.
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const videoInputRef = useRef<HTMLInputElement | null>(null);
  const pendingFileKindRef = useRef<"character" | "scene">("character");
  const pendingFilePositionRef = useRef<XYPosition | undefined>(undefined);
  // Single in-flight guard for the create-node toolbar + menu. Prevents spam-clicks (which would
  // each fire an independent api.saveAsset / api.appendShot) from creating duplicate nodes.
  const [creating, setCreating] = useState<"" | "character" | "scene" | "prop" | "style" | "shot" | "stitch" | "video">("");
  const guardCreate = useCallback(<K extends typeof creating>(kind: Exclude<K, "">, fn: () => unknown | Promise<unknown>) => {
    if (creating) return;
    setCreating(kind);
    void Promise.resolve(fn()).finally(() => setCreating(""));
  }, [creating]);

  // Edge ids that the user has just deleted but the server hasn't yet acknowledged. Held in a
  // ref so a stray re-render of derivedEdges (e.g. from an unrelated snapshot refresh racing with
  // our PATCH) doesn't reanimate the edge during the await window. Cleared after onMutated returns.
  const pendingDeletionsRef = useRef<Set<string>>(new Set());
  const pendingNodeDeletionsRef = useRef<Set<string>>(new Set());
  const pendingCreatedPositionsRef = useRef<Map<string, XYPosition>>(new Map());
  const rfInstanceRef = useRef<ReactFlowInstance<Node<FlowNodeData>, Edge> | null>(null);

  const flowPositionFromClient = useCallback((x: number, y: number): XYPosition | undefined => {
    return rfInstanceRef.current?.screenToFlowPosition({ x, y });
  }, []);

  const centerNodeAt = useCallback((nodeId: string, position: XYPosition | undefined) => {
    if (!position) return;
    const centered = { x: position.x - 160, y: position.y - 90 };
    pendingCreatedPositionsRef.current.set(nodeId, centered);
    setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, position: centered } : node)));
  }, []);

  useEffect(() => {
    setNodes((prev) => {
      const prevById = new Map(prev.map((n) => [n.id, n]));
      const merged: Node<FlowNodeData>[] = [];
      for (const next of derivedNodes) {
        const old = prevById.get(next.id);
        if (old) {
          // Refresh data + type but keep the user-dragged position.
          merged.push({ ...next, position: old.position });
        } else {
          const pendingPosition = pendingCreatedPositionsRef.current.get(next.id);
          if (pendingPosition) {
            pendingCreatedPositionsRef.current.delete(next.id);
            merged.push({ ...next, position: pendingPosition });
          } else {
            merged.push(next);
          }
        }
      }
      return merged.filter((node) => !pendingNodeDeletionsRef.current.has(node.id));
    });
    setEdges(derivedEdges.filter((e) => !pendingDeletionsRef.current.has(e.id)));
  }, [derivedNodes, derivedEdges]);

  // Listen for in-node mutations (model picker, etc.) that bypass the prop chain — they emit
  // a window 'flow-mutated' event after their PATCH so we can pull a fresh snapshot.
  useEffect(() => {
    const onMutatedEvent = () => { void onMutated(); };
    window.addEventListener("flow-mutated", onMutatedEvent);
    return () => window.removeEventListener("flow-mutated", onMutatedEvent);
  }, [onMutated]);

  const onNodesChange = useCallback<OnNodesChange<Node<FlowNodeData>>>((changes) => {
    setNodes((nds) => applyNodeChanges(changes, nds));
  }, []);
  const onEdgesChange = useCallback<OnEdgesChange>((changes) => {
    setEdges((eds) => applyEdgeChanges(changes, eds));
  }, []);

  /**
   * Drag-to-connect on canvas. Four legal connection shapes:
   *
   *   1. Asset → Storyboard:  registers the asset as a reference for that shot's storyboard
   *      (mutates `shot.assetIds`). The next /sub-storyboard call picks it up.
   *
   *   2. Asset → Shot:        same `shot.assetIds` mutation — the Seedance video generator already
   *      pulls character/scene/style assets from this list (generators.ts buildVideoPrompt). This
   *      branch matters when the shot has no storyboard node on the canvas: without it, the user
   *      can wire characters into shot.assetIds via Inspector but can't draw the link visually,
   *      and dragging character→shot would be silently rejected.
   *
   *   3. Storyboard → Shot:   registers the source shot's storyboard as an additional reference
   *      grid for the target shot's video render (mutates `shot.subShotStoryboardAssetIds`).
   *      Lets the user wire N storyboards into 1 shot for cross-shot continuity / style mixing.
   *
   *   4. RefVideo → Shot:     uses the uploaded reference video as Seedance's `reference_video`
   *      input. Sets both `shot.referenceVideoAssetId` (canonical
   *      wiring) and `shot.referenceClipUrl` (what the existing generator path actually reads).
   *
   * Connections that don't match any pattern are silently rejected.
   */
  const onConnect = useCallback(async (conn: Connection) => {
    if (!session) return;
    const src = conn.source || "";
    const tgt = conn.target || "";

    if (src.startsWith("asset-") && tgt.startsWith("shot-")) {
      const assetId = src.slice("asset-".length);
      const targetShotId = tgt.slice("shot-".length);
      const asset = snapshot.assets.find((a) => a.id === assetId);
      const targetShot = (session.shots || []).find((s) => s.id === targetShotId);
      const isFrameAnchor = (asset?.tags || []).includes("tailframe") || (asset?.tags || []).includes("frame-anchor");
      if (asset && targetShot && isFrameAnchor) {
        const liveBefore = await api.state();
        const liveBeforeShot = liveBefore.shots.find((s) => s.id === targetShotId);
        const previous = {
          firstFrameAssetId: liveBeforeShot?.firstFrameAssetId || "",
          referenceVideoAssetId: liveBeforeShot?.referenceVideoAssetId || "",
          referenceVideoFromShotId: liveBeforeShot?.referenceVideoFromShotId || "",
          referenceClipUrl: liveBeforeShot?.referenceClipUrl ?? null,
          referenceAudioUrl: liveBeforeShot?.referenceAudioUrl ?? null,
          usePreviousShotClip: liveBeforeShot?.usePreviousShotClip || false
        };
        const apply = async () => api.updateShot(targetShotId, {
          firstFrameAssetId: assetId,
          referenceVideoAssetId: "",
          referenceVideoFromShotId: "",
          referenceClipUrl: null,
          referenceAudioUrl: null,
          usePreviousShotClip: false
        });
        const revert = async () => api.updateShot(targetShotId, previous);
        await apply();
        onPushUndo?.({
          description: "连接尾帧到镜头首帧",
          undo: async () => { await revert(); await onMutated(); },
          redo: async () => { await apply(); await onMutated(); }
        });
        await onMutated();
        return;
      }
    }

    if (src.startsWith("asset-") && (tgt.startsWith("storyboard-") || tgt.startsWith("shot-"))) {
      const assetId = src.slice("asset-".length);
      const shotId = tgt.startsWith("storyboard-")
        ? tgt.slice("storyboard-".length)
        : tgt.slice("shot-".length);
      const shot = (session.shots || []).find((s) => s.id === shotId);
      if (!shot) return;
      const current = shot.assetIds || [];
      if (current.includes(assetId)) return; // already wired
      const apply = async () => {
        const live = await api.state();
        const liveShot = live.shots.find((item) => item.id === shotId);
        const liveIds = liveShot?.assetIds || [];
        return api.updateShot(shotId, { assetIds: liveIds.includes(assetId) ? liveIds : [...liveIds, assetId] });
      };
      const revert = async () => {
        const live = await api.state();
        const liveShot = live.shots.find((item) => item.id === shotId);
        const liveIds = liveShot?.assetIds || [];
        return api.updateShot(shotId, { assetIds: liveIds.filter((id) => id !== assetId) });
      };
      await apply();
      onPushUndo?.({
        description: "连接资产到分镜",
        undo: async () => { await revert(); await onMutated(); },
        redo: async () => { await apply(); await onMutated(); }
      });
      await onMutated();
      return;
    }

    if (src.startsWith("storyboard-") && tgt.startsWith("shot-")) {
      const ownerShotId = src.slice("storyboard-".length);
      const targetShotId = tgt.slice("shot-".length);
      const ownerShot = (session.shots || []).find((s) => s.id === ownerShotId);
      const targetShot = (session.shots || []).find((s) => s.id === targetShotId);
      if (!ownerShot || !targetShot) return;
      const storyboardAssetId = ownerShot.subShotStoryboardAssetId;
      if (!storyboardAssetId) return; // owner shot hasn't generated a storyboard yet
      const current = targetShot.subShotStoryboardAssetIds && targetShot.subShotStoryboardAssetIds.length > 0
        ? targetShot.subShotStoryboardAssetIds
        : (targetShot.subShotStoryboardAssetId ? [targetShot.subShotStoryboardAssetId] : []);
      if (current.includes(storyboardAssetId)) return;
      const apply = async () => {
        const live = await api.state();
        const liveShot = live.shots.find((item) => item.id === targetShotId);
        const liveIds = liveShot?.subShotStoryboardAssetIds && liveShot.subShotStoryboardAssetIds.length > 0
          ? liveShot.subShotStoryboardAssetIds
          : (liveShot?.subShotStoryboardAssetId ? [liveShot.subShotStoryboardAssetId] : []);
        return api.updateShot(targetShotId, {
          subShotStoryboardAssetIds: liveIds.includes(storyboardAssetId) ? liveIds : [...liveIds, storyboardAssetId],
          subShotPanelCount: liveShot?.subShotPanelCount && liveShot.subShotPanelCount > 1 ? liveShot.subShotPanelCount : 9
        });
      };
      const revert = async () => {
        const live = await api.state();
        const liveShot = live.shots.find((item) => item.id === targetShotId);
        const liveIds = liveShot?.subShotStoryboardAssetIds && liveShot.subShotStoryboardAssetIds.length > 0
          ? liveShot.subShotStoryboardAssetIds
          : (liveShot?.subShotStoryboardAssetId ? [liveShot.subShotStoryboardAssetId] : []);
        return api.updateShot(targetShotId, {
          subShotStoryboardAssetIds: liveIds.filter((id) => id !== storyboardAssetId),
          ...(liveIds.filter((id) => id !== storyboardAssetId).length ? {} : { subShotPanelCount: 0 })
        });
      };
      await apply();
      onPushUndo?.({
        description: "连接分镜板到镜头",
        undo: async () => { await revert(); await onMutated(); },
        redo: async () => { await apply(); await onMutated(); }
      });
      await onMutated();
      return;
    }

    if ((src.startsWith("refvideo-") || src.startsWith("videoproc-")) && tgt.startsWith("shot-")) {
      const refAssetId = src.startsWith("refvideo-")
        ? src.slice("refvideo-".length)
        : src.slice("videoproc-".length);
      const shotId = tgt.slice("shot-".length);
      const refAsset = snapshot.assets.find((a) => a.id === refAssetId);
      if (!refAsset) return;
      const refUrl = refAsset.mediaUrl || refAsset.imageUrl;
      const isPendingRef = refAssetId.startsWith("pending-ref-video-") || (refAsset.tags || []).includes("client-pending-upload");
      if (isPendingRef || !refUrl || refUrl.startsWith("blob:")) return; // upload still in flight or not server-resolvable
      const liveBefore = await api.state();
      const liveBeforeShot = liveBefore.shots.find((s) => s.id === shotId);
      const previous = {
        referenceVideoAssetId: liveBeforeShot?.referenceVideoAssetId || "",
        referenceVideoFromShotId: liveBeforeShot?.referenceVideoFromShotId || "",
        referenceClipUrl: liveBeforeShot?.referenceClipUrl ?? null,
        referenceAudioUrl: liveBeforeShot?.referenceAudioUrl ?? null,
        firstFrameAssetId: liveBeforeShot?.firstFrameAssetId || "",
        lastFrameAssetId: liveBeforeShot?.lastFrameAssetId || "",
        subShotStoryboardAssetId: liveBeforeShot?.subShotStoryboardAssetId || "",
        subShotStoryboardAssetIds: liveBeforeShot?.subShotStoryboardAssetIds ? [...liveBeforeShot.subShotStoryboardAssetIds] : [],
        subShotPanelCount: liveBeforeShot?.subShotPanelCount || 0,
        usePreviousShotClip: liveBeforeShot?.usePreviousShotClip || false
      };
      const apply = async () => api.updateShot(shotId, {
        referenceVideoAssetId: refAssetId,
        referenceVideoFromShotId: "",
        referenceClipUrl: null,
        referenceAudioUrl: null,
        firstFrameAssetId: "",
        lastFrameAssetId: "",
        subShotStoryboardAssetId: "",
        subShotStoryboardAssetIds: [],
        subShotPanelCount: 0,
        usePreviousShotClip: false
      });
      const revert = async () => {
        const live = await api.state();
        const liveShot = live.shots.find((item) => item.id === shotId);
        if (liveShot?.referenceVideoAssetId && liveShot.referenceVideoAssetId !== refAssetId) return liveShot;
        return api.updateShot(shotId, previous);
      };
      await apply();
      onPushUndo?.({
        description: "连接参考视频到镜头",
        undo: async () => { await revert(); await onMutated(); },
        redo: async () => { await apply(); await onMutated(); }
      });
      await onMutated();
      return;
    }

    if ((src.startsWith("tailframe-") || src.startsWith("asset-")) && tgt.startsWith("shot-")) {
      const assetId = src.startsWith("tailframe-") ? src.slice("tailframe-".length) : src.slice("asset-".length);
      const targetShotId = tgt.slice("shot-".length);
      const asset = snapshot.assets.find((a) => a.id === assetId);
      const targetShot = (session.shots || []).find((s) => s.id === targetShotId);
      if (!asset || !targetShot) return;
      const isFrameAnchor = (asset.tags || []).includes("tailframe") || (asset.tags || []).includes("frame-anchor");
      if (!isFrameAnchor) return;
      const liveBefore = await api.state();
      const liveBeforeShot = liveBefore.shots.find((s) => s.id === targetShotId);
      const previous = {
        firstFrameAssetId: liveBeforeShot?.firstFrameAssetId || "",
        referenceVideoAssetId: liveBeforeShot?.referenceVideoAssetId || "",
        referenceVideoFromShotId: liveBeforeShot?.referenceVideoFromShotId || "",
        referenceClipUrl: liveBeforeShot?.referenceClipUrl ?? null,
        referenceAudioUrl: liveBeforeShot?.referenceAudioUrl ?? null,
        usePreviousShotClip: liveBeforeShot?.usePreviousShotClip || false
      };
      const apply = async () => api.updateShot(targetShotId, {
        firstFrameAssetId: assetId,
        referenceVideoAssetId: "",
        referenceVideoFromShotId: "",
        referenceClipUrl: null,
        referenceAudioUrl: null,
        usePreviousShotClip: false
      });
      const revert = async () => api.updateShot(targetShotId, previous);
      await apply();
      onPushUndo?.({
        description: "连接尾帧到镜头首帧",
        undo: async () => { await revert(); await onMutated(); },
        redo: async () => { await apply(); await onMutated(); }
      });
      await onMutated();
      return;
    }

    if (src.startsWith("shot-") && tgt.startsWith("stitch-")) {
      const srcShotId = src.slice("shot-".length);
      const target = nodes.find((node) => node.id === tgt)?.data;
      if (!target || target.kind !== "stitch" || target.session.id !== session.id) return;
      const sourceShot = (session.shots || []).find((s) => s.id === srcShotId);
      if (!sourceShot) return;
      const jobId = target.job.id;
      const legacy = Boolean(target.legacy);
      const current = target.job.shotIds || [];
      if (current.includes(srcShotId)) return;

      const apply = async () => {
        const live = await api.state();
        const liveSession = live.sessions.find((item) => item.id === session.id);
        if (legacy) {
          const liveIds = liveSession?.stitchShotIds || [];
          return api.updateSession(session.id, {
            stitchShotIds: liveIds.includes(srcShotId) ? liveIds : [...liveIds, srcShotId],
            stitchStatus: "idle",
            stitchError: "",
            stitchProgress: ""
          });
        }
        const liveJob = liveSession?.stitchJobs?.find((job) => job.id === jobId);
        const liveIds = liveJob?.shotIds || [];
        return api.updateStitchJob(session.id, jobId, {
          shotIds: liveIds.includes(srcShotId) ? liveIds : [...liveIds, srcShotId],
          status: "idle",
          error: "",
          progress: ""
        });
      };
      const revert = async () => {
        const live = await api.state();
        const liveSession = live.sessions.find((item) => item.id === session.id);
        if (legacy) {
          const liveIds = liveSession?.stitchShotIds || [];
          return api.updateSession(session.id, {
            stitchShotIds: liveIds.filter((id) => id !== srcShotId),
            stitchStatus: "idle",
            stitchError: "",
            stitchProgress: ""
          });
        }
        const liveJob = liveSession?.stitchJobs?.find((job) => job.id === jobId);
        const liveIds = liveJob?.shotIds || [];
        return api.updateStitchJob(session.id, jobId, {
          shotIds: liveIds.filter((id) => id !== srcShotId),
          status: "idle",
          error: "",
          progress: ""
        });
      };
      await apply();
      onPushUndo?.({
        description: "连接视频到拼接",
        undo: async () => { await revert(); await onMutated(); },
        redo: async () => { await apply(); await onMutated(); }
      });
      await onMutated();
      return;
    }

    // Shot → Shot reference-video wiring. Source shot's rendered video becomes the target shot's
    // Seedance `reference_video`. Resolved at submit time by the server (it walks the source
    // shot's renders for an https remoteVideoUrl). We DON'T materialize an Asset row — the
    // relationship is encoded purely as `referenceVideoFromShotId`.
    if (src.startsWith("shot-") && tgt.startsWith("shot-")) {
      const srcShotId = src.slice("shot-".length);
      const tgtShotId = tgt.slice("shot-".length);
      if (srcShotId === tgtShotId) return; // no self-loop
      const sourceShot = (session.shots || []).find((s) => s.id === srcShotId);
      const targetShot = (session.shots || []).find((s) => s.id === tgtShotId);
      if (!sourceShot || !targetShot) return;
      // Reject if the source shot has no rendered video yet — Seedance can't fetch nothing.
      if (!sourceShot.videoUrl) {
        window.alert(`无法连接：源镜头「${sourceShot.title || `Shot ${sourceShot.index}`}」还没有生成的视频，先生成它再连。`);
        return;
      }
      const liveBefore = await api.state();
      const liveBeforeShot = liveBefore.shots.find((s) => s.id === tgtShotId);
      // Server expects "" for clearable fields when blanking; `null` for clearable string fields.
      const previous = {
        referenceVideoFromShotId: liveBeforeShot?.referenceVideoFromShotId || "",
        // Also restore the asset path + clip url since we're going to clear them on apply.
        referenceVideoAssetId: liveBeforeShot?.referenceVideoAssetId || "",
        referenceClipUrl: liveBeforeShot?.referenceClipUrl ?? null,
        firstFrameAssetId: liveBeforeShot?.firstFrameAssetId || "",
        lastFrameAssetId: liveBeforeShot?.lastFrameAssetId || "",
        subShotStoryboardAssetId: liveBeforeShot?.subShotStoryboardAssetId || "",
        subShotStoryboardAssetIds: liveBeforeShot?.subShotStoryboardAssetIds ? [...liveBeforeShot.subShotStoryboardAssetIds] : [],
        subShotPanelCount: liveBeforeShot?.subShotPanelCount || 0
      };
      const apply = async () => api.updateShot(tgtShotId, {
        referenceVideoFromShotId: srcShotId,
        // Mode mutex: a shot can only have one of {first/last frame, sub-shot grid, asset-based
        // refvideo, shot-based refvideo}. Setting cross-shot ref video clears the others so the
        // server's mode resolver picks this branch unambiguously.
        referenceVideoAssetId: "",
        referenceClipUrl: null,
        firstFrameAssetId: "",
        lastFrameAssetId: "",
        subShotStoryboardAssetId: "",
        subShotStoryboardAssetIds: [],
        subShotPanelCount: 0
      });
      const revert = async () => api.updateShot(tgtShotId, previous);
      await apply();
      onPushUndo?.({
        description: "把上游镜头的视频接到下一镜（reference_video）",
        undo: async () => { await revert(); await onMutated(); },
        redo: async () => { await apply(); await onMutated(); }
      });
      await onMutated();
      return;
    }
  }, [session, onMutated, onPushUndo, snapshot.assets]);

  /**
   * Edge-deletion handler: dispatches by `data` shape:
   *   - `canDisconnect`            → asset→storyboard intent edge → strip from `shot.assetIds`
   *   - `canDisconnectStoryboard`  → storyboard→shot edge → strip from `shot.subShotStoryboardAssetIds`.
   *     Additionally when the deleted edge is the *primary* (own-shot) one we clear the legacy
   *     singular `subShotStoryboardAssetId` too, otherwise the renderer's sub-shot-mode check still
   *     activates and re-references the asset.
   *   - `canDisconnectRefVideo`    → refvideo→shot edge → clear `referenceVideoAssetId` and
   *     `referenceClipUrl` together so the next regen drops Seedance reference_video.
   * Auto-derived edges (shot→stitch) carry `deletable: false` and never reach this path.
   */
  const onEdgesDelete = useCallback(async (deleted: Edge[]) => {
    if (!session) return;

    type AssetEdgeData = {
      canDisconnect?: boolean;
      assetId?: string;
      shotId?: string;
      auditOnly?: boolean;
      storyboardAssetId?: string;
    };
    type DerivedClipEdgeData = {
      canDisconnectDerivedClip?: boolean;
      sourceAssetId?: string;
      derivedAssetId?: string;
    };
    type StoryboardEdgeData = {
      canDisconnectStoryboard?: boolean;
      storyboardAssetId?: string;
      targetShotId?: string;
      isPrimary?: boolean;
    };
    type RefVideoEdgeData = {
      canDisconnectRefVideo?: boolean;
      refVideoAssetId?: string;
      targetShotId?: string;
    };
    type ShotRefEdgeData = {
      canDisconnectShotRef?: boolean;
      sourceShotId?: string;
      targetShotId?: string;
    };
    type FirstFrameEdgeData = {
      canDisconnectFirstFrame?: boolean;
      tailframeAssetId?: string;
      targetShotId?: string;
    };
    type StitchEdgeData = {
      canDisconnectStitch?: boolean;
      stitchShotId?: string;
      stitchJobId?: string;
    };

    const assetRemovals = deleted
      .map((edge) => edge.data as AssetEdgeData | undefined)
      .filter((d): d is AssetEdgeData & { assetId: string; shotId: string } => Boolean(d?.canDisconnect && d.assetId && d.shotId));
    const storyboardRemovals = deleted
      .map((edge) => edge.data as StoryboardEdgeData | undefined)
      .filter((d): d is StoryboardEdgeData & { storyboardAssetId: string; targetShotId: string } =>
        Boolean(d?.canDisconnectStoryboard && d.storyboardAssetId && d.targetShotId));
    const refVideoRemovals = deleted
      .map((edge) => edge.data as RefVideoEdgeData | undefined)
      .filter((d): d is Required<RefVideoEdgeData> =>
        Boolean(d?.canDisconnectRefVideo && d.refVideoAssetId && d.targetShotId));
    const shotRefRemovals = deleted
      .map((edge) => edge.data as ShotRefEdgeData | undefined)
      .filter((d): d is Required<ShotRefEdgeData> =>
        Boolean(d?.canDisconnectShotRef && d.sourceShotId && d.targetShotId));
    const firstFrameRemovals = deleted
      .map((edge) => edge.data as FirstFrameEdgeData | undefined)
      .filter((d): d is Required<FirstFrameEdgeData> =>
        Boolean(d?.canDisconnectFirstFrame && d.tailframeAssetId && d.targetShotId));
    const stitchRemovals = deleted
      .map((edge) => edge.data as StitchEdgeData | undefined)
      .filter((d): d is Required<StitchEdgeData> => Boolean(d?.canDisconnectStitch && d.stitchShotId));
    const derivedClipRemovals = deleted
      .map((edge) => edge.data as DerivedClipEdgeData | undefined)
      .filter((d): d is Required<DerivedClipEdgeData> => Boolean(d?.canDisconnectDerivedClip && d.sourceAssetId && d.derivedAssetId));

    if (!assetRemovals.length && !storyboardRemovals.length && !refVideoRemovals.length && !shotRefRemovals.length && !firstFrameRemovals.length && !stitchRemovals.length && !derivedClipRemovals.length) return;

    // Mark these edge ids as pending deletion so any racing snapshot refresh during the await
    // doesn't reanimate them via the useEffect rebuild path.
    for (const e of deleted) pendingDeletionsRef.current.add(e.id);

    // Group both kinds by shotId so we issue one PATCH per shot.
    type ShotPatch = {
      drop_assetIds: Set<string>;
      drop_storyboardIds: Set<string>;
      drop_primary_storyboard: boolean;
      drop_ref_video: boolean;
      drop_shot_ref: boolean;
      drop_first_frame: boolean;
    };
    const byShot = new Map<string, ShotPatch>();
    const ensure = (id: string): ShotPatch => {
      let entry = byShot.get(id);
      if (!entry) {
        entry = { drop_assetIds: new Set(), drop_storyboardIds: new Set(), drop_primary_storyboard: false, drop_ref_video: false, drop_shot_ref: false, drop_first_frame: false };
        byShot.set(id, entry);
      }
      return entry;
    };
    for (const r of assetRemovals) {
      if (!r.auditOnly) ensure(r.shotId).drop_assetIds.add(r.assetId);
    }
    for (const r of storyboardRemovals) {
      const slot = ensure(r.targetShotId);
      slot.drop_storyboardIds.add(r.storyboardAssetId);
      if (r.isPrimary) slot.drop_primary_storyboard = true;
    }
    for (const r of refVideoRemovals) ensure(r.targetShotId).drop_ref_video = true;
    for (const r of shotRefRemovals) ensure(r.targetShotId).drop_shot_ref = true;
    for (const r of firstFrameRemovals) ensure(r.targetShotId).drop_first_frame = true;

    const storyboardAssetRefDrops = new Map<string, Set<string>>();
    for (const r of assetRemovals) {
      if (!r.auditOnly || !r.storyboardAssetId) continue;
      const entry = storyboardAssetRefDrops.get(r.storyboardAssetId) || new Set<string>();
      entry.add(r.assetId);
      storyboardAssetRefDrops.set(r.storyboardAssetId, entry);
    }
    const derivedAssetClears = new Set(derivedClipRemovals.map((item) => item.derivedAssetId));

    const beforeByShot = new Map(Array.from(byShot.keys()).map((shotId) => {
      const shot = (session.shots || []).find((s) => s.id === shotId);
      return [shotId, shot ? {
        assetIds: [...(shot.assetIds || [])],
        subShotStoryboardAssetId: shot.subShotStoryboardAssetId,
        subShotStoryboardAssetIds: shot.subShotStoryboardAssetIds ? [...shot.subShotStoryboardAssetIds] : undefined,
        referenceVideoAssetId: shot.referenceVideoAssetId,
        referenceClipUrl: shot.referenceClipUrl ?? null,
        referenceVideoFromShotId: shot.referenceVideoFromShotId,
        firstFrameAssetId: shot.firstFrameAssetId
      } : undefined] as const;
    }));
    const beforeStitchShotIds = [...(session.stitchShotIds || [])];
    const stitchRemovalIds = new Set(stitchRemovals.filter((item) => !item.stitchJobId || item.stitchJobId === "legacy").map((item) => item.stitchShotId));
    const stitchRemovalIdsByJob = new Map<string, Set<string>>();
    for (const item of stitchRemovals) {
      if (!item.stitchJobId || item.stitchJobId === "legacy") continue;
      const set = stitchRemovalIdsByJob.get(item.stitchJobId) || new Set<string>();
      set.add(item.stitchShotId);
      stitchRemovalIdsByJob.set(item.stitchJobId, set);
    }
    const beforeStitchJobs = new Map((session.stitchJobs || []).map((job) => [job.id, { ...job, shotIds: [...(job.shotIds || [])] }]));
    const beforeByAsset = new Map(Array.from(new Set([
      ...Array.from(storyboardAssetRefDrops.keys()),
      ...Array.from(derivedAssetClears)
    ])).map((assetId) => {
      const asset = snapshot.assets.find((item) => item.id === assetId);
      return [assetId, asset ? {
        referenceAssetIds: asset.referenceAssetIds ? [...asset.referenceAssetIds] : undefined,
        derivedFromAssetId: asset.derivedFromAssetId
      } : undefined] as const;
    }));

    try {
      await Promise.all(Array.from(byShot.entries()).map(([shotId, drop]) => {
        const shot = (session.shots || []).find((s) => s.id === shotId);
        if (!shot) return Promise.resolve();
        const patch: Partial<typeof shot> = {};
        if (drop.drop_assetIds.size) {
          patch.assetIds = (shot.assetIds || []).filter((id) => !drop.drop_assetIds.has(id));
        }
        if (drop.drop_storyboardIds.size) {
          const current = shot.subShotStoryboardAssetIds && shot.subShotStoryboardAssetIds.length > 0
            ? shot.subShotStoryboardAssetIds
            : (shot.subShotStoryboardAssetId ? [shot.subShotStoryboardAssetId] : []);
          patch.subShotStoryboardAssetIds = current.filter((id) => !drop.drop_storyboardIds.has(id));
          if (patch.subShotStoryboardAssetIds.length === 0) patch.subShotPanelCount = 0;
        }
        if (drop.drop_primary_storyboard) {
          // Backend treats "" as "clear field" via normalizeShotPatch (server/index.ts line ~887).
          patch.subShotStoryboardAssetId = "";
        }
        if (drop.drop_ref_video) {
          // Clear both: assetId is the canonical wiring, clipUrl is what generators read. null
          // keeps the field nullable per the type while explicit "" runs through normalizeShotPatch.
          patch.referenceVideoAssetId = "";
          patch.referenceClipUrl = null;
        }
        if (drop.drop_shot_ref) {
          // Clear cross-shot wiring (shot.referenceVideoFromShotId).
          patch.referenceVideoFromShotId = "";
        }
        if (drop.drop_first_frame) {
          patch.firstFrameAssetId = "";
        }
        return api.updateShot(shotId, patch);
      }));
      await Promise.all(Array.from(storyboardAssetRefDrops.entries()).map(([assetId, dropIds]) => {
        const asset = snapshot.assets.find((item) => item.id === assetId);
        if (!asset) return Promise.resolve();
        return api.saveAsset({
          id: assetId,
          referenceAssetIds: (asset.referenceAssetIds || []).filter((id) => !dropIds.has(id))
        });
      }));
      await Promise.all(Array.from(derivedAssetClears).map((assetId) => api.saveAsset({
        id: assetId,
        derivedFromAssetId: ""
      })));
      if (stitchRemovalIds.size) {
        await api.updateSession(session.id, {
          stitchShotIds: beforeStitchShotIds.filter((id) => !stitchRemovalIds.has(id)),
          stitchStatus: "idle",
          stitchError: "",
          stitchProgress: ""
        });
      }
      await Promise.all(Array.from(stitchRemovalIdsByJob.entries()).map(([jobId, dropIds]) => {
        const job = (session.stitchJobs || []).find((item) => item.id === jobId);
        if (!job) return Promise.resolve();
        return api.updateStitchJob(session.id, jobId, {
          shotIds: (job.shotIds || []).filter((id) => !dropIds.has(id)),
          status: "idle",
          error: "",
          progress: ""
        });
      }));
      onPushUndo?.({
        description: deleted.length > 1 ? "断开多个连接" : "断开连接",
        undo: async () => {
          await Promise.all(Array.from(beforeByShot.entries()).map(([shotId, before]) => {
            if (!before) return Promise.resolve();
            return api.updateShot(shotId, before);
          }));
          await Promise.all(Array.from(beforeByAsset.entries()).map(([assetId, before]) => {
            if (!before) return Promise.resolve();
            return api.saveAsset({ id: assetId, ...before });
          }));
          if (stitchRemovalIds.size) {
            await api.updateSession(session.id, {
              stitchShotIds: beforeStitchShotIds,
              stitchStatus: "idle",
              stitchError: "",
              stitchProgress: ""
            });
          }
          await Promise.all(Array.from(stitchRemovalIdsByJob.keys()).map((jobId) => {
            const before = beforeStitchJobs.get(jobId);
            return before ? api.updateStitchJob(session.id, jobId, before) : Promise.resolve();
          }));
          await onMutated();
        },
        redo: async () => {
          const live = await api.state();
          await Promise.all(Array.from(byShot.entries()).map(([shotId, drop]) => {
            const shot = live.shots.find((item) => item.id === shotId);
            if (!shot) return Promise.resolve();
            const patch: Partial<Shot> = {};
            if (drop.drop_assetIds.size) patch.assetIds = (shot.assetIds || []).filter((id) => !drop.drop_assetIds.has(id));
            if (drop.drop_storyboardIds.size) {
              const current = shot.subShotStoryboardAssetIds && shot.subShotStoryboardAssetIds.length > 0
                ? shot.subShotStoryboardAssetIds
                : (shot.subShotStoryboardAssetId ? [shot.subShotStoryboardAssetId] : []);
              patch.subShotStoryboardAssetIds = current.filter((id) => !drop.drop_storyboardIds.has(id));
              if (patch.subShotStoryboardAssetIds.length === 0) patch.subShotPanelCount = 0;
            }
            if (drop.drop_primary_storyboard) patch.subShotStoryboardAssetId = "";
            if (drop.drop_ref_video) {
              patch.referenceVideoAssetId = "";
              patch.referenceClipUrl = null;
            }
            if (drop.drop_shot_ref) {
              patch.referenceVideoFromShotId = "";
            }
            if (drop.drop_first_frame) {
              patch.firstFrameAssetId = "";
            }
            return api.updateShot(shotId, patch);
          }));
          await Promise.all(Array.from(storyboardAssetRefDrops.entries()).map(([assetId, dropIds]) => {
            const asset = live.assets.find((item) => item.id === assetId);
            if (!asset) return Promise.resolve();
            return api.saveAsset({
              id: assetId,
              referenceAssetIds: (asset.referenceAssetIds || []).filter((id) => !dropIds.has(id))
            });
          }));
          await Promise.all(Array.from(derivedAssetClears).map((assetId) => api.saveAsset({
            id: assetId,
            derivedFromAssetId: ""
          })));
          if (stitchRemovalIds.size) {
            const liveSession = live.sessions.find((item) => item.id === session.id);
            const liveIds = liveSession?.stitchShotIds || [];
            await api.updateSession(session.id, {
              stitchShotIds: liveIds.filter((id) => !stitchRemovalIds.has(id)),
              stitchStatus: "idle",
              stitchError: "",
              stitchProgress: ""
            });
          }
          await Promise.all(Array.from(stitchRemovalIdsByJob.entries()).map(([jobId, dropIds]) => {
            const liveSession = live.sessions.find((item) => item.id === session.id);
            const liveJob = liveSession?.stitchJobs?.find((item) => item.id === jobId);
            if (!liveJob) return Promise.resolve();
            return api.updateStitchJob(session.id, jobId, {
              shotIds: (liveJob.shotIds || []).filter((id) => !dropIds.has(id)),
              status: "idle",
              error: "",
              progress: ""
            });
          }));
          await onMutated();
        }
      });
      await onMutated();
    } finally {
      // Clear pending markers either way; if the PATCH failed the server snapshot still has
      // the edges and reanimating them is the correct behavior.
      for (const e of deleted) pendingDeletionsRef.current.delete(e.id);
    }
  }, [session, onMutated, onPushUndo]);

  const selectedData = useMemo(() => {
    const node = nodes.find((n) => n.id === selectedNodeId);
    return node?.data;
  }, [nodes, selectedNodeId]);

  const onBeforeDelete = useCallback<OnBeforeDelete<Node<FlowNodeData>, Edge>>(async ({ nodes: deletingNodes, edges: deletingEdges }) => {
    // All node kinds are deletable now. Generating shots get a soft warning so the user knows the
    // in-flight Seedance task may still finish on the server (deletion only removes the local row);
    // they can still confirm to proceed. stitch + storyboard are real deletions handled below in
    // onNodesDelete via session/shot patches.
    const generatingShots = deletingNodes.filter(
      (node) => node.data.kind === "shot" && node.data.shot.status === "generating"
    );
    if (generatingShots.length) {
      const ok = window.confirm(
        `${generatingShots.length} 个分镜还在生成中。删除只清掉画布上的节点；远程 Seedance 任务可能还会跑完（不会再回灌到本地）。继续？`
      );
      if (!ok) return false;
    }
    const allowedNodes = deletingNodes;
    const labels = allowedNodes.map((node) => {
      const data = node.data;
      if (data.kind === "asset" || data.kind === "referenceVideo" || data.kind === "videoProcessor") return data.asset.name || data.asset.id;
      if (data.kind === "shot") return data.shot.title || `Shot ${data.shot.index}`;
      if (data.kind === "storyboard") return `分镜板 · ${data.shot.title || `Shot ${data.shot.index}`}`;
      if (data.kind === "stitch") return data.job.name || `拼接节点 ${data.job.id}`;
      return node.id;
    });
    // When deleting nodes, xyflow auto-includes the incident edges (the wires touching the
    // deleted nodes) in `deletingEdges`. Those are CASCADE consequences, not user-selected edge
    // deletions — they must be allowed through silently or the user can never delete a connected
    // node. We only treat as "mixed standalone" the edges whose endpoints are NOT in the deleting
    // node set (i.e. edges the user explicitly added to the selection alongside a node).
    const incidentEdges = deletingEdges.filter((e) =>
      deletingNodes.some((n) => n.id === e.source || n.id === e.target)
    );
    const standaloneEdges = deletingEdges.filter((e) => !incidentEdges.includes(e));
    if (deletingNodes.length > 0 && standaloneEdges.length > 0) {
      window.alert("请分开操作：先删除节点，再单独断开连接。这样撤销记录会更准确。");
      return false;
    }
    const effectiveEdges = deletingNodes.length > 0 ? [] : deletingEdges;
    if (!allowedNodes.length && !effectiveEdges.length) return false;
    if (allowedNodes.length || (deletingNodes.length === 0 && effectiveEdges.length)) {
      const lines = [
        allowedNodes.length ? `删除 ${allowedNodes.length} 个节点：\n${labels.join("\n")}` : "",
        // Only mention edge count to the user when they're doing standalone edge deletion. When
        // edges are cascade consequences of a node delete, the node confirm covers the intent.
        deletingNodes.length === 0 && effectiveEdges.length ? `断开 ${effectiveEdges.length} 条连接` : ""
      ].filter(Boolean);
      if (!window.confirm(`${lines.join("\n\n")}\n\n操作后可用撤销恢复。`)) return false;
    }
    return {
      nodes: allowedNodes,
      // Node deletion owns cleanup of its incident wires through the server delete path. Do not pass
      // those edges into onEdgesDelete or we'd create duplicate/conflicting undo entries.
      edges: effectiveEdges
    };
  }, []);

  const onNodesDelete = useCallback(async (deleted: Node<FlowNodeData>[]) => {
    if (!deleted.length) return;
    if (deleted.some((node) => node.id === selectedNodeId)) setSelectedNodeId(undefined);
    for (const node of deleted) pendingNodeDeletionsRef.current.add(node.id);
    try {
      for (const node of deleted) {
        const data = node.data;
        try {
          let ok = false;
          if (data.kind === "asset" || data.kind === "referenceVideo" || data.kind === "videoProcessor") {
            ok = await onDeleteCanvasAsset(data.asset);
          } else if (data.kind === "shot") {
            ok = await onDeleteCanvasShot(data.shot);
          } else if (data.kind === "storyboard") {
            // Clearing the shot's sub-storyboard wiring is what visually removes the node from
            // the canvas (buildGraph re-derives based on these fields). The orphaned grid Asset
            // stays in store for audit / restore — user can prune via the Asset library.
            const before = {
              subShotStoryboardAssetId: data.shot.subShotStoryboardAssetId,
              subShotStoryboardAssetIds: data.shot.subShotStoryboardAssetIds ? [...data.shot.subShotStoryboardAssetIds] : undefined,
              subShotPanelCount: data.shot.subShotPanelCount,
              composedSeedreamPromptDraft: data.shot.composedSeedreamPromptDraft
            };
            await api.updateShot(data.shot.id, {
              subShotStoryboardAssetId: "",
              subShotStoryboardAssetIds: [],
              subShotPanelCount: 0,
              composedSeedreamPromptDraft: ""
            });
            ok = true;
            const targetShotId = data.shot.id;
            onPushUndo?.({
              description: "删除分镜板节点",
              undo: async () => { await api.updateShot(targetShotId, before); await onMutated(); },
              redo: async () => {
                await api.updateShot(targetShotId, {
                  subShotStoryboardAssetId: "",
                  subShotStoryboardAssetIds: [],
                  subShotPanelCount: 0,
                  composedSeedreamPromptDraft: ""
                });
                await onMutated();
              }
            });
          } else if (data.kind === "stitch") {
            const sessionId = data.session.id;
            const job = data.job;
            if (data.legacy) {
              await api.updateSession(sessionId, { stitchHidden: true });
              ok = true;
              onPushUndo?.({
                description: "删除拼接节点",
                undo: async () => { await api.updateSession(sessionId, { stitchHidden: false }); await onMutated(); },
                redo: async () => { await api.updateSession(sessionId, { stitchHidden: true }); await onMutated(); }
              });
            } else {
              await api.deleteStitchJob(sessionId, job.id);
              ok = true;
              onPushUndo?.({
                description: "删除拼接节点",
                undo: async () => { await api.createStitchJob(sessionId, job); await onMutated(); },
                redo: async () => { await api.deleteStitchJob(sessionId, job.id); await onMutated(); }
              });
            }
          }
          if (!ok) {
            pendingNodeDeletionsRef.current.delete(node.id);
            setNodes((prev) => prev.some((item) => item.id === node.id) ? prev : [...prev, node]);
          }
        } catch (error) {
          pendingNodeDeletionsRef.current.delete(node.id);
          setNodes((prev) => prev.some((item) => item.id === node.id) ? prev : [...prev, node]);
          window.alert(`删除失败：${error instanceof Error ? error.message : "未知错误"}`);
        }
      }
      await onMutated();
    } finally {
      for (const node of deleted) pendingNodeDeletionsRef.current.delete(node.id);
    }
  }, [onDeleteCanvasAsset, onDeleteCanvasShot, onMutated, onPushUndo, selectedNodeId]);

  /**
   * Translate a user pick from the floating menu into the actual mutation. The "upload" branch
   * stages which kind of anchor the file should become (character vs scene), then triggers the
   * hidden file input — its onChange handler runs the upload.
   */
  const handleMenuPick = useCallback(async (option: CreateMenuOption) => {
    const placement = createMenu?.flowPosition;
    setCreateMenu(null);
    if (option === "character") {
      return guardCreate("character", async () => {
        const asset = await onCreateAnchorAsset("character");
        if (asset) centerNodeAt(`asset-${asset.id}`, placement);
      });
    }
    if (option === "scene") {
      return guardCreate("scene", async () => {
        const asset = await onCreateAnchorAsset("scene");
        if (asset) centerNodeAt(`asset-${asset.id}`, placement);
      });
    }
    if (option === "shot") {
      return guardCreate("shot", async () => {
        const shot = await onCreateShot();
        if (shot) centerNodeAt(`shot-${shot.id}`, placement);
      });
    }
    if (option === "stitch") {
      return guardCreate("stitch", async () => {
        if (!session) return;
        const updated = await api.createStitchJob(session.id);
        await onMutated();
        const job = updated.stitchJobs?.[updated.stitchJobs.length - 1];
        if (job) centerNodeAt(`stitch-${session.id}-${job.id}`, placement);
      });
    }
    if (option === "uploadCharacter") {
      pendingFileKindRef.current = "character";
      pendingFilePositionRef.current = placement;
      fileInputRef.current?.click();
      return;
    }
    if (option === "uploadScene") {
      pendingFileKindRef.current = "scene";
      pendingFilePositionRef.current = placement;
      fileInputRef.current?.click();
      return;
    }
    if (option === "uploadVideo") {
      pendingFilePositionRef.current = placement;
      videoInputRef.current?.click();
      return;
    }
  }, [centerNodeAt, createMenu?.flowPosition, guardCreate, onCreateAnchorAsset, onCreateShot, onMutated, session]);

  /** Drop-on-canvas handler: route file by mime type. Image → character anchor; video → reference. */
  const onDrop = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.files?.length) return;
    event.preventDefault();
    const file = event.dataTransfer.files[0];
    const placement = flowPositionFromClient(event.clientX, event.clientY);
    if (file.type.startsWith("image/")) {
      pendingFileKindRef.current = "character";
      void Promise.resolve(onUploadImageAsset(file, "character")).then((asset) => {
        if (asset) centerNodeAt(`asset-${asset.id}`, placement);
      });
      return;
    }
    if (file.type.startsWith("video/")) {
      void Promise.resolve(onUploadReferenceVideo(file)).then((asset) => {
        if (asset) centerNodeAt(`refvideo-${asset.id}`, placement);
      });
      return;
    }
  }, [centerNodeAt, flowPositionFromClient, onUploadImageAsset, onUploadReferenceVideo]);

  const toolbarStitchReady = session
    ? (session.stitchShotIds && session.stitchShotIds.length > 0
        ? session.stitchShotIds
            .map((id) => (session.shots || []).find((shot) => shot.id === id))
            .filter((shot): shot is Shot => Boolean(shot))
            .every((shot) => Boolean(shot.videoUrl))
        : (session.shots || []).length > 0 && (session.shots || []).every((shot) => Boolean(shot.videoUrl)))
    : false;

  if (!session) {
    return (
      <div className="flow-empty-state">
        <div style={{ display: "grid", gap: 8, placeItems: "center", padding: 32 }}>
          <p style={{ fontSize: 16, opacity: 0.85, margin: 0 }}>这里是节点画布</p>
          <p style={{ fontSize: 13, opacity: 0.6, margin: 0 }}>← 左侧侧栏点「新建 Session」或选一个已有 session</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flow-view">
      <header className="flow-toolbar">
        <div className="flow-toolbar-section">
          <strong>{session.title}</strong>
          <small>{(session.shots || []).length} 个分镜 · 目标 {session.targetDurationSec}s · 语言 {session.language || "zh"} · <em>右键空白处可新建节点</em></small>
        </div>
        <div className="flow-toolbar-actions">
          {undo && (
            <button
              className="flow-toolbar-undo"
              onClick={() => undo()}
              disabled={!canUndo}
              title={canUndo ? `撤销「${undoDescription}」(⌘Z)` : "没有可撤销的操作"}
            >
              ↶ 撤销
            </button>
          )}
          {redo && (
            <button
              className="flow-toolbar-undo"
              onClick={() => redo()}
              disabled={!canRedo}
              title={canRedo ? `恢复「${redoDescription}」(⇧⌘Z)` : "没有可恢复的操作"}
            >
              ↷ 恢复
            </button>
          )}
          <button
            onClick={() => guardCreate("character", () => onCreateAnchorAsset("character"))}
            disabled={Boolean(creating)}
            title="新建一个角色资产做跨分镜的身份锚"
          >
            {creating === "character" ? "..." : "+ 角色"}
          </button>
          <button
            onClick={() => guardCreate("scene", () => onCreateAnchorAsset("scene"))}
            disabled={Boolean(creating)}
            title="新建一个场景资产做跨分镜的环境锚"
          >
            {creating === "scene" ? "..." : "+ 场景"}
          </button>
          <button
            onClick={() => guardCreate("shot", () => onCreateShot())}
            disabled={Boolean(creating)}
            title="新增一个分镜（同时派生分镜板 + 视频节点）"
          >
            {creating === "shot" ? "..." : "+ 分镜"}
          </button>
          <button
            onClick={() => {
              pendingFilePositionRef.current = undefined;
              videoInputRef.current?.click();
            }}
            title="上传一段视频文件作为参考。会自动 AI 拆分镜表；也可拖到 Shot 上做 Seedance reference_video。"
          >
            + 上传视频
          </button>
          <button onClick={() => onStitch({ force: Boolean(session.stitchShotIds?.length) })} className="primary" disabled={!toolbarStitchReady}>
            {session.stitchShotIds?.length ? "按连接顺序拼接" : "拼接全片"}
          </button>
        </div>
      </header>
      <div className="flow-canvas-row">
        <div
          className="flow-canvas"
          onDrop={onDrop}
          onDragOver={(e) => {
            // Only allow drop when files are involved — otherwise xyflow needs to handle drag.
            if (e.dataTransfer.types.includes("Files")) e.preventDefault();
          }}
        >
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            nodeTypes={nodeTypes}
            onNodeClick={(_, node) => { setSelectedNodeId(node.id); setCreateMenu(null); }}
            onPaneClick={() => { setSelectedNodeId(undefined); setCreateMenu(null); }}
            onConnect={onConnect}
            onBeforeDelete={onBeforeDelete}
            onNodesDelete={onNodesDelete}
            onEdgesDelete={onEdgesDelete}
            // Mac keyboards label Backspace as "delete" — pressing it should delete the selected
            // node, matching what's printed on the key. xyflow's `useKeyPress` internally skips
            // these key bindings when an INPUT / TEXTAREA / SELECT / contenteditable element has
            // focus, so the user can still backspace inside Inspector textareas without nuking
            // the canvas.
            deleteKeyCode={["Delete", "Backspace"]}
            onPaneContextMenu={(e) => {
              const evt = e as unknown as MouseEvent;
              evt.preventDefault();
              setCreateMenu({ x: evt.clientX, y: evt.clientY, flowPosition: flowPositionFromClient(evt.clientX, evt.clientY) });
            }}
            onInit={(instance) => { rfInstanceRef.current = instance; }}
            // Disable xyflow's default 2× double-click zoom so the custom dblclick handler below
            // can own the gesture (fit-view-to-workflow — see flow-canvas-dblclick-trap).
            zoomOnDoubleClick={false}
            // Defaults are 0.5–2; widened to 0.1–4 so the canvas covers both "I'm lost, show me
            // everything" (zoom out far enough that the whole DAG is visible at once) and "let me
            // read the prompt textarea inside a node" (zoom in 2–3× without chained Ctrl+scroll).
            minZoom={0.1}
            maxZoom={4}
            // Enlarge the connection-snap radius so dragging an edge "near" a handle is enough —
            // the user doesn't have to pixel-hunt for the 8-px dot. The CSS below also bumps the
            // invisible hit target around each handle to ~24 px so initiating a drag is forgiving.
            connectionRadius={48}
            fitView
            fitViewOptions={{ padding: 0.15 }}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={20} size={1} color="#1f2937" />
            <Controls
              position="bottom-right"
              showInteractive={false}
              showZoom
              showFitView
              aria-label="画布缩放控制"
            />
            {/*
             * Minimap UX: the default xyflow minimap is tiny and the viewport rectangle is barely
             * visible, so the user can't tell where they are or which way to pan. We bump the size,
             * thicken + tint the viewport mask, and color-code nodes by kind. The wrapping div is
             * non-interactive (pointer-events pass through to the minimap itself) and just hosts a
             * clear caption + legend so a first-time user knows what they're looking at.
             *
             *   • 黄 = 角色/场景 (asset)   • 紫 = 分镜板   • 蓝 = 视频镜头   • 绿 = 拼接成片
             *   高亮的方框 = 你当前看到的范围 — 拖它移动画布，滚动它缩放
             */}
            <MiniMap
              pannable
              zoomable
              position="bottom-left"
              ariaLabel="画布缩略图"
              maskColor="rgba(15, 23, 42, 0.78)"
              maskStrokeColor="#fbbf24"
              maskStrokeWidth={3}
              bgColor="#0b1220"
              nodeStrokeColor="#0b1220"
              nodeStrokeWidth={2}
              nodeBorderRadius={4}
              style={{ width: 220, height: 150, borderRadius: 8, border: "1px solid #334155" }}
              nodeColor={(n) => {
                const k = (n.data as FlowNodeData)?.kind;
                if (k === "asset") return "#fbbf24";
                if (k === "storyboard") return "#a78bfa";
                if (k === "shot") return "#60a5fa";
                if (k === "stitch") return "#34d399";
                if (k === "referenceVideo") return "#f472b6";
                return "#6b7280";
              }}
            />
          </ReactFlow>
          <div className="flow-minimap-caption" aria-hidden="true">
            <strong>画布缩略图</strong>
            <small>
              <span className="legend-dot" style={{ background: "#fbbf24" }} />角色/场景
              <span className="legend-dot" style={{ background: "#a78bfa" }} />分镜板
              <span className="legend-dot" style={{ background: "#60a5fa" }} />视频
              <span className="legend-dot" style={{ background: "#34d399" }} />成片
            </small>
            <small className="flow-minimap-hint">
              <span className="viewport-swatch" />= 你看到的范围 · 拖动它移动画布
            </small>
          </div>
          <div className="flow-controls-caption" aria-hidden="true">
            <strong>缩放</strong>
            <small>＋ 放大 · − 缩小 · ⤢ 全景</small>
          </div>
          {/*
           * Double-click on the empty pane = fit-view to the whole workflow. This is the
           * "I'm lost, show me everything" gesture. xyflow's default 2× zoom-on-dblclick is
           * disabled (zoomOnDoubleClick={false} above) so this handler owns the gesture. Right-
           * click still opens CreateNodeMenu (onPaneContextMenu above), so node creation is not
           * lost. Double-click on a node card itself bubbles back unhandled — RF can do whatever
           * it wants there (currently nothing).
           */}
          <div
            className="flow-canvas-dblclick-trap"
            onDoubleClickCapture={(e) => {
              const target = e.target as HTMLElement;
              if (target.closest(".flow-node")) return;
              if (!target.closest(".react-flow__pane")) return;
              e.preventDefault();
              e.stopPropagation();
              rfInstanceRef.current?.fitView({ padding: 0.15, duration: 350 });
            }}
          />
          {/* Discoverability hint pinned bottom-center, faint, never blocks clicks. */}
          <div className="flow-canvas-hint" aria-hidden="true">
            双击空白 = 回到全景 · 右键空白 = 新建节点 · 滚轮缩放 0.1–4×
          </div>
        </div>
        {selectedData && (
          <Inspector
            selected={selectedData as FlowNodeData}
            session={session}
            allAssets={allAssets}
            visionReviewEnabled={visionReviewEnabled}
            onMutated={onMutated}
            onDeleteCanvasAsset={onDeleteCanvasAsset}
            onDeleteCanvasShot={onDeleteCanvasShot}
            onClose={() => setSelectedNodeId(undefined)}
          />
        )}
      </div>
      {createMenu && (
        <CreateNodeMenu
          x={createMenu.x}
          y={createMenu.y}
          onPick={handleMenuPick}
          onClose={() => setCreateMenu(null)}
        />
      )}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        style={{ display: "none" }}
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file) return;
          const placement = pendingFilePositionRef.current;
          pendingFilePositionRef.current = undefined;
          const asset = await onUploadImageAsset(file, pendingFileKindRef.current);
          if (asset) centerNodeAt(`asset-${asset.id}`, placement);
        }}
      />
      <input
        ref={videoInputRef}
        type="file"
        accept="video/*"
        style={{ display: "none" }}
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file) return;
          const placement = pendingFilePositionRef.current;
          pendingFilePositionRef.current = undefined;
          const asset = await onUploadReferenceVideo(file);
          if (asset) centerNodeAt(`refvideo-${asset.id}`, placement);
        }}
      />
      <DownloadToast />
    </div>
  );
}
