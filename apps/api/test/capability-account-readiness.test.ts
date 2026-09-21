import { expect, test } from "bun:test";
import { McpConnectionAccountBinding } from "@opengeni/contracts";
import { capabilityAccountReadiness } from "../src/mcp/capability-account-readiness";

function binding(serverId: string, canonicalServerId: string) {
  return McpConnectionAccountBinding.parse({
    serverId,
    canonicalServerId,
    connectionId: "11111111-1111-4111-8111-111111111111",
    originWorkspaceId: "22222222-2222-4222-8222-222222222222",
    subjectScope: "workspace",
    ownerSubjectId: null,
    accountLabel: "Team",
    providerDomain: "example.test",
    kind: "oauth2",
    connectionRef: {
      providerDomain: "example.test",
      kind: "oauth2",
      subjectScope: "workspace",
      connectionId: "11111111-1111-4111-8111-111111111111",
    },
  });
}

test("account-qualified tools make their canonical connector ready without requiring reconnection", () => {
  const result = capabilityAccountReadiness(
    ["mail-team", "opengeni"],
    [binding("mail-team", "mail"), binding("mail-personal", "mail")],
  );
  expect(result.available.has("mail")).toBe(true);
  expect(result.available.has("mail-personal")).toBe(false);
  expect(result.accepted.has("mail")).toBe(true);
});

test("accepted account without tools is distinguishable from no accepted account", () => {
  const result = capabilityAccountReadiness(["opengeni"], [binding("mail-team", "mail")]);
  expect(result.available.has("mail")).toBe(false);
  expect(result.accepted.has("mail")).toBe(true);
  expect(capabilityAccountReadiness(["mail-other"], []).available.has("mail")).toBe(false);
});

test("legacy exact tool identities remain ready; aliases are never inferred or transitively expanded", () => {
  expect(capabilityAccountReadiness(["mail"], null).available.has("mail")).toBe(true);
  const result = capabilityAccountReadiness(
    ["route"],
    [binding("route", "mail"), binding("mail", "other")],
  );
  expect(result.available.has("other")).toBe(false);
});
