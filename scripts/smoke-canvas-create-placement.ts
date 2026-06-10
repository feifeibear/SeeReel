import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

const source = readFileSync("src/client/flow/FlowView.tsx", "utf8");

assert.doesNotMatch(source, /position\.x\s*-\s*160/, "created nodes must not shift left from the right-click position");
assert.doesNotMatch(source, /position\.y\s*-\s*90/, "created nodes must not shift up from the right-click position");
assert.match(source, /pendingCreatedPositionsRef\.current\.set\(nodeId,\s*position\)/, "created nodes should use the projected click position directly");
assert.match(source, /persistCreatedNodePosition/, "created node placement should be persisted immediately, not only after dragging");
assert.match(source, /\[nodeId\]:\s*\{\s*x:\s*position\.x,\s*y:\s*position\.y\s*\}/, "persisted created node position should use the clicked canvas coordinate exactly");
assert.match(source, /await persistCreatedNodePosition\(/, "right-click create actions should await placement persistence before refreshing");

console.log("smoke:canvas-create-placement passed");
