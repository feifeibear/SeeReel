export interface NextSessionSelectionInput {
  orderedSessionIds: string[];
  selectedSessionIds: Set<string>;
  lastSelectedSessionId: string | undefined;
  clickedSessionId: string;
  shiftKey: boolean;
}

export interface NextSessionSelectionResult {
  selectedSessionIds: Set<string>;
  lastSelectedSessionId: string;
}

export function nextSessionSelection(input: NextSessionSelectionInput): NextSessionSelectionResult {
  const selectedSessionIds = new Set(input.selectedSessionIds);
  if (input.shiftKey && input.lastSelectedSessionId) {
    const from = input.orderedSessionIds.indexOf(input.lastSelectedSessionId);
    const to = input.orderedSessionIds.indexOf(input.clickedSessionId);
    if (from >= 0 && to >= 0) {
      const [start, end] = from < to ? [from, to] : [to, from];
      input.orderedSessionIds.slice(start, end + 1).forEach((id) => selectedSessionIds.add(id));
      return { selectedSessionIds, lastSelectedSessionId: input.clickedSessionId };
    }
  }

  if (selectedSessionIds.has(input.clickedSessionId)) {
    selectedSessionIds.delete(input.clickedSessionId);
  } else {
    selectedSessionIds.add(input.clickedSessionId);
  }
  return { selectedSessionIds, lastSelectedSessionId: input.clickedSessionId };
}
