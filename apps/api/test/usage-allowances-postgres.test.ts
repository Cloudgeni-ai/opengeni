import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { signDelegatedAccessToken, type Permission } from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  bootstrapWorkspace,
  createDb,
  createOrganizationApiKey,
  ensureExternalIdentity,
} from "@opengeni/db";
import { OpenGeniClient } from "@opengeni/sdk";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { requestBodyValidationHttpError } from "../src/http/request-body";
import { registerUsageAllowanceRoutes } from "../src/routes/usage-allowances";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
const secret = "allowance-api-postgres-delegation-secret";

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("usage-allowances-api");
  if (!acquired) throw new Error("Allowance API verification requires PostgreSQL");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function fixture() {
  const subjectId = `user:allowance-api:${crypto.randomUUID()}`;
  const externalId = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "allowance-api-test",
    accountExternalId: crypto.randomUUID(),
    accountName: "Allowance API",
    workspaceExternalSource: "allowance-api-test",
    workspaceExternalId: externalId,
    workspaceName: "Allowance API",
    subjectId,
  });
  const grant = access.workspaceGrants[0]!;
  const personalId = crypto.randomUUID();
  await shared.admin`insert into workspaces(id,account_id,name)
    values(${personalId},${grant.accountId},'Personal')`;
  await shared.admin`insert into organization_memberships
    (account_id,subject_id,role,status,personal_workspace_id)
    values(${grant.accountId},${subjectId},'owner','active',${personalId})`;
  return {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId,
    externalId,
  };
}

function api() {
  const app = new Hono();
  app.onError((error, c) => {
    const mapped = requestBodyValidationHttpError(error) ?? error;
    if (mapped instanceof HTTPException)
      return c.json({ error: { message: mapped.message } }, mapped.status);
    throw error;
  });
  registerUsageAllowanceRoutes(app, {
    db: client.db,
    settings: testSettings({
      productAccessMode: "managed",
      delegationSecret: secret,
      usageAllowancesEnabled: true,
    }),
    managedAuth: null,
  } as ApiRouteDeps);
  return app;
}

async function bearer(
  scope: Awaited<ReturnType<typeof fixture>>,
  permissions: Permission[],
  principalKind: "human_session" | "agent_attempt" = "human_session",
) {
  return await signDelegatedAccessToken(secret, {
    accountId: scope.accountId,
    workspaceId: scope.workspaceId,
    subjectId: scope.subjectId,
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
  });
}

async function key(scope: Awaited<ReturnType<typeof fixture>>) {
  const token = crypto.randomUUID();
  const stored = await createOrganizationApiKey(client.db, {
    accountId: scope.accountId,
    name: "Allowance API replay",
    prefix: "test",
    keyHash: createHash("sha256").update(token).digest("hex"),
    permissions: ["account:read", "workspace:admin", "api_keys:manage"],
  });
  return { token, id: stored.id };
}

function sdk(app: Hono, token: string) {
  return new OpenGeniClient({
    baseUrl: "http://allowance.test",
    apiKey: token,
    fetch: (input, init) => app.request(new Request(input, init)),
  });
}

