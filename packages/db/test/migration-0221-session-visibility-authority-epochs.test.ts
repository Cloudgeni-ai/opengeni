import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import {
  assertSessionAuthoritySnapshot,
  sessionAuthoritySnapshotMatchesSession,
  sessionAuthoritySnapshotsEqual,
} from "../src/session-control";

const migrationPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../drizzle/0221_session_visibility_authority_epochs.sql",
);
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

let shared: SharedTestDatabase | null = null;
let admin: ReturnType<typeof postgres> | null = null;
let schemaName = "";
let legacy: { accountId: string; workspaceId: string; sessionId: string; attemptId: string };
let migration = "";

const table = (name: string): string => `"${schemaName}"."${name}"`;

async function expectSqlState(action: () => Promise<unknown>, state: string): Promise<void> {
  let failure: unknown;
  try {
    await action();
  } catch (error) {
    failure = error;
  }
  expect((failure as { code?: string } | undefined)?.code).toBe(state);
}

beforeAll(async () => {
  migration = await readFile(migrationPath, "utf8");
  shared = await acquireSharedTestDatabase("migration-0221-session-visibility-authority-epochs");
  if (!shared && requireRealDatabase) {
    throw new Error(
      "[migration-0221-session-visibility-authority-epochs] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable",
    );
  }
  if (!shared) return;

  admin = postgres(shared.adminUrl, { max: 4 });
  schemaName = `slice_c_${crypto.randomUUID().replaceAll("-", "")}`;
  legacy = {
    accountId: crypto.randomUUID(),
    workspaceId: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    attemptId: crypto.randomUUID(),
  };

  await admin.unsafe(`create schema "${schemaName}"`);
  await admin.begin(async (tx) => {
    await tx.unsafe(`set local search_path to "${schemaName}"`);
    await tx.unsafe(`
      create table workspaces (
        id uuid primary key,
        account_id uuid not null,
        unique (id, account_id)
      );
      create table organization_memberships (
        id uuid primary key,
        account_id uuid not null,
        unique (id, account_id)
      );
      create table sessions (
        id uuid primary key,
        account_id uuid not null,
        workspace_id uuid not null,
        authority_epoch integer not null,
        visibility text not null,
        owner_organization_membership_id uuid,
        unique (workspace_id, id)
      );
      create table session_turn_attempts (
        id uuid primary key,
        account_id uuid not null,
        workspace_id uuid not null,
        session_id uuid not null,
        state text not null
      );
      insert into workspaces (id, account_id)
      values ('${legacy.workspaceId}', '${legacy.accountId}');
      insert into sessions (
        id, account_id, workspace_id, authority_epoch, visibility
      ) values (
        '${legacy.sessionId}', '${legacy.accountId}', '${legacy.workspaceId}', 7, 'workspace_shared'
      );
      insert into session_turn_attempts (
        id, account_id, workspace_id, session_id, state
      ) values (
        '${legacy.attemptId}', '${legacy.accountId}', '${legacy.workspaceId}', '${legacy.sessionId}', 'claimed'
      );
    `);
    await tx.unsafe(migration);
  });
}, 180_000);

afterAll(async () => {
  if (admin && schemaName) {
    await admin.unsafe(`drop schema if exists "${schemaName}" cascade`).catch(() => undefined);
  }
  await admin?.end().catch(() => undefined);
  await shared?.release();
}, 180_000);

