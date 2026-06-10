import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const nodesSource = readFileSync("src/client/flow/nodes.tsx", "utf8");
const inspectorSource = readFileSync("src/client/flow/Inspector.tsx", "utf8");
const robustVideoThumbMatch = nodesSource.match(/function RobustVideoThumb[\s\S]*?\n}\n\nfunction statusBadge/);
const shotNodeMatch = nodesSource.match(/function ShotNodeImpl[\s\S]*?\n}\n\n\/\/ ============================================================================\n\/\/ StitchNode/);
const shotInspectorMatch = inspectorSource.match(/function ShotInspector[\s\S]*?\n}\n\n\/\/ ============================================================================\n\/\/ Stitch inspector/);

assert.ok(robustVideoThumbMatch, "RobustVideoThumb component should exist");
assert.ok(shotNodeMatch, "ShotNodeImpl component should exist");
assert.ok(shotInspectorMatch, "ShotInspector component should exist");

const robustVideoThumb = robustVideoThumbMatch[0];
const shotNode = shotNodeMatch[0];
const shotInspector = shotInspectorMatch[0];

assert.match(
  robustVideoThumb,
  /<video[\s\S]*?\bcontrols\b/,
  "canvas video nodes should render native video controls for play, pause, progress, and seek"
);

assert.doesNotMatch(
  robustVideoThumb,
  /controls=\{false\}/,
  "canvas video nodes must not disable native controls"
);

assert.doesNotMatch(
  robustVideoThumb,
  /flow-thumb-play|openLightbox|setOpen|<Lightbox/,
  "canvas video nodes should not require the thumbnail play button or lightbox for normal playback"
);

assert.doesNotMatch(
  robustVideoThumb,
  /className="flow-thumb-preview flow-video-player nodrag nopan"/,
  "video player wrapper must stay outside React Flow's nodrag marker so non-player chrome can still open/select the node"
);

assert.match(
  robustVideoThumb,
  /className="flow-video-element nodrag nopan"/,
  "the native video element should keep controls isolated from React Flow gestures"
);

assert.doesNotMatch(
  robustVideoThumb,
  /className="flow-video-drag-surface"/,
  "canvas video nodes must not place a transparent drag surface over native play/progress/seek controls"
);

assert.match(robustVideoThumb, /playsInline/, "inline video player should support mobile inline playback");
assert.match(robustVideoThumb, /preload=\{eager \? "auto" : "metadata"\}/, "inline player should keep metadata preload until visible or hovered");

assert.doesNotMatch(
  shotNode,
  /api\.(reviewShotVideo|createShotFirstFrame|createShotTailFrame|createShotTailClip)|api\.downloadShotUrl|<NodeModelPicker|className="flow-node-foot"/,
  "canvas Shot nodes should not render review/download/derived-frame/model/status controls over the video player"
);

for (const call of [
  "api.reviewShotVideo",
  "api.createShotFirstFrame",
  "api.createShotTailFrame",
  "api.createShotTailClip",
  "api.downloadShotUrl",
  "api.updateShot"
]) {
  assert.ok(shotInspector.includes(call), `Shot Inspector should own ${call}`);
}

assert.doesNotMatch(
  shotInspector,
  /参考上一镜尾段|Reference previous tail clip|updatePreviousShotClip|continuity-toggle clip-toggle/,
  "Shot Inspector should not expose the hidden previous-tail shortcut; use visible tail-clip nodes instead"
);

console.log("canvas video node playback smoke passed");
