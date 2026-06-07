import type { Asset, AssetType, SessionLanguage } from "../shared/types";

export type ImageUploadKind = Extract<AssetType, "character" | "scene">;

export interface PendingImageUploadAssetInput {
  fileName: string;
  kind: ImageUploadKind;
  sessionId: string;
  objectUrl: string;
  now?: string;
  randomSuffix?: string;
  lang?: SessionLanguage;
}

export function imageUploadAssetName(fileName: string, kind: ImageUploadKind, lang: SessionLanguage = "zh") {
  const stem = fileName.replace(/\.[^/.]+$/, "");
  if (stem) return stem;
  if (kind === "character") return lang === "en" ? "Uploaded character" : "上传角色";
  return lang === "en" ? "Uploaded scene" : "上传场景";
}

export function imageUploadDescription(kind: ImageUploadKind, lang: SessionLanguage = "zh") {
  if (lang === "en") {
    return `Image imported from local disk and used as a ${kind === "character" ? "character" : "scene"} anchor`;
  }
  return `从本地拖入的图片，作为${kind === "character" ? "角色" : "场景"}锚使用`;
}

export function createPendingImageUploadAsset(input: PendingImageUploadAssetInput): Asset {
  const lang = input.lang || "zh";
  const now = input.now || new Date().toISOString();
  const suffix = input.randomSuffix || Math.random().toString(36).slice(2, 8);
  const timestamp = Number.isFinite(Date.parse(now)) ? Date.parse(now) : Date.now();
  return {
    id: `pending-image-upload-${timestamp}-${suffix}`,
    name: imageUploadAssetName(input.fileName, input.kind, lang),
    type: input.kind,
    mediaKind: "image",
    description: lang === "en" ? "Uploading image…" : "图片上传中…",
    prompt: "",
    mediaUrl: input.objectUrl,
    imageUrl: input.objectUrl,
    ownerSessionId: input.sessionId,
    tags: ["anchor", "uploaded", input.kind, "client-pending-upload"],
    createdAt: now,
    updatedAt: now
  };
}
