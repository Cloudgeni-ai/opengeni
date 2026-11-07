import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as core from "@opengeni/core";
import * as db from "@opengeni/db";
import type { AccessGrant } from "@opengeni/contracts";
import { testSettings } from "@opengeni/testing/settings";
import { configuredDecisionModel } from "@opengeni/runtime/model-call";
import { createDecisionCallService } from "../src/model-calls/decisions";
import * as rls from "../src/access-grant-rls";

const services: Array<{ flushUsage(): Promise<void> }> = [];
const restores: Array<() => void> = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.flushUsage();
  while (restores.length) restores.pop()!();
});
function spy<T extends object, K extends keyof T>(target: T, key: K, impl: unknown) {
  const mock = spyOn(target, key as never).mockImplementation(impl as never);
  restores.push(() => mock.mockRestore());
  return mock;
}
const settings = () =>
  testSettings({
    decisionModelProvider: "openai",
    decisionModelId: "decision-test",
    decisionModelApiKey: "test-key",
    decisionModelBaseUrl: "https://models.example.test/v1",
  });
const questions = {
  allowed: { type: "predicate" as const, instructions: "Is it allowed?" },
  category: { type: "choice" as const, instructions: "Pick", criteria: { a: "A", b: "B" } },
  quality: { type: "score" as const, instructions: "Score", criteria: ["bad", "good"] },
  private: { type: "predicate" as const, instructions: "Refuse" },
};
const answers = [
  { name: "allowed", type: "predicate", probability: 0.9 },
  { name: "category", type: "choice", choice: "b" },
  { name: "quality", type: "score", score: 1 },
  { name: "private", type: "refusal", reason: "Not enough information" },
];
const grant: AccessGrant = {
  accountId: "acct",
  workspaceId: "ws",
  subjectId: "caller",
  principalKind: "api_key",
  permissions: ["sessions:create"],
};
const caller = {
  grant,
  accountId: grant.accountId,
  workspaceId: grant.workspaceId,
  subjectId: grant.subjectId,
  requestId: "server-request",
};
function harness(
  options: {
    settings?: ReturnType<typeof settings>;
    respond?: (url: string, body: Record<string, unknown>) => Response;
  } = {},
) {
  const effective = options.settings ?? settings();
  const calls: Array<{ url: string; body: Record<string, unknown>; authorization: string | null }> =
    [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(init?.body as string);
    calls.push({
      url: String(url),
      body,
      authorization: new Headers(init?.headers).get("authorization"),
    });
    if (options.respond) return options.respond(String(url), body);
    return Response.json({
      model: "returned-model",
      answers,
      usage: { input_tokens: 12, output_tokens: 3, cost: 0.004 },
    });
  }) as typeof fetch;
  spy(
    rls,
    "withAccessGrantSessionRlsContext",
    async (_d: unknown, _g: unknown, fn: () => unknown) => fn(),
  );
  spy(rls, "billingOriginForAccessGrant", async () => "api");
  spy(db, "isWorkspaceEuOnly", async () => effective.requiredModelGeography === "eu");
  const admit = spy(core, "admitModelCall", async () => ({ allowed: true }));
  const settle = spy(core, "settleModelUsage", async () => ({}));
  const service = createDecisionCallService({
    db: {} as never,
    settings: effective,
    fetch: fetcher,
  });
  services.push(service);
  return { service, calls, admit, settle };
}

