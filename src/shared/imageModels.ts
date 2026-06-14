import type { AssetImageModel, SubStoryboardModel } from "./types";

export function normalizeAssetImageModel(value: unknown): AssetImageModel | undefined {
  if (typeof value !== "string") return undefined;
  const model = value.trim().toLowerCase().replace(/_/g, "-");
  if (!model) return undefined;
  if (model === "gpt-image-2" || model === "gpt-image2") return "gpt-image-2";
  if (model.includes("seedream-5.0-lite") || model.includes("seedream-5-lite")) return "seedream-5-lite";
  if (model.includes("seedream-4-5")) return "seedream-4-5";
  if (model.includes("seedream-4-0") || model === "seedream-4" || model === "doubao-seedream-4") return "seedream-4";
  return undefined;
}

export function normalizeSubStoryboardModel(value: unknown): SubStoryboardModel | undefined {
  const model = normalizeAssetImageModel(value);
  return model && model !== "gpt-image-2" ? model : undefined;
}

export function resolveAssetImageModelSelection(
  asset: { generationModel?: unknown; generationModelActual?: unknown },
  fallback?: unknown
): AssetImageModel {
  return normalizeAssetImageModel(asset.generationModel)
    || normalizeAssetImageModel(fallback)
    || normalizeAssetImageModel(asset.generationModelActual)
    || "seedream-4-5";
}
