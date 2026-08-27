import { describe, expect, test } from "bun:test";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  OrganizationRecoveryDeniedError,
  OrganizationRecoveryOperationReuseError,
  OrganizationRecoveryRevisionConflictError,
  OrganizationRecoveryUnavailableError,
} from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
import { Hono } from "hono";
import {
  organizationRecoveryHttpError,
  registerOrganizationRecoveryRoutes,
  type OrganizationRecoveryRouteServices,
} from "../src/routes/organization-recovery";

const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const RECOVERY_OPERATION_ID = "22222222-2222-4222-8222-222222222222";
const COMMAND_OPERATION_ID = "33333333-3333-4333-8333-333333333333";
const TARGET_MEMBERSHIP_ID = "44444444-4444-4444-8444-444444444444";
const CUSTODIANS = [
  "55555555-5555-4555-8555-555555555555",
  "66666666-6666-4666-8666-666666666666",
  "77777777-7777-4777-8777-777777777777",
] as const;

const OVERVIEW = {
  organizationId: ORGANIZATION_ID,
  availability: "recovery_unavailable" as const,
  unavailableReason: "no_policy" as const,
  recentReauthenticationAt: null,
  eligibleMembers: [],
  policy: null,
  operation: null,
  capabilities: {
    configure: true,
    accept: false,
    disable: false,
    start: false,
    approve: false,
    cancel: false,
    execute: false,
  },
};

function harness(overrides: Partial<OrganizationRecoveryRouteServices> = {}) {
  const calls: Array<{ operation: string; input: unknown }> = [];
  let identityInput: unknown;
  const mutation = (operation: string) => async (_db: unknown, input: unknown) => {
    calls.push({ operation, input });
    return { replay: false, overview: OVERVIEW };
  };
  const services = {
    requireCanonicalHumanRequestIdentity: async (_context: unknown, input: unknown) => {
      identityInput = input;
      return { authUserId: "auth-user", authSessionId: "auth-session" };
    },
    getManagedAuthRequestActorAdmissionStamp: () => ({
      authorityHash: "a".repeat(64),
      actorEpoch: "7",
    }),
    getManagedAuthRequestActorLeaseStamp: () => ({
      authorityHash: "a".repeat(64),
      actorEpoch: "7",
      requestId: "88888888-8888-4888-8888-888888888888",
    }),
    getOrganizationRecoveryOverview: async (_db: unknown, input: unknown) => {
      calls.push({ operation: "get", input });
      return OVERVIEW;
    },
    configureOrganizationRecoveryPolicy: mutation("configure"),
    acceptOrganizationRecoveryCustody: mutation("accept"),
    disableOrganizationRecoveryPolicy: mutation("disable"),
    startOrganizationRecoveryOperation: mutation("start"),
    approveOrganizationRecoveryOperation: mutation("approve"),
    cancelOrganizationRecoveryOperation: mutation("cancel"),
    executeOrganizationRecoveryOperation: mutation("execute"),
    ...overrides,
  } as unknown as OrganizationRecoveryRouteServices;
  const app = new Hono();
  const deps = {
    settings: testSettings({
      productAccessMode: "managed",
      managedAuthSessionSetMode: "broker",
    }),
    db: {},
    managedAuth: {},
    managedAuthSessionAdapter: {},
  } as unknown as ApiRouteDeps;
  registerOrganizationRecoveryRoutes(app, deps, services);
  return { app, calls, services, getIdentityInput: () => identityInput };
}

const headers = {
  cookie: "opengeni_session_set=test-authority",
  "content-type": "application/json",
};

