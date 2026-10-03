import { describe, expect, test } from "bun:test";
import { configuredProviders, getSettings } from "@opengeni/config";
import { azureGatewayFailoverFetch } from "../src/azure-gateway-failover";
import { buildProviderClient } from "../src/model-provider-client";
import { REPLAYABLE_REQUEST_BODY_FACTORY, requestBodyText } from "../src/replayable-json-body";

const model = "fixture-model";
const target = `openai/${model}`;
const primaryUrl = "https://primary.example/openai/v1/responses?api-version=example";
const originalBody = {
  model,
  input: [
    { role: "user", content: "Use the echo function." },
    { type: "reasoning", encrypted_content: "synthetic-opaque-reasoning", summary: [] },
    { type: "function_call", call_id: "call_fixture", name: "echo", arguments: "{}" },
    { type: "function_call_output", call_id: "call_fixture", output: "fixture-output" },
  ],
  tools: [{ type: "function", name: "echo", parameters: { type: "object", properties: {} } }],
  reasoning: { effort: "low" },
  store: false,
  stream: true,
  providerOptions: {
    azure: { apiKey: "synthetic-primary-option-key" },
    gateway: { byok: { azure: [{ apiKey: "caller-key" }] }, models: ["other/model"] },
  },
};
const init = () => ({
  method: "POST",
  headers: {
    Authorization: "Bearer primary-secret",
    "api-key": "primary-secret",
    Cookie: "fixture-cookie",
    "openai-project": "project-fixture",
  },
  body: JSON.stringify(originalBody),
});

