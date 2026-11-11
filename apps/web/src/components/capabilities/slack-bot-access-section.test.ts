import { describe, expect, test } from "bun:test";

import type { AccessContext } from "@opengeni/react/app/types";
import { canShareSlackBotWithOrganization } from "./slack-bot-access-section";

const managed = { productAccessMode: "managed", auth: { mode: "managedSession" } } as const;
const connection = { accountId: "acme", workspaceId: "ws-eng" };
const ADMIN_WORKSPACE = ["workspace:read", "workspace:admin"];

function context(
  role: "owner" | "admin" | "member",
  accountPermissions: string[],
  workspacePermissions: string[],
): AccessContext {
  return {
    mode: "managed",
    subjectId: "user:alex",
    defaultAccountId: "acme",
    accountGrants: [
      { accountId: "acme", subjectId: "user:alex", role, permissions: accountPermissions },
    ],
    workspaceGrants: [
      {
        workspaceId: "ws-eng",
        accountId: "acme",
        subjectId: "user:alex",
        permissions: workspacePermissions,
      },
    ],
  } as unknown as AccessContext;
}

function can(accessContext: AccessContext): boolean {
  return canShareSlackBotWithOrganization({
    accessContext,
    clientConfig: managed as never,
    connection,
  });
}

describe("sharing a workspace's Slack bot with the organization", () => {
  test("organization owners and admins who manage the workspace's integrations can", () => {
    expect(can(context("owner", ["account:read", "account:admin"], ADMIN_WORKSPACE))).toBe(true);
    // Admins don't hold account:admin (owner only), but the server lets them share it.
    expect(can(context("admin", ["account:read", "members:manage"], ADMIN_WORKSPACE))).toBe(true);
  });

  test("members and admins without the workspace's integrations can't", () => {
    expect(can(context("member", ["account:read"], ADMIN_WORKSPACE))).toBe(false);
    expect(
      can(
        context(
          "admin",
          ["account:read", "members:manage"],
          ["workspace:read", "connections:write"],
        ),
      ),
    ).toBe(false);
  });
});
