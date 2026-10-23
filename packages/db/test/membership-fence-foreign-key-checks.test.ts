import { afterAll, beforeAll, expect, test } from "bun:test";
import postgres from "postgres";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import {
  createDb,
  createSession,
  createWorkspace,
  ensureExternalIdentity,
  type DbClient,
} from "../src";

// A session row names its owner's organization membership through a foreign
// key. When a transaction updates the same session row twice, PostgreSQL checks
// that key again on the second update and takes FOR KEY SHARE on the
// membership. A request path that fences the membership and then writes the
// session must not block that check, or the two transactions deadlock: each
// waits for the row the other already holds.
let shared: SharedTestDatabase;
let client: DbClient;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("membership-fence-foreign-key-checks");
  if (!acquired) throw new Error("membership fence tests require real PostgreSQL");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
});

test("an external identity fence and a repeated session write do not deadlock", async () => {
  const [account] = await shared.admin<Array<{ id: string }>>`
    insert into managed_accounts (name) values ('Membership fence fixture') returning id`;
  const accountId = String(account!.id);
  const source = "example:instance";
  const externalId = crypto.randomUUID();
  const identity = await ensureExternalIdentity(client.db, { accountId, source, externalId });
  const team = await createWorkspace(client.db, { accountId, name: "Team workspace" });
  await shared.admin`
    insert into workspace_memberships (account_id, workspace_id, subject_id, role, permissions)
    values (${accountId}, ${team.id}, ${identity.subjectId}, 'member',
      opengeni_private.workspace_member_role_permissions('member'))`;
  await shared.admin`
    insert into session_tenancy_activations
      (account_id, activation_version, inventory_digest, parity_digest, activated_by)
    values (${accountId}, 1, ${"1".repeat(64)}, ${"2".repeat(64)}, 'membership-fence-test')`;
  const session = await createSession(client.db, {
    accountId,
    workspaceId: team.id,
    initialMessage: "membership fence",
    resources: [],
    metadata: {},
    createdBy: { kind: "subject", subjectId: identity.subjectId },
    model: "test-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  const [owned] = await shared.admin<Array<{ owner: string | null }>>`
    select owner_organization_membership_id as "owner" from sessions where id = ${session.id}`;
  expect(owned?.owner).toBe(identity.organizationMembershipId);

  const writer = postgres(shared.adminUrl, { max: 1 });
  const fence = postgres(shared.adminUrl, { max: 1 });
  try {
    const [fenceBackend] = await fence<Array<{ pid: number }>>`select pg_backend_pid() as pid`;
    const fencePid = fenceBackend!.pid;
    let releaseWriter!: () => void;
    const writerMayContinue = new Promise<void>((resolve) => (releaseWriter = resolve));
    let writerHoldsSession!: () => void;
    const writerHoldsSessionRow = new Promise<void>((resolve) => (writerHoldsSession = resolve));

    // A turn transition: write the session row, then write it again.
    const writing = writer.begin(async (tx) => {
      await tx`set local lock_timeout = '15s'`;
      await tx`update sessions set updated_at = clock_timestamp() where id = ${session.id}`;
      writerHoldsSession();
      await writerMayContinue;
      await tx`update sessions set updated_at = clock_timestamp() where id = ${session.id}`;
    });
    await writerHoldsSessionRow;

    // An external request: fence the identity's membership, then write the
    // same session. It waits for the writer's session row lock.
    const fencing = fence.begin(async (tx) => {
      await tx`set local lock_timeout = '15s'`;
      await tx`select set_config('opengeni.account_id', ${accountId}, true)`;
      await tx`select ensure_external_identity(${accountId}::uuid, ${source}, ${externalId})`;
      await tx`update sessions set updated_at = clock_timestamp() where id = ${session.id}`;
    });
    for (let attempt = 0; ; attempt += 1) {
      const [waiting] = await shared.admin<Array<{ waiting: boolean }>>`
        select wait_event_type = 'Lock' as waiting from pg_stat_activity where pid = ${fencePid}`;
      if (waiting?.waiting) break;
      if (attempt > 200) throw new Error("the fencing transaction never reached the session row");
      await Bun.sleep(25);
    }

    // The writer's second update re-checks the owner key while the fence holds
    // the membership. Both transactions must commit.
    releaseWriter();
    const outcomes = await Promise.allSettled([writing, fencing]);
    expect(
      outcomes.map((outcome) =>
        outcome.status === "fulfilled"
          ? "committed"
          : `${(outcome.reason as { code?: string }).code ?? ""} ${String(outcome.reason)}`,
      ),
    ).toEqual(["committed", "committed"]);
  } finally {
    await writer.end();
    await fence.end();
  }
}, 120_000);

test("runtime membership fences never block foreign-key checks", async () => {
  // FOR UPDATE is only needed to delete a membership or change its key.
  // Every routine that fences an existing membership while it writes other
  // rows uses FOR NO KEY UPDATE, which still excludes lifecycle writers.
  const rows = await shared.admin<Array<{ routine: string }>>`
    select p.oid::regprocedure::text as routine
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('ensure_external_identity', 'transition_session_visibility', 'fork_session_content')
      and p.prosrc ~* 'from\\s+organization_memberships\\M[^;]*\\mfor\\s+update\\M'`;
  expect(rows.map((row) => row.routine)).toEqual([]);
});
