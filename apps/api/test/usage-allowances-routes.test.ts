import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { signDelegatedAccessToken, type AccessContext, type Permission } from "@opengeni/contracts";
import * as db from "@opengeni/db";
import {
  accessGrantAuthorizationFromContext,
  type AccessGrantAuthorization,
  type ApiRouteDeps,
} from "@opengeni/core";
import { testSettings } from "@opengeni/testing";
import { requestBodyValidationHttpError } from "../src/http/request-body";
import {
  registerUsageAllowanceRoutes,
  requireAllowanceAuthority,
} from "../src/routes/usage-allowances";
import { createApp, workspaceActorContextExempt } from "../src/app";

const accountId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const keyId = "33333333-3333-4333-8333-333333333333";
const subjectId = "user:member";
const secret = "usage-allowance-route-delegation-secret";
const path = `/v1/workspaces/${workspaceId}`;
const config = { includedCredits: 1_000_000, period: "monthly" as const, version: 1 };
const usage = {
  period: { start: "2026-09-01T00:00:00Z", end: "2026-10-01T00:00:00Z" },
  workspace: {
    limit: 1_000_000,
    used: 10,
    remaining: 999_990,
    fraction: 0.00001,
    includedCredits: 1_000_000,
    grantsRemaining: 0,
    status: "ok" as const,
    resetsAt: "2026-10-01T00:00:00Z",
  },
  members: [subjectId, "user:other"].map((memberSubjectId) => ({
    subjectId: memberSubjectId,
    externalIdentity: null,
    rule: null,
    version: 0,
    limit: null,
    used: 10,
    remaining: null,
    fraction: null,
    status: "ok" as const,
    resetsAt: "2026-10-01T00:00:00Z",
  })),
  nextCursor: "user:other",
};
const restores: (() => void)[] = [];
afterEach(() => {
  while (restores.length) restores.pop()!();
});
function track<T extends { mockRestore(): void }>(spy: T): T {
  restores.push(() => spy.mockRestore());
  return spy;
}

function app(usageAllowancesEnabled = true, productAccessMode: "managed" | "local" = "managed") {
  const api = new Hono();
  api.onError((error, c) => {
    const mapped = requestBodyValidationHttpError(error) ?? error;
    if (mapped instanceof HTTPException)
      return c.json({ error: { message: mapped.message } }, mapped.status);
    throw error;
  });
  registerUsageAllowanceRoutes(api, {
    settings: testSettings({
      productAccessMode,
      delegationSecret: secret,
      usageAllowancesEnabled,
    }),
    db: new Proxy(
      {},
      {
        get() {
          throw new Error("Unexpected direct DB access");
        },
      },
    ) as never,
    managedAuth: null,
  } as ApiRouteDeps);
  return api;
}

