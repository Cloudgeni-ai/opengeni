import { describe, expect, test } from "bun:test";
import type { ResolvedModelProvider } from "@opengeni/config";

import {
  azureModelRequestPolicy,
  modelRequestPolicyForProvider,
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

  test("applies on Azure and OpenAI platform Responses, not on other providers", () => {
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
    } as const;
    expect(modelRequestPolicyForProvider(compatible)({ path: "/responses", body })).toBeUndefined();
  });
});
