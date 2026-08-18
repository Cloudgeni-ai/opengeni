import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import {
  createDb,
  createSession,
  ensureManagedAccessForUser,
  listSessionsForSubject,
  SESSION_LIST_SNAPSHOT_REDACTED_SESSION_ID,
  transitionSessionVisibility,
  type DbClient,
} from "../src";

const migrationPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../drizzle/0295_session_snapshot_and_pin_visibility.sql",
);
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("migration-0295-session-snapshot-and-pin-visibility");
  if (!shared && requireRealDatabase) {
    throw new Error(
      "[migration-0295-session-snapshot-and-pin-visibility] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable",
    );
  }
  if (shared) client = createDb(shared.appUrl, { max: 8 });
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

type Fixture = {
  accountId: string;
  workspaceId: string;
  ownerSubjectId: string;
  otherSubjectId: string;
};

/**
 * One workspace with an owning managed human plus a second ordinary member. The
 * second member is the party whose cached list page and personal pin must not
 * survive a visibility transition they were not party to.
 */
async function twoMemberWorkspace(label: string): Promise<Fixture> {
  if (!shared || !client) throw new Error("test database unavailable");
  const suffix = crypto.randomUUID();
  const ownerUserId = `${label}-owner-${suffix}`;
  const ownerSubjectId = `user:${ownerUserId}`;
  const access = await ensureManagedAccessForUser(client.db, {
    userId: ownerUserId,
    email: `${ownerUserId}@example.test`,
    name: "Session owner",
  });
  const grant = access.workspaceGrants[0]!;
  const otherSubjectId = `user:${label}-other-${suffix}`;
  const otherPersonalWorkspaceId = crypto.randomUUID();
  await shared.admin`
    insert into workspaces (id, account_id, name, external_source, external_id)
    values (
      ${otherPersonalWorkspaceId}, ${grant.accountId}, 'Other personal workspace',
      ${label}, ${`other-${suffix}`}
    )
  `;
  await shared.admin`
    insert into organization_memberships (account_id, subject_id, status, personal_workspace_id)
    values (${grant.accountId}, ${otherSubjectId}, 'active', ${otherPersonalWorkspaceId})
  `;
  await shared.admin`
    insert into workspace_memberships (account_id, workspace_id, subject_id, role, permissions)
    values (
      ${grant.accountId}, ${grant.workspaceId}, ${otherSubjectId}, 'member',
      '["sessions:read","sessions:control"]'::jsonb
    )
  `;
  return {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    ownerSubjectId,
    otherSubjectId,
  };
}

async function ownedSession(fixture: Fixture, message: string): Promise<string> {
  const session = await createSession(client!.db, {
    accountId: fixture.accountId,
    workspaceId: fixture.workspaceId,
    initialMessage: message,
    resources: [],
    metadata: {},
    model: "test-model",
    sandboxBackend: "modal",
    createdBy: { kind: "subject", subjectId: fixture.ownerSubjectId },
    createdByContext: {},
  });
  return session.id;
}