describe("allowance API PostgreSQL recovery", () => {
  test("lost clear response replays exactly, exposes tombstone CAS, and rejects after recreation", async () => {
    const scope = await fixture();
    const app = api();
    const token = await bearer(scope, ["account:admin", "workspace:read"]);
    let loseClearResponse = true;
    const native = new OpenGeniClient({
      baseUrl: "http://allowance.test",
      apiKey: token,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const response = await app.request(request);
        if (request.method === "DELETE" && loseClearResponse) {
          loseClearResponse = false;
          expect(response.status, await response.clone().text()).toBe(200);
          throw new TypeError("clear committed but its response was lost");
        }
        return response;
      },
    });
    expect(await native.getWorkspaceAllowanceState(scope.workspaceId)).toEqual({
      version: 0,
      config: null,
    });
    expect(await native.getWorkspaceAllowance(scope.workspaceId)).toBeNull();
    await native.setWorkspaceAllowance(scope.workspaceId, {
      includedCredits: 100,
      period: "none",
      expectedVersion: 0,
    });
    // Verified account admin plus a non-admin target grant admits full usage.
    expect((await native.getUsage(scope.workspaceId)).members).toHaveLength(1);
    const clear = { expectedVersion: 1, operationId: "native/clear" };
    await expect(native.clearWorkspaceAllowance(scope.workspaceId, clear)).rejects.toMatchObject({
      outcomeUnknown: true,
    });
    expect(await native.getWorkspaceAllowance(scope.workspaceId)).toBeNull();
    expect(await native.getWorkspaceAllowanceState(scope.workspaceId)).toEqual({
      version: 2,
      config: null,
    });
    expect(await native.clearWorkspaceAllowance(scope.workspaceId, clear)).toEqual({ version: 2 });
    await expect(
      native.clearWorkspaceAllowance(scope.workspaceId, { ...clear, expectedVersion: 2 }),
    ).rejects.toMatchObject({ status: 409 });
    const otherActor = await key(scope);
    await expect(
      sdk(app, otherActor.token).clearWorkspaceAllowance(scope.workspaceId, clear),
    ).rejects.toMatchObject({ status: 409 });
    const recreated = await native.setWorkspaceAllowance(scope.workspaceId, {
      includedCredits: 200,
      period: "none",
      expectedVersion: (await native.getWorkspaceAllowanceState(scope.workspaceId)).version,
    });
    expect(recreated.version).toBe(3);
    await expect(native.clearWorkspaceAllowance(scope.workspaceId, clear)).rejects.toMatchObject({
      status: 409,
    });
    expect(await native.getWorkspaceAllowanceState(scope.workspaceId)).toEqual({
      version: 3,
      config: recreated,
    });
  }, 60_000);

  test("organization clear replay rechecks current key authority on native and external mirrors", async () => {
    const scope = await fixture();
    const app = api();
    const actor = await key(scope);
    const service = sdk(app, actor.token);
    await service.setWorkspaceAllowance(scope.workspaceId, {
      includedCredits: 100,
      period: "none",
      expectedVersion: 0,
    });
    const clear = { expectedVersion: 1, operationId: "service/clear" };
    expect(await service.clearWorkspaceAllowance(scope.workspaceId, clear)).toEqual({ version: 2 });
    const mirror = `/v1/workspaces/external/allowance-api-test/${scope.externalId}`;
    const headers = { authorization: `Bearer ${actor.token}` };
    const response = await app.request(`${mirror}/allowance/state`, { headers });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toEqual({ version: 2, config: null });
    expect(await service.clearWorkspaceAllowance(scope.workspaceId, clear)).toEqual({ version: 2 });
    await shared.admin`update api_keys set permissions='["workspace:read"]'::jsonb
      where id=${actor.id}`;
    await expect(service.clearWorkspaceAllowance(scope.workspaceId, clear)).rejects.toMatchObject({
      status: 403,
    });
    const refused = await app.request(`${mirror}/allowance`, {
      method: "DELETE",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(clear),
    });
    expect(refused.status).toBe(403);
    expect(await service.getWorkspaceAllowanceState(scope.workspaceId)).toEqual({
      version: 2,
      config: null,
    });
  }, 60_000);

  test("asUser cannot borrow key budgets or roster; agents cannot access any allowance route", async () => {
    const scope = await fixture();
    const app = api();
    const actor = await key(scope);
    const identity = await ensureExternalIdentity(client.db, {
      accountId: scope.accountId,
      source: "product",
      externalId: "member",
    });
    await shared.admin`insert into workspace_memberships
      (account_id,workspace_id,subject_id,permissions)
      values(${scope.accountId},${scope.workspaceId},${identity.subjectId},'["workspace:read"]'::jsonb)`;
    const service = sdk(app, actor.token);
    await service.setWorkspaceAllowance(scope.workspaceId, {
      includedCredits: 100,
      period: "none",
      expectedVersion: 0,
    });
    const external = service.asUser("member", { source: "product" });
    expect(
      (await external.getMyUsage(scope.workspaceId)).members.map((row) => row.subjectId),
    ).toEqual([identity.subjectId]);
    const externalHeaders = {
      authorization: `Bearer ${actor.token}`,
      "x-opengeni-external-actor": encodeURIComponent(
        JSON.stringify({ mode: "external", identity: { source: "product", externalId: "member" } }),
      ),
    };
    const agent = await bearer(
      scope,
      ["account:admin", "workspace:admin", "api_keys:manage"],
      "agent_attempt",
    );
    for (const base of [
      `/v1/workspaces/${scope.workspaceId}`,
      `/v1/workspaces/external/allowance-api-test/${scope.externalId}`,
    ]) {
      for (const [suffix, method, body] of [
        ["/allowance", "GET", undefined],
        ["/allowance/state", "GET", undefined],
        ["/usage", "GET", undefined],
        ["/allowance", "PUT", { includedCredits: 1, period: "none", expectedVersion: 1 }],
        ["/allowance", "DELETE", { expectedVersion: 1, operationId: "forbidden" }],
        ["/allowance/grants", "POST", { credits: 1, operationId: "forbidden" }],
        [`/members/${scope.subjectId}/allowance`, "PUT", { rule: null, expectedVersion: 0 }],
        ["/members/external/product/member/allowance", "PUT", { rule: null, expectedVersion: 0 }],
      ] as const) {
        for (const headers of [externalHeaders, { authorization: `Bearer ${agent}` }]) {
          const response = await app.request(`${base}${suffix}`, {
            method,
            headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) },
            ...(body ? { body: JSON.stringify(body) } : {}),
          });
          expect(
            response.status,
            `${method} ${base}${suffix}: ${await response.clone().text()}`,
          ).toBe(403);
        }
      }
      expect(
        (await app.request(`${base}/usage/me`, { headers: { authorization: `Bearer ${agent}` } }))
          .status,
      ).toBe(403);
    }
    expect((await service.getWorkspaceAllowanceState(scope.workspaceId)).version).toBe(1);
  }, 60_000);
});
