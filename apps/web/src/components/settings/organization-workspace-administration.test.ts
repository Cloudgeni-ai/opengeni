import { describe, expect, test } from "bun:test";

import type { AccessContext } from "@/types";
import { organizationAdministrationAccountIds } from "./organization-workspace-administration";

function accessContext(): AccessContext {
  return {
    mode: "managed",
    subjectId: "user:administrator",
    accountGrants: [
      {
        accountId: "33333333-3333-4333-8333-333333333333",
        subjectId: "user:administrator",
        role: "member",
        permissions: ["account:read"],
      },
      {
        accountId: "22222222-2222-4222-8222-222222222222",
        subjectId: "user:administrator",
        role: "admin",
        permissions: ["account:read", "members:manage", "workspace:create", "billing:read"],
      },
      {
        accountId: "11111111-1111-4111-8111-111111111111",
        subjectId: "user:administrator",
        role: "owner",
        permissions: ["account:admin"],
      },
      {
        accountId: "44444444-4444-4444-8444-444444444444",
        subjectId: "user:someone-else",
        role: "owner",
        permissions: ["account:admin"],
      },
    ],
    workspaceGrants: [],
    defaultAccountId: null,
    defaultWorkspaceId: null,
  };
}

describe("organization workspace administration authority", () => {
  test("admits exact same-subject owner and admin roles without requiring account:admin", () => {
    expect(organizationAdministrationAccountIds(accessContext())).toEqual([
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    ]);
  });
});
