import type { Edge, Node } from "@xyflow/react";
import type { Asset, AssetImageModel, Shot, SessionWithShots, StitchJob, StoreSnapshot } from "../../shared/types";

export type AssetNodeKind = "character" | "scene" | "prop" | "style" | "other";

export interface AssetNodeData extends Record<string, unknown> {
  kind: "asset";
  asset: Asset;
  defaultImageModel?: AssetImageModel;
}

export interface StoryboardNodeData extends Record<string, unknown> {
  kind: "storyboard";
  shot: Shot;
  /** The sub-storyboard grid asset bound to this shot (if generated yet). */
  asset?: Asset;
  defaultImageModel?: AssetImageModel;
}

export interface ShotNodeData extends Record<string, unknown> {
  kind: "shot";
  shot: Shot;
}

export interface StitchNodeData extends Record<string, unknown> {
  kind: "stitch";
  session: SessionWithShots;
  job: StitchJob;
  legacy?: boolean;
}

export interface ReferenceVideoNodeData extends Record<string, unknown> {
  kind: "referenceVideo";
  asset: Asset;
}

export interface VideoProcessorNodeData extends Record<string, unknown> {
  kind: "videoProcessor";
  /** The derivative asset (i.e. the clipped output). */
  asset: Asset;
  /** The source asset this derivative was derived from (for header / context display). */
  sourceAsset?: Asset;
}

export interface TailframeNodeData extends Record<string, unknown> {
  kind: "tailframe";
  asset: Asset;
  sourceShot?: Shot;
  targetShots: Shot[];
}

export type FlowNodeData =
  | AssetNodeData
  | StoryboardNodeData
  | ShotNodeData
  | StitchNodeData
  | ReferenceVideoNodeData
  | VideoProcessorNodeData
  | TailframeNodeData;

export interface BuildGraphResult {
  nodes: Node<FlowNodeData>[];
  edges: Edge[];
}

const COLUMN_X = {
  asset: 60,
  videoProcessor: 460,
  storyboard: 860,
  shot: 1260,
  tailframe: 1660,
  stitch: 2060
};

const ROW_HEIGHT = 240;

/**
 * Project session state into a 4-column DAG:
 *
 *   Col 0: anchor Assets (characters / scenes / styles bound to this session)
 *   Col 1: per-shot sub-storyboard grid Assets
 *   Col 2: per-shot Video render
 *   Col 3: a single Stitch output
 *
 * Edges encode the actual data dependencies the server already enforces:
 *   - Asset → Storyboard: this asset's id is in the storyboard asset's referenceAssetIds
 *     (or, when no storyboard exists yet, the shot's assetIds — fallback)
 *   - Storyboard → Shot: shot.subShotStoryboardAssetId points to the storyboard asset
 *   - Shot → Stitch: every shot of the session feeds the single stitch output
 *
 * The graph re-derives on every snapshot — there's no separate "flow state" persisted on the
 * server, so the flow view stays in sync with the API by construction.
 */