describe("same-model Azure Gateway failover", () => {
  for (const status of [429, 500, 502, 503, 504]) {
    test(`makes one isolated fallback after a ${status} refusal`, async () => {
      let primaries = 0,
        fallbacks = 0,
        cancelled = false;
      const routed = azureGatewayFailoverFetch(
        { [model]: target },
        "gateway-secret",
        (async () => {
          primaries++;
          return new Response(
            new ReadableStream({
              cancel() {
                cancelled = true;
              },
            }),
            { status },
          );
        }) as typeof fetch,
        (async (url, request) => {
          fallbacks++;
          expect(String(url)).toBe("https://ai-gateway.vercel.sh/v1/responses");
          expect(Object.fromEntries(new Headers(request?.headers))).toEqual({
            authorization: "Bearer gateway-secret",
            "content-type": "application/json",
          });
          expect(JSON.parse(await requestBodyText(request?.body))).toEqual({
            ...originalBody,
            model: target,
            providerOptions: { gateway: { only: ["openai"], order: ["openai"] } },
          });
          return new Response("fallback", { status: 200 });
        }) as typeof fetch,
      );
      expect(await (await routed(primaryUrl, init())).text()).toBe("fallback");
      expect([primaries, fallbacks, cancelled]).toEqual([1, 1, true]);
    });
  }

  test("does not replay authentication, validation, policy or other refusals", async () => {
    for (const status of [200, 400, 401, 403, 404, 408, 409, 422, 501]) {
      const response = new Response("primary", { status });
      let calls = 0;
      const routed = azureGatewayFailoverFetch(
        { [model]: target },
        "gateway-secret",
        (async () => response) as typeof fetch,
        (async () => {
          calls++;
          return new Response();
        }) as typeof fetch,
      );
      expect(await routed(primaryUrl, init())).toBe(response);
      expect(calls).toBe(0);
    }
  });

  test("keeps network and acknowledgement uncertainty with the primary", async () => {
    const failure = new Error("synthetic connection reset");
    let calls = 0;
    const routed = azureGatewayFailoverFetch(
      { [model]: target },
      "gateway-secret",
      (async () => {
        throw failure;
      }) as typeof fetch,
      (async () => {
        calls++;
        return new Response();
      }) as typeof fetch,
    );
    await expect(routed(primaryUrl, init())).rejects.toBe(failure);
    expect(calls).toBe(0);
  });

  test("continues only a typed encrypted-reasoning rejection without changing history", async () => {
    for (const [code, input, expected] of [
      ["invalid_encrypted_content", originalBody.input, 1],
      ["invalid_encrypted_content", [{ role: "user", content: "fixture" }], 0],
      ["invalid_request_error", originalBody.input, 0],
    ] as const) {
      let calls = 0;
      const routed = azureGatewayFailoverFetch(
        { [model]: target },
        "gateway-secret",
        (async () => Response.json({ error: { code } }, { status: 400 })) as typeof fetch,
        (async (_url, request) => {
          calls++;
          expect(JSON.parse(await requestBodyText(request?.body)).input).toEqual(
            originalBody.input,
          );
          return new Response("continued");
        }) as typeof fetch,
      );
      await routed(primaryUrl, { ...init(), body: JSON.stringify({ ...originalBody, input }) });
      expect(calls).toBe(expected);
    }
  });

  test("never starts fallback for a broken successful stream", async () => {
    let calls = 0;
    const response = new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode("data: partial\n\n"));
        },
        pull(c) {
          c.error(new Error("synthetic stream loss"));
        },
      }),
    );
    const routed = azureGatewayFailoverFetch(
      { [model]: target },
      "gateway-secret",
      (async () => response) as typeof fetch,
      (async () => {
        calls++;
        return new Response();
      }) as typeof fetch,
    );
    const actual = await routed(primaryUrl, init());
    await expect(actual.text()).rejects.toThrow("synthetic stream loss");
    expect(calls).toBe(0);
  });

  test("cancellation remains authoritative after primary rejection", async () => {
    const controller = new AbortController();
    let calls = 0;
    const routed = azureGatewayFailoverFetch(
      { [model]: target },
      "gateway-secret",
      (async () => {
        controller.abort();
        return new Response("primary", { status: 429 });
      }) as typeof fetch,
      (async () => {
        calls++;
        return new Response();
      }) as typeof fetch,
    );
    const result = await routed(primaryUrl, { ...init(), signal: controller.signal });
    expect(await result.text()).toBe("primary");
    expect(calls).toBe(0);
  });

  test("does not move provider-owned state, unreviewed tools, or unknown models", async () => {
    const overrides = [
      { model: "unconfigured" },
      { previous_response_id: "resp_fixture" },
      { conversation: "conv_fixture" },
      { background: true },
      { input: [{ type: "item_reference", id: "item_fixture" }] },
      { input: [{ type: "compaction", encrypted_content: "synthetic" }] },
      { input: [{ role: "user", content: [{ type: "input_file", file_id: "file_fixture" }] }] },
      { tools: [{ type: "mcp", server_url: "https://tools.example/mcp" }] },
      { tools: [{ type: "image_generation" }] },
      { tools: [{ type: "code_interpreter" }] },
    ];
    for (const override of overrides) {
      let calls = 0;
      const response = new Response("primary", { status: 503 });
      const routed = azureGatewayFailoverFetch(
        { [model]: target },
        "gateway-secret",
        (async () => response) as typeof fetch,
        (async () => {
          calls++;
          return new Response();
        }) as typeof fetch,
      );
      expect(
        await routed(primaryUrl, {
          ...init(),
          body: JSON.stringify({ ...originalBody, ...override }),
        }),
      ).toBe(response);
      expect(calls).toBe(0);
    }
  });

  test("ignores non-create endpoints and arbitrary one-shot bodies", async () => {
    for (const request of [
      { url: primaryUrl.replace("responses", "chat/completions"), init: init() },
      { url: primaryUrl, init: { ...init(), method: "GET" } },
      { url: primaryUrl, init: { ...init(), body: new Blob([init().body]).stream() } },
    ]) {
      let calls = 0;
      const response = new Response("primary", { status: 429 });
      const routed = azureGatewayFailoverFetch(
        { [model]: target },
        "gateway-secret",
        (async () => response) as typeof fetch,
        (async () => {
          calls++;
          return new Response();
        }) as typeof fetch,
      );
      expect(await routed(request.url, request.init)).toBe(response);
      expect(calls).toBe(0);
    }
  });

  test("uses a fresh SDK body iterator after the physical primary consumed its input", async () => {
    let calls = 0;
    const text = init().body;
    const makeBody = () => new Blob([text]).stream();
    const routed = azureGatewayFailoverFetch(
      { [model]: target },
      "gateway-secret",
      (async (_url, request) => {
        expect(await requestBodyText(request?.body)).toBe(text);
        return new Response("primary", { status: 429 });
      }) as typeof fetch,
      (async (_url, request) => {
        calls++;
        expect(JSON.parse(await requestBodyText(request?.body)).input).toEqual(originalBody.input);
        return new Response("fallback");
      }) as typeof fetch,
    );
    await routed(primaryUrl, {
      ...init(),
      body: makeBody(),
      [REPLAYABLE_REQUEST_BODY_FACTORY]: makeBody,
    } as RequestInit);
    expect(calls).toBe(1);
  });

  test("a failed fallback never loops back to primary", async () => {
    let primaries = 0,
      fallbacks = 0;
    const routed = azureGatewayFailoverFetch(
      { [model]: target },
      "gateway-secret",
      (async () => {
        primaries++;
        return new Response("primary", { status: 429 });
      }) as typeof fetch,
      (async () => {
        fallbacks++;
        return new Response("fallback", { status: 503 });
      }) as typeof fetch,
    );
    expect((await routed(primaryUrl, init())).status).toBe(503);
    expect([primaries, fallbacks]).toEqual([1, 1]);
  });

  for (const registry of [false, true]) {
    test(`installed SDK makes exactly two physical requests for ${registry ? "registry" : "built-in"} Azure`, async () => {
      let primaries = 0,
        fallbacks = 0;
      const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        async fetch(request) {
          const data = (await request.json()) as Record<string, unknown>;
          if (new URL(request.url).pathname === "/responses") {
            primaries++;
            expect(data.model).toBe(model);
            return Response.json(
              { error: { type: "rate_limit_error", message: "synthetic capacity refusal" } },
              { status: 429 },
            );
          }
          fallbacks++;
          expect(data.model).toBe(target);
          expect(request.headers.get("authorization")).toBe("Bearer gateway-secret");
          return Response.json(
            { error: { type: "server_error", message: "synthetic fallback failure" } },
            { status: 503 },
          );
        },
      });
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (url, request) => {
        if (String(url) === "https://ai-gateway.vercel.sh/v1/responses")
          return await originalFetch(`${server.url}fallback`, request);
        return await originalFetch(url, request);
      }) as typeof fetch;
      try {
        const id = registry ? "fixture-primary" : "azure";
        const settings = getSettings({
          OPENGENI_ENV: "test",
          OPENGENI_OPENAI_PROVIDER: "azure",
          OPENGENI_OPENAI_MODEL: model,
          OPENGENI_OPENAI_ALLOWED_MODELS: model,
          OPENGENI_AZURE_OPENAI_BASE_URL: String(server.url),
          OPENGENI_AZURE_OPENAI_API_KEY: "primary-secret",
          OPENGENI_OPENAI_MAX_RETRIES: "5",
          OPENGENI_VERCEL_AI_GATEWAY_API_KEY: "gateway-secret",
          OPENGENI_AZURE_GATEWAY_FAILOVER_JSON: JSON.stringify({ [id]: { [model]: target } }),
          OPENGENI_MODEL_PROVIDERS_JSON: registry
            ? JSON.stringify([
                {
                  id,
                  kind: "api-key",
                  api: "responses",
                  wireProfile: "azure-openai",
                  baseUrl: String(server.url),
                  apiKey: "primary-secret",
                  models: [{ id: "fixture/product", upstreamModelId: model }],
                },
              ])
            : "[]",
        });
        const provider = configuredProviders(settings).find((p) => p.id === id)!;
        const client = buildProviderClient(provider, settings);
        await expect(
          (async () =>
            await client.responses.create({ model, input: "Synthetic test", store: false }))(),
        ).rejects.toMatchObject({ status: 503 });
        expect([primaries, fallbacks]).toEqual([1, 1]);
      } finally {
        globalThis.fetch = originalFetch;
        await server.stop(true);
      }
    });
  }
});
