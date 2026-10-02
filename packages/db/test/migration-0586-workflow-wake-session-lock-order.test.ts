import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "../../testing/src/shared-pg";
import {
  claimPendingSessionWorkflowWakes,
  createDb,
  createSession,
  enqueueSessionWorkflowWake,
  withRlsContext,
  type DbClient,
} from "../src";
import { migrate } from "../src/migrate";

let owned: OwnerMigratedTestDatabase;
let owner: postgres.Sql;
let client: DbClient;

beforeAll(async () => {
  const acquired = await acquireOwnerMigratedTestDatabase("wake-lock-order-owner");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  owned = acquired;
  await migrate(owned.ownerUrl);
  owner = postgres(owned.ownerUrl, { max: 1 });
  client = createDb(owned.ownerUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await owner?.end();
  await owned?.release();
}, 60_000);

test("rolling wake replacement preserves owner, ACL, scoped FORCE-RLS, and caller GUCs", async () => {
  const [role] = await owned.admin`
    select rolsuper, rolbypassrls from pg_roles where rolname = ${owned.ownerRole}
  `;
  expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
  const original = await readFile(
    new URL("../drizzle/0174_session_wake_live_interruption.sql", import.meta.url),
    "utf8",
  );
  const replacement = await readFile(
    new URL("../drizzle/0586_workflow_wake_session_lock_order.sql", import.meta.url),
    "utf8",
  );
  // Exercise an old dispatcher against the unchanged six-column SQL ABI and
  // then replace it online, as the migration does. No RLS relaxation occurs.
  await owner.unsafe(original);
  const posture = async () =>
    (
      await owner`
    select proowner, proacl::text, prosecdef, proconfig, pg_get_function_result(oid) as result
    from pg_proc where oid = 'opengeni_private.claim_session_workflow_wakes(integer)'::regprocedure
  `
    )[0];
  const before = await posture();
  const fixtures: Array<{ accountId: string; workspaceId: string; sessionId: string }> = [];
  for (let index = 0; index < 2; index++) {
    const [account] =
      await owned.admin`insert into managed_accounts (name) values ('wake owner fixture') returning id`;
    const [workspace] = await owned.admin`insert into workspaces (account_id, name)
      values (${account!.id}, 'wake owner fixture') returning id`;
    const sessionId = crypto.randomUUID();
    await owned.admin`insert into workspace_inference_controls (workspace_id, account_id)
      values (${workspace!.id}, ${account!.id})`;
    await createSession(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      requestedSessionId: sessionId,
      initialMessage: "wake owner fixture",
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      resources: [],
      metadata: {},
    });
    await enqueueSessionWorkflowWake(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      sessionId,
      temporalWorkflowId: `session-${sessionId}`,
      reason: "owner fixture",
    });
    fixtures.push({ accountId: account!.id, workspaceId: workspace!.id, sessionId });
  }
  // Existing limitation: a FORCE-RLS-bound owner with no tenant scope cannot
  // inventory this ledger. The fix must not invent cross-tenant authority.
  expect(await claimPendingSessionWorkflowWakes(client.db, 1000)).toEqual([]);
  const scopedClaim = async (fixture: (typeof fixtures)[number]) =>
    withRlsContext(
      client.db,
      { accountId: fixture.accountId, workspaceId: fixture.workspaceId },
      async (scoped) => {
        const settings = async () =>
          (await scoped.execute(sql`select
        current_setting('opengeni.account_id', true) as account_id,
        current_setting('opengeni.workspace_id', true) as workspace_id,
        current_setting('opengeni.subject_id', true) as subject_id`)) as unknown;
        const prior = await settings();
        const claimed = await claimPendingSessionWorkflowWakes(scoped, 1000);
        expect(await settings()).toEqual(prior);
        return claimed;
      },
    );
  const oldClaim = await scopedClaim(fixtures[0]!);
  expect(oldClaim.map((wake) => wake.sessionId)).toEqual([fixtures[0]!.sessionId]);
  await owner.unsafe(replacement);
  expect(await posture()).toEqual(before);
  expect(await claimPendingSessionWorkflowWakes(client.db, 1000)).toEqual([]);
  await owned.admin`update session_workflow_wake_outbox set attempts = 0, next_attempt_at = now()
    where session_id = ${fixtures[0]!.sessionId}`;
  expect(await scopedClaim(fixtures[0]!)).toEqual(oldClaim);
  expect((await scopedClaim(fixtures[1]!)).map((wake) => wake.sessionId)).toEqual([
    fixtures[1]!.sessionId,
  ]);
  const [guard] = await owned.admin`select tgenabled from pg_trigger
    where tgname = 'session_workflow_wake_imported_archive_guard'`;
  expect(guard?.tgenabled).toBe("O");
}, 180_000);
