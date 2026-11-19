import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  acquireRestrictedRuntimeTestDatabase,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing/shared-pg";
import postgres from "postgres";
import {
  applyOrgAgent,
  claimSessionWorkForAttempt,
  createDb,
  createOrgAgent,
  createRig,
  createSession,
  createWorkspace,
  ensureManagedAccessForUser,
  getRig,
  getSandbox,
  initializeSessionStartAtomically,
  listEnrollments,
  listOrganizationCompute,
  listRigs,
  materializeRigVersionForAttempt,
  listOrgAgentCompute,
  nestedPostgresSqlState,
  OrgAgentError,
  resolveOrgAgentRunsOnInAccount,
  revokeScopedRig,
  saveOrgAgentDraft,
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

async function organizationMachine(
  org: Org,
  options: {
    scope?: "organization" | "workspace" | "user";
    workspaceId?: string;
    name?: string;
  } = {},
) {
  const workspaceId = options.workspaceId ?? org.home;
  return (await app.begin(async (tx) => {
    await tx`select
      set_config('opengeni.account_id', ${org.accountId}, true),
      set_config('opengeni.workspace_id', ${workspaceId}, true),
      set_config('opengeni.subject_id', ${org.owner}, true)`;
    const [row] = await tx<Array<{ enrollmentId: string; sandboxId: string }>>`
      select enrollment_id as "enrollmentId", sandbox_id as "sandboxId"
      from finalize_scoped_enrollment(
        ${org.accountId}::uuid, ${workspaceId}::uuid, ${options.scope ?? "organization"},
        ${`ed25519:reach-${crypto.randomUUID()}`}, false, false, 'linux', 'x86_64',
        ${options.name ?? "Shared build box"}, ${(options.scope ?? "organization") === "organization"}
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
      allowManagedWorkspaces: false,
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
        allowManagedWorkspaces: false,
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
        from: {
          allowedWorkspaceIds: null,
          allowPersonalWorkspaces: true,
          allowManagedWorkspaces: false,
        },
        to: {
          allowedWorkspaceIds: [org.third],
          allowPersonalWorkspaces: false,
          allowManagedWorkspaces: false,
        },
      },
      {
        from: {
          allowedWorkspaceIds: [org.third],
          allowPersonalWorkspaces: false,
          allowManagedWorkspaces: false,
        },
        to: {
          allowedWorkspaceIds: null,
          allowPersonalWorkspaces: true,
          allowManagedWorkspaces: false,
        },
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
      allowManagedWorkspaces: false,
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
      reach: {
        homeWorkspaceId: org.home,
        allowedWorkspaceIds: [],
        allowPersonalWorkspaces: true,
        allowManagedWorkspaces: false,
      },
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
        allowManagedWorkspaces: false,
      },
    });
    expect(await visibleMachineIds(org, org.home)).toContain(machine.enrollmentId);
  }, 120_000);
});

describe("every organization machine and rig, wherever it works", () => {
  test("listed from any workspace once granted, with where each works; never someone else's", async () => {
    const org = await organization();
    const machine = await organizationMachine(org);
    const name = (label: string) => `${label}-${crypto.randomUUID().slice(0, 8)}`;
    const rig = await createRig(client.db, {
      accountId: org.accountId,
      workspaceId: org.home,
      scope: "organization",
      subjectId: org.owner,
      allowOrganization: true,
      name: name("shared-rig"),
    });
    const removed = await createRig(client.db, {
      accountId: org.accountId,
      workspaceId: org.home,
      scope: "organization",
      subjectId: org.owner,
      allowOrganization: true,
      name: name("removed-rig"),
    });
    await revokeScopedRig(client.db, access(org, org.home), removed.id, {
      allowOrganization: true,
    });
    // The workspace's own and the owner's own are not the organization's.
    const workspaceRig = await createRig(client.db, {
      accountId: org.accountId,
      workspaceId: org.second,
      scope: "workspace",
      subjectId: org.owner,
      name: name("workspace-rig"),
    });
    // Neither works in the second workspace any more.
    await updateOrganizationMachineReach(
      client.db,
      machine.enrollmentId,
      reachInput(org, [], false),
    );
    await updateOrganizationRigReach(client.db, rig.id, reachInput(org, [org.third], false));
    expect(await visibleMachineIds(org, org.second)).not.toContain(machine.enrollmentId);
    expect(await visibleRigIds(org, org.second)).not.toContain(rig.id);

    expect(await listOrganizationCompute(client.db, access(org, org.second), "machine")).toEqual([
      {
        id: machine.enrollmentId,
        name: "Shared build box",
        sandboxId: machine.sandboxId,
        reach: {
          homeWorkspaceId: org.home,
          allowedWorkspaceIds: [],
          allowPersonalWorkspaces: false,
          allowManagedWorkspaces: false,
        },
      },
    ]);
    const rigs = await listOrganizationCompute(client.db, access(org, org.personal), "rig");
    expect(rigs).toEqual([
      {
        id: rig.id,
        name: rig.name,
        reach: {
          homeWorkspaceId: org.home,
          allowedWorkspaceIds: [org.third],
          allowPersonalWorkspaces: false,
          allowManagedWorkspaces: false,
        },
      },
    ]);
    expect(rigs!.map((entry) => entry.id)).not.toContain(workspaceRig.id);
    expect(rigs!.map((entry) => entry.id)).not.toContain(removed.id);

    // Another organization's owner lists only their own organization's.
    const other = await organization();
    expect(await listOrganizationCompute(client.db, access(other, other.home), "machine")).toEqual(
      [],
    );

    // An API caller in the organization's context, with no membership, gets
    // the same list, as it does the scoped lists (the routes require
    // account:admin).
    expect(
      (
        await listOrganizationCompute(
          client.db,
          { accountId: org.accountId, workspaceId: org.home, subjectId: "api_key:reach-test" },
          "rig",
        )
      )?.map((entry) => entry.id),
    ).toEqual([rig.id]);

    // A member who can't use the workspace is refused there.
    const outsider = `user:reach-outsider-${crypto.randomUUID()}`;
    await shared.admin`
      insert into organization_memberships (
        account_id, subject_id, status, personal_workspace_id, authorization_revision
      ) values (${org.accountId}, ${outsider}, 'active', ${org.third}, 1)`;
    const refused = await listOrganizationCompute(
      client.db,
      { accountId: org.accountId, workspaceId: org.second, subjectId: outsider },
      "rig",
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(nestedPostgresSqlState(refused)).toBe("42501");
  }, 120_000);
});

/** A workspace the organization's product manages, made now, that the owner can use. */
async function managedWorkspace(org: Org, name = "Customer") {
  const workspaceId = (await createWorkspace(client.db, { accountId: org.accountId, name })).id;
  await shared.admin`
    insert into workspace_memberships (account_id, workspace_id, subject_id, role, permissions)
    values (${org.accountId}, ${workspaceId}, ${org.owner}, 'owner', ${MEMBER_PERMISSIONS}::jsonb)`;
  await shared.admin`
    insert into organization_managed_workspaces (account_id, workspace_id, source)
    values (${org.accountId}, ${workspaceId}, 'api_key')`;
  return workspaceId;
}

describe("all product-managed workspaces", () => {
  test("covers managed workspaces made later, not other shared ones, until switched off", async () => {
    const org = await organization();
    const machine = await organizationMachine(org);
    const rig = await createRig(client.db, {
      accountId: org.accountId,
      workspaceId: org.home,
      scope: "organization",
      subjectId: org.owner,
      allowOrganization: true,
      name: `managed-rig-${crypto.randomUUID().slice(0, 8)}`,
    });
    const before = await managedWorkspace(org, "Customer before");
    const machineReach = await updateOrganizationMachineReach(client.db, machine.enrollmentId, {
      ...reachInput(org, [], false),
      allowManagedWorkspaces: true,
    });
    expect(machineReach).toEqual({
      status: "updated",
      reach: {
        homeWorkspaceId: org.home,
        allowedWorkspaceIds: [],
        allowPersonalWorkspaces: false,
        allowManagedWorkspaces: true,
      },
    });
    await updateOrganizationRigReach(client.db, rig.id, {
      ...reachInput(org, [], false),
      allowManagedWorkspaces: true,
    });
    // Made after the switch: covered without listing it.
    const later = await managedWorkspace(org, "Customer later");

    for (const workspaceId of [before, later]) {
      expect(await visibleMachineIds(org, workspaceId)).toContain(machine.enrollmentId);
      expect(await visibleRigIds(org, workspaceId)).toContain(rig.id);
      expect(
        await getSandbox(client.db, access(org, workspaceId), machine.sandboxId),
      ).not.toBeNull();
      expect(await attachAllowed(org, workspaceId, machine.sandboxId)).toBe(true);
    }
    const attempt = await chatOnRig(org, later, rig.id, rig.activeVersion!.id);
    expect((await materializeRigVersionForAttempt(client.db, attempt))?.version.id).toBe(
      rig.activeVersion!.id,
    );
    // A shared workspace the product does not manage, and Personal, stay out.
    for (const workspaceId of [org.second, org.personal]) {
      expect(await visibleMachineIds(org, workspaceId)).not.toContain(machine.enrollmentId);
      expect(await visibleRigIds(org, workspaceId)).not.toContain(rig.id);
      expect(await attachAllowed(org, workspaceId, machine.sandboxId)).toBe(false);
    }

    // Reported where reach is listed.
    expect(
      (await listOrganizationCompute(client.db, access(org, org.home), "machine"))?.find(
        (entry) => entry.id === machine.enrollmentId,
      )?.reach.allowManagedWorkspaces,
    ).toBe(true);
    expect(
      (await getRig(client.db, access(org, later), rig.id))?.reach?.allowManagedWorkspaces,
    ).toBe(true);

    // An update that leaves the switch out keeps it.
    await updateOrganizationMachineReach(
      client.db,
      machine.enrollmentId,
      reachInput(org, [org.third], false),
    );
    expect(await visibleMachineIds(org, later)).toContain(machine.enrollmentId);
    expect(await visibleMachineIds(org, org.third)).toContain(machine.enrollmentId);

    // Off: the managed workspaces lose it, from the next turn on.
    await updateOrganizationMachineReach(client.db, machine.enrollmentId, {
      ...reachInput(org, [], false),
      allowManagedWorkspaces: false,
    });
    await updateOrganizationRigReach(client.db, rig.id, {
      ...reachInput(org, [], false),
      allowManagedWorkspaces: false,
    });
    expect(await visibleMachineIds(org, later)).not.toContain(machine.enrollmentId);
    expect(await attachAllowed(org, later, machine.sandboxId)).toBe(false);
    const refused = await materializeRigVersionForAttempt(client.db, attempt).then(
      () => null,
      (error: unknown) => error,
    );
    expect(nestedPostgresSqlState(refused)).toBe("42501");

    const audit = await shared.admin<Array<{ metadata: Record<string, unknown> }>>`
      select metadata from audit_events
      where action = 'connected_machine.reach.changed' and target_id = ${machine.enrollmentId}
      order by occurred_at`;
    expect(audit.at(-1)?.metadata).toMatchObject({
      from: { allowManagedWorkspaces: true },
      to: { allowManagedWorkspaces: false },
    });
  }, 180_000);
});

describe("Runs on: organization machines and environments only", () => {
  test("the Console list says which work in managed workspaces; saves refuse others", async () => {
    const org = await organization();
    await managedWorkspace(org);
    const machine = await organizationMachine(org, { name: "Build box" });
    const narrow = await organizationMachine(org, { name: "Narrow box" });
    await updateOrganizationMachineReach(
      client.db,
      narrow.enrollmentId,
      reachInput(org, [], false),
    );
    const workspaceMachine = await organizationMachine(org, {
      scope: "workspace",
      workspaceId: org.second,
      name: "Team box",
    });
    const rig = await createRig(client.db, {
      accountId: org.accountId,
      workspaceId: org.home,
      scope: "organization",
      subjectId: org.owner,
      allowOrganization: true,
      name: "Python 3.13",
    });

    const listed = await listOrgAgentCompute(client.db, org.accountId);
    expect(listed.machines.map((entry) => entry.name).sort()).toEqual(["Build box", "Narrow box"]);
    expect(listed.machines.find((entry) => entry.id === machine.enrollmentId)).toMatchObject({
      sandboxId: machine.sandboxId,
      reach: { allowedWorkspaceIds: null },
    });
    expect(listed.machines.map((entry) => entry.id)).not.toContain(workspaceMachine.enrollmentId);
    expect(listed.environments.map((entry) => entry.id)).toEqual([rig.id]);

    const resolve = (runsOn: Parameters<typeof resolveOrgAgentRunsOnInAccount>[2]) =>
      resolveOrgAgentRunsOnInAccount(client.db, org.accountId, runsOn);
    // Names, ids and sandbox ids of organization machines and environments
    // resolve to the machine's enrollment id or the environment's id.
    for (const ref of ["build BOX", machine.enrollmentId, machine.sandboxId]) {
      expect(await resolve({ kind: "machine", machine: ref })).toEqual({
        target: { machineId: machine.enrollmentId },
      });
    }
    expect(await resolve({ kind: "sandbox", environment: "Python 3.13" })).toEqual({
      target: { environmentId: rig.id },
    });
    for (const runsOn of [{ kind: "sandbox" as const }, { kind: "none" as const }, undefined]) {
      expect(await resolve(runsOn)).toEqual({ target: null });
    }
    // A workspace machine (like a Personal one) is never an organization agent's.
    expect(
      await resolve({
        kind: "machine",
        machine: workspaceMachine.sandboxId,
      }),
    ).toMatchObject({ problem: { code: "machine_not_found" } });
    expect(await resolve({ kind: "sandbox", environment: "Nope" })).toMatchObject({
      problem: { code: "environment_not_found" },
    });
    // A Personal (Only me) machine: the create path sees its scope and refuses
    // it; saves never find it among the organization's.
    const personalMachine = await organizationMachine(org, { scope: "user", name: "My laptop" });
    expect(
      (await getSandbox(client.db, access(org, org.home), personalMachine.sandboxId))?.scope,
    ).toBe("user");
    expect(listed.machines.map((entry) => entry.id)).not.toContain(personalMachine.enrollmentId);
    for (const ref of ["My laptop", personalMachine.sandboxId, personalMachine.enrollmentId]) {
      expect(await resolve({ kind: "machine", machine: ref })).toMatchObject({
        problem: { code: "machine_not_found" },
      });
    }

    // Create, draft and deploy (also a dry run) refuse them.
    const actor = { subjectId: org.owner, label: "Owner" };
    const refusal = async (promise: Promise<unknown>) =>
      await promise.then(
        () => null,
        (error: unknown) => (error instanceof OrgAgentError ? [error.status, error.code] : error),
      );
    const onTeamBox = { kind: "machine" as const, machine: "Team box" };
    expect(
      await refusal(
        createOrgAgent(client.db, {
          accountId: org.accountId,
          actor,
          key: "on-team-box",
          definition: { name: "On team box", config: { runsOn: onTeamBox } },
        }),
      ),
    ).toEqual([422, "machine_not_found"]);
    const agent = await createOrgAgent(client.db, {
      accountId: org.accountId,
      actor,
      key: "on-build-box",
      definition: {
        name: "On build box",
        config: { runsOn: { kind: "machine", machine: "Build box" } },
      },
    });
    expect(agent.draft?.config.runsOn).toEqual({ kind: "machine", machine: "Build box" });
    // The version keeps the id the name resolved to (config keeps the name).
    const savedTarget = async (agentId: string) =>
      (
        await shared.admin<Array<{ target: unknown }>>`
          select runs_on_target as target from agent_revisions
          where agent_id = ${agentId} order by revision desc limit 1`
      )[0]?.target;
    expect(await savedTarget(agent.id)).toEqual({ machineId: machine.enrollmentId });
    const onRig = await createOrgAgent(client.db, {
      accountId: org.accountId,
      actor,
      key: "on-rig",
      definition: {
        name: "On rig",
        config: { runsOn: { kind: "sandbox", environment: "python 3.13" } },
      },
    });
    expect(await savedTarget(onRig.id)).toEqual({ environmentId: rig.id });
    const toolsOnly = await createOrgAgent(client.db, {
      accountId: org.accountId,
      actor,
      key: "tools-only",
      definition: { name: "Tools only", config: { runsOn: { kind: "none" } } },
    });
    expect(await savedTarget(toolsOnly.id)).toBeNull();
    expect(
      await refusal(
        saveOrgAgentDraft(client.db, {
          accountId: org.accountId,
          agentId: agent.id,
          actor,
          expectedVersion: agent.rowVersion,
          definition: { name: "On build box", config: { runsOn: onTeamBox } },
        }),
      ),
    ).toEqual([422, "machine_not_found"]);
    for (const dryRun of [true, false]) {
      expect(
        await refusal(
          applyOrgAgent(client.db, {
            accountId: org.accountId,
            key: "deployed",
            actor: { subjectId: "api_key:deploy", label: "Deploy key" },
            definition: {
              name: "Deployed",
              config: { runsOn: { kind: "sandbox", environment: "Nope" } },
            },
            publish: false,
            moveRunningChats: false,
            dryRun,
          }),
        ),
      ).toEqual([422, "environment_not_found"]);
    }
  }, 180_000);
});
