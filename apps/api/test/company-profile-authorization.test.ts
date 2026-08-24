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
 * The manual administration route keeps the pre-existing admission contract:
 * a direct human session whose exact account grant carries `account:admin`
 * (granted to organization owners). Organization admins, members, machines,
 * and service-initiated requests are refused. Delegated (embedded) human
 * sessions carrying `account:admin` remain admitted exactly as before this
 * change; narrowing that is a deliberate product decision, not a silent one.
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

  test("denies organization admins and members without account:admin", () => {
    for (const role of ["admin", "member"] as const) {
      expectForbidden(
        () => requireDirectAccountAdmin(authorization({ role })),
        "missing permission: account:admin",
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
