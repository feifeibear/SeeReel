import { resolveNodeReviewEnabled } from "../src/shared/reviewSettings";

function assertEqual<T>(actual: T, expected: T, label: string) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

assertEqual(resolveNodeReviewEnabled(true, undefined), true, "global on + default node runs review");
assertEqual(resolveNodeReviewEnabled(true, true), true, "global on + node on runs review");
assertEqual(resolveNodeReviewEnabled(true, false), false, "global on + node off skips review");
assertEqual(resolveNodeReviewEnabled(false, undefined), false, "global off + default node skips review");
assertEqual(resolveNodeReviewEnabled(false, true), false, "global off + node on still skips review");
assertEqual(resolveNodeReviewEnabled(undefined, false), false, "server default + node off skips review");
assertEqual(resolveNodeReviewEnabled(undefined, undefined), true, "server default + default node runs review");

console.log("vlm review toggle smoke passed");
