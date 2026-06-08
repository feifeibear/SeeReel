import {
  clearShotPollFailure,
  recordShotPollFailure,
  shouldSurfaceShotPollError
} from "../src/client/shotPollErrors";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const failures = new Map<string, number>();
const shotId = "shot_poll_transient";

assert(
  !shouldSurfaceShotPollError(recordShotPollFailure(failures, shotId, new Error("502"))),
  "first 502 poll failure should be treated as transient"
);
assert(
  !shouldSurfaceShotPollError(recordShotPollFailure(failures, shotId, new Error("502 Bad Gateway"))),
  "second 502 poll failure should still be suppressed"
);
assert(
  shouldSurfaceShotPollError(recordShotPollFailure(failures, shotId, new Error("502"))),
  "third consecutive 502 poll failure should be shown"
);

clearShotPollFailure(failures, shotId);
assert(failures.get(shotId) === undefined, "successful poll should clear the failure count");
assert(
  !shouldSurfaceShotPollError(recordShotPollFailure(failures, shotId, new Error("Network connection lost"))),
  "network-level poll failure should use the same transient threshold"
);
assert(
  shouldSurfaceShotPollError(recordShotPollFailure(failures, shotId, new Error("Seedance polling failed: bad key"))),
  "non-transient provider errors should be shown immediately"
);

console.log("shot poll error smoke passed");
