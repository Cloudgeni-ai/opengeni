// Migration 0302: a managed human's session in their OWN personal workspace
// must be owned by that human.
//
// 0225's `guard_session_authority_write` gated owner resolution on an
// `EXISTS (workspace_memberships ...)` row in the session's workspace. 0219
// deliberately provisions a personal workspace WITHOUT one (it raises 42501 on
// a pre-existing row), so the gate could never be satisfied there and every
// personal-workspace session was written with a NULL owner pair.
//
// Every fixture here goes through the REAL provisioning seam
// (`ensureManagedAccessForUserWithOrganizationMemberships`) rather than
// hand-inserting a `workspace_memberships` row into a fake "personal
// workspace" - a row real provisioning forbids, and the reason the defect was
// invisible to the 0225 suite.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  acquireOwnerMigratedTestDatabase,
  acquireSharedTestDatabase,
  type OwnerMigratedTestDatabase,
  type SharedTestDatabase,
} from "@opengeni/testing";
import {
  createDb,
  createSession,
  ensureManagedAccessForUserWithOrganizationMemberships,
  nestedPostgresSqlState,
  type DbClient,
} from "../src";
import { migrate } from "../src/migrate";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("migration-0302-personal-workspace-session-ownership");
  if (!shared && requireRealDatabase) {
    throw new Error(
      "[migration-0302-personal-workspace-session-ownership] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable",
    );
  }
  if (shared) client = createDb(shared.appUrl, { max: 8 });
}, 300_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

type ProvisionedHuman = {
  accountId: string;
  subjectId: string;
  membershipId: string;
  personalWorkspaceId: string;
  legacyWorkspaceId: string;
};

/** Provision a managed human exactly the way the Better Auth hook does. */
async function provisionManagedHuman(label: string): Promise<ProvisionedHuman> {
  if (!shared || !client) throw new Error("test database unavailable");
  const userId = `${label}-${crypto.randomUUID()}`;
  const subjectId = `user:${userId}`;
  const provisioned = await ensureManagedAccessForUserWithOrganizationMemberships(client.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Personal workspace human",
  });
  const grant = provisioned.accessContext.workspaceGrants[0]!;
  const membership = provisioned.organizationMemberships.find(
    (candidate) => candidate.organizationId === grant.accountId,
  );
  if (!membership?.personalWorkspaceId) {
    throw new Error("managed-human provisioning produced no personal workspace");
  }
  return {
    accountId: grant.accountId,
    subjectId,
    membershipId: membership.id,
    personalWorkspaceId: membership.personalWorkspaceId,
    legacyWorkspaceId: grant.workspaceId,
  };
}

/**
 * 0214's commit gate also raises 55000, so the SQLSTATE alone would not prove
 * which fence fired. Assert the exact message too.
 */
const UNRESOLVED_PERSONAL_OWNER = "session owner authority is unresolved in a personal workspace";

