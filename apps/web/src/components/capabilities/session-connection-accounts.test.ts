import { expect, mock, test } from "bun:test";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import type { CapabilityCatalogItem, ConnectionMetadata, Session } from "@opengeni/sdk";
import {
  selectedConnectionAccounts,
  sessionConnectionAccounts,
  connectedAccountGroups,
  connectionAccountChoices,
  selectedNativeConnectorRefs,
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

test("mixed authorized workspace and personal inventory excludes disconnected accounts", async () => {
  const h = harness([
    { ...account, status: "revoked" },
    { ...account, id: "workspace-account", subjectId: null, authorityId: undefined },
  ]);
  expect(
    await sessionConnectionAccounts(h.client, { id: "session", workspaceId: "workspace" }, [item]),
  ).toEqual([{ serverId: "example", connectionId: "workspace-account" }]);
});

test("all eligible accounts attach by default, not by timestamp or ownership preference", async () => {
  const h = harness([account, { ...account, id: "other" }]);
  expect(
    await sessionConnectionAccounts(h.client, { id: "session", workspaceId: "workspace" }, [item]),
  ).toEqual([
    { serverId: "example", connectionId: "connection" },
    { serverId: "example", connectionId: "other" },
  ]);
});

test("an explicit account choice survives reordering; a removed choice never switches accounts", () => {
  const accounts = [account, { ...account, id: "other" }] as ConnectionMetadata[];
  const group = { serverId: "mail", name: "Mail", accounts };
  expect(selectedConnectionAccounts([group], {}).unresolved).toEqual([]);
  const choice = { mail: ["connection"] };
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

test("explicit exclusions survive new accounts and an empty choice never becomes defaults", () => {
  const group = {
    serverId: "mail",
    name: "Mail",
    accounts: [account, { ...account, id: "other" }] as ConnectionMetadata[],
  };
  expect(selectedConnectionAccounts([group], { mail: ["connection"] }).selections).toEqual([
    { serverId: "mail", connectionId: "connection" },
  ]);
  expect(selectedConnectionAccounts([group], { mail: [] })).toEqual({
    selections: [],
    unresolved: [group],
  });
  expect(selectedConnectionAccounts([{ ...group, accounts: [] }], {}).unresolved).toHaveLength(1);
});

test("multiple schedule pairs round-trip without collapsing or duplicating accounts", () => {
  const pairs = [
    { serverId: "example", connectionId: "connection" },
    { serverId: "example", connectionId: "other" },
  ];
  const groups = connectedAccountGroups(selectedNativeConnectorRefs([item]), [
    account,
    { ...account, id: "other" },
  ] as ConnectionMetadata[]);
  expect(connectionAccountChoices([...pairs, pairs[0]!])).toEqual({
    example: ["connection", "other"],
  });
  expect(selectedConnectionAccounts(groups, connectionAccountChoices(pairs)).selections).toEqual(
    pairs,
  );
});

test("native refs honor exact IDs, provider, kind and status; host refs are not native accounts", () => {
  const accounts = [
    account,
    { ...account, id: "other" },
    { ...account, id: "wrong-provider", providerDomain: "other.example" },
    { ...account, id: "wrong-kind", kind: "oauth2" },
    { ...account, id: "disconnected", status: "revoked" },
    { ...account, id: "no-authority", authorityId: undefined },
  ] as ConnectionMetadata[];
  expect(
    connectedAccountGroups(selectedNativeConnectorRefs([item]), accounts)[0]?.accounts.map(
      (value) => value.id,
    ),
  ).toEqual(["connection", "other"]);
  const fixed = { ...item, connectionRef: { ...item.connectionRef!, connectionId: "other" } };
  expect(
    connectedAccountGroups(selectedNativeConnectorRefs([fixed]), accounts)[0]?.accounts.map(
      (value) => value.id,
    ),
  ).toEqual(["other"]);
  expect(
    connectedAccountGroups(
      selectedNativeConnectorRefs([
        { ...item, connectionRef: { ...item.connectionRef!, authoritySource: "host" } },
      ]),
      accounts,
    ),
  ).toEqual([]);
  expect(selectedNativeConnectorRefs([{ ...item, enabled: false }])).toEqual([]);
  expect(connectedAccountGroups(selectedNativeConnectorRefs([item, item]), accounts)).toHaveLength(
    1,
  );
});
