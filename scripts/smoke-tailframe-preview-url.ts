import { strict as assert } from "node:assert";
import { assetThumbUrl, tailframeThumbUrl } from "../src/client/flow/mediaUrls";

const remoteTosUrl = "https://tos.example.com/presigned-tailframe.jpg?expires=soon";
const localMediaUrl = "/media/tailframe-shot-1.jpg";

assert.equal(
  assetThumbUrl({ mediaUrl: remoteTosUrl, referenceImageUrl: localMediaUrl }),
  localMediaUrl,
  "canvas image assets should prefer the stable local media URL over an expiring remote URL"
);

assert.equal(
  tailframeThumbUrl({ mediaUrl: remoteTosUrl, imageUrl: remoteTosUrl, referenceImageUrl: localMediaUrl }),
  localMediaUrl,
  "tail-frame previews should prefer the stable local media URL over an expiring remote URL"
);

assert.equal(
  tailframeThumbUrl({ mediaUrl: remoteTosUrl, imageUrl: remoteTosUrl }),
  remoteTosUrl,
  "tail-frame previews should fall back to the remote URL when no local media URL exists"
);

console.log("tailframe preview URL smoke passed");
