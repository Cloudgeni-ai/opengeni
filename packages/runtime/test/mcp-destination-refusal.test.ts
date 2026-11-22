import { afterEach, expect, mock, test } from "bun:test";
import { testSettings } from "@opengeni/testing/settings";
import { configureRuntimeMetricsHooks, prepareAgentTools } from "../src/index";

afterEach(() => configureRuntimeMetricsHooks(null));

test.each([
  ["https://127.0.0.1/mcp", "blocked", "private_or_special_use"],
  ["https://does-not-exist.invalid/mcp", "unresolvable", "dns_not_found"],
] as const)(
  "records a refused setup for %s without sending credentials",
  async (url, reason, diagnostic) => {
    const reportMcpDestinationRefusal = mock(async (_reason: "blocked" | "unresolvable") => true);
    const network = mock(async () => new Response("unexpected"));
    const outcomes: string[] = [];
    configureRuntimeMetricsHooks({
      onMcpLifecycle: (event) => {
        if (event.phase === "connect") outcomes.push(event.outcome);
      },
    });
    const logs = mock(() => {});
    const warn = console.warn;
    console.warn = logs;
    try {
      const prepared = await prepareAgentTools(
        testSettings({
          environment: "production",
          sandboxBackend: "none",
          mcpServers: [
            {
              id: "blocked",
              url,
              connectionRef: { providerDomain: new URL(url).hostname, kind: "api_key" },
            },
          ],
        }),
        [{ kind: "mcp", id: "blocked", optional: true }],
        {
          workspaceId: crypto.randomUUID(),
          mcpFetchImpl: network,
          resolveCredential: async () => ({
            status: "ok",
            connectionId: crypto.randomUUID(),
            headers: { Authorization: "Bearer test-only" },
            reportMcpDestinationRefusal,
          }),
        },
      );
      try {
        expect(prepared.mcpServers).toHaveLength(0);
        expect(reportMcpDestinationRefusal.mock.calls, JSON.stringify(logs.mock.calls)).toEqual([
          [reason],
        ]);
        expect(outcomes).toEqual(["refused_by_policy"]);
        expect(network).not.toHaveBeenCalled();
        expect(JSON.stringify(logs.mock.calls)).toContain(diagnostic);
        expect(JSON.stringify(logs.mock.calls)).not.toContain(url);
      } finally {
        await prepared.close();
      }
    } finally {
      console.warn = warn;
    }
  },
);