/** Run `fn` on a runtime-role (NOSUPERUSER NOBYPASSRLS) connection as `subjectId`. */
async function asMember<T>(
  app: postgres.Sql,
  fixture: Fixture,
  subjectId: string,
  fn: (sql: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  return (await app.begin(async (sql) => {
    await sql`select set_config('opengeni.account_id', ${fixture.accountId}, true)`;
    await sql`select set_config('opengeni.workspace_id', ${fixture.workspaceId}, true)`;
    await sql`select set_config('opengeni.subject_id', ${subjectId}, true)`;
    return await fn(sql);
  })) as T;
}

async function makePrivate(fixture: Fixture, sessionId: string, epoch: number): Promise<void> {
  await transitionSessionVisibility(client!.db, {
    workspaceId: fixture.workspaceId,
    sessionId,
    actorSubjectId: fixture.ownerSubjectId,
    targetVisibility: "user_private",
    expectedAuthorityEpoch: epoch,
    operationKey: `private:${crypto.randomUUID()}`,
  });
}

describe("migration 0295 session list snapshot and pin visibility", () => {
  test("declares a rolling deployment mode and the bounded stripping contract", async () => {
    const migration = await readFile(migrationPath, "utf8");
    expect(migration.split(/\r?\n/u, 1)[0]).toBe("-- deployment-mode: rolling");
    expect(migration).toContain("session_visibility_lifecycle_capability_held");
    expect(migration).toContain("pg_current_xact_id_if_assigned()");
    expect(migration).toContain("CREATE POLICY session_visibility_cache_stripping");
    expect(migration).toContain("CREATE TRIGGER sessions_strip_private_list_snapshots");
    expect(migration).toContain("snapshot.subject_id IS DISTINCT FROM NEW.owner_subject_id");
    expect(migration).toContain("'00000000-0000-0000-0000-000000000000'::uuid");
    // The strip must never be reachable from a forgeable GUC alone.
    expect(migration).toContain("FROM session_visibility_write_capabilities capability");
    // The pin escape belongs on USING only; WITH CHECK stays strict so a member
    // cannot pin — or flip `pinned` on — a session they cannot see.
    const pinPolicy = migration.slice(
      migration.indexOf("CREATE POLICY session_visibility_isolation ON %1$I.session_pins"),
    );
    const pinUsing = pinPolicy.slice(0, pinPolicy.indexOf("WITH CHECK"));
    const pinCheck = pinPolicy.slice(pinPolicy.indexOf("WITH CHECK"));
    expect(pinUsing).toContain("subject_id = opengeni_private.current_subject_id()");
    expect(pinCheck).not.toContain("subject_id = opengeni_private.current_subject_id()");
  });

  test("installs the capability policy, strip trigger, and pin escape", async () => {
    if (!shared) return;
    const [cachePolicy] = await shared.admin<Array<{ using: string; permissive: boolean }>>`
      select pg_get_expr(policy.polqual, policy.polrelid) as using,
             policy.polpermissive as permissive
      from pg_policy policy
      join pg_class relation on relation.oid = policy.polrelid
      where relation.relname = 'session_list_snapshots'
        and policy.polname = 'session_visibility_cache_stripping'
    `;
    expect(cachePolicy?.permissive).toBe(true);
    expect(cachePolicy?.using).toContain("session_visibility_lifecycle_capability_held");

    const [trigger] = await shared.admin<Array<{ definition: string }>>`
      select pg_get_triggerdef(trigger_row.oid) as definition
      from pg_trigger trigger_row
      join pg_class relation on relation.oid = trigger_row.tgrelid
      where relation.relname = 'sessions'
        and trigger_row.tgname = 'sessions_strip_private_list_snapshots'
    `;
    expect(trigger?.definition).toContain("AFTER UPDATE OF visibility");
    expect(trigger?.definition).toContain("user_private");

    // 0225's generic FK loop must still consider `session_pins` isolated.
    const [pinPolicy] = await shared.admin<
      Array<{ using: string; check: string | null; permissive: boolean }>
    >`
      select pg_get_expr(policy.polqual, policy.polrelid) as using,
             pg_get_expr(policy.polwithcheck, policy.polrelid) as check,
             policy.polpermissive as permissive
      from pg_policy policy
      join pg_class relation on relation.oid = policy.polrelid
      where relation.relname = 'session_pins'
        and policy.polname = 'session_visibility_isolation'
    `;
    expect(pinPolicy?.permissive).toBe(false);
    expect(pinPolicy?.using).toContain("current_subject_id()");
    expect(pinPolicy?.check).toContain("session_reference_visible");
    expect(pinPolicy?.check).not.toContain("current_subject_id()");
  }, 180_000);

  test("strips a transitioned session out of another member's cached page", async () => {
    if (!shared || !client) return;
    const fixture = await twoMemberWorkspace("strip");
    const leaked = await ownedSession(fixture, "pre-fix leak");
    const stripped = await ownedSession(fixture, "post-fix strip");
    const untouched = await ownedSession(fixture, "still shared");

    const app = postgres(shared.appUrl, { max: 2 });
    try {
      // The other member caches one list page naming all three sessions.
      const snapshotId = await asMember(app, fixture, fixture.otherSubjectId, async (sql) => {
        const [row] = await sql<Array<{ id: string }>>`
          insert into session_list_snapshots (
            account_id, workspace_id, subject_id, ordinary_session_ids, expires_at
          ) values (
            ${fixture.accountId}, ${fixture.workspaceId}, ${fixture.otherSubjectId},
            ${sql.array([leaked, stripped, untouched])}::uuid[], now() + interval '1 hour'
          ) returning id
        `;
        return row!.id;
      });
      // The owner caches their own page naming the same sessions; it is not
      // stale for them, so it must survive untouched.
      await asMember(app, fixture, fixture.ownerSubjectId, async (sql) => {
        await sql`
          insert into session_list_snapshots (
            account_id, workspace_id, subject_id, ordinary_session_ids, expires_at
          ) values (
            ${fixture.accountId}, ${fixture.workspaceId}, ${fixture.ownerSubjectId},
            ${sql.array([leaked, stripped, untouched])}::uuid[], now() + interval '1 hour'
          )
        `;
      });

      // BEFORE: reproduce the exact pre-0294 behaviour by disabling only the new
      // trigger. Everything else — 0225's policies, the transition function —
      // is unchanged.
      await shared.admin`
        alter table sessions disable trigger sessions_strip_private_list_snapshots
      `;
      await makePrivate(fixture, leaked, 1);
      await shared.admin`
        alter table sessions enable trigger sessions_strip_private_list_snapshots
      `;

      // AFTER: the same transition with the fix in place.
      await makePrivate(fixture, stripped, 1);

      const observed = await asMember(app, fixture, fixture.otherSubjectId, async (sql) => {
        const [row] = await sql<Array<{ ids: string[] }>>`
          select ordinary_session_ids as ids from session_list_snapshots
          where id = ${snapshotId}
        `;
        const visible = await sql<Array<{ id: string }>>`
          select id from sessions where id in ${sql([leaked, stripped, untouched])}
        `;
        return { ids: row!.ids, visible: visible.map((entry) => entry.id).sort() };
      });

      // Neither private session is readable — 0225 already guarantees that.
      expect(observed.visible).toEqual([untouched]);
      // The un-stripped transition still leaks its identity into the cache; the
      // stripped one is redacted; the still-shared session is unchanged.
      expect(observed.ids).toEqual([leaked, SESSION_LIST_SNAPSHOT_REDACTED_SESSION_ID, untouched]);
      // Cursor offsets are byte-stable: the redacted slot keeps its position.
      expect(observed.ids).toHaveLength(3);

      // The owner's own cached page is untouched by their own transition.
      const ownerIds = await asMember(app, fixture, fixture.ownerSubjectId, async (sql) => {
        const [row] = await sql<Array<{ ids: string[] }>>`
          select ordinary_session_ids as ids from session_list_snapshots
          where subject_id = ${fixture.ownerSubjectId}
        `;
        return row!.ids;
      });
      expect(ownerIds).toEqual([leaked, stripped, untouched]);
    } finally {
      await app.end();
    }
  }, 180_000);

  test("keeps the strip unreachable for the runtime role", async () => {
    if (!shared || !client) return;
    const fixture = await twoMemberWorkspace("forge");
    const sessionId = await ownedSession(fixture, "forge target");
    const app = postgres(shared.appUrl, { max: 2 });
    try {
      await asMember(app, fixture, fixture.otherSubjectId, async (sql) => {
        await sql`
          insert into session_list_snapshots (
            account_id, workspace_id, subject_id, ordinary_session_ids, expires_at
          ) values (
            ${fixture.accountId}, ${fixture.workspaceId}, ${fixture.otherSubjectId},
            ${sql.array([sessionId])}::uuid[], now() + interval '1 hour'
          )
        `;
      });

      // The capability GUC alone is not authority: the runtime role cannot mint
      // the backing row, and it cannot read the capability table at all.
      const forged = await asMember(app, fixture, fixture.ownerSubjectId, async (sql) => {
        await sql`
          select set_config(
            'opengeni.session_visibility_write_capability', ${crypto.randomUUID()}, true
          )
        `;
        const held = await sql<Array<{ held: boolean }>>`
          select session_visibility_lifecycle_capability_held() as held
        `;
        const updated = await sql`
          update session_list_snapshots set ordinary_session_ids = '{}'::uuid[]
          where subject_id = ${fixture.otherSubjectId}
        `;
        return { held: held[0]!.held, updated: updated.count };
      });
      expect(forged).toEqual({ held: false, updated: 0 });

      let mintFailure: unknown;
      try {
        await asMember(app, fixture, fixture.ownerSubjectId, async (sql) => {
          await sql`
            insert into session_visibility_write_capabilities (
              backend_pid, transaction_id, capability_id
            ) values (pg_backend_pid(), pg_current_xact_id(), ${crypto.randomUUID()})
          `;
        });
      } catch (error) {
        mintFailure = error;
      }
      expect(mintFailure).toBeDefined();
      expect(String(mintFailure)).toContain("session_visibility_write_capabilities");
    } finally {
      await app.end();
    }
  }, 180_000);

  test("keeps a stale pin invisible to the product but removable by its owner", async () => {
    if (!shared || !client) return;
    const fixture = await twoMemberWorkspace("pin");
    const sessionId = await ownedSession(fixture, "pinned then privatised");
    const app = postgres(shared.appUrl, { max: 2 });
    try {
      await asMember(app, fixture, fixture.otherSubjectId, async (sql) => {
        await sql`
          insert into session_pins (account_id, workspace_id, subject_id, session_id)
          values (
            ${fixture.accountId}, ${fixture.workspaceId}, ${fixture.otherSubjectId},
            ${sessionId}
          )
        `;
      });
      await makePrivate(fixture, sessionId, 1);

      // BEFORE: restore 0225's `FOR ALL` strict predicate and show the pin is
      // both invisible and permanently undeletable by the member who made it.
      await shared.admin.unsafe(`
        drop policy session_visibility_isolation on session_pins;
        create policy session_visibility_isolation on session_pins as restrictive
          for all
          using (session_reference_visible(account_id, workspace_id, session_id))
          with check (session_reference_visible(account_id, workspace_id, session_id));
      `);
      const beforeFix = await asMember(app, fixture, fixture.otherSubjectId, async (sql) => {
        const rows = await sql`select id from session_pins where session_id = ${sessionId}`;
        const deleted = await sql`delete from session_pins where session_id = ${sessionId}`;
        return { readable: rows.length, deleted: deleted.count };
      });
      expect(beforeFix).toEqual({ readable: 0, deleted: 0 });

      // AFTER: restore 0295's owner escape.
      await shared.admin.unsafe(`
        drop policy session_visibility_isolation on session_pins;
        create policy session_visibility_isolation on session_pins as restrictive
          for all
          using (
            session_reference_visible(account_id, workspace_id, session_id)
            or subject_id = opengeni_private.current_subject_id()
          )
          with check (session_reference_visible(account_id, workspace_id, session_id));
      `);

      // The pin is still inert everywhere the product looks: the session itself
      // stays invisible, so neither the pinned rail nor the ordinary page can
      // surface it.
      const listed = await listSessionsForSubject(client.db, fixture.workspaceId, {
        subjectId: fixture.otherSubjectId,
        limit: 50,
      });
      expect(listed.pinned).toEqual([]);
      expect(listed.sessions.some((session) => session.id === sessionId)).toBe(false);

      const readable = await asMember(
        app,
        fixture,
        fixture.otherSubjectId,
        async (sql) =>
          (await sql`select id from session_pins where session_id = ${sessionId}`).length,
      );
      expect(readable).toBe(1);

      // A member still cannot pin — or re-pin — a session they cannot see, so
      // the escape never becomes a session-existence oracle through the FK.
      let insertFailure: unknown;
      try {
        await asMember(app, fixture, fixture.otherSubjectId, async (sql) => {
          await sql`
            insert into session_pins (account_id, workspace_id, subject_id, session_id)
            values (
              ${fixture.accountId}, ${fixture.workspaceId}, ${fixture.otherSubjectId},
              ${crypto.randomUUID()}
            )
          `;
        });
      } catch (error) {
        insertFailure = error;
      }
      expect(String(insertFailure)).toContain("session_visibility_isolation");

      const deleted = await asMember(app, fixture, fixture.otherSubjectId, async (sql) => {
        const rows = await sql`delete from session_pins where session_id = ${sessionId}`;
        return rows.count;
      });
      expect(deleted).toBe(1);

      // A different member never gains anything from the escape.
      const [remaining] = await shared.admin<Array<{ count: number }>>`
        select count(*)::int as count from session_pins where session_id = ${sessionId}
      `;
      expect(remaining?.count).toBe(0);
    } finally {
      await app.end();
    }
  }, 180_000);

  // The shared harness migrates as a SUPERUSER, and a superuser bypasses FORCE
  // RLS outright — so the strip above would have committed even without the new
  // policy. A deployment whose migration owner is an ordinary NOSUPERUSER
  // NOBYPASSRLS role is the case the policy actually exists for. Re-own the
  // strip onto such a role and prove both directions.
  test("admits the strip for a NOSUPERUSER NOBYPASSRLS owner only under the capability", async () => {
    if (!shared || !client) return;
    const fixture = await twoMemberWorkspace("nosuper");
    const sessionId = await ownedSession(fixture, "non-superuser owner strip");
    const role = `og_0294_probe_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const app = postgres(shared.appUrl, { max: 2 });
    try {
      await asMember(app, fixture, fixture.otherSubjectId, async (sql) => {
        await sql`
          insert into session_list_snapshots (
            account_id, workspace_id, subject_id, ordinary_session_ids, expires_at
          ) values (
            ${fixture.accountId}, ${fixture.workspaceId}, ${fixture.otherSubjectId},
            ${sql.array([sessionId])}::uuid[], now() + interval '1 hour'
          )
        `;
      });

      // Re-own ONLY the shipped trigger function onto a non-superuser role.
      // The transition function and the capability minting stay exactly as
      // shipped, so this exercises the real code path.
      await shared.admin.unsafe(`
        create role ${role} nosuperuser nobypassrls;
        grant usage on schema public, opengeni_private to ${role};
        grant execute on all functions in schema opengeni_private to ${role};
        grant execute on function session_visibility_lifecycle_capability_held() to ${role};
        grant select, update on session_list_snapshots to ${role};
        alter function strip_private_session_list_snapshots() owner to ${role};
      `);

      const [policy] = await shared.admin<Array<{ using: string }>>`
        select pg_get_expr(policy.polqual, policy.polrelid) as using
        from pg_policy policy
        join pg_class relation on relation.oid = policy.polrelid
        where relation.relname = 'session_list_snapshots'
          and policy.polname = 'session_visibility_cache_stripping'
      `;
      const capabilityPredicate = policy!.using;

      // NEGATIVE CONTROL: without the capability policy, FORCE RLS genuinely
      // engages for the non-superuser trigger owner and the strip silently
      // reaches nothing. The policy is the only thing that admits it.
      await shared.admin`
        drop policy session_visibility_cache_stripping on session_list_snapshots
      `;
      await makePrivate(fixture, sessionId, 1);
      const withoutPolicy = await asMember(
        app,
        fixture,
        fixture.otherSubjectId,
        async (sql) =>
          (
            await sql<Array<{ ids: string[] }>>`
              select ordinary_session_ids as ids from session_list_snapshots
            `
          )[0]!.ids,
      );
      expect(withoutPolicy).toEqual([sessionId]);

      // POSITIVE: restore the shipped policy and the same non-superuser trigger
      // owner strips the page — proving the capability is genuinely held when
      // the AFTER trigger fires, before the transition releases it.
      await shared.admin.unsafe(`
        create policy session_visibility_cache_stripping on session_list_snapshots
          for all using (${capabilityPredicate}) with check (${capabilityPredicate});
      `);
      const second = await ownedSession(fixture, "second private session");
      await asMember(app, fixture, fixture.otherSubjectId, async (sql) => {
        await sql`
          update session_list_snapshots
          set ordinary_session_ids = ${sql.array([sessionId, second])}::uuid[]
        `;
      });
      await makePrivate(fixture, second, 1);
      const withPolicy = await asMember(
        app,
        fixture,
        fixture.otherSubjectId,
        async (sql) =>
          (
            await sql<Array<{ ids: string[] }>>`
              select ordinary_session_ids as ids from session_list_snapshots
            `
          )[0]!.ids,
      );
      expect(withPolicy).toEqual([sessionId, SESSION_LIST_SNAPSHOT_REDACTED_SESSION_ID]);
    } finally {
      await app.end();
      await shared.admin
        .unsafe(
          `alter function strip_private_session_list_snapshots() owner to current_user;
           drop owned by ${role} cascade;
           drop role ${role};`,
        )
        .catch(() => undefined);
    }
  }, 180_000);

  test("denies another member's pin to everyone but its owner", async () => {
    if (!shared || !client) return;
    const fixture = await twoMemberWorkspace("cross");
    const sessionId = await ownedSession(fixture, "cross-member pin");
    const app = postgres(shared.appUrl, { max: 2 });
    try {
      await asMember(app, fixture, fixture.otherSubjectId, async (sql) => {
        await sql`
          insert into session_pins (account_id, workspace_id, subject_id, session_id)
          values (
            ${fixture.accountId}, ${fixture.workspaceId}, ${fixture.otherSubjectId},
            ${sessionId}
          )
        `;
      });
      await makePrivate(fixture, sessionId, 1);
      const asOwner = await asMember(app, fixture, fixture.ownerSubjectId, async (sql) => {
        const rows = await sql`select id from session_pins where session_id = ${sessionId}`;
        const deleted = await sql`delete from session_pins where session_id = ${sessionId}`;
        return { readable: rows.length, deleted: deleted.count };
      });
      expect(asOwner).toEqual({ readable: 0, deleted: 0 });
    } finally {
      await app.end();
    }
  }, 180_000);
});
