import {
  buildCanvasPath,
  buildGalleryPath,
  parseAppRoute
} from "../src/client/routes";

function assertEqual<T>(actual: T, expected: T, label: string) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

assertEqual(buildGalleryPath(), "/gallery", "gallery path should be clean");
assertEqual(buildCanvasPath("ses_route_smoke"), "/canvas/ses_route_smoke", "canvas path should include session id");
assertEqual(buildCanvasPath(""), "/canvas", "canvas path should omit blank session id");

assertEqual(
  parseAppRoute({ pathname: "/gallery", hash: "" }).view,
  "gallery",
  "clean gallery path should select Gallery"
);
assertEqual(
  parseAppRoute({ pathname: "/canvas/ses_route_smoke", hash: "" }).sessionId,
  "ses_route_smoke",
  "clean canvas path should preserve session id"
);
assertEqual(
  parseAppRoute({ pathname: "/", hash: "" }).view,
  "studio",
  "root path should default to Studio/Canvas"
);
assertEqual(
  parseAppRoute({ pathname: "/", hash: "#/s/ses_legacy" }).sessionId,
  "ses_legacy",
  "legacy session hash should remain readable"
);
assertEqual(
  parseAppRoute({ pathname: "/", hash: "#/gallery" }).view,
  "gallery",
  "legacy gallery hash should remain readable"
);

console.log("client route smoke passed");
