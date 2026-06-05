export function assetThumbUrl(asset: { mediaUrl?: string; imageUrl?: string; referenceImageUrl?: string }) {
  return asset.mediaUrl || asset.imageUrl || asset.referenceImageUrl;
}

export function tailframeThumbUrl(asset: { mediaUrl?: string; imageUrl?: string; referenceImageUrl?: string }) {
  const stableLocalUrl = asset.referenceImageUrl?.startsWith("/media/") ? asset.referenceImageUrl : undefined;
  return stableLocalUrl || asset.mediaUrl || asset.imageUrl || asset.referenceImageUrl;
}
