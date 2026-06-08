const VIEWPORT_MARGIN = 12;
const MIN_SCROLLABLE_HEIGHT = 220;

export type CreateNodeMenuPlacement = "left" | "right";
export type CreateNodeMenuVerticalPlacement = "above" | "below";

export interface CreateNodeMenuLayoutInput {
  anchorX: number;
  anchorY: number;
  viewportWidth: number;
  viewportHeight: number;
  menuWidth: number;
  menuHeight: number;
}

export interface CreateNodeMenuLayout {
  left: number;
  top: number;
  maxHeight: number;
  placementX: CreateNodeMenuPlacement;
  placementY: CreateNodeMenuVerticalPlacement;
}

export function resolveCreateNodeMenuLayout({
  anchorX,
  anchorY,
  viewportWidth,
  viewportHeight,
  menuWidth,
  menuHeight
}: CreateNodeMenuLayoutInput): CreateNodeMenuLayout {
  const safeViewportWidth = Math.max(menuWidth + VIEWPORT_MARGIN * 2, viewportWidth);
  const safeViewportHeight = Math.max(MIN_SCROLLABLE_HEIGHT + VIEWPORT_MARGIN * 2, viewportHeight);
  const availableRight = safeViewportWidth - VIEWPORT_MARGIN - anchorX;
  const availableLeft = anchorX - VIEWPORT_MARGIN;
  const placementX: CreateNodeMenuPlacement = availableRight >= menuWidth || availableRight >= availableLeft ? "right" : "left";
  const rawLeft = placementX === "right" ? anchorX : anchorX - menuWidth;
  const left = clamp(rawLeft, VIEWPORT_MARGIN, safeViewportWidth - VIEWPORT_MARGIN - menuWidth);

  const availableBelow = safeViewportHeight - VIEWPORT_MARGIN - anchorY;
  const availableAbove = anchorY - VIEWPORT_MARGIN;
  const placementY: CreateNodeMenuVerticalPlacement = availableBelow >= menuHeight || availableBelow >= availableAbove ? "below" : "above";
  const availableHeight = placementY === "below" ? availableBelow : availableAbove;
  const maxHeight = clamp(Math.min(menuHeight, availableHeight), Math.min(MIN_SCROLLABLE_HEIGHT, safeViewportHeight - VIEWPORT_MARGIN * 2), safeViewportHeight - VIEWPORT_MARGIN * 2);
  const rawTop = placementY === "below" ? anchorY : anchorY - maxHeight;
  const top = clamp(rawTop, VIEWPORT_MARGIN, safeViewportHeight - VIEWPORT_MARGIN - maxHeight);

  return { left, top, maxHeight, placementX, placementY };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}
