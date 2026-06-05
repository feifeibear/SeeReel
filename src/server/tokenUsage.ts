import type { TokenUsageBreakdown, TokenUsageEvent, TokenUsageModelFamily } from "../shared/types";

type UsageLike = Record<string, unknown>;

export type TokenUsageInput = Omit<TokenUsageEvent, "id" | "sessionId" | "createdAt"> & {
  id?: string;
  sessionId?: string;
  createdAt?: string;
};

export function tokenUsageFromRaw(raw: unknown): TokenUsageBreakdown | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as UsageLike;
  if (record.usage && typeof record.usage === "object") {
    const nested = tokenUsageFromRaw(record.usage);
    if (nested) return nested;
  }
  if (record.data && typeof record.data === "object") {
    const nested = tokenUsageFromRaw(record.data);
    if (nested) return nested;
  }

  const inputTokens = firstNumber(record, [
    "input_tokens",
    "inputTokens",
    "prompt_tokens",
    "promptTokens",
    "cached_input_tokens",
    "cachedInputTokens"
  ]);
  const outputTokens = firstNumber(record, [
    "output_tokens",
    "outputTokens",
    "completion_tokens",
    "completionTokens",
    "generated_tokens",
    "generatedTokens"
  ]);
  const directTotal = firstNumber(record, ["total_tokens", "totalTokens", "total_tokens_used", "totalTokensUsed", "total"]);
  const totalTokens = directTotal ?? ((inputTokens ?? 0) + (outputTokens ?? 0));
  if (!Number.isFinite(totalTokens) || totalTokens <= 0) return undefined;
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    totalTokens
  };
}

export function tokenUsageEventFromRaw(
  rawUsage: unknown,
  event: Omit<TokenUsageInput, "inputTokens" | "outputTokens" | "totalTokens" | "rawUsage">
): TokenUsageInput | undefined {
  const usage = tokenUsageFromRaw(rawUsage);
  if (!usage) return undefined;
  return {
    ...event,
    ...usage,
    modelFamily: event.modelFamily || inferTokenUsageModelFamily(event),
    rawUsage
  };
}

export function inferTokenUsageModelFamily(event: Pick<TokenUsageInput, "model" | "provider">): TokenUsageModelFamily {
  const model = (event.model || "").toLowerCase();
  const provider = (event.provider || "").toLowerCase();
  if (
    model.includes("seedream-5-lite") ||
    model.includes("seedream_5_lite") ||
    model.includes("seedream-5.0-lite") ||
    model.includes("seedream5lite") ||
    model.includes("doubao-seedream-5.0-lite")
  ) return "seedream-5-lite";
  if (model.includes("seedream-4-5") || model.includes("seedream_4_5") || model.includes("seedream4.5")) return "seedream-4-5";
  if (model.includes("seedream-4") || model.includes("seedream_4") || model.includes("seedream4") || provider === "seedream") return "seedream-4";
  if (model.includes("fast") && (model.includes("seedance") || provider === "seedance")) return "seedance-2-0-fast";
  if (model.includes("seedance") || provider === "seedance") return "seedance-2-0";
  return "other";
}

function firstNumber(record: UsageLike, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.round(value));
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return Math.max(0, Math.round(parsed));
    }
  }
  return undefined;
}
