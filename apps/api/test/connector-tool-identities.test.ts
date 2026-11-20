import { expect, test } from "bun:test";
import { connectorToolIdentities, connectorToolIdentity } from "../src/site-tool-routing";

const inventory = {
  canonical: new Map([
    ["tracker", { capabilityId: null, name: "Tracker", providerDomain: "tracker.test" }],
    ["mail", { capabilityId: null, name: "Mail", providerDomain: "mail.test" }],
  ]),
  plain: new Set(["opengeni"]),
  accounts: [
    {
      serverId: "account-mine",
      canonicalServerId: "mail",
      connector: "Mail",
      account: "me@mail.test",
      connectionId: "00000000-0000-4000-8000-000000000001",
    },
  ],
};

test("account routes become their connector entry; others stay as they are", () => {
  // The reader's own account route maps through their bindings.
  expect(
    connectorToolIdentity(inventory, [], { serverId: "account-mine", toolName: "send" }),
  ).toEqual({ serverId: "mail", toolName: "send" });
  // Another member's route maps through the one connector entry paired with it.
  expect(
    connectorToolIdentity(
      inventory,
      [
        { serverId: "account-theirs", toolName: "list_items" },
        { serverId: "tracker", toolName: "list_items" },
      ],
      { serverId: "account-theirs", toolName: "list_items" },
    ),
  ).toEqual({ serverId: "tracker", toolName: "list_items" });
  // Ambiguous or unexplained routes, and plain tools, are kept.
  const ambiguous = [
    { serverId: "account-theirs", toolName: "list_items" },
    { serverId: "tracker", toolName: "list_items" },
    { serverId: "mail", toolName: "list_items" },
  ];
  expect(connectorToolIdentity(inventory, ambiguous, ambiguous[0]!)).toEqual(ambiguous[0]!);
  expect(
    connectorToolIdentity(inventory, [], { serverId: "opengeni", toolName: "search" }),
  ).toEqual({ serverId: "opengeni", toolName: "search" });
});

test("the list keeps one entry per connector tool", () => {
  expect(
    connectorToolIdentities(inventory, [
      { serverId: "account-mine", toolName: "send" },
      { serverId: "mail", toolName: "send" },
      { serverId: "opengeni", toolName: "search" },
    ]),
  ).toEqual([
    { serverId: "mail", toolName: "send" },
    { serverId: "opengeni", toolName: "search" },
  ]);
});
