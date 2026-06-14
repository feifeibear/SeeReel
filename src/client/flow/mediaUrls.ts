export function assetThumbUrl(asset: { mediaUrl?: string; imageUrl?: string; thumbnailUrl?: string; sourceImageUrl?: string; referenceImageUrl?: string }) {
  const stableLocalUrl = [asset.thumbnailUrl, asset.imageUrl, asset.mediaUrl, asset.referenceImageUrl].find((url) => url?.startsWith("/media/"));
  return asset.thumbnailUrl || stableLocalUrl || asset.mediaUrl || asset.imageUrl || asset.sourceImageUrl || asset.referenceImageUrl;
}

export function tailframeThumbUrl(asset: { mediaUrl?: string; imageUrl?: string; thumbnailUrl?: string; sourceImageUrl?: string; referenceImageUrl?: string }) {
  const stableLocalUrl = [asset.thumbnailUrl, asset.imageUrl, asset.mediaUrl, asset.referenceImageUrl].find((url) => url?.startsWith("/media/"));
  return asset.thumbnailUrl || stableLocalUrl || asset.mediaUrl || asset.imageUrl || asset.sourceImageUrl || asset.referenceImageUrl;
}
