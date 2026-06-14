import type { Node, XYPosition } from "@xyflow/react";

export function applyPendingCreatedPositions<T extends Node>(
  prevNodes: T[],
  derivedNodes: T[],
  pendingPositions: Map<string, XYPosition>,
  pendingDeletedNodeIds: Set<string>
): T[] {
  const prevById = new Map(prevNodes.map((node) => [node.id, node]));
  const merged: T[] = [];
  for (const next of derivedNodes) {
    const pendingPosition = pendingPositions.get(next.id);
    if (pendingPosition) {
      pendingPositions.delete(next.id);
      merged.push({ ...next, position: pendingPosition });
      continue;
    }
    const old = prevById.get(next.id);
    merged.push(old ? { ...next, position: old.position } : next);
  }
  return merged.filter((node) => !pendingDeletedNodeIds.has(node.id));
}
