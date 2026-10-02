import { expect, test } from "bun:test";
import { withClaudeModelRequest, withClaudeUsageObserver } from "../src/claude-subscription-usage";
import { instrumentedModelFetch } from "../src/model-provider-client";
import { AnthropicMessagesModel } from "../src/anthropic-messages";
import type { ResolvedModelProvider } from "@opengeni/config";

test("usage observer sees success and 429 headers without consuming responses", async () => {
  for (const status of [200, 429]) {
    const calls: Array<[string, number, string | null]> = [];
    const fetcher = instrumentedModelFetch(
      "workspace-claude-subscription",
      (async () =>
        new Response("body", {
          status,
          headers: { "anthropic-ratelimit-unified-5h-utilization": "1" },
        })) as typeof fetch,
    );
    const response = await withClaudeUsageObserver(
      (id, observed) => {
        calls.push([
          id,
          observed.status,
          observed.headers.get("anthropic-ratelimit-unified-5h-utilization"),
        ]);
      },
      () => fetcher("https://api.anthropic.com/v1/messages", { method: "POST", body: "{}" }),
    );
    expect(calls).toEqual([["workspace-claude-subscription", status, "1"]]);
    expect(await response.text()).toBe("body");
  }
});
test("concurrent contexts remain separate and observer failures cannot fail model calls", async () => {
  const seen: string[] = [];
  const fetcher = instrumentedModelFetch(
    "claude",
    (async () => new Response("ok")) as typeof fetch,
  );
  await Promise.all([
    withClaudeUsageObserver(
      () => {
        seen.push("one");
        throw new Error("telemetry failed");
      },
      async () => {
        await Promise.resolve();
        expect(
          await (await fetcher("https://api.anthropic.com/v1/messages", { method: "POST" })).text(),
        ).toBe("ok");
      },
    ),
    withClaudeUsageObserver(
      () => {
        seen.push("two");
      },
      () => fetcher("https://api.anthropic.com/v1/messages", { method: "POST" }),
    ),
  ]);
  expect(seen.toSorted()).toEqual(["one", "two"]);
  await fetcher("https://api.anthropic.com/v1/messages", { method: "POST" });
  expect(seen).toHaveLength(2);
});

test("each physical Claude request renews authentication without changing body or request headers", async () => {
  const outgoing: Request[] = [];
  const observedTokens: (string | null | undefined)[] = [];
  const fetcher = instrumentedModelFetch("claude", (async (input, init) => {
    outgoing.push(new Request(input, init));
    return new Response("ok");
  }) as typeof fetch);
  let prepares = 0;
  await withClaudeUsageObserver(
    (_provider, _response, _model, requestToken) => {
      observedTokens.push(requestToken);
    },
    async () => {
      for (const body of ['{"kind":"main"}', '{"kind":"title"}', '{"kind":"compaction"}']) {
        await fetcher(
          new Request("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
              authorization: "Bearer old",
              "content-type": "application/json",
              "anthropic-version": "2023-06-01",
            },
            body,
          }),
          { headers: { "anthropic-beta": "oauth-2025-04-20" } },
        );
      }
      await fetcher("https://api.anthropic.com/api/oauth/usage");
    },
    async (id, headers) => {
      expect(id).toBe("claude");
      headers.set("authorization", "Bearer renewed-" + ++prepares);
      return headers;
    },
  );
  expect(prepares).toBe(3);
  expect(observedTokens).toEqual(["renewed-1", "renewed-2", "renewed-3"]);
  for (const [i, request] of outgoing.slice(0, 3).entries()) {
    expect(request.headers.get("authorization")).toBe("Bearer renewed-" + (i + 1));
    expect(request.headers.get("content-type")).toBe("application/json");
    expect(request.headers.get("anthropic-version")).toBe("2023-06-01");
    expect(request.headers.get("anthropic-beta")).toBe("oauth-2025-04-20");
    expect(await request.json()).toEqual({
      kind: ["main", "title", "compaction"][i],
    });
  }
  expect(outgoing[3]!.headers.has("authorization")).toBe(false);
});

