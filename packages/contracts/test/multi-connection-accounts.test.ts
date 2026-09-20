import { expect, test } from "bun:test";
import { McpConnectionAccountSelections, McpConnectionAccountBinding } from "../src";

test("one connector can attach multiple exact accounts", () => {
  const accounts = [
    { serverId: "slack", connectionId: crypto.randomUUID() },
    { serverId: "slack", connectionId: crypto.randomUUID() },
  ];
  expect(McpConnectionAccountSelections.parse(accounts)).toEqual(accounts);
});

test("duplicate connector-account pairs are rejected", () => {
  const account = { serverId: "slack", connectionId: crypto.randomUUID() };
  expect(McpConnectionAccountSelections.safeParse([account, account]).success).toBe(false);
});

test("account selection cannot supply ownership or credential material", () => {
  const account = { serverId: "slack", connectionId: crypto.randomUUID() };
  for (const extra of [{ ownerSubjectId: "another-user" }, { token: "not-a-token" }]) {
    expect(McpConnectionAccountSelections.safeParse([{ ...account, ...extra }]).success).toBe(
      false,
    );
  }
});

test("the same account can be selected for distinct connector surfaces", () => {
  const connectionId = crypto.randomUUID();
  expect(
    McpConnectionAccountSelections.parse([
      { serverId: "mail", connectionId },
      { serverId: "calendar", connectionId },
    ]),
  ).toHaveLength(2);
});

test("accepted bindings reject a mismatched connection ref or workspace owner", () => {
  const connectionId = crypto.randomUUID();
  const binding = {
    serverId: "account-route",
    canonicalServerId: "slack",
    connectionId,
    originWorkspaceId: crypto.randomUUID(),
    subjectScope: "workspace",
    ownerSubjectId: null,
    accountLabel: "Example workspace",
    providerDomain: "slack.test",
    kind: "oauth2",
    connectionRef: {
      connectionId,
      providerDomain: "slack.test",
      kind: "oauth2",
      subjectScope: "workspace",
    },
  };
  expect(McpConnectionAccountBinding.safeParse(binding).success).toBe(true);
  expect(
    McpConnectionAccountBinding.safeParse({ ...binding, ownerSubjectId: "alice" }).success,
  ).toBe(false);
  expect(
    McpConnectionAccountBinding.safeParse({
      ...binding,
      connectionRef: { ...binding.connectionRef, connectionId: crypto.randomUUID() },
    }).success,
  ).toBe(false);
});
