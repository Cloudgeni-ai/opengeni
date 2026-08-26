import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import {
  createDb,
  createSessionWithIdempotencyKeyResult,
  ensureManagedAccessForUserWithOrganizationMemberships,
  getOrganizationPrivateSessionSettings,
  transitionSessionVisibility,
  updateOrganizationPrivateSessionSettings,
  type DbClient,
} from "../src";
import { migrate } from "../src/migrate";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

let owned: OwnerMigratedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  owned = await acquireOwnerMigratedTestDatabase("migration-0342-private-transition-gate");
  if (!owned) {
    if (requireRealDatabase) throw new Error("PostgreSQL required");
    return;
  }
  await migrate(owned.ownerUrl);
  client = createDb(owned.ownerUrl, { max: 4 });
}, 900_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await owned?.release();
}, 180_000);

describe("migration 0344 private visibility transition gate", () => {
  test("fails fresh shared-workspace transitions closed without breaking replay or personal workspaces", async () => {
    if (!owned || !client) return;
    const [identity] = await owned.admin<Array<{ superuser: boolean; bypassRls: boolean }>>`
      select rolsuper as superuser, rolbypassrls as "bypassRls"
      from pg_roles where rolname = ${owned.ownerRole}`;
    expect(identity).toEqual({ superuser: false, bypassRls: false });

    const userId = `visibility-gate-${crypto.randomUUID()}`;
    const subjectId = `user:${userId}`;
    const provisioned = await ensureManagedAccessForUserWithOrganizationMemberships(client.db, {
      userId,
      email: `${userId}@example.test`,
      name: "Visibility gate owner",
    });
    const sharedWorkspaceId = provisioned.accessContext.defaultWorkspaceId;
    const sharedGrant = provisioned.accessContext.workspaceGrants.find(
      (grant) => grant.workspaceId === sharedWorkspaceId,
    );
    const membership = provisioned.organizationMemberships.find(
      (candidate) => candidate.organizationId === sharedGrant?.accountId,
    );
    if (!membership?.personalWorkspaceId || !sharedWorkspaceId || !sharedGrant) {
      throw new Error("managed organization authority missing");
    }
    const accountId = sharedGrant.accountId;
    await owned.admin`
      update organization_memberships set role = 'owner'
      where id = ${membership.id}`;
    await owned.admin`
      insert into session_tenancy_activations (
        account_id, activation_version, inventory_digest, parity_digest, activated_by
      ) values (${accountId}, 1, ${"3".repeat(64)}, ${"4".repeat(64)}, '0342-test')`;

    const settings = await getOrganizationPrivateSessionSettings(client.db, {
      organizationId: accountId,
      actorSubjectId: subjectId,
    });
    expect(settings).toMatchObject({ enabled: false, available: true, version: 0 });
    const enabled = await updateOrganizationPrivateSessionSettings(client.db, {
      organizationId: accountId,
      actorSubjectId: subjectId,
      enabled: true,
      expectedVersion: settings.version,
      operationId: crypto.randomUUID(),
    });
    expect(enabled).toMatchObject({ enabled: true, available: true, version: 1 });

    const createSharedSession = async (workspaceId: string, key: string) => {
      const result = await createSessionWithIdempotencyKeyResult(client!.db, {
        accountId,
        workspaceId,
        visibility: "workspace_shared",
        initialMessage: "visibility transition gate fixture",
        resources: [],
        metadata: {},
        createdBy: { kind: "subject", subjectId },
        subjectId,
        model: "test-model",
        reasoningEffort: "medium",
        latencyMode: "standard",
        sandboxBackend: "none",
        createIdempotencyKey: key,
      });
      if (result.denied) throw new Error("fixture session unexpectedly denied");
      return result.session;
    };

    const replaySession = await createSharedSession(
      sharedWorkspaceId,
      `shared-replay-${crypto.randomUUID()}`,
    );
    const operationKey = `transition-replay-${crypto.randomUUID()}`;
    const applied = await transitionSessionVisibility(client.db, {
      workspaceId: sharedWorkspaceId,
      sessionId: replaySession.id,
      actorSubjectId: subjectId,
      targetVisibility: "user_private",
      expectedAuthorityEpoch: 1,
      operationKey,
    });
    expect(applied).toMatchObject({ visibility: "user_private", changed: true, replay: false });

    const disabled = await updateOrganizationPrivateSessionSettings(client.db, {
      organizationId: accountId,
      actorSubjectId: subjectId,
      enabled: false,
      expectedVersion: enabled.version,
      operationId: crypto.randomUUID(),
    });
    expect(disabled).toMatchObject({ enabled: false, available: true, version: 2 });

    const replay = await transitionSessionVisibility(client.db, {
      workspaceId: sharedWorkspaceId,
      sessionId: replaySession.id,
      actorSubjectId: subjectId,
      targetVisibility: "user_private",
      expectedAuthorityEpoch: 1,
      operationKey,
    });
    expect(replay).toEqual({ ...applied, replay: true });

    const freshSession = await createSharedSession(
      sharedWorkspaceId,
      `shared-fresh-${crypto.randomUUID()}`,
    );
    await expect(
      transitionSessionVisibility(client.db, {
        workspaceId: sharedWorkspaceId,
        sessionId: freshSession.id,
        actorSubjectId: subjectId,
        targetVisibility: "user_private",
        expectedAuthorityEpoch: 1,
        operationKey: `transition-fresh-${crypto.randomUUID()}`,
      }),
    ).rejects.toHaveProperty("name", "SessionTenancyNotActivatedError");

    await expect(
      transitionSessionVisibility(client.db, {
        workspaceId: sharedWorkspaceId,
        sessionId: replaySession.id,
        actorSubjectId: subjectId,
        targetVisibility: "workspace_shared",
        expectedAuthorityEpoch: 2,
        operationKey: `transition-shared-${crypto.randomUUID()}`,
      }),
    ).resolves.toMatchObject({ visibility: "workspace_shared", changed: true });

    const personalSession = await createSharedSession(
      membership.personalWorkspaceId,
      `personal-${crypto.randomUUID()}`,
    );
    await expect(
      transitionSessionVisibility(client.db, {
        workspaceId: membership.personalWorkspaceId,
        sessionId: personalSession.id,
        actorSubjectId: subjectId,
        targetVisibility: "user_private",
        expectedAuthorityEpoch: 1,
        operationKey: `transition-personal-${crypto.randomUUID()}`,
      }),
    ).resolves.toMatchObject({ visibility: "user_private", changed: true });
  }, 900_000);
});