describe("migration 0221 session visibility authority epochs", () => {
  test("keeps migration order, total constraints, trigger posture, and no authority bypass", () => {
    if (!shared) return;
    expect(migration.split(/\r?\n/u, 1)[0]).toBe("-- deployment-mode: rolling");
    expect(migration).toContain('ALTER COLUMN "authority_epoch" SET NOT NULL');
    expect(migration).toContain('ALTER COLUMN "authority_visibility" SET NOT NULL');
    expect(migration).toContain("CREATE TRIGGER session_turn_attempts_fill_authority_snapshot_trg");
    expect(migration).toContain(
      "CREATE TRIGGER session_turn_attempts_guard_authority_snapshot_immutable_trg",
    );
    expect(migration).not.toContain("SECURITY DEFINER");
    expect(migration).not.toContain("set_config");
    expect(migration).not.toContain("GRANT ");
    const triggerStart = migration.indexOf(
      "CREATE OR REPLACE FUNCTION %1$I.session_turn_attempts_fill_authority_snapshot",
    );
    const workspaceLock = migration.indexOf("FROM %1$I.workspaces", triggerStart);
    const sessionLock = migration.indexOf("FROM %1$I.sessions", workspaceLock);
    expect(triggerStart).toBeGreaterThanOrEqual(0);
    expect(workspaceLock).toBeGreaterThan(triggerStart);
    expect(sessionLock).toBeGreaterThan(workspaceLock);
    expect(migration.indexOf('UPDATE "session_turn_attempts" attempts')).toBeLessThan(triggerStart);
  });

  test("backfills legacy attempts and fills omitted old-writer inserts exactly", async () => {
    if (!admin) return;
    const [backfilled] = await admin.unsafe<
      Array<{
        authorityEpoch: number;
        authorityVisibility: string;
        ownerMembershipId: string | null;
      }>
    >(
      `select authority_epoch as "authorityEpoch", authority_visibility as "authorityVisibility", authority_owner_organization_membership_id as "ownerMembershipId" from ${table("session_turn_attempts")} where id = '${legacy.attemptId}'`,
    );
    expect(backfilled).toEqual({
      authorityEpoch: 7,
      authorityVisibility: "workspace_shared",
      ownerMembershipId: null,
    });

    const insertedId = crypto.randomUUID();
    await admin.unsafe(`
      insert into ${table("session_turn_attempts")} (id, account_id, workspace_id, session_id, state)
      values ('${insertedId}', '${legacy.accountId}', '${legacy.workspaceId}', '${legacy.sessionId}', 'claimed')
    `);
    const [filled] = await admin.unsafe<
      Array<{
        authorityEpoch: number;
        authorityVisibility: string;
        ownerMembershipId: string | null;
      }>
    >(
      `select authority_epoch as "authorityEpoch", authority_visibility as "authorityVisibility", authority_owner_organization_membership_id as "ownerMembershipId" from ${table("session_turn_attempts")} where id = '${insertedId}'`,
    );
    expect(filled).toEqual(backfilled);

    const privateMembershipId = crypto.randomUUID();
    const privateSessionId = crypto.randomUUID();
    const privateAttemptId = crypto.randomUUID();
    await admin.unsafe(`
      insert into ${table("organization_memberships")} (id, account_id)
      values ('${privateMembershipId}', '${legacy.accountId}');
      insert into ${table("sessions")} (
        id, account_id, workspace_id, authority_epoch, visibility,
        owner_organization_membership_id
      ) values (
        '${privateSessionId}', '${legacy.accountId}', '${legacy.workspaceId}', 37,
        'user_private', '${privateMembershipId}'
      );
      insert into ${table("session_turn_attempts")} (
        id, account_id, workspace_id, session_id, state
      ) values (
        '${privateAttemptId}', '${legacy.accountId}', '${legacy.workspaceId}',
        '${privateSessionId}', 'claimed'
      );
    `);
    const [privateFilled] = await admin.unsafe<
      Array<{
        authorityEpoch: number;
        authorityVisibility: string;
        ownerMembershipId: string | null;
      }>
    >(
      `select authority_epoch as "authorityEpoch", authority_visibility as "authorityVisibility", authority_owner_organization_membership_id as "ownerMembershipId" from ${table("session_turn_attempts")} where id = '${privateAttemptId}'`,
    );
    expect(privateFilled).toEqual({
      authorityEpoch: 37,
      authorityVisibility: "user_private",
      ownerMembershipId: privateMembershipId,
    });
  });

  test("preserves shared provenance and private owner shape", async () => {
    if (!admin) return;
    const membershipId = crypto.randomUUID();
    const provenanceSessionId = crypto.randomUUID();
    const privateSessionId = crypto.randomUUID();
    await admin.unsafe(`
      insert into ${table("organization_memberships")} (id, account_id)
      values ('${membershipId}', '${legacy.accountId}');
      insert into ${table("sessions")} (id, account_id, workspace_id, authority_epoch, visibility, owner_organization_membership_id)
      values
        ('${provenanceSessionId}', '${legacy.accountId}', '${legacy.workspaceId}', 8, 'workspace_shared', '${membershipId}'),
        ('${privateSessionId}', '${legacy.accountId}', '${legacy.workspaceId}', 9, 'user_private', '${membershipId}');
    `);
    for (const [sessionId, epoch] of [
      [provenanceSessionId, 8],
      [privateSessionId, 9],
    ] as const) {
      const attemptId = crypto.randomUUID();
      await admin.unsafe(`
        insert into ${table("session_turn_attempts")} (id, account_id, workspace_id, session_id, state)
        values ('${attemptId}', '${legacy.accountId}', '${legacy.workspaceId}', '${sessionId}', 'claimed')
      `);
      const [row] = await admin.unsafe<
        Array<{ authorityEpoch: number; ownerMembershipId: string }>
      >(
        `select authority_epoch as "authorityEpoch", authority_owner_organization_membership_id as "ownerMembershipId" from ${table("session_turn_attempts")} where id = '${attemptId}'`,
      );
      expect(row).toEqual({ authorityEpoch: epoch, ownerMembershipId: membershipId });
    }
  });

  test("rejects every partial or invalid tuple, including CHECK-UNKNOWN shapes", async () => {
    if (!admin) return;
    const cases = [
      { values: "null, 'workspace_shared', null", state: "23502" },
      { values: "10, null, null", state: "23502" },
      { values: `null, null, '${crypto.randomUUID()}'`, state: "23502" },
      { values: "10, 'invalid', null", state: "23514" },
      { values: "10, 'user_private', null", state: "23514" },
      { values: `10, 'user_private', '${crypto.randomUUID()}'`, state: "23503" },
    ];
    for (const { values, state } of cases) {
      await expectSqlState(
        () =>
          admin!.unsafe(`
            insert into ${table("session_turn_attempts")} (
              id, account_id, workspace_id, session_id, state,
              authority_epoch, authority_visibility, authority_owner_organization_membership_id
            ) values (
              '${crypto.randomUUID()}', '${legacy.accountId}', '${legacy.workspaceId}', '${legacy.sessionId}', 'claimed',
              ${values}
            )
          `),
        state,
      );
    }
  });

  test("snapshot columns are immutable while ordinary attempt state remains mutable", async () => {
    if (!admin) return;
    const attemptId = crypto.randomUUID();
    await admin.unsafe(`
      insert into ${table("session_turn_attempts")} (id, account_id, workspace_id, session_id, state)
      values ('${attemptId}', '${legacy.accountId}', '${legacy.workspaceId}', '${legacy.sessionId}', 'claimed')
    `);
    await expectSqlState(
      () =>
        admin!.unsafe(
          `update ${table("session_turn_attempts")} set authority_epoch = 99 where id = '${attemptId}'`,
        ),
      "23514",
    );
    await admin.unsafe(
      `update ${table("session_turn_attempts")} set state = 'running' where id = '${attemptId}'`,
    );
    const [row] = await admin.unsafe<Array<{ state: string; authorityEpoch: number }>>(
      `select state, authority_epoch as "authorityEpoch" from ${table("session_turn_attempts")} where id = '${attemptId}'`,
    );
    expect(row).toEqual({ state: "running", authorityEpoch: 7 });
  });

  test("pure helpers accept current tuples and reject replay/stale mismatches", () => {
    const workspace = assertSessionAuthoritySnapshot({
      authorityEpoch: 7,
      authorityVisibility: "workspace_shared",
      authorityOwnerOrganizationMembershipId: null,
    });
    const privateSnapshot = assertSessionAuthoritySnapshot({
      authorityEpoch: 9,
      authorityVisibility: "user_private",
      authorityOwnerOrganizationMembershipId: crypto.randomUUID(),
    });
    expect(workspace).toMatchObject({ authorityEpoch: 7, authorityVisibility: "workspace_shared" });
    expect(privateSnapshot.authorityVisibility).toBe("user_private");
    expect(() =>
      assertSessionAuthoritySnapshot({
        authorityEpoch: null,
        authorityVisibility: "workspace_shared",
        authorityOwnerOrganizationMembershipId: null,
      }),
    ).toThrow();
    expect(
      sessionAuthoritySnapshotMatchesSession(workspace, {
        authorityEpoch: 7,
        visibility: "workspace_shared",
        ownerOrganizationMembershipId: null,
      }),
    ).toBe(true);
    expect(
      sessionAuthoritySnapshotMatchesSession(workspace, {
        authorityEpoch: 8,
        visibility: "workspace_shared",
        ownerOrganizationMembershipId: null,
      }),
    ).toBe(false);
    expect(
      sessionAuthoritySnapshotMatchesSession(workspace, {
        authorityEpoch: 7,
        visibility: "user_private",
        ownerOrganizationMembershipId: privateSnapshot.authorityOwnerOrganizationMembershipId,
      }),
    ).toBe(false);
    expect(
      sessionAuthoritySnapshotMatchesSession(privateSnapshot, {
        authorityEpoch: 9,
        visibility: "user_private",
        ownerOrganizationMembershipId: crypto.randomUUID(),
      }),
    ).toBe(false);
    expect(sessionAuthoritySnapshotsEqual(workspace, { ...workspace })).toBe(true);
    expect(sessionAuthoritySnapshotsEqual(workspace, { ...workspace, authorityEpoch: 8 })).toBe(
      false,
    );
    expect(
      sessionAuthoritySnapshotsEqual(workspace, {
        ...workspace,
        authorityVisibility: "user_private",
      }),
    ).toBe(false);
  });
});
