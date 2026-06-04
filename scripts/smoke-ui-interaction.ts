import { readFileSync } from "node:fs";
import { resolveSessionDockState } from "../src/client/sessionDockState";
import { resolveCanvasCreatePosition } from "../src/client/flow/canvasPosition";

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
  "clientPending",
  "resolveReplacedOptimisticNodePosition"
].forEach((pattern) => {
  assertEqual(flowSource.includes(pattern), false, `FlowView does not render structural optimistic canvas state: ${pattern}`);
});

console.log("ui interaction smoke passed");
