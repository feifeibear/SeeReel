function envDisabled(name: string) {
  return /^(0|false|no|off)$/i.test(process.env[name]?.trim() || "");
}

export function seedreamWebSearchPayload() {
  if (envDisabled("SEEDREAM_WEB_SEARCH")) return {};
  return {
    model_params: {
      tools: [{ type: "web_search" }]
    }
  };
}
