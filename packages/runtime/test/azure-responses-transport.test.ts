import { expect, test } from "bun:test";
import { resolveModelProvider } from "@opengeni/config";
import { testSettings } from "@opengeni/testing/settings";
import {
  createResponsesTurn,
  isModelSocketTransportError,
  responsesTransport,
  withResponsesConversation,
} from "@opengeni/network/responses-websocket";
import { buildOpenAIClientFromSettings, buildProviderClient } from "../src/model-provider-client";

const key = "fixture-azure-key";
const azureSettings = () =>
  testSettings({
    openaiProvider: "azure",
    azureOpenaiBaseUrl: "https://example.openai.azure.com/openai/v1",
    azureOpenaiApiKey: key,
    azureOpenaiAdToken: undefined,
    openaiResponsesWebSocketEnabled: true,
    openaiMaxRetries: 0,
  });

test.each(["key", "entra", "both", "openai"] as const)(
  "configured %s authentication retains its explicit credential kind",
  async (kind) => {
    const settings = azureSettings();
    if (kind === "entra") settings.azureOpenaiApiKey = undefined;
    if (kind === "entra" || kind === "both") settings.azureOpenaiAdToken = "fixture-entra";
    if (kind === "openai") {
      settings.openaiProvider = "openai";
      settings.openaiApiKey = "fixture-openai";
    }
    let headers = new Headers();
    const client = buildOpenAIClientFromSettings(settings).withOptions({
      fetch: async (_input, init) => {
        headers = new Headers(init?.headers);
        return Response.json({ id: "response", output: [] });
      },
    });
    await client.responses.create({ model: "deployment", input: "Hello" });
    expect(headers.get("api-key")).toBe(kind === "key" || kind === "both" ? key : null);
    expect(headers.get("authorization")).toBe(
      kind === "entra"
        ? "Bearer fixture-entra"
        : kind === "openai"
          ? "Bearer fixture-openai"
          : null,
    );
  },
);

test.each([undefined, { aUtHoRiZaTiOn: "Bearer explicit-entra" }])(
  "resolved Azure clients use api-key without overriding explicit bearer headers: %j",
  async (defaultHeaders) => {
    const settings = testSettings({
      modelProvidersJson: JSON.stringify([
        {
          id: "azure-secondary",
          api: "responses",
          wireProfile: "azure-openai",
          baseUrl: "https://secondary.openai.azure.com/openai/v1",
          apiKey: key,
          models: [{ id: "secondary-model" }],
        },
      ]),
    });
    const { provider } = resolveModelProvider(settings, "secondary-model");
    let headers = new Headers();
    const client = buildProviderClient(
      { ...provider, ...(defaultHeaders ? { defaultHeaders } : {}) },
      settings,
    ).withOptions({
      fetch: async (_input, init) => {
        headers = new Headers(init?.headers);
        return Response.json({ id: "response", output: [] });
      },
    });
    await client.responses.create({ model: "deployment", input: "Hello" });
    expect(headers.get("api-key")).toBe(defaultHeaders ? null : key);
    expect(headers.get("authorization")).toBe(defaultHeaders ? "Bearer explicit-entra" : null);
  },
);

test.each([101, 302, 307, 403, 429, 503])(
  "real WebSocket Azure-style upgrade %s preserves auth, refusal and retry policy",
  async (upgradeStatus) => {
    const urls: string[] = [];
    const headers: Headers[] = [];
    const socketBodies: unknown[] = [];
    const httpBodies: unknown[] = [];
    let upgrades = 0;
    let fallbacks = 0;
    const terminal = {
      type: "response.completed",
      response: { id: "response", status: "completed", output: [] },
    };
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request, listener) {
        urls.push(request.url);
        headers.push(request.headers);
        if (request.headers.get("upgrade") === "websocket") {
          upgrades++;
          if (upgradeStatus === 101) {
            expect(request.headers.get("api-key")).toBe(key);
            if (listener.upgrade(request)) return;
            return new Response("Upgrade failed", { status: 500 });
          }
          return new Response(null, {
            status: upgradeStatus,
            // Never follow even a same-origin redirect containing a credential.
            headers: { location: `${listener.url}responses?api-key=redirect-fixture` },
          });
        }
        expect(fallbacks).toBeGreaterThan(0);
        httpBodies.push(await request.json());
        return new Response(`data: ${JSON.stringify(terminal)}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        });
      },
      websocket: {
        message(socket, data) {
          socketBodies.push(JSON.parse(String(data)));
          socket.send(JSON.stringify(terminal));
        },
      },
    });
    const transport = responsesTransport(fetch, {
      endpoint: {
        label: "Azure",
        url: /^http:\/\/127\.0\.0\.1:\d+\/responses$/,
        httpOnlyFields: ["stream", "background"],
        conversationScoped: true,
      },
    });
    const client = buildOpenAIClientFromSettings(azureSettings()).withOptions({
      baseURL: String(server.url),
      fetch: transport as typeof fetch,
      maxRetries: 0,
    });
    const turn = () =>
      createResponsesTurn("azure-chat", undefined, {
        onFallback: async () => {
          // The HTTP request must wait for durable turn-fallback selection.
          await Bun.sleep(1);
          fallbacks++;
        },
      });
    const firstTurn = turn();
    const request = {
      model: "deployment",
      input: "Hello",
      instructions: "Be brief",
      stream: true as const,
    };
    const send = (scope = firstTurn) =>
      withResponsesConversation(scope, async () => {
        const events = [];
        for await (const event of await client.responses.create(request)) events.push(event);
        return events;
      });
    try {
      if (upgradeStatus === 429 || upgradeStatus === 503) {
        const error = await send().catch((failure: unknown) => failure);
        expect(isModelSocketTransportError(error)).toBe(true);
        expect(httpBodies).toHaveLength(0);
        expect(fallbacks).toBe(0);
        expect(firstTurn.httpOnly).toBe(false);
      } else {
        expect(await send()).toMatchObject([terminal]);
        expect(await send()).toMatchObject([terminal]);
        expect(upgrades).toBe(1);
        if (upgradeStatus === 101) {
          expect(socketBodies).toHaveLength(2);
          expect(httpBodies).toHaveLength(0);
          expect(fallbacks).toBe(0);
          const { stream: _stream, ...socketRequest } = request;
          expect(socketBodies[0]).toEqual({ ...socketRequest, type: "response.create" });
        } else {
          expect(socketBodies).toHaveLength(0);
          expect(httpBodies).toEqual([request, request]);
          expect(fallbacks).toBe(1);
          expect(await send(turn())).toMatchObject([terminal]);
          expect(upgrades).toBe(2);
          expect(fallbacks).toBe(2);
        }
      }
      expect(
        headers.every((value) => value.get("api-key") === key && !value.has("authorization")),
      ).toBe(true);
      expect(urls.every((url) => !new URL(url).search)).toBe(true);
    } finally {
      server.stop(true);
    }
  },
);