function failureMessage(error: unknown): string {
  let current = error;
  while (current instanceof Error) {
    const message = (current as { message?: unknown }).message;
    if (typeof message === "string" && message.includes(UNRESOLVED_PERSONAL_OWNER)) {
      return message;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return error instanceof Error ? error.message : String(error);
}

async function ownerOf(
  sessionId: string,
): Promise<{ membershipId: string | null; subjectId: string | null }> {
  if (!shared) throw new Error("test database unavailable");
  const [row] = await shared.admin<
    Array<{ membershipId: string | null; subjectId: string | null }>
  >`
    select
      owner_organization_membership_id as "membershipId",
      owner_subject_id as "subjectId"
    from sessions where id = ${sessionId}
  `;
  return row ?? { membershipId: null, subjectId: null };
}

async function createOrdinaryWorkspace(accountId: string, label: string): Promise<string> {
  if (!shared) throw new Error("test database unavailable");
  const workspaceId = crypto.randomUUID();
  await shared.admin`
    insert into workspaces (id, account_id, name, external_source, external_id)
    values (
      ${workspaceId}, ${accountId}, ${label},
      'migration-0302-test', ${`${label}-${workspaceId}`}
    )
  `;
  await shared.admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspaceId}, ${accountId})
  `;
  return workspaceId;
}

async function newSession(input: {
  accountId: string;
  workspaceId: string;
  createdBy: { kind: "subject" | "service"; subjectId: string };
  parentSessionId?: string;
}): Promise<{ id: string }> {
  if (!client) throw new Error("test database unavailable");
  return await createSession(client.db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
    initialMessage: "migration 0302 session",
    resources: [],
    metadata: {},
    model: "test-model",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "modal",
    createdBy: input.createdBy,
    createdByContext: {},
  });
}

describe("migration 0302 personal-workspace session ownership", () => {
  test("real provisioning leaves the personal workspace membershipless", async () => {
    if (!shared || !client) return;
    const human = await provisionManagedHuman("pw-shape");
    const rows = await shared.admin<Array<{ workspaceId: string }>>`
      select workspace_id as "workspaceId" from workspace_memberships
      where account_id = ${human.accountId}
    `;
    // Exactly one row, for the LEGACY Better Auth workspace. The personal
    // workspace has none - that is the whole reason 0225's EXISTS gate failed.
    expect(rows.map((row) => row.workspaceId)).toEqual([human.legacyWorkspaceId]);
    expect(human.personalWorkspaceId).not.toBe(human.legacyWorkspaceId);
  });

  test("owns a session created in the human's own personal workspace", async () => {
    if (!shared || !client) return;
    const human = await provisionManagedHuman("pw-owned");
    const session = await newSession({
      accountId: human.accountId,
      workspaceId: human.personalWorkspaceId,
      createdBy: { kind: "subject", subjectId: human.subjectId },
    });
    expect(await ownerOf(session.id)).toEqual({
      membershipId: human.membershipId,
      subjectId: human.subjectId,
    });
  });

  test("still owns a session in an ordinary workspace the human is a member of", async () => {
    if (!shared || !client) return;
    const human = await provisionManagedHuman("pw-ordinary");
    const session = await newSession({
      accountId: human.accountId,
      workspaceId: human.legacyWorkspaceId,
      createdBy: { kind: "subject", subjectId: human.subjectId },
    });
    expect(await ownerOf(session.id)).toEqual({
      membershipId: human.membershipId,
      subjectId: human.subjectId,
    });
  });

  test("does NOT own a session in an ordinary workspace the human cannot access", async () => {
    if (!shared || !client) return;
    const human = await provisionManagedHuman("pw-noaccess");
    const strangerWorkspaceId = await createOrdinaryWorkspace(
      human.accountId,
      "ordinary-no-access",
    );
    const session = await newSession({
      accountId: human.accountId,
      workspaceId: strangerWorkspaceId,
      createdBy: { kind: "subject", subjectId: human.subjectId },
    });
    // The membership pointer names ONE workspace. Widening it to every
    // same-organization workspace would be exactly the phase-D inference the
    // repair must not make.
    expect(await ownerOf(session.id)).toEqual({ membershipId: null, subjectId: null });
  });

  test("preserves genuinely ownerless service and non-user-subject sessions", async () => {
    if (!shared || !client) return;
    const human = await provisionManagedHuman("pw-ownerless");
    const serviceSession = await newSession({
      accountId: human.accountId,
      workspaceId: human.personalWorkspaceId,
      createdBy: { kind: "service", subjectId: "service:scheduler" },
    });
    expect(await ownerOf(serviceSession.id)).toEqual({ membershipId: null, subjectId: null });

    const apiKeyWorkspaceId = await createOrdinaryWorkspace(human.accountId, "api-key-workspace");
    const apiKeySubjectId = `api_key:${crypto.randomUUID()}`;
    await shared.admin`
      insert into workspace_memberships (
        account_id, workspace_id, subject_id, role, permissions
      ) values (
        ${human.accountId}, ${apiKeyWorkspaceId}, ${apiKeySubjectId},
        'member', '["sessions:read","sessions:create"]'::jsonb
      )
    `;
    const apiKeySession = await newSession({
      accountId: human.accountId,
      workspaceId: apiKeyWorkspaceId,
      createdBy: { kind: "subject", subjectId: apiKeySubjectId },
    });
    // 0219/0263 gate organization anchors to `user:%`, so an API-key subject can
    // never acquire one. It stays permanently, correctly ownerless.
    expect(await ownerOf(apiKeySession.id)).toEqual({ membershipId: null, subjectId: null });
  });

  test("leaves a suspended member's personal-workspace session ownerless without raising", async () => {
    if (!shared || !client) return;
    const human = await provisionManagedHuman("pw-suspended");
    await shared.admin`
      update organization_memberships set status = 'suspended', revoked_at = null
      where account_id = ${human.accountId} and subject_id = ${human.subjectId}
    `;
    const session = await newSession({
      accountId: human.accountId,
      workspaceId: human.personalWorkspaceId,
      createdBy: { kind: "subject", subjectId: human.subjectId },
    });
    expect(await ownerOf(session.id)).toEqual({ membershipId: null, subjectId: null });
  });

  test("does not raise when the personal workspace's own member is no longer active", async () => {
    if (!shared || !client) return;
    // The classifier's short-circuit on `creator_has_active_membership` covers
    // the case where the SUSPENDED human is the creator (above). It can never
    // reach the `personal_owner.status = 'active'` predicate, because that
    // creator has no active membership at all. Reaching it needs TWO distinct
    // memberships: an ACTIVE creator, and a NON-ACTIVE member whose
    // `personal_workspace_id` names the target workspace.
    //
    // That state is what 0263's real `suspend` action produces: it sets
    // `status = 'suspended'` and deliberately RETAINS `personal_workspace_id`
    // (only the offboard retention purge nulls the pointer), and 0218's
    // `organization_memberships_active_personal_workspace_check` is one-way -
    // it requires the pointer while ACTIVE and says nothing afterwards, so a
    // non-active membership legitimately keeps naming its personal workspace.
    const suspendedOwner = await provisionManagedHuman("pw-suspended-owner");
    await shared.admin`
      update organization_memberships set status = 'suspended', revoked_at = null
      where account_id = ${suspendedOwner.accountId}
        and subject_id = ${suspendedOwner.subjectId}
    `;
    // The pointer survives suspension - otherwise this fixture would not even
    // describe the state the predicate guards.
    const [pointer] = await shared.admin<Array<{ personalWorkspaceId: string | null }>>`
      select personal_workspace_id as "personalWorkspaceId"
      from organization_memberships
      where account_id = ${suspendedOwner.accountId}
        and subject_id = ${suspendedOwner.subjectId}
    `;
    expect(pointer?.personalWorkspaceId).toBe(suspendedOwner.personalWorkspaceId);

    const activeSubjectId = `user:pw-suspended-other-${crypto.randomUUID()}`;
    const activePersonalWorkspaceId = await createOrdinaryWorkspace(
      suspendedOwner.accountId,
      "suspended-owner-peer-personal",
    );
    await shared.admin`
      insert into organization_memberships (
        account_id, subject_id, status, personal_workspace_id
      ) values (
        ${suspendedOwner.accountId}, ${activeSubjectId}, 'active',
        ${activePersonalWorkspaceId}
      )
    `;

    // Same insert shape as the loud case below, differing ONLY in the personal
    // workspace member's status. 0302's header states the rule: a suspended or
    // revoked member "is excluded from both the resolver and the classifier by
    // the same `status = 'active'` predicate, so their personal-workspace
    // sessions stay ownerless without raising, exactly as before". Drop that
    // predicate from the classifier and this insert raises 55000 instead.
    const session = await newSession({
      accountId: suspendedOwner.accountId,
      workspaceId: suspendedOwner.personalWorkspaceId,
      createdBy: { kind: "subject", subjectId: activeSubjectId },
    });
    expect(await ownerOf(session.id)).toEqual({ membershipId: null, subjectId: null });
  });

  test("raises 55000 instead of silently writing NULL for an unresolved personal workspace", async () => {
    if (!shared || !client) return;
    const owner = await provisionManagedHuman("pw-loud-owner");
    // A second active member of the SAME organization, sharing the legacy
    // workspace so the intruder is a real member of the organization.
    const intruderSubjectId = `user:pw-loud-intruder-${crypto.randomUUID()}`;
    const intruderPersonalWorkspaceId = await createOrdinaryWorkspace(
      owner.accountId,
      "intruder-personal",
    );
    await shared.admin`
      insert into organization_memberships (
        account_id, subject_id, status, personal_workspace_id
      ) values (
        ${owner.accountId}, ${intruderSubjectId}, 'active', ${intruderPersonalWorkspaceId}
      )
    `;
    // The intruder tries to create a session inside the OWNER's personal
    // workspace. 0219's access model makes this unreachable in production; if it
    // ever happens the fence must be loud rather than mint an ownerless row.
    let failure: unknown;
    try {
      await newSession({
        accountId: owner.accountId,
        workspaceId: owner.personalWorkspaceId,
        createdBy: { kind: "subject", subjectId: intruderSubjectId },
      });
    } catch (error) {
      failure = error;
    }
    expect(nestedPostgresSqlState(failure)).toBe("55000");
    expect(failureMessage(failure)).toContain(UNRESOLVED_PERSONAL_OWNER);
    const [remaining] = await shared.admin<Array<{ count: number }>>`
      select count(*)::int as count from sessions
      where workspace_id = ${owner.personalWorkspaceId}
        and created_by_subject_id = ${intruderSubjectId}
    `;
    expect(remaining?.count).toBe(0);
  });

  test("a child session still inherits its parent's owner pair verbatim", async () => {
    if (!shared || !client) return;
    const human = await provisionManagedHuman("pw-child");
    const parent = await newSession({
      accountId: human.accountId,
      workspaceId: human.personalWorkspaceId,
      createdBy: { kind: "subject", subjectId: human.subjectId },
    });
    // The parent branch wins over creator resolution, so a service-created
    // child of an owned parent inherits the human's pair verbatim.
    const child = await newSession({
      accountId: human.accountId,
      workspaceId: human.personalWorkspaceId,
      parentSessionId: parent.id,
      createdBy: { kind: "service", subjectId: "service:agent" },
    });
    expect(await ownerOf(child.id)).toEqual({
      membershipId: human.membershipId,
      subjectId: human.subjectId,
    });
  });
});

// The trigger is SECURITY DEFINER and reads FORCE-RLS `organization_memberships`
// behind a transaction-local lifecycle marker. The shared harness migrates as
// the container SUPERUSER, for whom FORCE RLS never engages, so the definer's
// real read boundary is invisible there. This block reproduces OpenGeni's
// documented deployment posture: a NOSUPERUSER NOBYPASSRLS migration owner.
describe("migration 0302 under a NOSUPERUSER NOBYPASSRLS migration owner", () => {
  let owned: OwnerMigratedTestDatabase | null = null;

  beforeAll(async () => {
    owned = await acquireOwnerMigratedTestDatabase("migration-0302-owner-migrated");
    if (!owned && requireRealDatabase) {
      throw new Error("[migration-0302] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable");
    }
  }, 900_000);

  afterAll(async () => {
    await owned?.release();
  }, 180_000);

  test("resolves the personal-workspace owner when the definer cannot bypass RLS", async () => {
    if (!owned) return;
    const { admin, ownerUrl, ownerRole } = owned;
    const [identity] = await admin<Array<{ superuser: boolean; bypassRls: boolean }>>`
      select rolsuper as "superuser", rolbypassrls as "bypassRls"
      from pg_roles where rolname = ${ownerRole}
    `;
    expect(identity).toEqual({ superuser: false, bypassRls: false });
    // Guard against a silently truncated chain: 0302 must actually be present.
    const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql"));
    expect(files.some((file) => file.endsWith("_personal_workspace_session_ownership.sql"))).toBe(
      true,
    );

    await migrate(ownerUrl);

    const accountId = crypto.randomUUID();
    const personalWorkspaceId = crypto.randomUUID();
    const subjectId = `user:owner-migrated-${crypto.randomUUID()}`;
    await admin`
      insert into managed_accounts (id, name, external_source, external_id)
      values (${accountId}, 'owner-migrated', 'better-auth:user', ${accountId})
    `;
    await admin`
      insert into workspaces (id, account_id, name)
      values (${personalWorkspaceId}, ${accountId}, 'owner-migrated personal')
    `;
    await admin`
      insert into workspace_inference_controls (workspace_id, account_id)
      values (${personalWorkspaceId}, ${accountId})
    `;
    const [membership] = await admin<Array<{ id: string }>>`
      insert into organization_memberships (
        account_id, subject_id, status, personal_workspace_id
      ) values (${accountId}, ${subjectId}, 'active', ${personalWorkspaceId})
      returning id
    `;

    // The INSERT itself runs as the superuser, but the trigger body executes as
    // the NOSUPERUSER definer, so its organization_memberships read is the one
    // that must pass FORCE RLS through the lifecycle marker.
    const sessionId = crypto.randomUUID();
    const insertSession = async (id: string, creatorSubjectId: string): Promise<void> => {
      await admin.begin(async (sql) => {
        // The sibling SECURITY DEFINER helpers on this path (depth policy,
        // activity gate) are ALSO owned by the NOSUPERUSER role, so they need
        // the ordinary tenant context a real writer establishes.
        await sql`select set_config('opengeni.account_id', ${accountId}, true)`;
        await sql`select set_config('opengeni.workspace_id', ${personalWorkspaceId}, true)`;
        await sql`select set_config('opengeni.subject_id', ${creatorSubjectId}, true)`;
        await sql`select set_config('opengeni.session_variable_set_attachments_v1', '1', true)`;
        await sql`select set_config('opengeni.session_activity_gate_state', 'open', true)`;
        await sql`
          select set_config(
            'opengeni.session_activity_gate_workspace_id', ${personalWorkspaceId}, true
          )
        `;
        await sql`
          insert into sessions (
            id, account_id, workspace_id, sandbox_group_id, status,
            created_by_kind, created_by_subject_id, initial_message, model,
            sandbox_backend, resources, tools, metadata, tool_policy,
            reasoning_effort, latency_mode
          ) values (
            ${id}, ${accountId}, ${personalWorkspaceId}, ${id}, 'queued',
            'subject', ${creatorSubjectId}, 'owner-migrated session',
            'test-model', 'modal', '[]'::jsonb, '[]'::jsonb, '{}'::jsonb,
            '{"mode":"workspace_default","inheritedFromSessionId":null}'::jsonb,
            'medium', 'standard'
          )
        `;
        // 0214's commit gate rejects a transaction that reaches COMMIT with an
        // unfinalized session write. Replay the minimal finalization the
        // ordinary writer performs.
        await sql`
          select set_config('opengeni.session_activity_gate_state', 'preparing', true)
        `;
        await sql`set constraints all immediate`;
        await sql`
          set constraints sessions_activity_insert_commit_guard,
            sessions_activity_update_commit_guard deferred
        `;
        await sql`
          select set_config('opengeni.session_activity_gate_state', 'finalizing', true)
        `;
        await sql`
          with advanced as (
            update workspace_session_activity_revisions as counter
            set revision = counter.revision + 1
            where counter.workspace_id = ${personalWorkspaceId}
            returning counter.revision
          )
          update sessions as session
          set activity_revision = advanced.revision,
              activity_revision_pending_xid = null
          from advanced
          where session.workspace_id = ${personalWorkspaceId}
            and session.activity_revision_pending_xid
              = pg_current_xact_id()::text::bigint
        `;
        await sql`
          select set_config('opengeni.session_activity_gate_state', 'finalized', true)
        `;
      });
    };
    await insertSession(sessionId, subjectId);
    const [row] = await admin<Array<{ membershipId: string | null; subjectId: string | null }>>`
      select
        owner_organization_membership_id as "membershipId",
        owner_subject_id as "subjectId"
      from sessions where id = ${sessionId}
    `;
    expect(row).toEqual({ membershipId: membership!.id, subjectId });

    // And the fence stays loud there too: another active member of the same
    // organization cannot mint an ownerless session in that personal workspace.
    const intruderSubjectId = `user:owner-migrated-intruder-${crypto.randomUUID()}`;
    const intruderWorkspaceId = crypto.randomUUID();
    await admin`
      insert into workspaces (id, account_id, name)
      values (${intruderWorkspaceId}, ${accountId}, 'owner-migrated intruder personal')
    `;
    await admin`
      insert into workspace_inference_controls (workspace_id, account_id)
      values (${intruderWorkspaceId}, ${accountId})
    `;
    await admin`
      insert into organization_memberships (
        account_id, subject_id, status, personal_workspace_id
      ) values (${accountId}, ${intruderSubjectId}, 'active', ${intruderWorkspaceId})
    `;
    let failure: unknown;
    try {
      await insertSession(crypto.randomUUID(), intruderSubjectId);
    } catch (error) {
      failure = error;
    }
    expect(nestedPostgresSqlState(failure)).toBe("55000");
    expect(failureMessage(failure)).toContain(UNRESOLVED_PERSONAL_OWNER);
  }, 900_000);
});
