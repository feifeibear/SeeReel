import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  type Connection,
  type Edge,
  type Node,
  type OnNodesChange,
  type OnEdgesChange,
  type OnBeforeDelete,
  type ReactFlowInstance,
  type XYPosition,
  ConnectionMode,
  applyNodeChanges,
  applyEdgeChanges
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { api } from "../api";
import type { Asset, AssetImageModel, AssetType, SessionWithShots, Shot, StitchJob, StoreSnapshot } from "../../shared/types";
import { buildSessionGraph, visualNodeIdForAsset, type FlowNodeData } from "./buildGraph";
import { AssetNode, AudioTrackNode, MusicNode, ReferenceVideoNode, VideoAssetNode, VideoProcessorNode, StoryboardNode, ShotNode, StitchNode, TailframeNode, VoiceNode } from "./nodes";
import { Inspector } from "./Inspector";
import { DownloadToast } from "./DownloadToast";
import { CreateNodeMenu, type CreateMenuOption } from "./CreateNodeMenu";
import { resolveCanvasCreatePosition } from "./canvasPosition";
import { buildPendingConnectEdge, mergePendingEdges } from "./pendingConnection";
import type { UndoableAction } from "./useUndoStack";
import { useI18n, type UiLanguage } from "../i18n";

type AnchorKind = Extract<AssetType, "image" | "character" | "scene" | "prop" | "style" | "voice" | "music"> | "moodboard";
export type UploadImageAssetResult = Asset | {
  asset: Asset;
  completed?: Promise<Asset | undefined>;
};

function normalizeUploadImageAssetResult(result: UploadImageAssetResult | undefined) {
  if (!result) return undefined;
  if ("asset" in result) return result;
  return { asset: result };
}

const nodeTypes = {
  assetNode: AssetNode,
  moodboardNode: AssetNode,
  imageNode: AssetNode,
  storyboardNode: StoryboardNode,
  shotNode: ShotNode,
  stitchNode: StitchNode,
  voiceNode: VoiceNode,
  musicNode: MusicNode,
  audioTrackNode: AudioTrackNode,
  referenceVideoNode: ReferenceVideoNode,
  videoAssetNode: VideoAssetNode,
  videoProcessorNode: VideoProcessorNode,
  tailframeNode: TailframeNode
};

const MemoInspector = memo(Inspector);

const flowProOptions = { hideAttribution: true };

function isAssetBackedNodeData(data: FlowNodeData): data is Extract<FlowNodeData, { asset: Asset }> {
  return data.kind === "image"
    || data.kind === "asset"
    || data.kind === "voice"
    || data.kind === "music"
    || data.kind === "referenceVideo"
    || data.kind === "videoAsset"
    || data.kind === "videoProcessor"
    || data.kind === "tailframe";
}

export interface FlowViewProps {
  snapshot: StoreSnapshot;
  session: SessionWithShots | undefined;
  visionReviewEnabled: boolean;
  defaultImageModel?: AssetImageModel;
  onMutated: () => Promise<void> | void;
  onCreateAnchorAsset: (kind: AnchorKind) => Promise<Asset | undefined> | Asset | undefined;
  onCreateShot: () => Promise<Shot | undefined> | Shot | undefined;
  onCreateStitchJob?: () => Promise<StitchJob | undefined> | StitchJob | undefined;
  onSetStitchOrder: (jobId: string, shotIds: string[], legacy?: boolean) => Promise<void> | void;
  onDeleteCanvasAsset: (asset: Asset) => Promise<boolean> | boolean;
  onDeleteCanvasShot: (shot: Shot) => Promise<boolean> | boolean;
  onUploadImageAsset: (file: File, kind: "image" | "character" | "scene") => Promise<UploadImageAssetResult | undefined> | UploadImageAssetResult | undefined;
  /** Drop a video file onto the canvas → upload + auto-trigger reference-video analysis. */
  onUploadReferenceVideo: (file: File) => Promise<Asset | undefined> | Asset | undefined;
  onPushUndo?: (action: UndoableAction) => void;
  /** Canvas-level undo / redo wired to the App-level useUndoStack. Disabled when stack is empty. */
  undo?: () => Promise<void> | void;
  redo?: () => Promise<void> | void;
  canUndo?: boolean;
  canRedo?: boolean;
  undoDescription?: string;
  redoDescription?: string;
  toolbarPrimaryAction?: ReactNode;
}

function legacyStitchJobForSession(session: SessionWithShots): StitchJob {
  return {
    id: "legacy",
    name: "完整视频",
    shotIds: session.stitchShotIds || [],
    status: session.stitchStatus,
    progress: session.stitchProgress,
    error: session.stitchError,
    finalVideoUrl: session.finalVideoUrl,
    finalVideoSignature: session.finalVideoSignature,
    finalVideoGeneratedAt: session.finalVideoGeneratedAt,
    finalVideoReviewStatus: session.finalVideoReviewStatus,
    finalVideoReview: session.finalVideoReview,
    finalVideoReviewError: session.finalVideoReviewError,
    finalVideoReviewUpdatedAt: session.finalVideoReviewUpdatedAt,
    finalVideoReviewRunningSignature: session.finalVideoReviewRunningSignature,
    finalVideoReviewBuiltForSignature: session.finalVideoReviewBuiltForSignature,
    runningSignature: session.stitchRunningSignature,
    startedAt: session.stitchStartedAt,
    updatedAt: session.stitchUpdatedAt,
    createdAt: session.createdAt
  };
}

