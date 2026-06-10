export function assetThumbUrl(asset: { mediaUrl?: string; imageUrl?: string; referenceImageUrl?: string }) {
  const stableLocalUrl = [asset.referenceImageUrl, asset.imageUrl, asset.mediaUrl].find((url) => url?.startsWith("/media/"));
  return stableLocalUrl || asset.mediaUrl || asset.imageUrl || asset.referenceImageUrl;
}

export function tailframeThumbUrl(asset: { mediaUrl?: string; imageUrl?: string; referenceImageUrl?: string }) {
  const stableLocalUrl = [asset.referenceImageUrl, asset.imageUrl, asset.mediaUrl].find((url) => url?.startsWith("/media/"));
  return stableLocalUrl || asset.mediaUrl || asset.imageUrl || asset.referenceImageUrl;
}
