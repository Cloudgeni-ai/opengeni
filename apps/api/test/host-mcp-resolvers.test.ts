import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { OpenGeniClient } from "@opengeni/sdk";
import { signDelegatedAccessToken } from "@opengeni/contracts";
import { type ApiRouteDeps } from "@opengeni/core";
import { createNativeRemoteMcpCredentialsPort } from "@opengeni/core/remote-mcp-credentials";
import {
  buildHostGatewayConnectionTokenResolver,
  createDb,
  createApiKey,
  createOrganizationApiKey,
  createWorkspace,
  ensureExternalIdentity,
  mutateHostMcpResolver,
  type DbClient,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { registerHostMcpResolverRoutes } from "../src/routes/host-mcp-resolvers";
import { registerWorkspaceRoutes } from "../src/routes/workspaces";
import { assertRuntimeDatabasePosture } from "@opengeni/db";

let shared: SharedTestDatabase;
let db: DbClient;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("host-resolver-public");
  if (!acquired) throw new Error("Host resolver regressions require PostgreSQL");
  shared = acquired;
  db = createDb(shared.appUrl);
  await assertRuntimeDatabasePosture(db.db, { rlsStrategy: "force" });
}, 180_000);
afterAll(async () => {
  await db?.close();
  await shared?.release();
});

