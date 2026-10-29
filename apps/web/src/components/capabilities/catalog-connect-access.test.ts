import { describe, expect, test } from "bun:test";
import type { CapabilityCatalogItem } from "@opengeni/react/app/types";
import { addConnectionErrorCopy, catalogConnectAccess } from "./capability-copy";

// A server an admin added by hand: it declares no sign-in until asked.
const custom = {
  id: "mcp:team-tools",
  kind: "mcp",
  source: "manual",
  name: "Team tools",
  authKind: null,
  enabled: false,
  connectionRef: null,
  workspaceId: "shared",
  endpointUrl: "https://tools.example/mcp",
  mcpUrl: null,
  runtime: { available: true },
} as unknown as CapabilityCatalogItem;
const reviewed = {
  ...custom,
  id: "mcp:notion",
  source: "built_in",
  name: "Notion",
  authKind: "oauth2",
  workspaceId: null,
} as unknown as CapabilityCatalogItem;
const member = { permissions: ["connections:read", "connections:write"] };
const admin = { permissions: ["workspace:admin"] };

describe("who may connect from a connection's page", () => {
  test("a member can't start sign-in for a custom server that isn't on yet; it says to ask an admin", () => {
    expect(catalogConnectAccess(custom, member, "shared")).toEqual({
      personalOnly: false,
      blocked: {
        title: "Ask an admin to turn on Team tools",
        description:
          "Only an admin can turn it on in this workspace. Once it's on, you can connect your own account here.",
      },
    });
    expect(catalogConnectAccess(custom, { permissions: [] }, "shared").blocked?.title).toBe(
      "You can't connect accounts here",
    );
  });

  test("once an admin turns it on for each person, a member connects only their own account", () => {
    const on = {
      ...custom,
      enabled: true,
      connectionRef: { providerDomain: "tools.example", kind: "oauth2", subjectScope: "subject" },
    } as unknown as CapabilityCatalogItem;
    expect(catalogConnectAccess(on, member, "shared")).toEqual({
      personalOnly: true,
      blocked: null,
    });
  });

  test("a reviewed sign-in integration lets a member turn it on for their own account", () => {
    expect(catalogConnectAccess(reviewed, member, "shared")).toEqual({
      personalOnly: true,
      blocked: null,
    });
  });

  test("an admin chooses who can use it in a shared workspace", () => {
    expect(catalogConnectAccess(custom, admin, "shared")).toEqual({
      personalOnly: false,
      blocked: null,
    });
  });

  test("in a Personal workspace everything connected is only yours, with no workspace choice", () => {
    for (const item of [custom, reviewed])
      expect(catalogConnectAccess(item, admin, "personal").personalOnly).toBe(true);
    expect(catalogConnectAccess({ ...reviewed, enabled: true }, admin, "personal")).toEqual({
      personalOnly: true,
      blocked: null,
    });
    // Before the grant loads, the page still knows the workspace.
    expect(catalogConnectAccess(custom, null, "personal").personalOnly).toBe(true);
  });
});

test("adding a server without permission explains who can, never the raw permission name", () => {
  const copy = addConnectionErrorCopy({
    status: 403,
    message: "API 403: missing permission: capabilities:manage",
  });
  expect(copy.title).toBe("Only an admin can add connections");
  expect(`${copy.title} ${copy.description}`).not.toContain("capabilities:manage");
});
