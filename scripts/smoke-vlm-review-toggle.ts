import { resolveNodeReviewEnabled } from "../src/shared/reviewSettings";

function assertEqual<T>(actual: T, expected: T, label: string) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

assertEqual(resolveNodeReviewEnabled(true, undefined), false, "global on + default node still skips auto review");
assertEqual(resolveNodeReviewEnabled(true, true), false, "global on + node on still skips auto review");
assertEqual(resolveNodeReviewEnabled(true, false), false, "global on + node off skips review");
assertEqual(resolveNodeReviewEnabled(false, undefined), false, "global off + default node skips review");
assertEqual(resolveNodeReviewEnabled(false, true), false, "global off + node on still skips review");
assertEqual(resolveNodeReviewEnabled(undefined, false), false, "server default + node off skips review");
assertEqual(resolveNodeReviewEnabled(undefined, undefined), false, "server default + default node skips auto review");

console.log("vlm review toggle smoke passed");
