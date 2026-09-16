import { expect, mock, test } from "bun:test";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import type { CapabilityCatalogItem, ConnectionMetadata, Session } from "@opengeni/sdk";
import {
  selectedConnectionAccounts,
  sessionConnectionAccounts,
} from "./session-connection-accounts";

const item = {
  name: "Example Mail",
  enabled: true,
  connectionRef: { subjectScope: "subject", providerDomain: "example.com", kind: "api_key" },
  runtime: { mcpServerId: "example" },
} as CapabilityCatalogItem;
const account = {
  id: "connection",
  subjectId: "owner",
  status: "active",
  authorityId: "authority",
  providerDomain: "example.com",
  kind: "api_key",
};
function harness(accounts: unknown[] = [account]) {
  const issueUserResourceGrant = mock(async () => {
    throw new Error("Consent grants are retired");
  });
  const listUserResourceAuthorities = mock(async () => {
    throw new Error("Consent grants are retired");
  });
  const client = {
    listOwnConnectionAccounts: async () => accounts,
    issueUserResourceGrant,
    listUserResourceAuthorities,
  } as unknown as OpenGeniBrowserClient;
  return { client, issueUserResourceGrant, listUserResourceAuthorities };
}

test("connected accounts work without private conversation activation or consent APIs", async () => {
  const h = harness();
  const session = { id: "session", workspaceId: "workspace" } as Session;
  expect(await sessionConnectionAccounts(h.client, session, [item])).toEqual([
    { serverId: "example", connectionId: "connection" },
  ]);
  expect(h.issueUserResourceGrant).not.toHaveBeenCalled();
  expect(h.listUserResourceAuthorities).not.toHaveBeenCalled();
});

test("disconnected and workspace-owned accounts do not become personal selections", async () => {
  const h = harness([
    { ...account, status: "revoked" },
    { ...account, subjectId: null },
  ]);
  expect(
    await sessionConnectionAccounts(h.client, { id: "session", workspaceId: "workspace" }, [item]),
  ).toEqual([]);
});

test("multiple accounts require a choice rather than timestamp-based selection", async () => {
  const h = harness([account, { ...account, id: "other" }]);
  await expect(
    sessionConnectionAccounts(h.client, { id: "session", workspaceId: "workspace" }, [item]),
  ).rejects.toThrow("Choose an account");
});

test("an explicit account choice survives reordering; a removed choice never switches accounts", () => {
  const accounts = [account, { ...account, id: "other" }] as ConnectionMetadata[];
  const group = { serverId: "mail", name: "Mail", accounts };
  expect(selectedConnectionAccounts([group], {}).unresolved).toEqual([group]);
  const choice = { mail: "connection" };
  expect(
    selectedConnectionAccounts([{ ...group, accounts: [...accounts].reverse() }], choice)
      .selections,
  ).toEqual([{ serverId: "mail", connectionId: "connection" }]);
  const remaining = { ...group, accounts: [accounts[1]!] };
  expect(selectedConnectionAccounts([remaining], choice)).toEqual({
    selections: [],
    unresolved: [remaining],
  });
});
