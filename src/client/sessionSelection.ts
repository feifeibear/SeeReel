export function resolveRefreshSelectedSessionId({
  current,
  fromHash,
  availableSessionIds,
  deletedSessionIds
}: {
  current: string;
  fromHash: string;
  availableSessionIds: string[];
  deletedSessionIds: string[];
}) {
  const available = new Set(availableSessionIds);
  const deleted = new Set(deletedSessionIds);

  if (current && !deleted.has(current)) return current;
  if (fromHash && available.has(fromHash) && !deleted.has(fromHash)) return fromHash;
  return availableSessionIds.find((id) => !deleted.has(id)) || "";
}
