import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  getSandboxRecoveryDiscontinuity,
  readRecentSandboxRecoveryObservations,
  submitHumanPromptInTransaction,
  withWorkspaceRls,
  withWorkspaceSubjectSessionActivityRls,
} from "../src/index";
import { nestedPostgresSqlState } from "../src/persistence-errors";

const MIGRATION = "0548_lost_sandbox_group_continuity.sql";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("migration-0548-lost-sandbox-continuity");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function sqlState(operation: PromiseLike<unknown>): Promise<string | null> {
  const failure = await Promise.resolve(operation).then(
    () => null,
    (error: unknown) => error,
  );
  return failure === null ? null : (nestedPostgresSqlState(failure) ?? "unknown");
}

async function workspaceSession() {
  const unique = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: unique,
    accountName: "fresh workspace receipts",
    workspaceExternalSource: "test",
    workspaceExternalId: unique,
    workspaceName: "fresh workspace receipts",
    subjectId: `subject-${unique}`,
  });
  const grant = access.workspaceGrants[0]!;
  const scope = {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    subjectId: grant.subjectId,
  };
  const session = await createSession(client.db, {
    ...scope,
    initialMessage: "",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "modal",
  });
  return { ...scope, session };
}

type Fixture = Awaited<ReturnType<typeof workspaceSession>>;

function freshReceipt(f: Fixture) {
  const operationId = crypto.randomUUID();
  return {
    operationId,
    result: {
      operationId,
      initiatingSessionId: f.session.id,
      freshWorkspace: {
        version: 1,
        sessionId: f.session.id,
        sandboxGroupId: f.session.sandboxGroupId,
        leaseId: crypto.randomUUID(),
        leaseEpoch: 4,
        workspaceGeneration: 12,
        archiveGeneration: null,
        lostAt: "2026-09-22T10:11:12.000Z",
        reason: "archive_unavailable",
      },
    },
  };
}

async function insertFreshReceipt(f: Fixture) {
  const receipt = freshReceipt(f);
  const [row] = await withWorkspaceRls(client.db, f.workspaceId, (tx) =>
    tx.execute<{ id: string }>(sql`
      insert into session_command_receipts(account_id, workspace_id, actor_type, actor_subject_id,
        action, target_session_id, operation_key, canonical_request_hash, result)
      values(${f.accountId}, ${f.workspaceId}, 'service', 'opengeni:automatic-sandbox-recovery',
        'sandbox.recovery.fresh_workspace', ${f.session.id}, ${receipt.operationId},
        'fresh-workspace-test', ${JSON.stringify(receipt.result)}::jsonb)
      returning id`),
  );
  return { id: row!.id, ...receipt };
}

