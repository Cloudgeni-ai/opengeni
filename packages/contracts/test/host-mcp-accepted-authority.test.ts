import { expect, test } from "bun:test";
import { HostMcpAcceptedAuthority } from "../src/host-mcp-bindings";

function snapshot(): HostMcpAcceptedAuthority {
  return {
    version: 1,
    accountId: crypto.randomUUID(),
    workspaceId: crypto.randomUUID(),
    targetSessionId: crypto.randomUUID(),
    targetSessionVisibility: "user_private",
    targetSessionAuthorityEpoch: 1,
    acceptedWork: { kind: "turn", turnId: crypto.randomUUID() },
    bindingId: crypto.randomUUID(),
    bindingGeneration: 1,
    definition: {
      serverId: "host",
      destinationUrl: "https://tools.example/mcp",
      connectionRef: {
        authoritySource: "host",
        connectionId: "opaque-host-account",
        providerDomain: "tools.example",
      },
    },
    ownerSubjectId: `external_user:${crypto.randomUUID()}`,
    ownerOrganizationMembershipId: crypto.randomUUID(),
    ownerMembershipAuthorizationRevision: 1,
    delegationId: crypto.randomUUID(),
    delegationGeneration: 1,
    source: { kind: "direct" },
  };
}

test("accepted host authority retains causal ownership independently of a scheduled initiator", () => {
  const value = snapshot();
  expect(HostMcpAcceptedAuthority.parse(value)).toEqual(value);
  value.acceptedWork = {
    kind: "scheduled_task",
    taskId: crypto.randomUUID(),
    taskAuthorityRevision: 2,
    runId: crypto.randomUUID(),
  };
  value.source = {
    kind: "inherited_turn",
    sessionId: crypto.randomUUID(),
    turnId: crypto.randomUUID(),
  };
  expect(HostMcpAcceptedAuthority.parse(value)).toEqual(value);
  expect(
    HostMcpAcceptedAuthority.safeParse({ ...value, authenticatingApiKeyId: crypto.randomUUID() })
      .success,
  ).toBe(false);
  expect(
    HostMcpAcceptedAuthority.safeParse({ ...value, creatorSubjectId: "scheduler" }).success,
  ).toBe(false);
});

test("accepted host authority rejects missing epochs, loose inheritance, and credentials", () => {
  for (const field of [
    "ownerOrganizationMembershipId",
    "ownerMembershipAuthorizationRevision",
    "delegationId",
    "delegationGeneration",
    "targetSessionAuthorityEpoch",
    "bindingGeneration",
  ] as const) {
    const value = { ...snapshot() } as Record<string, unknown>;
    delete value[field];
    expect(HostMcpAcceptedAuthority.safeParse(value).success).toBe(false);
  }
  for (const source of [
    { kind: "creator" },
    { kind: "inherited_turn", sessionId: crypto.randomUUID() },
    { kind: "direct", subjectId: "other" },
  ]) {
    expect(HostMcpAcceptedAuthority.safeParse({ ...snapshot(), source }).success).toBe(false);
  }
  const value = snapshot();
  expect(
    HostMcpAcceptedAuthority.safeParse({
      ...value,
      source: {
        kind: "inherited_turn",
        sessionId: value.targetSessionId,
        turnId: (value.acceptedWork as { turnId: string }).turnId,
      },
    }).success,
  ).toBe(false);
  expect(
    HostMcpAcceptedAuthority.safeParse({
      ...value,
      delegationGeneration: Number.MAX_SAFE_INTEGER + 1,
    }).success,
  ).toBe(false);
  expect(
    HostMcpAcceptedAuthority.safeParse({
      ...value,
      definition: { ...value.definition, headers: { Authorization: "secret" } },
    }).success,
  ).toBe(false);
});
