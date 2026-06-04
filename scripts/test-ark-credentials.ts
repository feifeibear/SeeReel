import assert from "node:assert/strict";
import type { NextFunction, Request, Response } from "express";
import { ARK_AGENT_PLAN_BASE, resolveArkCredential } from "../src/server/arkCredentials";
import { clearRequestAgentPlanKey, setRequestAgentPlanKey, userCredentialMiddleware } from "../src/server/userCredentials";
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
  "REELYAI_VISION_REVIEW_USE_AGENT_PLAN"
];

const savedEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

function restoreEnv() {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function withUserRequest(fn: () => void) {
  const req = {
    headers: {
      cookie: "reelyai_user_id=testuser1234567890"
    }
  } as Request;
  const res = {
    cookie() {
      return this;
    }
  } as unknown as Response;
  userCredentialMiddleware(req, res, fn as NextFunction);
}

try {
  for (const key of ENV_KEYS) delete process.env[key];

  withUserRequest(() => {
    setRequestAgentPlanKey("browser-plan-key");

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

    clearRequestAgentPlanKey();
  });

  assert.equal(resolveReviewModel("agent-plan"), "doubao-seed-2.0-pro");
  process.env.VISION_REVIEW_AGENT_PLAN_MODEL = "compatible-plan-vlm";
  assert.equal(resolveReviewModel("agent-plan"), "compatible-plan-vlm");
  assert.equal(resolveReviewModel("standard"), "seed-2-0-pro-260328");
} finally {
  restoreEnv();
}
