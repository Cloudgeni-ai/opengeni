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
import { authorizeCompanyProfileMutation } from "../src/routes/company-profile";

const accountId = "11111111-1111-4111-8111-111111111111";
const otherAccountId = "22222222-2222-4222-8222-222222222222";
const workspaceId = "33333333-3333-4333-8333-333333333333";
const subjectId = "user:organization-admin";

function authorization(input: {
  role?: AccountRole;
  accountPermissions?: Permission[];
  principalKind?: AccessPrincipalKind;
  accountGrantAccountId?: string;
  accountGrantSubjectId?: string;
  serviceInitiator?: AccessGrant["serviceInitiator"];
  duplicateWorkspaceGrant?: boolean;
}) {
  const grant: AccessGrant = {
    accountId,
    workspaceId,
    subjectId,
    permissions: ["workspace:read"],
    principalKind: input.principalKind ?? "human_session",
    ...(input.serviceInitiator ? { serviceInitiator: input.serviceInitiator } : {}),
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
    workspaceGrants: [grant, ...(input.duplicateWorkspaceGrant ? [{ ...grant }] : [])],
    defaultAccountId: accountId,
    defaultWorkspaceId: workspaceId,
  };
  return {
    ...accessGrantAuthorizationFromContext(context, grant),
    canonicalManagedHumanSession: input.principalKind === undefined,
  };
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

describe("company-profile human mutation authorization", () => {
  test("allows direct organization owners and admins without broad account-admin permission", () => {
    for (const role of ["owner", "admin"] as const) {
      const access = authorization({ role });
      expect(access.accountGrant?.permissions).not.toContain("account:admin");
      expect(() => authorizeCompanyProfileMutation(access)).not.toThrow();
    }
  });

  test("denies ordinary members even when a stale or over-broad grant says account admin", () => {
    expectForbidden(
      () =>
        authorizeCompanyProfileMutation(
          authorization({
            role: "member",
            accountPermissions: ["account:admin"],
          }),
        ),
      "organization owner or admin",
    );
  });

  test("fails closed for duplicate matching workspace grants", () => {
    const access = authorization({ role: "admin", duplicateWorkspaceGrant: true });
    expect(access.contextIntegrity).toBe(false);
    expect(access.accountGrant).toBeNull();
    expectForbidden(
      () => authorizeCompanyProfileMutation(access),
      "direct human-authorized request",
    );
  });

  test("fails closed for machines, service-initiated requests, and mismatched account context", () => {
    for (const principalKind of [
      "human_session",
      "agent_attempt",
      "service",
      "api_key",
      "configured_key",
    ] as const) {
      expectForbidden(
        () => authorizeCompanyProfileMutation(authorization({ role: "admin", principalKind })),
        "direct human-authorized request",
      );
    }
    expectForbidden(
      () =>
        authorizeCompanyProfileMutation(
          authorization({
            role: "owner",
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
        authorizeCompanyProfileMutation(
          authorization({
            role: "owner",
            accountGrantAccountId: otherAccountId,
          }),
        ),
      "direct human-authorized request",
    );
    expectForbidden(
      () =>
        authorizeCompanyProfileMutation(
          authorization({ role: "owner", accountGrantSubjectId: "user:other" }),
        ),
      "direct human-authorized request",
    );
  });
});
