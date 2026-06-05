export function resolveRefreshSelectedSessionId({
  current,
  fromRoute,
  availableSessionIds,
  deletedSessionIds
}: {
  current: string;
  fromRoute: string;
  availableSessionIds: string[];
  deletedSessionIds: string[];
}) {
  const available = new Set(availableSessionIds);
  const deleted = new Set(deletedSessionIds);

  if (current && !deleted.has(current)) return current;
  if (fromRoute && available.has(fromRoute) && !deleted.has(fromRoute)) return fromRoute;
  return availableSessionIds.find((id) => !deleted.has(id)) || "";
}