async function bearer(
  permissions: Permission[],
  principalKind: "human_session" | "agent_attempt" | "service" = "human_session",
  subject = subjectId,
  anchorWorkspaceId = workspaceId,
) {
  return `Bearer ${await signDelegatedAccessToken(secret, {
    accountId,
    workspaceId: anchorWorkspaceId,
    subjectId: subject,
    principalKind,
    permissions,
    ...(principalKind === "agent_attempt"
      ? {
          sessionId: crypto.randomUUID(),
          turnId: crypto.randomUUID(),
          attemptId: crypto.randomUUID(),
          executionGeneration: 1,
        }
      : {}),
    exp: Math.floor(Date.now() / 1000) + 3600,
  })}`;
}
function request(
  api: Hono,
  route: string,
  authorization: string | undefined,
  method = "GET",
  body?: unknown,
) {
  return api.request(route, {
    method,
    headers: {
      ...(authorization ? { authorization } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
function storage() {
  track(
    spyOn(db, "withAccountRls").mockImplementation(async (_db, _account, callback) =>
      callback({} as never),
    ),
  );
  track(
    spyOn(db, "getWorkspace").mockResolvedValue({
      id: workspaceId,
      accountId,
      kind: "shared",
    } as never),
  );
  return {
    get: track(spyOn(db, "getWorkspaceAllowance").mockResolvedValue(config)),
    state: track(spyOn(db, "getWorkspaceAllowanceState").mockResolvedValue({ version: 1, config })),
    set: track(spyOn(db, "setWorkspaceAllowance").mockResolvedValue(config)),
    clear: track(spyOn(db, "clearWorkspaceAllowance").mockResolvedValue({ version: 2 })),
    grant: track(
      spyOn(db, "grantWorkspaceCredits").mockResolvedValue({
        operationId: "once",
        credits: 1,
        remaining: 1,
        expiresAt: null,
      }),
    ),
    member: track(
      spyOn(db, "setMemberAllowance").mockResolvedValue({
        subjectId,
        rule: { share: 2 },
        version: 1,
      }),
    ),
    usage: track(spyOn(db, "getWorkspaceUsage").mockResolvedValue(usage)),
  };
}
function organizationKey(
  permissions: Permission[],
  options: {
    accountId?: string;
    workspaceId?: string | null;
    credentialKind?: "organization" | "workspace";
  } = {},
) {
  track(
    spyOn(db, "findActiveApiKeyByHash").mockResolvedValue({
      id: keyId,
      accountId: options.accountId ?? accountId,
      workspaceId: options.workspaceId ?? null,
      credentialKind: options.credentialKind ?? "organization",
      permissions,
      name: "Fixture key",
      description: null,
      prefix: "fixture",
      expiresAt: null,
      revokedAt: null,
      lastUsedAt: null,
      createdAt: "",
      updatedAt: "",
    } as never),
  );
  track(spyOn(db, "getWorkspaceGrant").mockResolvedValue(null));
  track(
    spyOn(db, "requireWorkspace").mockResolvedValue({
      id: workspaceId,
      accountId,
      kind: "shared",
    } as never),
  );
  return "Bearer fixture-key";
}

describe("allowance authorization matrix", () => {
  test("account admins manage shared workspace budgets without acquiring operational workspace access", async () => {
    const spies = storage();
    const api = app();
    const auth = await bearer(
      ["account:admin"],
      "human_session",
      subjectId,
      "88888888-8888-4888-8888-888888888888",
    );
    track(spyOn(db, "getWorkspaceGrant").mockResolvedValue(null));
    track(
      spyOn(db, "requireWorkspace").mockResolvedValue({
        id: workspaceId,
        accountId,
        kind: "shared",
      } as never),
    );
    expect((await request(api, `${path}/allowance`, auth)).status).toBe(200);
    expect((await request(api, `${path}/allowance/state`, auth)).status).toBe(200);
    expect(
      (
        await request(api, `${path}/allowance`, auth, "PUT", {
          includedCredits: 1,
          period: "none",
          expectedVersion: 0,
        })
      ).status,
    ).toBe(200);
    expect(
      (await request(api, `${path}/allowance`, auth, "DELETE", { expectedVersion: 1 })).status,
    ).toBe(200);
    expect(
      (
        await request(api, `${path}/allowance/grants`, auth, "POST", {
          operationId: "once",
          credits: 1,
        })
      ).status,
    ).toBe(200);
    expect(spies.set.mock.calls[0]![1]).toMatchObject({
      accountId,
      workspaceId,
      actorSubjectId: subjectId,
    });
    for (const route of [`${path}/usage`, `${path}/usage/me`]) {
      expect((await request(api, route, auth)).status).toBe(403);
    }
    expect(
      (
        await request(api, `${path}/members/${subjectId}/allowance`, auth, "PUT", {
          rule: null,
          expectedVersion: 0,
        })
      ).status,
    ).toBe(403);
    expect(spies.member).not.toHaveBeenCalled();
    expect(spies.usage).not.toHaveBeenCalled();
    const target = track(
      spyOn(db, "getWorkspace").mockResolvedValue({
        id: workspaceId,
        accountId: "99999999-9999-4999-8999-999999999999",
        kind: "shared",
      } as never),
    );
    expect((await request(api, `${path}/allowance`, auth)).status).toBe(403);
    target.mockResolvedValue({ id: workspaceId, accountId, kind: "personal" } as never);
    expect((await request(api, `${path}/allowance`, auth)).status).toBe(403);
    target.mockResolvedValue({ id: workspaceId, accountId, kind: "shared" } as never);
    const fullApp = createApp({
      settings: testSettings({
        productAccessMode: "managed",
        delegationSecret: secret,
        usageAllowancesEnabled: true,
      }),
      db: {} as never,
      bus: {} as never,
      workflowClient: {} as never,
      managedAuth: null,
    } as never);
    expect(
      (
        await request(fullApp, `${path}/allowance`, auth, "PUT", {
          includedCredits: 1,
          period: "none",
          expectedVersion: 0,
        })
      ).status,
    ).toBe(200);
    expect((await request(fullApp, `${path}/usage`, auth)).status).toBe(403);
    expect((await request(fullApp, `${path}/allowance/state`, auth)).status).toBe(200);
  });

  test("workspace admin reads/configures members but never changes workspace budgets", async () => {
    const spies = storage();
    const api = app();
    const auth = await bearer(["workspace:admin"]);
    expect((await request(api, `${path}/allowance`, auth)).status).toBe(200);
    expect((await request(api, `${path}/allowance/state`, auth)).status).toBe(200);
    expect((await request(api, `${path}/usage`, auth)).status).toBe(200);
    expect(
      (
        await request(
          api,
          `${path}/members/${encodeURIComponent(subjectId)}/allowance`,
          auth,
          "PUT",
          { rule: { share: 2 }, expectedVersion: 0 },
        )
      ).status,
    ).toBe(200);
    for (const [route, method, body] of [
      [`${path}/allowance`, "PUT", { ...config, version: undefined, expectedVersion: 0 }],
      [`${path}/allowance`, "DELETE", { expectedVersion: 1 }],
      [`${path}/allowance/grants`, "POST", { operationId: "once", credits: 1 }],
    ] as const)
      expect((await request(api, route, auth, method, body)).status).toBe(403);
    expect(spies.set).not.toHaveBeenCalled();
    expect(spies.clear).not.toHaveBeenCalled();
    expect(spies.grant).not.toHaveBeenCalled();
  });

  test("verified account admin with target access reads full usage; billing and membership permission cannot", async () => {
    const spies = storage();
    const api = app();
    expect(
      (
        await request(api, `${path}/allowance`, await bearer(["account:admin"]), "PUT", {
          includedCredits: 1_000_000,
          period: "monthly",
          expectedVersion: 0,
        })
      ).status,
    ).toBe(200);
    expect(spies.set.mock.calls[0]![1]).toMatchObject({
      accountId,
      workspaceId,
      actorSubjectId: subjectId,
      actorType: "human_session",
      expectedVersion: 0,
    });
    expect((await request(api, `${path}/usage`, await bearer(["account:admin"]))).status).toBe(200);
    expect(spies.usage.mock.calls[0]![1]).toMatchObject({ accountId, workspaceId });
    for (const permissions of [
      ["billing:manage"],
      ["billing:read"],
      ["members:manage"],
      ["api_keys:manage"],
    ] as Permission[][]) {
      expect(
        (
          await request(api, `${path}/allowance`, await bearer(permissions), "DELETE", {
            expectedVersion: 1,
          })
        ).status,
      ).toBe(403);
    }
    expect(
      (
        await request(
          api,
          `${path}/allowance`,
          await bearer(["account:admin"], "service"),
          "DELETE",
          {
            expectedVersion: 1,
          },
        )
      ).status,
    ).toBe(403);
  });

  test("account admin full reads require a resolver-produced authorization, not a matching shape", () => {
    const context: AccessContext = {
      mode: "managed",
      subjectId,
      accountGrants: [{ accountId, subjectId, permissions: ["account:admin"] }],
      workspaceGrants: [
        {
          accountId,
          workspaceId,
          subjectId,
          principalKind: "human_session",
          permissions: ["workspace:read"],
        },
      ],
    };
    const authorization = accessGrantAuthorizationFromContext(context, context.workspaceGrants[0]!);
    expect(() => requireAllowanceAuthority({ authorization, context }, "read")).not.toThrow();
    expect(() =>
      requireAllowanceAuthority(
        { authorization: { ...authorization } as AccessGrantAuthorization, context },
        "read",
      ),
    ).toThrow("workspace access authorization is invalid");
    const wrongAccount = accessGrantAuthorizationFromContext(
      {
        ...context,
        accountGrants: [{ accountId: keyId, subjectId, permissions: ["account:admin"] }],
      },
      context.workspaceGrants[0]!,
    );
    expect(() =>
      requireAllowanceAuthority({ authorization: wrongAccount, context }, "read"),
    ).toThrow();
  });

  test("an unrelated organization budget lookup miss falls through to normal native target access", async () => {
    const spies = storage();
    const otherAccountId = "44444444-4444-4444-8444-444444444444";
    const anchorId = "88888888-8888-4888-8888-888888888888";
    const context: AccessContext = {
      mode: "local",
      subjectId,
      accountGrants: [
        { accountId: otherAccountId, subjectId, permissions: ["account:admin"] },
        { accountId, subjectId, permissions: ["account:read"] },
      ],
      workspaceGrants: [
        {
          accountId: otherAccountId,
          workspaceId: anchorId,
          subjectId,
          principalKind: "human_session",
          permissions: ["workspace:read"],
        },
        {
          accountId,
          workspaceId,
          subjectId,
          principalKind: "human_session",
          permissions: ["workspace:admin"],
        },
      ],
    };
    track(spyOn(db, "bootstrapWorkspace").mockResolvedValue(context));
    track(spyOn(db, "getWorkspace").mockResolvedValue(null));
    const api = app(true, "local");
    expect((await request(api, `${path}/allowance`, undefined)).status).toBe(200);
    expect((await request(api, `${path}/usage`, undefined)).status).toBe(200);
    expect(spies.get.mock.calls[0]![1]).toMatchObject({ accountId, workspaceId });
    expect(
      (await request(api, `${path}/allowance`, undefined, "DELETE", { expectedVersion: 1 })).status,
    ).toBe(403);
    expect(spies.clear).not.toHaveBeenCalled();
    context.accountGrants[1]!.permissions = ["account:admin"];
    track(
      spyOn(db, "getWorkspace").mockImplementation(async (_db, targetId) =>
        targetId === workspaceId
          ? ({ id: workspaceId, accountId, kind: "personal" } as never)
          : null,
      ),
    );
    expect(
      (await request(api, `${path}/allowance`, undefined, "DELETE", { expectedVersion: 1 })).status,
    ).toBe(403);
    expect(spies.clear).not.toHaveBeenCalled();
  });

  test("agents with all permissions are denied on every read and write", async () => {
    const spies = storage();
    const api = app();
    const auth = await bearer(
      ["account:admin", "workspace:admin", "api_keys:manage"],
      "agent_attempt",
    );
    for (const [route, method, body] of [
      [`${path}/allowance`, "GET", undefined],
      [`${path}/allowance/state`, "GET", undefined],
      [`${path}/usage`, "GET", undefined],
      [`${path}/usage/me`, "GET", undefined],
      [`${path}/allowance`, "PUT", { includedCredits: 1, period: "none", expectedVersion: 0 }],
      [`${path}/allowance`, "DELETE", { expectedVersion: 1 }],
      [`${path}/allowance/grants`, "POST", { operationId: "once", credits: 1 }],
      [`${path}/members/${subjectId}/allowance`, "PUT", { rule: null, expectedVersion: 0 }],
    ] as const)
      expect((await request(api, route, auth, method, body)).status).toBe(403);
    for (const spy of Object.values(spies)) expect(spy).not.toHaveBeenCalled();
  });

  test("member can read only its own usage, never roster or config; machine own reads fail", async () => {
    const spies = storage();
    const api = app();
    const auth = await bearer(["workspace:read"]);
    const response = await request(api, `${path}/usage/me?period=2026-09`, auth);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ members: [usage.members[0]], nextCursor: null });
    expect(spies.usage.mock.calls[0]![1]).toMatchObject({
      accountId,
      workspaceId,
      subjectId,
      period: "2026-09",
    });
    expect((await request(api, `${path}/usage`, auth)).status).toBe(403);
    expect((await request(api, `${path}/allowance`, auth)).status).toBe(403);
    expect((await request(api, `${path}/allowance/state`, auth)).status).toBe(403);
    for (const principal of ["service"] as const) {
      expect(
        (await request(api, `${path}/usage/me`, await bearer(["workspace:admin"], principal)))
          .status,
      ).toBe(403);
    }
    expect(
      (await request(api, `${path}/usage/me`, organizationKey(["workspace:admin"]))).status,
    ).toBe(403);
  });

  test("asUser reads only its own usage and cannot borrow its backing organization key", async () => {
    const spies = storage();
    const api = app();
    const externalSubject = "external_user:55555555-5555-4555-8555-555555555555";
    const auth = organizationKey(["account:read", "workspace:admin", "api_keys:manage"]);
    track(
      spyOn(db, "ensureExternalIdentity").mockResolvedValue({
        id: "55555555-5555-4555-8555-555555555555",
        accountId,
        subjectId: externalSubject,
        source: "product",
        externalId: "Person",
        personalWorkspaceId: "66666666-6666-4666-8666-666666666666",
        organizationMembershipId: "77777777-7777-4777-8777-777777777777",
        authorizationRevision: 1,
      } as never),
    );
    track(
      spyOn(db, "withWorkspaceSubjectRls").mockImplementation(
        async (_db, _workspace, _subject, callback) => callback({} as never),
      ),
    );
    track(
      spyOn(db, "getWorkspaceGrant").mockResolvedValue({
        accountId,
        workspaceId,
        subjectId: externalSubject,
        principalKind: "human_session",
        permissions: ["workspace:read"],
      }),
    );
    spies.usage.mockResolvedValue({
      ...usage,
      members: [{ ...usage.members[0]!, subjectId: externalSubject }, usage.members[1]!],
    });
    const headers = {
      authorization: auth,
      "x-opengeni-external-actor": encodeURIComponent(
        JSON.stringify({
          mode: "external",
          identity: { source: "product", externalId: "Person" },
        }),
      ),
    };
    const response = await api.request(`${path}/usage/me`, { headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      members: [{ subjectId: externalSubject }],
      nextCursor: null,
    });
    expect(spies.usage.mock.calls[0]![1]).toMatchObject({ subjectId: externalSubject });
    for (const [route, method, body] of [
      [`${path}/allowance`, "PUT", { includedCredits: 1, period: "none", expectedVersion: 0 }],
      [`${path}/allowance`, "DELETE", { expectedVersion: 1 }],
      [`${path}/allowance/grants`, "POST", { operationId: "once", credits: 1 }],
      [`${path}/members/${subjectId}/allowance`, "PUT", { rule: null, expectedVersion: 0 }],
    ] as const) {
      expect(
        (
          await api.request(route, {
            method,
            headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify(body),
          })
        ).status,
      ).toBe(403);
    }
    expect((await api.request(`${path}/usage`, { headers })).status).toBe(403);
    expect((await api.request(`${path}/allowance`, { headers })).status).toBe(403);
    expect((await api.request(`${path}/allowance/state`, { headers })).status).toBe(403);
    expect(spies.set).not.toHaveBeenCalled();
    expect(spies.clear).not.toHaveBeenCalled();
    expect(spies.grant).not.toHaveBeenCalled();
    expect(spies.member).not.toHaveBeenCalled();
    track(
      spyOn(db, "withAccountRls").mockImplementation(async (_db, _account, callback) =>
        callback({} as never),
      ),
    );
    track(
      spyOn(db, "findWorkspaceByExternalIdentity").mockResolvedValue({ id: workspaceId } as never),
    );
    expect(
      (await api.request("/v1/workspaces/external/host/customer/usage/me", { headers })).status,
    ).toBe(200);
  });

  test("workspace keys and account-admin-only callers cannot administer members", async () => {
    storage();
    const api = app();
    const auth = organizationKey(["workspace:admin", "api_keys:manage"], {
      workspaceId,
      credentialKind: "workspace",
    });
    expect(
      (
        await request(api, `${path}/allowance`, auth, "PUT", {
          includedCredits: 1,
          period: "none",
          expectedVersion: 0,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(api, `${path}/members/${subjectId}/allowance`, auth, "PUT", {
          rule: { share: 1 },
          expectedVersion: 0,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(
          api,
          `${path}/members/${subjectId}/allowance`,
          await bearer(["account:admin"]),
          "PUT",
          { rule: null, expectedVersion: 0 },
        )
      ).status,
    ).toBe(403);
  });

  test("full organization key follows key-control for budgets; read key reads without billing", async () => {
    const spies = storage();
    const api = app();
    const auth = organizationKey(["account:read", "workspace:admin", "api_keys:manage"]);
    expect(
      (
        await request(api, `${path}/allowance`, auth, "PUT", {
          includedCredits: 1,
          period: "none",
          expectedVersion: 0,
        })
      ).status,
    ).toBe(200);
    expect(
      (await request(api, `${path}/allowance`, auth, "DELETE", { expectedVersion: 1 })).status,
    ).toBe(200);
    expect(
      (
        await request(api, `${path}/allowance/grants`, auth, "POST", {
          operationId: "once",
          credits: 1,
        })
      ).status,
    ).toBe(200);
    expect(spies.grant.mock.calls[0]![1]).toMatchObject({ actorSubjectId: `api_key:${keyId}` });
  });

  test("organization read key cannot mutate, and full keys without key-control cannot change budgets", async () => {
    const spies = storage();
    const api = app();
    let auth = organizationKey(["account:read", "workspace:read", "sessions:read"]);
    expect((await request(api, `${path}/usage`, auth)).status).toBe(200);
    expect((await request(api, `${path}/allowance`, auth)).status).toBe(200);
    expect((await request(api, `${path}/allowance/state`, auth)).status).toBe(200);
    expect(
      (
        await request(api, `${path}/allowance/grants`, auth, "POST", {
          operationId: "once",
          credits: 1,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(api, `${path}/members/${subjectId}/allowance`, auth, "PUT", {
          rule: null,
          expectedVersion: 0,
        })
      ).status,
    ).toBe(403);
    auth = organizationKey(["workspace:admin"]);
    expect(
      (await request(api, `${path}/allowance`, auth, "DELETE", { expectedVersion: 1 })).status,
    ).toBe(403);
    expect(spies.clear).not.toHaveBeenCalled();
  });

  test("wrong-organization keys and forged organization-key subjects are denied", async () => {
    storage();
    const api = app();
    const auth = organizationKey(["account:admin", "workspace:admin", "api_keys:manage"], {
      accountId: "44444444-4444-4444-8444-444444444444",
    });
    expect((await request(api, `${path}/usage`, auth)).status).toBe(403);
    expect(
      (
        await request(
          api,
          `${path}/allowance`,
          await bearer(
            ["account:admin", "workspace:admin", "api_keys:manage"],
            "human_session",
            `api_key:${keyId}`,
          ),
          "DELETE",
          { expectedVersion: 1 },
        )
      ).status,
    ).toBe(403);
  });
});

describe("allowance HTTP contract", () => {
  test("default-off activation blocks producers on native and external mirrors without touching storage", async () => {
    const spies = storage();
    const api = app(false);
    const auth = organizationKey(["account:read", "workspace:admin", "api_keys:manage"]);
    track(
      spyOn(db, "withAccountRls").mockImplementation(async (_db, _account, callback) =>
        callback({} as never),
      ),
    );
    track(
      spyOn(db, "findWorkspaceByExternalIdentity").mockResolvedValue({ id: workspaceId } as never),
    );
    for (const base of [path, "/v1/workspaces/external/host/customer"]) {
      for (const [suffix, method, body] of [
        ["/allowance", "PUT", { includedCredits: 1, period: "none", expectedVersion: 0 }],
        ["/allowance/grants", "POST", { operationId: "once", credits: 1 }],
        [`/members/${subjectId}/allowance`, "PUT", { rule: { share: 2 }, expectedVersion: 0 }],
        [
          "/members/external/host/one/allowance",
          "PUT",
          { rule: { credits: 1 }, expectedVersion: 0 },
        ],
      ] as const) {
        expect((await request(api, `${base}${suffix}`, auth, method, body)).status).toBe(409);
      }
    }
    expect(spies.set).not.toHaveBeenCalled();
    expect(spies.grant).not.toHaveBeenCalled();
    expect(spies.member).not.toHaveBeenCalled();
    expect(spies.usage).not.toHaveBeenCalled();
  });

  test("activation off preserves reads, exact-version clear, member-null recovery and authorization", async () => {
    const spies = storage();
    const api = app(false);
    const auth = await bearer(["workspace:admin", "account:admin"]);
    expect((await request(api, `${path}/allowance`, auth)).status).toBe(200);
    expect((await request(api, `${path}/allowance/state`, auth)).status).toBe(200);
    expect((await request(api, `${path}/usage`, auth)).status).toBe(200);
    expect((await request(api, `${path}/usage/me`, auth)).status).toBe(200);
    expect(
      (await request(api, `${path}/allowance`, auth, "DELETE", { expectedVersion: 1 })).status,
    ).toBe(200);
    expect(
      (
        await request(api, `${path}/members/${subjectId}/allowance`, auth, "PUT", {
          rule: null,
          expectedVersion: 1,
        })
      ).status,
    ).toBe(200);
    expect(spies.clear).toHaveBeenCalledTimes(1);
    expect(spies.member).toHaveBeenCalledTimes(1);
    expect(
      (
        await request(api, `${path}/allowance`, await bearer(["workspace:admin"]), "PUT", {
          includedCredits: 1,
          period: "none",
          expectedVersion: 0,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(api, `${path}/allowance`, auth, "PUT", {
          includedCredits: -1,
          period: "none",
          expectedVersion: 0,
        })
      ).status,
    ).toBe(400);
  });

  test("full app registers exact external-tenant mirrors without confusing external for a workspace id", async () => {
    storage();
    const auth = organizationKey(["account:read", "workspace:admin", "api_keys:manage"]);
    track(
      spyOn(db, "withAccountRls").mockImplementation(async (_db, _account, callback) =>
        callback({} as never),
      ),
    );
    track(
      spyOn(db, "findWorkspaceByExternalIdentity").mockResolvedValue({ id: workspaceId } as never),
    );
    const fullApp = createApp({
      settings: testSettings({
        productAccessMode: "managed",
        delegationSecret: secret,
        usageAllowancesEnabled: true,
      }),
      db: {} as never,
      bus: {} as never,
      workflowClient: {} as never,
      managedAuth: null,
    } as never);
    expect(
      (await request(fullApp, "/v1/workspaces/external/host/customer/allowance", auth)).status,
    ).toBe(200);
    expect(
      (await request(fullApp, "/v1/workspaces/external/host/customer/allowance/state", auth))
        .status,
    ).toBe(200);
    for (const [method, suffix] of [
      ["GET", "/allowance"],
      ["GET", "/allowance/state"],
      ["PUT", "/allowance"],
      ["DELETE", "/allowance"],
      ["POST", "/allowance/grants"],
      ["GET", "/usage"],
      ["GET", "/usage/me"],
      ["PUT", "/members/user%3Aone/allowance"],
      ["PUT", "/members/external/host/one/allowance"],
    ] as const)
      expect(
        workspaceActorContextExempt(method, `/v1/workspaces/external/host/customer${suffix}`),
      ).toBe(true);
    expect(workspaceActorContextExempt("POST", "/v1/workspaces/external/host/customer/usage")).toBe(
      false,
    );
    expect(
      workspaceActorContextExempt("GET", "/v1/workspaces/external/host/customer/sessions"),
    ).toBe(false);
    expect(workspaceActorContextExempt("GET", `${path}/allowance/state`)).toBe(true);
    expect(workspaceActorContextExempt("PUT", `${path}/allowance/state`)).toBe(false);
    expect(
      workspaceActorContextExempt("POST", "/v1/workspaces/external/host/customer/allowance/state"),
    ).toBe(false);
  });

  test("requires authentication before all storage access", async () => {
    const spies = storage();
    const api = app();
    track(spyOn(db, "findActiveApiKeyByHash").mockResolvedValue(null));
    expect((await request(api, `${path}/allowance`, undefined)).status).toBe(401);
    expect((await request(api, `${path}/allowance/state`, undefined)).status).toBe(401);
    for (const spy of Object.values(spies)) expect(spy).not.toHaveBeenCalled();
  });

  test("validates CAS, amounts, period/page inputs and own selectors", async () => {
    const spies = storage();
    const api = app();
    const auth = await bearer(["account:admin", "workspace:admin"]);
    for (const body of [
      { includedCredits: 1, period: "monthly" },
      { includedCredits: 1.2, period: "monthly", expectedVersion: 0 },
      { includedCredits: 1, period: "monthly", expectedVersion: -1 },
    ]) {
      expect((await request(api, `${path}/allowance`, auth, "PUT", body)).status).toBe(400);
    }
    expect(
      (await request(api, `${path}/allowance`, auth, "DELETE", { expectedVersion: 0 })).status,
    ).toBe(400);
    for (const operationId of ["", " ", "é".repeat(129)])
      expect(
        (
          await request(api, `${path}/allowance`, auth, "DELETE", {
            expectedVersion: 1,
            operationId,
          })
        ).status,
      ).toBe(400);
    for (const query of [
      "period=2026-13",
      "limit=0",
      "limit=201",
      "limit=1.5",
      "subjectId=other",
    ]) {
      expect((await request(api, `${path}/usage?${query}`, auth)).status).toBe(400);
    }
    for (const query of ["subjectId=other", "cursor=other", "limit=1"]) {
      expect((await request(api, `${path}/usage/me?${query}`, auth)).status).toBe(400);
    }
    expect(spies.set).not.toHaveBeenCalled();
    expect(spies.usage).not.toHaveBeenCalled();
  });

  test("reads nullable config and forwards pagination without changing ledger units", async () => {
    const spies = storage();
    const api = app();
    const auth = await bearer(["workspace:admin"]);
    spies.get.mockResolvedValue(null);
    expect(await (await request(api, `${path}/allowance`, auth)).json()).toBeNull();
    for (const version of [0, 2]) {
      spies.state.mockResolvedValue({ version, config: null });
      expect(await (await request(api, `${path}/allowance/state`, auth)).json()).toEqual({
        version,
        config: null,
      });
    }
    const response = await request(
      api,
      `${path}/usage?period=2026-09&limit=20&cursor=user%3Afirst`,
      auth,
    );
    expect(await response.json()).toEqual(usage);
    expect(spies.usage.mock.calls[0]![1]).toMatchObject({
      period: "2026-09",
      limit: 20,
      cursor: "user:first",
    });
  });

  test("CAS, grant conflicts and missing-member errors have stable HTTP status", async () => {
    const spies = storage();
    const api = app();
    const auth = await bearer(["account:admin", "workspace:admin"]);
    spies.set.mockRejectedValue(new db.UsageAllowanceVersionConflictError());
    expect(
      (
        await request(api, `${path}/allowance`, auth, "PUT", {
          includedCredits: 1,
          period: "monthly",
          expectedVersion: 0,
        })
      ).status,
    ).toBe(409);
    spies.grant.mockRejectedValue(Object.assign(new Error("conflict"), { code: "23505" }));
    expect(
      (
        await request(api, `${path}/allowance/grants`, auth, "POST", {
          operationId: "once",
          credits: 1,
        })
      ).status,
    ).toBe(409);
    spies.member.mockRejectedValue(Object.assign(new Error("missing"), { code: "P0002" }));
    expect(
      (
        await request(api, `${path}/members/${subjectId}/allowance`, auth, "PUT", {
          rule: null,
          expectedVersion: 0,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await request(api, `${path}/members/nonexistent/allowance`, auth, "PUT", {
          rule: null,
          expectedVersion: 0,
        })
      ).status,
    ).toBe(404);
    expect(spies.member).toHaveBeenCalledTimes(2);
  });

  test("clear forwards an optional exact operation key and preserves the version receipt", async () => {
    const spies = storage();
    const api = app();
    const auth = await bearer(["account:admin", "workspace:read"]);
    const body = { expectedVersion: 1, operationId: "clear/once" };
    expect(await (await request(api, `${path}/allowance`, auth, "DELETE", body)).json()).toEqual({
      version: 2,
    });
    expect(spies.clear.mock.calls[0]![1]).toEqual({
      accountId,
      workspaceId,
      actorSubjectId: subjectId,
      actorType: "human_session",
      ...body,
    });
    spies.clear.mockRejectedValue(new db.UsageAllowanceVersionConflictError());
    expect((await request(api, `${path}/allowance`, auth, "DELETE", body)).status).toBe(409);
  });

  test("only defined methods dispatch", async () => {
    const spies = storage();
    const api = app();
    const auth = await bearer(["account:admin", "workspace:admin"]);
    for (const [route, method] of [
      [`${path}/allowance`, "POST"],
      [`${path}/allowance`, "PATCH"],
      [`${path}/allowance/state`, "PUT"],
      [`${path}/allowance/state`, "POST"],
      [`${path}/allowance/grants`, "GET"],
      [`${path}/allowance/grants`, "PUT"],
      [`${path}/usage`, "POST"],
      [`${path}/usage/me`, "PUT"],
      [`${path}/members/${subjectId}/allowance`, "GET"],
      [`${path}/members/${subjectId}/allowance`, "DELETE"],
    ] as const)
      expect((await request(api, route, auth, method)).status).toBe(404);
    for (const spy of Object.values(spies)) expect(spy).not.toHaveBeenCalled();
  });

  test("external member mutations forward exact identity to one atomic command; tenant mirrors stay organization scoped", async () => {
    const spies = storage();
    const api = app();
    const auth = organizationKey(["account:read", "workspace:admin", "api_keys:manage"]);
    expect(
      (
        await request(
          api,
          `${path}/members/external/product/Person%2FCase/allowance`,
          auth,
          "PUT",
          { rule: { share: 2 }, expectedVersion: 0 },
        )
      ).status,
    ).toBe(200);
    expect(spies.usage).not.toHaveBeenCalled();
    expect(spies.member.mock.calls[0]![1]).toMatchObject({
      accountId,
      workspaceId,
      actorSubjectId: `api_key:${keyId}`,
      actorType: "api_key",
      externalIdentity: { source: "product", externalId: "Person/Case" },
    });
    expect(spies.member.mock.calls[0]![1]).not.toHaveProperty("subjectId");
    spies.member.mockRejectedValue(Object.assign(new Error("missing"), { code: "P0002" }));
    expect(
      (
        await request(api, `${path}/members/external/product/missing/allowance`, auth, "PUT", {
          rule: null,
          expectedVersion: 0,
        })
      ).status,
    ).toBe(404);
    const scope = track(
      spyOn(db, "withAccountRls").mockImplementation(async (_db, _account, callback) =>
        callback({} as never),
      ),
    );
    const find = track(
      spyOn(db, "findWorkspaceByExternalIdentity").mockResolvedValue({ id: workspaceId } as never),
    );
    expect(
      (await request(api, "/v1/workspaces/external/product/Tenant%2FCase/allowance", auth)).status,
    ).toBe(200);
    expect(scope.mock.calls[0]![1]).toBe(accountId);
    expect(find.mock.calls[0]![1]).toEqual({
      accountId,
      externalSource: "product",
      externalId: "Tenant/Case",
    });
  });

  test("workspace admins resolve external members atomically without roster reads or identity provisioning", async () => {
    const spies = storage();
    const api = app();
    const auth = await bearer(["workspace:admin"]);
    const externalSubject = "external_user:55555555-5555-4555-8555-555555555555";
    spies.member.mockResolvedValue({
      subjectId: externalSubject,
      rule: { credits: 10 },
      version: 1,
    });
    const roster = track(
      spyOn(db, "listWorkspaceMembers").mockImplementation(async () => {
        throw new Error("Roster must not be read");
      }),
    );
    const provision = track(
      spyOn(db, "ensureExternalIdentity").mockImplementation(async () => {
        throw new Error("Identity must not be provisioned");
      }),
    );
    expect(
      (
        await request(
          api,
          `${path}/members/external/host/Case%2FSensitive/allowance`,
          auth,
          "PUT",
          { rule: { credits: 10 }, expectedVersion: 0 },
        )
      ).status,
    ).toBe(200);
    expect(spies.usage).not.toHaveBeenCalled();
    expect(roster).not.toHaveBeenCalled();
    expect(provision).not.toHaveBeenCalled();
    expect(spies.member.mock.calls[0]![1]).toMatchObject({
      externalIdentity: { source: "host", externalId: "Case/Sensitive" },
      rule: { credits: 10 },
    });
  });
});
