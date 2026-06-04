export function resolveNodeReviewEnabled(globalReview: boolean | undefined, nodeReview: boolean | undefined) {
  return globalReview !== false && nodeReview !== false;
}
