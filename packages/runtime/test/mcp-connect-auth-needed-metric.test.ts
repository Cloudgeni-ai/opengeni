import { afterEach, expect, test } from "bun:test";
import { testSettings } from "@opengeni/testing/settings";
import { configureRuntimeMetricsHooks, prepareAgentTools } from "../src/index";

// A connect the broker refused a credential (the person already sees the
// account needs attention) is its own lifecycle outcome, so the operator alert
// on failing connections does not page for an account that is known broken.
// A server that fails with a credential is still a plain failure.

afterEach(() => configureRuntimeMetricsHooks(null));

const workspaceId = "22222222-2222-4222-8222-222222222222";

async function connectOutcomes(options: {
  resolveCredential: Parameters<typeof prepareAgentTools>[2]["resolveCredential"];
  mcpFetchImpl: Parameters<typeof prepareAgentTools>[2]["mcpFetchImpl"];
}): Promise<string[]> {
  const outcomes: string[] = [];
  configureRuntimeMetricsHooks({
    onMcpLifecycle: (event) => {
      if (event.phase === "connect") outcomes.push(`${event.policy}:${event.outcome}`);
    },
  });
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const prepared = await prepareAgentTools(
      testSettings({
        mcpServers: [
          {
            id: "acme",
            name: "Acme",
            // A public address literal: no DNS lookup, so the destination policy admits it.
            url: "https://1.1.1.1/mcp",
            connectionRef: { providerDomain: "1.1.1.1", kind: "oauth2" },
            cacheToolsList: false,
          },
        ],
      }),
      [{ kind: "mcp", id: "acme", optional: true }],
      { workspaceId, credentialSubjectId: "subject-a", ...options },
    );
    try {
      expect(prepared.mcpServers).toHaveLength(0);
    } finally {
      await prepared.close();
    }
  } finally {
    console.warn = originalWarn;
  }
  return outcomes;
}

test.each(["expired", "refresh_failed", "personal_authority_unavailable"] as const)(
  "a connect refused a credential (%s) is recorded as auth_needed",
  async (reason) => {
    const outcomes = await connectOutcomes({
      resolveCredential: async () => ({
        status: "auth_needed",
        reason,
        providerDomain: "1.1.1.1",
      }),
      mcpFetchImpl: async () => {
        throw new Error("a request without a credential must not reach the provider");
      },
    });
    expect(outcomes).toEqual(["best_effort:auth_needed"]);
  },
);

test("a server that rejects or drops a credentialed connect is still a failure", async () => {
  let reached = 0;
  for (const mcpFetchImpl of [
    async () => {
      reached += 1;
      return new Response("forbidden", { status: 403 });
    },
    async () => {
      reached += 1;
      throw Object.assign(new Error("connect timed out"), { code: "ETIMEDOUT" });
    },
  ]) {
    const outcomes = await connectOutcomes({
      resolveCredential: async () => ({
        status: "ok",
        connectionId: crypto.randomUUID(),
        headers: { Authorization: "Bearer test-only" },
      }),
      mcpFetchImpl,
    });
    expect(outcomes).toEqual(["best_effort:failed"]);
  }
  expect(reached).toBeGreaterThanOrEqual(2);
});
