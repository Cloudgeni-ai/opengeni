import { expect, test } from "bun:test";
import type { McpCredentialsRequest } from "@opengeni/contracts";
import { HostMcpBinding } from "@opengeni/contracts/host-mcp-bindings";
import { hostMcpBindingMatchesRequest } from "../src/host-mcp-binding-match";

const binding: HostMcpBinding = {
  id: "ac94f59b-5a1e-4c56-a733-e5133b525b12",
  accountId: "fc94f59b-5a1e-4c56-a733-e5133b525b12",
  workspaceId: "bc94f59b-5a1e-4c56-a733-e5133b525b12",
  ownerSubjectId: "external_user:dc94f59b-5a1e-4c56-a733-e5133b525b12",
  authorizationRevision: 1,
  generation: 1,
  status: "active",
  definition: {
    serverId: "host",
    destinationUrl: "https://mcp.example/tools",
    connectionRef: {
      authoritySource: "host",
      connectionId: "opaque-account",
      providerDomain: "mcp.example",
      scopes: ["read"],
    },
  },
  createdAt: "2026-09-07T00:00:00Z",
  revokedAt: null,
};
function request(): McpCredentialsRequest {
  return {
    ...structuredClone(binding.definition),
    accountId: binding.accountId,
    workspaceId: binding.workspaceId,
    sessionId: "session",
    rootSessionId: "root",
    turnId: "turn",
    attemptId: "attempt",
    executionGeneration: 1,
    initiator: { kind: "service", subjectId: "scheduler" },
    initiatorContext: {},
    surface: "model",
    credentialTarget: "mcp",
    forceRefresh: false,
    connectionRef: {
      ...structuredClone(binding.definition.connectionRef),
      hostBinding: { bindingId: binding.id, generation: 1 },
    },
  };
}

test("binding match canonicalizes HTTPS but does not infer authority from the initiator", () => {
  const input = request();
  input.destinationUrl = "https://MCP.example:443/tools";
  expect(hostMcpBindingMatchesRequest(binding, input)).toBe(true);
  input.initiator = { kind: "subject", subjectId: "unrelated" };
  // Both are metadata matches, not accepted execution grants.
  expect(hostMcpBindingMatchesRequest(binding, input)).toBe(true);
});

test("binding match denies changes to immutable request selection", () => {
  expect(HostMcpBinding.safeParse(binding).success).toBe(true);
  expect(hostMcpBindingMatchesRequest(binding, request())).toBe(true);
  const changes: Array<(input: McpCredentialsRequest) => void> = [
    (input) => {
      input.accountId = crypto.randomUUID();
    },
    (input) => {
      input.workspaceId = crypto.randomUUID();
    },
    (input) => {
      input.serverId = "other";
    },
    (input) => {
      input.destinationUrl += "?account=other";
    },
    (input) => {
      input.destinationUrl += "/other";
    },
    (input) => {
      input.destinationUrl += "#fragment";
    },
    (input) => {
      input.destinationUrl = "http://mcp.example/tools";
    },
    (input) => {
      input.credentialTarget = "http_api";
    },
    (input) => {
      input.connectionRef.connectionId = "other";
    },
    (input) => {
      input.connectionRef.scopes = ["read", "write"];
    },
    (input) => {
      input.connectionRef.resource = "other";
    },
    (input) => {
      input.connectionRef.hostBinding!.generation++;
    },
    (input) => {
      input.connectionRef.hostBinding!.bindingId = crypto.randomUUID();
    },
    (input) => {
      delete input.connectionRef.hostBinding;
    },
  ];
  for (const change of changes) {
    const input = request();
    change(input);
    expect(hostMcpBindingMatchesRequest(binding, input)).toBe(false);
  }
});

test("binding match rejects revoked and malformed registry metadata", () => {
  for (const changed of [
    { ...binding, status: "revoked" },
    { ...binding, revokedAt: binding.createdAt },
    { ...binding, generation: 2 },
    { ...binding, authorizationRevision: 0 },
    { ...binding, definition: { ...binding.definition, headers: { authorization: "synthetic" } } },
  ])
    expect(hostMcpBindingMatchesRequest(changed, request())).toBe(false);
});
