import type { XYPosition } from "@xyflow/react";

type CanvasRectLike = Pick<DOMRect, "left" | "top">;

export function resolveCanvasCreatePosition({
  clientX,
  clientY,
  canvasRect,
  screenToFlowPosition
}: {
  clientX: number;
  clientY: number;
  canvasRect?: CanvasRectLike;
  screenToFlowPosition?: (point: XYPosition) => XYPosition;
}): XYPosition | undefined {
  if (screenToFlowPosition) return screenToFlowPosition({ x: clientX, y: clientY });
  if (!canvasRect) return undefined;
  return { x: clientX - canvasRect.left, y: clientY - canvasRect.top };
}
