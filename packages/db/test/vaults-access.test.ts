// Vault access (0739): the reach matrix (AX-1), narrowing (AX-2), schedule
// owners rechecked per run (AX-3), "available in" (AX-4), Only-me privacy
// (AX-7), stale attempts (AX-8), integrity rules (DM-7) and limits (DM-8),
// all through the SECURITY DEFINER routines as the application role.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { SecretPrincipal } from "@opengeni/contracts";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import {
  claimSessionWorkForAttempt,
  createDb,
  createScheduledTask,
  createSession,
  createVault,
  createWorkspace,
  encryptEnvironmentValue,
  ensureDefaultVault,
  ensureManagedAccessForUser,
  ensureTaskVault,
  getVault,
  getVaultItem,
  initializeSessionStartAtomically,
  isVaultError,
  listVaultFieldVersions,
  listVaultItems,
  listVaultsForSubject,
  readVaultFieldCiphertext,
  resolveSecretReferenceCandidates,
  setSessionVaultPolicy,
  updateVault,
  upsertVaultItem,
  type DbClient,
  type VaultDbContext,
  type VaultRow,
} from "../src";

setDefaultTimeout(180_000);

const key = Buffer.alloc(32, 7);
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("vaults-access");
  if (!shared) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1")
      throw new Error("Real PostgreSQL is required");
    return;
  }
  client = createDb(shared.appUrl, { max: 4 });
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
});

/** Start a lazy postgres.js query so `expect(...).rejects` sees a real promise. */
async function executeLazy(query: () => PromiseLike<unknown>): Promise<unknown> {
  return await query();
}

async function expectVaultError(promise: Promise<unknown>, code: string) {
  try {
    await promise;
  } catch (error) {
    if (!isVaultError(error)) throw error;
    expect(error.code as string).toBe(code);
    return error;
  }
  throw new Error(`expected ${code}`);
}

type Person = { subjectId: string; membershipId: string };
type World = Awaited<ReturnType<typeof buildWorld>>;

async function buildWorld() {
  const db = client!.db;
  const admin = shared!.admin;
  const ownerUser = `vaults-owner-${crypto.randomUUID()}`;
  const access = await ensureManagedAccessForUser(db, {
    userId: ownerUser,
    email: `${ownerUser}@example.test`,
    name: "Vault owner",
  });
  const accountId = access.workspaceGrants[0]!.accountId;
  const owner = `user:${ownerUser}`;
  const sharedWorkspace = await createWorkspace(db, { accountId, name: "Vault access shared" });
  const workspaceId = sharedWorkspace.id;

  const addMembership = async (subjectId: string, role: "member" | "admin") => {
    const [personal] = await admin<{ id: string }[]>`
      insert into workspaces (account_id, name) values (${accountId}::uuid, 'Personal')
      returning id::text as id`;
    const [membership] = await admin<{ id: string }[]>`
      insert into organization_memberships (account_id, subject_id, status, role, personal_workspace_id)
      values (${accountId}::uuid, ${subjectId}, 'active', ${role}, ${personal!.id}::uuid)
      returning id::text as id`;
    return { id: membership!.id, personalWorkspaceId: personal!.id };
  };
  const person = async (
    label: string,
    role: "member" | "admin",
    permissions: string[] | null,
  ): Promise<Person & { personalWorkspaceId: string }> => {
    const subjectId = `user:vaults-${label}-${crypto.randomUUID()}`;
    const membership = await addMembership(subjectId, role);
    if (permissions) {
      await admin`
        insert into workspace_memberships (account_id, workspace_id, subject_id, role, permissions)
        values (${accountId}::uuid, ${workspaceId}::uuid, ${subjectId}, 'member',
          ${JSON.stringify(permissions)}::text::jsonb)`;
    }
    return {
      subjectId,
      membershipId: membership.id,
      personalWorkspaceId: membership.personalWorkspaceId,
    };
  };
  const member = await person("member", "member", [
    "sessions:create",
    "sessions:read",
    "secrets:use",
  ]);
  const legacy = await person("legacy", "member", ["sessions:create", "variable-sets:use"]);
  const viewer = await person("viewer", "member", ["sessions:read", "sessions:create"]);
  const orgAdmin = await person("admin", "admin", ["sessions:create", "sessions:read"]);
  const scheduleOwner = await person("scheduler", "member", [
    "sessions:create",
    "scheduled-tasks:write",
    "secrets:use",
  ]);
  // The member's personal workspace is the "personal workspace" of AX-4.
  const personalWorkspaceId = member.personalWorkspaceId;
  const [ownerMembership] = await admin<{ id: string }[]>`
    select id::text as id from organization_memberships
    where account_id = ${accountId}::uuid and subject_id = ${owner}`;

  const subject = (who: string, workspace = workspaceId): VaultDbContext => ({
    kind: "subject",
    accountId,
    workspaceId: workspace,
    subjectId: who,
  });

  const item = async (context: VaultDbContext, vault: VaultRow, name: string, value: string) =>
    await upsertVaultItem(db, context, {
      vaultId: vault.id,
      name,
      type: "api_key",
      fields: [
        {
          name: "value",
          kind: "concealed",
          valueEncrypted: encryptEnvironmentValue(key, value),
          valueSize: Buffer.byteLength(value),
        },
      ],
    });

  const vaults = {
    memberOnly: await createVault(db, subject(member.subjectId), {
      name: "Member only",
      ownerKind: "user",
    }),
    adminOnly: await createVault(db, subject(orgAdmin.subjectId), {
      name: "Admin only",
      ownerKind: "user",
    }),
    ownerOnly: await createVault(db, subject(scheduleOwner.subjectId), {
      name: "Scheduler only",
      ownerKind: "user",
    }),
    workspace: await createVault(db, subject(member.subjectId), {
      name: "Team",
      ownerKind: "workspace",
    }),
    orgAvailable: await createVault(db, subject(owner), {
      name: "Org everywhere",
      ownerKind: "organization",
      allowOrganization: true,
    }),
    orgElsewhere: await createVault(db, subject(owner), {
      name: "Org elsewhere",
      ownerKind: "organization",
      allowOrganization: true,
      availability: { allowedWorkspaceIds: [personalWorkspaceId], allowPersonalWorkspaces: true },
    }),
    orgNoPersonal: await createVault(db, subject(owner), {
      name: "Org no personal",
      ownerKind: "organization",
      allowOrganization: true,
      availability: { allowedWorkspaceIds: null, allowPersonalWorkspaces: false },
    }),
  };
  const items: Record<string, string> = {};
  const writers: Record<keyof typeof vaults, string> = {
    memberOnly: member.subjectId,
    adminOnly: orgAdmin.subjectId,
    ownerOnly: scheduleOwner.subjectId,
    workspace: member.subjectId,
    orgAvailable: owner,
    orgElsewhere: owner,
    orgNoPersonal: owner,
  };
  for (const [label, vault] of Object.entries(vaults) as Array<[keyof typeof vaults, VaultRow]>) {
    const context = subject(
      writers[label],
      label === "orgElsewhere" ? personalWorkspaceId : workspaceId,
    );
    const written = await item(context, vault, `KEY_${label}`, `value-${label}`);
    items[written.id] = label;
  }
  return {
    db,
    admin,
    accountId,
    workspaceId,
    personalWorkspaceId,
    owner: { subjectId: owner, membershipId: ownerMembership!.id },
    member,
    legacy,
    viewer,
    orgAdmin,
    scheduleOwner,
    subject,
    item,
    addMembership,
    vaults,
    items,
  };
}

