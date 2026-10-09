import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { sql } from "drizzle-orm";
import { readFile } from "node:fs/promises";

import {
  createDb,
  getOrganizationAgentAdminAccess,
  getSessionAdminAccessView,
  grantSessionAdminAccess,
  nestedPostgresSqlState,
  resolveSessionAdminAuthority,
  revokeSessionAdminAccess,
  SessionAdminAccessNotAllowedError,
  SessionAdminAccessNotOwnSessionError,
  setOrganizationAgentAdminAccess,
  withWorkspaceSessionActivityRls,
  type DbClient,
} from "../src";
import { FORCE_RLS_TABLES, RUNTIME_FULL_DML_TABLES } from "../src/runtime-posture";

// Admin access for agent sessions: allowed per organization (off by default),
// given by an owner or admin to their own session, and checked live.
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("session-admin-access");
  if (!shared && requireRealDatabase) throw new Error("PostgreSQL test database unavailable");
  if (shared) client = createDb(shared.appUrl, { max: 4 });
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

async function organization(label: string) {
  const [account] = await shared!.admin<{ id: string }[]>`
    insert into managed_accounts (name) values (${label}) returning id`;
  const [workspace] = await shared!.admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${account!.id}, 'Shared') returning id`;
  await shared!.admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspace!.id}, ${account!.id})`;
  const people = {
    owner: `user:${crypto.randomUUID()}`,
    admin: `user:${crypto.randomUUID()}`,
    member: `user:${crypto.randomUUID()}`,
  };
  for (const [role, subjectId] of Object.entries(people)) {
    const [personal] = await shared!.admin<{ id: string }[]>`
      insert into workspaces (account_id, name) values (${account!.id}, 'Personal') returning id`;
    await shared!.admin`
      insert into organization_memberships
        (account_id, subject_id, role, status, personal_workspace_id)
      values (${account!.id}, ${subjectId}, ${role}, 'active', ${personal!.id})`;
  }
  return { accountId: account!.id, workspaceId: workspace!.id, ...people };
}

async function session(
  org: { accountId: string; workspaceId: string },
  createdBy: { kind: "subject" | "service"; subjectId: string },
): Promise<string> {
  const id = crypto.randomUUID();
  await withWorkspaceSessionActivityRls(client!.db, org.workspaceId, async (scoped) => {
    await scoped.execute(sql`
      insert into sessions (id, account_id, workspace_id, initial_message, model, reasoning_effort,
        latency_mode, sandbox_backend, sandbox_group_id, tool_policy, root_session_id, status,
        created_by_kind, created_by_subject_id)
      values (${id}, ${org.accountId}, ${org.workspaceId}, 'admin access fixture', 'test-model',
        'medium', 'standard', 'none', ${id},
        jsonb_build_object('mode', 'explicit', 'inheritedFromSessionId', null), ${id}, 'idle',
        ${createdBy.kind}, ${createdBy.subjectId})`);
  });
  return id;
}

async function sqlState(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    return nestedPostgresSqlState(error) ?? (error as Error).name;
  }
}

