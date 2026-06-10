import type { Shot, ShotRender } from "./types";

type PendingRenderInput = Pick<ShotRender, "status" | "generationTaskId" | "videoUrl">;

export type ShotGenerationStateInput = Pick<Shot, "status" | "generationTaskId" | "renders" | "videoUrl">;

export function isPendingShotRender(render: PendingRenderInput | undefined): boolean {
  if (!render) return false;
  if (render.status === "generating") return true;
  return Boolean(render.generationTaskId && !render.videoUrl);
}

export function hasActiveShotGeneration(shot: ShotGenerationStateInput | undefined): boolean {
  if (!shot) return false;
  if (shot.status === "generating") return true;
  if (shot.videoUrl) return false;
  if (shot.generationTaskId && !shot.videoUrl) return true;
  return (shot.renders || []).some(isPendingShotRender);
}

export function selectedShotPendingRender(shot: ShotGenerationStateInput | undefined): ShotRender | undefined {
  if (!shot) return undefined;
  if (!hasActiveShotGeneration(shot)) return undefined;
  const renders = shot.renders || [];
  return renders.find(isPendingShotRender);
}
