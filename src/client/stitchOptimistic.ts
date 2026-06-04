import type { StitchJob } from "../shared/types";

export function resolveCreatedStitchJobFollowupPatch({
  createdJobs,
  optimisticJob
}: {
  createdJobs: StitchJob[];
  optimisticJob: StitchJob;
}): { jobId: string; shotIds: string[] } | undefined {
  const optimisticShotIds = Array.from(new Set(optimisticJob.shotIds || []));
  if (!optimisticShotIds.length) return undefined;

  const createdJob = [...createdJobs].reverse().find((job) =>
    job.id === optimisticJob.id || job.name === optimisticJob.name
  ) || createdJobs[createdJobs.length - 1];
  if (!createdJob) return undefined;

  const currentShotIds = createdJob.shotIds || [];
  const current = new Set(currentShotIds);
  const missing = optimisticShotIds.filter((shotId) => !current.has(shotId));
  if (!missing.length) return undefined;

  return {
    jobId: createdJob.id,
    shotIds: [...currentShotIds, ...missing]
  };
}
