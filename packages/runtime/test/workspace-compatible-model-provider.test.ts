import { afterEach, describe, expect, test } from "bun:test";
import { configuredProviders, withDirectModelProviders } from "@opengeni/config";
import { directModelConnectionSpec } from "@opengeni/contracts";
import { testSettings } from "@opengeni/testing";

import { buildProviderClient } from "../src/model-provider";

// Unique to this file so no other test shares the connection identity.
const connection = {
  id: "00000000-0000-4000-8000-00000000c0a1",
  version: 1,
  subjectId: null,
  kind: "api_key",
  status: "active",
  providerDomain: "api.example.com",
  metadata: {
    credentialRole: "direct_openai_compatible",
    directModelProvider: {
      provider: "openai_compatible",
      baseUrl: "https://api.example.com/v1",
      model: "org/model:tag",
    },
  },
};
const spec = directModelConnectionSpec(connection)!;

function compatibleProvider(settings: ReturnType<typeof testSettings>, apiKey?: string) {
  const overlaid = withDirectModelProviders(settings, [
    { ...connection, ...(apiKey ? { apiKey } : {}) },
  ]);
  return {
    settings: overlaid,
    provider: configuredProviders(overlaid).find((candidate) => candidate.id === spec.providerId)!,
  };
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("a workspace's own OpenAI-compatible endpoint", () => {
  test("sends Chat Completions, streamed or not, with the workspace key to its base URL only", async () => {
    let globalFetchCalls = 0;
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      globalFetchCalls++;
      return await originalFetch(...args);
    }) as typeof fetch;
    const requests: Array<{ path: string; authorization: string | null; body: any }> = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const body = await request.json();
        requests.push({
          path: new URL(request.url).pathname,
          authorization: request.headers.get("authorization"),
          body,
        });
        const message = { role: "assistant", content: "Hello" };
        if (!body.stream) {
          return Response.json({
            id: "chatcmpl-1",
            object: "chat.completion",
            created: 0,
            model: body.model,
            choices: [{ index: 0, message, finish_reason: "stop" }],
          });
        }
        const chunk = (delta: object, finish: string | null) =>
          `data: ${JSON.stringify({
            id: "chatcmpl-2",
            object: "chat.completion.chunk",
            created: 0,
            model: body.model,
            choices: [{ index: 0, delta, finish_reason: finish }],
          })}\n\n`;
        return new Response(
          chunk({ role: "assistant", content: "Hel" }, null) +
            chunk({ content: "lo" }, "stop") +
            "data: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    try {
      const { settings, provider } = compatibleProvider(
        testSettings({ openaiApiKey: "sk-deployment-must-not-leak" }),
        "workspace-compatible-key",
      );
      expect(provider).toMatchObject({
        kind: "direct-compatible-workspace",
        api: "chat",
        label: "api.example.com",
      });
      // Local/test settings allow a loopback server; production refuses it (below).
      const client = buildProviderClient(
        { ...provider, baseUrl: `http://127.0.0.1:${server.port}/v1` },
        settings,
      );
      const completion = await client.chat.completions.create({
        model: "org/model:tag",
        messages: [{ role: "user", content: "Hi" }],
      });
      expect(completion.choices[0]?.message.content).toBe("Hello");
      const stream = await client.chat.completions.create({
        model: "org/model:tag",
        messages: [{ role: "user", content: "Hi" }],
        stream: true,
      });
      let streamed = "";
      for await (const event of stream) streamed += event.choices[0]?.delta.content ?? "";
      expect(streamed).toBe("Hello");
      expect(requests).toHaveLength(2);
      for (const request of requests) {
        expect(request.path).toBe("/v1/chat/completions");
        expect(request.authorization).toBe("Bearer workspace-compatible-key");
        expect(request.body.model).toBe("org/model:tag");
      }
      // The pinned transport, not the process-wide fetch, carried both requests.
      expect(globalFetchCalls).toBe(0);
    } finally {
      server.stop(true);
    }
  });

  test("refuses private addresses outside local and test, before any request", async () => {
    let requests = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        requests++;
        return new Response("{}");
      },
    });
    try {
      const { settings, provider } = compatibleProvider(testSettings(), "workspace-compatible-key");
      const client = buildProviderClient(
        { ...provider, baseUrl: `https://127.0.0.1:${server.port}/v1` },
        { ...settings, environment: "production", integrationsAllowPrivateNetworkTargets: false },
      );
      const error = await client.chat.completions
        .create({ model: "org/model:tag", messages: [{ role: "user", content: "Hi" }] })
        .catch((caught: unknown) => caught as Error & { cause?: Error });
      expect(error).toBeInstanceOf(Error);
      expect(String(error?.cause?.message ?? error?.message)).toContain(
        "private or special-use network address",
      );
      expect(requests).toBe(0);
    } finally {
      server.stop(true);
    }
  });

  test("a missing workspace key fails closed and never falls back to the deployment key", () => {
    const { settings, provider } = compatibleProvider(
      testSettings({ openaiApiKey: "sk-deployment-fallback" }),
    );
    expect(() => buildProviderClient(provider, settings)).toThrow("key is unavailable");
  });
});
