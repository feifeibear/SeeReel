import type { StandardApiKeyRoute } from "../shared/types";
import { getRequestAgentPlanKey, getRequestApiKey, getRequestApiKeyCredential, hasRequestAgentPlanKey, hasRequestApiKey } from "./userCredentials";
import { getAdminAgentPlanKey, hasAdminAgentPlanKey } from "./adminSettings";

export const ARK_AGENT_PLAN_BASE = "https://ark.cn-beijing.volces.com/api/plan/v3";
export const BYTEPLUS_ARK_BASE = "https://ark.ap-southeast.bytepluses.com/api/v3";
export const VOLCENGINE_CN_ARK_BASE = "https://ark.cn-beijing.volces.com/api/v3";

export interface ArkCredential {
  apiKey?: string;
  apiBase: string;
  source: "standard" | "agent-plan" | "missing";
  standardRoute?: StandardApiKeyRoute;
}

export interface StandardCredentialRouteConfig {
  route: StandardApiKeyRoute;
  keyEnvNames: string[];
  baseEnvNames: string[];
  defaultBase: string;
}

export interface ResolveArkCredentialOpts {
  keyEnvNames: string[];
  baseEnvNames: string[];
  defaultBase: string;
  standardRoutes?: StandardCredentialRouteConfig[];
  preferAgentPlan?: boolean;
  allowRequestApiKey?: boolean;
  allowRequestAgentPlan?: boolean;
  allowEnvAgentPlan?: boolean;
}

export function resolveArkCredential(opts: ResolveArkCredentialOpts): ArkCredential {
  const requestApiKeyCredential = getRequestApiKeyCredential();
  const requestApiKey = requestApiKeyCredential?.apiKey || getRequestApiKey();
  const requestAgentPlanKey = getRequestAgentPlanKey();
  const adminTrialAgentPlanKey = getAdminAgentPlanKey();
  const agentPlanKey = env("ARK_AGENT_PLAN_KEY", "AGENT_PLAN_API_KEY", "VOLCENGINE_AGENT_PLAN_KEY");
  const allowRequestApiKey = opts.allowRequestApiKey ?? true;
  const allowRequestAgentPlan = opts.allowRequestAgentPlan ?? true;
  const allowEnvAgentPlan = opts.allowEnvAgentPlan ?? true;
  const standardRoutes = opts.standardRoutes?.length ? opts.standardRoutes : undefined;

  if (standardRoutes) {
    for (const route of standardRoutes) {
      const apiBase = routeBase(route);
      if (allowRequestApiKey && requestApiKey && (requestApiKeyCredential?.route || "byteplus") === route.route) {
        return { apiKey: requestApiKey, apiBase, source: "standard", standardRoute: route.route };
      }
      const routeKey = env(...route.keyEnvNames);
      if (routeKey) {
        return { apiKey: routeKey, apiBase, source: "standard", standardRoute: route.route };
      }
    }
  } else {
    const standardKey = env(...opts.keyEnvNames);
    const standardBase = (env(...opts.baseEnvNames) || opts.defaultBase).replace(/\/$/, "");
    if (allowRequestApiKey && requestApiKey) {
      return { apiKey: requestApiKey, apiBase: standardBase, source: "standard", standardRoute: requestApiKeyCredential?.route || "byteplus" };
    }
    if (standardKey) {
      return { apiKey: standardKey, apiBase: standardBase, source: "standard", standardRoute: inferStandardRouteFromBase(standardBase) };
    }
  }
  if (allowRequestAgentPlan && requestAgentPlanKey) {
    return { apiKey: requestAgentPlanKey, apiBase: agentPlanBase(), source: "agent-plan" };
  }
  if (allowEnvAgentPlan && adminTrialAgentPlanKey) {
    return { apiKey: adminTrialAgentPlanKey, apiBase: agentPlanBase(), source: "agent-plan" };
  }
  if (allowEnvAgentPlan && agentPlanKey) {
    return { apiKey: agentPlanKey, apiBase: agentPlanBase(), source: "agent-plan" };
  }
  const missingBase = standardRoutes ? routeBase(standardRoutes[0]) : (env(...opts.baseEnvNames) || opts.defaultBase).replace(/\/$/, "");
  return { apiBase: missingBase, source: "missing" };
}

export function hasAgentPlanKey() {
  return Boolean(getRequestAgentPlanKey() || hasAdminAgentPlanKey() || env("ARK_AGENT_PLAN_KEY", "AGENT_PLAN_API_KEY", "VOLCENGINE_AGENT_PLAN_KEY"));
}

export function hasStandardApiKey() {
  return Boolean(
    hasRequestApiKey() ||
      env(
        "BP_ARK_API_KEY",
        "BP_SEEDANCE_API_KEY",
        "BP_SEEDREAM_API_KEY",
        "CN_ARK_API_KEY",
        "CN_SEEDANCE_API_KEY",
        "CN_SEEDREAM_API_KEY",
        "ARK_API_KEY"
      )
  );
}

export function isUsingAdminTrialAgentPlan() {
  return Boolean(!hasRequestAgentPlanKey() && hasAdminAgentPlanKey());
}

export function arkMissingKeyMessage(service: string, existingEnvNames: string[]) {
  return `Missing ${service} API key (${existingEnvNames.join(" / ")} / ARK_AGENT_PLAN_KEY)`;
}

function agentPlanBase() {
  return (env("ARK_AGENT_PLAN_BASE", "AGENT_PLAN_API_BASE") || ARK_AGENT_PLAN_BASE).replace(/\/$/, "");
}

function routeBase(route: StandardCredentialRouteConfig) {
  return (env(...route.baseEnvNames) || route.defaultBase).replace(/\/$/, "");
}

function inferStandardRouteFromBase(apiBase: string): StandardApiKeyRoute {
  return /cn-beijing|volces\.com/i.test(apiBase) ? "volcengine-cn" : "byteplus";
}

function env(...keys: string[]) {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}
