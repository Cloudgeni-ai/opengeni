import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "../../testing/src/shared-pg";
import { migrate } from "../src/migrate";
import {
  canonicalSessionVisibilityTransitionHash,
  createDb,
  createSessionWithIdempotencyKeyResult,
  ensureManagedAccessForUserWithOrganizationMemberships,
  type DbClient,
} from "../src";

const migrationUrl = new URL(
  "../drizzle/0345_tenant_scoped_session_tenancy_fence.sql",
  import.meta.url,
);
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let owned: OwnerMigratedTestDatabase | null = null;
let client: DbClient | null = null;

describe("migration 0345 tenant-scoped session-tenancy fence", () => {
  beforeAll(async () => {
    owned = await acquireOwnerMigratedTestDatabase("session-tenancy-fence");
    if (!owned) {
      if (requireRealDatabase) throw new Error("real database required but unavailable");
      return;
    }
    await migrate(owned.ownerUrl);
    client = createDb(owned.ownerUrl, { max: 4 });
  }, 900_000);

  afterAll(async () => {
    await client?.close().catch(() => undefined);
    await owned?.release();
  });

  test("replaces schema-wide table locks with the canonical tenant prefix", async () => {
    const migration = await readFile(migrationUrl, "utf8");
    expect(migration).not.toMatch(/LOCK TABLE/u);
    expect(migration).toContain("CREATE OR REPLACE FUNCTION assert_session_tenancy_quiescent");
    expect(migration).toContain("CREATE OR REPLACE FUNCTION transition_session_visibility");
    expect(migration).toContain("CREATE OR REPLACE FUNCTION fork_session_content");
    expect(migration).toContain("require_session_tenancy_fence");
    expect(migration).toContain("never restart a pre-0345 image");
    const hotTableDeclaration = migration.slice(
      migration.indexOf("hot_tables constant text[]"),
      migration.indexOf("];", migration.indexOf("hot_tables constant text[]")),
    );
    expect(hotTableDeclaration.match(/'[^']+'/gu)).toHaveLength(17);

    const transition = migration.slice(
      migration.indexOf("CREATE OR REPLACE FUNCTION transition_session_visibility"),
      migration.indexOf("CREATE OR REPLACE FUNCTION fork_session_content"),
    );
    expect(transition.indexOf("organization-membership:")).toBeLessThan(
      transition.indexOf("session-tenancy:"),
    );
    expect(transition.indexOf("session-tenancy:")).toBeLessThan(
      transition.indexOf("FROM workspaces"),
    );
    if (owned) {
      const [installed] = await owned.admin<Array<{ count: number }>>`
        select count(*)::int as count from pg_trigger
        where tgname = 'session_tenancy_workspace_fence' and not tgisinternal`;
      expect(installed?.count).toBe(17);
    }
  });

  test("the application activity boundary takes the matching shared prefix", async () => {
    const database = await readFile(new URL("../src/database.ts", import.meta.url), "utf8");
    const tenancy = await readFile(new URL("../src/session-tenancy.ts", import.meta.url), "utf8");
    const agents = await readFile(new URL("../../../AGENTS.md", import.meta.url), "utf8");
    expect(database).toContain("pg_advisory_xact_lock_shared");
    expect(database).toContain("session-tenancy:${context.workspaceId}");
    expect(tenancy).toMatch(/transitionSessionVisibility[\s\S]*?undefined,\s*"none"/u);
    expect(agents).toContain("never restart a pre-0345 image");
  });

  test("an exclusive fence blocks only writers in the same workspace", async () => {
    if (!owned) return;
    const holder = postgres(owned.ownerUrl, { max: 1 });
    const probe = postgres(owned.ownerUrl, { max: 1 });
    const workspaceA = crypto.randomUUID();
    const workspaceB = crypto.randomUUID();
    const connection = await holder.reserve();
    try {
      await connection`begin`;
      await connection`select pg_advisory_xact_lock(hashtextextended(
        ${`session-tenancy:${workspaceA}`}, 0))`;
      const [same] = await probe<Array<{ acquired: boolean }>>`
        select pg_try_advisory_xact_lock_shared(hashtextextended(
          ${`session-tenancy:${workspaceA}`}, 0)) as acquired`;
      const [other] = await probe<Array<{ acquired: boolean }>>`
        select pg_try_advisory_xact_lock_shared(hashtextextended(
          ${`session-tenancy:${workspaceB}`}, 0)) as acquired`;
      expect(same?.acquired).toBe(false);
      expect(other?.acquired).toBe(true);
    } finally {
      await connection`rollback`;
      connection.release();
      await holder.end({ timeout: 5 });
      await probe.end({ timeout: 5 });
    }
  });

  test("a real transition fences same-workspace production writes but not another workspace", async () => {
    if (!owned || !client) return;
    const within = async <T>(operation: Promise<T>, label: string): Promise<T> =>
      await Promise.race([
        operation,
        Bun.sleep(10_000).then(() => {
          throw new Error(`${label} exceeded 10s`);
        }),
      ]);
    const userId = `fence-${crypto.randomUUID()}`;
    const subjectId = `user:${userId}`;
    const provisioned = await within(
      ensureManagedAccessForUserWithOrganizationMemberships(client.db, {
        userId,
        email: `${userId}@example.test`,
        name: "Fence owner",
      }),
      "managed-access provisioning",
    );
    const personalWorkspaceId = provisioned.organizationMemberships[0]?.personalWorkspaceId;
    const sharedGrant = provisioned.accessContext.workspaceGrants.find(
      (candidate) => candidate.workspaceId !== personalWorkspaceId,
    );
    const sharedWorkspaceId = sharedGrant?.workspaceId;
    const grant = provisioned.accessContext.workspaceGrants.find(
      (candidate) => candidate.workspaceId === sharedWorkspaceId,
    );
    const membership = provisioned.organizationMemberships.find(
      (candidate) => candidate.organizationId === grant?.accountId,
    );
    if (!grant || !membership?.personalWorkspaceId || !sharedWorkspaceId) {
      throw new Error("fence fixture requires distinct shared and personal workspaces");
    }
    await within(
      owned.admin`update organization_memberships set role = 'owner' where id = ${membership.id}`,
      "owner-role fixture update",
    );
    await within(
      owned.admin`insert into session_tenancy_activations (
        account_id, activation_version, inventory_digest, parity_digest, activated_by
      ) values (${grant.accountId}, 1, ${"5".repeat(64)}, ${"6".repeat(64)}, '0345-test')`,
      "tenancy-activation fixture insert",
    );

    // A personal workspace owned by the same subject legitimately shares the
    // organization-membership authority row that the transition locks. Use a
    // second organization/subject here so the assertion isolates the tenancy
    // fence itself from that independent lifecycle serialization boundary.
    const otherUserId = `fence-other-${crypto.randomUUID()}`;
    const otherSubjectId = `user:${otherUserId}`;
    const otherProvisioned = await within(
      ensureManagedAccessForUserWithOrganizationMemberships(client.db, {
        userId: otherUserId,
        email: `${otherUserId}@example.test`,
        name: "Other fence owner",
      }),
      "other-tenant managed-access provisioning",
    );
    const otherWorkspaceId = otherProvisioned.accessContext.defaultWorkspaceId;
    const otherGrant = otherProvisioned.accessContext.workspaceGrants.find(
      (candidate) => candidate.workspaceId === otherWorkspaceId,
    );
    if (!otherWorkspaceId || !otherGrant || otherGrant.accountId === grant.accountId) {
      throw new Error("fence fixture requires an unrelated organization workspace");
    }

    const create = async (
      accountId: string,
      workspaceId: string,
      actorSubjectId: string,
      key: string,
    ) => {
      const result = await createSessionWithIdempotencyKeyResult(client!.db, {
        accountId,
        workspaceId,
        visibility: "workspace_shared",
        initialMessage: "tenant fence",
        resources: [],
        metadata: {},
        createdBy: { kind: "subject", subjectId: actorSubjectId },
        subjectId: actorSubjectId,
        model: "test-model",
        reasoningEffort: "medium",
        latencyMode: "standard",
        sandboxBackend: "none",
        createIdempotencyKey: key,
      });
      if (result.denied) throw new Error("fence fixture create denied");
      return result.session;
    };
    const source = await within(
      create(grant.accountId, sharedWorkspaceId, subjectId, `source-${crypto.randomUUID()}`),
      "source production writer",
    );
    const holder = postgres(owned.ownerUrl, { max: 1, onnotice: () => undefined });
    const connection = await holder.reserve();
    try {
      await connection`begin`;
      await connection`select set_config('opengeni.account_id', ${grant.accountId}, true),
        set_config('opengeni.workspace_id', ${sharedWorkspaceId}, true),
        set_config('opengeni.subject_id', ${subjectId}, true),
        set_config('lock_timeout', '10s', true),
        set_config('statement_timeout', '10s', true)`;
      const operationKey = `hold-${crypto.randomUUID()}`;
      const requestHash = canonicalSessionVisibilityTransitionHash({
        sessionId: source.id,
        targetVisibility: "workspace_shared",
        expectedAuthorityEpoch: 1,
      });
      await within(
        connection`select * from transition_session_visibility(
          ${grant.accountId}::uuid, ${sharedWorkspaceId}::uuid, ${source.id}::uuid,
          ${subjectId}, 'workspace_shared', 1, ${operationKey}, ${requestHash}, 1)`,
        "exclusive transition fence",
      );

      const same = create(
        grant.accountId,
        sharedWorkspaceId,
        subjectId,
        `same-${crypto.randomUUID()}`,
      );
      const other = create(
        otherGrant.accountId,
        otherWorkspaceId,
        otherSubjectId,
        `other-${crypto.randomUUID()}`,
      );
      const pending = Symbol("pending");
      expect(
        await Promise.race([same.then(() => "settled"), Bun.sleep(250).then(() => pending)]),
      ).toBe(pending);
      await expect(within(other, "other-workspace production writer")).resolves.toHaveProperty(
        "workspaceId",
        otherWorkspaceId,
      );
      await connection`commit`;
      await expect(within(same, "same-workspace production writer")).resolves.toHaveProperty(
        "workspaceId",
        sharedWorkspaceId,
      );
    } finally {
      await connection`rollback`.catch(() => undefined);
      connection.release();
      await holder.end({ timeout: 5 });
    }
  }, 900_000);
});
