import { describe, expect, test } from "bun:test";
import {
  assertTurnExecutionPolicyMatchesConfigV1,
  configuredModels,
  getSettings,
  resolveTurnExecutionPolicyV1,
  type ModelCapabilitiesV1,
} from "@opengeni/config";
import { resolveTurnModel } from "@opengeni/runtime";
import { hostedWebSearchForTurn, resolveAcceptedTurnModel } from "../src/activities/agent-turn";

const base = getSettings({ OPENGENI_ENV: "test" });
const capabilities = (webSearch: ModelCapabilitiesV1["hostedTools"]["webSearch"]) => {
  const current = configuredModels(base)[0]!.capabilities;
  return { ...current, hostedTools: { ...current.hostedTools, webSearch } };
};

function settingsWith(webSearch: ModelCapabilitiesV1["hostedTools"]["webSearch"]) {
  return {
    ...base,
    modelProvidersJson: JSON.stringify([
      {
        id: "acme",
        api: "responses",
        wireProfile: "azure-openai",
        baseUrl: "https://acme.example/openai/v1",
        apiKey: "fake-test-key",
        models: [
          {
            id: "acme/model",
            upstreamModelId: "upstream-model",
            capabilities: capabilities(webSearch),
            hostedWebSearch: webSearch.runnable,
          },
        ],
      },
    ]),
  };
}

const input = {
  modelId: "acme/model",
  requestedModelId: null,
  modelSource: "continuation",
  reasoningEffort: "medium",
  reasoningSource: "continuation",
  latencyMode: "standard",
  latencyModeSource: "continuation",
} as const;

describe("accepted turn hosted web search after catalog enablement", () => {
  const before = settingsWith({ upstream: "unknown", runnable: false });
  const after = settingsWith({ upstream: "supported", runnable: true });
  const runtime = { resolveTurnModel };

  test("a turn frozen before enablement keeps its frozen tool set on recovery", () => {
    const accepted = resolveTurnExecutionPolicyV1(before, input);
    // The claim-time check passes on a post-enablement worker...
    expect(() => assertTurnExecutionPolicyMatchesConfigV1(after, accepted, input)).not.toThrow();
    // ...and the attempt still runs without the newly enabled tool.
    const resolved = resolveAcceptedTurnModel(runtime, after, accepted);
    expect(resolved?.provider.id).toBe("acme");
    expect(resolved?.configured.definitionVersion).toBe(accepted.definitionVersion);
    expect(hostedWebSearchForTurn(resolved, true)).toBe(false);
  });

  test("the next accepted turn gets hosted web search", () => {
    const accepted = resolveTurnExecutionPolicyV1(after, input);
    const resolved = resolveAcceptedTurnModel(runtime, after, accepted);
    expect(resolved?.configured).toEqual(resolveTurnModel(after, input.modelId)!.configured);
    expect(hostedWebSearchForTurn(resolved, false)).toBe(true);
  });

  test("an unresolved model keeps the legacy deployment gate", () => {
    const accepted = resolveTurnExecutionPolicyV1(before, input);
    expect(resolveAcceptedTurnModel({ resolveTurnModel: () => null }, after, accepted)).toBeNull();
  });
});