async function claim(f: Fixture, protocol: 1 | 2 | 3 | undefined) {
  await withWorkspaceSubjectSessionActivityRls(client.db, f.workspaceId, f.subjectId, (tx) =>
    submitHumanPromptInTransaction(tx, {
      accountId: f.accountId,
      workspaceId: f.workspaceId,
      subjectId: f.subjectId,
      sessionId: f.session.id,
      actor: { type: "human", subjectId: f.subjectId },
      operationKey: crypto.randomUUID(),
      delivery: "send",
      text: "Inspect the current workspace",
      resources: [],
      reasoningEffortFallback: "medium",
      source: "user",
    }),
  );
  return await claimSessionWorkForAttempt(client.db, f.workspaceId, {
    sessionId: f.session.id,
    workflowId: `session-${f.session.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId: crypto.randomUUID(),
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
    ...(protocol ? { filesystemDiscontinuityProtocol: protocol } : {}),
  });
}

test("is a reviewed rolling migration that never rewrites older receipts or leases", async () => {
  const text = await readFile(new URL(`../drizzle/${MIGRATION}`, import.meta.url), "utf8");
  expect(text.split("\n")[0]).toBe("-- deployment-mode: rolling");
  expect(text).not.toMatch(/\bupdate\s+(sandbox_leases|session_command_receipts)\b/i);
  expect(text).not.toMatch(/\bdelete\s+from\b/i);
}, 180_000);

test("an empty-workspace receipt fences every claim below warning protocol v3", async () => {
  const f = await workspaceSession();
  await insertFreshReceipt(f);
  for (const protocol of [undefined, 1, 2] as const) {
    expect(await sqlState(claim(f, protocol))).toBe("55000");
  }
  expect(await claim(f, 3)).toMatchObject({ action: "claimed" });
  const [stamp] = await client.db.execute<{ value: string }>(
    sql`select coalesce(current_setting('opengeni.filesystem_discontinuity_protocol_v3', true), '') as value`,
  );
  expect(stamp!.value).toBe("");
  expect(await getSandboxRecoveryDiscontinuity(client.db, f.workspaceId, f.session.id)).toContain(
    "lost at 2026-09-22T10:11:12.000Z",
  );
}, 180_000);

test("empty-workspace receipts are immutable and permanent until their session is deleted", async () => {
  const f = await workspaceSession();
  const receipt = await insertFreshReceipt(f);
  for (const assignment of [
    sql`action = 'renamed'`,
    sql`result = '{}'::jsonb`,
    sql`target_session_id = null`,
  ]) {
    expect(
      await sqlState(
        withWorkspaceRls(client.db, f.workspaceId, (tx) =>
          tx.execute(
            sql`update session_command_receipts set ${assignment} where id = ${receipt.id}`,
          ),
        ),
      ),
    ).toBe("55000");
  }
  expect(
    await sqlState(
      withWorkspaceRls(client.db, f.workspaceId, (tx) =>
        tx.execute(sql`delete from session_command_receipts where id = ${receipt.id}`),
      ),
    ),
  ).toBe("55000");
  await withWorkspaceSubjectSessionActivityRls(client.db, f.workspaceId, f.subjectId, (tx) =>
    tx.execute(sql`delete from sessions where id = ${f.session.id}`),
  );
  expect(
    (
      await shared.admin`select count(*)::int as count from session_command_receipts where id = ${receipt.id}`
    )[0]!.count,
  ).toBe(0);
}, 180_000);

test("the operator ledger records only attributed fresh-workspace decisions", async () => {
  const f = await workspaceSession();
  const eventId = crypto.randomUUID();
  // An event of another action cannot be recorded under the new kind.
  await shared.admin`insert into audit_events(id, account_id, workspace_id, subject_id, action,
      target_type, target_id, metadata)
    values(${eventId}, ${f.accountId}, ${f.workspaceId}, 'opengeni:sandbox-reaper',
      'sandbox.provider_missing_before_capture', 'sandbox_group', ${f.session.sandboxGroupId}, '{}'::jsonb)`;
  expect(
    await sqlState(
      withWorkspaceRls(client.db, f.workspaceId, (tx) =>
        tx.execute(sql`select opengeni_private.record_sandbox_recovery_operator_event(
          ${eventId}::uuid, 'fresh_workspace_selected')`),
      ),
    ),
  ).toBe("42501");
  const before = await readRecentSandboxRecoveryObservations(client.db);
  const freshId = crypto.randomUUID();
  await shared.admin`insert into audit_events(id, account_id, workspace_id, subject_id, action,
      target_type, target_id, metadata)
    values(${freshId}, ${f.accountId}, ${f.workspaceId}, 'opengeni:automatic-sandbox-recovery',
      'sandbox.fresh_workspace_recovery.authorized', 'sandbox_group', ${f.session.sandboxGroupId},
      '{}'::jsonb)`;
  await withWorkspaceRls(client.db, f.workspaceId, (tx) =>
    tx.execute(sql`select opengeni_private.record_sandbox_recovery_operator_event(
      ${freshId}::uuid, 'fresh_workspace_selected')`),
  );
  const after = await readRecentSandboxRecoveryObservations(client.db);
  expect(after.freshWorkspaceSelections).toBe(before.freshWorkspaceSelections + 1);
  expect(after.providerLosses).toBe(before.providerLosses);
  expect(
    await sqlState(
      client.db.execute(sql`insert into opengeni_private.sandbox_recovery_operator_receipts
        (audit_event_id, kind) values (${crypto.randomUUID()}::uuid, 'fresh_workspace_selected')`),
    ),
  ).toBe("42501");
  expect(
    await sqlState(
      shared.admin`insert into opengeni_private.sandbox_recovery_operator_receipts
        (audit_event_id, kind) values (${crypto.randomUUID()}, 'unknown_kind')`,
    ),
  ).toBe("23514");
}, 180_000);
