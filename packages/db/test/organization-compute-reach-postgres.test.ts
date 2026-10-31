import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  acquireRestrictedRuntimeTestDatabase,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing/shared-pg";
import postgres from "postgres";
import {
  claimSessionWorkForAttempt,
  createDb,
  createRig,
  createSession,
  createWorkspace,
  ensureManagedAccessForUser,
  getRig,
  getSandbox,
  initializeSessionStartAtomically,
  listEnrollments,
  listRigs,
  materializeRigVersionForAttempt,
  nestedPostgresSqlState,
  updateOrganizationMachineReach,
  updateOrganizationRigReach,
  type DbClient,
} from "../src/index";

// An organization's machines and rigs work in the workspaces it picks: every
// shared workspace or chosen ones, members' Personal workspaces when switched
// on, and always the workspace they were connected from or made in. These
// tests run the real migrated schema with a non-BYPASSRLS owner and runtime.
let shared: RestrictedRuntimeTestDatabase;
let client: DbClient;
let app: postgres.Sql;

beforeAll(async () => {
  const acquired = await acquireRestrictedRuntimeTestDatabase("organization-compute-reach");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 4, searchPath: shared.schema });
  app = postgres(shared.appUrl, {
    max: 2,
    prepare: false,
    connection: { search_path: shared.schema },
    onnotice: () => undefined,
  });
}, 900_000);

