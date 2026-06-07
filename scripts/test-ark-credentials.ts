import assert from "node:assert/strict";
import type { NextFunction, Request, Response } from "express";
import { ARK_AGENT_PLAN_BASE, isUsingAdminTrialAgentPlan, resolveArkCredential } from "../src/server/arkCredentials";
import { resolveSeedanceCredential, resolveSeedanceModel, resolveSeedreamCredential } from "../src/server/generators";
import {
  clearRequestAgentPlanKey,
  clearRequestApiKey,
  requestApiKeyStatus,
  setRequestAgentPlanKey,
  setRequestApiKey,
  userCredentialMiddleware
} from "../src/server/userCredentials";
import { resolveReviewModel } from "../src/server/visionReview";

const ENV_KEYS = [
  "ARK_AGENT_PLAN_KEY",
  "AGENT_PLAN_API_KEY",
  "VOLCENGINE_AGENT_PLAN_KEY",
  "ARK_AGENT_PLAN_BASE",
  "AGENT_PLAN_API_BASE",
  "VISION_REVIEW_API_KEY",
  "VISION_REVIEW_API_BASE",
  "VISION_REVIEW_MODEL",
  "VISION_REVIEW_AGENT_PLAN_MODEL",
  "REELYAI_VISION_REVIEW_USE_AGENT_PLAN",
  "SEEREEL_DISABLE_ADMIN_AGENT_PLAN",
  "SEEREEL_ADMIN_AGENT_PLAN_KEY",
  "BP_ARK_API_KEY",
  "BP_SEEDREAM_API_KEY",
  "BP_SEEDREAM_API_BASE",
  "BP_SEEDANCE_API_KEY",
  "BP_SEEDANCE_API_BASE",
  "CN_ARK_API_KEY",
  "CN_SEEDREAM_API_KEY",
  "CN_SEEDREAM_API_BASE",
  "CN_SEEDANCE_API_KEY",
  "CN_SEEDANCE_API_BASE",
  "SEEDANCE_API_KEY",
  "SEEDANCE_API_BASE",
  "SEEDANCE_MODEL",
  "SEEDANCE_CN_MODEL",
  "ARK_API_KEY"
];

const savedEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

