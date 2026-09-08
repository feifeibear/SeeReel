import type { SeedanceVariant } from "./types";

export const SEEDANCE_20_MIN_DURATION_SEC = 1;
export const SEEDANCE_20_MAX_DURATION_SEC = 15;
export const SEEDANCE_25_MIN_DURATION_SEC = 4;
export const SEEDANCE_25_MAX_DURATION_SEC = 30;
export const SEEDANCE_20_VIDEO_LIMIT = 3;
export const SEEDANCE_20_AUDIO_LIMIT = 3;
export const SEEDANCE_25_VIDEO_LIMIT = 10;
export const SEEDANCE_25_AUDIO_LIMIT = 10;
export const SEEDANCE_25_IMAGE_LIMIT = 30;

export function normalizeSeedanceVariant(value: unknown): SeedanceVariant | undefined {
  if (typeof value !== "string") return undefined;
  const model = value.trim().toLowerCase().replace(/_/g, "-");
  if (!model) return undefined;
  if (
    model === "2.5"
    || model === "2-5"
    || model === "seedance-2.5"
    || model === "seedance-2-5"
    || model.includes("seedance-2-5")
    || model.includes("seedance-2.5")
  ) return "2.5";
  if (model === "fast" || (model.includes("fast") && model.includes("seedance"))) return "fast";
  if (
    model === "standard"
    || model === "2.0"
    || model === "2-0"
    || model === "seedance-2.0"
    || model === "seedance-2-0"
    || model.includes("seedance-2-0")
    || model.includes("seedance-2.0")
  ) return "standard";
  return undefined;
}

export function isSeedance25(variant?: SeedanceVariant | string): boolean {
  return normalizeSeedanceVariant(variant) === "2.5";
}

export function seedanceDurationBounds(variant?: SeedanceVariant | string): { min: number; max: number } {
  return isSeedance25(variant)
    ? { min: SEEDANCE_25_MIN_DURATION_SEC, max: SEEDANCE_25_MAX_DURATION_SEC }
    : { min: SEEDANCE_20_MIN_DURATION_SEC, max: SEEDANCE_20_MAX_DURATION_SEC };
}

export function clampSeedanceDurationSec(duration: unknown, variant?: SeedanceVariant | string): number {
  const { min, max } = seedanceDurationBounds(variant);
  const parsed = Number(duration);
  const fallback = Math.min(max, Math.max(min, 15));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

export function seedanceReferenceLimits(variant?: SeedanceVariant | string): {
  image: number;
  video: number;
  audio: number;
} {
  if (isSeedance25(variant)) {
    return {
      image: SEEDANCE_25_IMAGE_LIMIT,
      video: SEEDANCE_25_VIDEO_LIMIT,
      audio: SEEDANCE_25_AUDIO_LIMIT
    };
  }
  return {
    image: Number.POSITIVE_INFINITY,
    video: SEEDANCE_20_VIDEO_LIMIT,
    audio: SEEDANCE_20_AUDIO_LIMIT
  };
}
