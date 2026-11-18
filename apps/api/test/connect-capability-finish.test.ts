import { describe, expect, test } from "bun:test";

import { connectCapabilityPlan } from "../src/integrations/connect-capability-finish";

// What the sign-in callback does with the capability a connect was for. It
// must match what the console's return page did before (oauthResumeAction,
// catalogConnectionAccountSelection, oauthConnectionRef), so finishing in the
// callback changes where setup happens, not what it sets up.

const connection = { id: "conn-new", providerDomain: "gmailmcp.googleapis.com" };
const active = (connectionRef: Record<string, unknown>) => ({
  enabled: true,
  connectionRef: connectionRef as never,
});

describe("connectCapabilityPlan", () => {
  test("a capability that is not on yet is turned on for every eligible account", () => {
    expect(connectCapabilityPlan({ enabled: false }, connection, "personal")).toEqual({
      kind: "enable",
      payload: expect.objectContaining({
        connectionRef: {
          providerDomain: "gmailmcp.googleapis.com",
          kind: "oauth2",
          subjectScope: "subject",
          accountSelection: "all_eligible",
        },
      }),
    });
    expect(
      connectCapabilityPlan({ enabled: false, connectionRef: null }, connection, "workspace"),
    ).toMatchObject({
      kind: "enable",
      payload: { connectionRef: { subjectScope: "workspace", accountSelection: "all_eligible" } },
    });
  });

  test("a per-person binding already finds the new personal account", () => {
    expect(
      connectCapabilityPlan(
        active({
          providerDomain: "gmailmcp.googleapis.com",
          kind: "oauth2",
          subjectScope: "subject",
        }),
        connection,
        "personal",
      ),
    ).toEqual({ kind: "on" });
  });

  test("an all-eligible workspace binding already includes the new account", () => {
    expect(
      connectCapabilityPlan(
        active({
          providerDomain: "gmailmcp.googleapis.com",
          kind: "oauth2",
          subjectScope: "workspace",
          accountSelection: "all_eligible",
        }),
        connection,
        "workspace",
      ),
    ).toEqual({ kind: "on" });
  });

  test("a pinned account that was reconnected in place is already right", () => {
    expect(
      connectCapabilityPlan(
        active({ connectionId: "conn-new", providerDomain: "gmailmcp.googleapis.com" }),
        connection,
        "workspace",
      ),
    ).toEqual({ kind: "on" });
  });

  test("a pinned account that was replaced is pointed at the new one", () => {
    expect(
      connectCapabilityPlan(
        active({
          connectionId: "conn-gone",
          providerDomain: "gmailmcp.googleapis.com",
          subjectScope: "workspace",
        }),
        connection,
        "workspace",
      ),
    ).toMatchObject({
      kind: "enable",
      payload: {
        connectionRef: {
          connectionId: "conn-new",
          providerDomain: "gmailmcp.googleapis.com",
          kind: "oauth2",
          subjectScope: "workspace",
        },
      },
    });
  });

  test("an organization's or host's setup is left to the page, never rewritten", () => {
    // An organization connector that reaches the workspace, pinned to its own account.
    expect(
      connectCapabilityPlan(
        {
          ...active({
            connectionId: "org-conn",
            providerDomain: "gmailmcp.googleapis.com",
            subjectScope: "workspace",
          }),
          organizationManaged: true,
        },
        connection,
        "workspace",
      ),
    ).toEqual({ kind: "leave" });
    // Turned off in this workspace: turning it back on is the workspace's call.
    expect(
      connectCapabilityPlan({ enabled: false, organizationManaged: true }, connection, "workspace"),
    ).toEqual({ kind: "leave" });
    expect(
      connectCapabilityPlan({ enabled: true, connectionRef: null }, connection, "workspace"),
    ).toEqual({
      kind: "leave",
    });
    expect(
      connectCapabilityPlan(
        active({
          providerDomain: "gmailmcp.googleapis.com",
          kind: "oauth2",
          authoritySource: "host",
        }),
        connection,
        "workspace",
      ),
    ).toEqual({ kind: "leave" });
  });

  test("an organization connector each person signs in to already includes the new account", () => {
    expect(
      connectCapabilityPlan(
        {
          ...active({
            providerDomain: "gmailmcp.googleapis.com",
            kind: "oauth2",
            subjectScope: "subject",
          }),
          organizationManaged: true,
        },
        connection,
        "personal",
      ),
    ).toEqual({ kind: "on" });
  });
});