function restoreEnv() {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function withUserRequest(fn: () => Promise<void>) {
  const req = {
    headers: {
      cookie: "reelyai_user_id=testuser1234567890"
    },
    socket: {
      remoteAddress: "127.0.0.1"
    }
  } as Request;
  const res = {
    cookie() {
      return this;
    }
  } as unknown as Response;
  await new Promise<void>((resolve, reject) => {
    userCredentialMiddleware(req, res, (() => {
      fn().then(resolve, reject);
    }) as NextFunction);
  });
}

try {
  for (const key of ENV_KEYS) delete process.env[key];

  await withUserRequest(async () => {
    await setRequestAgentPlanKey("browser-plan-key");

    const defaultCredential = resolveArkCredential({
      keyEnvNames: ["VISION_REVIEW_API_KEY"],
      baseEnvNames: ["VISION_REVIEW_API_BASE"],
      defaultBase: "https://standard.example/api/v3"
    });
    assert.equal(defaultCredential.source, "agent-plan");
    assert.equal(defaultCredential.apiKey, "browser-plan-key");
    assert.equal(defaultCredential.apiBase, ARK_AGENT_PLAN_BASE);

    const vlmCredential = resolveArkCredential({
      keyEnvNames: ["VISION_REVIEW_API_KEY"],
      baseEnvNames: ["VISION_REVIEW_API_BASE"],
      defaultBase: "https://standard.example/api/v3",
      allowRequestAgentPlan: false,
      allowEnvAgentPlan: false
    });
    assert.equal(vlmCredential.source, "missing");
    assert.equal(vlmCredential.apiKey, undefined);
    assert.equal(vlmCredential.apiBase, "https://standard.example/api/v3");

    process.env.VISION_REVIEW_API_KEY = "test-standard-vlm-key";
    const standardCredential = resolveArkCredential({
      keyEnvNames: ["VISION_REVIEW_API_KEY"],
      baseEnvNames: ["VISION_REVIEW_API_BASE"],
      defaultBase: "https://standard.example/api/v3",
      allowRequestAgentPlan: false,
      allowEnvAgentPlan: false
    });
    assert.equal(standardCredential.source, "standard");
    assert.equal(standardCredential.apiKey, "test-standard-vlm-key");

    await clearRequestAgentPlanKey();
  });

  process.env.SEEREEL_ADMIN_AGENT_PLAN_KEY = "test-admin-trial-plan-key";
  await withUserRequest(async () => {
    assert.equal(isUsingAdminTrialAgentPlan(), true);
    await setRequestApiKey("browser-bp-standard-key", "byteplus");
    assert.equal(isUsingAdminTrialAgentPlan(), false);
    await clearRequestApiKey();
    await setRequestAgentPlanKey("browser-plan-key");
    assert.equal(isUsingAdminTrialAgentPlan(), false);
    await clearRequestAgentPlanKey();
  });
  process.env.BP_ARK_API_KEY = "test-env-bp-standard-key";
  await withUserRequest(async () => {
    assert.equal(isUsingAdminTrialAgentPlan(), false);
  });
  delete process.env.BP_ARK_API_KEY;
  delete process.env.SEEREEL_ADMIN_AGENT_PLAN_KEY;

  await withUserRequest(async () => {
    await setRequestAgentPlanKey("browser-plan-key");
    await setRequestApiKey("browser-standard-key", "byteplus");

    const status = requestApiKeyStatus();
    assert.equal(status.configured, true);
    assert.equal(typeof status.fingerprint, "string");
    assert.equal(status.route, "byteplus");

    const preferredCredential = resolveArkCredential({
      keyEnvNames: ["BP_ARK_API_KEY", "BP_SEEDANCE_API_KEY"],
      baseEnvNames: ["SEEDANCE_API_BASE"],
      defaultBase: "https://standard.example/api/v3"
    });
    assert.equal(preferredCredential.source, "standard");
    assert.equal(preferredCredential.standardRoute, "byteplus");
    assert.equal(preferredCredential.apiKey, "browser-standard-key");
    assert.equal(preferredCredential.apiBase, "https://standard.example/api/v3");

    await clearRequestApiKey();
    const fallbackCredential = resolveArkCredential({
      keyEnvNames: ["BP_ARK_API_KEY", "BP_SEEDANCE_API_KEY"],
      baseEnvNames: ["SEEDANCE_API_BASE"],
      defaultBase: "https://standard.example/api/v3"
    });
    assert.equal(fallbackCredential.source, "agent-plan");
    assert.equal(fallbackCredential.apiKey, "browser-plan-key");

    await clearRequestAgentPlanKey();
  });

  await withUserRequest(async () => {
    await setRequestApiKey("browser-cn-standard-key", "volcengine-cn");

    const status = requestApiKeyStatus();
    assert.equal(status.configured, true);
    assert.equal(status.route, "volcengine-cn");

    const cnCredential = resolveSeedanceCredential();
    assert.equal(cnCredential.source, "standard");
    assert.equal(cnCredential.standardRoute, "volcengine-cn");
    assert.equal(cnCredential.apiKey, "browser-cn-standard-key");
    assert.equal(cnCredential.apiBase, "https://ark.cn-beijing.volces.com/api/v3");
    assert.equal(resolveSeedanceModel({ seedanceVariant: "standard" }), "doubao-seedance-2-0");

    await clearRequestApiKey();
  });

  process.env.ARK_AGENT_PLAN_KEY = "env-agent-plan-key";
  process.env.SEEREEL_DISABLE_ADMIN_AGENT_PLAN = "1";
  process.env.CN_ARK_API_KEY = "env-cn-key";
  process.env.CN_SEEDREAM_API_KEY = "test-cn-seedream-key";
  process.env.CN_SEEDANCE_API_KEY = "test-cn-seedance-key";
  process.env.BP_ARK_API_KEY = "env-bp-key";
  process.env.BP_SEEDREAM_API_KEY = "test-bp-seedream-key";
  process.env.BP_SEEDANCE_API_KEY = "test-bp-seedance-key";
  process.env.BP_SEEDREAM_API_BASE = "https://bp-seedream.example/api/v3";
  process.env.BP_SEEDANCE_API_BASE = "https://bp.example/api/v3";
  process.env.CN_SEEDREAM_API_BASE = "https://cn-seedream.example/api/v3";
  process.env.CN_SEEDANCE_API_BASE = "https://cn.example/api/v3";

  const allEnvSeedreamCredential = resolveSeedreamCredential();
  assert.equal(allEnvSeedreamCredential.source, "standard");
  assert.equal(allEnvSeedreamCredential.standardRoute, "byteplus");
  assert.equal(allEnvSeedreamCredential.apiKey, "env-bp-key");
  assert.equal(allEnvSeedreamCredential.apiBase, "https://bp-seedream.example/api/v3");

  const allEnvCredential = resolveSeedanceCredential();
  assert.equal(allEnvCredential.source, "standard");
  assert.equal(allEnvCredential.standardRoute, "byteplus");
  assert.equal(allEnvCredential.apiKey, "env-bp-key");
  assert.equal(allEnvCredential.apiBase, "https://bp.example/api/v3");

  delete process.env.BP_ARK_API_KEY;
  const bpSeedreamEnvCredential = resolveSeedreamCredential();
  assert.equal(bpSeedreamEnvCredential.source, "standard");
  assert.equal(bpSeedreamEnvCredential.standardRoute, "byteplus");
  assert.equal(bpSeedreamEnvCredential.apiKey, "test-bp-seedream-key");
  assert.equal(bpSeedreamEnvCredential.apiBase, "https://bp-seedream.example/api/v3");

  const bpSeedanceEnvCredential = resolveSeedanceCredential();
  assert.equal(bpSeedanceEnvCredential.source, "standard");
  assert.equal(bpSeedanceEnvCredential.standardRoute, "byteplus");
  assert.equal(bpSeedanceEnvCredential.apiKey, "test-bp-seedance-key");
  assert.equal(bpSeedanceEnvCredential.apiBase, "https://bp.example/api/v3");

  delete process.env.BP_SEEDREAM_API_KEY;
  delete process.env.BP_SEEDANCE_API_KEY;
  const cnSeedreamEnvCredential = resolveSeedreamCredential();
  assert.equal(cnSeedreamEnvCredential.source, "standard");
  assert.equal(cnSeedreamEnvCredential.standardRoute, "volcengine-cn");
  assert.equal(cnSeedreamEnvCredential.apiKey, "env-cn-key");
  assert.equal(cnSeedreamEnvCredential.apiBase, "https://cn-seedream.example/api/v3");

  const cnEnvCredential = resolveSeedanceCredential();
  assert.equal(cnEnvCredential.source, "standard");
  assert.equal(cnEnvCredential.standardRoute, "volcengine-cn");
  assert.equal(cnEnvCredential.apiKey, "env-cn-key");
  assert.equal(cnEnvCredential.apiBase, "https://cn.example/api/v3");
  assert.equal(resolveSeedanceModel({ seedanceVariant: "standard" }), "doubao-seedance-2-0");

  delete process.env.CN_ARK_API_KEY;
  const cnSeedreamOnlyEnvCredential = resolveSeedreamCredential();
  assert.equal(cnSeedreamOnlyEnvCredential.source, "standard");
  assert.equal(cnSeedreamOnlyEnvCredential.standardRoute, "volcengine-cn");
  assert.equal(cnSeedreamOnlyEnvCredential.apiKey, "test-cn-seedream-key");
  assert.equal(cnSeedreamOnlyEnvCredential.apiBase, "https://cn-seedream.example/api/v3");

  const cnSeedanceEnvCredential = resolveSeedanceCredential();
  assert.equal(cnSeedanceEnvCredential.source, "standard");
  assert.equal(cnSeedanceEnvCredential.standardRoute, "volcengine-cn");
  assert.equal(cnSeedanceEnvCredential.apiKey, "test-cn-seedance-key");
  assert.equal(cnSeedanceEnvCredential.apiBase, "https://cn.example/api/v3");

  delete process.env.CN_SEEDREAM_API_KEY;
  delete process.env.CN_SEEDANCE_API_KEY;
  const planSeedreamCredential = resolveSeedreamCredential();
  assert.equal(planSeedreamCredential.source, "agent-plan");
  assert.equal(planSeedreamCredential.apiKey, "env-agent-plan-key");
  assert.equal(planSeedreamCredential.apiBase, ARK_AGENT_PLAN_BASE);

  const planEnvCredential = resolveSeedanceCredential();
  assert.equal(planEnvCredential.source, "agent-plan");
  assert.equal(planEnvCredential.apiKey, "env-agent-plan-key");
  assert.equal(planEnvCredential.apiBase, ARK_AGENT_PLAN_BASE);
  assert.equal(resolveSeedanceModel({ seedanceVariant: "standard" }), "doubao-seedance-2-0-260128");

  assert.equal(resolveReviewModel("agent-plan"), "doubao-seed-2.0-pro");
  process.env.VISION_REVIEW_AGENT_PLAN_MODEL = "compatible-plan-vlm";
  assert.equal(resolveReviewModel("agent-plan"), "compatible-plan-vlm");
  assert.equal(resolveReviewModel("standard"), "seed-2-0-pro-260328");
} finally {
  restoreEnv();
}