export function FlowView({ snapshot, session, visionReviewEnabled, defaultImageModel, onMutated, onCreateAnchorAsset, onCreateShot, onCreateStitchJob, onSetStitchOrder, onDeleteCanvasAsset, onDeleteCanvasShot, onUploadImageAsset, onUploadReferenceVideo, onPushUndo, undo, redo, canUndo, canRedo, undoDescription, redoDescription, toolbarPrimaryAction }: FlowViewProps) {
  const { lang, t } = useI18n();
  const allAssets = snapshot.assets;
  const { nodes: derivedNodes, edges: derivedEdges } = useMemo(() => {
    if (!session) return { nodes: [] as Node<FlowNodeData>[], edges: [] as Edge[] };
    return buildSessionGraph(snapshot, session);
  }, [snapshot, session]);

  const [nodes, setNodes] = useState<Node<FlowNodeData>[]>(derivedNodes);
  const [edges, setEdges] = useState<Edge[]>(derivedEdges);
  const nodesRef = useRef<Node<FlowNodeData>[]>(derivedNodes);
  const [selectedNodeId, setSelectedNodeId] = useState<string | undefined>();
  const [showFinalVideoPanel, setShowFinalVideoPanel] = useState(false);
  // Floating "新建节点" menu position. Right-click summons it; null hides it.
  const [createMenu, setCreateMenu] = useState<{ x: number; y: number; flowPosition?: XYPosition } | null>(null);
  const [creatingKind, setCreatingKind] = useState<string>("");
  // Hidden file input pulled from the canvas surface for the "上传图" menu option and drop-on-canvas.
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const videoInputRef = useRef<HTMLInputElement | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const pendingFileKindRef = useRef<"image" | "character" | "scene">("image");
  const pendingFilePositionRef = useRef<XYPosition | undefined>(undefined);
  const guardCreate = useCallback((kind: string, fn: () => unknown | Promise<unknown>) => {
    if (creatingKind) return;
    setCreatingKind(kind);
    void Promise.resolve(fn())
      .catch((error: unknown) => {
        window.alert(`${lang === "en" ? "Create failed" : "创建失败"}：${error instanceof Error ? error.message : "未知错误"}`);
      })
      .finally(() => setCreatingKind(""));
  }, [creatingKind, lang]);

  // Edge ids that the user has just deleted but the server hasn't yet acknowledged. Held in a
  // ref so a stray re-render of derivedEdges (e.g. from an unrelated snapshot refresh racing with
  // our PATCH) doesn't reanimate the edge during the await window. Cleared after onMutated returns.
  const pendingDeletionsRef = useRef<Set<string>>(new Set());
  const pendingNodeDeletionsRef = useRef<Set<string>>(new Set());
  const pendingCreatedPositionsRef = useRef<Map<string, XYPosition>>(new Map());
  const pendingConnectEdgesRef = useRef<Map<string, Edge>>(new Map());
  const rfInstanceRef = useRef<ReactFlowInstance<Node<FlowNodeData>, Edge> | null>(null);

  const flowPositionFromClient = useCallback((x: number, y: number): XYPosition | undefined => {
    return resolveCanvasCreatePosition({
      clientX: x,
      clientY: y,
      canvasRect: canvasRef.current?.getBoundingClientRect(),
      screenToFlowPosition: rfInstanceRef.current?.screenToFlowPosition
    });
  }, []);

  const placeNodeAt = useCallback((nodeId: string, position: XYPosition | undefined) => {
    if (!position) return;
    pendingCreatedPositionsRef.current.set(nodeId, position);
    setNodes((prev) => {
      const nextNodes = prev.map((node) => (node.id === nodeId ? { ...node, position } : node));
      nodesRef.current = nextNodes;
      return nextNodes;
    });
  }, []);

  const persistCreatedNodePosition = useCallback(async (nodeId: string, position: XYPosition | undefined) => {
    if (!session || !position) return;
    const canvasNodePositions = {
      ...(session.canvasNodePositions || {}),
      ...Object.fromEntries(
        nodesRef.current.map((node) => [node.id, { x: node.position.x, y: node.position.y }])
      ),
      [nodeId]: { x: position.x, y: position.y }
    };
    await api.updateSession(session.id, { canvasNodePositions });
  }, [session]);

  const centerUploadImageResult = useCallback((result: UploadImageAssetResult | undefined, placement?: XYPosition) => {
    const upload = normalizeUploadImageAssetResult(result);
    if (!upload) return;
    placeNodeAt(`asset-${upload.asset.id}`, placement);
    void persistCreatedNodePosition(`asset-${upload.asset.id}`, placement);
    if (upload.completed) {
      void upload.completed.then((asset) => {
        if (asset) {
          placeNodeAt(`asset-${asset.id}`, placement);
          void persistCreatedNodePosition(`asset-${asset.id}`, placement);
        }
      });
    }
  }, [persistCreatedNodePosition, placeNodeAt]);

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
      const nextNodes = merged.filter((node) => !pendingNodeDeletionsRef.current.has(node.id));
      nodesRef.current = nextNodes;
      return nextNodes;
    });
    const visibleDerivedEdges = derivedEdges.filter((e) =>
      !pendingDeletionsRef.current.has(e.id) &&
      !pendingNodeDeletionsRef.current.has(e.source) &&
      !pendingNodeDeletionsRef.current.has(e.target)
    );
    const visiblePendingEdges = Array.from(pendingConnectEdgesRef.current.values()).filter((e) =>
      !pendingDeletionsRef.current.has(e.id) &&
      !pendingNodeDeletionsRef.current.has(e.source) &&
      !pendingNodeDeletionsRef.current.has(e.target)
    );
    setEdges(mergePendingEdges(visibleDerivedEdges, visiblePendingEdges));
  }, [derivedNodes, derivedEdges]);

  // Listen for in-node mutations (model picker, etc.) that bypass the prop chain — they emit
  // a window 'flow-mutated' event after their PATCH so we can pull a fresh snapshot.
  useEffect(() => {
    const onMutatedEvent = () => { void onMutated(); };
    window.addEventListener("flow-mutated", onMutatedEvent);
    return () => window.removeEventListener("flow-mutated", onMutatedEvent);
  }, [onMutated]);

  const onNodesChange = useCallback<OnNodesChange<Node<FlowNodeData>>>((changes) => {
    setNodes((nds) => {
      const nextNodes = applyNodeChanges(changes, nds);
      nodesRef.current = nextNodes;
      return nextNodes;
    });
  }, []);
  const persistCanvasNodePositions = useCallback(() => {
    if (!session) return;
    const canvasNodePositions = Object.fromEntries(
      nodesRef.current.map((node) => [node.id, { x: node.position.x, y: node.position.y }])
    );
    void api.updateSession(session.id, { canvasNodePositions })
      .then(() => { void onMutated(); })
      .catch((error: Error) => {
        window.alert(`${lang === "en" ? "Layout save failed" : "布局保存失败"}：${error.message}`);
      });
  }, [lang, onMutated, session]);
  const onEdgesChange = useCallback<OnEdgesChange>((changes) => {
    setEdges((eds) => applyEdgeChanges(changes, eds));
  }, []);

  const onNodeClick = useCallback((_: unknown, node: Node<FlowNodeData>) => {
    setSelectedNodeId(node.id);
    setShowFinalVideoPanel(false);
    setCreateMenu(null);
  }, []);

  const onPaneClick = useCallback(() => {
    setSelectedNodeId(undefined);
    setShowFinalVideoPanel(false);
    setCreateMenu(null);
  }, []);

  const onPaneContextMenu = useCallback((event: React.MouseEvent | MouseEvent) => {
    const evt = event as MouseEvent;
    evt.preventDefault();
    setCreateMenu({ x: evt.clientX, y: evt.clientY, flowPosition: flowPositionFromClient(evt.clientX, evt.clientY) });
  }, [flowPositionFromClient]);

  const onNodeContextMenu = useCallback((event: React.MouseEvent) => {
    onPaneContextMenu(event);
  }, [onPaneContextMenu]);

  const onInit = useCallback((instance: ReactFlowInstance<Node<FlowNodeData>, Edge>) => {
    rfInstanceRef.current = instance;
  }, []);

  const beginPendingConnect = useCallback((connection: Connection) => {
    if (!session) return undefined;
    const pendingEdge = buildPendingConnectEdge({
      connection,
      session,
      snapshot,
      targetNodeData: nodesRef.current.find((node) => node.id === connection.target)?.data
    });
    if (!pendingEdge) return undefined;
    pendingConnectEdgesRef.current.set(pendingEdge.id, pendingEdge);
    setEdges((prev) => mergePendingEdges(prev, [pendingEdge]));
    return pendingEdge.id;
  }, [session, snapshot]);

  const clearPendingConnect = useCallback((edgeId: string | undefined, removeVisible: boolean) => {
    if (!edgeId) return;
    pendingConnectEdgesRef.current.delete(edgeId);
    if (removeVisible) setEdges((prev) => prev.filter((edge) => edge.id !== edgeId));
  }, []);

  const runConnectMutation = useCallback(async (connection: Connection, mutation: () => Promise<void>) => {
    const pendingEdgeId = beginPendingConnect(connection);
    try {
      await mutation();
      clearPendingConnect(pendingEdgeId, false);
    } catch (error) {
      clearPendingConnect(pendingEdgeId, true);
      throw error;
    }
  }, [beginPendingConnect, clearPendingConnect]);

  useEffect(() => {
    setSelectedNodeId(undefined);
    setShowFinalVideoPanel(false);
    setCreateMenu(null);
    setCreatingKind("");
    pendingCreatedPositionsRef.current.clear();
    void rfInstanceRef.current?.setViewport({ x: 0, y: 0, zoom: 1 });
  }, [session?.id]);

  const onCanvasDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (e.dataTransfer.types.includes("Files")) e.preventDefault();
  }, []);

  const closeInspector = useCallback(() => {
    setSelectedNodeId(undefined);
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
   *   5. Stitch → Audio:    opt-in post-production audio-track wiring. Audio tracks are separate
   *      nodes and are not part of the final chain unless this edge is explicit.
   *
   * Connections that don't match any pattern are silently rejected.
   */
  const onConnect = useCallback(async (conn: Connection) => {
    if (!session) return;
    const src = conn.source || "";
    const tgt = conn.target || "";
    const isFrameAnchorNode = (nodeId: string) => nodeId.startsWith("frame-anchor-") || nodeId.startsWith("tailframe-");
    const isVisualAssetNode = (nodeId: string) => nodeId.startsWith("image-") || nodeId.startsWith("asset-") || nodeId.startsWith("moodboard-") || isFrameAnchorNode(nodeId);
    const assetIdFromVisualNode = (nodeId: string) => {
      if (nodeId.startsWith("frame-anchor-")) return nodeId.slice("frame-anchor-".length);
      if (nodeId.startsWith("tailframe-")) return nodeId.slice("tailframe-".length);
      if (nodeId.startsWith("image-")) return nodeId.slice("image-".length);
      if (nodeId.startsWith("asset-")) return nodeId.slice("asset-".length);
      if (nodeId.startsWith("moodboard-")) return nodeId.slice("moodboard-".length);
      return "";
    };
    const resolveVisualReferenceSource = () => {
      if (isVisualAssetNode(src)) {
        const assetId = assetIdFromVisualNode(src);
        const asset = snapshot.assets.find((item) => item.id === assetId);
        const isFrameAnchor = (asset?.tags || []).includes("tailframe") || (asset?.tags || []).includes("frame-anchor");
        return asset && !isFrameAnchor ? asset : undefined;
      }
      if (src.startsWith("storyboard-")) {
        const ownerShotId = src.slice("storyboard-".length);
        const ownerShot = (session.shots || []).find((shot) => shot.id === ownerShotId);
        const storyboardAssetId = ownerShot?.subShotStoryboardAssetId;
        return storyboardAssetId ? snapshot.assets.find((asset) => asset.id === storyboardAssetId) : undefined;
      }
      return undefined;
    };

    if (isVisualAssetNode(src) && tgt.startsWith("shot-")) {
      const assetId = assetIdFromVisualNode(src);
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
          referenceClipPreviewUrl: liveBeforeShot?.referenceClipPreviewUrl ?? null,
          referenceAudioPreviewUrl: liveBeforeShot?.referenceAudioPreviewUrl ?? null,
          usePreviousShotClip: liveBeforeShot?.usePreviousShotClip || false
        };
        const apply = async () => api.updateShot(targetShotId, {
          firstFrameAssetId: assetId,
          referenceVideoAssetId: "",
          referenceVideoFromShotId: "",
          referenceClipUrl: null,
          referenceAudioUrl: null,
          referenceClipPreviewUrl: null,
          referenceAudioPreviewUrl: null,
          usePreviousShotClip: false
        });
        const revert = async () => api.updateShot(targetShotId, previous);
        await runConnectMutation(conn, async () => {
          await apply();
          onPushUndo?.({
            description: "连接尾帧到镜头首帧",
            undo: async () => { await revert(); await onMutated(); },
            redo: async () => { await apply(); await onMutated(); }
          });
          await onMutated();
        });
        return;
      }
    }

    if ((isVisualAssetNode(src) || src.startsWith("storyboard-")) && (isVisualAssetNode(tgt) || tgt.startsWith("storyboard-"))) {
      const sourceAsset = resolveVisualReferenceSource();
      if (!sourceAsset) return;
      if (isVisualAssetNode(tgt)) {
        const targetAssetId = assetIdFromVisualNode(tgt);
        if (targetAssetId === sourceAsset.id) return;
        const targetAsset = snapshot.assets.find((asset) => asset.id === targetAssetId);
        if (!targetAsset) return;
        const current = targetAsset.referenceAssetIds || [];
        if (current.includes(sourceAsset.id)) return;
        const apply = async () => {
          const live = await api.state();
          const liveAsset = live.assets.find((asset) => asset.id === targetAssetId);
          const liveIds = liveAsset?.referenceAssetIds || [];
          return api.saveAsset({
            id: targetAssetId,
            referenceAssetIds: liveIds.includes(sourceAsset.id) ? liveIds : [...liveIds, sourceAsset.id]
          });
        };
        const revert = async () => {
          const live = await api.state();
          const liveAsset = live.assets.find((asset) => asset.id === targetAssetId);
          const liveIds = liveAsset?.referenceAssetIds || [];
          return api.saveAsset({
            id: targetAssetId,
            referenceAssetIds: liveIds.filter((id) => id !== sourceAsset.id)
          });
        };
        await runConnectMutation(conn, async () => {
          await apply();
          onPushUndo?.({
            description: "连接图像参考到资产",
            undo: async () => { await revert(); await onMutated(); },
            redo: async () => { await apply(); await onMutated(); }
          });
          await onMutated();
        });
        return;
      }
      if (tgt.startsWith("storyboard-")) {
        const targetShotId = tgt.slice("storyboard-".length);
        const targetShot = (session.shots || []).find((shot) => shot.id === targetShotId);
        if (!targetShot || targetShot.subShotStoryboardAssetId === sourceAsset.id) return;
        const current = targetShot.assetIds || [];
        if (current.includes(sourceAsset.id)) return;
        const apply = async () => {
          const live = await api.state();
          const liveShot = live.shots.find((shot) => shot.id === targetShotId);
          const liveIds = liveShot?.assetIds || [];
          return api.updateShot(targetShotId, {
            assetIds: liveIds.includes(sourceAsset.id) ? liveIds : [...liveIds, sourceAsset.id],
            subShotPanelCount: liveShot?.subShotPanelCount && liveShot.subShotPanelCount > 1 ? liveShot.subShotPanelCount : 9
          });
        };
        const revert = async () => {
          const live = await api.state();
          const liveShot = live.shots.find((shot) => shot.id === targetShotId);
          const liveIds = liveShot?.assetIds || [];
          return api.updateShot(targetShotId, { assetIds: liveIds.filter((id) => id !== sourceAsset.id) });
        };
        await runConnectMutation(conn, async () => {
          await apply();
          onPushUndo?.({
            description: "连接图像参考到分镜板",
            undo: async () => { await revert(); await onMutated(); },
            redo: async () => { await apply(); await onMutated(); }
          });
          await onMutated();
        });
        return;
      }
    }

    if (isVisualAssetNode(src) && (tgt.startsWith("storyboard-") || tgt.startsWith("shot-"))) {
      const assetId = assetIdFromVisualNode(src);
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
      await runConnectMutation(conn, async () => {
        await apply();
        onPushUndo?.({
          description: "连接资产到分镜",
          undo: async () => { await revert(); await onMutated(); },
          redo: async () => { await apply(); await onMutated(); }
        });
        await onMutated();
      });
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
      await runConnectMutation(conn, async () => {
        await apply();
        onPushUndo?.({
          description: "连接分镜板到镜头",
          undo: async () => { await revert(); await onMutated(); },
          redo: async () => { await apply(); await onMutated(); }
        });
        await onMutated();
      });
      return;
    }

    if ((src.startsWith("refvideo-") || src.startsWith("videoproc-") || src.startsWith("video-")) && tgt.startsWith("shot-")) {
      const refAssetId = src.startsWith("refvideo-")
        ? src.slice("refvideo-".length)
        : src.startsWith("videoproc-")
          ? src.slice("videoproc-".length)
          : src.slice("video-".length);
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
        referenceClipPreviewUrl: liveBeforeShot?.referenceClipPreviewUrl ?? null,
        referenceAudioPreviewUrl: liveBeforeShot?.referenceAudioPreviewUrl ?? null,
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
        referenceClipPreviewUrl: null,
        referenceAudioPreviewUrl: null,
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
      await runConnectMutation(conn, async () => {
        await apply();
        onPushUndo?.({
          description: "连接参考视频到镜头",
          undo: async () => { await revert(); await onMutated(); },
          redo: async () => { await apply(); await onMutated(); }
        });
        await onMutated();
      });
      return;
    }

    if ((isFrameAnchorNode(src) || src.startsWith("asset-")) && tgt.startsWith("shot-")) {
      const assetId = isFrameAnchorNode(src) ? assetIdFromVisualNode(src) : src.slice("asset-".length);
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
        referenceClipPreviewUrl: liveBeforeShot?.referenceClipPreviewUrl ?? null,
        referenceAudioPreviewUrl: liveBeforeShot?.referenceAudioPreviewUrl ?? null,
        usePreviousShotClip: liveBeforeShot?.usePreviousShotClip || false
      };
      const apply = async () => api.updateShot(targetShotId, {
        firstFrameAssetId: assetId,
        referenceVideoAssetId: "",
        referenceVideoFromShotId: "",
        referenceClipUrl: null,
        referenceAudioUrl: null,
        referenceClipPreviewUrl: null,
        referenceAudioPreviewUrl: null,
        usePreviousShotClip: false
      });
      const revert = async () => api.updateShot(targetShotId, previous);
      await runConnectMutation(conn, async () => {
        await apply();
        onPushUndo?.({
          description: "连接尾帧到镜头首帧",
          undo: async () => { await revert(); await onMutated(); },
          redo: async () => { await apply(); await onMutated(); }
        });
        await onMutated();
      });
      return;
    }

    if (src.startsWith("stitch-") && tgt.startsWith("audio-")) {
      const source = nodesRef.current.find((node) => node.id === src)?.data;
      const target = nodesRef.current.find((node) => node.id === tgt)?.data;
      if (!source || source.kind !== "stitch" || !target || target.kind !== "audioTrack") return;
      if (source.session.id !== session.id || target.session.id !== session.id) return;
      if (source.job.id !== target.job.id) return;
      const jobId = target.job.id;
      if ((session.audioTrackStitchJobIds || []).includes(jobId)) return;
      const apply = async () => {
        const live = await api.state();
        const liveSession = live.sessions.find((item) => item.id === session.id);
        const liveIds = liveSession?.audioTrackStitchJobIds || [];
        return api.updateSession(session.id, {
          audioTrackHidden: false,
          audioTrackStitchJobIds: liveIds.includes(jobId) ? liveIds : [...liveIds, jobId]
        });
      };
      const revert = async () => {
        const live = await api.state();
        const liveSession = live.sessions.find((item) => item.id === session.id);
        const liveIds = liveSession?.audioTrackStitchJobIds || [];
        return api.updateSession(session.id, {
          audioTrackStitchJobIds: liveIds.filter((id) => id !== jobId)
        });
      };
      await runConnectMutation(conn, async () => {
        await apply();
        onPushUndo?.({
          description: "连接拼接到音轨",
          undo: async () => { await revert(); await onMutated(); },
          redo: async () => { await apply(); await onMutated(); }
        });
        await onMutated();
      });
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
      const liveBefore = await api.state();
      const liveBeforeShot = liveBefore.shots.find((s) => s.id === tgtShotId);
      // Server expects "" for clearable fields when blanking; `null` for clearable string fields.
      const previous = {
        referenceVideoFromShotId: liveBeforeShot?.referenceVideoFromShotId || "",
        // Also restore the asset path + clip url since we're going to clear them on apply.
        referenceVideoAssetId: liveBeforeShot?.referenceVideoAssetId || "",
        referenceClipUrl: liveBeforeShot?.referenceClipUrl ?? null,
        referenceAudioUrl: liveBeforeShot?.referenceAudioUrl ?? null,
        referenceClipPreviewUrl: liveBeforeShot?.referenceClipPreviewUrl ?? null,
        referenceAudioPreviewUrl: liveBeforeShot?.referenceAudioPreviewUrl ?? null,
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
        referenceAudioUrl: null,
        referenceClipPreviewUrl: null,
        referenceAudioPreviewUrl: null,
        firstFrameAssetId: "",
        lastFrameAssetId: "",
        subShotStoryboardAssetId: "",
        subShotStoryboardAssetIds: [],
        subShotPanelCount: 0
      });
      const revert = async () => api.updateShot(tgtShotId, previous);
      await runConnectMutation(conn, async () => {
        await apply();
        onPushUndo?.({
          description: "把上游镜头的视频接到下一镜（reference_video）",
          undo: async () => { await revert(); await onMutated(); },
          redo: async () => { await apply(); await onMutated(); }
        });
        await onMutated();
      });
      return;
    }
  }, [session, onMutated, onPushUndo, runConnectMutation, snapshot.assets]);

  /**
   * Edge-deletion handler: dispatches by `data` shape:
   *   - `canDisconnect`            → asset→storyboard intent edge → strip from `shot.assetIds`
   *   - `canDisconnectStoryboard`  → storyboard→shot edge → strip from `shot.subShotStoryboardAssetIds`.
   *     Additionally when the deleted edge is the *primary* (own-shot) one we clear the legacy
   *     singular `subShotStoryboardAssetId` too, otherwise the renderer's sub-shot-mode check still
   *     activates and re-references the asset.
   *   - `canDisconnectRefVideo`    → refvideo→shot edge → clear `referenceVideoAssetId` and
   *     `referenceClipUrl` together so the next regen drops Seedance reference_video.
   *   - `canDisconnectAudioTrack` → stitch→audio edge → remove that stitch job from explicit
   *     post-production audio-track wiring.
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
    type AssetReferenceEdgeData = {
      canDisconnectAssetReference?: boolean;
      sourceAssetId?: string;
      targetAssetId?: string;
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
    type AudioTrackEdgeData = {
      canDisconnectAudioTrack?: boolean;
      stitchJobId?: string;
    };

    const assetRemovals = deleted
      .map((edge) => edge.data as AssetEdgeData | undefined)
      .filter((d): d is AssetEdgeData & { assetId: string; shotId: string } => Boolean(d?.canDisconnect && d.assetId && d.shotId));
    const assetReferenceRemovals = deleted
      .map((edge) => edge.data as AssetReferenceEdgeData | undefined)
      .filter((d): d is Required<AssetReferenceEdgeData> =>
        Boolean(d?.canDisconnectAssetReference && d.sourceAssetId && d.targetAssetId));
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
    const audioTrackRemovals = deleted
      .map((edge) => edge.data as AudioTrackEdgeData | undefined)
      .filter((d): d is Required<AudioTrackEdgeData> => Boolean(d?.canDisconnectAudioTrack && d.stitchJobId));
    const derivedClipRemovals = deleted
      .map((edge) => edge.data as DerivedClipEdgeData | undefined)
      .filter((d): d is Required<DerivedClipEdgeData> => Boolean(d?.canDisconnectDerivedClip && d.sourceAssetId && d.derivedAssetId));

    if (!assetRemovals.length && !assetReferenceRemovals.length && !storyboardRemovals.length && !refVideoRemovals.length && !shotRefRemovals.length && !firstFrameRemovals.length && !stitchRemovals.length && !audioTrackRemovals.length && !derivedClipRemovals.length) return;

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
    const assetReferenceDrops = new Map<string, Set<string>>();
    for (const r of assetReferenceRemovals) {
      const entry = assetReferenceDrops.get(r.targetAssetId) || new Set<string>();
      entry.add(r.sourceAssetId);
      assetReferenceDrops.set(r.targetAssetId, entry);
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
        referenceAudioUrl: shot.referenceAudioUrl ?? null,
        referenceClipPreviewUrl: shot.referenceClipPreviewUrl ?? null,
        referenceAudioPreviewUrl: shot.referenceAudioPreviewUrl ?? null,
        referenceVideoFromShotId: shot.referenceVideoFromShotId,
        firstFrameAssetId: shot.firstFrameAssetId
      } : undefined] as const;
    }));
    const beforeStitchShotIds = [...(session.stitchShotIds || [])];
    const beforeAudioTrackStitchJobIds = [...(session.audioTrackStitchJobIds || [])];
    const stitchRemovalIds = new Set(stitchRemovals.filter((item) => !item.stitchJobId || item.stitchJobId === "legacy").map((item) => item.stitchShotId));
    const stitchRemovalIdsByJob = new Map<string, Set<string>>();
    for (const item of stitchRemovals) {
      if (!item.stitchJobId || item.stitchJobId === "legacy") continue;
      const set = stitchRemovalIdsByJob.get(item.stitchJobId) || new Set<string>();
      set.add(item.stitchShotId);
      stitchRemovalIdsByJob.set(item.stitchJobId, set);
    }
    const beforeStitchJobs = new Map((session.stitchJobs || []).map((job) => [job.id, { ...job, shotIds: [...(job.shotIds || [])] }]));
    const audioTrackRemovalIds = new Set(audioTrackRemovals.map((item) => item.stitchJobId));
    const beforeByAsset = new Map(Array.from(new Set([
      ...Array.from(storyboardAssetRefDrops.keys()),
      ...Array.from(assetReferenceDrops.keys()),
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
          patch.referenceAudioUrl = null;
          patch.referenceClipPreviewUrl = null;
          patch.referenceAudioPreviewUrl = null;
        }
        if (drop.drop_shot_ref) {
          // Clear cross-shot wiring (shot.referenceVideoFromShotId).
          patch.referenceVideoFromShotId = "";
          patch.referenceClipUrl = null;
          patch.referenceAudioUrl = null;
          patch.referenceClipPreviewUrl = null;
          patch.referenceAudioPreviewUrl = null;
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
      await Promise.all(Array.from(assetReferenceDrops.entries()).map(([assetId, dropIds]) => {
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
      if (audioTrackRemovalIds.size) {
        await api.updateSession(session.id, {
          audioTrackStitchJobIds: beforeAudioTrackStitchJobIds.filter((id) => !audioTrackRemovalIds.has(id))
        });
      }
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
          if (audioTrackRemovalIds.size) {
            await api.updateSession(session.id, {
              audioTrackStitchJobIds: beforeAudioTrackStitchJobIds
            });
          }
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
              patch.referenceAudioUrl = null;
              patch.referenceClipPreviewUrl = null;
              patch.referenceAudioPreviewUrl = null;
            }
            if (drop.drop_shot_ref) {
              patch.referenceVideoFromShotId = "";
              patch.referenceClipUrl = null;
              patch.referenceAudioUrl = null;
              patch.referenceClipPreviewUrl = null;
              patch.referenceAudioPreviewUrl = null;
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
          await Promise.all(Array.from(assetReferenceDrops.entries()).map(([assetId, dropIds]) => {
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
          if (audioTrackRemovalIds.size) {
            const liveSession = live.sessions.find((item) => item.id === session.id);
            const liveIds = liveSession?.audioTrackStitchJobIds || [];
            await api.updateSession(session.id, {
              audioTrackStitchJobIds: liveIds.filter((id) => !audioTrackRemovalIds.has(id))
            });
          }
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
    if (showFinalVideoPanel && session) {
      return {
        kind: "stitch",
        session,
        job: legacyStitchJobForSession(session),
        legacy: true
      } satisfies FlowNodeData;
    }
    const node = nodes.find((n) => n.id === selectedNodeId);
    return node?.data;
  }, [nodes, selectedNodeId, session, showFinalVideoPanel]);

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
      if (isAssetBackedNodeData(data)) {
        return data.asset.name || data.asset.id;
      }
      if (data.kind === "shot") return data.shot.title || `Shot ${data.shot.index}`;
      if (data.kind === "storyboard") return `分镜板 · ${data.shot.title || `Shot ${data.shot.index}`}`;
      if (data.kind === "stitch") return data.job.name || `拼接节点 ${data.job.id}`;
      if (data.kind === "audioTrack") return "添加音轨节点";
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
          if (isAssetBackedNodeData(data)) {
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
          } else if (data.kind === "audioTrack") {
            const sessionId = data.session.id;
            const before = {
              audioTrackHidden: data.session.audioTrackHidden,
              audioTrackStitchJobIds: data.session.audioTrackStitchJobIds ? [...data.session.audioTrackStitchJobIds] : undefined
            };
            await api.updateSession(sessionId, {
              audioTrackHidden: true,
              audioTrackStitchJobIds: (data.session.audioTrackStitchJobIds || []).filter((id) => id !== data.job.id)
            });
            ok = true;
            onPushUndo?.({
              description: "删除添加音轨节点",
              undo: async () => { await api.updateSession(sessionId, before); await onMutated(); },
              redo: async () => {
                await api.updateSession(sessionId, {
                  audioTrackHidden: true,
                  audioTrackStitchJobIds: (before.audioTrackStitchJobIds || []).filter((id) => id !== data.job.id)
                });
                await onMutated();
              }
            });
          }
          if (!ok) {
            pendingNodeDeletionsRef.current.delete(node.id);
            setNodes((prev) => {
              const nextNodes = prev.some((item) => item.id === node.id) ? prev : [...prev, node];
              nodesRef.current = nextNodes;
              return nextNodes;
            });
          }
        } catch (error) {
          pendingNodeDeletionsRef.current.delete(node.id);
          setNodes((prev) => {
            const nextNodes = prev.some((item) => item.id === node.id) ? prev : [...prev, node];
            nodesRef.current = nextNodes;
            return nextNodes;
          });
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
   * stages an image upload, then triggers the hidden file input — its onChange handler runs the upload.
   */
  const handleMenuPick = useCallback(async (option: CreateMenuOption) => {
    const placement = createMenu?.flowPosition;
    setCreateMenu(null);
    if (option === "image") {
      return guardCreate("image", async () => {
        const asset = await onCreateAnchorAsset("image");
        if (asset) {
          const nodeId = visualNodeIdForAsset(asset) || `image-${asset.id}`;
          placeNodeAt(nodeId, placement);
          await persistCreatedNodePosition(nodeId, placement);
        }
      });
    }
    if (option === "storyboard") {
      return guardCreate("storyboard", async () => {
        const shot = await onCreateShot();
        if (!shot) return;
        await api.updateShot(shot.id, { subShotPanelCount: 9 });
        const nodeId = `storyboard-${shot.id}`;
        placeNodeAt(nodeId, placement);
        await persistCreatedNodePosition(nodeId, placement);
        await onMutated();
      });
    }
    if (option === "shot") {
      return guardCreate("shot", async () => {
        const shot = await onCreateShot();
        if (shot) {
          const nodeId = `shot-${shot.id}`;
          placeNodeAt(nodeId, placement);
          await persistCreatedNodePosition(nodeId, placement);
        }
      });
    }
    if (option === "stitch") {
      return guardCreate("stitch", async () => {
        if (!session) return;
        const job = onCreateStitchJob ? await onCreateStitchJob() : undefined;
        const nodeId = job ? `stitch-${session.id}-${job.id}` : `stitch-${session.id}-legacy`;
        if (!job && session.stitchHidden) {
          await api.updateSession(session.id, { stitchHidden: false });
        }
        placeNodeAt(nodeId, placement);
        await persistCreatedNodePosition(nodeId, placement);
        await onMutated();
      });
    }
    if (option === "audioTrack") {
      return guardCreate("audioTrack", async () => {
        if (!session) return;
        await api.updateSession(session.id, {
          audioTrackHidden: false,
          audioTrackStitchJobIds: Array.from(new Set([...(session.audioTrackStitchJobIds || []), "legacy"]))
        });
        placeNodeAt("audio-legacy", placement);
        await persistCreatedNodePosition("audio-legacy", placement);
        await onMutated();
      });
    }
    if (option === "voice") {
      return guardCreate("voice", async () => {
        const asset = await onCreateAnchorAsset("voice");
        if (asset) {
          const nodeId = `voice-${asset.id}`;
          placeNodeAt(nodeId, placement);
          await persistCreatedNodePosition(nodeId, placement);
        }
      });
    }
    if (option === "music") {
      return guardCreate("music", async () => {
        const asset = await onCreateAnchorAsset("music");
        if (asset) {
          const nodeId = `music-${asset.id}`;
          placeNodeAt(nodeId, placement);
          await persistCreatedNodePosition(nodeId, placement);
          await onMutated();
        }
      });
    }
    if (option === "uploadImage") {
      pendingFileKindRef.current = "image";
      pendingFilePositionRef.current = placement;
      fileInputRef.current?.click();
      return;
    }
    if (option === "uploadVideo") {
      pendingFilePositionRef.current = placement;
      videoInputRef.current?.click();
      return;
    }
  }, [createMenu?.flowPosition, guardCreate, onCreateAnchorAsset, onCreateShot, onCreateStitchJob, onMutated, persistCreatedNodePosition, placeNodeAt, session]);

  /** Drop-on-canvas handler: route file by mime type. Image → character anchor; video → reference. */
  const onDrop = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.files?.length) return;
    event.preventDefault();
    const file = event.dataTransfer.files[0];
    const placement = flowPositionFromClient(event.clientX, event.clientY);
    if (file.type.startsWith("image/")) {
      pendingFileKindRef.current = "image";
      void Promise.resolve(onUploadImageAsset(file, "image")).then((result) => centerUploadImageResult(result, placement));
      return;
    }
    if (file.type.startsWith("video/")) {
      void Promise.resolve(onUploadReferenceVideo(file)).then((asset) => {
        if (asset) {
          const nodeId = `refvideo-${asset.id}`;
          placeNodeAt(nodeId, placement);
          void persistCreatedNodePosition(nodeId, placement);
        }
      });
      return;
    }
  }, [centerUploadImageResult, flowPositionFromClient, onUploadImageAsset, onUploadReferenceVideo, persistCreatedNodePosition, placeNodeAt]);

  if (!session) {
    return (
      <div className="flow-empty-state">
        <div style={{ display: "grid", gap: 8, placeItems: "center", padding: 32 }}>
          <p style={{ fontSize: 16, opacity: 0.85, margin: 0 }}>{t.flow.emptyTitle}</p>
          <p style={{ fontSize: 13, opacity: 0.6, margin: 0 }}>{t.flow.emptyHint}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flow-view">
      <header className="flow-toolbar">
        <div className="flow-toolbar-section">
          {toolbarPrimaryAction && <div className="flow-toolbar-primary-action">{toolbarPrimaryAction}</div>}
          <strong>{session.title}</strong>
          <small>
            {t.flow.summary((session.shots || []).length, session.targetDurationSec, (session.language || lang) as UiLanguage)}
            <em>{creatingKind ? (lang === "en" ? "Creating..." : "创建中...") : t.flow.createNodeHint}</em>
          </small>
        </div>
        <div className="flow-toolbar-actions">
          <button
            type="button"
            className="primary"
            onClick={() => {
              setSelectedNodeId(undefined);
              setShowFinalVideoPanel((value) => !value);
            }}
            title={lang === "en" ? "Open final video stitch, review, and download controls" : "打开完整视频拼接、终审和下载面板"}
          >
            {session.stitchStatus === "running" ? t.nodes.stitching : t.nodes.fullVideo}
          </button>
          {undo && (
            <button
              className="flow-toolbar-undo"
              onClick={() => undo()}
              disabled={!canUndo}
              title={canUndo ? t.flow.undoTitle(undoDescription) : t.flow.undoTitle()}
            >
              {t.flow.undo}
            </button>
          )}
          {redo && (
            <button
              className="flow-toolbar-undo"
              onClick={() => redo()}
              disabled={!canRedo}
              title={canRedo ? t.flow.redoTitle(redoDescription) : t.flow.redoTitle()}
            >
              {t.flow.redo}
            </button>
          )}
        </div>
      </header>
      <div className="flow-canvas-row">
        <div
          ref={canvasRef}
          className="flow-canvas"
          onDrop={onDrop}
          onDragOver={onCanvasDragOver}
          onContextMenuCapture={onPaneContextMenu}
        >
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onNodeDragStop={persistCanvasNodePositions}
            onEdgesChange={onEdgesChange}
            nodeTypes={nodeTypes}
            onNodeClick={onNodeClick}
            onNodeContextMenu={onNodeContextMenu}
            onPaneClick={onPaneClick}
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
            onPaneContextMenu={onPaneContextMenu}
            onInit={onInit}
            // Speed-first: no automatic fitView on mount and no double-click zoom surprises.
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
            connectionMode={ConnectionMode.Loose}
            proOptions={flowProOptions}
          >
            <Background gap={20} size={1} color="#1f2937" />
            <Controls
              position="bottom-right"
              showInteractive={false}
              showZoom
              showFitView
              aria-label={t.flow.zoomControlsAria}
            />
          </ReactFlow>
        </div>
        {selectedData && (
          <MemoInspector
            selected={selectedData as FlowNodeData}
            session={session}
            allAssets={allAssets}
            visionReviewEnabled={visionReviewEnabled}
            defaultImageModel={defaultImageModel}
            onMutated={onMutated}
            onSetStitchOrder={onSetStitchOrder}
            onDeleteCanvasAsset={onDeleteCanvasAsset}
            onDeleteCanvasShot={onDeleteCanvasShot}
            onClose={closeInspector}
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
          const result = await onUploadImageAsset(file, pendingFileKindRef.current);
          centerUploadImageResult(result, placement);
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
          if (asset) {
            const nodeId = `refvideo-${asset.id}`;
            placeNodeAt(nodeId, placement);
            await persistCreatedNodePosition(nodeId, placement);
          }
        }}
      />
      <DownloadToast />
    </div>
  );
}
