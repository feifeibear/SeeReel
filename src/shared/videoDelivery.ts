export type VideoDeliveryMode = "playback" | "download";

export interface VideoDeliveryInput {
  videoUrl?: string;
  remoteVideoUrl?: string;
  playbackVideoUrl?: string;
  downloadVideoUrl?: string;
}

export function isRemoteDeliveryUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return ["http:", "https:"].includes(parsed.protocol) && !["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

export function shouldRedirectVideoDelivery(url: string | undefined): boolean {
  return isRemoteDeliveryUrl(url);
}

export function resolveVideoDeliveryUrl(source: VideoDeliveryInput, mode: VideoDeliveryMode = "playback"): string | undefined {
  const candidates = mode === "download"
    ? [source.downloadVideoUrl, source.playbackVideoUrl, source.remoteVideoUrl, source.videoUrl]
    : [source.playbackVideoUrl, source.downloadVideoUrl, source.remoteVideoUrl, source.videoUrl];
  return candidates.find(Boolean);
}
