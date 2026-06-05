import type { Connection, Edge } from "@xyflow/react";
import type { Asset, SessionWithShots, StoreSnapshot } from "../../shared/types";
import type { FlowNodeData } from "./buildGraph";

export interface PendingConnectInput {
  connection: Connection;
  session: SessionWithShots;
  snapshot: StoreSnapshot;
  targetNodeData?: FlowNodeData;
}

export function mergePendingEdges(derivedEdges: Edge[], pendingEdges: Edge[]) {
  const derivedIds = new Set(derivedEdges.map((edge) => edge.id));
  return [
    ...derivedEdges,
    ...pendingEdges.filter((edge) => !derivedIds.has(edge.id))
  ];
}

export function buildPendingConnectEdge(input: PendingConnectInput): Edge | undefined {
  const source = input.connection.source || "";
  const target = input.connection.target || "";
  if (!source || !target) return undefined;

  if (source.startsWith("asset-") && (target.startsWith("storyboard-") || target.startsWith("shot-"))) {
    const assetId = source.slice("asset-".length);
    const targetShotId = target.startsWith("storyboard-")
      ? target.slice("storyboard-".length)
      : target.slice("shot-".length);
    const asset = input.snapshot.assets.find((item) => item.id === assetId);
    const targetShot = input.session.shots?.find((shot) => shot.id === targetShotId);
    if (!asset || !targetShot) return undefined;
    const isFrameAnchor = hasTag(asset, "tailframe") || hasTag(asset, "frame-anchor");
    if (isFrameAnchor) {
      return {
        id: `e-tailframe-${asset.id}-${targetShot.id}`,
        source,
        target: `shot-${targetShot.id}`,
        animated: true,
        data: { canDisconnectFirstFrame: true, tailframeAssetId: asset.id, targetShotId: targetShot.id },
        style: { stroke: "#38bdf8", strokeWidth: 2, opacity: 0.8 }
      };
    }
    return {
      id: `e-asset-${asset.id}-shot-${targetShot.id}`,
      source,
      target: `shot-${targetShot.id}`,
      animated: true,
      data: { canDisconnect: true, assetId: asset.id, shotId: targetShot.id },
      style: { stroke: "#fbbf24", strokeWidth: 2, opacity: 0.8 }
    };
  }

  if (source.startsWith("storyboard-") && target.startsWith("shot-")) {
    const ownerShotId = source.slice("storyboard-".length);
    const targetShotId = target.slice("shot-".length);
    const ownerShot = input.session.shots?.find((shot) => shot.id === ownerShotId);
    const targetShot = input.session.shots?.find((shot) => shot.id === targetShotId);
    const storyboardAssetId = ownerShot?.subShotStoryboardAssetId;
    if (!ownerShot || !targetShot || !storyboardAssetId) return undefined;
    const isPrimary = ownerShot.id === targetShot.id;
    return {
      id: `e-storyboard-${ownerShot.id}-shot-${targetShot.id}-${storyboardAssetId}`,
      source,
      target: `shot-${targetShot.id}`,
      animated: true,
      data: { canDisconnectStoryboard: true, storyboardAssetId, targetShotId: targetShot.id, isPrimary },
      style: {
        stroke: "#a78bfa",
        strokeWidth: 2,
        opacity: 0.8,
        ...(isPrimary ? {} : { strokeDasharray: "4 3" })
      }
    };
  }

  if ((source.startsWith("refvideo-") || source.startsWith("videoproc-")) && target.startsWith("shot-")) {
    const refAssetId = source.startsWith("refvideo-")
      ? source.slice("refvideo-".length)
      : source.slice("videoproc-".length);
    const refAsset = input.snapshot.assets.find((asset) => asset.id === refAssetId);
    const targetShotId = target.slice("shot-".length);
    const targetShot = input.session.shots?.find((shot) => shot.id === targetShotId);
    if (!refAsset || !targetShot) return undefined;
    return {
      id: `e-${source}-shot-${targetShot.id}`,
      source,
      target: `shot-${targetShot.id}`,
      animated: true,
      data: { canDisconnectRefVideo: true, refVideoAssetId: refAsset.id, targetShotId: targetShot.id },
      style: { stroke: "#34d399", strokeWidth: 2, opacity: 0.8 }
    };
  }

  if (source.startsWith("tailframe-") && target.startsWith("shot-")) {
    const tailframeAssetId = source.slice("tailframe-".length);
    const targetShotId = target.slice("shot-".length);
    const targetShot = input.session.shots?.find((shot) => shot.id === targetShotId);
    if (!targetShot) return undefined;
    return {
      id: `e-tailframe-${tailframeAssetId}-${targetShot.id}`,
      source,
      target: `shot-${targetShot.id}`,
      animated: true,
      data: { canDisconnectFirstFrame: true, tailframeAssetId, targetShotId: targetShot.id },
      style: { stroke: "#38bdf8", strokeWidth: 2, opacity: 0.8 }
    };
  }

  if (source.startsWith("shot-") && target.startsWith("stitch-") && input.targetNodeData?.kind === "stitch") {
    const shotId = source.slice("shot-".length);
    const shot = input.session.shots?.find((item) => item.id === shotId);
    const job = input.targetNodeData.job;
    if (!shot || job.shotIds?.includes(shotId)) return undefined;
    return {
      id: `e-stitch-${shot.id}-${input.session.id}-${job.id}`,
      source,
      target,
      animated: true,
      data: { canDisconnectStitch: true, stitchShotId: shot.id, stitchJobId: job.id, stitchOrderIndex: job.shotIds?.length || 0 },
      label: String((job.shotIds?.length || 0) + 1),
      style: {
        stroke: "#34d399",
        strokeWidth: 2,
        opacity: 0.8,
        ...(shot.videoUrl ? {} : { strokeDasharray: "4 3" })
      }
    };
  }

  if (source.startsWith("shot-") && target.startsWith("shot-")) {
    const sourceShotId = source.slice("shot-".length);
    const targetShotId = target.slice("shot-".length);
    const sourceShot = input.session.shots?.find((shot) => shot.id === sourceShotId);
    const targetShot = input.session.shots?.find((shot) => shot.id === targetShotId);
    if (!sourceShot || !targetShot || sourceShot.id === targetShot.id || !sourceShot.videoUrl) return undefined;
    return {
      id: `e-shotref-${sourceShot.id}-${targetShot.id}`,
      source,
      target,
      animated: true,
      data: { canDisconnectShotRef: true, sourceShotId: sourceShot.id, targetShotId: targetShot.id },
      style: { stroke: "#34d399", strokeWidth: 2, strokeDasharray: "4 3", opacity: 0.8 }
    };
  }

  return undefined;
}

function hasTag(asset: Asset, tag: string) {
  return (asset.tags || []).includes(tag);
}
