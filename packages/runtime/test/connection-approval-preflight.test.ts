import { describe, expect, test } from "bun:test";
import { startTestMcpServer } from "@opengeni/testing/mcp";
import { testSettings } from "@opengeni/testing/settings";
import { prepareAgentTools, type ResolveConnectionCredentialInput } from "../src";

// A person confirms an approval-required connection tool (for example Gmail
// send from a Site) only when the current-human gateway can preflight it
// without side effects. Connection-backed servers without a provider preflight
// get one: an exact, non-refreshing, non-recording credential lookup.
describe("connection approval preflight", () => {
  async function prepare(
    preflight: boolean,
    credential: (input: ResolveConnectionCredentialInput) => "ok" | "expired",
  ) {
    const provider = startTestMcpServer();
    const lookups: ResolveConnectionCredentialInput[] = [];
    const prepared = await prepareAgentTools(
      testSettings({
        mcpServers: [
          {
            id: "docs",
            url: provider.url,
            cacheToolsList: false,
            requireApproval: ["search_documents"],
            connectionRef: { providerDomain: "127.0.0.1", kind: "api_key" },
          },
        ],
      }),
      [{ kind: "mcp", id: "docs" }],
      {
        accountId: "11111111-1111-4111-8111-111111111111",
        workspaceId: "22222222-2222-4222-8222-222222222222",
        credentialSubjectId: "human:viewer",
        ...(preflight ? { connectionApprovalPreflight: true } : {}),
        resolveCredential: async (input) => {
          lookups.push(input);
          return credential(input) === "ok"
            ? {
                status: "ok" as const,
                connectionId: "conn_1",
                headers: { authorization: "Bearer token" },
              }
            : {
                status: "auth_needed" as const,
                reason: "expired" as const,
                providerDomain: "127.0.0.1",
                connectionId: "conn_1",
              };
        },
        workspaceToolGateway: {
          requireApproval: (_entry, _caller, context) =>
            context.transportMeta?.approvalConfirmed !== true,
        },
      },
    );
    return { provider, lookups, prepared };
  }
  const prepareSearch = (prepared: Awaited<ReturnType<typeof prepare>>["prepared"]) =>
    prepared.toolGateway!.prepareCall(
      {
        operationId: "33333333-3333-4333-8333-333333333333",
        catalogDigest: prepared.toolGatewayCatalog!.digest,
        identity: { serverId: "docs", toolName: "search_documents" },
        arguments: { query: "q" },
        caller: { kind: "http", subjectId: "human:viewer" },
      },
      { transportMeta: { approvalConfirmed: true } },
    );
  const entry = (prepared: Awaited<ReturnType<typeof prepare>>["prepared"]) =>
    prepared.toolGatewayCatalog!.entries.find(
      (item) => item.identity.serverId === "docs" && item.identity.toolName === "search_documents",
    );

  test("an approval-required connection tool is listed and preflights its exact connection", async () => {
    const { provider, lookups, prepared } = await prepare(true, () => "ok");
    try {
      expect(entry(prepared)?.approval).toBe("human");
      lookups.length = 0;
      const call = await prepareSearch(prepared);
      const preflights = lookups.filter((input) => input.credentialResolutionMode === "preflight");
      expect(preflights).toHaveLength(1);
      expect(preflights[0]).toMatchObject({
        serverId: "docs",
        toolName: "search_documents",
        forceRefresh: false,
        preflightAcceptsRefreshableExpiry: true,
        subjectId: "human:viewer",
      });
      expect(provider.calls).toHaveLength(0);
      await call.execute();
      expect(provider.calls).toHaveLength(1);
    } finally {
      await prepared.close();
      provider.close();
    }
  });

  test("a connection that needs attention fails before an approval and before the provider", async () => {
    const { provider, prepared } = await prepare(true, (input) =>
      input.credentialResolutionMode === "preflight" ? "expired" : "ok",
    );
    try {
      await expect(prepareSearch(prepared)).rejects.toThrow();
      expect(provider.calls).toHaveLength(0);
    } finally {
      await prepared.close();
      provider.close();
    }
  });

  test("other callers keep the provider's own preflight (none)", async () => {
    const { provider, lookups, prepared } = await prepare(false, () => "ok");
    try {
      lookups.length = 0;
      await prepareSearch(prepared).then(
        () => undefined,
        () => undefined,
      );
      expect(lookups.filter((input) => input.credentialResolutionMode === "preflight")).toEqual([]);
    } finally {
      await prepared.close();
      provider.close();
    }
  });
});
