import { getRequestAgentPlanKey } from "./userCredentials";

export const ARK_AGENT_PLAN_BASE = "https://ark.cn-beijing.volces.com/api/plan/v3";

export interface ArkCredential {
  apiKey?: string;
  apiBase: string;
  source: "standard" | "agent-plan" | "missing";
}

export interface ResolveArkCredentialOpts {
  keyEnvNames: string[];
  baseEnvNames: string[];
  defaultBase: string;
  preferAgentPlan?: boolean;
  allowRequestAgentPlan?: boolean;
  allowEnvAgentPlan?: boolean;
}

export function resolveArkCredential(opts: ResolveArkCredentialOpts): ArkCredential {
  const requestAgentPlanKey = getRequestAgentPlanKey();
  const agentPlanKey = env("ARK_AGENT_PLAN_KEY", "AGENT_PLAN_API_KEY", "VOLCENGINE_AGENT_PLAN_KEY");
  const standardKey = env(...opts.keyEnvNames);
  const standardBase = (env(...opts.baseEnvNames) || opts.defaultBase).replace(/\/$/, "");
  const preferAgentPlan = opts.preferAgentPlan ?? (isEnabled("REELYAI_USE_AGENT_PLAN") || env("REELYAI_CREDENTIAL_MODE") === "agent-plan");
  const allowRequestAgentPlan = opts.allowRequestAgentPlan ?? true;
  const allowEnvAgentPlan = opts.allowEnvAgentPlan ?? true;

  if (allowRequestAgentPlan && requestAgentPlanKey) {
    return { apiKey: requestAgentPlanKey, apiBase: agentPlanBase(), source: "agent-plan" };
  }
  if (allowEnvAgentPlan && preferAgentPlan && agentPlanKey) {
    return { apiKey: agentPlanKey, apiBase: agentPlanBase(), source: "agent-plan" };
  }
  if (standardKey) {
    return { apiKey: standardKey, apiBase: standardBase, source: "standard" };
  }
  if (allowEnvAgentPlan && agentPlanKey) {
    return { apiKey: agentPlanKey, apiBase: agentPlanBase(), source: "agent-plan" };
  }
  return { apiBase: standardBase, source: "missing" };
}

export function hasAgentPlanKey() {
  return Boolean(getRequestAgentPlanKey() || env("ARK_AGENT_PLAN_KEY", "AGENT_PLAN_API_KEY", "VOLCENGINE_AGENT_PLAN_KEY"));
}

export function arkMissingKeyMessage(service: string, existingEnvNames: string[]) {
  return `Missing ${service} API key (${existingEnvNames.join(" / ")} / ARK_AGENT_PLAN_KEY)`;
}

function agentPlanBase() {
  return (env("ARK_AGENT_PLAN_BASE", "AGENT_PLAN_API_BASE") || ARK_AGENT_PLAN_BASE).replace(/\/$/, "");
}

function isEnabled(name: string) {
  return /^(1|true|yes|on)$/i.test(env(name) || "");
}

function env(...keys: string[]) {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}
