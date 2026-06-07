import { readFileSync } from "node:fs";
import { resolveInitialLanguage } from "../src/client/i18n";
import { resolveSessionDockState } from "../src/client/sessionDockState";
import { resolveCanvasCreatePosition } from "../src/client/flow/canvasPosition";
import { buildSessionGraph } from "../src/client/flow/buildGraph";
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

const visualReferenceSnapshot = {
  runtime: { seedreamDefaultModel: "seedream-4-5" as const },
  sessions: [],
  shots: [],
  assets: [
    {
      id: "assetChar",
      name: "Character",
      type: "character" as const,
      mediaKind: "image" as const,
      description: "",
      prompt: "",
      ownerSessionId: "sesA",
      referenceAssetIds: ["assetScene"],
      tags: ["anchor", "character"],
      createdAt: "",
      updatedAt: ""
    },
    {
      id: "assetScene",
      name: "Scene",
      type: "scene" as const,
      mediaKind: "image" as const,
      description: "",
      prompt: "",
      ownerSessionId: "sesA",
      referenceAssetIds: ["storyboardAsset"],
      tags: ["anchor", "scene"],
      createdAt: "",
      updatedAt: ""
    },
    {
      id: "storyboardAsset",
      name: "Storyboard",
      type: "scene" as const,
      mediaKind: "image" as const,
      description: "",
      prompt: "",
      ownerShotId: "shotA",
      referenceAssetIds: ["assetChar"],
      tags: ["sub-storyboard", "shot-scoped"],
      createdAt: "",
      updatedAt: ""
    }
  ]
};

const visualReferenceSession = {
  id: "sesA",
  title: "Session",
  logline: "",
  style: "",
  targetDurationSec: 10,
  createdAt: "",
  updatedAt: "",
  shots: [{
    id: "shotA",
    sessionId: "sesA",
    index: 1,
    title: "Shot 1",
    durationSec: 5,
    rawPrompt: "",
    prompt: "",
    assetIds: ["assetChar"],
    subShotPanelCount: 9,
    subShotStoryboardAssetId: "storyboardAsset",
    subShotStoryboardAssetIds: ["storyboardAsset"],
    renders: [],
    status: "draft" as const,
    createdAt: "",
    updatedAt: ""
  }]
};
const visualReferenceGraph = buildSessionGraph(visualReferenceSnapshot, visualReferenceSession);
assertEqual(
  visualReferenceGraph.edges.some((edge) => edge.id === "e-assetref-assetScene-assetChar"),
  true,
  "character assets can reference scene assets for image generation"
);
assertEqual(
  visualReferenceGraph.edges.some((edge) => edge.id === "e-storyboardref-storyboardAsset-assetScene"),
  true,
  "scene assets can reference storyboard assets for image generation"
);
assertEqual(
  visualReferenceGraph.edges.some((edge) => edge.id === "e-asset-assetChar-storyboard-shotA"),
  true,
  "storyboards can reference character assets for image generation"
);

const pendingAssetReferenceEdge = buildPendingConnectEdge({
  connection: { source: "asset-assetScene", target: "asset-assetChar" },
  session: visualReferenceSession,
  snapshot: visualReferenceSnapshot
});
assertEqual(pendingAssetReferenceEdge?.id, "e-assetref-assetScene-assetChar", "pending asset reference edge matches final edge id");

const createNodeMenuSource = readFileSync(new URL("../src/client/flow/CreateNodeMenu.tsx", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../src/client/App.tsx", import.meta.url), "utf8");
const flowSource = readFileSync(new URL("../src/client/flow/FlowView.tsx", import.meta.url), "utf8");
assertEqual(createNodeMenuSource.includes('"storyboard"'), true, "right-click create menu exposes a storyboard option");
assertEqual(flowSource.includes('if (option === "storyboard")'), true, "right-click storyboard option creates a visible storyboard node");

assertEqual(resolveInitialLanguage(null), "zh", "fresh public entry defaults to Chinese");
assertEqual(resolveInitialLanguage("en", "zh"), "en", "current-version explicit English preference is respected");
assertEqual(resolveInitialLanguage(null, "en"), "zh", "legacy English preference does not override Chinese default");

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
  'className="vision-review-toggle"',
  "title={t.app.refresh}"
].forEach((pattern) => {
  assertEqual(appSource.includes(pattern), false, `App top actions do not expose utility control: ${pattern}`);
});

[
  "optimisticEdgesRef",
  "addOptimisticEdge",
  "resolveReplacedOptimisticNodePosition"
].forEach((pattern) => {
  assertEqual(flowSource.includes(pattern), false, `FlowView does not render structural optimistic canvas state: ${pattern}`);
});

console.log("ui interaction smoke passed");
