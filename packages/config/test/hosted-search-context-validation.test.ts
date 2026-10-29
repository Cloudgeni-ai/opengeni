import { describe, expect, test } from "bun:test";
import { parseModelCatalogDocument, parseModelProvidersJson } from "../src";

const enabledCapabilities = {
  reasoning: {
    upstream: "supported",
    runnable: true,
    efforts: ["medium"],
    defaultEffort: "medium",
    required: false,
  },
  functionCalling: { upstream: "supported", runnable: true },
  structuredOutput: { upstream: "supported", runnable: true },
  hostedTools: {
    webSearch: { upstream: "supported", runnable: true },
    xSearch: { upstream: "unknown", runnable: false },
    codeExecution: { upstream: "unknown", runnable: false },
  },
  inputModalities: ["text"],
  outputModalities: ["text"],
  transports: {
    sse: { upstream: "supported", runnable: true },
    responsesWebSocket: { upstream: "unknown", runnable: false },
    realtimeAudio: { upstream: "unknown", runnable: false },
  },
  latencyModes: [{ id: "standard", upstream: "supported", runnable: true }],
};

const disabledCapabilities = {
  ...enabledCapabilities,
  hostedTools: {
    ...enabledCapabilities.hostedTools,
    webSearch: { upstream: "supported", runnable: false },
  },
};

const message =
  "hostedWebSearchContextSize requires a Responses route with hosted web search enabled";

for (const source of ["environment", "database"] as const) {
  const parse = (api: string | undefined, model: Record<string, unknown>) => {
    const provider = {
      id: "example",
      baseUrl: "https://api.example.test/v1",
      ...(api === undefined ? {} : { api }),
      models: [{ id: "example/model", ...model }],
    };
    return source === "environment"
      ? parseModelProvidersJson(JSON.stringify([{ ...provider, apiKey: "test-key" }]))
      : parseModelCatalogDocument({
          schemaVersion: 1,
          builtInModels: ["gpt-6-luna"],
          registryProviders: [provider],
        }).registryProviders;
  };

  describe(`${source} hosted-search context validation`, () => {
    for (const size of ["low", "medium", "high"] as const) {
      test(`accepts ${size} on Responses routes with legacy or normalized search enabled`, () => {
        for (const enabled of [
          { hostedWebSearch: true },
          { capabilities: enabledCapabilities },
          { hostedWebSearch: true, capabilities: enabledCapabilities },
        ]) {
          expect(
            parse("responses", { ...enabled, hostedWebSearchContextSize: size })[0]?.models[0]
              ?.hostedWebSearchContextSize,
          ).toBe(size);
        }
      });

      test(`rejects ${size} on non-Responses routes even when hosted search is enabled`, () => {
        for (const api of [undefined, "chat", "anthropic-messages"]) {
          for (const enabled of [
            { hostedWebSearch: true },
            { capabilities: enabledCapabilities },
          ]) {
            expect(() => parse(api, { ...enabled, hostedWebSearchContextSize: size })).toThrow(
              message,
            );
          }
        }
      });

      test(`rejects ${size} on Responses routes with hosted search off or unspecified`, () => {
        for (const disabled of [
          {},
          { hostedWebSearch: false },
          { capabilities: disabledCapabilities },
          { hostedWebSearch: false, capabilities: disabledCapabilities },
        ]) {
          expect(() =>
            parse("responses", { ...disabled, hostedWebSearchContextSize: size }),
          ).toThrow(message);
        }
      });
    }

    test("leaves routes without an explicit context setting unchanged", () => {
      for (const api of [undefined, "responses", "chat", "anthropic-messages"]) {
        for (const model of [
          {},
          { hostedWebSearch: false },
          { hostedWebSearch: true },
          { capabilities: enabledCapabilities },
          { capabilities: disabledCapabilities },
        ]) {
          expect(parse(api, model)[0]?.models[0]).not.toHaveProperty("hostedWebSearchContextSize");
        }
      }
    });
  });
}
