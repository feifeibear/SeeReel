import { resolveRefreshSelectedSessionId } from "../src/client/sessionSelection";

function assertEqual(actual: string, expected: string, label: string) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

assertEqual(
  resolveRefreshSelectedSessionId({
    current: "ses_editing",
    fromHash: "ses_editing",
    availableSessionIds: ["ses_newer"],
    deletedSessionIds: []
  }),
  "ses_editing",
  "refresh must not auto-switch away from the active session when a slow online snapshot omits it"
);

assertEqual(
  resolveRefreshSelectedSessionId({
    current: "",
    fromHash: "ses_from_hash",
    availableSessionIds: ["ses_latest", "ses_from_hash"],
    deletedSessionIds: []
  }),
  "ses_from_hash",
  "initial load should honor a valid hash session"
);

assertEqual(
  resolveRefreshSelectedSessionId({
    current: "",
    fromHash: "",
    availableSessionIds: ["ses_latest", "ses_old"],
    deletedSessionIds: []
  }),
  "ses_latest",
  "initial load without current or hash should select latest"
);

assertEqual(
  resolveRefreshSelectedSessionId({
    current: "ses_deleted",
    fromHash: "ses_deleted",
    availableSessionIds: ["ses_survivor"],
    deletedSessionIds: ["ses_deleted"]
  }),
  "ses_survivor",
  "deleted active session should move to a surviving session"
);

console.log("session selection smoke passed");
