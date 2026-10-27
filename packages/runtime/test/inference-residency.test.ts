import { describe, expect, spyOn, test } from "bun:test";
import { euModelRoutes, type Settings } from "@opengeni/config";
import { testSettings } from "@opengeni/testing/settings";
import {
  InferenceRegionRestrictedError,
  MultiProviderModelProvider,
  currentInferenceResidency,
  findInferenceRegionRestrictedError,
  inferenceResidencyRequirement,
  resolveInferenceResidency,
  resolveTurnModel,
  withInferenceResidency,
} from "../src";
import { instrumentedModelFetch } from "../src/model-provider-client";
import { ReplayableJsonOpenAI } from "../src/replayable-json-body";

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

  test("under EU a hosted provider tool in the body is refused, even on an EU model route", async () => {
    const { sent, inner } = recordingFetch();
    const guarded = instrumentedModelFetch(
      "azure-eu",
      inner,
      false,
      inferenceResidencyRequirement(eu()),
    );
    const withTools = (tools: unknown[], extra: Record<string, unknown> = {}): RequestInit => ({
      method: "POST",
      body: JSON.stringify({ model: "gpt-eu", input: "hi", tools, ...extra }),
    });
    // Function tools run here: allowed.
    await guarded(URL_RESPONSES, withTools([{ type: "function", name: "lookup" }]));
    // Hosted search (Grounding with Bing on Azure) and hosted image generation are not EU.
    for (const tools of [
      [{ type: "web_search" }],
      [{ type: "web_search_preview" }],
      [{ type: "web_search_20250305", name: "web_search" }],
      [{ type: "image_generation" }],
      // Hosted tools without any residency record are refused too.
      [{ type: "code_interpreter" }],
      [{ type: "mcp", server_url: "https://mcp.example.com" }],
    ]) {
      await expect(guarded(URL_RESPONSES, withTools(tools))).rejects.toThrow(
        InferenceRegionRestrictedError,
      );
    }
    await expect(guarded(URL_RESPONSES, withTools([], { web_search_options: {} }))).rejects.toThrow(
      "Web search is not supported in EU.",
    );
    expect(sent).toHaveLength(1);
    // Outside EU hosted tools pass as before.
    const open = instrumentedModelFetch("azure-eu", inner, false, null);
    await open(URL_RESPONSES, withTools([{ type: "web_search" }]));
    expect(sent).toHaveLength(2);
  });

  test("under EU only tools Opengeni executes pass; unknown and hosted entries are refused", async () => {
    const { sent, inner } = recordingFetch();
    const guarded = instrumentedModelFetch(
      "azure-eu",
      inner,
      false,
      inferenceResidencyRequirement(eu()),
    );
    const withTools = (tools: unknown, extra: Record<string, unknown> = {}): RequestInit => ({
      method: "POST",
      body: JSON.stringify({ model: "gpt-eu", input: "hi", tools, ...extra }),
    });
    // Client-executed tools: allowed.
    const allowed: unknown[] = [
      { type: "function", name: "lookup" },
      { type: "custom", name: "grammar" },
      { type: "local_shell" },
      { type: "apply_patch" },
      { type: "computer_use_preview" },
      { type: "shell" },
      { type: "shell", environment: { type: "local" } },
      { type: "tool_search", execution: "client" },
      { type: "bash_20250124", name: "bash" },
      { type: "text_editor_20250728", name: "str_replace_based_edit_tool" },
      { type: "computer_20250124", name: "computer" },
      { type: "memory_20250818", name: "memory" },
      { name: "lookup", input_schema: { type: "object" } },
      { type: "namespace", name: "crm", tools: [{ type: "function", name: "find" }] },
    ];
    await guarded(URL_RESPONSES, withTools(allowed));
    expect(sent).toHaveLength(1);
    // Each case the review proved reached the provider is refused.
    for (const [tools, extra] of [
      [[{ type: "shell", environment: { type: "container_auto" } }], {}],
      [[{ type: "mcp_toolset", mcp_server_name: "crm" }], {}],
      [[], { mcp_servers: [{ type: "url", url: "https://mcp.example.com", name: "crm" }] }],
      [[{ google_search: {} }], {}],
      [[], { plugins: [{ id: "web" }] }],
      [[], { data_sources: [{ type: "azure_search", parameters: {} }] }],
      [[], { search_parameters: { mode: "on" } }],
      [[{ type: "a_future_hosted_tool" }], {}],
      [[{ type: "tool_search" }], {}],
      [[{ type: "tool_search", execution: "server" }], {}],
      [[{ type: "namespace", name: "x", tools: [{ type: "web_search" }] }], {}],
      [[{ name: "no_schema" }], {}],
      [{ type: "web_search" }, {}],
    ] as [unknown, Record<string, unknown>][]) {
      await expect(guarded(URL_RESPONSES, withTools(tools, extra))).rejects.toThrow(
        InferenceRegionRestrictedError,
      );
    }
    expect(sent).toHaveLength(1);
    // Empty hosted options request nothing.
    await guarded(URL_RESPONSES, withTools([], { plugins: [], mcp_servers: null }));
    expect(sent).toHaveLength(2);
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
    // Any method other than a read is refused, with or without a body.
    await expect(
      guarded("https://res.openai.azure.com/openai/v1/files/file-1", { method: "DELETE" }),
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

  test("an SDK client surfaces a refusal once, as the typed error, without retrying", async () => {
    const { sent, inner } = recordingFetch();
    const guarded = instrumentedModelFetch(
      "azure-eu",
      inner,
      false,
      inferenceResidencyRequirement(eu()),
    );
    let attempts = 0;
    const client = new ReplayableJsonOpenAI({
      apiKey: "key",
      baseURL: "https://res.openai.azure.com/openai/v1",
      maxRetries: 2,
      fetch: (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        attempts += 1;
        return await guarded(input, init);
      }) as typeof fetch,
    });
    const error = await client.responses
      .create({ model: "gpt-global-eu", input: "hi" })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(InferenceRegionRestrictedError);
    expect(attempts).toBe(1);
    expect(sent).toHaveLength(0);
  });

  test("a client resolved for an EU-only run refuses a non-EU body once, with retries on", async () => {
    const network = spyOn(globalThis, "fetch").mockImplementation(
      (async () => new Response("{}", { status: 500 })) as unknown as typeof fetch,
    );
    try {
      const resolved = resolveTurnModel(
        settings({ requiredModelGeography: "eu", openaiMaxRetries: 2 }),
        "azure-eu/gpt-eu",
      )!;
      const error = await resolved.client.responses
        .create({ model: "gpt-global-eu", input: "hi" })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(InferenceRegionRestrictedError);
      expect(network).not.toHaveBeenCalled();
    } finally {
      network.mockRestore();
    }
  });

  test("a wrapped refusal is still found on the cause chain", () => {
    const refusal = new InferenceRegionRestrictedError("gpt-global-eu");
    const wrapped = new Error("Connection error.", { cause: new Error("x", { cause: refusal }) });
    expect(findInferenceRegionRestrictedError(wrapped)).toBe(refusal);
    expect(findInferenceRegionRestrictedError(refusal)).toBe(refusal);
    expect(findInferenceRegionRestrictedError(new Error("other"))).toBeNull();
    const cyclic = new Error("cyclic") as Error & { cause?: unknown };
    cyclic.cause = cyclic;
    expect(findInferenceRegionRestrictedError(cyclic)).toBeNull();
  });

  test("an SDK request body is checked from its source object, without buffering it", async () => {
    const outerBodies: unknown[] = [];
    const innerBodies: unknown[] = [];
    const inner = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      innerBodies.push(init?.body);
      await new Response(init?.body as ReadableStream).text();
      return new Response(JSON.stringify({ id: "resp", output: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const guarded = instrumentedModelFetch(
      "azure-eu",
      inner,
      false,
      inferenceResidencyRequirement(eu()),
    );
    const client = new ReplayableJsonOpenAI({
      apiKey: "key",
      baseURL: "https://res.openai.azure.com/openai/v1",
      maxRetries: 0,
      fetch: (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        outerBodies.push(init?.body);
        return await guarded(input, init);
      }) as typeof fetch,
    });
    await client.responses.create({ model: "gpt-eu", input: "hi" });
    expect(outerBodies[0]).toBeInstanceOf(ReadableStream);
    // The same stream reaches the network: it was neither tee'd nor read.
    expect(innerBodies).toHaveLength(1);
    expect(innerBodies[0]).toBe(outerBodies[0]);
  });

  test("a nested context never widens an EU or unresolved parent", async () => {
    const { sent, inner } = recordingFetch();
    const unbound = instrumentedModelFetch("azure-eu", inner);
    await withInferenceResidency(eu(), async () => {
      await withInferenceResidency(settings(), async () => {
        expect(currentInferenceResidency()?.requirement?.geography).toBe("eu");
        await unbound(URL_RESPONSES, post("gpt-eu"));
        await expect(unbound(URL_RESPONSES, post("gpt-global-eu"))).rejects.toThrow(
          InferenceRegionRestrictedError,
        );
      });
    });
    await withInferenceResidency(null, async () => {
      await withInferenceResidency(settings(), async () => {
        expect(currentInferenceResidency()?.resolved).toBe(false);
        await expect(unbound(URL_RESPONSES, post("gpt-global-eu"))).rejects.toThrow(
          InferenceRegionRestrictedError,
        );
      });
      // The parent's own later binding still applies to contexts nested afterwards.
      resolveInferenceResidency(eu());
      await withInferenceResidency(settings(), async () => {
        await unbound(URL_RESPONSES, post("gpt-eu"));
        await expect(unbound(URL_RESPONSES, post("gpt-global-eu"))).rejects.toThrow(
          InferenceRegionRestrictedError,
        );
      });
    });
    // A nested EU context narrows an open parent.
    await withInferenceResidency(settings(), async () => {
      await withInferenceResidency(eu(), async () => {
        await expect(unbound(URL_RESPONSES, post("gpt-global-eu"))).rejects.toThrow(
          InferenceRegionRestrictedError,
        );
      });
      await unbound(URL_RESPONSES, post("gpt-global-eu"));
    });
    expect(sent).toHaveLength(3);
  });

  test("a deployment-path URL is checked against the deployment it calls", async () => {
    const { sent, inner } = recordingFetch();
    const guarded = instrumentedModelFetch(
      "azure-eu",
      inner,
      false,
      inferenceResidencyRequirement(eu()),
    );
    const deployment = (name: string) =>
      `https://res.openai.azure.com/openai/deployments/${name}/responses?api-version=2025-04-01-preview`;
    // The body names the EU route, but Azure runs the deployment in the URL.
    await expect(guarded(deployment("gpt-global-standard"), post("gpt-eu"))).rejects.toThrow(
      InferenceRegionRestrictedError,
    );
    await guarded(deployment("gpt-eu"), post("gpt-eu"));
    expect(sent).toHaveLength(1);
    // Case, percent-encoding and empty segments don't hide the deployment,
    // and a deployment path without a readable name is refused.
    for (const path of [
      "/openai/Deployments/gpt-global-standard/responses",
      "/openai/%64eployments/gpt-global-standard/responses",
      "/openai/deployments//gpt-global-standard/responses",
      "/openai/deployments%2Fgpt-global-standard/responses",
      "/openai/deployments",
      "/openai/deployments/",
      "/openai/deployments/gpt-eu/deployments/gpt-global-standard/responses",
    ]) {
      await expect(
        guarded(`https://res.openai.azure.com${path}?api-version=1`, post("gpt-eu")),
      ).rejects.toThrow(InferenceRegionRestrictedError);
    }
    await guarded(
      "https://res.openai.azure.com/openai/DEPLOYMENTS//gpt-eu/responses",
      post("gpt-eu"),
    );
    expect(sent).toHaveLength(2);
  });

  test("built-in Azure deployment-path mode refuses a model that is not its deployment", () => {
    const builtin = (deployment: string) =>
      testSettings({
        openaiProvider: "azure",
        azureOpenaiEndpoint: "https://res.openai.azure.com",
        azureOpenaiDeployment: deployment,
        azureOpenaiApiVersion: "2025-04-01-preview",
        azureOpenaiApiKey: "az-key",
        openaiModel: "gpt-eu",
        builtinModelResidencyJson: JSON.stringify({ "gpt-eu": euDataZone }),
        requiredModelGeography: "eu",
      });
    // Requests would reach gpt-global-standard, so the gpt-eu claim does not hold.
    expect(() => resolveTurnModel(builtin("gpt-global-standard"), "gpt-eu")).toThrow(
      InferenceRegionRestrictedError,
    );
    expect(() =>
      new MultiProviderModelProvider(builtin("gpt-global-standard")).resolveBinding("gpt-eu"),
    ).toThrow(InferenceRegionRestrictedError);
    expect(resolveTurnModel(builtin("gpt-eu"), "gpt-eu")?.configured.id).toBe("gpt-eu");
  });
});
