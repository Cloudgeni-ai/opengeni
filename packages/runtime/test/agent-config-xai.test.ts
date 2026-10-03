import { describe, expect, test } from "bun:test";
import type { ModelRequest } from "@openai/agents";
import type { ResolvedModelProvider } from "@opengeni/config";
import {
  allAgentCapabilities,
  noneAgentCapabilities,
  resolveAgentToolFamilies,
  type ResolvedAgentConfig,
} from "@opengeni/contracts";
import {
  XAI_SUBSCRIPTION_MODEL_ID_PREFIX,
  XAI_SUBSCRIPTION_PROVIDER_ID,
  XAI_SUBSCRIPTION_PROXY_BASE_URL,
  xaiSubscriptionFetch,
  xaiSubscriptionRequestStorage,
} from "@opengeni/xai-subscription";
import { buildModelInstance, modelRequestPolicyForProvider } from "../src/index";
import { ReplayableJsonOpenAI, requestBodyText } from "../src/replayable-json-body";

function config(from: "all" | "none", webSearch?: boolean): ResolvedAgentConfig {
  const capabilities = from === "all" ? allAgentCapabilities() : noneAgentCapabilities();
  if (webSearch !== undefined) capabilities.webSearch = webSearch;
  return {
    version: 1,
    from,
    capabilities,
    unavailable: [],
    identity: null,
    renderer: "opengeni",
    source: "request",
  };
}

// Capture the actual serialized proxy-bound request, not the gate's return
// value or an expected-body reconstruction. Provider policy, model conversion,
// replayable body handling and the subscription fetch wrapper are production.
async function captureXaiRequest(agent: ResolvedAgentConfig | null, webSearch = true) {
  const requests: Record<string, unknown>[] = [];
  const provider: ResolvedModelProvider = {
    id: XAI_SUBSCRIPTION_PROVIDER_ID,
    label: "SuperGrok subscription",
    kind: "xai-subscription",
    api: "responses",
    builtin: false,
  };
  const client = new ReplayableJsonOpenAI(
    {
      apiKey: "synthetic-placeholder",
      baseURL: XAI_SUBSCRIPTION_PROXY_BASE_URL,
      maxRetries: 0,
      fetch: xaiSubscriptionFetch(async (_input, init) => {
        requests.push(JSON.parse(await requestBodyText(init?.body)) as Record<string, unknown>);
        return new Response(
          'data: {"type":"response.completed","response":{"id":"r1","status":"completed","output":[],"usage":{"total_tokens":1,"context_details":{"input_tokens":1,"output_tokens":0}}}}\n\n',
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }),
    },
    { modelRequestPolicy: modelRequestPolicyForProvider(provider) },
  );
  const model = buildModelInstance(provider, client, `${XAI_SUBSCRIPTION_MODEL_ID_PREFIX}grok-4.6`);
  const families = resolveAgentToolFamilies(agent, { webSearch });
  const token = { accessToken: "synthetic-test-token", userId: "fixture-user" };
  await xaiSubscriptionRequestStorage.run(
    {
      clientVersion: "1.0.1",
      sessionId: "fixture-session",
      turnId: "fixture-turn",
      getToken: async () => token,
      refresh: async () => token,
      resolveModel: (slug) => slug,
      hostedSearch: { webSearch: families.webSearch, xSearch: families.webSearch },
    },
    async () => {
      for await (const _event of model.getStreamedResponse({
        input: "Reply done.",
        modelSettings: {},
        tools: [
          {
            type: "function",
            name: "customer_product_lookup",
            description: "A session-owned product tool",
            parameters: { type: "object", properties: {}, additionalProperties: false },
            strict: true,
          },
        ],
        handoffs: [],
        outputType: "text",
        tracing: false,
      } as ModelRequest)) {
        /* consume production SSE normalization */
      }
    },
  );
  expect(requests).toHaveLength(1);
  return requests[0]!;
}

function hostedTypes(request: Record<string, unknown>) {
  return (request.tools as { type: string }[])
    .filter((tool) => tool.type !== "function")
    .map((tool) => tool.type);
}

describe("agent configuration gates SuperGrok native search at the proxy boundary", () => {
  test("legacy null and configured all serialize identical proxy requests", async () => {
    const legacy = await captureXaiRequest(null);
    const all = await captureXaiRequest(config("all"));
    expect(all).toEqual(legacy);
    expect(hostedTypes(legacy)).toEqual(["web_search", "x_search"]);
    expect(legacy).toMatchObject({
      model: "grok-4.6",
      stream: true,
      store: false,
      include: ["reasoning.encrypted_content"],
    });
  });

  test.each([
    { label: "none", agent: config("none") },
    { label: "all with search off", agent: config("all", false) },
    {
      label: "deployment-unavailable search",
      agent: { ...config("all"), unavailable: ["webSearch"] } as ResolvedAgentConfig,
    },
  ])("$label omits both web_search and x_search", async ({ agent }) => {
    const request = await captureXaiRequest(agent);
    expect(hostedTypes(request)).toEqual([]);
    expect(request.tools).toMatchObject([{ type: "function", name: "customer_product_lookup" }]);
  });

  test("none with search explicitly enabled adds both native declarations", async () => {
    expect(hostedTypes(await captureXaiRequest(config("none", true)))).toEqual([
      "web_search",
      "x_search",
    ]);
  });

  test.each([null, config("all")])(
    "the deployment search switch narrows null and configured all",
    async (agent) => {
      const request = await captureXaiRequest(agent, false);
      expect(hostedTypes(request)).toEqual([]);
      expect(request.tools).toMatchObject([{ type: "function", name: "customer_product_lookup" }]);
    },
  );
});
