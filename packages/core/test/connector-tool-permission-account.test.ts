import { expect, test } from "bun:test";
import { type ConnectionMetadata, McpServerConnectionRef } from "@opengeni/contracts";
import {
  unpinnedConnectorToolPermissionAccount,
  connectorToolPermissionReference,
} from "../src/domain/connector-tool-permissions";

const ref: McpServerConnectionRef = {
  providerDomain: "service.example.test",
  kind: "oauth2",
  accountSelection: "all_eligible",
};
function connection(subjectId: string | null = null): ConnectionMetadata {
  return {
    id: crypto.randomUUID(),
    accountId: crypto.randomUUID(),
    workspaceId: crypto.randomUUID(),
    providerDomain: ref.providerDomain,
    kind: "oauth2",
    status: "active",
    subjectId,
    grantedScopes: [],
    expiresAt: null,
    lastRefreshAt: null,
    lastUsedAt: null,
    lastError: null,
    version: 1,
    metadata: {},
    createdBySubjectId: null,
    updatedBySubjectId: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

test("discovery pins the selected account with a valid exact credential reference", () => {
  const selected = connection();
  const pinned = connectorToolPermissionReference(ref, selected.id);
  expect(McpServerConnectionRef.parse(pinned)).toMatchObject({
    connectionId: selected.id,
    providerDomain: ref.providerDomain,
    kind: "oauth2",
  });
  expect(pinned.accountSelection).toBeUndefined();
  expect(ref.accountSelection).toBe("all_eligible");
});

test("workspace selector uses its sole active shared account, excluding personal and unrelated rows", () => {
  const shared = connection();
  expect(
    unpinnedConnectorToolPermissionAccount(
      ref,
      [
        connection("alice"),
        shared,
        connection("bob"),
        { ...connection(), providerDomain: "other.example.test" },
        { ...connection(), kind: "api_key" },
        { ...connection(), status: "disabled" },
      ],
      "alice",
    ),
  ).toBe(shared);
  expect(unpinnedConnectorToolPermissionAccount(ref, [connection("alice")], "alice")).toBeNull();
});

test("personal selector never resolves another actor or a shared account", () => {
  const personal = connection("alice");
  const personalRef = { ...ref, subjectScope: "subject" as const };
  expect(
    unpinnedConnectorToolPermissionAccount(
      personalRef,
      [connection(), connection("bob"), personal],
      "alice",
    ),
  ).toBe(personal);
  expect(unpinnedConnectorToolPermissionAccount(personalRef, [personal], "bob")).toBeNull();
});

test("ambiguous selector refuses to pick an account for approval changes", () => {
  expect(() =>
    unpinnedConnectorToolPermissionAccount(ref, [connection(), connection()], "alice"),
  ).toThrow("Choose one account");
  expect(() =>
    unpinnedConnectorToolPermissionAccount(
      { ...ref, subjectScope: "subject" },
      [connection("alice"), connection("alice")],
      "alice",
    ),
  ).toThrow("Choose one account");
});