test("public organization administration routes two future instances and fences rotation/revocation without restoring replayed secrets", async () => {
  const [account] =
    await shared.admin`insert into managed_accounts (name) values ('Resolver fixtures') returning id`;
  const accountId = account!.id as string;
  const token = crypto.randomUUID();
  const key = await createOrganizationApiKey(db.db, {
    accountId,
    name: "Resolver admin",
    prefix: "test",
    keyHash: createHash("sha256").update(token).digest("hex"),
    permissions: ["account:admin", "workspace:create", "workspace:read"],
  });
  const settings = testSettings({
    databaseUrl: shared.appUrl,
    productAccessMode: "configured",
    environmentsEncryptionKey: Buffer.alloc(32, 7).toString("base64"),
    hostMcpCredentialResolversJson: JSON.stringify([
      { accountId, url: "https://legacy.example/credentials", bearerToken: "legacy-fixture" },
    ]),
  });
  const deps = { db: db.db, settings, bus: new MemoryEventBus() } as unknown as ApiRouteDeps;
  const app = new Hono();
  app.onError((error, c) => {
    if (error instanceof HTTPException) return c.json({ message: error.message }, error.status);
    throw error;
  });
  registerHostMcpResolverRoutes(app, deps);
  registerWorkspaceRoutes(app, deps);
  const service = new OpenGeniClient({
    baseUrl: "http://fixture",
    apiKey: token,
    fetch: (input, init) => app.request(input, init),
  });
  const put = {
    operationId: crypto.randomUUID(),
    expectedGeneration: 0,
    url: "https://one.example/credentials",
    bearerToken: "one-secret",
  };
  await expect(service.putHostMcpResolver(accountId, "instance:one", put)).rejects.toMatchObject({
    status: 409,
  });
  const accepted = { ...put, acknowledgeLegacyRoutingReplacement: true };
  const [one, replay] = await Promise.all([
    service.putHostMcpResolver(accountId, "instance:one", accepted),
    service.putHostMcpResolver(accountId, "instance:one", accepted),
  ]);
  expect(replay).toEqual(one);
  await expect(
    service.putHostMcpResolver(accountId, "instance:one", {
      ...accepted,
      operationId: crypto.randomUUID(),
    }),
  ).rejects.toMatchObject({ status: 409 });
  expect(one).toMatchObject({ generation: 1, status: "active", externalSource: "instance:one" });
  expect(JSON.stringify(one)).not.toContain("one-secret");
  expect(one).not.toHaveProperty("secretEncrypted");
  await expect(
    service.putHostMcpResolver(accountId, "instance:one", {
      ...accepted,
      bearerToken: "different",
    }),
  ).rejects.toMatchObject({ status: 409 });
  await service.putHostMcpResolver(accountId, "instance:two", {
    ...put,
    operationId: crypto.randomUUID(),
    url: "https://two.example/credentials",
    bearerToken: "two-secret",
  });
  // No workspace existed at registration. Public ensure chooses a stable source
  // once; it does not install configuration or a resolver per workspace.
  const { workspace: first } = await service.ensureWorkspace({
    accountId,
    externalSource: "instance:one",
    externalId: "customer-a",
    name: "First",
  });
  const { workspace: second } = await service.ensureWorkspace({
    accountId,
    externalSource: "instance:two",
    externalId: "customer-a",
    name: "Second",
  });
  const { workspace: future } = await service.ensureWorkspace({
    accountId,
    externalSource: "instance:one",
    externalId: "customer-b",
    name: "Future",
  });
  const { workspace: missing } = await service.ensureWorkspace({
    accountId,
    externalSource: "unregistered",
    externalId: "customer-c",
    name: "Missing",
  });
  const sent: { url: string; bearer: string }[] = [];
  let entered = Promise.withResolvers<void>();
  let delay: Promise<void> | undefined;
  const port = createNativeRemoteMcpCredentialsPort(settings, db.db, async (url, init) => {
    sent.push({ url: String(url), bearer: new Headers(init?.headers).get("Authorization")! });
    const envelope = JSON.parse(String(init?.body));
    entered.resolve();
    await delay;
    return Response.json({
      version: 1,
      requestId: envelope.requestId,
      destinationUrl: envelope.request.destinationUrl,
      resolution: {
        status: "ok",
        accountId,
        workspaceId: envelope.request.workspaceId,
        requestId: envelope.request.requestId,
        providerDomain: "tools.example",
        connectionId: "personal-account",
        headers: { authorization: "Bearer provider-fixture" },
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });
  });
  const resolve = (workspaceId: string) =>
    buildHostGatewayConnectionTokenResolver(
      port.mcpGatewayCredentials!,
      {
        accountId,
        workspaceId,
        authority: {
          kind: "organization_service",
          subjectId: `api_key:${key.id}`,
          permissions: [],
        },
      },
      async () => undefined,
    )({
      workspaceId,
      serverId: "tools",
      destinationUrl: "https://tools.example/mcp",
      connectionRef: {
        authoritySource: "host",
        providerDomain: "tools.example",
        connectionId: "personal-account",
      },
    });
  for (const workspace of [first, second, future])
    expect((await resolve(workspace.id)).status).toBe("ok");
  expect(sent).toEqual([
    { url: put.url, bearer: "Bearer one-secret" },
    { url: "https://two.example/credentials", bearer: "Bearer two-secret" },
    { url: put.url, bearer: "Bearer one-secret" },
  ]);
  expect((await resolve(missing.id)).status).toBe("auth_needed");
  expect(sent).toHaveLength(3);
  const old = await resolve(first.id);
  if (old.status !== "ok") throw new Error("expected credential");
  expect(await old.authorizeProviderRequest!()).toBe(true);
  const gate = Promise.withResolvers<void>();
  delay = gate.promise;
  entered = Promise.withResolvers<void>();
  const inFlight = resolve(first.id);
  await entered.promise;
  const rotated = await service.putHostMcpResolver(accountId, "instance:one", {
    operationId: crypto.randomUUID(),
    expectedGeneration: 1,
    url: "https://one-new.example/credentials",
    bearerToken: "new-secret",
  });
  expect(rotated.id).toBe(one.id);
  expect(rotated.generation).toBe(2);
  expect(await old.authorizeProviderRequest!()).toBe(false);
  delay = undefined;
  gate.resolve();
  expect((await inFlight).status).toBe("auth_needed");
  const fresh = await resolve(first.id);
  expect(fresh.status).toBe("ok");
  expect(sent.at(-1)).toEqual({ url: rotated.url, bearer: "Bearer new-secret" });
  const revoke = { operationId: crypto.randomUUID(), expectedGeneration: 2 };
  const revoked = await service.revokeHostMcpResolver(accountId, "instance:one", revoke);
  expect(revoked).toMatchObject({ id: one.id, generation: 3, status: "revoked" });
  if (fresh.status === "ok") expect(await fresh.authorizeProviderRequest!()).toBe(false);
  expect(await service.putHostMcpResolver(accountId, "instance:one", accepted)).toEqual(one);
  expect((await service.getHostMcpResolver(accountId, "instance:one")).status).toBe("revoked");
  expect((await resolve(first.id)).status).toBe("auth_needed");
  await service.revokeHostMcpResolver(accountId, "instance:two", {
    operationId: crypto.randomUUID(),
    expectedGeneration: 1,
  });
  const beforeDenied = sent.length;
  expect((await resolve(second.id)).status).toBe("auth_needed");
  expect((await resolve(missing.id)).status).toBe("auth_needed");
  expect(sent).toHaveLength(beforeDenied); // All rows revoked still never re-enable static routing.
  await service.putHostMcpResolver(accountId, "instance:one", {
    operationId: crypto.randomUUID(),
    expectedGeneration: 3,
    url: rotated.url,
    bearerToken: "reactivated-secret",
  });
  expect((await resolve(first.id)).status).toBe("ok");
  await service.revokeHostMcpResolver(accountId, "instance:one", revoke);
  expect((await service.getHostMcpResolver(accountId, "instance:one")).generation).toBe(4);
  const [stored] =
    await shared.admin`select secret_encrypted from host_mcp_resolvers where id = ${one.id}`;
  expect(stored!.secret_encrypted).toStartWith("v2:");
  expect(stored!.secret_encrypted).not.toContain("reactivated-secret");
  const [operations] =
    await shared.admin`select jsonb_agg(result)::text as results from host_mcp_resolver_operations where account_id = ${accountId}`;
  expect(operations!.results).not.toContain("secret");
  await shared.admin`update api_keys set revoked_at = clock_timestamp() where id = ${key.id}`;
  expect((await resolve(first.id)).status).toBe("ok"); // Registry ownership outlives its creating admin key.
  await expect(
    service.putHostMcpResolver(accountId, "instance:one", accepted),
  ).rejects.toMatchObject({ status: 401 });
  await expect(
    mutateHostMcpResolver(
      db.db,
      { accountId, subjectId: `api_key:${key.id}` },
      {
        externalSource: "instance:one",
        encryptionKey: Buffer.alloc(32, 7),
        legacyConfigured: true,
        kind: "put",
        request: accepted,
      },
    ),
  ).rejects.toMatchObject({ status: 403 });
}, 180_000);

test("registration denies delegated, external, workspace and non-admin credentials without echoing secrets", async () => {
  const [account] =
    await shared.admin`insert into managed_accounts (name) values ('Resolver authority') returning id`;
  const accountId = account!.id as string;
  const workspace = await createWorkspace(db.db, { accountId, name: "Shared" });
  const tokens = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  for (const [index, token] of tokens.entries()) {
    const input = {
      accountId,
      name: "Fixture",
      prefix: "test",
      keyHash: createHash("sha256").update(token).digest("hex"),
      permissions: ["account:admin" as const],
    };
    if (index === 1) await createApiKey(db.db, { ...input, workspaceId: workspace.id });
    else
      await createOrganizationApiKey(db.db, {
        ...input,
        permissions: index === 2 ? ["workspace:read"] : input.permissions,
      });
  }
  await ensureExternalIdentity(db.db, { accountId, externalId: "alice" });
  const deps = {
    db: db.db,
    settings: testSettings({
      databaseUrl: shared.appUrl,
      productAccessMode: "configured",
      delegationSecret: "resolver-delegated-fixture",
      environmentsEncryptionKey: Buffer.alloc(32, 7).toString("base64"),
    }),
  } as unknown as ApiRouteDeps;
  const app = new Hono();
  app.onError((error, c) => {
    if (error instanceof HTTPException) return c.json({ message: error.message }, error.status);
    throw error;
  });
  registerHostMcpResolverRoutes(app, deps);
  const clients = tokens.map(
    (apiKey) =>
      new OpenGeniClient({
        baseUrl: "http://fixture",
        apiKey,
        fetch: (input, init) => app.request(input, init),
      }),
  );
  const request = {
    operationId: crypto.randomUUID(),
    expectedGeneration: 0,
    url: "https://host.example/credentials",
    bearerToken: "private-fixture",
  };
  for (const client of [clients[0]!.asUser("alice"), clients[1]!, clients[2]!])
    await expect(client.putHostMcpResolver(accountId, "instance", request)).rejects.toMatchObject({
      status: 403,
    });
  await expect(
    clients[0]!
      .asLinkedUser("alice", { linkId: crypto.randomUUID(), expectedLinkRevision: 1 })
      .putHostMcpResolver(accountId, "instance", request),
  ).rejects.toMatchObject({ status: 403 });
  const forged = new OpenGeniClient({
    baseUrl: "http://fixture",
    fetch: (input, init) => app.request(input, init),
    apiKey: await signDelegatedAccessToken(deps.settings.delegationSecret!, {
      accountId,
      workspaceId: workspace.id,
      subjectId: "user:fixture",
      principalKind: "human_session",
      permissions: ["account:admin"],
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  });
  await expect(forged.putHostMcpResolver(accountId, "instance", request)).rejects.toMatchObject({
    status: 403,
  });
  const cookie = await app.request(
    `/v1/organizations/${accountId}/mcp-credential-resolvers/instance`,
    {
      method: "PUT",
      headers: {
        Cookie: "better-auth.session_token=invalid-fixture",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
    },
  );
  expect([401, 403]).toContain(cookie.status);
  await expect(
    clients[0]!.putHostMcpResolver(accountId, "instance", {
      ...request,
      bearerToken: "secret\r\nheader",
    }),
  ).rejects.toMatchObject({ status: 422 });
  await expect(
    clients[0]!.putHostMcpResolver(accountId, "instance", {
      ...request,
      url: "https://user:secret@host.example/",
    }),
  ).rejects.toMatchObject({ status: 422 });
  await expect(
    clients[0]!.putHostMcpResolver(crypto.randomUUID(), "instance", request),
  ).rejects.toMatchObject({ status: 403 });
  const [count] =
    await shared.admin`select count(*)::integer as total from host_mcp_resolvers where account_id = ${accountId}`;
  expect(count!.total).toBe(0);
}, 180_000);
