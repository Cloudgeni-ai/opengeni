import { expect, test } from "bun:test";
import type { ConnectionUseAttribution } from "@opengeni/contracts/connection-authority";
import type { HostMcpAcceptedAuthority } from "@opengeni/contracts/host-mcp-bindings";
import { mcpOperationAuthorityDigest } from "../src/activities/mcp-operation-authority";
import type { ResolveConnectionCredentialInput } from "@opengeni/db";

const request: ResolveConnectionCredentialInput = {
  workspaceId: "workspace",
  serverId: "server",
  destinationUrl: "https://example.test/mcp",
  connectionRef: {
    providerDomain: "example.test",
    scopes: ["write", "read"],
    selectedResources: [{ kind: "repository", id: "1" }],
  },
};
const native = {
  organizationId: "org",
  workspaceId: "workspace",
  sessionId: "session",
  connectionId: "connection",
  connectionGeneration: 1,
  scope: "user",
  ownerSubjectId: "owner",
  authorityId: "accepted-authority",
  grantId: "grant",
} as ConnectionUseAttribution;
const host = {
  version: 1,
  accountId: "org",
  workspaceId: "workspace",
  targetSessionId: "session",
  targetSessionVisibility: "shared",
  targetSessionAuthorityEpoch: 1,
  ownerSubjectId: "owner",
  ownerOrganizationMembershipId: "membership",
  ownerMembershipAuthorizationRevision: 1,
  bindingId: "binding",
  bindingGeneration: 1,
  delegationId: "delegation",
  delegationGeneration: 1,
  definition: { serverId: "server", destinationUrl: "https://example.test/mcp" },
  source: { kind: "direct" },
  acceptedWork: { kind: "turn", turnId: "turn-1" },
} as unknown as HostMcpAcceptedAuthority;

test("native authority is stable across observers, retries and secret rotation; exact selection is bound", () => {
  const digest = mcpOperationAuthorityDigest(request, { native });
  expect(digest).toMatch(/^[a-f0-9]{64}$/);
  expect(
    mcpOperationAuthorityDigest(
      { ...request, toolName: "observer", forceRefresh: true },
      { native },
    ),
  ).toBe(digest);
  for (const change of [
    { ownerSubjectId: "other" },
    { connectionGeneration: 2 },
    { grantId: "other" },
    { authorityId: "other" },
    { connectionId: "other" },
  ]) {
    expect(mcpOperationAuthorityDigest(request, { native: { ...native, ...change } })).not.toBe(
      digest,
    );
  }
  for (const change of [
    { destinationUrl: "https://other.test/mcp" },
    { serverId: "other" },
    { connectionRef: { ...request.connectionRef, scopes: ["read"] } },
    {
      connectionRef: {
        ...request.connectionRef,
        selectedResources: [{ kind: "repository" as const, id: "2" }],
      },
    },
  ]) {
    expect(mcpOperationAuthorityDigest({ ...request, ...change }, { native })).not.toBe(digest);
  }
  expect(
    mcpOperationAuthorityDigest(
      { ...request, connectionRef: { ...request.connectionRef, scopes: ["read", "write"] } },
      { native },
    ),
  ).toBe(digest);
});

test("host authority binds durable revisions, not accepted turn provenance", () => {
  const digest = mcpOperationAuthorityDigest(request, { host });
  expect(
    mcpOperationAuthorityDigest(request, {
      host: {
        ...host,
        acceptedWork: { kind: "turn", turnId: "turn-2" },
        source: { kind: "inherited_turn", sessionId: "session", turnId: "turn-1" },
      },
    }),
  ).toBe(digest);
  for (const change of [
    { ownerSubjectId: "other" },
    { targetSessionAuthorityEpoch: 2 },
    { ownerMembershipAuthorizationRevision: 2 },
    { bindingGeneration: 2 },
    { delegationGeneration: 2 },
    { delegationId: "other" },
  ]) {
    expect(mcpOperationAuthorityDigest(request, { host: { ...host, ...change } })).not.toBe(digest);
  }
});

test("workspace connection authority also distinguishes the accepted principal, never credentials", () => {
  const principal = { kind: "subject", subjectId: "human-1" };
  const digest = mcpOperationAuthorityDigest(request, { native, principal });
  expect(
    mcpOperationAuthorityDigest(request, {
      native,
      principal: { ...principal, subjectId: "human-2" },
    }),
  ).not.toBe(digest);
  const noisyRequest = {
    ...request,
    requestId: "new-request",
    attemptId: "new-attempt",
    connectionVersion: 99,
    get headers(): never {
      throw new Error("must not read credential headers");
    },
  };
  expect(mcpOperationAuthorityDigest(noisyRequest, { native, principal })).toBe(digest);
});