type Turn = {
  sessionId: string;
  principal: Extract<SecretPrincipal, { kind: "attempt" }>;
};

async function startTurn(
  world: World,
  input: {
    createdBy: { kind: "subject" | "service"; subjectId: string };
    parentSessionId?: string;
    scheduledTaskId?: string;
  },
): Promise<Turn> {
  const { db, accountId, workspaceId } = world;
  const session = await createSession(db, {
    accountId,
    workspaceId,
    initialMessage: "vault access",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    createdBy: input.createdBy,
    ...(input.createdBy.kind === "subject" ? { subjectId: input.createdBy.subjectId } : {}),
    ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
  });
  const started = await initializeSessionStartAtomically(db, {
    accountId,
    workspaceId,
    sessionId: session.id,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
  });
  if (!started.turn) throw new Error("initial turn was not created");
  if (input.scheduledTaskId) {
    // Seed a run for the schedule and mark the turn as that run's (test-only
    // shortcut around the schedule dispatcher).
    await world.admin.begin(async (tx) => {
      await tx.unsafe("set local session_replication_role = replica");
      const [run] = await tx<{ id: string }[]>`
        insert into scheduled_task_runs (task_id, account_id, workspace_id, status, trigger_type, session_id)
        values (${input.scheduledTaskId!}::uuid, ${accountId}::uuid, ${workspaceId}::uuid, 'running', 'manual',
          ${session.id}::uuid)
        returning id::text as id`;
      await tx`update session_turns set scheduled_task_run_id = ${run!.id}::uuid
        where id = ${started.turn!.id}::uuid`;
    });
  }
  const attemptId = crypto.randomUUID();
  const claimed = await claimSessionWorkForAttempt(db, workspaceId, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    dispatchId: crypto.randomUUID(),
    attemptId,
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") throw new Error(`claim failed: ${claimed.reason}`);
  return {
    sessionId: session.id,
    principal: {
      kind: "attempt",
      accountId,
      workspaceId,
      sessionId: session.id,
      turnId: claimed.turn.id,
      attemptId,
      executionGeneration: claimed.turn.executionGeneration,
    },
  };
}

/** The labels of every seeded item a principal resolves by ID, plus "task" for task items. */
async function reach(
  world: World,
  principal: SecretPrincipal,
  taskItems: Record<string, string> = {},
) {
  const ids = [...Object.keys(world.items), ...Object.keys(taskItems)];
  const resolved = await resolveSecretReferenceCandidates(
    world.db,
    { kind: "principal", principal },
    {
      refs: ids.map((itemId, index) => ({
        index,
        form: "id",
        itemId,
        otp: false,
        previous: false,
      })),
    },
  );
  const labels = resolved.candidates.map(
    (candidate) => world.items[candidate.itemId] ?? taskItems[candidate.itemId] ?? candidate.itemId,
  );
  return { labels: [...new Set(labels)].sort(), meta: resolved.meta };
}

async function taskItem(world: World, turn: Turn, label: string) {
  const vault = await ensureTaskVault(
    world.db,
    { kind: "principal", principal: turn.principal },
    { workspaceId: world.workspaceId, sessionId: turn.sessionId },
  );
  const written = await world.item(
    { kind: "principal", principal: turn.principal },
    vault,
    `TASK_${label}`,
    label,
  );
  return { vault, itemId: written.id };
}

const SHARED = ["orgAvailable", "orgNoPersonal", "workspace"];

describe.skipIf(!process.env.OPENGENI_TEST_PG_URL && process.env.OPENGENI_REQUIRE_REAL_DB !== "1")(
  "vault access",
  () => {
    let world: World;
    beforeAll(async () => {
      if (!client) return;
      world = await buildWorld();
    });

    test("AX-1: each principal reaches exactly its row of the matrix", async () => {
      if (!client) return;
      const matrix: Array<[string, Turn, string[]]> = [];
      const memberTurn = await startTurn(world, {
        createdBy: { kind: "subject", subjectId: world.member.subjectId },
      });
      matrix.push(["member turn", memberTurn, ["memberOnly", ...SHARED]]);
      const adminTurn = await startTurn(world, {
        createdBy: { kind: "subject", subjectId: world.orgAdmin.subjectId },
      });
      matrix.push(["admin turn", adminTurn, ["adminOnly", ...SHARED]]);
      const legacyTurn = await startTurn(world, {
        createdBy: { kind: "subject", subjectId: world.legacy.subjectId },
      });
      matrix.push(["legacy-alias member turn", legacyTurn, SHARED]);
      const viewerTurn = await startTurn(world, {
        createdBy: { kind: "subject", subjectId: world.viewer.subjectId },
      });
      matrix.push(["viewer turn", viewerTurn, []]);
      const serviceTurn = await startTurn(world, {
        createdBy: { kind: "service", subjectId: "service:vault-access-test" },
      });
      matrix.push(["service turn", serviceTurn, SHARED]);
      const owned = await createScheduledTask(world.db, {
        accountId: world.accountId,
        workspaceId: world.workspaceId,
        name: `Owned ${crypto.randomUUID().slice(0, 6)}`,
        status: "active",
        schedule: { type: "manual" },
        temporalScheduleId: `vaults-owned-${crypto.randomUUID()}`,
        runMode: "new_session_per_run",
        overlapPolicy: "allow_concurrent",
        agentConfig: { prompt: "owned", resources: [], tools: [], metadata: {} },
        createdBy: { kind: "subject", subjectId: world.scheduleOwner.subjectId },
        metadata: {},
      });
      const ownedRun = await startTurn(world, {
        createdBy: { kind: "service", subjectId: "service:scheduler" },
        scheduledTaskId: owned.id,
      });
      matrix.push(["owned schedule run", ownedRun, ["ownerOnly", ...SHARED]]);
      const ownerless = await createScheduledTask(world.db, {
        accountId: world.accountId,
        workspaceId: world.workspaceId,
        name: `Ownerless ${crypto.randomUUID().slice(0, 6)}`,
        status: "active",
        schedule: { type: "manual" },
        temporalScheduleId: `vaults-ownerless-${crypto.randomUUID()}`,
        runMode: "new_session_per_run",
        overlapPolicy: "allow_concurrent",
        agentConfig: { prompt: "ownerless", resources: [], tools: [], metadata: {} },
        createdBy: { kind: "service", subjectId: "service:vault-access-test" },
        metadata: {},
      });
      const ownerlessRun = await startTurn(world, {
        createdBy: { kind: "service", subjectId: "service:scheduler" },
        scheduledTaskId: ownerless.id,
      });
      matrix.push(["ownerless schedule run", ownerlessRun, SHARED]);

      // Every turn has its own task vault; it sees only its own tree's.
      const taskItems: Record<string, string> = {};
      const taskOf = new Map<string, string>();
      for (const [label, turn] of matrix) {
        const written = await taskItem(world, turn, label);
        taskItems[written.itemId] = `task:${label}`;
        taskOf.set(label, `task:${label}`);
      }
      const results: Record<string, string[]> = {};
      for (const [label, turn, expected] of matrix) {
        const got = await reach(world, turn.principal, taskItems);
        results[label] = got.labels;
        expect({ label, labels: got.labels }).toEqual({
          label,
          labels: [...expected, taskOf.get(label)!].sort(),
        });
      }

      // Site viewers reach their own Only-me and shared vaults, never a task vault.
      const site = (subjectId: string): SecretPrincipal => ({
        kind: "site_viewer",
        accountId: world.accountId,
        workspaceId: world.workspaceId,
        subjectId,
        siteId: crypto.randomUUID(),
        siteVersion: "1",
      });
      expect((await reach(world, site(world.member.subjectId), taskItems)).labels).toEqual(
        ["memberOnly", ...SHARED].sort(),
      );
      expect((await reach(world, site(world.viewer.subjectId), taskItems)).labels).toEqual([]);

      // AX-7: listing as the admin never shows another person's Only-me vault.
      const adminList = await listVaultsForSubject(
        world.db,
        world.subject(world.orgAdmin.subjectId),
        {
          workspaceId: world.workspaceId,
        },
      );
      expect(adminList.map((vault) => vault.id)).not.toContain(world.vaults.memberOnly.id);
      expect(adminList.map((vault) => vault.id)).toContain(world.vaults.adminOnly.id);
      console.log(`[vaults-access] reach matrix ${JSON.stringify(results)}`);
    });

    test("AX-7: an admin cannot get, list items of or reveal another person's Only-me vault", async () => {
      if (!client) return;
      const asAdmin = world.subject(world.orgAdmin.subjectId);
      const memberItemId = Object.entries(world.items).find(
        ([, label]) => label === "memberOnly",
      )![0];
      await expectVaultError(
        getVault(world.db, asAdmin, { vaultId: world.vaults.memberOnly.id }),
        "vault_not_found",
      );
      await expectVaultError(
        listVaultItems(world.db, asAdmin, { vaultId: world.vaults.memberOnly.id }),
        "vault_not_found",
      );
      await expectVaultError(
        getVaultItem(world.db, asAdmin, { itemId: memberItemId }),
        "vault_item_not_found",
      );
      const asMember = world.subject(world.member.subjectId);
      const memberItem = await getVaultItem(world.db, asMember, { itemId: memberItemId });
      const fieldId = memberItem.fields[0]!.id;
      await expectVaultError(
        readVaultFieldCiphertext(world.db, asAdmin, { fieldId, purpose: "reveal" }),
        "vault_item_not_found",
      ).catch(async () =>
        expectVaultError(
          readVaultFieldCiphertext(world.db, asAdmin, { fieldId, purpose: "reveal" }),
          "vault_field_not_found",
        ),
      );
      const before = await world.admin<{ count: number }[]>`
        select count(*)::int as count from audit_events
        where action = 'vault.field.revealed' and target_id = ${memberItemId}`;
      const revealed = await readVaultFieldCiphertext(world.db, asMember, {
        fieldId,
        purpose: "reveal",
      });
      expect(revealed.valueEncrypted).toBeTruthy();
      const after = await world.admin<{ count: number }[]>`
        select count(*)::int as count from audit_events
        where action = 'vault.field.revealed' and target_id = ${memberItemId}`;
      expect(after[0]!.count - before[0]!.count).toBe(1);
    });

    test("AX-8: a stale execution generation cannot resolve", async () => {
      if (!client) return;
      const turn = await startTurn(world, {
        createdBy: { kind: "subject", subjectId: world.member.subjectId },
      });
      const fresh = await reach(world, turn.principal);
      expect(fresh.labels).toContain("workspace");
      await expectVaultError(
        reach(world, {
          ...turn.principal,
          executionGeneration: turn.principal.executionGeneration - 1,
        }),
        "vault_permission_denied",
      );
      await expectVaultError(
        reach(world, { ...turn.principal, attemptId: crypto.randomUUID() }),
        "vault_permission_denied",
      );
    });

    test("AX-3: a schedule owner who loses membership resolves nothing on the next run", async () => {
      if (!client) return;
      const leaver = {
        subjectId: `user:vaults-leaver-${crypto.randomUUID()}`,
      };
      await world.addMembership(leaver.subjectId, "member");
      await world.admin`
        insert into workspace_memberships (account_id, workspace_id, subject_id, permissions)
        values (${world.accountId}::uuid, ${world.workspaceId}::uuid, ${leaver.subjectId},
          '["sessions:create","scheduled-tasks:write","secrets:use"]'::jsonb)`;
      const own = await createVault(world.db, world.subject(leaver.subjectId), {
        name: "Leaver only",
        ownerKind: "user",
      });
      const ownItem = await world.item(
        world.subject(leaver.subjectId),
        own,
        "LEAVER_KEY",
        "leaver",
      );
      const task = await createScheduledTask(world.db, {
        accountId: world.accountId,
        workspaceId: world.workspaceId,
        name: `Leaver ${crypto.randomUUID().slice(0, 6)}`,
        status: "active",
        schedule: { type: "manual" },
        temporalScheduleId: `vaults-leaver-${crypto.randomUUID()}`,
        runMode: "new_session_per_run",
        overlapPolicy: "allow_concurrent",
        agentConfig: { prompt: "leaver", resources: [], tools: [], metadata: {} },
        createdBy: { kind: "subject", subjectId: leaver.subjectId },
        metadata: {},
      });
      const extra = { [ownItem.id]: "leaverOnly" };
      const first = await startTurn(world, {
        createdBy: { kind: "service", subjectId: "service:scheduler" },
        scheduledTaskId: task.id,
      });
      expect((await reach(world, first.principal, extra)).labels).toEqual(
        ["leaverOnly", ...SHARED].sort(),
      );

      await world.admin`
        update organization_memberships set status = 'revoked', revoked_at = now()
        where account_id = ${world.accountId}::uuid and subject_id = ${leaver.subjectId}`;
      const second = await startTurn(world, {
        createdBy: { kind: "service", subjectId: "service:scheduler" },
        scheduledTaskId: task.id,
      });
      const after = await reach(world, second.principal, extra);
      expect(after.labels).toEqual([]);
      expect(after.meta).toMatchObject({ humanExpected: true, humanValid: false });
    });

    test("AX-4: organization vault availability follows its toggles", async () => {
      if (!client) return;
      const memberHere: SecretPrincipal = {
        kind: "human",
        accountId: world.accountId,
        workspaceId: world.workspaceId,
        subjectId: world.member.subjectId,
        verifiedHuman: true,
        viaApiKey: false,
      };
      const ownerPersonal: SecretPrincipal = {
        kind: "human",
        accountId: world.accountId,
        workspaceId: world.personalWorkspaceId,
        subjectId: world.member.subjectId,
        verifiedHuman: true,
        viaApiKey: false,
      };
      const org = (labels: string[]) => labels.filter((label) => label.startsWith("org"));
      expect(org((await reach(world, memberHere)).labels)).toEqual([
        "orgAvailable",
        "orgNoPersonal",
      ]);
      expect(org((await reach(world, ownerPersonal)).labels)).toEqual([
        "orgAvailable",
        "orgElsewhere",
      ]);

      const asOwner = world.subject(world.owner.subjectId);
      const asOwnerThere = world.subject(world.owner.subjectId, world.personalWorkspaceId);
      const elsewhere = await getVault(world.db, asOwnerThere, {
        vaultId: world.vaults.orgElsewhere.id,
      });
      await updateVault(world.db, asOwnerThere, {
        vaultId: elsewhere.id,
        expectedGeneration: elsewhere.generation,
        availability: { allowedWorkspaceIds: null, allowPersonalWorkspaces: false },
        allowOrganization: true,
      });
      expect(org((await reach(world, memberHere)).labels)).toEqual([
        "orgAvailable",
        "orgElsewhere",
        "orgNoPersonal",
      ]);
      expect(org((await reach(world, ownerPersonal)).labels)).toEqual(["orgAvailable"]);

      const noPersonal = await getVault(world.db, asOwner, {
        vaultId: world.vaults.orgNoPersonal.id,
      });
      await updateVault(world.db, asOwner, {
        vaultId: noPersonal.id,
        expectedGeneration: noPersonal.generation,
        availability: { allowedWorkspaceIds: null, allowPersonalWorkspaces: true },
        allowOrganization: true,
      });
      expect(org((await reach(world, ownerPersonal)).labels)).toEqual([
        "orgAvailable",
        "orgNoPersonal",
      ]);
      // Restore for later tests.
      const restored = await getVault(world.db, asOwner, { vaultId: world.vaults.orgElsewhere.id });
      await updateVault(world.db, asOwner, {
        vaultId: restored.id,
        expectedGeneration: restored.generation,
        availability: {
          allowedWorkspaceIds: [world.personalWorkspaceId],
          allowPersonalWorkspaces: true,
        },
        allowOrganization: true,
      });
    });

    test("AX-4: an Only-me vault is available where its owner chooses, and always at home", async () => {
      if (!client) return;
      const [other] = await world.admin<{ id: string }[]>`
        insert into workspaces (account_id, name) values (${world.accountId}::uuid, 'Second shared')
        returning id::text as id`;
      const secondWorkspaceId = other!.id;
      await world.admin`
        insert into workspace_memberships (account_id, workspace_id, subject_id, role, permissions)
        values (${world.accountId}::uuid, ${secondWorkspaceId}::uuid, ${world.member.subjectId}, 'member',
          ${JSON.stringify(["sessions:create", "sessions:read", "secrets:use"])}::text::jsonb)`;
      const personIn = (subjectId: string, workspaceId: string): SecretPrincipal => ({
        kind: "human",
        accountId: world.accountId,
        workspaceId,
        subjectId,
        verifiedHuman: true,
        viaApiKey: false,
      });
      const memberIn = (workspaceId: string) => personIn(world.member.subjectId, workspaceId);
      const here = world.subject(world.member.subjectId);
      const home = world.subject(world.member.subjectId, world.personalWorkspaceId);

      // A new Only-me vault starts in the workspace it was added from.
      const narrow = await createVault(world.db, here, { name: "Started here", ownerKind: "user" });
      expect(narrow.availability?.allowedWorkspaceIds).toEqual([world.workspaceId]);
      const written = await world.item(here, narrow, "KEY_started_here", "value-started-here");
      const extra = { [written.id]: "startedHere" };
      const reaches = async (workspaceId: string) =>
        (await reach(world, memberIn(workspaceId), extra)).labels.includes("startedHere");
      expect(await reaches(world.workspaceId)).toBe(true);
      expect(await reaches(world.personalWorkspaceId)).toBe(true);
      expect(await reaches(secondWorkspaceId)).toBe(false);
      await expectVaultError(
        getVault(world.db, world.subject(world.member.subjectId, secondWorkspaceId), {
          vaultId: narrow.id,
        }),
        "vault_not_found",
      );

      // The owner moves it from home, where it is always reachable.
      const atHome = await getVault(world.db, home, { vaultId: narrow.id });
      const moved = await updateVault(world.db, home, {
        vaultId: narrow.id,
        expectedGeneration: atHome.generation,
        availability: {
          allowedWorkspaceIds: [secondWorkspaceId, secondWorkspaceId],
          allowPersonalWorkspaces: true,
        },
      });
      expect(moved.availability?.allowedWorkspaceIds).toEqual([secondWorkspaceId]);
      expect(await reaches(world.workspaceId)).toBe(false);
      expect(await reaches(secondWorkspaceId)).toBe(true);
      expect(await reaches(world.personalWorkspaceId)).toBe(true);

      // An empty list keeps it at home only; null makes it available everywhere.
      const homeOnly = await updateVault(world.db, home, {
        vaultId: narrow.id,
        expectedGeneration: moved.generation,
        availability: { allowedWorkspaceIds: [], allowPersonalWorkspaces: true },
      });
      expect(homeOnly.availability?.allowedWorkspaceIds).toEqual([]);
      expect(await reaches(secondWorkspaceId)).toBe(false);
      expect(await reaches(world.personalWorkspaceId)).toBe(true);
      await updateVault(world.db, home, {
        vaultId: narrow.id,
        expectedGeneration: homeOnly.generation,
        availability: { allowedWorkspaceIds: null, allowPersonalWorkspaces: true },
      });
      expect(await reaches(world.workspaceId)).toBe(true);
      expect(await reaches(secondWorkspaceId)).toBe(true);

      // Nobody else reaches it, wherever it is available.
      const adminHere = personIn(world.orgAdmin.subjectId, world.workspaceId);
      expect((await reach(world, adminHere, extra)).labels).not.toContain("startedHere");

      // An explicit availability on create wins over the default.
      const everywhere = await createVault(world.db, here, {
        name: "Everywhere from the start",
        ownerKind: "user",
        availability: { allowedWorkspaceIds: null, allowPersonalWorkspaces: true },
      });
      expect(everywhere.availability?.allowedWorkspaceIds).toBeNull();

      // The default vault stays available everywhere.
      const defaultVault = await ensureDefaultVault(
        world.db,
        world.subject(world.member.subjectId, secondWorkspaceId),
        {
          workspaceId: secondWorkspaceId,
          ownerKind: "user",
        },
      );
      expect(defaultVault.isDefault).toBe(true);
      expect(defaultVault.availability?.allowedWorkspaceIds).toBeNull();
      await expectVaultError(
        updateVault(world.db, here, {
          vaultId: defaultVault.id,
          expectedGeneration: defaultVault.generation,
          availability: { allowedWorkspaceIds: [world.workspaceId], allowPersonalWorkspaces: true },
        }),
        "vault_permission_denied",
      );
    });

    test("AX-2: narrowing is a subset of the parent, applies at resolve time and spares the task vault", async () => {
      if (!client) return;
      const parent = await startTurn(world, {
        createdBy: { kind: "subject", subjectId: world.member.subjectId },
      });
      const parentTask = await taskItem(world, parent, "parent");
      const extra = { [parentTask.itemId]: "task" };
      const asMember = world.subject(world.member.subjectId);
      await setSessionVaultPolicy(world.db, asMember, {
        sessionId: parent.sessionId,
        policy: {
          mode: "selected",
          vaultIds: [world.vaults.workspace.id, world.vaults.orgAvailable.id],
        },
      });
      expect((await reach(world, parent.principal, extra)).labels).toEqual([
        "orgAvailable",
        "task",
        "workspace",
      ]);

      const child = await startTurn(world, {
        createdBy: { kind: "subject", subjectId: world.member.subjectId },
        parentSessionId: parent.sessionId,
      });
      // The child shares the root's task vault and inherits the parent's narrowing.
      expect((await reach(world, child.principal, extra)).labels).toEqual([
        "orgAvailable",
        "task",
        "workspace",
      ]);
      const outside = await expectVaultError(
        setSessionVaultPolicy(world.db, asMember, {
          sessionId: child.sessionId,
          policy: { mode: "selected", vaultIds: [world.vaults.memberOnly.id] },
        }),
        "vault_policy_outside_parent",
      );
      expect(outside.details).toMatchObject({ outsideVaultIds: [world.vaults.memberOnly.id] });
      await expectVaultError(
        setSessionVaultPolicy(world.db, asMember, {
          sessionId: child.sessionId,
          policy: { mode: "all" },
        }),
        "vault_policy_outside_parent",
      );
      await setSessionVaultPolicy(world.db, asMember, {
        sessionId: child.sessionId,
        policy: { mode: "selected", vaultIds: [world.vaults.workspace.id.toUpperCase()] },
      });
      expect((await reach(world, child.principal, extra)).labels).toEqual(["task", "workspace"]);

      // A later parent narrowing narrows the child at resolve time.
      await setSessionVaultPolicy(world.db, asMember, {
        sessionId: parent.sessionId,
        policy: { mode: "selected", vaultIds: [world.vaults.orgAvailable.id] },
      });
      expect((await reach(world, child.principal, extra)).labels).toEqual(["task"]);

      // A schedule's policy applies to its runs.
      const scheduled = await createScheduledTask(world.db, {
        accountId: world.accountId,
        workspaceId: world.workspaceId,
        name: `Narrow ${crypto.randomUUID().slice(0, 6)}`,
        status: "active",
        schedule: { type: "manual" },
        temporalScheduleId: `vaults-narrow-${crypto.randomUUID()}`,
        runMode: "new_session_per_run",
        overlapPolicy: "allow_concurrent",
        agentConfig: { prompt: "narrow", resources: [], tools: [], metadata: {} },
        createdBy: { kind: "service", subjectId: "service:vault-access-test" },
        vaultPolicy: { mode: "selected", vaultIds: [world.vaults.orgNoPersonal.id] },
        metadata: {},
      });
      expect(scheduled.vaultPolicy).toEqual({
        mode: "selected",
        vaultIds: [world.vaults.orgNoPersonal.id],
      });
      const run = await startTurn(world, {
        createdBy: { kind: "service", subjectId: "service:scheduler" },
        scheduledTaskId: scheduled.id,
      });
      const runTask = await taskItem(world, run, "run");
      expect((await reach(world, run.principal, { [runTask.itemId]: "task" })).labels).toEqual([
        "orgNoPersonal",
        "task",
      ]);
    });

    test("DM-7: shape checks, unique names and the root-session cascade", async () => {
      if (!client) return;
      const admin = world.admin;
      // A user vault needs its owner membership; a task vault needs its root session.
      await expect(
        executeLazy(
          () => admin`insert into vaults (account_id, workspace_id, owner_kind, name)
          values (${world.accountId}::uuid, ${world.workspaceId}::uuid, 'user', 'No owner')`,
        ),
      ).rejects.toThrow();
      await expect(
        executeLazy(
          () => admin`insert into vaults (account_id, workspace_id, owner_kind, name)
          values (${world.accountId}::uuid, ${world.workspaceId}::uuid, 'task', 'No root')`,
        ),
      ).rejects.toThrow();
      await expect(
        executeLazy(
          () => admin`insert into vaults (account_id, workspace_id, owner_kind, name, source)
          values (${world.accountId}::uuid, ${world.workspaceId}::uuid, 'workspace', 'Provider', 'onepassword')`,
        ),
      ).rejects.toThrow();
      // Name rules: surrounding whitespace (vertical tab included) is refused,
      // and names may start and end with any letter, "v" included.
      const [names] = await admin<Record<string, boolean | string>[]>`
        select opengeni_private.vault_name_is_valid('value') as value,
          opengeni_private.vault_name_is_valid('dev env v') as trailing_v,
          opengeni_private.vault_name_is_valid(' padded') as padded,
          opengeni_private.vault_name_is_valid(chr(11) || 'tab') as vertical_tab,
          opengeni_private.vault_sanitize_legacy_name('  vault/v ') as sanitized`;
      expect(names).toEqual({
        value: true,
        trailing_v: true,
        padded: false,
        vertical_tab: false,
        sanitized: "vault-v",
      });
      // Names are unique per owner scope, case-insensitively, for vaults and items.
      await expectVaultError(
        createVault(world.db, world.subject(world.member.subjectId), {
          name: "TEAM",
          ownerKind: "workspace",
        }),
        "vault_name_conflict",
      );
      await expectVaultError(
        world.item(
          world.subject(world.member.subjectId),
          world.vaults.workspace,
          "key_WORKSPACE",
          "dup",
        ),
        "vault_item_name_conflict",
      );
      // The same name is fine in another owner scope.
      await createVault(world.db, world.subject(world.member.subjectId), {
        name: "Team",
        ownerKind: "user",
      });

      // Deleting the root session deletes its task vault, items, fields and versions.
      const turn = await startTurn(world, {
        createdBy: { kind: "subject", subjectId: world.member.subjectId },
      });
      const written = await taskItem(world, turn, "cascade");
      const fieldIds = (
        await admin<{ id: string }[]>`
          select id::text from vault_item_fields where item_id = ${written.itemId}::uuid`
      ).map((row) => row.id);
      const count = async () =>
        (
          await admin<{ vaults: number; items: number; versions: number }[]>`
          select
            (select count(*)::int from vaults where id = ${written.vault.id}::uuid) as vaults,
            (select count(*)::int from vault_items where vault_id = ${written.vault.id}::uuid) as items,
            (select count(*)::int from vault_field_versions
              where field_id = any(${fieldIds}::uuid[])) as versions`
        )[0]!;
      expect(await count()).toEqual({ vaults: 1, items: 1, versions: 1 });
      await admin.begin(async (tx) => {
        await tx`update sessions set active_turn_id = null where id = ${turn.sessionId}::uuid`.catch(
          () => undefined,
        );
      });
      await admin`delete from sessions where id = ${turn.sessionId}::uuid`;
      expect(await count()).toEqual({ vaults: 0, items: 0, versions: 0 });

      // Row security is forced and the application role has no direct access.
      const app = postgres(shared!.appUrl, { max: 1, onnotice: () => undefined });
      try {
        await expect(executeLazy(() => app`select count(*) from vaults`)).rejects.toThrow(
          /permission denied/,
        );
        await expect(
          executeLazy(() => app`select count(*) from vault_field_versions`),
        ).rejects.toThrow(/permission denied/);
      } finally {
        await app.end();
      }
    });

    test("DM-8: limits raise vault_limit_reached or secret_value_too_large and versions are pruned to 10", async () => {
      if (!client) return;
      const app = postgres(shared!.appUrl, { max: 1, onnotice: () => undefined });
      const vault = await createVault(world.db, world.subject(world.member.subjectId), {
        name: `Limits ${crypto.randomUUID().slice(0, 6)}`,
        ownerKind: "workspace",
      });
      const scoped = async <T>(
        overrides: Record<string, number>,
        fn: (sql: postgres.TransactionSql) => Promise<T>,
      ) =>
        await app.begin(async (sql) => {
          await sql`select set_config('opengeni.account_id', ${world.accountId}, true),
            set_config('opengeni.workspace_id', ${world.workspaceId}, true),
            set_config('opengeni.subject_id', ${world.member.subjectId}, true),
            set_config('opengeni.vault_limits_override', ${JSON.stringify(overrides)}, true)`;
          return await fn(sql);
        });
      const write = (sql: postgres.TransactionSql, payload: Record<string, unknown>) =>
        sql`select upsert_vault_item(${JSON.stringify({ vaultId: vault.id, type: "api_key", ...payload })}::text::jsonb) as value`;
      const field = (value: string) => ({
        name: "value",
        kind: "concealed" as const,
        valueEncrypted: encryptEnvironmentValue(key, value),
        valueSize: Buffer.byteLength(value),
      });
      const code = async (promise: Promise<unknown>) => {
        try {
          await promise;
          return null;
        } catch (error) {
          return String((error as Error).message).split(":")[0];
        }
      };
      try {
        expect(
          await code(
            scoped({ itemsPerVault: 2 }, async (sql) => {
              await write(sql, { name: "ONE", fields: [field("1")] });
              await write(sql, { name: "TWO", fields: [field("2")] });
              await write(sql, { name: "THREE", fields: [field("3")] });
            }),
          ),
        ).toBe("vault_limit_reached");
        expect(
          await code(
            scoped({ fieldsPerItem: 2 }, (sql) =>
              write(sql, {
                name: "FIELDS",
                fields: ["a", "b", "c"].map((name) => ({ ...field(name), name })),
              }),
            ),
          ),
        ).toBe("vault_limit_reached");
        expect(
          await code(
            scoped({ textValueMaxBytes: 4 }, (sql) =>
              write(sql, { name: "BIG", fields: [{ ...field("12345") }] }),
            ),
          ),
        ).toBe("secret_value_too_large");
        expect(
          await code(
            scoped(
              { vaultsPerOwnerScope: 1 },
              (sql) =>
                sql`select create_vault(${JSON.stringify({ name: `Over ${crypto.randomUUID().slice(0, 6)}`, ownerKind: "workspace" })}::text::jsonb)`,
            ),
          ),
        ).toBe("vault_limit_reached");
        // The real text limit (64 KiB) without overrides.
        const big = "x".repeat(65_537);
        await expectVaultError(
          world.item(world.subject(world.member.subjectId), vault, "REAL_BIG", big),
          "secret_value_too_large",
        );

        // Versions beyond 10 are pruned, oldest first.
        const asMember = world.subject(world.member.subjectId);
        const created = await world.item(asMember, vault, "ROTATED", "v1");
        for (let version = 2; version <= 13; version += 1) {
          await upsertVaultItem(world.db, asMember, {
            itemId: created.id,
            fields: [{ ...field(`v${version}`) }],
          });
        }
        const current = await getVaultItem(world.db, asMember, { itemId: created.id });
        const versions = await listVaultFieldVersions(world.db, asMember, {
          fieldId: current.fields[0]!.id,
        });
        expect(versions.map((row) => row.version).sort((a, b) => a - b)).toEqual([
          4, 5, 6, 7, 8, 9, 10, 11, 12, 13,
        ]);
      } finally {
        await app.end();
      }
    });
  },
);
