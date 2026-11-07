import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as core from "@opengeni/core";
import * as db from "@opengeni/db";
import type { AccessGrant } from "@opengeni/contracts";
import { testSettings } from "@opengeni/testing/settings";
import { createAuxiliaryModelCallService } from "../src/model-calls/auxiliary";
import * as rls from "../src/access-grant-rls";

const restores: Array<() => void> = [];
afterEach(() => {
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
    documentEmbeddingProvider: "openai",
    documentEmbeddingApiKey: "test-key",
    documentEmbeddingBaseUrl: "https://models.example.test/v1",
    documentEmbeddingModel: "embedding-test",
    documentEmbeddingDimensions: 2,
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
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(init?.body as string);
    calls.push({ url: String(url), body });
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
  const service = createAuxiliaryModelCallService({
    db: {} as never,
    settings: effective,
    fetch: fetcher,
  });
  return { service, calls, admit, settle };
}

describe("public auxiliary inference through the existing providers and meter", () => {
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
    expect(h.calls[0]).toMatchObject({
      url: "https://models.example.test/v1/decisions",
      body: { model: "decision-test" },
    });
    expect(h.admit.mock.calls[0]![1]).toMatchObject({
      model: "openai/decision-test",
      billingOrigin: "api",
      countsTowardTokenCap: true,
      byok: false,
    });
    expect(h.settle.mock.calls[0]![2]).toMatchObject({
      sourceId: "model_call:server-request",
      normalizedUsage: { telemetry: { inputTokens: 12, outputTokens: 3 } },
      externalProviderCost: { costUsd: 0.004, source: "provider-reported" },
      processingResidency: { geography: "unknown" },
    });
  });
  test("malformed typed answers are refused but received usage is settled", async () => {
    const h = harness({
      respond: () =>
        Response.json({ answers: [], usage: { input_tokens: 4, output_tokens: 2, cost: 0.001 } }),
    });
    await expect(
      h.service.decide({ ...caller, request: { input: "x", questions } }),
    ).rejects.toMatchObject({ status: 502, code: "provider_error" });
    expect(h.settle).toHaveBeenCalledTimes(1);
  });
  test("an unconfigured decision model never borrows chat credentials", async () => {
    const h = harness({ settings: testSettings({ openaiApiKey: "chat-only" }) });
    await expect(
      h.service.decide({ ...caller, request: { input: "x", questions } }),
    ).rejects.toMatchObject({ status: 503 });
    expect(h.calls).toHaveLength(0);
  });
  test("workspace EU restrictions refuse both routes before network dispatch", async () => {
    const h = harness();
    spy(db, "isWorkspaceEuOnly", async () => true);
    await expect(
      h.service.decide({ ...caller, request: { input: "x", questions } }),
    ).rejects.toMatchObject({ code: "region_restricted" });
    await expect(h.service.embed({ ...caller, request: { input: "x" } })).rejects.toMatchObject({
      code: "region_restricted",
    });
    expect(h.calls).toHaveLength(0);
  });
  test("a failed workspace residency read never reaches a provider", async () => {
    const h = harness();
    spy(db, "isWorkspaceEuOnly", async () => {
      throw new Error("db down");
    });
    await expect(h.service.embed({ ...caller, request: { input: "x" } })).rejects.toThrow(
      "db down",
    );
    expect(h.calls).toHaveLength(0);
  });
  test("declared EU decision endpoint runs and keeps its residency receipt", async () => {
    const h = harness({
      settings: {
        ...settings(),
        requiredModelGeography: "eu",
        sideFeatureResidencyJson: JSON.stringify({
          "decision_model.openai": {
            endpoint: "https://models.example.test/v1",
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
    expect(h.settle.mock.calls[0]![2]).toMatchObject({ processingResidency: { geography: "eu" } });
  });
  test("embeddings reuse batching, preserve input order and report configured dimensions", async () => {
    const h = harness({
      respond: (_url, body) =>
        Response.json({
          model: "embedding-test",
          data: (body.input as string[])
            .map((_, index) => ({ index, embedding: [index, 1] }))
            .reverse(),
          usage: {
            prompt_tokens: (body.input as string[]).length,
            total_tokens: (body.input as string[]).length,
          },
        }),
    });
    const result = await h.service.embed({
      ...caller,
      request: { input: Array.from({ length: 65 }, (_, i) => String(i)) },
    });
    expect(result.dimensions).toBe(2);
    expect(result.data).toHaveLength(65);
    expect(result.data[0]).toEqual({ object: "embedding", index: 0, embedding: [0, 1] });
    expect(result.usage).toEqual({
      inputTokens: 65,
      totalTokens: 65,
      requests: 2,
      costUsd: null,
      costSource: "unknown",
    });
    expect(h.calls).toHaveLength(2);
    expect(h.calls[0]!.body).toMatchObject({ model: "embedding-test", dimensions: 2 });
    expect(h.settle.mock.calls[0]![2]).toMatchObject({ normalizedUsage: { totalTokens: 65 } });
  });
  test.each(["missing", "duplicate", "dimension", "nonfinite"])(
    "invalid embedding %s is refused after settling received usage",
    async (kind) => {
      const data =
        kind === "missing"
          ? []
          : kind === "duplicate"
            ? [
                { index: 0, embedding: [0, 1] },
                { index: 0, embedding: [0, 1] },
              ]
            : [{ index: 0, embedding: kind === "dimension" ? [0] : [null, 1] }];
      const h = harness({
        respond: () =>
          Response.json({
            model: "embedding-test",
            data,
            usage: { prompt_tokens: 5, total_tokens: 5 },
          }),
      });
      await expect(h.service.embed({ ...caller, request: { input: "x" } })).rejects.toMatchObject({
        code: "provider_error",
      });
      expect(h.settle).toHaveBeenCalledTimes(1);
    },
  );
  test("later failed batch retains the first batch's usage", async () => {
    let batch = 0;
    const h = harness({
      respond: (_url, body) =>
        ++batch === 1
          ? Response.json({
              model: "embedding-test",
              data: (body.input as string[]).map((_, index) => ({ index, embedding: [0, 1] })),
              usage: { prompt_tokens: 64, total_tokens: 64 },
            })
          : new Response("rejected", { status: 400 }),
    });
    await expect(
      h.service.embed({ ...caller, request: { input: Array(65).fill("x") } }),
    ).rejects.toMatchObject({ status: 400 });
    expect(h.settle.mock.calls[0]![2]).toMatchObject({ normalizedUsage: { totalTokens: 64 } });
  });
  test("unknown usage is not invented; pre-aborted requests send nothing", async () => {
    const h = harness({ respond: () => Response.json({ answers }) });
    const result = await h.service.decide({ ...caller, request: { input: "x", questions } });
    expect(result.usage).toMatchObject({ inputTokens: null, outputTokens: null, costUsd: null });
    const signal = AbortSignal.abort();
    await expect(
      h.service.decide({ ...caller, signal, request: { input: "x", questions } }),
    ).rejects.toMatchObject({ name: "AbortError" });
    await expect(
      h.service.embed({ ...caller, signal, request: { input: "x" } }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(h.calls).toHaveLength(1);
  });
  test("allowance rejection prevents either provider call", async () => {
    const h = harness();
    h.admit.mockImplementation(async () => ({
      allowed: false,
      denial: "allowance_exhausted",
      message: "Limit reached",
    }));
    await expect(
      h.service.decide({ ...caller, request: { input: "x", questions } }),
    ).rejects.toMatchObject({ status: 429 });
    await expect(h.service.embed({ ...caller, request: { input: "x" } })).rejects.toMatchObject({
      status: 429,
    });
    expect(h.calls).toHaveLength(0);
  });
});
