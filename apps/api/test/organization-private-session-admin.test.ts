import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  createDb,
  createOrganizationApiKey,
  getOrganizationPrivateSessionSettings,
  updateOrganizationPrivateSessionSettings,
  nestedPostgresSqlState,
  type DbClient,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import type { ApiRouteDeps } from "@opengeni/core";
import { organizationApiKeyPermissionsForAccess } from "../src/routes/api-keys";
import { registerOrganizationMembershipRoutes } from "../src/routes/organization-memberships";

let shared: SharedTestDatabase;
let db: DbClient;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("organization-private-session-admin");
  if (!acquired) throw new Error("Private-session administration tests require PostgreSQL");
  shared = acquired;
  db = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await db?.close();
  await shared?.release();
});

test("organization admin keys manage private-session settings without a human membership", async () => {
  const [account] =
    await shared.admin`insert into managed_accounts (name) values ('Private session fixture') returning id`;
  const [other] =
    await shared.admin`insert into managed_accounts (name) values ('Other fixture') returning id`;
  const token = crypto.randomUUID();
  const key = await createOrganizationApiKey(db.db, {
    accountId: account!.id,
    name: "Organization administrator",
    prefix: "test",
    keyHash: createHash("sha256").update(token).digest("hex"),
    permissions: organizationApiKeyPermissionsForAccess("full"),
  });
  const app = new Hono();
  app.onError((error, c) => {
    if (error instanceof HTTPException) return c.json({ message: error.message }, error.status);
    throw error;
  });
  registerOrganizationMembershipRoutes(app, {
    db: db.db,
    settings: testSettings({
      databaseUrl: shared.appUrl,
      productAccessMode: "managed",
    }),
    bus: new MemoryEventBus(),
  } as unknown as ApiRouteDeps);
  const endpoint = `/v1/organizations/${account!.id}/private-session-settings`;
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
  const patch = (body: object) =>
    app.request(endpoint, {
      method: "PATCH",
      headers,
      body: JSON.stringify(body),
    });
  const initial = await app.request(endpoint, { headers });
  expect(initial.status).toBe(200);
  expect(await initial.json()).toMatchObject({
    enabled: false,
    available: false,
    version: 0,
  });
  expect(
    (await app.request(`/v1/organizations/${other!.id}/private-session-settings`, { headers }))
      .status,
  ).toBe(403);
  const operation = {
    enabled: true,
    expectedVersion: 0,
    operationId: crypto.randomUUID(),
  };
  expect((await patch(operation)).status).toBe(409);
  await shared.admin`insert into session_tenancy_activations (account_id, activation_version, inventory_digest, parity_digest, activated_by)
    values (${account!.id}, 1, ${"3".repeat(64)}, ${"4".repeat(64)}, 'private-session-admin-test')`;
  const enabled = await patch(operation);
  expect(enabled.status).toBe(200);
  const result = await enabled.json();
  expect(result).toMatchObject({
    enabled: true,
    available: true,
    version: 1,
    changed: true,
  });
  const replay = await patch(operation);
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual(result);
  expect((await patch({ ...operation, enabled: false })).status).toBe(409);
  expect((await patch({ ...operation, operationId: crypto.randomUUID() })).status).toBe(409);
  const competing = await Promise.all([
    patch({ enabled: false, expectedVersion: 1, operationId: crypto.randomUUID() }),
    patch({ enabled: false, expectedVersion: 1, operationId: crypto.randomUUID() }),
  ]);
  expect(competing.map((response) => response.status).sort()).toEqual([200, 409]);
  const restrictedToken = crypto.randomUUID();
  await createOrganizationApiKey(db.db, {
    accountId: account!.id,
    name: "Read-only organization key",
    prefix: "test",
    keyHash: createHash("sha256").update(restrictedToken).digest("hex"),
    permissions: ["workspace:read"],
  });
  expect(
    (
      await app.request(endpoint, {
        headers: { authorization: `Bearer ${restrictedToken}` },
      })
    ).status,
  ).toBe(403);
  await shared.admin`update api_keys set revoked_at = now() where id = ${key.id}`;
  expect((await app.request(endpoint, { headers })).status).not.toBe(200);
  expect((await patch(operation)).status).not.toBe(200);
  // Simulate a key revoked after API authentication: the DB must still deny it.
  const scope = { organizationId: account!.id, actorSubjectId: `api_key:${key.id}` };
  for (const run of [
    () => getOrganizationPrivateSessionSettings(db.db, scope),
    () => updateOrganizationPrivateSessionSettings(db.db, { ...scope, ...operation }),
  ]) {
    let failure: unknown;
    try {
      await run();
    } catch (error) {
      failure = error;
    }
    expect(nestedPostgresSqlState(failure)).toBe("42501");
  }
});