describe("session admin access", () => {
  test("ships as rolling FORCE RLS tables the runtime may change", async () => {
    const migration = await readFile(
      new URL("../drizzle/0692_session_admin_access.sql", import.meta.url),
      "utf8",
    );
    expect(migration.split("\n")[0]).toBe("-- deployment-mode: rolling");
    for (const table of ["organization_agent_admin_access", "session_admin_access"] as const) {
      expect(FORCE_RLS_TABLES).toContain(table);
      expect(RUNTIME_FULL_DML_TABLES).toContain(table);
    }
  });

  test("is off until an owner or admin allows it", async () => {
    if (!client) return;
    const db = client.db;
    const org = await organization("admin-access-off");
    const own = await session(org, { kind: "subject", subjectId: org.owner });
    expect(
      (await getOrganizationAgentAdminAccess(db, org.accountId)).sessionAdminAccessAllowed,
    ).toBe(false);
    await expect(
      grantSessionAdminAccess(db, {
        organizationId: org.accountId,
        workspaceId: org.workspaceId,
        sessionId: own,
        actorSubjectId: org.owner,
      }),
    ).rejects.toBeInstanceOf(SessionAdminAccessNotAllowedError);
    expect(
      await sqlState(
        setOrganizationAgentAdminAccess(db, {
          organizationId: org.accountId,
          actorSubjectId: org.member,
          sessionAdminAccessAllowed: true,
        }),
      ),
    ).toBe("42501");
    expect(
      await resolveSessionAdminAuthority(db, {
        accountId: org.accountId,
        workspaceId: org.workspaceId,
        sessionId: own,
      }),
    ).toBeNull();
  });

  test("an owner or admin gives only their own session, and it acts as them", async () => {
    if (!client) return;
    const db = client.db;
    const org = await organization("admin-access-grant");
    await setOrganizationAgentAdminAccess(db, {
      organizationId: org.accountId,
      actorSubjectId: org.admin,
      sessionAdminAccessAllowed: true,
    });
    const ownersSession = await session(org, { kind: "subject", subjectId: org.owner });
    const membersSession = await session(org, { kind: "subject", subjectId: org.member });
    const spawned = await session(org, { kind: "service", subjectId: org.owner });
    const target = { organizationId: org.accountId, workspaceId: org.workspaceId };

    // Someone else's session, or one an agent started, never takes an admin's access.
    await expect(
      grantSessionAdminAccess(db, {
        ...target,
        sessionId: membersSession,
        actorSubjectId: org.owner,
      }),
    ).rejects.toBeInstanceOf(SessionAdminAccessNotOwnSessionError);
    await expect(
      grantSessionAdminAccess(db, { ...target, sessionId: spawned, actorSubjectId: org.owner }),
    ).rejects.toBeInstanceOf(SessionAdminAccessNotOwnSessionError);
    // A member can't give admin access even to their own session.
    expect(
      await sqlState(
        grantSessionAdminAccess(db, {
          ...target,
          sessionId: membersSession,
          actorSubjectId: org.member,
        }),
      ),
    ).toBe("42501");

    const granted = await grantSessionAdminAccess(db, {
      ...target,
      sessionId: ownersSession,
      actorSubjectId: org.owner,
    });
    expect(granted.grantedBySubjectId).toBe(org.owner);
    // Giving it again keeps the original grant.
    expect(
      await grantSessionAdminAccess(db, {
        ...target,
        sessionId: ownersSession,
        actorSubjectId: org.owner,
      }),
    ).toEqual(granted);
    const key = { accountId: org.accountId, workspaceId: org.workspaceId };
    expect(await resolveSessionAdminAuthority(db, { ...key, sessionId: ownersSession })).toEqual({
      subjectId: org.owner,
      grantedAt: granted.grantedAt,
    });
    expect(
      await resolveSessionAdminAuthority(db, { ...key, sessionId: membersSession }),
    ).toBeNull();

    const ownerView = await getSessionAdminAccessView(db, {
      ...key,
      sessionId: ownersSession,
      viewerSubjectId: org.owner,
    });
    expect(ownerView).toMatchObject({
      allowed: true,
      active: true,
      viewerStartedSession: true,
      viewerIsAdministrator: true,
    });
    const memberView = await getSessionAdminAccessView(db, {
      ...key,
      sessionId: ownersSession,
      viewerSubjectId: org.member,
    });
    expect(memberView).toMatchObject({ viewerStartedSession: false, viewerIsAdministrator: false });

    // Another organization never sees or uses this grant.
    const other = await organization("admin-access-other");
    expect(
      await resolveSessionAdminAuthority(db, {
        accountId: other.accountId,
        workspaceId: org.workspaceId,
        sessionId: ownersSession,
      }),
    ).toBeNull();

    expect(await revokeSessionAdminAccess(db, { ...key, sessionId: ownersSession })).toBe(true);
    expect(await resolveSessionAdminAuthority(db, { ...key, sessionId: ownersSession })).toBeNull();
    expect(await revokeSessionAdminAccess(db, { ...key, sessionId: ownersSession })).toBe(false);
  });

  test("ends when the person loses their role or the organization turns it off", async () => {
    if (!client) return;
    const db = client.db;
    const org = await organization("admin-access-live");
    const key = { accountId: org.accountId, workspaceId: org.workspaceId };
    await setOrganizationAgentAdminAccess(db, {
      organizationId: org.accountId,
      actorSubjectId: org.owner,
      sessionAdminAccessAllowed: true,
    });
    const adminsSession = await session(org, { kind: "subject", subjectId: org.admin });
    const ownersSession = await session(org, { kind: "subject", subjectId: org.owner });
    for (const [sessionId, actorSubjectId] of [
      [adminsSession, org.admin],
      [ownersSession, org.owner],
    ] as const) {
      await grantSessionAdminAccess(db, {
        organizationId: org.accountId,
        workspaceId: org.workspaceId,
        sessionId,
        actorSubjectId,
      });
    }
    expect(
      await resolveSessionAdminAuthority(db, { ...key, sessionId: adminsSession }),
    ).not.toBeNull();

    await shared!.admin`
      update organization_memberships set role = 'member'
      where account_id = ${org.accountId} and subject_id = ${org.admin}`;
    expect(await resolveSessionAdminAuthority(db, { ...key, sessionId: adminsSession })).toBeNull();
    expect(
      await resolveSessionAdminAuthority(db, { ...key, sessionId: ownersSession }),
    ).not.toBeNull();

    // Turning it off removes every grant; turning it on again restores none.
    await setOrganizationAgentAdminAccess(db, {
      organizationId: org.accountId,
      actorSubjectId: org.owner,
      sessionAdminAccessAllowed: false,
    });
    expect(await resolveSessionAdminAuthority(db, { ...key, sessionId: ownersSession })).toBeNull();
    await setOrganizationAgentAdminAccess(db, {
      organizationId: org.accountId,
      actorSubjectId: org.owner,
      sessionAdminAccessAllowed: true,
    });
    expect(await resolveSessionAdminAuthority(db, { ...key, sessionId: ownersSession })).toBeNull();
  });
});
