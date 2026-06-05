import { resolveRefreshSelectedSessionId } from "../src/client/sessionSelection";

function assertEqual(actual: string, expected: string, label: string) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

assertEqual(
  resolveRefreshSelectedSessionId({
    current: "ses_editing",
    fromRoute: "ses_editing",
    availableSessionIds: ["ses_newer"],
    deletedSessionIds: []
  }),
  "ses_editing",
  "refresh must not auto-switch away from the active session when a slow online snapshot omits it"
);

assertEqual(
  resolveRefreshSelectedSessionId({
    current: "",
    fromRoute: "ses_from_route",
    availableSessionIds: ["ses_latest", "ses_from_route"],
    deletedSessionIds: []
  }),
  "ses_from_route",
  "initial load should honor a valid route session"
);

assertEqual(
  resolveRefreshSelectedSessionId({
    current: "",
    fromRoute: "",
    availableSessionIds: ["ses_latest", "ses_old"],
    deletedSessionIds: []
  }),
  "ses_latest",
  "initial load without current or hash should select latest"
);

assertEqual(
  resolveRefreshSelectedSessionId({
    current: "ses_deleted",
    fromRoute: "ses_deleted",
    availableSessionIds: ["ses_survivor"],
    deletedSessionIds: ["ses_deleted"]
  }),
  "ses_survivor",
  "deleted active session should move to a surviving session"
);

console.log("session selection smoke passed");
