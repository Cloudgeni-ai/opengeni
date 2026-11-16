import { expect, test } from "bun:test";
import type {
  CapabilityCatalogItem,
  CapabilityInstallation,
  ConnectionMetadata,
} from "@opengeni/contracts";
import { ConnectionAccountSelectionError } from "../src/domain/personal-connection-delegations";
import { applyCapabilityEnablement } from "../src/domain/capabilities";
import { settingsWithSessionMcpServerMetadata } from "../src/domain/sessions";
import {
  mcpAccountBindingsFromVisibleConnections,
  mcpAccountRouteId,
  personalDelegationsForAccountBindings,
} from "../src/domain/mcp-account-bindings";

const accountId = crypto.randomUUID();
const workspaceId = crypto.randomUUID();
const server = {
  id: "slack",
  url: "https://slack.example.test/mcp",
  cacheToolsList: false,
  connectionRef: { providerDomain: "slack.example.test", kind: "oauth2" as const },
};
function connection(subjectId: string | null = "alice"): ConnectionMetadata {
  return {
    id: crypto.randomUUID(),
    accountId,
    workspaceId,
    subjectId,
    ...(subjectId ? { authorityId: crypto.randomUUID() } : {}),
    providerDomain: "slack.example.test",
    kind: "oauth2",
    status: "active",
    grantedScopes: [],
    expiresAt: null,
    lastRefreshAt: null,
    lastUsedAt: null,
    lastError: null,
    version: 1,
    metadata: { displayName: "Alice", slackTeamName: "Example" },
    createdBySubjectId: "alice",
    updatedBySubjectId: "alice",
    createdAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z",
  };
}
const input = { accountId, workspaceId, subjectId: "alice", servers: [server] };

test("agent account labels use verified provider identity without changing exact routing", () => {
  const selected = {
    ...connection(),
    metadata: { providerEmail: "alice@example.test", slackTeamName: "Community" },
  };
  const [binding] = mcpAccountBindingsFromVisibleConnections({ ...input, connections: [selected] });
  expect(binding?.accountLabel).toBe("alice@example.test · Community · Yours");
  expect(binding?.connectionId).toBe(selected.id);
  const legacy = { ...connection(), metadata: { slackUserId: "U_ONE", slackTeamId: "T_ONE" } };
  expect(
    mcpAccountBindingsFromVisibleConnections({ ...input, connections: [legacy] })[0]?.accountLabel,
  ).toBe("slack.example.test account · Yours");
});

