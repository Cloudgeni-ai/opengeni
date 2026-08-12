import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import {
  applyCanonicalHumanIdentityOperation,
  ensureCanonicalHumanIdentityForAuthUser,
  getCanonicalHumanIdentityProjection,
  synchronizeCanonicalHumanLoginBindings,
  validateCanonicalHumanSession,
} from "../src/canonical-human-identities";
import { createDb, nestedPostgresSqlState, type DbClient } from "../src";

const migrationPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../drizzle/0223_canonical_human_login_bindings.sql",
);
const posturePath = join(dirname(fileURLToPath(import.meta.url)), "../src/runtime-posture.ts");
const provisionerPath = join(dirname(fileURLToPath(import.meta.url)), "../src/provision-roles.ts");

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const externalAdminUrl = process.env.OPENGENI_ORG_TENANCY_POSTGRES_ADMIN_URL;
const externalAppUrl = process.env.OPENGENI_ORG_TENANCY_POSTGRES_APP_URL;

beforeAll(async () => {
  if ((externalAdminUrl === undefined) !== (externalAppUrl === undefined)) {
    throw new Error(
      "set both OPENGENI_ORG_TENANCY_POSTGRES_ADMIN_URL and OPENGENI_ORG_TENANCY_POSTGRES_APP_URL",
    );
  }
  if (externalAdminUrl && externalAppUrl) {
    const admin = postgres(externalAdminUrl, { max: 8 });
    shared = {
      admin,
      adminUrl: externalAdminUrl,
      appUrl: externalAppUrl,
      release: async () => await admin.end(),
    };
  } else {
    shared = await acquireSharedTestDatabase("migration-0223-canonical-human-identities");
  }
  if (!shared && requireRealDatabase) {
    throw new Error(
      "[migration-0223-canonical-human-identities] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable",
    );
  }
  if (shared) client = createDb(shared.appUrl, { max: 8 });
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

async function createAuthUser(input?: { name?: string; email?: string }): Promise<string> {
  if (!shared) throw new Error("test database unavailable");
  const id = `identity-${crypto.randomUUID()}`;
  await shared.admin`
    insert into auth_users (id, name, email, email_verified)
    values (
      ${id},
      ${input?.name ?? "Canonical Human"},
      ${input?.email ?? `${id}@example.test`},
      true
    )
  `;
  return id;
}

async function createVerifiedBinding(
  userId: string,
  providerId: string,
  providerAccountId: string,
): Promise<void> {
  if (!shared) throw new Error("test database unavailable");
  await shared.admin`
    insert into auth_identities (
      id, user_id, provider_id, account_id, created_at, updated_at
    ) values (
      ${crypto.randomUUID()}, ${userId}, ${providerId}, ${providerAccountId}, now(), now()
    )
  `;
}

async function createStampedSession(
  userId: string,
  identity: { identityId: string; identityRevision: number; authRevision: number },
): Promise<string> {
  if (!shared) throw new Error("test database unavailable");
  const sessionId = crypto.randomUUID();
  await shared.admin`
    insert into auth_sessions (
      id, user_id, token, expires_at,
      identity_id, identity_revision, auth_revision
    ) values (
      ${sessionId}, ${userId}, ${crypto.randomUUID()}, now() + interval '1 hour',
      ${identity.identityId}, ${identity.identityRevision}, ${identity.authRevision}
    )
  `;
  return sessionId;
}

async function expectSqlState(action: () => Promise<unknown>, state: string): Promise<void> {
  let failure: unknown;
  try {
    await action();
  } catch (error) {
    failure = error;
  }
  expect(nestedPostgresSqlState(failure)).toBe(state);
}

describe("migration 0223 canonical human identities and login bindings", () => {
  test("pins the rolling lifecycle, no-direct-DML posture, and metadata-minimal projection", async () => {
    const [migration, posture, provisioner] = await Promise.all([
      readFile(migrationPath, "utf8"),
      readFile(posturePath, "utf8"),
      readFile(provisionerPath, "utf8"),
    ]);
    expect(migration.split(/\r?\n/u, 1)[0]).toBe("-- deployment-mode: rolling");
    for (const table of [
      "canonical_human_identities",
      "canonical_human_identity_subjects",
      "canonical_human_login_bindings",
      "canonical_human_identity_operations",
    ]) {
      expect(migration).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
      expect(posture).toContain(`"${table}"`);
    }
    for (const routine of [
      "ensure_canonical_human_identity(text, text)",
      "validate_canonical_human_session(text, text, boolean)",
      "get_canonical_human_identity_projection(text)",
      "apply_canonical_human_identity_operation(uuid, text, bigint, text, uuid, text, text, text)",
    ]) {
      expect(posture).toContain(`"${routine}"`);
      expect(provisioner).toContain(routine.replaceAll(", ", ","));
    }
    const projectionStart = migration.indexOf(
      "CREATE OR REPLACE FUNCTION %1$I.get_canonical_human_identity_projection",
    );
    const projectionEnd = migration.indexOf(
      "CREATE OR REPLACE FUNCTION %1$I.apply_canonical_human_identity_operation",
    );
    const projectionSql = migration.slice(projectionStart, projectionEnd);
    expect(projectionSql).not.toContain("organization_memberships");
    expect(projectionSql).not.toContain("workspace_memberships");
    expect(projectionSql).not.toContain("managed_accounts");
    expect(projectionSql).not.toContain("workspaces");
  });

  test("converges one identity, supports multiple verified bindings, and invalidates sessions immediately", async () => {
    if (!shared || !client) return;
    const userId = await createAuthUser({ name: "Multiple Login Human" });
    const concurrent = await Promise.all(
      Array.from({ length: 8 }, () => ensureCanonicalHumanIdentityForAuthUser(client!.db, userId)),
    );
    expect(new Set(concurrent.map((row) => row.identityId)).size).toBe(1);
    expect(new Set(concurrent.map((row) => row.identityRevision))).toEqual(new Set([1]));

    await createVerifiedBinding(userId, "password", userId);
    const first = await applyCanonicalHumanIdentityOperation(client.db, {
      operationId: crypto.randomUUID(),
      authUserId: userId,
      expectedIdentityRevision: 1,
      operationType: "link",
      providerId: "password",
      providerAccountId: userId,
      reason: "Attach verified password login",
    });
    await createVerifiedBinding(userId, "github", `github-${userId}`);
    const second = await applyCanonicalHumanIdentityOperation(client.db, {
      operationId: crypto.randomUUID(),
      authUserId: userId,
      expectedIdentityRevision: first.identity.activeIdentity.identityRevision,
      operationType: "link",
      providerId: "github",
      providerAccountId: `github-${userId}`,
      reason: "Attach verified GitHub login",
    });
    expect(second.identity.loginBindings).toHaveLength(2);
    expect(second.identity.loginBindings.map((binding) => binding.providerId).sort()).toEqual([
      "github",
      "password",
    ]);

    const sessionId = await createStampedSession(userId, {
      identityId: second.identity.activeIdentity.id,
      identityRevision: second.identity.activeIdentity.identityRevision,
      authRevision: second.identity.activeIdentity.authRevision,
    });
    const passwordBinding = second.identity.loginBindings.find(
      (binding) => binding.providerId === "password",
    )!;
    const unlinked = await applyCanonicalHumanIdentityOperation(client.db, {
      operationId: crypto.randomUUID(),
      authUserId: userId,
      expectedIdentityRevision: second.identity.activeIdentity.identityRevision,
      operationType: "unlink",
      bindingId: passwordBinding.id,
      reason: "Remove obsolete password login",
    });
    expect(unlinked.outcome).toBe("applied");
    expect(
      unlinked.identity.loginBindings.find((binding) => binding.id === passwordBinding.id)?.status,
    ).toBe("revoked");
    expect(
      await validateCanonicalHumanSession(client.db, {
        authSessionId: sessionId,
        authUserId: userId,
      }),
    ).toBe(false);
    const [sessionCount] = await shared.admin<{ count: number }[]>`
      select count(*)::int as count from auth_sessions where id = ${sessionId}
    `;
    expect(sessionCount).toEqual({ count: 0 });
  });

  test("synchronizes verified authentication accounts idempotently before session stamping", async () => {
    if (!shared || !client) return;
    const userId = await createAuthUser({ name: "Authentication Sync Human" });
    await createVerifiedBinding(userId, "credential", userId);
    await createVerifiedBinding(userId, "github", `github-${userId}`);

    const first = await synchronizeCanonicalHumanLoginBindings(client.db, userId);
    expect(first.identityStatus).toBe("active");
    const projection = await getCanonicalHumanIdentityProjection(client.db, userId);
    expect(projection.loginBindings.map((binding) => binding.providerId).sort()).toEqual([
      "credential",
      "github",
    ]);

    const second = await synchronizeCanonicalHumanLoginBindings(client.db, userId);
    expect(second).toEqual(first);
    const [operationCount] = await shared.admin<{ count: number }[]>`
      select count(*)::int as count
      from canonical_human_identity_operations
      where actor_auth_user_id = ${userId}
    `;
    expect(operationCount).toEqual({ count: 2 });
  });

  test("fails closed into lost-factor recovery and requires a recovery-only reauthentication", async () => {
    if (!shared || !client) return;
    const userId = await createAuthUser({ name: "Recovery Human" });
    const identity = await ensureCanonicalHumanIdentityForAuthUser(client.db, userId);
    await createVerifiedBinding(userId, "password", userId);
    const linked = await applyCanonicalHumanIdentityOperation(client.db, {
      operationId: crypto.randomUUID(),
      authUserId: userId,
      expectedIdentityRevision: identity.identityRevision,
      operationType: "link",
      providerId: "password",
      providerAccountId: userId,
      reason: "Attach only verified factor",
    });
    const onlyBinding = linked.identity.loginBindings[0]!;
    const originalSession = await createStampedSession(userId, {
      identityId: linked.identity.activeIdentity.id,
      identityRevision: linked.identity.activeIdentity.identityRevision,
      authRevision: linked.identity.activeIdentity.authRevision,
    });

    const recovery = await applyCanonicalHumanIdentityOperation(client.db, {
      operationId: crypto.randomUUID(),
      authUserId: userId,
      expectedIdentityRevision: linked.identity.activeIdentity.identityRevision,
      operationType: "unlink",
      bindingId: onlyBinding.id,
      reason: "Lost the only factor",
    });
    expect(recovery.outcome).toBe("lost_factor");
    expect(recovery.identity.activeIdentity).toMatchObject({
      status: "recovery_required",
      recoveryState: "lost_factor",
      activeLoginBindingId: null,
    });
    expect(
      await validateCanonicalHumanSession(client.db, {
        authSessionId: originalSession,
        authUserId: userId,
        allowRecovery: true,
      }),
    ).toBe(false);

    const recoverySession = await createStampedSession(userId, {
      identityId: recovery.identity.activeIdentity.id,
      identityRevision: recovery.identity.activeIdentity.identityRevision,
      authRevision: recovery.identity.activeIdentity.authRevision,
    });
    expect(
      await validateCanonicalHumanSession(client.db, {
        authSessionId: recoverySession,
        authUserId: userId,
      }),
    ).toBe(false);
    expect(
      await validateCanonicalHumanSession(client.db, {
        authSessionId: recoverySession,
        authUserId: userId,
        allowRecovery: true,
      }),
    ).toBe(true);

    const restored = await applyCanonicalHumanIdentityOperation(client.db, {
      operationId: crypto.randomUUID(),
      authUserId: userId,
      expectedIdentityRevision: recovery.identity.activeIdentity.identityRevision,
      operationType: "recover",
      bindingId: onlyBinding.id,
      reason: "Verified the recovered factor",
    });
    expect(restored.identity.activeIdentity).toMatchObject({
      status: "active",
      recoveryState: "ready",
      activeLoginBindingId: onlyBinding.id,
    });
  });

  test("contains provider-account collisions as a deterministic cross-human dispute", async () => {
    if (!shared || !client) return;
    const firstUser = await createAuthUser({ name: "First Collision Human" });
    const secondUser = await createAuthUser({ name: "Second Collision Human" });
    const firstIdentity = await ensureCanonicalHumanIdentityForAuthUser(client.db, firstUser);
    const secondIdentity = await ensureCanonicalHumanIdentityForAuthUser(client.db, secondUser);
    const providerAccountId = `collision-${crypto.randomUUID()}`;
    await createVerifiedBinding(firstUser, "github", providerAccountId);
    const linked = await applyCanonicalHumanIdentityOperation(client.db, {
      operationId: crypto.randomUUID(),
      authUserId: firstUser,
      expectedIdentityRevision: firstIdentity.identityRevision,
      operationType: "link",
      providerId: "github",
      providerAccountId,
      reason: "Attach first collision claimant",
    });
    const firstSession = await createStampedSession(firstUser, {
      identityId: linked.identity.activeIdentity.id,
      identityRevision: linked.identity.activeIdentity.identityRevision,
      authRevision: linked.identity.activeIdentity.authRevision,
    });
    await shared.admin`
      update auth_identities
      set user_id = ${secondUser}, updated_at = now()
      where provider_id = 'github' and account_id = ${providerAccountId}
    `;
    const disputed = await applyCanonicalHumanIdentityOperation(client.db, {
      operationId: crypto.randomUUID(),
      authUserId: secondUser,
      expectedIdentityRevision: secondIdentity.identityRevision,
      operationType: "link",
      providerId: "github",
      providerAccountId,
      reason: "Contain conflicting verified claimant",
    });
    expect(disputed.outcome).toBe("disputed");
    const identities = await shared.admin<{ id: string; status: string; recoveryState: string }[]>`
      select id, status, recovery_state as "recoveryState"
      from canonical_human_identities
      where id in (${firstIdentity.identityId}, ${secondIdentity.identityId})
      order by id
    `;
    expect(identities).toHaveLength(2);
    expect(
      identities.every((row) => row.status === "disputed" && row.recoveryState === "disputed"),
    ).toBe(true);
    expect(
      await validateCanonicalHumanSession(client.db, {
        authSessionId: firstSession,
        authUserId: firstUser,
        allowRecovery: true,
      }),
    ).toBe(false);
  });

  test("keeps one human's two organization memberships independent with no cross-organization resource path", async () => {
    if (!shared || !client) return;
    const userId = await createAuthUser({ name: "Multi Organization Human" });
    const identity = await ensureCanonicalHumanIdentityForAuthUser(client.db, userId);
    const subjectId = `user:${userId}`;
    const accountA = crypto.randomUUID();
    const accountB = crypto.randomUUID();
    const workspaceA = crypto.randomUUID();
    const workspaceB = crypto.randomUUID();
    await shared.admin`
      insert into managed_accounts (id, name) values
        (${accountA}, 'Organization A'),
        (${accountB}, 'Organization B')
    `;
    await shared.admin`
      insert into workspaces (id, account_id, name) values
        (${workspaceA}, ${accountA}, 'Personal A'),
        (${workspaceB}, ${accountB}, 'Personal B')
    `;
    const memberships = await shared.admin<{ id: string; accountId: string }[]>`
      insert into organization_memberships (
        account_id, subject_id, status, personal_workspace_id
      ) values
        (${accountA}, ${subjectId}, 'active', ${workspaceA}),
        (${accountB}, ${subjectId}, 'active', ${workspaceB})
      returning id, account_id as "accountId"
    `;
    expect(memberships).toHaveLength(2);
    expect(new Set(memberships.map((row) => row.accountId))).toEqual(new Set([accountA, accountB]));
    expect(new Set(memberships.map((row) => row.id)).size).toBe(2);

    await expectSqlState(
      () =>
        shared!.admin`
          insert into organization_user_resource_authorities (
            account_id, organization_membership_id, resource_kind, resource_id
          ) values (
            ${accountA}, ${memberships.find((row) => row.accountId === accountB)!.id},
            'variable_set', ${crypto.randomUUID()}
          )
        `,
      "23503",
    );

    const projection = await getCanonicalHumanIdentityProjection(client.db, userId);
    expect(projection.activeIdentity.id).toBe(identity.identityId);
    const serialized = JSON.stringify(projection);
    expect(serialized).not.toContain(accountA);
    expect(serialized).not.toContain(accountB);
    expect(serialized).not.toContain(workspaceA);
    expect(serialized).not.toContain(workspaceB);
    expect(serialized).not.toContain("membership");
    expect(serialized).not.toContain("resource");
  });
});
