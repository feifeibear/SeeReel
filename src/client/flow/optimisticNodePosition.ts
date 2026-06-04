import type { XYPosition } from "@xyflow/react";

export type OptimisticNodePositionDescriptor = {
  id: string;
  kind: string;
  assetId?: string;
  assetName?: string;
  jobId?: string;
  jobName?: string;
  position: XYPosition;
};

function isPendingReplacement(previous: OptimisticNodePositionDescriptor, next: Omit<OptimisticNodePositionDescriptor, "position">) {
  if (previous.kind !== next.kind) return false;
  if (next.kind === "stitch") {
    return Boolean(previous.jobId?.startsWith("stitch_pending") && previous.jobName && previous.jobName === next.jobName);
  }
  if (next.kind === "asset") {
    return Boolean(previous.assetId?.startsWith("asset_pending") && previous.assetName && previous.assetName === next.assetName);
  }
  if (next.kind === "referenceVideo") {
    return Boolean(previous.assetId?.startsWith("pending-ref-video") && previous.assetName && previous.assetName === next.assetName);
  }
  return false;
}

export function resolveReplacedOptimisticNodePosition({
  next,
  previous
}: {
  next: Omit<OptimisticNodePositionDescriptor, "position">;
  previous: OptimisticNodePositionDescriptor[];
}): XYPosition | undefined {
  return previous.find((node) => isPendingReplacement(node, next))?.position;
}
