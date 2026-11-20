import { describe, expect, test } from "bun:test";
import type { ResolvedModelProvider } from "@opengeni/config";
import { OPENGENI_GATEWAY_MODELS } from "@opengeni/config";
import { codexRequestStorage, normalizedCodexRequestBody } from "@opengeni/codex";
import { xaiSubscriptionRequestStorage } from "@opengeni/xai-subscription";

import {
  azureModelRequestPolicy,
  modelRequestPolicyForProvider,
  storelessResponsesBody,
  systemPromptRoleForProvider,
} from "../src/model-provider-request-policy";
import {
  cacheableSystemPromptBody,
  withCacheableSystemPrompt,
} from "../src/responses-system-prompt";

const SYSTEM = "You are a careful agent.\n\n# Rules\n- Be brief.";
const developer = { type: "message", role: "developer", content: SYSTEM };

describe("system prompt as the leading developer input item", () => {
  test("moves instructions into the first input item and drops the field", () => {
    const user = { type: "message", role: "user", content: "hi" };
    const body = Object.freeze({
      model: "m",
      instructions: SYSTEM,
      input: Object.freeze([user]),
      tools: [],
    });
    const projected = cacheableSystemPromptBody("/responses", body)!;
    expect("instructions" in projected).toBe(false);
    expect(projected.input).toEqual([developer, user]);
    expect(projected.model).toBe("m");
    // The caller's body and history array are untouched.
    expect(body.instructions).toBe(SYSTEM);
    expect(body.input).toEqual([user]);
  });

  test("every request of a chat starts with byte-identical bytes", () => {
    const first = cacheableSystemPromptBody("/responses", {
      instructions: SYSTEM,
      input: [{ type: "message", role: "user", content: "one" }],
    })!;
    const second = cacheableSystemPromptBody("/responses?api-version=preview", {
      instructions: SYSTEM,
      input: [
        { type: "message", role: "user", content: "one" },
        { type: "message", role: "assistant", content: "ok" },
        { type: "message", role: "user", content: "two" },
      ],
    })!;
    const leading = (body: Record<string, unknown>) => JSON.stringify((body.input as unknown[])[0]);
    expect(leading(first)).toBe(leading(second));
    expect(JSON.stringify(first).slice(0, -20)).toBe(
      JSON.stringify(second).slice(0, JSON.stringify(first).length - 20),
    );
  });

  test("wraps string input as the user message after the system prompt", () => {
    expect(
      cacheableSystemPromptBody("/responses", { instructions: SYSTEM, input: "hello" })!.input,
    ).toEqual([developer, { type: "message", role: "user", content: "hello" }]);
  });

  test("leaves requests without a system prompt, other endpoints and stored state alone", () => {
    expect(cacheableSystemPromptBody("/responses", { input: [] })).toBeNull();
    expect(cacheableSystemPromptBody("/responses", { instructions: "  ", input: [] })).toBeNull();
    expect(cacheableSystemPromptBody("/chat/completions", { instructions: SYSTEM })).toBeNull();
    expect(cacheableSystemPromptBody("/responses/resp_1", { instructions: SYSTEM })).toBeNull();
    expect(
      cacheableSystemPromptBody("/responses", {
        instructions: SYSTEM,
        input: [],
        previous_response_id: "resp_1",
      }),
    ).toBeNull();
    expect(
      cacheableSystemPromptBody("/responses", {
        instructions: SYSTEM,
        input: [],
        conversation: "conv_1",
      }),
    ).toBeNull();
    expect(cacheableSystemPromptBody("/responses", { instructions: SYSTEM })).toBeNull();
  });

  test("composes after another policy's projection", () => {
    const policy = withCacheableSystemPrompt(({ body }) => ({
      body: { ...body, store: false },
      headers: { "x-test": "1" },
    }));
    expect(policy({ path: "/responses", body: { instructions: SYSTEM, input: [] } })).toEqual({
      body: { store: false, input: [developer] },
      headers: { "x-test": "1" },
    });
    expect(withCacheableSystemPrompt(() => undefined)({ path: "/responses", body: {} })).toBe(
      undefined,
    );
  });

  test("applies on Azure, the OpenAI platform and compatible Responses servers", () => {
    const body = { model: "m", instructions: SYSTEM, input: [] };
    expect(azureModelRequestPolicy({ path: "/responses", body })!.body).toEqual({
      model: "m",
      store: false,
      input: [developer],
    });
    const platform: ResolvedModelProvider = {
      id: "openai-workspace",
      label: "OpenAI",
      kind: "direct-openai-workspace",
      api: "responses",
      wireProfile: "openai",
      builtin: false,
    };
    expect(modelRequestPolicyForProvider(platform)({ path: "/responses", body })!.body).toEqual({
      model: "m",
      store: false,
      input: [developer],
    });
    // A caller-chosen `store` still gets the cacheable prompt.
    expect(
      modelRequestPolicyForProvider(platform)({
        path: "/responses",
        body: { ...body, store: true },
      })!.body,
    ).toEqual({ model: "m", store: true, input: [developer] });
    const compatible = {
      id: "fixture",
      label: "Fixture",
      kind: "api-key",
      api: "responses",
      builtin: false,
      wireProfile: "openai",
      baseUrl: "https://llm.example.test/v1",
    } as const;
    // A compatible server keeps its own `store` contract.
    expect(modelRequestPolicyForProvider(compatible)({ path: "/responses", body })!.body).toEqual({
      model: "m",
      input: [{ ...developer, role: "system" }],
    });
  });
});

