import { describe, expect, test } from "bun:test";
import { euModelRoutes, type Settings } from "@opengeni/config";
import { testSettings } from "@opengeni/testing/settings";
import {
  InferenceRegionRestrictedError,
  MultiProviderModelProvider,
  inferenceResidencyRequirement,
  resolveInferenceResidency,
  resolveTurnModel,
  withInferenceResidency,
} from "../src";
import { instrumentedModelFetch } from "../src/model-provider-client";

const euDataZone = {
  geography: "eu",
  deploymentType: "azure_data_zone",
  regions: ["swedencentral"],
  evidence: {
    source: "operator_declaration",
    reference: "Azure deployment gpt-eu, sku DataZoneStandard",
    verifiedAt: "2026-10-26",
  },
} as const;

function settings(overrides: Partial<Settings> = {}): Settings {
  return testSettings({
    modelProvidersJson: JSON.stringify([
      {
        id: "azure-eu",
        api: "responses",
        wireProfile: "azure-openai",
        baseUrl: "https://res.openai.azure.com/openai/v1",
        apiKey: "key",
        models: [
          { id: "azure-eu/gpt-eu", upstreamModelId: "gpt-eu", residency: euDataZone },
          // Named EU, but nothing declares where it runs: unknown, so not EU.
          { id: "azure-eu/gpt-global-eu", upstreamModelId: "gpt-global-eu" },
        ],
      },
    ]),
    ...overrides,
  });
}

const eu = () => settings({ requiredModelGeography: "eu" });
const URL_RESPONSES = "https://res.openai.azure.com/openai/v1/responses";

function recordingFetch() {
  const sent: string[] = [];
  const inner = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    sent.push(typeof init?.body === "string" ? init.body : "<stream>");
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { sent, inner };
}

function post(model: string): RequestInit {
  return { method: "POST", body: JSON.stringify({ model, input: "hi" }) };
}

describe("EU-only inference enforcement", () => {
  test("EU routes come from residency records, never from names", () => {
    const routes = euModelRoutes(eu());
    expect([...(routes.get("azure-eu") ?? [])]).toEqual(["gpt-eu"]);
  });

  test("resolution refuses a non-EU route and the unlisted-model fallback", () => {
    expect(resolveTurnModel(eu(), "azure-eu/gpt-eu")?.configured.upstreamModelId).toBe("gpt-eu");
    expect(() => resolveTurnModel(eu(), "azure-eu/gpt-global-eu")).toThrow(
      InferenceRegionRestrictedError,
    );
    expect(() => resolveTurnModel(eu(), "not-configured")).toThrow(InferenceRegionRestrictedError);
    // Without the requirement nothing changes.
    expect(resolveTurnModel(settings(), "azure-eu/gpt-global-eu")).not.toBeNull();
    expect(resolveTurnModel(settings(), "not-configured")).toBeNull();
  });

  test("the built-in fallback binding is refused under EU when the built-in model is not EU", () => {
    const provider = new MultiProviderModelProvider(eu());
    expect(() => provider.resolveBinding(eu().openaiModel)).toThrow(InferenceRegionRestrictedError);
    expect(() => provider.resolveBinding()).toThrow(InferenceRegionRestrictedError);
  });

  test("a client built from EU settings refuses non-EU requests outside any run context", async () => {
    const { sent, inner } = recordingFetch();
    const guarded = instrumentedModelFetch(
      "azure-eu",
      inner,
      false,
      inferenceResidencyRequirement(eu()),
    );
    await guarded(URL_RESPONSES, post("gpt-eu"));
    await expect(guarded(URL_RESPONSES, post("gpt-global-eu"))).rejects.toThrow(
      InferenceRegionRestrictedError,
    );
    // The same model on another provider id is not the declared route.
    const other = instrumentedModelFetch(
      "openai",
      inner,
      false,
      inferenceResidencyRequirement(eu()),
    );
    await expect(other(URL_RESPONSES, post("gpt-eu"))).rejects.toThrow(
      InferenceRegionRestrictedError,
    );
    // A body without a readable model is refused.
    await expect(guarded(URL_RESPONSES, { method: "POST", body: "not json" })).rejects.toThrow(
      InferenceRegionRestrictedError,
    );
    expect(sent).toHaveLength(1);
  });

  test("a non-model request with a body is refused under EU; reads pass", async () => {
    const { sent, inner } = recordingFetch();
    const guarded = instrumentedModelFetch(
      "azure-eu",
      inner,
      false,
      inferenceResidencyRequirement(eu()),
    );
    await guarded("https://res.openai.azure.com/openai/v1/models", { method: "GET" });
    await expect(
      guarded("https://res.openai.azure.com/openai/v1/images/generations", post("gpt-eu")),
    ).rejects.toThrow(InferenceRegionRestrictedError);
    expect(sent).toHaveLength(1);
  });

  test("an unresolved run context refuses every model request until it is bound", async () => {
    const { sent, inner } = recordingFetch();
    const unbound = instrumentedModelFetch("azure-eu", inner);
    await withInferenceResidency(null, async () => {
      await expect(unbound(URL_RESPONSES, post("gpt-eu"))).rejects.toThrow(
        InferenceRegionRestrictedError,
      );
      resolveInferenceResidency(settings());
      await unbound(URL_RESPONSES, post("gpt-global-eu"));
    });
    expect(sent).toHaveLength(1);
  });

  test("an EU run context applies to clients built without the requirement and never widens", async () => {
    const { sent, inner } = recordingFetch();
    const unbound = instrumentedModelFetch("azure-eu", inner);
    await withInferenceResidency(eu(), async () => {
      await unbound(URL_RESPONSES, post("gpt-eu"));
      await expect(unbound(URL_RESPONSES, post("gpt-global-eu"))).rejects.toThrow(
        InferenceRegionRestrictedError,
      );
      // A later settings snapshot without the requirement does not relax it.
      resolveInferenceResidency(settings());
      await expect(unbound(URL_RESPONSES, post("gpt-global-eu"))).rejects.toThrow(
        InferenceRegionRestrictedError,
      );
    });
    // Outside a context, a client without a requirement is unaffected.
    await unbound(URL_RESPONSES, post("gpt-global-eu"));
    expect(sent).toHaveLength(2);
  });

  test("a stream body is inspected without consuming what is sent", async () => {
    const received: string[] = [];
    const inner = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      received.push(await new Response(init?.body as ReadableStream).text());
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const guarded = instrumentedModelFetch(
      "azure-eu",
      inner,
      false,
      inferenceResidencyRequirement(eu()),
    );
    const body = JSON.stringify({ model: "gpt-eu", input: "hi" });
    await guarded(URL_RESPONSES, {
      method: "POST",
      body: new Response(body).body,
      duplex: "half",
    } as RequestInit);
    expect(received).toEqual([body]);
    await expect(
      guarded(URL_RESPONSES, {
        method: "POST",
        body: new Response(JSON.stringify({ model: "gpt-global-eu" })).body,
        duplex: "half",
      } as RequestInit),
    ).rejects.toThrow(InferenceRegionRestrictedError);
  });

  test("clients for EU and non-EU settings are not shared through the client cache", async () => {
    const euModel = resolveTurnModel(eu(), "azure-eu/gpt-eu")!;
    const openModel = resolveTurnModel(settings(), "azure-eu/gpt-eu")!;
    expect(euModel.client).not.toBe(openModel.client);
  });
});
