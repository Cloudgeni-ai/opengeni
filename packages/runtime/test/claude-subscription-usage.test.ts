import { expect, test } from "bun:test";
import { withClaudeUsageObserver } from "../src/claude-subscription-usage";
import { instrumentedModelFetch } from "../src/model-provider-client";

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
  const fetcher = instrumentedModelFetch("claude", (async (input, init) => {
    outgoing.push(new Request(input, init));
    return new Response("ok");
  }) as typeof fetch);
  let prepares = 0;
  await withClaudeUsageObserver(
    () => {},
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
