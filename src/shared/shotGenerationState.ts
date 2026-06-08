import type { Shot, ShotRender } from "./types";

type PendingRenderInput = Pick<ShotRender, "status" | "generationTaskId">;

export type ShotGenerationStateInput = Pick<Shot, "status" | "generationTaskId" | "renders">;

export function isPendingShotRender(render: PendingRenderInput | undefined): boolean {
  return Boolean(render && (render.status === "generating" || render.generationTaskId));
}

export function hasActiveShotGeneration(shot: ShotGenerationStateInput | undefined): boolean {
  return Boolean(shot && (shot.status === "generating" || shot.generationTaskId));
}

export function selectedShotPendingRender(shot: ShotGenerationStateInput | undefined): ShotRender | undefined {
  if (!shot) return undefined;
  if (!hasActiveShotGeneration(shot)) return undefined;
  const renders = shot.renders || [];
  return renders.find(isPendingShotRender);
}
