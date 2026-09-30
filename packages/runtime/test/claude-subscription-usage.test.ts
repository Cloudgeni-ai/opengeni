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
