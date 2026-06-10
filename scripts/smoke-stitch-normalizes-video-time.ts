import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync("src/server/generators.ts", "utf8");
const stitchMatch = source.match(/export async function stitchShotVideos[\s\S]*?\n}\n\nasync function materializeVideo/);

assert.ok(stitchMatch, "stitchShotVideos should exist");

const stitchBody = stitchMatch[0];

assert.match(
  source,
  /async function normalizeStitchInputVideo\(/,
  "stitching should normalize each input into a fresh MP4 segment before concat"
);

assert.match(
  stitchBody,
  /normalizeStitchInputVideo\(/,
  "stitchShotVideos should call normalizeStitchInputVideo for every materialized input"
);

assert.match(
  source,
  /setpts=PTS-STARTPTS/,
  "normalized stitch inputs should reset video timestamps"
);

assert.match(
  source,
  /aresample=async=1:first_pts=0/,
  "normalized stitch inputs should reset audio timestamps"
);

assert.match(
  source,
  /-shortest/,
  "normalized stitch inputs should avoid inherited long audio or video tails"
);

assert.match(
  source,
  /maxDurationSec/,
  "final-video cache validation should reject outputs that are much longer than the selected shots"
);

console.log("stitch time normalization smoke passed");
