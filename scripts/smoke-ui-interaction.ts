import { readFileSync } from "node:fs";
import { resolveSessionDockState } from "../src/client/sessionDockState";
import { resolveCanvasCreatePosition } from "../src/client/flow/canvasPosition";
import { buildPendingConnectEdge, mergePendingEdges } from "../src/client/flow/pendingConnection";

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

const pendingStitchEdge = buildPendingConnectEdge({
  connection: { source: "shot_shotA".replace("shot_", "shot-"), target: "stitch-sesA-stitchA" },
  session: {
    id: "sesA",
    title: "Session",
    logline: "",
    style: "",
    targetDurationSec: 10,
    createdAt: "",
    updatedAt: "",
    shots: [{ id: "shotA", sessionId: "sesA", index: 1, title: "Shot 1", durationSec: 5, rawPrompt: "", prompt: "", assetIds: [], renders: [], status: "draft", createdAt: "", updatedAt: "" }],
    stitchJobs: [{ id: "stitchA", name: "Stitch", shotIds: [], status: "idle", createdAt: "", updatedAt: "" }]
  },
  snapshot: { sessions: [], shots: [], assets: [] },
  targetNodeData: {
    kind: "stitch",
    legacy: false,
    session: { id: "sesA", title: "Session", logline: "", style: "", targetDurationSec: 10, createdAt: "", updatedAt: "", shots: [] },
    job: { id: "stitchA", name: "Stitch", shotIds: [], status: "idle", createdAt: "", updatedAt: "" }
  }
});
assertEqual(pendingStitchEdge?.id, "e-stitch-shotA-sesA-stitchA", "pending stitch edge uses the final derived edge id");
assertEqual(pendingStitchEdge?.source, "shot-shotA", "pending stitch edge source");
assertEqual(pendingStitchEdge?.target, "stitch-sesA-stitchA", "pending stitch edge target");

const mergedPendingEdges = mergePendingEdges(
  [{ id: "edge-live", source: "a", target: "b" }],
  [pendingStitchEdge].filter((edge): edge is NonNullable<typeof edge> => Boolean(edge))
);
assertEqual(mergedPendingEdges.length, 2, "pending edge appears immediately before server refresh");
assertEqual(mergePendingEdges([pendingStitchEdge!], [pendingStitchEdge!]).length, 1, "server-confirmed edge replaces pending duplicate");

const appSource = readFileSync(new URL("../src/client/App.tsx", import.meta.url), "utf8");
const flowSource = readFileSync(new URL("../src/client/flow/FlowView.tsx", import.meta.url), "utf8");

[
  "optimisticAssets",
  "optimisticShots",
  "optimisticStitchJobs",
  "asset_pending_",
  "stitch_pending_"
].forEach((pattern) => {
  assertEqual(appSource.includes(pattern), false, `App does not keep structural optimistic canvas state: ${pattern}`);
});

[
  "optimisticEdgesRef",
  "addOptimisticEdge",
  "resolveReplacedOptimisticNodePosition"
].forEach((pattern) => {
  assertEqual(flowSource.includes(pattern), false, `FlowView does not render structural optimistic canvas state: ${pattern}`);
});

console.log("ui interaction smoke passed");
