import { resolveSessionDockState } from "../src/client/sessionDockState";
import { resolveCanvasCreatePosition } from "../src/client/flow/canvasPosition";
import { resolveCreatedStitchJobFollowupPatch } from "../src/client/stitchOptimistic";
import { resolveCreatedAssetFollowupShotPatches } from "../src/client/assetOptimistic";
import { resolveReplacedOptimisticNodePosition } from "../src/client/flow/optimisticNodePosition";

function assertEqual<T>(actual: T, expected: T, label: string) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

const loadingDock = resolveSessionDockState({ stateLoaded: false, sessionCount: 0, busy: "" });
assertEqual(loadingDock.canCreateSession, false, "session create is disabled until the first state snapshot loads");
assertEqual(loadingDock.emptyState, "loading", "session dock shows loading instead of empty history before state loads");

const emptyDock = resolveSessionDockState({ stateLoaded: true, sessionCount: 0, busy: "" });
assertEqual(emptyDock.canCreateSession, true, "session create is enabled after the first state snapshot loads");
assertEqual(emptyDock.emptyState, "empty", "session dock shows the empty prompt only after state has loaded");

let usedReactFlowProjection = false;
const projectedPosition = resolveCanvasCreatePosition({
  clientX: 420,
  clientY: 300,
  canvasRect: { left: 100, top: 50 },
  screenToFlowPosition: (point) => {
    usedReactFlowProjection = true;
    assertEqual(point.x, 420, "screen projection receives viewport x");
    assertEqual(point.y, 300, "screen projection receives viewport y");
    return { x: 24, y: 48 };
  }
});
assertEqual(usedReactFlowProjection, true, "canvas placement uses React Flow projection when available");
assertEqual(projectedPosition?.x, 24, "projected canvas x");
assertEqual(projectedPosition?.y, 48, "projected canvas y");

const fallbackPosition = resolveCanvasCreatePosition({
  clientX: 420,
  clientY: 300,
  canvasRect: { left: 100, top: 50 }
});
assertEqual(fallbackPosition?.x, 320, "fallback canvas x subtracts rect left");
assertEqual(fallbackPosition?.y, 250, "fallback canvas y subtracts rect top");

const followupPatch = resolveCreatedStitchJobFollowupPatch({
  createdJobs: [
    { id: "stitch_real", name: "拼接 1", shotIds: [], status: "idle", createdAt: "2026-06-04T00:00:00.000Z", updatedAt: "2026-06-04T00:00:00.000Z" }
  ],
  optimisticJob: { id: "stitch_pending_1", name: "拼接 1", shotIds: ["shot_a"], status: "idle", createdAt: "2026-06-04T00:00:00.000Z", updatedAt: "2026-06-04T00:00:00.000Z" }
});
assertEqual(followupPatch?.jobId, "stitch_real", "created stitch job followup targets the real server job");
assertEqual(followupPatch?.shotIds.join(","), "shot_a", "created stitch job followup preserves pending shot links");

const noFollowupPatch = resolveCreatedStitchJobFollowupPatch({
  createdJobs: [
    { id: "stitch_real", name: "拼接 1", shotIds: ["shot_a"], status: "idle", createdAt: "2026-06-04T00:00:00.000Z", updatedAt: "2026-06-04T00:00:00.000Z" }
  ],
  optimisticJob: { id: "stitch_pending_1", name: "拼接 1", shotIds: ["shot_a"], status: "idle", createdAt: "2026-06-04T00:00:00.000Z", updatedAt: "2026-06-04T00:00:00.000Z" }
});
assertEqual(noFollowupPatch, undefined, "no stitch followup patch when the server job already has the pending links");

const assetFollowupPatches = resolveCreatedAssetFollowupShotPatches({
  shots: [
    {
      id: "shot_a",
      sessionId: "session_1",
      index: 1,
      title: "A",
      script: "",
      camera: "",
      durationSec: 5,
      assetIds: ["asset_pending_1", "asset_keep"],
      firstFrameAssetId: "asset_pending_1",
      prompt: "",
      status: "draft",
      createdAt: "2026-06-04T00:00:00.000Z",
      updatedAt: "2026-06-04T00:00:00.000Z"
    }
  ],
  optimisticAssetId: "asset_pending_1",
  createdAssetId: "asset_real"
});
assertEqual(assetFollowupPatches.length, 1, "created asset followup patches shots with pending references");
assertEqual(assetFollowupPatches[0]?.shotId, "shot_a", "created asset followup targets the affected shot");
assertEqual(assetFollowupPatches[0]?.patch.assetIds?.join(","), "asset_real,asset_keep", "created asset followup replaces pending asset list id");
assertEqual(assetFollowupPatches[0]?.patch.firstFrameAssetId, "asset_real", "created asset followup replaces pending frame anchor id");

const replacementPosition = resolveReplacedOptimisticNodePosition({
  next: { id: "stitch-session-stitch_real", kind: "stitch", jobId: "stitch_real", jobName: "拼接 1" },
  previous: [
    { id: "stitch-session-stitch_pending_1", kind: "stitch", jobId: "stitch_pending_1", jobName: "拼接 1", position: { x: 120, y: 240 } }
  ]
});
assertEqual(replacementPosition?.x, 120, "real stitch node inherits pending stitch x");
assertEqual(replacementPosition?.y, 240, "real stitch node inherits pending stitch y");

const assetReplacementPosition = resolveReplacedOptimisticNodePosition({
  next: { id: "asset-asset_real", kind: "asset", assetId: "asset_real", assetName: "未命名角色" },
  previous: [
    { id: "asset-asset_pending_1", kind: "asset", assetId: "asset_pending_1", assetName: "未命名角色", position: { x: 88, y: 144 } }
  ]
});
assertEqual(assetReplacementPosition?.x, 88, "real asset node inherits pending asset x");
assertEqual(assetReplacementPosition?.y, 144, "real asset node inherits pending asset y");

const refVideoReplacementPosition = resolveReplacedOptimisticNodePosition({
  next: { id: "refvideo-asset_real", kind: "referenceVideo", assetId: "asset_real", assetName: "sample" },
  previous: [
    { id: "refvideo-pending-ref-video-1", kind: "referenceVideo", assetId: "pending-ref-video-1", assetName: "sample", position: { x: 44, y: 72 } }
  ]
});
assertEqual(refVideoReplacementPosition?.x, 44, "real reference-video node inherits pending upload x");
assertEqual(refVideoReplacementPosition?.y, 72, "real reference-video node inherits pending upload y");

console.log("ui interaction smoke passed");
