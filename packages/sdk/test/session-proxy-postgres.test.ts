import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import postgres from "postgres";
import type { Permission } from "@opengeni/contracts";
import { createDb, createOrganizationApiKey, createWorkspace, type DbClient } from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { createApp } from "../../../apps/api/src/app";
import { artifactViewerCapability, createSessionProxyHandler, OpenGeniClient } from "../src/index";
import { getSessionProxyWorkspaceGrant } from "../src/session-proxy";

// Explicit native opt-in runs the same full-migration/FORCE-RLS fixture as CI.
// REQUIRE_REAL_DB must fail, not silently pass, when no real fixture is available.
const requireRealDatabase =
  process.env.REQUIRE_REAL_DB === "1" || process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const postgresTests =
  requireRealDatabase || process.env.CI || process.env.OPENGENI_TEST_PG_URL || Bun.which("docker")
    ? describe
    : describe.skip;
const SOURCE = "proxy-postgres:host";
const PRODUCT = "https://product.example.test/api/opengeni";
const API = "http://127.0.0.1:8000";
const VIEWER_PERMISSIONS: Permission[] = [
  "workspace:read",
  "sessions:read",
  "artifacts:read",
  "artifacts:publish",
];

describe("session proxy real PostgreSQL", () => {
  let shared: SharedTestDatabase;
  let db: DbClient;

  postgresTests("external-user effective authority", () => {
    beforeAll(async () => {
      const acquired = await acquireSharedTestDatabase("sdk-session-proxy");
      if (!acquired) throw new Error("Session proxy regression requires real PostgreSQL");
      shared = acquired;
      db = createDb(shared.appUrl, { max: 4, rlsStrategy: "force" });
    }, 180_000);

    afterAll(async () => {
      await db?.close();
      await shared?.release();
    });

    async function fixture() {
      const [account] = await shared.admin`
        insert into managed_accounts (name) values ('Session proxy PostgreSQL') returning id`;
      const accountId = String(account!.id);
      const workspace = await createWorkspace(db.db, { accountId, name: "Host customer" });
      const token = crypto.randomUUID();
      const key = await createOrganizationApiKey(db.db, {
        accountId,
        name: "Host service",
        prefix: "test",
        keyHash: createHash("sha256").update(token).digest("hex"),
        permissions: [...VIEWER_PERMISSIONS, "members:manage", "account:admin"],
      });
      const app = createApp({
        settings: testSettings({
          productAccessMode: "managed",
          databaseUrl: shared.appUrl,
          sandboxBackend: "none",
          observabilityMetricsEnabled: false,
        }),
        db: db.db,
        bus: new MemoryEventBus(),
        workflowClient: {} as never,
        managedAuth: null,
        objectStorage: null,
      });
      const requests: Request[] = [];
      const service = new OpenGeniClient({
        baseUrl: API,
        apiKey: token,
        fetch: async (input, init) => {
          const request = new Request(input, init);
          requests.push(request);
          return app.request(request);
        },
      });
      const user = crypto.randomUUID();
      const identity = await service.addExternalWorkspaceMember(workspace.id, {
        identity: { externalId: user, source: SOURCE },
        permissions: VIEWER_PERMISSIONS,
        operationId: crypto.randomUUID(),
      });
      const actor = service.asUser(user, { source: SOURCE });
      const handler = createSessionProxyHandler(service, {
        resolve: () => ({ workspaceId: workspace.id, user, source: SOURCE }),
        artifacts: true,
      });
      const browser = new OpenGeniClient({
        baseUrl: PRODUCT,
        fetch: (input, init) => handler(new Request(input, init)),
      });
      return { accountId, workspace, key, requests, service, identity, actor, browser };
    }

    test("empty external access inventory still yields real proxy config and viewer capability", async () => {
      const f = await fixture();
      const appProbe = postgres(shared.appUrl, { max: 1 });
      try {
        const [posture] = await appProbe`
          select current_user, rolsuper, rolbypassrls
          from pg_roles where rolname = current_user`;
        expect(posture).toMatchObject({
          current_user: "opengeni_app",
          rolsuper: false,
          rolbypassrls: false,
        });
      } finally {
        await appProbe.end();
      }
      const [rls] = await shared.admin`
        select relrowsecurity, relforcerowsecurity
        from pg_class where oid = 'sessions'::regclass`;
      expect(rls).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });

      const context = await f.actor.getAccessContext();
      expect(context.subjectId).toBe(f.identity.subjectId);
      expect(context.workspaceGrants).toEqual([]);
      const grant = await getSessionProxyWorkspaceGrant(f.actor, f.workspace.id);
      expect(grant).toMatchObject({
        workspaceId: f.workspace.id,
        accountId: f.accountId,
        subjectId: f.identity.subjectId,
      });
      expect([...grant.permissions].sort()).toEqual([...VIEWER_PERMISSIONS].sort());
      expect(grant.permissions).not.toContain("account:admin");
      expect(grant.permissions).not.toContain("members:manage");

      const capability = await artifactViewerCapability({
        client: f.actor,
        workspaceId: f.workspace.id,
        source: SOURCE,
      });
      const config = await f.browser.getClientConfig();
      expect(config.artifacts).toEqual(capability);
      expect(capability.cachePartition).toMatchObject({
        accountId: f.accountId,
        principalId: f.identity.subjectId,
      });
      expect(capability.cachePartition.authorizationEpoch).toMatch(/^sha256:[a-f0-9]{64}$/u);
      expect(capability.editableLiveUrl).toStartWith("ws://127.0.0.1:8000/");
      const grantRequests = f.requests.filter((request) =>
        new URL(request.url).pathname.endsWith("/access/grant"),
      );
      expect(grantRequests).toHaveLength(3);
      for (const request of grantRequests) {
        expect(
          JSON.parse(decodeURIComponent(request.headers.get("x-opengeni-external-actor")!)),
        ).toMatchObject({
          mode: "external",
          identity: { externalId: f.identity.externalId, source: SOURCE },
        });
      }
    }, 180_000);

    test("the same proxy refreshes permission epochs and refuses a revoked workspace grant", async () => {
      const f = await fixture();
      const initial = (await f.browser.getClientConfig()).artifacts!;
      expect((await f.browser.getClientConfig()).artifacts).toEqual(initial);
      const reducedPermissions = VIEWER_PERMISSIONS.filter(
        (permission) => permission !== "artifacts:publish",
      );
      const update = await f.service.updateExternalWorkspaceMember(
        f.accountId,
        f.workspace.id,
        f.identity.organizationMembershipId,
        { permissions: reducedPermissions, operationId: crypto.randomUUID() },
      );
      expect(update).toMatchObject({ narrowed: true, replay: false });
      const refreshed = (await f.browser.getClientConfig()).artifacts!;
      expect(refreshed.cachePartition.principalId).toBe(initial.cachePartition.principalId);
      expect(refreshed.cachePartition.authorizationEpoch).not.toBe(
        initial.cachePartition.authorizationEpoch,
      );
      expect(refreshed).toEqual(
        await artifactViewerCapability({
          client: f.actor,
          workspaceId: f.workspace.id,
          source: SOURCE,
        }),
      );
      expect(
        (await getSessionProxyWorkspaceGrant(f.actor, f.workspace.id)).permissions,
      ).not.toContain("artifacts:publish");
      // Membership removal is the native teardown, not an asUser reprovision.
      await f.service.removeWorkspaceMember(f.workspace.id, f.identity.subjectId);
      await expect(f.browser.getClientConfig()).rejects.toMatchObject({ status: 403 });
      await expect(
        artifactViewerCapability({
          client: f.actor,
          workspaceId: f.workspace.id,
          source: SOURCE,
        }),
      ).rejects.toMatchObject({ status: 403 });
      await expect(getSessionProxyWorkspaceGrant(f.actor, f.workspace.id)).rejects.toMatchObject({
        status: 403,
      });
      // Organization admission remains active: inventory is not authorization.
      expect((await f.actor.getAccessContext()).workspaceGrants).toEqual([]);
    }, 180_000);

    test("live organization-key ceiling changes and revocation invalidate a warmed proxy", async () => {
      const f = await fixture();
      const initial = (await f.browser.getClientConfig()).artifacts!;
      // Key administration is fixture-only SQL; every asserted read still
      // authenticates the real hashed key and resolves the external membership.
      await shared.admin`
        update api_keys set permissions = ${JSON.stringify([
          "workspace:read",
          "sessions:read",
          "artifacts:read",
        ])}::jsonb where id = ${f.key.id}`;
      const reducedGrant = await getSessionProxyWorkspaceGrant(f.actor, f.workspace.id);
      expect(reducedGrant.permissions).not.toContain("artifacts:publish");
      const reduced = (await f.browser.getClientConfig()).artifacts!;
      expect(reduced.cachePartition.authorizationEpoch).not.toBe(
        initial.cachePartition.authorizationEpoch,
      );
      await shared.admin`update api_keys set revoked_at = now() where id = ${f.key.id}`;
      await expect(f.browser.getClientConfig()).rejects.toMatchObject({ status: 401 });
      await expect(
        artifactViewerCapability({
          client: f.actor,
          workspaceId: f.workspace.id,
          source: SOURCE,
        }),
      ).rejects.toMatchObject({ status: 401 });
    }, 180_000);
  });
});
