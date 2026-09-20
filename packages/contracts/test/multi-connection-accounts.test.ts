import { expect, test } from "bun:test";
import { McpConnectionAccountSelections } from "../src";

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
