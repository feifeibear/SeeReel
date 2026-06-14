import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { applyPendingCreatedPositions } from "../src/client/flow/createdNodePlacement";

const source = readFileSync("src/client/flow/FlowView.tsx", "utf8");

assert.doesNotMatch(source, /position\.x\s*-\s*160/, "created nodes must not shift left from the right-click position");
assert.doesNotMatch(source, /position\.y\s*-\s*90/, "created nodes must not shift up from the right-click position");
assert.match(source, /pendingCreatedPositionsRef\.current\.set\(nodeId,\s*position\)/, "created nodes should use the projected click position directly");
assert.match(source, /persistCreatedNodePosition/, "created node placement should be persisted immediately, not only after dragging");
assert.match(source, /\[nodeId\]:\s*\{\s*x:\s*position\.x,\s*y:\s*position\.y\s*\}/, "persisted created node position should use the clicked canvas coordinate exactly");
assert.match(source, /await persistCreatedNodePosition\(/, "right-click create actions should await placement persistence before refreshing");

const pendingPositions = new Map([["image-new", { x: 420, y: 260 }]]);
const nodes = applyPendingCreatedPositions(
  [{ id: "image-old", position: { x: 10, y: 20 }, data: {}, type: "imageNode" }],
  [
    { id: "image-old", position: { x: 60, y: 60 }, data: {}, type: "imageNode" },
    { id: "image-new", position: { x: 60, y: 300 }, data: {}, type: "imageNode" }
  ],
  pendingPositions,
  new Set()
);

assert.deepEqual(
  nodes.find((node) => node.id === "image-new")?.position,
  { x: 420, y: 260 },
  "newly created right-click nodes should enter the graph at the clicked mouse position"
);
assert.deepEqual(
  nodes.find((node) => node.id === "image-old")?.position,
  { x: 10, y: 20 },
  "existing nodes should keep their current dragged position during graph refresh"
);
assert.equal(pendingPositions.has("image-new"), false, "pending created position should be consumed after it is applied");

console.log("smoke:canvas-create-placement passed");
