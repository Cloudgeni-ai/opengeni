import { describe, expect, test } from "bun:test";
import { configuredProviders, type ResolvedModelProvider } from "@opengeni/config";
import { testSettings } from "@opengeni/testing";

import {
  buildProviderClient,
  OrganizationOpperUnavailableError,
  WorkspaceOpperUnavailableError,
} from "../src/model-provider";
import { requestBodyText } from "../src/replayable-json-body";
import {
  isOpperClaudeUpstreamModel,
  modelRequestPolicyForProvider,
} from "../src/model-provider-request-policy";

const GEMINI = "vertexai/gemini-3.8-flash-eu";
const SONNET = "aws/claude-sonnet-4-6-eu";

function opperProvider(
  kind: "opper-managed" | "opper-workspace" | "opper-organization",
  apiKey: string | null = "op-key",
): ResolvedModelProvider {
  return {
    id: kind === "opper-managed" ? "opper" : kind.replace("opper-", "") + "-opper",
    label: "Opper",
    kind,
    api: "chat",
    wireProfile: "openai",
    builtin: false,
    baseUrl: "https://api.opper.ai/v3/compat",
    ...(apiKey ? { apiKey } : {}),
    credentialSource:
      kind === "opper-managed"
        ? { kind: "deployment", mechanism: "api_key" }
        : kind === "opper-workspace"
          ? { kind: "workspace_connection", mechanism: "api_key" }
          : { kind: "organization_connection", mechanism: "api_key" },
    billing:
      kind === "opper-managed"
        ? { upstreamPayer: "deployment", metering: "opengeni_credits" }
        : kind === "opper-workspace"
          ? { upstreamPayer: "workspace", metering: "external" }
          : { upstreamPayer: "organization", metering: "external" },
  };
}

const unsignedHistory = [
  { role: "user", content: "Start" },
  { role: "assistant", content: "Answer.", reasoning: "Unsigned fixture thought." },
  { role: "user", content: "Continue" },
];

describe("Opper request policy", () => {
  test("recognizes Claude across Opper pools, pinned routes and provider aliases", () => {
    for (const model of [
      "claude-sonnet-4-6",
      SONNET,
      "anthropic/claude-sonnet-4-6",
      "vertexai/claude-sonnet-4-6-eu",
      "eu.anthropic.claude-sonnet-4-6",
    ])
      expect(isOpperClaudeUpstreamModel(model)).toBe(true);
    for (const model of [GEMINI, "gemini-3.8-flash", "mistral/mistral-large-eu", undefined])
      expect(isOpperClaudeUpstreamModel(model)).toBe(false);
  });

  for (const kind of ["opper-managed", "opper-workspace", "opper-organization"] as const) {
    test(`moves unsigned reasoning into labeled text for Claude targets (${kind})`, () => {
      const policy = modelRequestPolicyForProvider(opperProvider(kind));
      const result = policy({
        path: "/chat/completions",
        body: { model: SONNET, messages: structuredClone(unsignedHistory) },
      });
      const serialized = JSON.stringify(result?.body.messages);
      expect(serialized).not.toContain('"reasoning"');
      expect(serialized).toContain("Unsigned fixture thought.");
      expect(serialized).toContain("Historical reasoning without a provider signature");
    });
  }

  test("leaves non-Claude Opper targets' native reasoning fields alone", () => {
    const policy = modelRequestPolicyForProvider(opperProvider("opper-workspace"));
    const result = policy({
      path: "/chat/completions",
      body: { model: GEMINI, messages: structuredClone(unsignedHistory) },
    });
    expect(JSON.stringify(result?.body.messages ?? unsignedHistory)).toContain('"reasoning"');
  });

  test("projects Gemini `$ref` tool-output keys for Opper Gemini routes", () => {
    const policy = modelRequestPolicyForProvider(opperProvider("opper-managed"));
    const result = policy({
      path: "/chat/completions",
      body: {
        model: GEMINI,
        messages: [
          { role: "user", content: "Search" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call-1",
                type: "function",
                function: { name: "tool_search", arguments: "{}" },
              },
            ],
          },
          {
            role: "tool",
            tool_call_id: "call-1",
            content: JSON.stringify({ schema: { $ref: "#/definitions/x" } }),
          },
        ],
      },
    });
    const toolMessage = (result!.body.messages as Array<Record<string, unknown>>).at(-1)!;
    expect(String(toolMessage.content)).toContain('"_$ref"');
    expect(String(toolMessage.content)).not.toContain('"$ref"');
  });

  test("an Opper model outside the reviewed catalog fails before network I/O", () => {
    const policy = modelRequestPolicyForProvider(
      opperProvider("opper-managed"),
      new Map([[GEMINI, undefined]]),
    );
    expect(() =>
      policy({ path: "/chat/completions", body: { model: "openai/gpt-unknown", messages: [] } }),
    ).toThrow(/not in the reviewed catalog/u);
    expect(() =>
      policy({ path: "/chat/completions", body: { model: GEMINI, messages: [] } }),
    ).not.toThrow();
  });
});

describe("Opper provider clients", () => {
  test("never let the SDK replay Opper requests", () => {
    const settings = testSettings({ opperApiKey: "op-deployment" });
    expect(settings.openaiMaxRetries).toBeGreaterThan(0);
    const managed = configuredProviders(settings).find((provider) => provider.id === "opper")!;
    expect(buildProviderClient(managed, settings).maxRetries).toBe(0);
    for (const kind of ["opper-workspace", "opper-organization"] as const) {
      const provider = opperProvider(kind);
      const first = buildProviderClient(provider, settings);
      // Scoped credentials are attempt-local, never cached across workspaces.
      expect(first).not.toBe(buildProviderClient(provider, settings));
      expect(first.maxRetries).toBe(0);
    }
  });

  test("a scoped Opper client without its key fails with an actionable error", () => {
    const settings = testSettings({});
    expect(() => buildProviderClient(opperProvider("opper-workspace", null), settings)).toThrow(
      WorkspaceOpperUnavailableError,
    );
    expect(() => buildProviderClient(opperProvider("opper-organization", null), settings)).toThrow(
      OrganizationOpperUnavailableError,
    );
  });

  test("managed Opper sends the exact pinned route to the compat Chat endpoint with a bearer key", async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (input, init) => {
      calls.push({
        url: String(input instanceof Request ? input.url : input),
        headers: new Headers(init?.headers),
        body: JSON.parse(await requestBodyText(init?.body)),
      });
      return new Response("upstream unavailable", { status: 503 });
    }) as typeof fetch;
    try {
      // A distinct key keeps this client out of the earlier test's cache entry.
      const settings = testSettings({ opperApiKey: "op-deployment-fetch" });
      const provider = configuredProviders(settings).find((candidate) => candidate.id === "opper")!;
      const client = buildProviderClient(provider, settings);
      await expect(
        (async () =>
          await client.chat.completions.create({
            model: SONNET,
            messages: [{ role: "user", content: "hello" }],
          }))(),
      ).rejects.toThrow(/503/u);
      // One request: a 503 is not blindly replayed.
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe("https://api.opper.ai/v3/compat/chat/completions");
      expect(calls[0]!.headers.get("authorization")).toBe("Bearer op-deployment-fetch");
      expect(calls[0]!.body.model).toBe(SONNET);

      await expect(
        (async () =>
          await client.chat.completions.create({
            model: "openai/gpt-unknown",
            messages: [{ role: "user", content: "hello" }],
          }))(),
      ).rejects.toThrow(/not in the reviewed catalog/u);
      expect(calls).toHaveLength(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