export function buildSessionGraph(snapshot: StoreSnapshot, session: SessionWithShots): BuildGraphResult {
  const nodes: Node<FlowNodeData>[] = [];
  const edges: Edge[] = [];
  const defaultImageModel = snapshot.runtime?.seedreamDefaultModel;

  const sessionAssets = snapshot.assets.filter((asset) => {
    if (asset.ownerShotId) return false; // shot-scoped (sketches / sub-storyboards) handled separately
    // Strict session isolation: only show assets that explicitly belong to THIS session. Global
    // assets (no ownerSessionId) used to leak into every canvas, which made "新建 session" feel
    // pre-populated with old-session leftovers like 老棋师 / Lisa Su. Hard-skip them here — if
    // a user wants to reuse a character across sessions they can promote/copy it explicitly via
    // the Asset library actions, which sets ownerSessionId on the new copy.
    return asset.ownerSessionId === session.id;
  });

  // Anchor assets: characters first, then scenes / props / styles. Tag-only assets (no media yet)
  // are still surfaced so the user can see "this character exists but hasn't been generated".
  // Reference-video assets (uploaded clips for analysis/reference) are split off — they live in a separate
  // pile below the anchors so they don't clutter the identity-anchor row.
  // Derivative video-clip assets (those with `derivedFromAssetId` set) are split out further
  // into their own column as videoProcessor nodes — they represent a transformation step in
  // the pipeline rather than a top-level reference.
  const isReferenceVideo = (asset: Asset) => (asset.tags || []).includes("reference-video");
  const isTailframe = (asset: Asset) => (asset.tags || []).includes("tailframe");
  const sourceShotIdForTailframe = (asset: Asset) =>
    (asset.tags || []).find((tag) => tag.startsWith("source-shot:"))?.slice("source-shot:".length) || asset.ownerShotId;
  const isDerivedClip = (asset: Asset) => Boolean(asset.derivedFromAssetId);
  const anchorAssets = sessionAssets.filter((asset) => asset.type !== "other" && !isReferenceVideo(asset) && !isTailframe(asset));
  const tailframeAssets = sessionAssets.filter(isTailframe);
  const referenceVideoAssets = sessionAssets.filter((a) => isReferenceVideo(a) && !isDerivedClip(a));
  const derivedClipAssets = sessionAssets.filter((a) => isReferenceVideo(a) && isDerivedClip(a));
  anchorAssets.sort((a, b) => {
    const order = { character: 0, scene: 1, prop: 2, style: 3, other: 4 } as Record<string, number>;
    const oa = order[a.type] ?? 9;
    const ob = order[b.type] ?? 9;
    if (oa !== ob) return oa - ob;
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  });
  anchorAssets.forEach((asset, index) => {
    nodes.push({
      id: `asset-${asset.id}`,
      type: "assetNode",
      position: { x: COLUMN_X.asset, y: 60 + index * ROW_HEIGHT },
      data: { kind: "asset", asset, defaultImageModel } satisfies AssetNodeData
    });
  });
  // Stack reference-video nodes below the anchor list. They have no edges by default — they live
  // off the main pipeline; the user "applies" a parsed shot to a target shot via the Inspector.
  referenceVideoAssets.forEach((asset, index) => {
    nodes.push({
      id: `refvideo-${asset.id}`,
      type: "referenceVideoNode",
      position: { x: COLUMN_X.asset, y: 60 + (anchorAssets.length + index) * ROW_HEIGHT },
      data: { kind: "referenceVideo", asset } satisfies ReferenceVideoNodeData
    });
  });

  // VideoProcessor (clip-derivative) nodes. Each derived asset emits one node in col `videoProcessor`,
  // vertically aligned with its source refvideo. We also auto-emit a non-deletable edge from the
  // source refvideo to its derivative — that link is structural (set at derive-clip creation) and
  // can only be removed by deleting the derivative asset.
  const refvideoIndexById = new Map<string, number>();
  referenceVideoAssets.forEach((a, i) => refvideoIndexById.set(a.id, i));
  derivedClipAssets.forEach((asset, derivedIdx) => {
    const sourceAsset = asset.derivedFromAssetId
      ? referenceVideoAssets.find((a) => a.id === asset.derivedFromAssetId)
      : undefined;
    // If we can find the source, vertically align the derivative with it; otherwise stack at the
    // tail. Either way the y-coord stays in the refvideo row band.
    const sourceIndex = sourceAsset ? refvideoIndexById.get(sourceAsset.id) : undefined;
    const yIndex = sourceIndex !== undefined ? sourceIndex : referenceVideoAssets.length + derivedIdx;
    const procNodeId = `videoproc-${asset.id}`;
    nodes.push({
      id: procNodeId,
      type: "videoProcessorNode",
      position: {
        x: COLUMN_X.videoProcessor,
        y: 60 + (anchorAssets.length + yIndex) * ROW_HEIGHT
      },
      data: { kind: "videoProcessor", asset, sourceAsset } satisfies VideoProcessorNodeData
    });
    if (sourceAsset) {
      edges.push({
        id: `e-derive-${sourceAsset.id}-${asset.id}`,
        source: `refvideo-${sourceAsset.id}`,
        target: procNodeId,
        animated: false,
        data: { canDisconnectDerivedClip: true, sourceAssetId: sourceAsset.id, derivedAssetId: asset.id },
        style: { stroke: "#60a5fa", strokeWidth: 2 }
      });
    }
  });

  // Sort shots by index for a tidy vertical layout in cols 1–2.
  const orderedShots = (session.shots || []).slice().sort((a, b) => a.index - b.index);

  // Reverse index: storyboard asset id → the shot that owns the storyboard node hosting it.
  // Used below when wiring N-to-1 Storyboard→Shot edges, since the source node id is always
  // `storyboard-${ownerShotId}` regardless of which shot consumes the asset. We index BOTH the
  // singular `subShotStoryboardAssetId` (the canonical primary, set by /sub-storyboard) and any
  // ids that appear in plural lists — defensive against an out-of-sync state where the singular
  // got cleared but a plural reference still points at the asset.
  const ownerShotByStoryboardAssetId = new Map<string, string>();
  orderedShots.forEach((shot) => {
    if (shot.subShotStoryboardAssetId && !ownerShotByStoryboardAssetId.has(shot.subShotStoryboardAssetId)) {
      ownerShotByStoryboardAssetId.set(shot.subShotStoryboardAssetId, shot.id);
    }
  });
  // Second pass: claim ownership for any id seen in a plural list. First-seen wins, so the
  // shot's own primary still dominates if present.
  orderedShots.forEach((shot) => {
    (shot.subShotStoryboardAssetIds || []).forEach((assetId) => {
      if (!ownerShotByStoryboardAssetId.has(assetId)) {
        // Find which shot's primary this asset *was*; if no shot owns it directly, attribute
        // ownership to the shot that's currently consuming it. The storyboard node for that
        // shot will be the visible source on the canvas.
        const candidate = orderedShots.find((s) => s.subShotStoryboardAssetId === assetId);
        ownerShotByStoryboardAssetId.set(assetId, candidate?.id || shot.id);
      }
    });
  });

  const shotIndexById = new Map(orderedShots.map((shot, index) => [shot.id, index]));
  const tailframeById = new Map(tailframeAssets.map((asset) => [asset.id, asset]));

  tailframeAssets.forEach((asset, index) => {
    const sourceShotId = sourceShotIdForTailframe(asset);
    const sourceShot = sourceShotId ? orderedShots.find((shot) => shot.id === sourceShotId) : undefined;
    const sourceIndex = sourceShot ? shotIndexById.get(sourceShot.id) : undefined;
    const targetShots = orderedShots.filter((shot) => shot.firstFrameAssetId === asset.id);
    const yIndex = sourceIndex ?? index;
    const tailframeNodeId = `tailframe-${asset.id}`;
    nodes.push({
      id: tailframeNodeId,
      type: "tailframeNode",
      position: { x: COLUMN_X.tailframe, y: 60 + yIndex * ROW_HEIGHT },
      data: { kind: "tailframe", asset, sourceShot, targetShots } satisfies TailframeNodeData
    });
    if (sourceShot) {
      edges.push({
        id: `e-tailframe-source-${sourceShot.id}-${asset.id}`,
        source: `shot-${sourceShot.id}`,
        target: tailframeNodeId,
        animated: false,
        data: { tailframeSource: true, sourceShotId: sourceShot.id, tailframeAssetId: asset.id },
        style: { stroke: "#38bdf8", strokeWidth: 2, strokeDasharray: "5 3" }
      });
    }
  });

  // Per-shot Storyboard + Video nodes.
  orderedShots.forEach((shot, index) => {
    const storyboardAsset = shot.subShotStoryboardAssetId
      ? snapshot.assets.find((asset) => asset.id === shot.subShotStoryboardAssetId)
      : undefined;
    // Only emit a Storyboard node when the user has actually opted into sub-storyboard mode for
    // this shot — meaning either a storyboard asset has been generated, or the shot is consuming
    // someone else's storyboard via the plural list. A brand-new "+ 分镜" should produce just the
    // ShotNode; the canvas stays clean and the user opts into storyboards explicitly via the
    // ShotInspector "+ 生成分镜板" entry.
    const showStoryboardNode = Boolean(
      storyboardAsset
      || (shot.subShotStoryboardAssetIds && shot.subShotStoryboardAssetIds.length > 0)
      || (shot.subShotPanelCount && shot.subShotPanelCount > 1)
    );
    const storyboardNodeId = `storyboard-${shot.id}`;
    if (showStoryboardNode) {
      nodes.push({
        id: storyboardNodeId,
        type: "storyboardNode",
        position: { x: COLUMN_X.storyboard, y: 60 + index * ROW_HEIGHT },
        data: { kind: "storyboard", shot, asset: storyboardAsset, defaultImageModel } satisfies StoryboardNodeData,
        deletable: true
      });
    }

    const shotNodeId = `shot-${shot.id}`;
    nodes.push({
      id: shotNodeId,
      type: "shotNode",
      position: { x: COLUMN_X.shot, y: 60 + index * ROW_HEIGHT },
      data: { kind: "shot", shot } satisfies ShotNodeData,
      deletable: shot.status !== "generating"
    });

    // Storyboard → Shot edges. N-to-1 wiring: a shot may consume multiple storyboards (its own
    // primary plus any user-added extras dragged in from other shots). Source of truth is
    // `shot.subShotStoryboardAssetIds`; we fall back to the legacy singular `subShotStoryboardAssetId`
    // for shots created before plural was introduced. Each edge is user-deletable so the UI lets
    // the user / AI rewire freely; the primary edge (own storyboard) is rendered solid, extras
    // dashed so the visual hierarchy stays clear.
    const consumedAssetIds = (shot.subShotStoryboardAssetIds && shot.subShotStoryboardAssetIds.length > 0)
      ? shot.subShotStoryboardAssetIds
      : (shot.subShotStoryboardAssetId ? [shot.subShotStoryboardAssetId] : []);
    consumedAssetIds.forEach((assetId) => {
      const ownerShotId = ownerShotByStoryboardAssetId.get(assetId);
      if (!ownerShotId) return; // referenced asset isn't a known shot's primary storyboard — skip
      const sourceNodeId = `storyboard-${ownerShotId}`;
      const isPrimary = ownerShotId === shot.id;
      edges.push({
        id: `e-${sourceNodeId}-${shotNodeId}-${assetId}`,
        source: sourceNodeId,
        target: shotNodeId,
        animated: shot.status === "generating",
        // Both primary and cross-shot edges are user-deletable; FlowView's onEdgesDelete
        // handles the actual `subShotStoryboardAssetIds` mutation. Tagged with the contextual
        // ids so the handler doesn't have to reverse-parse node ids.
        data: { canDisconnectStoryboard: true, storyboardAssetId: assetId, targetShotId: shot.id, isPrimary },
        style: {
          stroke: "#a78bfa",
          strokeWidth: 2,
          ...(isPrimary ? {} : { strokeDasharray: "4 3", opacity: 0.85 })
        }
      });
    });

    // RefVideo → Shot edge (Seedance reference_video pattern). When the shot has a
    // referenceVideoAssetId, draw a green edge from that asset's node to this shot. The asset
    // may be a top-level refvideo (node id `refvideo-...`) OR a clip-derivative (node id
    // `videoproc-...`); we resolve the right node id based on which pile the asset is in.
    // User-deletable — onEdgesDelete clears both `referenceVideoAssetId` and the synced
    // `referenceClipUrl`.
    if (shot.referenceVideoAssetId) {
      const fromRefvideo = referenceVideoAssets.find((a) => a.id === shot.referenceVideoAssetId);
      const fromDerived = !fromRefvideo
        ? derivedClipAssets.find((a) => a.id === shot.referenceVideoAssetId)
        : undefined;
      const sourceNodeId = fromRefvideo
        ? `refvideo-${fromRefvideo.id}`
        : fromDerived ? `videoproc-${fromDerived.id}` : undefined;
      if (sourceNodeId) {
        edges.push({
          id: `e-${sourceNodeId}-${shotNodeId}`,
          source: sourceNodeId,
          target: shotNodeId,
          animated: shot.status === "generating",
          data: { canDisconnectRefVideo: true, refVideoAssetId: shot.referenceVideoAssetId, targetShotId: shot.id },
          style: { stroke: "#34d399", strokeWidth: 2 }
        });
      }
    }

    // Cross-shot reference video edge (`shot.referenceVideoFromShotId`). When set, draw a green
    // edge from the source shot node directly into this shot — same visual treatment as the
    // refvideo→shot edge above, just with shot-{srcId} as the source. Renders nothing if the
    // source shot was deleted or not in this session.
    if (shot.referenceVideoFromShotId && shot.referenceVideoFromShotId !== shot.id) {
      const sourceShot = orderedShots.find((s) => s.id === shot.referenceVideoFromShotId);
      if (sourceShot) {
        const sourceNodeId = `shot-${sourceShot.id}`;
        edges.push({
          id: `e-shotref-${sourceShot.id}-${shot.id}`,
          source: sourceNodeId,
          target: shotNodeId,
          animated: shot.status === "generating",
          data: { canDisconnectShotRef: true, sourceShotId: sourceShot.id, targetShotId: shot.id },
          style: { stroke: "#34d399", strokeWidth: 2, strokeDasharray: "4 3" }
        });
      }
    }

    // Tailframe → Shot edge (`shot.firstFrameAssetId`). Tailframe nodes are generated from an
    // upstream video and then dragged into a downstream shot to become its Seedance first_frame.
    if (shot.firstFrameAssetId) {
      const tailframe = tailframeById.get(shot.firstFrameAssetId);
      if (tailframe) {
        edges.push({
          id: `e-tailframe-${tailframe.id}-${shot.id}`,
          source: `tailframe-${tailframe.id}`,
          target: shotNodeId,
          animated: shot.status === "generating",
          data: { canDisconnectFirstFrame: true, tailframeAssetId: tailframe.id, targetShotId: shot.id },
          style: { stroke: "#38bdf8", strokeWidth: 2 }
        });
      }
    }

    // Asset → Storyboard / Shot edges. The visual wiring is the user's *intent* (`shot.assetIds`):
    // dragging a line on the canvas mutates this list and the next /sub-storyboard call picks it
    // up. We also overlay any audit-only refs — assets that *were* used last time but have since
    // been disconnected — as dashed edges so the user can see "this is no longer wired but the
    // current image still bakes it in until you regenerate".
    // Current intent edges always land on the Shot node. `shot.assetIds` is the live source of
    // truth for video generation, even when a storyboard node is visible, so dragging an anchor
    // onto a Shot should leave a visible Shot connection instead of being rerouted upstream.
    // Storyboard-baked historical references are still shown below as dashed audit-only edges.
    const assetEdgeTargetId = shotNodeId;
    const intentIds = (shot.assetIds || []).filter((id) => {
      const a = snapshot.assets.find((item) => item.id === id);
      return a && a.type !== "other" && !a.ownerShotId;
    });
    const auditIds = storyboardAsset?.referenceAssetIds || [];
    const intentSet = new Set(intentIds);
    const auditOnly = auditIds.filter((id) => !intentSet.has(id));
    intentIds.forEach((assetId) => {
      const exists = anchorAssets.some((asset) => asset.id === assetId);
      if (!exists) return;
      edges.push({
        id: `e-asset-${assetId}-${assetEdgeTargetId}`,
        source: `asset-${assetId}`,
        target: assetEdgeTargetId,
        animated: false,
        data: { canDisconnect: true, assetId, shotId: shot.id },
        style: { stroke: "#fbbf24", strokeWidth: 2 }
      });
    });
    // Audit-only edges only make sense when the storyboard node is showing — they describe a
    // mismatch between the storyboard asset's baked-in references and the current intent list.
    // Without a storyboard node there's nothing to audit, so skip. Also requires the storyboard
    // asset itself to exist (it might be missing on a freshly-created shot whose user hit
    // "+ 启用分镜板" but never clicked "出图" yet).
    if (showStoryboardNode && storyboardAsset) {
      auditOnly.forEach((assetId) => {
        const exists = anchorAssets.some((asset) => asset.id === assetId);
        if (!exists) return;
        edges.push({
          id: `e-asset-${assetId}-${storyboardNodeId}-audit`,
          source: `asset-${assetId}`,
          target: storyboardNodeId,
          animated: false,
          data: { canDisconnect: true, assetId, shotId: shot.id, auditOnly: true, storyboardAssetId: storyboardAsset.id },
          style: { stroke: "#fbbf24", strokeWidth: 1.5, strokeDasharray: "6 4", opacity: 0.6 }
        });
      });
    }
  });

  // Stitch output nodes. Legacy sessions may still have one session-level stitch output; new right-
  // click-created nodes live in session.stitchJobs and each carries its own playlist/result.
  const legacyStitchJob: StitchJob | undefined = (!session.stitchJobs?.length
    && (orderedShots.length >= 2 || Boolean(session.finalVideoUrl) || Boolean(session.stitchShotIds))
    && !session.stitchHidden)
      ? {
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
        }
      : undefined;
  const stitchJobs = legacyStitchJob ? [legacyStitchJob] : (session.stitchJobs || []);
  stitchJobs.forEach((job, jobIndex) => {
    const middleY = 60 + ((orderedShots.length - 1) * ROW_HEIGHT) / 2 + jobIndex * ROW_HEIGHT;
    const legacy = job.id === "legacy";
    const stitchNodeId = legacy ? `stitch-${session.id}` : `stitch-${session.id}-${job.id}`;
    nodes.push({
      id: stitchNodeId,
      type: "stitchNode",
      position: { x: COLUMN_X.stitch, y: middleY },
      data: { kind: "stitch", session, job, legacy } satisfies StitchNodeData
    });
    (job.shotIds || []).forEach((shotId, orderIndex) => {
      const shot = orderedShots.find((item) => item.id === shotId);
      if (!shot) return;
      edges.push({
        id: `e-stitch-${shot.id}-${session.id}-${job.id}`,
        source: `shot-${shot.id}`,
        target: stitchNodeId,
        animated: job.status === "running",
        data: { canDisconnectStitch: true, stitchShotId: shot.id, stitchJobId: job.id, stitchOrderIndex: orderIndex },
        label: String(orderIndex + 1),
        style: {
          stroke: "#34d399",
          strokeWidth: 2,
          ...(shot.videoUrl ? {} : { strokeDasharray: "4 3", opacity: 0.65 })
        }
      });
    });
  });

  return { nodes, edges };
}
