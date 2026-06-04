import type { Shot } from "../shared/types";

function replaceIdList(ids: string[] | undefined, optimisticAssetId: string, createdAssetId: string): string[] | undefined {
  if (!ids?.includes(optimisticAssetId)) return undefined;
  return Array.from(new Set(ids.map((id) => (id === optimisticAssetId ? createdAssetId : id))));
}

function replaceScalarId(id: string | undefined, optimisticAssetId: string, createdAssetId: string): string | undefined {
  return id === optimisticAssetId ? createdAssetId : undefined;
}

export function resolveCreatedAssetFollowupShotPatches({
  shots,
  optimisticAssetId,
  createdAssetId
}: {
  shots: Shot[];
  optimisticAssetId: string;
  createdAssetId: string;
}): Array<{ shotId: string; patch: Partial<Shot> }> {
  if (!optimisticAssetId || !createdAssetId || optimisticAssetId === createdAssetId) return [];

  return shots.flatMap((shot) => {
    const patch: Partial<Shot> = {};
    const assetIds = replaceIdList(shot.assetIds, optimisticAssetId, createdAssetId);
    const subShotStoryboardAssetIds = replaceIdList(shot.subShotStoryboardAssetIds, optimisticAssetId, createdAssetId);
    const subShotStoryboardAssetId = replaceScalarId(shot.subShotStoryboardAssetId, optimisticAssetId, createdAssetId);
    const referenceVideoAssetId = replaceScalarId(shot.referenceVideoAssetId, optimisticAssetId, createdAssetId);
    const firstFrameAssetId = replaceScalarId(shot.firstFrameAssetId, optimisticAssetId, createdAssetId);
    const lastFrameAssetId = replaceScalarId(shot.lastFrameAssetId, optimisticAssetId, createdAssetId);

    if (assetIds) patch.assetIds = assetIds;
    if (subShotStoryboardAssetIds) patch.subShotStoryboardAssetIds = subShotStoryboardAssetIds;
    if (subShotStoryboardAssetId) patch.subShotStoryboardAssetId = subShotStoryboardAssetId;
    if (referenceVideoAssetId) patch.referenceVideoAssetId = referenceVideoAssetId;
    if (firstFrameAssetId) patch.firstFrameAssetId = firstFrameAssetId;
    if (lastFrameAssetId) patch.lastFrameAssetId = lastFrameAssetId;

    return Object.keys(patch).length ? [{ shotId: shot.id, patch }] : [];
  });
}
