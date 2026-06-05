export type SessionDockEmptyState = "loading" | "empty" | "none";

export function resolveSessionDockState({
  stateLoaded,
  sessionCount,
  busy
}: {
  stateLoaded: boolean;
  sessionCount: number;
  busy: string;
}) {
  const loading = !stateLoaded;
  return {
    canCreateSession: !loading && busy !== "create-session",
    emptyState: loading ? "loading" as SessionDockEmptyState : sessionCount === 0 ? "empty" as SessionDockEmptyState : "none" as SessionDockEmptyState
  };
}