describe("the system prompt leads the cached prefix on every Responses route", () => {
  const body = Object.freeze({
    model: "m",
    instructions: SYSTEM,
    input: Object.freeze([{ type: "message", role: "user", content: "hi" }]),
    tools: [],
  });
  const provider = (fields: Partial<ResolvedModelProvider>): ResolvedModelProvider => ({
    id: "fixture",
    label: "Fixture",
    kind: "api-key",
    api: "responses",
    builtin: false,
    wireProfile: "openai",
    ...fields,
  });
  const leading = (projected: Record<string, unknown> | undefined) =>
    (projected?.input as Record<string, unknown>[] | undefined)?.[0];

  test("OpenAI-run routes keep the exact bytes they sent before", () => {
    // Codex: the leading developer item, then the Codex normalization.
    const context = {
      clientVersion: "test",
      getToken: async () => ({ accessToken: "fixture", chatgptAccountId: null, isFedramp: false }),
      refresh: async () => ({ accessToken: "fixture", chatgptAccountId: null, isFedramp: false }),
      resolveModel: (model: string) => model,
      nextRequestId: () => "request-1",
    };
    const codex = codexRequestStorage.run(context, () =>
      modelRequestPolicyForProvider(
        provider({ id: "codex", kind: "codex-subscription", baseUrl: "https://codex.test" }),
      )({ path: "/responses", body }),
    );
    expect(JSON.stringify(codex!.body)).toBe(
      JSON.stringify(
        normalizedCodexRequestBody(cacheableSystemPromptBody("/responses", body)!, (m) => m),
      ),
    );
    // OpenAI platform: storeless, then the leading developer item.
    const platform = modelRequestPolicyForProvider(
      provider({ id: "openai-workspace", kind: "direct-openai-workspace" }),
    )({ path: "/responses", body });
    expect(JSON.stringify(platform!.body)).toBe(
      JSON.stringify(
        cacheableSystemPromptBody("/responses", storelessResponsesBody("/responses", body)!),
      ),
    );
    // Azure: the Azure projection, storeless, then the leading developer item.
    const azure = modelRequestPolicyForProvider(
      provider({ id: "azure", kind: "direct-azure-workspace", wireProfile: "azure-openai" }),
    )({ path: "/responses", body });
    expect(JSON.stringify(azure!.body)).toBe(
      JSON.stringify(azureModelRequestPolicy({ path: "/responses", body })!.body),
    );
  });

  test("OpenAI-run backends get a developer item, every other route a system item", () => {
    expect(systemPromptRoleForProvider(provider({ kind: "codex-subscription" }))).toBe("developer");
    expect(systemPromptRoleForProvider(provider({ wireProfile: "azure-openai" }))).toBe(
      "developer",
    );
    expect(systemPromptRoleForProvider(provider({ kind: "direct-openai-organization" }))).toBe(
      "developer",
    );
    // An operator's provider on the OpenAI platform, named or by the SDK default.
    expect(systemPromptRoleForProvider(provider({ baseUrl: "https://api.openai.com/v1" }))).toBe(
      "developer",
    );
    expect(systemPromptRoleForProvider(provider({}))).toBe("developer");
    expect(
      systemPromptRoleForProvider(
        provider({ kind: "xai-subscription", baseUrl: "https://grok-proxy.test/v1" }),
      ),
    ).toBe("system");
    expect(
      systemPromptRoleForProvider(
        provider({ kind: "vercel-gateway-managed", baseUrl: "https://gateway.test/v1" }),
      ),
    ).toBe("system");
    expect(
      systemPromptRoleForProvider(
        provider({ kind: "direct-compatible-workspace", baseUrl: "https://llm.example.test/v1" }),
      ),
    ).toBe("system");
  });

  test("SuperGrok subscription requests lead with the system prompt", () => {
    const token = { accessToken: "fixture", userId: "fixture-user" };
    const result = xaiSubscriptionRequestStorage.run(
      {
        clientVersion: "test",
        sessionId: "fixture-session",
        turnId: "fixture-turn",
        getToken: async () => token,
        refresh: async () => token,
        resolveModel: (slug) => slug,
      },
      () =>
        modelRequestPolicyForProvider(
          provider({ kind: "xai-subscription", baseUrl: "https://grok-proxy.test/v1" }),
        )({ path: "/responses", body }),
    );
    expect("instructions" in result!.body!).toBe(false);
    expect(leading(result!.body)).toEqual({ type: "message", role: "system", content: SYSTEM });
    expect(result!.body!.store).toBe(false);
  });

  test("Gateway requests lead with the system prompt and keep their routing", () => {
    const result = modelRequestPolicyForProvider(
      provider({ kind: "vercel-gateway-managed", baseUrl: "https://gateway.test/v1" }),
    )({
      path: "/responses",
      body: { ...body, model: OPENGENI_GATEWAY_MODELS.kimi.upstreamModelId },
    });
    expect("instructions" in result!.body!).toBe(false);
    expect(leading(result!.body)).toEqual({ type: "message", role: "system", content: SYSTEM });
    expect(result!.body!.providerOptions).toBeDefined();
  });

  test("Chat Completions keeps its leading system message untouched", () => {
    const messages = [
      { role: "system", content: SYSTEM },
      { role: "user", content: "hi" },
    ];
    const chat = modelRequestPolicyForProvider(
      provider({ api: "chat", baseUrl: "https://llm.example.test/v1" }),
    )({ path: "/chat/completions", body: { model: "m", messages } });
    expect(chat).toBeUndefined();
  });
});