test("rejected pinned accounts retain safe structured identity and eligibility reason", () => {
  const selected = connection();
  for (const [servers, connections, reason] of [
    [[], [selected], "connector_unavailable"],
    [[server], [], "account_not_visible"],
    [[server], [{ ...selected, status: "revoked" }], "account_inactive"],
    [[server], [{ ...selected, providerDomain: "other.example.test" }], "account_mismatch"],
  ] as const) {
    let failure: unknown;
    try {
      mcpAccountBindingsFromVisibleConnections({
        ...input,
        servers: [...servers],
        connections: [...connections] as ConnectionMetadata[],
        selections: [{ serverId: server.id, connectionId: selected.id }],
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ConnectionAccountSelectionError);
    expect((failure as ConnectionAccountSelectionError).diagnostic).toEqual({
      version: 1,
      reason: "selected_account_unavailable",
      accounts: [{ serverId: server.id, connectionId: selected.id, reason }],
    });
  }
});

test("account selection cannot silently replace a persisted legacy session attachment", () => {
  const native = connection();
  const legacy = {
    ...server,
    headerNames: [],
    credentialVersion: 1,
    connectionRef: {
      authoritySource: "host" as const,
      hostBinding: { selection: "accepted_turn" as const },
      subjectScope: "subject" as const,
      providerDomain: server.connectionRef.providerDomain,
      kind: "delegated" as const,
    },
  };
  const projected = settingsWithSessionMcpServerMetadata(
    { mcpServers: [server] } as Parameters<typeof settingsWithSessionMcpServerMetadata>[0],
    [legacy],
  );
  expect(projected.mcpServers[0]?.connectionRef).toEqual(legacy.connectionRef);
  expect(() =>
    mcpAccountBindingsFromVisibleConnections({
      ...input,
      servers: projected.mcpServers,
      connections: [native],
      selections: [{ serverId: server.id, connectionId: native.id }],
    }),
  ).toThrow(ConnectionAccountSelectionError);
});

test("an unconnected default connector grants no account and does not block admission", () => {
  expect(mcpAccountBindingsFromVisibleConnections({ ...input, connections: [] })).toEqual([]);
  expect(personalDelegationsForAccountBindings([])).toEqual([]);
});

test("catalog projection distinguishes intentional workspace selectors from exact installation pins", () => {
  const item = {
    kind: "mcp",
    source: "manual",
    runtime: { available: true },
    metadata: {},
    authModel: null,
  } as CapabilityCatalogItem;
  const project = (connectionRef: Record<string, unknown>) =>
    applyCapabilityEnablement(item, {
      status: "active",
      config: { connectionRef },
      metadata: { mcpConnectivity: { status: "auth_deferred" } },
    } as CapabilityInstallation).connectionRef;
  const selector = { ...server.connectionRef, accountSelection: "all_eligible" };
  expect(project(selector)).toEqual(selector);
  const pinned = { ...server.connectionRef, connectionId: crypto.randomUUID() };
  expect(project(pinned)).toEqual(pinned);
});

test("workspace and two personal accounts attach with distinct exact routes", () => {
  const connections = [connection(null), connection(), connection()];
  const bindings = mcpAccountBindingsFromVisibleConnections({ ...input, connections });
  expect(bindings).toHaveLength(3);
  expect(new Set(bindings.map((binding) => binding.serverId)).size).toBe(3);
  expect(bindings.every((binding) => binding.canonicalServerId === "slack")).toBe(true);
  expect(
    bindings.find((binding) => binding.subjectScope === "workspace")?.ownerSubjectId,
  ).toBeNull();
  expect(personalDelegationsForAccountBindings(bindings)).toHaveLength(2);
  // Two personal accounts that read the same are told apart for the agent;
  // the shared one already differs by scope and keeps its plain label.
  const labels = bindings.map((binding) => binding.accountLabel);
  expect(new Set(labels).size).toBe(3);
  expect(labels).toContain("Alice · Example · Shared");
  expect(
    labels.filter((label) => label.startsWith("Alice · Example · Connected Sep 20 00:00 UTC · ")),
  ).toHaveLength(2);
});

function apiKeyConnection(
  createdAt: string,
  extra: Partial<ConnectionMetadata> = {},
): ConnectionMetadata {
  return {
    ...connection(),
    providerDomain: "mcp.example.test",
    kind: "api_key",
    metadata: { mcpUrl: "https://mcp.example.test/mcp", resource: "https://mcp.example.test/mcp" },
    createdAt,
    updatedAt: createdAt,
    ...extra,
  };
}
const apiKeyServer = {
  id: "example-mcp",
  url: "https://mcp.example.test/mcp",
  cacheToolsList: false,
  connectionRef: { providerDomain: "mcp.example.test", kind: "api_key" as const },
};

test("unnamed API-key accounts of one server read differently for the agent", () => {
  const first = apiKeyConnection("2026-10-25T09:00:00.000Z");
  const second = apiKeyConnection("2026-10-27T15:30:00.000Z");
  const labels = mcpAccountBindingsFromVisibleConnections({
    ...input,
    servers: [apiKeyServer],
    connections: [first, second],
  }).map((binding) => binding.accountLabel);
  expect(labels.sort()).toEqual([
    "mcp.example.test account · Connected Oct 25 · Yours",
    "mcp.example.test account · Connected Oct 27 · Yours",
  ]);
  // Same day: the time (UTC) tells them apart.
  const sameDay = mcpAccountBindingsFromVisibleConnections({
    ...input,
    servers: [apiKeyServer],
    connections: [first, apiKeyConnection("2026-10-25T14:05:00.000Z")],
  }).map((binding) => binding.accountLabel);
  expect(sameDay.sort()).toEqual([
    "mcp.example.test account · Connected Oct 25 09:00 UTC · Yours",
    "mcp.example.test account · Connected Oct 25 14:05 UTC · Yours",
  ]);
});

test("a person's name labels an account; a verified identity always wins over it", () => {
  const named = apiKeyConnection("2026-10-25T09:00:00.000Z", { label: "Team inbox" });
  const unnamed = apiKeyConnection("2026-10-25T09:00:00.000Z");
  const identified = {
    ...apiKeyConnection("2026-10-25T09:00:00.000Z", { label: "Team inbox" }),
    metadata: { mcpUrl: "https://mcp.example.test/mcp", email: "ops@example.test" },
  };
  const labels = mcpAccountBindingsFromVisibleConnections({
    ...input,
    servers: [apiKeyServer],
    connections: [named, unnamed, identified],
  }).map((binding) => binding.accountLabel);
  expect(labels.sort()).toEqual([
    "Team inbox · Yours",
    "mcp.example.test account · Yours",
    "ops@example.test · Yours",
  ]);
});

test("an account keeps its label when a selection narrows the turn to it", () => {
  const first = apiKeyConnection("2026-10-25T09:00:00.000Z");
  const second = apiKeyConnection("2026-10-27T15:30:00.000Z");
  const all = mcpAccountBindingsFromVisibleConnections({
    ...input,
    servers: [apiKeyServer],
    connections: [first, second],
  });
  const narrowed = mcpAccountBindingsFromVisibleConnections({
    ...input,
    servers: [apiKeyServer],
    connections: [first, second],
    selections: [{ serverId: apiKeyServer.id, connectionId: second.id }],
  });
  expect(narrowed).toHaveLength(1);
  expect(narrowed[0]?.accountLabel).toBe(
    all.find((binding) => binding.connectionId === second.id)?.accountLabel,
  );
  expect(narrowed[0]?.accountLabel).toBe("mcp.example.test account · Connected Oct 27 · Yours");
});

test("a unique unnamed account keeps exactly its previous label", () => {
  const [binding] = mcpAccountBindingsFromVisibleConnections({
    ...input,
    servers: [apiKeyServer],
    connections: [apiKeyConnection("2026-10-25T09:00:00.000Z")],
  });
  expect(binding?.accountLabel).toBe("mcp.example.test account · Yours");
});

test("intentional catalog selectors accept workspace and personal accounts and freeze exact refs", () => {
  const connections = [connection(null), connection()];
  const bindings = mcpAccountBindingsFromVisibleConnections({
    ...input,
    servers: [
      { ...server, connectionRef: { ...server.connectionRef, accountSelection: "all_eligible" } },
    ],
    connections,
  });
  expect(bindings).toHaveLength(2);
  expect(
    bindings.every(
      (binding) =>
        binding.connectionRef.connectionId === binding.connectionId &&
        binding.connectionRef.accountSelection === undefined,
    ),
  ).toBe(true);
});

test("explicit workspace-only selection excludes personal accounts", () => {
  const shared = connection(null);
  const bindings = mcpAccountBindingsFromVisibleConnections({
    ...input,
    connections: [shared, connection()],
    selections: [{ serverId: server.id, connectionId: shared.id }],
  });
  expect(bindings).toHaveLength(1);
  expect(bindings[0]?.subjectScope).toBe("workspace");
  expect(personalDelegationsForAccountBindings(bindings)).toEqual([]);
});

test("other users, organizations and workspaces cannot enter the binding set", () => {
  const connections = [
    connection("bob"),
    { ...connection(), accountId: crypto.randomUUID() },
    { ...connection(null), workspaceId: crypto.randomUUID() },
  ];
  expect(mcpAccountBindingsFromVisibleConnections({ ...input, connections })).toEqual([]);
  for (const candidate of connections) {
    expect(() =>
      mcpAccountBindingsFromVisibleConnections({
        ...input,
        connections,
        selections: [{ serverId: server.id, connectionId: candidate.id }],
      }),
    ).toThrow("unavailable");
  }
});

test("personal cross-workspace inventory requires the same authenticated owner", () => {
  const personal = { ...connection(), workspaceId: crypto.randomUUID() };
  expect(
    mcpAccountBindingsFromVisibleConnections({ ...input, connections: [personal] }),
  ).toHaveLength(1);
  expect(
    mcpAccountBindingsFromVisibleConnections({
      ...input,
      subjectId: null,
      connections: [personal],
    }),
  ).toEqual([]);
});

test("missing selected account never falls back to another eligible account", () => {
  expect(() =>
    mcpAccountBindingsFromVisibleConnections({
      ...input,
      connections: [connection()],
      selections: [{ serverId: server.id, connectionId: crypto.randomUUID() }],
    }),
  ).toThrow(ConnectionAccountSelectionError);
});

test("explicit connection refs remain exact without selectedResources or account choices", () => {
  const pinned = connection(null);
  const other = connection();
  const exact = {
    ...input,
    servers: [{ ...server, connectionRef: { ...server.connectionRef, connectionId: pinned.id } }],
  };
  expect(
    mcpAccountBindingsFromVisibleConnections({ ...exact, connections: [pinned, other] }).map(
      (binding) => binding.connectionId,
    ),
  ).toEqual([pinned.id]);
  expect(() =>
    mcpAccountBindingsFromVisibleConnections({
      ...exact,
      connections: [pinned, other],
      selections: [{ serverId: server.id, connectionId: other.id }],
    }),
  ).toThrow(ConnectionAccountSelectionError);
  expect(mcpAccountBindingsFromVisibleConnections({ ...exact, connections: [other] })).toEqual([]);
});

test("no selection always resolves the current accounts, including ones added later", () => {
  const later = connection();
  expect(
    mcpAccountBindingsFromVisibleConnections({ ...input, connections: [], selections: [] }),
  ).toEqual([]);
  expect(
    mcpAccountBindingsFromVisibleConnections({ ...input, connections: [later], selections: [] }),
  ).toHaveLength(1);
});

test("a pin narrows only its own connector and a revoked pin fails with the shared typed error", () => {
  const selected = connection();
  const newer = connection();
  const pinned = {
    ...input,
    servers: [server, { ...server, id: "other" }],
    selections: [{ serverId: server.id, connectionId: selected.id }],
  };
  const bindings = mcpAccountBindingsFromVisibleConnections({
    ...pinned,
    connections: [selected, newer],
  });
  expect(
    bindings
      .filter((binding) => binding.canonicalServerId === server.id)
      .map((binding) => binding.connectionId),
  ).toEqual([selected.id]);
  expect(
    bindings
      .filter((binding) => binding.canonicalServerId === "other")
      .map((binding) => binding.connectionId)
      .sort(),
  ).toEqual([selected.id, newer.id].sort());
  expect(() =>
    mcpAccountBindingsFromVisibleConnections({
      ...pinned,
      connections: [{ ...selected, status: "revoked" }, newer],
    }),
  ).toThrow(ConnectionAccountSelectionError);
});

test("resource constraints are enforced before attaching accounts", () => {
  const resource = "https://slack.example.test/team/one";
  const matching = { ...connection(), metadata: { resource: `${resource}/` } };
  const other = { ...connection(), metadata: { resource: "https://slack.example.test/team/two" } };
  const bindings = mcpAccountBindingsFromVisibleConnections({
    ...input,
    servers: [{ ...server, connectionRef: { ...server.connectionRef, resource } }],
    connections: [matching, other, connection()],
  });
  expect(bindings).toHaveLength(1);
  expect(bindings[0]?.connectionId).toBe(matching.id);
});

test("route identity is stable, bounded and distinguishes connector surfaces", () => {
  const id = crypto.randomUUID();
  expect(mcpAccountRouteId("slack", id)).toBe(mcpAccountRouteId("slack", id));
  expect(mcpAccountRouteId("slack", id)).not.toBe(mcpAccountRouteId("mail", id));
  expect(mcpAccountRouteId("x".repeat(256), id).length).toBeLessThan(256);
});