describe("public platform-funded decisions", () => {
  test("typed predicate, choice, score and refusal use the deployment model and settle actual usage", async () => {
    const h = harness();
    const result = await h.service.decide({ ...caller, request: { input: "text", questions } });
    expect(result.answers).toEqual({
      allowed: { type: "predicate", probability: 0.9 },
      category: { type: "choice", choice: "b" },
      quality: { type: "score", score: 1 },
      private: { type: "refusal", reason: "Not enough information" },
    });
    expect(result.usage).toMatchObject({
      inputTokens: 12,
      outputTokens: 3,
      costUsd: 0.004,
      costSource: "provider-reported",
    });
    expect(result.model).toBe("openai/returned-model");
    expect(h.calls[0]).toMatchObject({
      url: "https://models.example.test/v1/decisions",
      body: { model: "decision-test" },
    });
    expect(h.admit).not.toHaveBeenCalled();
    await h.service.flushUsage();
    expect(h.settle.mock.calls[0]![2]).toMatchObject({
      sourceId: "model_call:server-request",
      model: "openai/returned-model",
      initiatorContext: { model: "openai/returned-model" },
      normalizedUsage: { telemetry: { inputTokens: 12, outputTokens: 3 } },
      externalProviderCost: { costUsd: 0.004, source: "provider-reported" },
      processingResidency: { geography: "unknown" },
    });
  });
  test("a separate public model leaves agent routing unchanged and records the answered model", async () => {
    const shared = {
      ...settings(),
      publicDecisionModelProvider: "openrouter" as const,
      publicDecisionModelId: "product-model",
      publicDecisionModelApiKey: "product-key",
    };
    const h = harness({
      settings: shared,
      respond: () =>
        Response.json({
          model: "returned-model",
          answers: Object.fromEntries(answers.map(({ name, ...answer }) => [name, answer])),
          usage: { input_tokens: 12, output_tokens: 3, cost: 0.004 },
        }),
    });
    const result = await h.service.decide({ ...caller, request: { input: "x", questions } });
    expect(h.calls[0]).toMatchObject({
      url: "https://openrouter.ai/api/alpha/decisions",
      body: { model: "product-model" },
      authorization: "Bearer product-key",
    });
    expect(configuredDecisionModel(shared)?.id).toBe("openai/decision-test");
    expect(result.model).toBe("openrouter/returned-model");
    await h.service.flushUsage();
    expect(h.settle.mock.calls[0]![2]).toMatchObject({ model: "openrouter/returned-model" });
  });
  test("an incomplete public override returns unavailable instead of calling the agent model", async () => {
    const h = harness({ settings: { ...settings(), publicDecisionModelId: "product-model" } });
    await expect(
      h.service.decide({ ...caller, request: { input: "x", questions } }),
    ).rejects.toMatchObject({ status: 503 });
    expect(h.calls).toHaveLength(0);
  });
  test("workspace residency checks apply to the public model rather than the agent route", async () => {
    const h = harness({
      settings: {
        ...settings(),
        publicDecisionModelProvider: "openrouter",
        publicDecisionModelId: "product-model",
        publicDecisionModelApiKey: "product-key",
        sideFeatureResidencyJson: JSON.stringify({
          "decision_model.openai": {
            endpoint: "https://models.example.test/v1",
            residency: {
              geography: "eu",
              deploymentType: "azure_data_zone",
              regions: ["swedencentral"],
              evidence: {
                source: "operator_declaration",
                reference: "test",
                verifiedAt: "2026-11-07",
              },
            },
          },
        }),
      },
    });
    spy(db, "isWorkspaceEuOnly", async () => true);
    await expect(
      h.service.decide({ ...caller, request: { input: "x", questions } }),
    ).rejects.toMatchObject({ code: "region_restricted" });
    expect(h.calls).toHaveLength(0);
  });
  test("malformed typed answers are refused but received usage is settled", async () => {
    const h = harness({
      respond: () =>
        Response.json({ answers: [], usage: { input_tokens: 4, output_tokens: 2, cost: 0.001 } }),
    });
    await expect(
      h.service.decide({ ...caller, request: { input: "x", questions } }),
    ).rejects.toMatchObject({ status: 502, code: "provider_error" });
    await h.service.flushUsage();
    expect(h.settle).toHaveBeenCalledTimes(1);
  });
  test("an unconfigured decision model never borrows chat credentials", async () => {
    const h = harness({ settings: testSettings({ openaiApiKey: "chat-only" }) });
    await expect(
      h.service.decide({ ...caller, request: { input: "x", questions } }),
    ).rejects.toMatchObject({ status: 503 });
    expect(h.calls).toHaveLength(0);
  });
  test("workspace EU restrictions refuse decisions before network dispatch", async () => {
    const h = harness();
    spy(db, "isWorkspaceEuOnly", async () => true);
    await expect(
      h.service.decide({ ...caller, request: { input: "x", questions } }),
    ).rejects.toMatchObject({ code: "region_restricted" });
    expect(h.calls).toHaveLength(0);
  });
  test("a failed workspace residency read never reaches a provider", async () => {
    const h = harness();
    spy(db, "isWorkspaceEuOnly", async () => {
      throw new Error("db down");
    });
    await expect(
      h.service.decide({ ...caller, request: { input: "x", questions } }),
    ).rejects.toThrow("db down");
    expect(h.calls).toHaveLength(0);
  });
  test("declared EU public decision endpoint runs and keeps its residency receipt", async () => {
    const h = harness({
      settings: {
        ...settings(),
        requiredModelGeography: "eu",
        publicDecisionModelProvider: "openai",
        publicDecisionModelId: "eu-product-model",
        publicDecisionModelApiKey: "eu-product-key",
        publicDecisionModelBaseUrl: "https://public.example.test/v1",
        sideFeatureResidencyJson: JSON.stringify({
          "decision_model.openai": {
            endpoint: "https://public.example.test/v1",
            residency: {
              geography: "eu",
              deploymentType: "azure_data_zone",
              regions: ["swedencentral"],
              evidence: {
                source: "operator_declaration",
                reference: "test deployment",
                verifiedAt: "2026-11-07",
              },
            },
          },
        }),
      },
    });
    await h.service.decide({ ...caller, request: { input: "x", questions } });
    expect(h.calls[0]).toMatchObject({
      url: "https://public.example.test/v1/decisions",
      body: { model: "eu-product-model" },
    });
    await h.service.flushUsage();
    expect(h.settle.mock.calls[0]![2]).toMatchObject({ processingResidency: { geography: "eu" } });
  });
  test("unknown usage is not invented; pre-aborted requests send nothing", async () => {
    const h = harness({ respond: () => Response.json({ answers }) });
    const result = await h.service.decide({ ...caller, request: { input: "x", questions } });
    expect(result.usage).toMatchObject({ inputTokens: null, outputTokens: null, costUsd: null });
    const signal = AbortSignal.abort();
    await expect(
      h.service.decide({ ...caller, signal, request: { input: "x", questions } }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(h.calls).toHaveLength(1);
  });
  test("tenant attribution cannot invoke allowance admission or change the payer", async () => {
    const h = harness();
    h.admit.mockImplementation(async () => {
      throw new Error("Customer allowance exhausted");
    });
    const result = await h.service.decide({
      ...caller,
      request: { input: "x", questions, tenantLabel: "customer" },
    });
    expect(result.tenantLabel).toBe("customer");
    expect(h.admit).not.toHaveBeenCalled();
    expect(h.settle).not.toHaveBeenCalled();
    await h.service.flushUsage();
    expect(h.settle.mock.calls[0]![2]).toMatchObject({
      accountId: "acct",
      workspaceId: "ws",
      chargesOpenGeniCredits: false,
      initiatorContext: { tenantLabel: "customer" },
    });
  });
  test("receipt failure retries only the write, without replaying inference", async () => {
    const h = harness();
    h.settle.mockImplementationOnce(async () => {
      throw new Error("DB unavailable");
    });
    const result = await h.service.decide({ ...caller, request: { input: "x", questions } });
    expect(result.object).toBe("decision");
    expect(h.settle).not.toHaveBeenCalled();
    await expect(h.service.flushUsage()).rejects.toThrow("remain pending");
    await h.service.flushUsage();
    expect(h.settle).toHaveBeenCalledTimes(2);
    expect(h.calls).toHaveLength(1);
  });
});
