import { expect, test } from "bun:test";
import { testSettings } from "@opengeni/testing";
import type { McpConnectionAccountBinding } from "@opengeni/contracts";
import {
  accountRouteAuthNeededPayload,
  expandMcpAccountRoutes,
} from "../src/activities/mcp-account-routes";

const personal: McpConnectionAccountBinding = {
  serverId: "mail-account-personal",
  canonicalServerId: "mail",
  connectionId: "11111111-1111-4111-8111-111111111111",
  originWorkspaceId: "33333333-3333-4333-8333-333333333333",
  subjectScope: "subject",
  ownerSubjectId: "human:alice",
  accountLabel: "alice@example.test",
  providerDomain: "example.test",
  kind: "oauth2",
  connectionRef: {
    connectionId: "11111111-1111-4111-8111-111111111111",
    providerDomain: "example.test",
    kind: "oauth2",
    subjectScope: "subject",
  },
};
const workspace: McpConnectionAccountBinding = {
  ...personal,
  serverId: "mail-account-workspace",
  connectionId: "22222222-2222-4222-8222-222222222222",
  subjectScope: "workspace",
  ownerSubjectId: null,
  accountLabel: "Team inbox",
  connectionRef: {
    ...personal.connectionRef,
    connectionId: "22222222-2222-4222-8222-222222222222",
    subjectScope: "workspace",
  },
};
const settings = () =>
  testSettings({
    mcpServers: [
      {
        id: "mail",
        url: "https://example.test/mcp",
        requireApproval: "always",
        allowedTools: ["read", "send"],
        headers: { Authorization: "synthetic-old-account-token" },
        connectionRef: {
          connectionId: personal.connectionId,
          providerDomain: "example.test",
          kind: "oauth2",
          subjectScope: "subject",
        },
      },
    ],
  });

test("auth recovery keeps exact execution alias and adds only frozen canonical identity", () => {
  const payload = {
    serverId: personal.serverId,
    providerDomain: personal.providerDomain,
    reason: "personal_authority_unavailable" as const,
  };
  expect(accountRouteAuthNeededPayload(payload, [personal])).toEqual({
    ...payload,
    canonicalServerId: "mail",
  });
  expect(
    accountRouteAuthNeededPayload({ ...payload, serverId: "unknown" }, [personal]),
  ).not.toHaveProperty("canonicalServerId");
});

test("simultaneous routes retain canonical restrictions and distinct exact account identities", () => {
  const original = settings();
  const result = expandMcpAccountRoutes({
    settings: original,
    tools: [{ kind: "mcp", id: "mail", eager: true }],
    bindings: [personal, workspace],
  });
  expect(result.tools.map((tool) => tool.id)).toEqual([personal.serverId, workspace.serverId]);
  expect(result.tools.every((tool) => tool.eager)).toBe(true);
  expect(result.settings.mcpServers.map((server) => server.connectionRef?.connectionId)).toEqual([
    personal.connectionId,
    workspace.connectionId,
  ]);
  expect(result.settings.mcpServers.map((server) => server.connectionRef?.subjectScope)).toEqual([
    "subject",
    "workspace",
  ]);
  for (const server of result.settings.mcpServers) {
    expect(server.requireApproval).toBe("always");
    expect(server.allowedTools).toEqual(["read", "send"]);
    expect(server.headers).toBeUndefined();
  }
  expect(result.accountLabels.get(personal.serverId)).toBe("mail — Personal: alice@example.test");
  expect(result.accountLabels.get(workspace.serverId)).toBe("mail — Workspace: Team inbox");
  expect(original.mcpServers[0]?.id).toBe("mail");
});

test("empty accepted bindings remove authenticated defaults while null keeps historical behavior", () => {
  const original = settings();
  original.mcpServers.push({ id: "public", url: "https://public.test/mcp", cacheToolsList: false });
  const tools = [
    { kind: "mcp" as const, id: "mail" },
    { kind: "mcp" as const, id: "public" },
  ];
  const empty = expandMcpAccountRoutes({ settings: original, tools, bindings: [] });
  expect(empty.tools.map((tool) => tool.id)).toEqual(["public"]);
  expect(empty.settings.mcpServers.map((server) => server.id)).toEqual(["public"]);
  const legacy = expandMcpAccountRoutes({ settings: original, tools, bindings: null });
  expect(legacy.tools).toEqual(tools);
  expect(legacy.settings).toBe(original);
});

test("bindings cannot grant a connector excluded by canonical policy", () => {
  const result = expandMcpAccountRoutes({ settings: settings(), tools: [], bindings: [personal] });
  expect(result.tools).toEqual([]);
  expect(result.settings.mcpServers).toEqual([]);
});

test("duplicate aliases, canonical collisions and fabricated workspace owners fail closed", () => {
  for (const bindings of [
    [personal, { ...workspace, serverId: personal.serverId }],
    [{ ...personal, serverId: "mail" }],
    [{ ...workspace, ownerSubjectId: "human:alice" }],
    [personal, { ...personal, serverId: "another-alias" }],
  ]) {
    expect(() =>
      expandMcpAccountRoutes({
        settings: settings(),
        tools: [{ kind: "mcp", id: "mail" }],
        bindings,
      }),
    ).toThrow("Invalid accepted MCP account route");
  }
});

test("provider changes never rebind an accepted route", () => {
  expect(() =>
    expandMcpAccountRoutes({
      settings: settings(),
      tools: [{ kind: "mcp", id: "mail" }],
      bindings: [
        {
          ...personal,
          providerDomain: "other.test",
          connectionRef: { ...personal.connectionRef, providerDomain: "other.test" },
        },
      ],
    }),
  ).toThrow("does not match canonical provider");
});

test("account refs retain frozen resource restrictions without copying another account config", () => {
  const source = settings();
  source.mcpServers[0]!.connectionRef!.resource = "https://changed.example.test";
  source.mcpServers[0]!.connectionRef!.scopes = ["new.admin"];
  const frozen = {
    ...personal,
    connectionRef: {
      ...personal.connectionRef,
      scopes: ["read"],
      resource: "https://accepted.example.test",
    },
  };
  const result = expandMcpAccountRoutes({
    settings: source,
    tools: [{ kind: "mcp", id: "mail" }],
    bindings: [frozen, workspace],
  });
  expect(result.settings.mcpServers[0]?.connectionRef).toEqual(frozen.connectionRef);
  expect(result.settings.mcpServers[1]?.connectionRef).toEqual(workspace.connectionRef);
  result.settings.mcpServers[0]!.connectionRef!.scopes!.push("mutated");
  expect(frozen.connectionRef.scopes).toEqual(["read"]);
});
