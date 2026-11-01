import { describe, expect, test } from "bun:test";

import type { AccessContext } from "@opengeni/react/app/types";
import { deviceApprovalScopes } from "./device-approval-scopes";

const managed = { productAccessMode: "managed", auth: { mode: "managedSession" } } as const;

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
        workspaceId: "ws",
        accountId: "acme",
        subjectId: "user:alex",
        permissions: workspacePermissions,
      },
    ],
  } as unknown as AccessContext;
}

function scopes(accessContext: AccessContext) {
  return deviceApprovalScopes({ accessContext, clientConfig: managed, workspaceId: "ws" });
}

describe("device approval scopes", () => {
  test("an organization admin who manages enrollments may choose the organization", () => {
    expect(
      scopes(context("admin", ["account:read", "members:manage"], ["enrollments:manage"])),
    ).toEqual({ workspace: true, organization: true });
  });

  test("an admin without enrollments:manage in the workspace is offered neither, as the server refuses", () => {
    expect(scopes(context("admin", ["account:read", "members:manage"], ["sessions:read"]))).toEqual(
      { workspace: false, organization: false },
    );
  });

  test("a member who manages enrollments gets the workspace only", () => {
    expect(scopes(context("member", ["account:read"], ["enrollments:manage"]))).toEqual({
      workspace: true,
      organization: false,
    });
  });

  test("before the lookup answers nothing is refused yet and the organization isn't offered", () => {
    expect(
      deviceApprovalScopes({
        accessContext: context("member", ["account:read"], []),
        clientConfig: managed,
        workspaceId: null,
      }),
    ).toEqual({ workspace: true, organization: false });
  });
});
