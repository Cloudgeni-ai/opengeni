import { describe, expect, test } from "bun:test";
import {
  type AccessContext,
  type AccessGrant,
  type AccessPrincipalKind,
  type Permission,
} from "@opengeni/contracts";
import { accessGrantAuthorizationFromContext } from "@opengeni/core";
import { HTTPException } from "hono/http-exception";
import { authorizePreferenceRegistryScopeMutation } from "../src/routes/preference-registry";

const accountId = "11111111-1111-4111-8111-111111111111";
const otherAccountId = "22222222-2222-4222-8222-222222222222";
const workspaceId = "33333333-3333-4333-8333-333333333333";
const otherWorkspaceId = "44444444-4444-4444-8444-444444444444";
const subjectId = "user:hosted-owner";

function authorization(input: {
  workspacePermissions?: Permission[];
  accountPermissions?: Permission[];
  principalKind?: AccessPrincipalKind;
  contextSubjectId?: string;
  grantSubjectId?: string;
  accountGrantSubjectId?: string;
  accountGrantAccountId?: string;
  metadata?: AccessGrant["metadata"];
  serviceInitiator?: AccessGrant["serviceInitiator"];
  serviceInitiatorContext?: AccessGrant["serviceInitiatorContext"];
  extraWorkspaceGrant?: AccessGrant;
}) {
  const contextSubjectId = input.contextSubjectId ?? subjectId;
  const grant: AccessGrant = {
    accountId,
    workspaceId,
    subjectId: input.grantSubjectId ?? subjectId,
    permissions: input.workspacePermissions ?? ["workspace:read", "workspace:admin"],
    ...(input.principalKind ? { principalKind: input.principalKind } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
    ...(input.serviceInitiator ? { serviceInitiator: input.serviceInitiator } : {}),
    ...(input.serviceInitiatorContext
      ? { serviceInitiatorContext: input.serviceInitiatorContext }
      : {}),
  };
  const context: AccessContext = {
    mode: "managed",
    subjectId: contextSubjectId,
    accountGrants: [
      {
        accountId: input.accountGrantAccountId ?? accountId,
        subjectId: input.accountGrantSubjectId ?? subjectId,
        permissions: input.accountPermissions ?? ["account:admin"],
      },
    ],
    workspaceGrants: [grant, ...(input.extraWorkspaceGrant ? [input.extraWorkspaceGrant] : [])],
    defaultAccountId: accountId,
    defaultWorkspaceId: workspaceId,
  };
  return accessGrantAuthorizationFromContext(context, grant);
}

function expectForbidden(operation: () => void, message?: string): void {
  try {
    operation();
    throw new Error("expected preference authorization to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(HTTPException);
    expect((error as HTTPException).status).toBe(403);
    if (message) expect((error as Error).message).toContain(message);
  }
}

describe("preference registry scope authorization", () => {
  test("uses the matching authenticated account grant for hosted organization governance", () => {
    const access = authorization({ principalKind: "human_session" });
    expect(access.contextIntegrity).toBe(true);
    expect(access.grant.permissions).not.toContain("account:admin");
    expect(access.accountGrant?.permissions).toContain("account:admin");
    expect(() => authorizePreferenceRegistryScopeMutation(access, "organization")).not.toThrow();
  });

  test("does not expand workspace or ordinary human permissions into organization authority", () => {
    const workspaceAdmin = authorization({
      principalKind: "human_session",
      accountPermissions: ["billing:read"],
    });
    expect(() =>
      authorizePreferenceRegistryScopeMutation(workspaceAdmin, "workspace"),
    ).not.toThrow();
    expectForbidden(
      () => authorizePreferenceRegistryScopeMutation(workspaceAdmin, "organization"),
      "account:admin",
    );

    const ordinaryHuman = authorization({
      principalKind: "human_session",
      workspacePermissions: ["workspace:read"],
      accountPermissions: ["billing:read"],
    });
    expect(() => authorizePreferenceRegistryScopeMutation(ordinaryHuman, "user")).not.toThrow();
    expectForbidden(
      () => authorizePreferenceRegistryScopeMutation(ordinaryHuman, "workspace"),
      "workspace:admin",
    );
    expectForbidden(
      () => authorizePreferenceRegistryScopeMutation(ordinaryHuman, "organization"),
      "account:admin",
    );
  });

  test("fails closed for machines, keys, generic grants, and malformed direct-human claims", () => {
    for (const principalKind of [
      "agent_attempt",
      "service",
      "api_key",
      "configured_key",
    ] as const) {
      expectForbidden(() =>
        authorizePreferenceRegistryScopeMutation(authorization({ principalKind }), "user"),
      );
    }
    expectForbidden(() => authorizePreferenceRegistryScopeMutation(authorization({}), "workspace"));
    expectForbidden(() =>
      authorizePreferenceRegistryScopeMutation(
        authorization({
          principalKind: "human_session",
          metadata: { sessionId: "partial-malformed-attempt" },
        }),
        "organization",
      ),
    );
    expectForbidden(() =>
      authorizePreferenceRegistryScopeMutation(
        authorization({
          principalKind: "human_session",
          serviceInitiator: {
            kind: "service",
            subjectId: "service:embedding-host",
            label: "Embedding host",
          },
        }),
        "organization",
      ),
    );
    expectForbidden(() =>
      authorizePreferenceRegistryScopeMutation(
        authorization({
          principalKind: "human_session",
          serviceInitiatorContext: { occurrenceId: "orphan-service-context" },
        }),
        "organization",
      ),
    );
  });

  test("rejects mismatched account context and mixed authenticated identities or principals", () => {
    for (const access of [
      authorization({
        principalKind: "human_session",
        accountGrantAccountId: otherAccountId,
      }),
      authorization({
        principalKind: "human_session",
        accountGrantSubjectId: "user:other-account-owner",
      }),
      authorization({
        principalKind: "human_session",
        contextSubjectId: "user:other-authenticated-subject",
      }),
      authorization({
        principalKind: "human_session",
        extraWorkspaceGrant: {
          accountId,
          workspaceId: otherWorkspaceId,
          subjectId,
          permissions: ["workspace:read", "workspace:admin"],
          principalKind: "agent_attempt",
        },
      }),
      authorization({
        principalKind: "human_session",
        extraWorkspaceGrant: {
          accountId,
          workspaceId: otherWorkspaceId,
          subjectId,
          permissions: ["workspace:read", "workspace:admin"],
          principalKind: "human_session",
          serviceInitiatorContext: { occurrenceId: "mixed-orphan-service-context" },
        },
      }),
    ]) {
      expect(access.contextIntegrity).toBe(false);
      expect(access.accountGrant).toBeNull();
      expectForbidden(() => authorizePreferenceRegistryScopeMutation(access, "organization"));
    }
  });
});