test("response token capture follows Fetch header replacement without a prepare callback", async () => {
  const wire: (string | null)[] = [];
  const observed: (string | null | undefined)[] = [];
  const fetcher = instrumentedModelFetch("claude", (async (input, init) => {
    wire.push(new Request(input, init).headers.get("authorization"));
    return new Response("ok");
  }) as typeof fetch);
  await withClaudeUsageObserver(
    (_provider, _response, _model, token) => {
      observed.push(token);
    },
    async () => {
      for (const headers of [
        undefined,
        { "x-example": "override" },
        { authorization: "Bearer replaced" },
      ]) {
        await fetcher(
          new Request("https://example.test/v1/messages", {
            method: "POST",
            headers: { authorization: "Bearer original" },
            body: "{}",
          }),
          { headers },
        );
      }
    },
  );
  expect(wire).toEqual(["Bearer original", null, "Bearer replaced"]);
  expect(observed).toEqual(["original", null, "replaced"]);
});

test("failed authentication renewal never dispatches a model request", async () => {
  let dispatched = false;
  const fetcher = instrumentedModelFetch("claude", (async () => {
    dispatched = true;
    return new Response("bad");
  }) as typeof fetch);
  await expect(
    withClaudeUsageObserver(
      () => {},
      () =>
        fetcher("https://api.anthropic.com/v1/messages", {
          method: "POST",
          body: "{}",
        }),
      async () => {
        throw new Error("Sign in again");
      },
    ),
  ).rejects.toThrow("Sign in again");
  expect(dispatched).toBe(false);
});

test("reordered responses keep the account receipt prepared with their dispatched authentication", async () => {
  let account = "fixture-account-a";
  let finishA!: (response: Response) => void;
  let startedA!: () => void;
  const started = new Promise<void>((resolve) => {
    startedA = resolve;
  });
  const seen: Array<[string, string | undefined, string | null | undefined, number]> = [];
  const fetcher = instrumentedModelFetch("claude", (async (_input, init) => {
    if (new Headers(init?.headers).get("authorization") === "Bearer fixture-account-a") {
      startedA();
      return new Promise<Response>((resolve) => {
        finishA = resolve;
      });
    }
    return new Response("account-b", { status: 200 });
  }) as typeof fetch);
  await withClaudeUsageObserver(
    () => {
      throw new Error("A prepared receipt must replace the mutable observer");
    },
    async () => {
      const a = withClaudeModelRequest("fixture-opus", () =>
        fetcher("https://example.test/v1/messages", { method: "POST", body: "{}" }),
      );
      await started;
      account = "fixture-account-b";
      const b = await withClaudeModelRequest("fixture-sonnet", () =>
        fetcher("https://example.test/v1/messages", { method: "POST", body: "{}" }),
      );
      finishA(new Response("account-a", { status: 429 }));
      expect(await (await a).text()).toBe("account-a");
      expect(await b.text()).toBe("account-b");
    },
    async (_provider, headers) => {
      const dispatchedAccount = account;
      headers.set("authorization", `Bearer ${dispatchedAccount}`);
      return {
        headers,
        observe: (_provider, response, model, token) => {
          seen.push([dispatchedAccount, model, token, response.status]);
        },
      };
    },
  );
  expect(seen).toEqual([
    ["fixture-account-b", "fixture-sonnet", "fixture-account-b", 200],
    ["fixture-account-a", "fixture-opus", "fixture-account-a", 429],
  ]);
});

test("native concurrent model requests bind quota observations to their exact upstream model", async () => {
  const seen: string[] = [];
  const provider = {
    id: "claude",
    api: "anthropic-messages",
    apiKey: "synthetic-key",
    baseUrl: "https://example.test/v1",
    kind: "api-key",
  } as ResolvedModelProvider;
  const fetcher = instrumentedModelFetch(provider.id, (async () => {
    await Promise.resolve();
    return Response.json({
      id: "msg_fixture",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "fixture" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  }) as typeof fetch);
  const request = {
    input: "Fixture",
    modelSettings: {},
    tools: [],
    handoffs: [],
    outputType: "text",
    tracing: false,
  } as const;
  await withClaudeUsageObserver(
    (_, __, model) => {
      seen.push(model!);
    },
    () =>
      Promise.all([
        new AnthropicMessagesModel(provider, "claude-opus-5-5", fetcher).getResponse({
          ...request,
          tools: [],
          handoffs: [],
        }),
        new AnthropicMessagesModel(provider, "claude-sonnet-5-5", fetcher).getResponse({
          ...request,
          tools: [],
          handoffs: [],
        }),
      ]),
  );
  expect(seen.toSorted()).toEqual(["claude-opus-5-5", "claude-sonnet-5-5"]);
});
