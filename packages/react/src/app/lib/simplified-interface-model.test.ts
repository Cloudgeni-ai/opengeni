import { describe, expect, test } from "bun:test";

import {
  SIMPLIFIED_INTERFACE_REASONING_EFFORT,
  simplifiedInterfaceModelPolicy,
} from "./simplified-interface-model";

type Catalog = Parameters<typeof simplifiedInterfaceModelPolicy>[0];
type Model = Catalog["models"][number];

function model(id: string, extra: Partial<Model> = {}): Model {
  return {
    id,
    label: id,
    provider: "opengeni",
    providerLabel: "Opengeni",
    api: "responses",
    source: "opengeni",
    ...extra,
  } as Model;
}

const efforts = (list: string[], defaultEffort: string) =>
  ({ capabilities: { reasoning: { efforts: list, defaultEffort } } }) as unknown as Partial<Model>;

describe("the simplified interface's one model policy", () => {
  test("names GPT-6.1 Sol at medium under the id this deployment gives it", () => {
    const policy = simplifiedInterfaceModelPolicy({
      defaultModel: "azure-sol/gpt-6.1-sol",
      defaultReasoningEffort: "xhigh",
      models: [
        model("gpt-6-luna", efforts(["low", "medium", "high"], "xhigh")),
        model("azure-sol/gpt-6.1-sol", efforts(["low", "medium", "high", "xhigh"], "medium")),
        model("anthropic/claude-opus-5-5"),
      ],
    });
    expect(policy).toEqual({ model: "azure-sol/gpt-6.1-sol", reasoningEffort: "medium" });
    expect(SIMPLIFIED_INTERFACE_REASONING_EFFORT).toBe("medium");
  });

  test("wins over a different deployment default", () => {
    const policy = simplifiedInterfaceModelPolicy({
      defaultModel: "gpt-6-luna",
      defaultReasoningEffort: "low",
      models: [model("gpt-6-luna"), model("gpt-6.1-sol")],
    });
    expect(policy).toEqual({ model: "gpt-6.1-sol", reasoningEffort: "medium" });
  });

  test("never picks someone's own subscription or provider account", () => {
    const policy = simplifiedInterfaceModelPolicy({
      defaultModel: "gpt-6-sol",
      defaultReasoningEffort: "low",
      models: [
        model("codex/gpt-6.1-sol", { source: "codex" }),
        model("gateway/gpt-6.1-sol", { source: "workspace_gateway" }),
        model("gpt-6-sol"),
      ],
    });
    expect(policy.model).toBe("gpt-6-sol");
  });

  test("a deployment without it uses its default model, still at medium", () => {
    const policy = simplifiedInterfaceModelPolicy({
      defaultModel: "gpt-6-sol",
      defaultReasoningEffort: "low",
      models: [model("gpt-6-sol", efforts(["low", "medium", "high"], "low")), model("gpt-6-luna")],
    });
    expect(policy).toEqual({ model: "gpt-6-sol", reasoningEffort: "medium" });
  });

  test("a model that cannot run medium keeps its own default level", () => {
    const policy = simplifiedInterfaceModelPolicy({
      defaultModel: "glm-5.3-flash",
      defaultReasoningEffort: "low",
      models: [model("glm-5.3-flash", efforts(["low", "high", "max"], "max"))],
    });
    expect(policy).toEqual({ model: "glm-5.3-flash", reasoningEffort: "max" });
  });
});
