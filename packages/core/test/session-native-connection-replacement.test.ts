import { expect, test } from "bun:test";
import type { ConnectionMetadata, McpServerConnectionRef } from "@opengeni/contracts";
import { nativeSessionConnectionReplacement } from "../src/domain/session-native-connection-replacement";

const accountId = crypto.randomUUID();
const workspaceId = crypto.randomUUID();
const native = {
  id: crypto.randomUUID(),
  accountId,
  workspaceId,
  subjectId: "alice",
  authorityId: crypto.randomUUID(),
  providerDomain: "tools.example.test",
  kind: "oauth2",
  status: "active",
  grantedScopes: ["read", "write"],
  metadata: { mcpUrl: "https://tools.example.test/mcp", resource: "https://tools.example.test" },
} as ConnectionMetadata;
const legacy: McpServerConnectionRef = {
  authoritySource: "host",
  hostBinding: { selection: "accepted_turn" },
  subjectScope: "subject",
  providerDomain: "tools.example.test",
  kind: "delegated",
  scopes: ["read"],
  resource: "https://tools.example.test",
};
const input = {
  accountId,
  workspaceId,
  subjectId: "alice",
  serverUrl: "https://tools.example.test/mcp",
  currentRef: legacy,
  nativeConnectionId: native.id,
  connections: [native],
};

test("replacement derives an exact native reference and preserves existing restrictions", () => {
  expect(nativeSessionConnectionReplacement(input)).toEqual({
    connectionId: native.id,
    providerDomain: native.providerDomain,
    kind: "oauth2",
    subjectScope: "subject",
    scopes: ["read"],
    resource: legacy.resource,
  });
  expect(legacy.authoritySource).toBe("host");
  const selectedResources = [{ kind: "repository" as const, id: "exact-repository" }];
  expect(
    nativeSessionConnectionReplacement({
      ...input,
      currentRef: { ...legacy, selectedResources },
    }).selectedResources,
  ).toEqual(selectedResources);
});

test("unavailable, foreign and unauthenticated accounts cannot be selected", () => {
  for (const candidate of [
    { ...native, subjectId: "bob" },
    { ...native, accountId: crypto.randomUUID() },
    { ...native, status: "revoked" },
    { ...native, authorityId: undefined },
    { ...native, subjectId: null, workspaceId: crypto.randomUUID() },
  ]) {
    expect(() =>
      nativeSessionConnectionReplacement({
        ...input,
        connections: [candidate as ConnectionMetadata],
      }),
    ).toThrow();
  }
  expect(() => nativeSessionConnectionReplacement({ ...input, subjectId: null })).toThrow();
  expect(() => nativeSessionConnectionReplacement({ ...input, connections: [] })).toThrow();
});

test("native account destination and existing resource restrictions are not widened", () => {
  for (const candidate of [
    { ...native, providerDomain: "other.example.test" },
    { ...native, metadata: { ...native.metadata, mcpUrl: "https://tools.example.test/other" } },
    { ...native, metadata: { ...native.metadata, resource: "https://other.example.test" } },
    { ...native, grantedScopes: [] },
  ]) {
    expect(() =>
      nativeSessionConnectionReplacement({ ...input, connections: [candidate] }),
    ).toThrow();
  }
});

test("workspace accounts remain ownerless and personal accounts require the exact authenticated owner", () => {
  expect(
    nativeSessionConnectionReplacement({
      ...input,
      subjectId: null,
      currentRef: null,
      connections: [{ ...native, subjectId: null }],
    }).subjectScope,
  ).toBe("workspace");
  expect(
    nativeSessionConnectionReplacement({
      ...input,
      connections: [{ ...native, workspaceId: crypto.randomUUID() }],
    }).connectionId,
  ).toBe(native.id);
});
