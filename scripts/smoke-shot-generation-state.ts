import type { Shot } from "../src/shared/types";
import {
  hasActiveShotGeneration,
  selectedShotPendingRender
} from "../src/shared/shotGenerationState";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const readyShotWithStaleHistory = {
  id: "shot_ready",
  sessionId: "ses_test",
  index: 2,
  title: "Shot 2",
  durationSec: 15,
  rawPrompt: "fly forward",
  prompt: "fly forward",
  status: "ready",
  videoUrl: "/media/ready.mp4",
  assetIds: [],
  createdAt: "",
  updatedAt: "",
  renders: [
    { id: "render_ready", status: "ready", videoUrl: "/media/ready.mp4", createdAt: "" },
    {
      id: "render_stale",
      status: "generating",
      generationTaskId: "cgt_stale",
      generationStartedAt: "2026-06-08T00:00:00.000Z",
      createdAt: ""
    }
  ]
} satisfies Shot;

assert(
  !hasActiveShotGeneration(readyShotWithStaleHistory),
  "ready shot should not be treated as actively generating because of stale render history"
);
assert(
  !selectedShotPendingRender(readyShotWithStaleHistory),
  "ready shot should not expose stale historical pending render as selected pending render"
);

const generatingShot = {
  ...readyShotWithStaleHistory,
  id: "shot_generating",
  status: "generating",
  generationTaskId: "cgt_current",
  generationStartedAt: "2026-06-08T01:00:00.000Z"
} satisfies Shot;

assert(hasActiveShotGeneration(generatingShot), "generating shot should be treated as active");
assert(
  selectedShotPendingRender(generatingShot)?.id === "render_stale",
  "generating shot should expose its pending render for elapsed/progress display"
);

console.log("shot generation state smoke passed");
