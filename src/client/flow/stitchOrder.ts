import type { Shot } from "../../shared/types";

export function deriveConnectedShotOrder(shots: Shot[]): string[] {
  const ordered = shots.slice().sort((a, b) => a.index - b.index);
  const shotById = new Map(ordered.map((shot) => [shot.id, shot]));
  const targets = new Set<string>();
  const nextBySource = new Map<string, string>();

  for (const shot of ordered) {
    const sourceId = shot.referenceVideoFromShotId;
    if (!sourceId || sourceId === shot.id || !shotById.has(sourceId)) continue;
    targets.add(shot.id);
    if (!nextBySource.has(sourceId)) nextBySource.set(sourceId, shot.id);
  }

  if (!nextBySource.size) return [];

  const visited = new Set<string>();
  const result: string[] = [];
  const starts = ordered
    .filter((shot) => nextBySource.has(shot.id) && !targets.has(shot.id))
    .map((shot) => shot.id);
  const fallbackStarts = ordered
    .filter((shot) => nextBySource.has(shot.id))
    .map((shot) => shot.id);

  for (const start of starts.length ? starts : fallbackStarts) {
    let current: string | undefined = start;
    const chainSeen = new Set<string>();
    while (current && shotById.has(current) && !chainSeen.has(current)) {
      chainSeen.add(current);
      if (!visited.has(current)) {
        visited.add(current);
        result.push(current);
      }
      current = nextBySource.get(current);
    }
  }

  return result.length > 1 ? result : [];
}
