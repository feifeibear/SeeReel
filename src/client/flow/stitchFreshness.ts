import type { Shot, StitchJob } from "../../shared/types";

function parseTime(value?: string | null) {
  if (!value) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : undefined;
}

export function latestShotVideoTime(shot: Shot) {
  const candidates: number[] = [];
  const topLevelTime = parseTime(shot.videoGeneratedAt);
  if (topLevelTime !== undefined) candidates.push(topLevelTime);

  for (const render of shot.renders || []) {
    if (shot.videoUrl && render.videoUrl && render.videoUrl !== shot.videoUrl) continue;
    const renderTime = parseTime(render.videoGeneratedAt) ?? parseTime(render.createdAt);
    if (renderTime !== undefined) candidates.push(renderTime);
  }

  return candidates.length ? Math.max(...candidates) : undefined;
}

export function isShotVideoUpdatedAfterFinal(shot: Shot, job: StitchJob) {
  if (!shot.videoUrl || !job.finalVideoUrl) return false;
  const shotTime = latestShotVideoTime(shot);
  const finalTime = parseTime(job.finalVideoGeneratedAt) ?? parseTime(job.updatedAt);
  if (shotTime === undefined || finalTime === undefined) return false;
  return shotTime > finalTime;
}
