import { describe, expect, test } from "bun:test";
import type { AccessContext, AccessGrant } from "@opengeni/contracts";
import { HTTPException } from "hono/http-exception";
import {
  accessGrantAuthorizationFromContext,
  requireAccountAdminAuthorizationStamp,
  type AccessGrantAuthorization,
} from "../src/access";

const accountId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const subjectId = "human:account-admin";

function resolvedAuthorization(
  mode: AccessContext["mode"],
  delegated = false,
): AccessGrantAuthorization {
  const grant: AccessGrant = {
    accountId,
    workspaceId,
    subjectId,
    permissions: ["documents:manage"],
    principalKind: "human_session",
    ...(delegated ? { metadata: { delegated: true } } : {}),
  };
  const context: AccessContext = {
    mode,
    subjectId,
    accountGrants: [
      {
        accountId,
        subjectId,
        permissions: ["account:read", "account:admin"],
      },
    ],
    workspaceGrants: [grant],
    defaultAccountId: accountId,
    defaultWorkspaceId: workspaceId,
  };
  return accessGrantAuthorizationFromContext(context, grant);
}

describe("exact account-admin authorization stamps", () => {
  test("covers managed, local, configured, and signed delegated access", () => {
    for (const [mode, delegated] of [
      ["managed", false],
      ["local", false],
      ["configured", false],
      ["managed", true],
    ] as const) {
      expect(requireAccountAdminAuthorizationStamp(resolvedAuthorization(mode, delegated))).toEqual(
        {
          authorizationId: expect.any(String),
          accountId,
          actorSubjectId: subjectId,
          permission: "account:admin",
        },
      );
    }
  });

  test("rejects an unstamped shape and mismatched account authority", () => {
    const resolved = resolvedAuthorization("configured");
    const forged = { ...resolved } satisfies AccessGrantAuthorization;
    expect(() => requireAccountAdminAuthorizationStamp(forged)).toThrow(HTTPException);

    const mismatched = accessGrantAuthorizationFromContext(
      {
        mode: "configured",
        subjectId,
        accountGrants: [
          {
            accountId: "33333333-3333-4333-8333-333333333333",
            subjectId,
            permissions: ["account:admin"],
          },
        ],
        workspaceGrants: [resolved.grant],
        defaultAccountId: accountId,
        defaultWorkspaceId: workspaceId,
      },
      resolved.grant,
    );
    expect(() => requireAccountAdminAuthorizationStamp(mismatched)).toThrow(HTTPException);
  });
});