afterAll(async () => {
  await app?.end({ timeout: 1 }).catch(() => undefined);
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

const MEMBER_PERMISSIONS = JSON.stringify([
  "sessions:read",
  "sessions:create",
  "sessions:control",
  "rigs:use",
  "enrollments:read",
]);

/** An organization with its owner's first shared workspace (home), two more
 * shared workspaces and the owner's Personal workspace. */
async function organization() {
  const ownerUserId = `reach-owner-${crypto.randomUUID()}`;
  const owner = `user:${ownerUserId}`;
  const managed = await ensureManagedAccessForUser(client.db, {
    userId: ownerUserId,
    email: `${ownerUserId}@example.test`,
    name: "Organization owner",
  });
  const grant = managed.workspaceGrants.find(
    (candidate) => candidate.workspaceId === managed.defaultWorkspaceId,
  );
  if (!grant) throw new Error("owner has no shared workspace grant");
  const { accountId } = grant;
  const home = grant.workspaceId;
  const second = (await createWorkspace(client.db, { accountId, name: "Second" })).id;
  const third = (await createWorkspace(client.db, { accountId, name: "Third" })).id;
  for (const workspaceId of [second, third]) {
    await shared.admin`
      insert into workspace_memberships (account_id, workspace_id, subject_id, role, permissions)
      values (${accountId}, ${workspaceId}, ${owner}, 'owner', ${MEMBER_PERMISSIONS}::jsonb)`;
  }
  const [membership] = await shared.admin<Array<{ personal: string | null }>>`
    select personal_workspace_id::text as personal from organization_memberships
    where account_id = ${accountId} and subject_id = ${owner}`;
  if (!membership?.personal) throw new Error("owner has no Personal workspace");
  return { accountId, owner, home, second, third, personal: membership.personal };
}

type Org = Awaited<ReturnType<typeof organization>>;

function access(org: Org, workspaceId: string) {
  return { accountId: org.accountId, workspaceId, subjectId: org.owner };
}

async function visibleRigIds(org: Org, workspaceId: string): Promise<string[]> {
  return (await listRigs(client.db, access(org, workspaceId))).map((rig) => rig.id);
}

async function visibleMachineIds(org: Org, workspaceId: string): Promise<string[]> {
  return (await listEnrollments(client.db, access(org, workspaceId))).map(
    (enrollment) => enrollment.id,
  );
}

async function attachAllowed(org: Org, workspaceId: string, sandboxId: string) {
  return (await app.begin(async (tx) => {
    await tx`select
      set_config('opengeni.account_id', ${org.accountId}, true),
      set_config('opengeni.workspace_id', ${workspaceId}, true),
      set_config('opengeni.subject_id', ${org.owner}, true)`;
    const [row] = await tx<Array<{ allowed: boolean }>>`
      select authorize_scoped_sandbox_attach(
        ${org.accountId}::uuid, ${workspaceId}::uuid, ${sandboxId}::uuid
      ) as allowed`;
    return row!.allowed;
  })) as boolean;
}

async function organizationMachine(org: Org) {
  return (await app.begin(async (tx) => {
    await tx`select
      set_config('opengeni.account_id', ${org.accountId}, true),
      set_config('opengeni.workspace_id', ${org.home}, true),
      set_config('opengeni.subject_id', ${org.owner}, true)`;
    const [row] = await tx<Array<{ enrollmentId: string; sandboxId: string }>>`
      select enrollment_id as "enrollmentId", sandbox_id as "sandboxId"
      from finalize_scoped_enrollment(
        ${org.accountId}::uuid, ${org.home}::uuid, 'organization',
        ${`ed25519:reach-${crypto.randomUUID()}`}, false, false, 'linux', 'x86_64',
        'Shared build box', true
      )`;
    return row!;
  })) as { enrollmentId: string; sandboxId: string };
}

function reachInput(
  org: Org,
  allowedWorkspaceIds: string[] | null,
  allowPersonalWorkspaces: boolean,
) {
  return {
    accountId: org.accountId,
    homeWorkspaceId: org.home,
    allowedWorkspaceIds,
    allowPersonalWorkspaces,
    subjectId: org.owner,
  };
}

/** A claimed turn of a chat in `workspaceId` that runs on the rig. */
async function chatOnRig(org: Org, workspaceId: string, rigId: string, rigVersionId: string) {
  const session = await createSession(client.db, {
    accountId: org.accountId,
    workspaceId,
    initialMessage: "Build on the shared rig",
    resources: [],
    metadata: {},
    createdBy: { kind: "subject", subjectId: org.owner },
    subjectId: org.owner,
    model: "test-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    rigId,
    rigVersionId,
  } as never);
  await initializeSessionStartAtomically(client.db, {
    accountId: org.accountId,
    workspaceId,
    sessionId: session.id,
    reasoningEffortFallback: "medium",
    createdEventPayload: {},
  } as never);
  const attemptId = crypto.randomUUID();
  const claimed = await claimSessionWorkForAttempt(client.db, workspaceId, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") throw new Error(`turn was not claimed: ${claimed.reason}`);
  return {
    accountId: org.accountId,
    workspaceId,
    subjectId: org.owner,
    sessionId: session.id,
    turnId: claimed.turn.id,
    attemptId,
    executionGeneration: claimed.turn.executionGeneration,
  };
}

describe("where an organization rig works", () => {
  test("everywhere by default, then only where the organization picks", async () => {
    const org = await organization();
    const rig = await createRig(client.db, {
      accountId: org.accountId,
      workspaceId: org.home,
      scope: "organization",
      subjectId: org.owner,
      allowOrganization: true,
      name: `shared-rig-${crypto.randomUUID().slice(0, 8)}`,
    });
    expect(rig.reach).toEqual({
      homeWorkspaceId: org.home,
      allowedWorkspaceIds: null,
      allowPersonalWorkspaces: true,
    });
    for (const workspaceId of [org.home, org.second, org.third, org.personal]) {
      expect(await visibleRigIds(org, workspaceId)).toContain(rig.id);
    }
    // A chat in the second workspace gets the rig: not only the workspace it
    // was made in, where its rows live.
    const attempt = await chatOnRig(org, org.second, rig.id, rig.activeVersion!.id);
    expect((await materializeRigVersionForAttempt(client.db, attempt))?.version.id).toBe(
      rig.activeVersion!.id,
    );

    const narrowed = await updateOrganizationRigReach(
      client.db,
      rig.id,
      reachInput(org, [org.third], false),
    );
    expect(narrowed).toEqual({
      status: "updated",
      reach: {
        homeWorkspaceId: org.home,
        allowedWorkspaceIds: [org.third],
        allowPersonalWorkspaces: false,
      },
    });
    expect(await visibleRigIds(org, org.home)).toContain(rig.id);
    expect(await visibleRigIds(org, org.third)).toContain(rig.id);
    expect(await visibleRigIds(org, org.second)).not.toContain(rig.id);
    expect(await visibleRigIds(org, org.personal)).not.toContain(rig.id);
    expect(await getRig(client.db, access(org, org.second), rig.id)).toBeNull();
    expect((await getRig(client.db, access(org, org.third), rig.id))?.reach).toEqual(
      narrowed.status === "updated" ? narrowed.reach : null,
    );
    // That chat's next attempt no longer gets the rig.
    const refused = await materializeRigVersionForAttempt(client.db, attempt).then(
      () => null,
      (error: unknown) => error,
    );
    expect(nestedPostgresSqlState(refused)).toBe("42501");
    expect(String((refused as { cause?: { message?: string } }).cause?.message)).toContain(
      "organization rig does not work in the runtime workspace",
    );

    const widened = await updateOrganizationRigReach(
      client.db,
      rig.id,
      reachInput(org, null, true),
    );
    expect(widened.status).toBe("updated");
    expect(await visibleRigIds(org, org.second)).toContain(rig.id);
    expect(await visibleRigIds(org, org.personal)).toContain(rig.id);
    const materialized = await materializeRigVersionForAttempt(client.db, attempt);
    expect(materialized?.version.id).toBe(rig.activeVersion!.id);

    const audit = await shared.admin<Array<{ metadata: Record<string, unknown> }>>`
      select metadata from audit_events
      where action = 'rig.reach.changed' and target_id = ${rig.id}
      order by occurred_at`;
    expect(audit.map((row) => row.metadata)).toEqual([
      {
        from: { allowedWorkspaceIds: null, allowPersonalWorkspaces: true },
        to: { allowedWorkspaceIds: [org.third], allowPersonalWorkspaces: false },
      },
      {
        from: { allowedWorkspaceIds: [org.third], allowPersonalWorkspaces: false },
        to: { allowedWorkspaceIds: null, allowPersonalWorkspaces: true },
      },
    ]);
  }, 120_000);

  test("a workspace rig has no organization reach to change", async () => {
    const org = await organization();
    const rig = await createRig(client.db, {
      accountId: org.accountId,
      workspaceId: org.home,
      scope: "workspace",
      subjectId: org.owner,
      name: `workspace-rig-${crypto.randomUUID().slice(0, 8)}`,
    });
    expect(rig.reach ?? null).toBeNull();
    expect(
      await updateOrganizationRigReach(client.db, rig.id, reachInput(org, [org.second], true)),
    ).toEqual({ status: "not_found" });
    expect(await visibleRigIds(org, org.second)).not.toContain(rig.id);
  }, 120_000);
});

describe("where an organization machine works", () => {
  test("narrowing hides it and refuses new attaches where it no longer works", async () => {
    const org = await organization();
    const machine = await organizationMachine(org);
    const [listed] = (await listEnrollments(client.db, access(org, org.second))).filter(
      (enrollment) => enrollment.id === machine.enrollmentId,
    );
    expect(listed?.reach).toEqual({
      homeWorkspaceId: org.home,
      allowedWorkspaceIds: null,
      allowPersonalWorkspaces: true,
    });
    expect(await attachAllowed(org, org.second, machine.sandboxId)).toBe(true);

    // Only its home workspace, plus members' Personal workspaces.
    expect(
      await updateOrganizationMachineReach(
        client.db,
        machine.enrollmentId,
        reachInput(org, [], true),
      ),
    ).toEqual({
      status: "updated",
      reach: { homeWorkspaceId: org.home, allowedWorkspaceIds: [], allowPersonalWorkspaces: true },
    });
    expect(await visibleMachineIds(org, org.home)).toContain(machine.enrollmentId);
    expect(await visibleMachineIds(org, org.personal)).toContain(machine.enrollmentId);
    expect(await visibleMachineIds(org, org.second)).not.toContain(machine.enrollmentId);
    expect(await visibleMachineIds(org, org.third)).not.toContain(machine.enrollmentId);
    expect(await getSandbox(client.db, access(org, org.second), machine.sandboxId)).toBeNull();
    expect(
      await getSandbox(client.db, access(org, org.personal), machine.sandboxId),
    ).not.toBeNull();
    expect(await attachAllowed(org, org.second, machine.sandboxId)).toBe(false);
    expect(await attachAllowed(org, org.home, machine.sandboxId)).toBe(true);
    expect(await attachAllowed(org, org.personal, machine.sandboxId)).toBe(true);

    // The Personal switch alone.
    await updateOrganizationMachineReach(
      client.db,
      machine.enrollmentId,
      reachInput(org, [org.second], false),
    );
    expect(await attachAllowed(org, org.second, machine.sandboxId)).toBe(true);
    expect(await attachAllowed(org, org.personal, machine.sandboxId)).toBe(false);
    expect(await visibleMachineIds(org, org.personal)).not.toContain(machine.enrollmentId);
  }, 120_000);

  test("only the organization's shared workspaces can be picked; its home always has it", async () => {
    const org = await organization();
    const machine = await organizationMachine(org);
    const stranger = crypto.randomUUID();
    expect(
      await updateOrganizationMachineReach(
        client.db,
        machine.enrollmentId,
        reachInput(org, [org.personal, stranger, org.second], true),
      ),
    ).toEqual({ status: "unknown_workspaces", workspaceIds: [org.personal, stranger] });
    // Nothing changed.
    expect(await visibleMachineIds(org, org.third)).toContain(machine.enrollmentId);

    // The home workspace and repeats are dropped from the stored list.
    const updated = await updateOrganizationMachineReach(
      client.db,
      machine.enrollmentId,
      reachInput(org, [org.home, org.second, org.second], true),
    );
    expect(updated).toEqual({
      status: "updated",
      reach: {
        homeWorkspaceId: org.home,
        allowedWorkspaceIds: [org.second],
        allowPersonalWorkspaces: true,
      },
    });
    expect(await visibleMachineIds(org, org.home)).toContain(machine.enrollmentId);
  }, 120_000);
});
