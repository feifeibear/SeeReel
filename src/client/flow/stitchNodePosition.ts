import type { XYPosition } from "@xyflow/react";

export type StitchNodePositionDescriptor = {
  id: string;
  kind: string;
  jobId?: string;
  jobName?: string;
  position: XYPosition;
};

export function resolveReplacedStitchNodePosition({
  next,
  previous
}: {
  next: Omit<StitchNodePositionDescriptor, "position">;
  previous: StitchNodePositionDescriptor[];
}): XYPosition | undefined {
  if (next.kind !== "stitch" || !next.jobName) return undefined;
  return previous.find((node) =>
    node.kind === "stitch"
    && node.jobId?.startsWith("stitch_pending")
    && node.jobName === next.jobName
  )?.position;
}
