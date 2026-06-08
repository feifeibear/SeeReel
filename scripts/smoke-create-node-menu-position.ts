import assert from "node:assert/strict";
import { resolveCreateNodeMenuLayout } from "../src/client/flow/createNodeMenuPosition";

const nearBottom = resolveCreateNodeMenuLayout({
  anchorX: 360,
  anchorY: 650,
  viewportWidth: 1024,
  viewportHeight: 760,
  menuWidth: 480,
  menuHeight: 700
});

assert.equal(nearBottom.placementY, "above");
assert.ok(nearBottom.top >= 12, "menu should stay inside the top viewport margin");
assert.ok(nearBottom.top + nearBottom.maxHeight <= 748, "menu should stay inside the bottom viewport margin");
assert.ok(nearBottom.maxHeight < 700, "menu should become scrollable when the full list cannot fit");

const nearRight = resolveCreateNodeMenuLayout({
  anchorX: 980,
  anchorY: 140,
  viewportWidth: 1024,
  viewportHeight: 760,
  menuWidth: 480,
  menuHeight: 420
});

assert.equal(nearRight.placementX, "left");
assert.ok(nearRight.left + 480 <= 1012, "menu should align left of the cursor near the right edge");

const roomy = resolveCreateNodeMenuLayout({
  anchorX: 220,
  anchorY: 120,
  viewportWidth: 1024,
  viewportHeight: 760,
  menuWidth: 360,
  menuHeight: 420
});

assert.equal(roomy.placementY, "below");
assert.equal(roomy.placementX, "right");
assert.equal(roomy.top, 120);
assert.equal(roomy.left, 220);
assert.equal(roomy.maxHeight, 420);

console.log("smoke:create-node-menu-position passed");
