import { expect, test } from "bun:test";
import { McpServerConnectionRef } from "../src";
import { HostMcpBindingDefinition, hostMcpBindingMatchesSelection } from "../src/host-mcp-bindings";

const ceiling = {
  serverId: "host-tools",
  destinationUrl: "https://tools.example/mcp",
  connectionRef: {
    authoritySource: "host" as const,
    providerDomain: "tools.example",
    provider: "example",
    kind: "delegated" as const,
    subjectScope: "subject" as const,
    scopes: ["read"],
    selectedResources: [{ kind: "repository" as const, id: "repo" }],
    hostBinding: { selection: "accepted_turn" as const },
  },
};
const binding = (connectionId: string) => ({
  id: crypto.randomUUID(),
  generation: 1,
  definition: {
    ...ceiling,
    connectionRef: { ...ceiling.connectionRef, connectionId, hostBinding: undefined },
  },
});

test("explicit accepted-turn descriptor permits only account choice within the exact ceiling", () => {
  expect(McpServerConnectionRef.safeParse(ceiling.connectionRef).success).toBe(true);
  expect(HostMcpBindingDefinition.safeParse(ceiling).success).toBe(false);
  for (const account of ["account-a", "account-b"]) {
    const candidate = binding(account);
    expect(hostMcpBindingMatchesSelection(candidate, ceiling)).toBe(true);
    for (const delta of [
      { provider: "other" },
      { providerDomain: "other.example" },
      { scopes: ["write"] },
      { resource: "other" },
      { selectedResources: [{ kind: "repository" as const, id: "other" }] },
      { subjectScope: "workspace" as const },
      { kind: "api_key" as const },
    ]) {
      expect(
        hostMcpBindingMatchesSelection(
          {
            ...candidate,
            definition: {
              ...candidate.definition,
              connectionRef: { ...candidate.definition.connectionRef, ...delta },
            },
          },
          ceiling,
        ),
      ).toBe(false);
    }
    expect(
      hostMcpBindingMatchesSelection(candidate, {
        ...ceiling,
        destinationUrl: "https://tools.example/other",
      }),
    ).toBe(false);
    expect(hostMcpBindingMatchesSelection(candidate, { ...ceiling, serverId: "other" })).toBe(
      false,
    );
  }
});

test("fixed binding stays exact and accepted-turn configuration cannot carry a creator account", () => {
  const candidate = binding("a");
  const fixed = {
    ...ceiling,
    connectionRef: {
      ...candidate.definition.connectionRef,
      hostBinding: { bindingId: candidate.id, generation: candidate.generation },
    },
  };
  expect(hostMcpBindingMatchesSelection(candidate, fixed)).toBe(true);
  expect(hostMcpBindingMatchesSelection(binding("a"), fixed)).toBe(false);
  for (const delta of [
    { connectionId: "creator" },
    { subjectScope: "workspace" },
    { authoritySource: undefined },
  ])
    expect(McpServerConnectionRef.safeParse({ ...ceiling.connectionRef, ...delta }).success).toBe(
      false,
    );
});
