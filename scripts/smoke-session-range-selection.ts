import { strict as assert } from "node:assert";
import { nextSessionSelection } from "../src/client/sessionMultiSelect";

const sessionIds = ["ses_1", "ses_2", "ses_3", "ses_4", "ses_5"];

let state = nextSessionSelection({
  orderedSessionIds: sessionIds,
  selectedSessionIds: new Set<string>(),
  lastSelectedSessionId: undefined,
  clickedSessionId: "ses_2",
  shiftKey: false
});
assert.deepEqual([...state.selectedSessionIds], ["ses_2"]);
assert.equal(state.lastSelectedSessionId, "ses_2");

state = nextSessionSelection({
  orderedSessionIds: sessionIds,
  selectedSessionIds: state.selectedSessionIds,
  lastSelectedSessionId: state.lastSelectedSessionId,
  clickedSessionId: "ses_5",
  shiftKey: true
});
assert.deepEqual([...state.selectedSessionIds].sort(), ["ses_2", "ses_3", "ses_4", "ses_5"]);
assert.equal(state.lastSelectedSessionId, "ses_5");

state = nextSessionSelection({
  orderedSessionIds: sessionIds,
  selectedSessionIds: state.selectedSessionIds,
  lastSelectedSessionId: state.lastSelectedSessionId,
  clickedSessionId: "ses_3",
  shiftKey: false
});
assert.deepEqual([...state.selectedSessionIds].sort(), ["ses_2", "ses_4", "ses_5"]);
assert.equal(state.lastSelectedSessionId, "ses_3");

console.log("session range selection smoke passed");
