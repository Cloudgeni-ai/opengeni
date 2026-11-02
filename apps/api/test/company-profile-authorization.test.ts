import { describe, expect, test } from "bun:test";
import {
  type AccessContext,
  type AccessGrant,
  type AccessPrincipalKind,
  type AccountRole,
  type Permission,
} from "@opengeni/contracts";
import { accessGrantAuthorizationFromContext } from "@opengeni/core";
import { HTTPException } from "hono/http-exception";
import { requireDirectAccountAdmin } from "../src/routes/company-profile";

const accountId = "11111111-1111-4111-8111-111111111111";
const otherAccountId = "22222222-2222-4222-8222-222222222222";
const workspaceId = "33333333-3333-4333-8333-333333333333";
const subjectId = "user:organization-owner";

function authorization(input: {
  role?: AccountRole;
  accountPermissions?: Permission[];
  principalKind?: AccessPrincipalKind;
  accountGrantAccountId?: string;
  accountGrantSubjectId?: string;
  serviceInitiator?: AccessGrant["serviceInitiator"];
  delegated?: boolean;
}) {
  const grant: AccessGrant = {
    accountId,
    workspaceId,
    subjectId,
    permissions: ["workspace:read"],
    principalKind: input.principalKind ?? "human_session",
    ...(input.serviceInitiator ? { serviceInitiator: input.serviceInitiator } : {}),
    ...(input.delegated ? { metadata: { delegated: true } } : {}),
  };
  const context: AccessContext = {
    mode: "managed",
    subjectId,
    accountGrants: [
      {
        accountId: input.accountGrantAccountId ?? accountId,
        subjectId: input.accountGrantSubjectId ?? subjectId,
        ...(input.role ? { role: input.role } : {}),
        permissions: input.accountPermissions ?? ["account:read"],
      },
    ],
    workspaceGrants: [grant],
    defaultAccountId: accountId,
    defaultWorkspaceId: workspaceId,
  };
  return accessGrantAuthorizationFromContext(context, grant);
}

function expectForbidden(operation: () => void, message: string): void {
  try {
    operation();
    throw new Error("expected company-profile authorization to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(HTTPException);
    expect((error as HTTPException).status).toBe(403);
    expect((error as Error).message).toContain(message);
  }
}

/**
 * The manual administration route admits a direct human session that
 * administers the organization: an exact account grant carrying
 * `account:admin` (organization owners), or an owner/admin role on a
 * canonical Better Auth cookie session (covered end to end in
 * organization-admin-knowledge-administration.test.ts). The contexts built
 * here are not cookie-stamped, so a bare admin role without that proof is
 * still refused. Members, machines, and service-initiated requests are
 * refused. Delegated (embedded) human sessions carrying `account:admin`
 * remain admitted.
 */
describe("company-profile human mutation authorization", () => {
  test("admits a direct human session holding account:admin", () => {
    expect(() =>
      requireDirectAccountAdmin(
        authorization({ role: "owner", accountPermissions: ["account:read", "account:admin"] }),
      ),
    ).not.toThrow();
    expect(() =>
      requireDirectAccountAdmin(
        authorization({
          role: "owner",
          accountPermissions: ["account:read", "account:admin"],
          delegated: true,
        }),
      ),
    ).not.toThrow();
  });

  test("denies members, and admin roles without a canonical human session proof", () => {
    for (const role of ["admin", "member"] as const) {
      expectForbidden(
        () => requireDirectAccountAdmin(authorization({ role })),
        "You don't have permission to manage this organization.",
      );
    }
  });

  test("fails closed for machines, service-initiated requests, and mismatched account context", () => {
    for (const principalKind of [
      "agent_attempt",
      "service",
      "api_key",
      "configured_key",
    ] as const) {
      expectForbidden(
        () =>
          requireDirectAccountAdmin(
            authorization({
              role: "owner",
              accountPermissions: ["account:admin"],
              principalKind,
            }),
          ),
        "direct human-authorized request",
      );
    }
    expectForbidden(
      () =>
        requireDirectAccountAdmin(
          authorization({
            role: "owner",
            accountPermissions: ["account:admin"],
            serviceInitiator: {
              kind: "service",
              subjectId: "service:embedding-host",
              label: "Embedding host",
            },
          }),
        ),
      "direct human-authorized request",
    );
    expectForbidden(
      () =>
        requireDirectAccountAdmin(
          authorization({
            role: "owner",
            accountPermissions: ["account:admin"],
            accountGrantAccountId: otherAccountId,
          }),
        ),
      "direct human-authorized request",
    );
    expectForbidden(
      () =>
        requireDirectAccountAdmin(
          authorization({
            role: "owner",
            accountPermissions: ["account:admin"],
            accountGrantSubjectId: "user:other",
          }),
        ),
      "direct human-authorized request",
    );
  });
});
