import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import {
  createDb,
  createOrganizationApiKey,
  createSession,
  createWorkspace,
  ensureExternalIdentity,
  withSessionRlsActorContext,
  type Database,
  type DbClient,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import { requireAccessGrantAuthorization } from "../src/access";
import {
  consentManagedHumanSandboxRecovery,
  getManagedHumanSandboxRecovery,
  requireSandboxRecoveryConsentHuman,
} from "../src/application/sandbox-recovery";

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
let db: Database;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("core-sandbox-recovery-external-consent");
  if (!shared) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") {
      throw new Error("PostgreSQL test database unavailable while OPENGENI_REQUIRE_REAL_DB=1");
    }
    return;
  }
  client = createDb(shared.appUrl);
  db = client.db;
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

describe("sandbox recovery consent through the API as the user", () => {
  test("a verified external user acting as themselves may preview and consent; the bare key and a copied grant may not", async () => {
    if (!shared) return;
    const admin = shared.admin;
    const [account] =
      await admin`insert into managed_accounts (name) values ('Sandbox recovery external consent') returning id`;
    if (!account) throw new Error("account seed failed");
    const accountId = account.id as string;
    const workspace = await createWorkspace(db, { accountId, name: "Recovery consent" });
    const workspaceId = workspace.id;
    const token = crypto.randomUUID();
    await createOrganizationApiKey(db, {
      accountId,
      name: "Recovery consent",
      prefix: "test",
      keyHash: createHash("sha256").update(token).digest("hex"),
      permissions: ["workspace:read", "sessions:read", "sessions:control"],
    });
    const identity = await ensureExternalIdentity(db, { accountId, externalId: "recovery-user" });
    await admin`insert into workspace_memberships (account_id, workspace_id, subject_id, role, permissions)
      values (${accountId}, ${workspaceId}, ${identity.subjectId}, 'member',
        '["workspace:read","sessions:read","sessions:control"]'::jsonb)`;
    const session = await withSessionRlsActorContext({ subjectId: identity.subjectId }, () =>
      createSession(db, {
        accountId,
        workspaceId,
        initialMessage: "Recovery consent fixture",
        createdBy: { kind: "subject", subjectId: identity.subjectId },
        resources: [],
        tools: [],
        model: "test-model",
        reasoningEffort: "medium",
        latencyMode: "standard",
        sandboxBackend: "none",
      }),
    );

    const deps = { db, settings: testSettings({ productAccessMode: "configured" }) };
    const outcome = async (run: () => Promise<unknown>) => {
      try {
        await run();
        return "allowed";
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return message.includes("managed-human") ? "refused" : `failed: ${message}`;
      }
    };
    const app = new Hono();
    app.get("/check", async (c) => {
      const authorization = await requireAccessGrantAuthorization(c, deps, workspaceId);
      const copied = { ...authorization, grant: { ...authorization.grant } };
      return c.json({
        preview: await outcome(() =>
          getManagedHumanSandboxRecovery(deps as never, authorization, workspaceId, session.id),
        ),
        // No recovery is pending: persistence admits the external subject's
        // live workspace authority, then refuses the stale selection itself.
        consent: await outcome(() =>
          consentManagedHumanSandboxRecovery(
            deps as never,
            authorization,
            workspaceId,
            session.id,
            {
              operationId: crypto.randomUUID(),
              acceptHistoricalCheckpoint: true,
              selection: {
                version: 1,
                sessionId: session.id,
                sandboxGroupId: crypto.randomUUID(),
                leaseId: crypto.randomUUID(),
                routeEpoch: 0,
                authorityEpoch: 1,
                leaseEpoch: 0,
                workspaceGeneration: 0,
                archiveGeneration: 0,
                artifactId: crypto.randomUUID(),
                revision: "absent",
                capturedAt: new Date().toISOString(),
              },
            },
          ),
        ),
        copied: await outcome(async () => requireSandboxRecoveryConsentHuman(copied, workspaceId)),
        otherWorkspace: await outcome(async () =>
          requireSandboxRecoveryConsentHuman(authorization, crypto.randomUUID()),
        ),
      });
    });

    const asUser = await app.request("/check", {
      headers: {
        authorization: `Bearer ${token}`,
        "x-opengeni-external-actor": encodeURIComponent(
          JSON.stringify({ mode: "external", identity: { externalId: "recovery-user" } }),
        ),
      },
    });
    expect(asUser.status).toBe(200);
    expect(await asUser.json()).toEqual({
      preview: "allowed",
      consent: "failed: The checkpoint or recovery eligibility changed; review a fresh preview",
      copied: "refused",
      otherWorkspace: "refused",
    });

    const bareKey = await app.request("/check", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(bareKey.status).toBe(200);
    expect(await bareKey.json()).toMatchObject({ preview: "refused", consent: "refused" });
  }, 120_000);
});
