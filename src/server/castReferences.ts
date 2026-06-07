import type { Asset, Session, StoryCharacter } from "../shared/types";

function normalizeMentionText(value: string | undefined) {
  return (value || "")
    .trim()
    .replace(/^@+/, "")
    .toLocaleLowerCase();
}

function isCastAssetVisibleToSession(asset: Asset, sessionId: string) {
  if (asset.ownerShotId) return false;
  if (asset.ownerSessionId && asset.ownerSessionId !== sessionId) return false;
  return true;
}

function castAliases(character: StoryCharacter) {
  return [
    character.assetMention,
    character.name
  ]
    .map(normalizeMentionText)
    .filter(Boolean);
}

function promptMentionsCast(promptText: string, character: StoryCharacter) {
  const normalizedPrompt = normalizeMentionText(promptText);
  return castAliases(character).some((alias) => normalizedPrompt.includes(`@${alias}`));
}

function findSessionCastAsset(character: StoryCharacter, allAssets: Asset[], sessionId: string) {
  const byId = character.assetId
    ? allAssets.find((asset) => asset.id === character.assetId)
    : undefined;
  if (byId && byId.type === "character" && isCastAssetVisibleToSession(byId, sessionId)) return byId;

  const aliases = new Set(castAliases(character));
  return allAssets.find((asset) => {
    if (asset.type !== "character") return false;
    if (!isCastAssetVisibleToSession(asset, sessionId)) return false;
    const sessionScoped = Boolean(asset.ownerSessionId) && asset.ownerSessionId === sessionId;
    const castTagged = (asset.tags || []).includes("cast");
    if (!sessionScoped && !castTagged) return false;
    return aliases.has(normalizeMentionText(asset.name));
  });
}

export function getMentionedSessionCastAssets(session: Session | undefined, allAssets: Asset[], promptText: string, allowedAssetIds?: Set<string>) {
  if (!session?.story?.characters?.length) return [];

  const assets: Asset[] = [];
  const seen = new Set<string>();
  for (const character of session.story.characters) {
    if (!character.name) continue;
    if (!character.assetId && !character.assetMention) continue;
    if (!promptMentionsCast(promptText, character)) continue;

    const match = findSessionCastAsset(character, allAssets, session.id);
    if (match && allowedAssetIds && !allowedAssetIds.has(match.id)) continue;
    if (!match || seen.has(match.id)) continue;
    seen.add(match.id);
    assets.push(match);
  }
  return assets;
}
