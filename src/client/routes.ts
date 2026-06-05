export type AppView = "studio" | "gallery";

export interface AppRoute {
  view: AppView;
  sessionId: string;
}

export interface LocationLike {
  pathname: string;
  hash?: string;
}

function safeDecode(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function buildGalleryPath() {
  return "/gallery";
}

export function buildCanvasPath(sessionId?: string) {
  const cleanId = sessionId?.trim();
  return cleanId ? `/canvas/${encodeURIComponent(cleanId)}` : "/canvas";
}

export function parseAppRoute(location: LocationLike): AppRoute {
  const pathname = (location.pathname || "/").replace(/\/+$/, "") || "/";
  if (pathname === "/gallery") return { view: "gallery", sessionId: "" };

  const canvasMatch = pathname.match(/^\/canvas(?:\/([^/]+))?$/);
  if (canvasMatch) {
    return { view: "studio", sessionId: canvasMatch[1] ? safeDecode(canvasMatch[1]) : "" };
  }

  const hash = location.hash || "";
  if (hash.startsWith("#/gallery")) return { view: "gallery", sessionId: "" };
  const legacySessionMatch = hash.match(/^#\/s\/([A-Za-z0-9_-]+)/);
  if (legacySessionMatch) return { view: "studio", sessionId: legacySessionMatch[1] };

  return { view: "studio", sessionId: "" };
}