async function jsonRequest(app: Hono, path: string, method: string, body?: unknown) {
  return await app.request(`http://opengeni.test${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("organization recovery routes", () => {
  test("exposes the bounded overview only to a ready canonical browser human", async () => {
    const { app, calls, getIdentityInput } = harness();
    const response = await jsonRequest(app, `/v1/organizations/${ORGANIZATION_ID}/recovery`, "GET");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(OVERVIEW);
    expect(calls).toEqual([
      {
        operation: "get",
        input: {
          organizationId: ORGANIZATION_ID,
          actorSubjectId: "user:auth-user",
          actorAuthUserId: "auth-user",
          actorAuthSessionId: "auth-session",
          actorFence: {
            authorityHash: "a".repeat(64),
            actorEpoch: "7",
          },
        },
      },
    ]);
    expect(getIdentityInput()).toMatchObject({ allowRecovery: false });
  });

  test("forwards exact command bodies with server-owned actor and reauthentication identity", async () => {
    const { app, calls } = harness();
    const requests = [
      {
        operation: "configure",
        method: "PUT",
        path: `/v1/organizations/${ORGANIZATION_ID}/recovery/policy`,
        body: {
          custodianMembershipIds: CUSTODIANS,
          expectedPolicyRevision: 0,
          operationId: COMMAND_OPERATION_ID,
        },
      },
      {
        operation: "accept",
        method: "POST",
        path: `/v1/organizations/${ORGANIZATION_ID}/recovery/policy/accept`,
        body: { expectedPolicyRevision: 1, operationId: COMMAND_OPERATION_ID },
      },
      {
        operation: "disable",
        method: "POST",
        path: `/v1/organizations/${ORGANIZATION_ID}/recovery/policy/disable`,
        body: { expectedPolicyRevision: 1, operationId: COMMAND_OPERATION_ID },
      },
      {
        operation: "start",
        method: "POST",
        path: `/v1/organizations/${ORGANIZATION_ID}/recovery/operations`,
        body: {
          targetMembershipId: TARGET_MEMBERSHIP_ID,
          expectedPolicyRevision: 1,
          operationId: COMMAND_OPERATION_ID,
        },
      },
      ...(["approve", "cancel", "execute"] as const).map((operation) => ({
        operation,
        method: "POST",
        path: `/v1/organizations/${ORGANIZATION_ID}/recovery/operations/${RECOVERY_OPERATION_ID}/${operation}`,
        body: {
          expectedOperationRevision: 2,
          operationId: COMMAND_OPERATION_ID,
        },
      })),
    ];

    for (const request of requests) {
      const response = await jsonRequest(app, request.path, request.method, request.body);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        replay: false,
        overview: OVERVIEW,
      });
    }

    expect(calls.map((call) => call.operation)).toEqual(
      requests.map((request) => request.operation),
    );
    for (const call of calls) {
      expect(call.input).toMatchObject({
        organizationId: ORGANIZATION_ID,
        actorSubjectId: "user:auth-user",
        actorAuthUserId: "auth-user",
        actorAuthSessionId: "auth-session",
        operationId: COMMAND_OPERATION_ID,
        actorFence: {
          authorityHash: "a".repeat(64),
          actorEpoch: "7",
          requestId: "88888888-8888-4888-8888-888888888888",
        },
      });
      expect(JSON.stringify(call.input)).not.toContain("reauthOperationId");
    }
    expect(calls.find((call) => call.operation === "start")?.input).not.toHaveProperty(
      "recoveryOperationId",
    );
    for (const operation of ["approve", "cancel", "execute"]) {
      expect(calls.find((call) => call.operation === operation)?.input).toMatchObject({
        recoveryOperationId: RECOVERY_OPERATION_ID,
        expectedOperationRevision: 2,
      });
    }
  });

  test("rejects non-cookie authority, bearer ambiguity, strict extras, and missing actor fences", async () => {
    const { app } = harness();
    const path = `/v1/organizations/${ORGANIZATION_ID}/recovery`;
    expect((await app.request(`http://opengeni.test${path}`)).status).toBe(401);
    expect(
      (
        await app.request(`http://opengeni.test${path}`, {
          headers: {
            cookie: headers.cookie,
            authorization: "Bearer forbidden",
          },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await app.request(`http://opengeni.test${path}/policy`, {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer forbidden",
          },
          body: "{}",
        })
      ).status,
    ).toBe(401);

    const invalid = await jsonRequest(app, `${path}/policy`, "PUT", {
      custodianMembershipIds: CUSTODIANS,
      expectedPolicyRevision: 0,
      operationId: COMMAND_OPERATION_ID,
      accountId: ORGANIZATION_ID,
    });
    expect(invalid.status).toBe(422);

    const noFence = harness({
      getManagedAuthRequestActorLeaseStamp: () => null,
    });
    const response = await jsonRequest(noFence.app, `${path}/policy/accept`, "POST", {
      expectedPolicyRevision: 1,
      operationId: COMMAND_OPERATION_ID,
    });
    expect(response.status).toBe(409);
  });

  test("maps denials non-enumeratingly and preserves bounded conflict classes", async () => {
    for (const [error, expectedStatus, expectedCode, expectedPublicCode] of [
      [new OrganizationRecoveryDeniedError(), 404, undefined, "not_found"],
      [new OrganizationRecoveryUnavailableError(), 409, "recovery_unavailable", "conflict"],
      [
        new OrganizationRecoveryRevisionConflictError(),
        409,
        "organization_recovery_revision_conflict",
        "conflict",
      ],
      [
        new OrganizationRecoveryOperationReuseError(),
        409,
        "organization_recovery_operation_reuse",
        "idempotency_conflict",
      ],
    ] as const) {
      expect(organizationRecoveryHttpError(error)).toMatchObject({
        status: expectedStatus,
        code: expectedPublicCode,
        retryable: false,
        outcomeUnknown: false,
        ...(expectedCode ? { details: { code: expectedCode } } : { details: undefined }),
      });
      const { app } = harness({
        getOrganizationRecoveryOverview: async () => {
          throw error;
        },
      });
      const response = await jsonRequest(
        app,
        `/v1/organizations/${ORGANIZATION_ID}/recovery`,
        "GET",
      );
      expect(response.status).toBe(expectedStatus);
    }
  });

  test("rejects malformed organization and operation resource identifiers", async () => {
    const { app, calls } = harness();
    const invalidOrganization = await jsonRequest(
      app,
      "/v1/organizations/not-a-uuid/recovery",
      "GET",
    );
    expect(invalidOrganization.status).toBe(422);
    const invalidOperation = await jsonRequest(
      app,
      `/v1/organizations/${ORGANIZATION_ID}/recovery/operations/not-a-uuid/approve`,
      "POST",
      { expectedOperationRevision: 1, operationId: COMMAND_OPERATION_ID },
    );
    expect(invalidOperation.status).toBe(422);
    expect(calls).toEqual([]);
  });
});
