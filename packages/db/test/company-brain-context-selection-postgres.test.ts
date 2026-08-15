import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import {
  correctWorkspaceMemory,
  createDb,
  createSession,
  ensureManagedAccessForUser,
  getOrCreateCompanyProfileSnapshot,
  getOrCreatePreferenceRegistrySnapshot,
  getOrCreateWorkspaceInstructionPolicySnapshot,
  nestedPostgresSqlState,
  resolveCompanyBrainContextSelection,
  saveWorkspaceMemory,
  withSessionRlsActorContext,
  withWorkspaceRls,
  dbSql,
  type DbClient,
} from "../src";

const migrationPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../drizzle/0256_company_brain_context_selection_receipts.sql",
);
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("company-brain-context-selection");
  if (!shared && requireRealDatabase) {
    throw new Error("[company-brain-context-selection] real PostgreSQL is required");
  }
  if (shared) client = createDb(shared.appUrl, { max: 8 });
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

type Attempt = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  attemptId: string;
  executionGeneration: number;
  ownerSubjectId: string;
};

async function fixture(
  options: {
    child?: boolean;
    mode?: "legacy_standing" | "retrieval_only";
  } = {},
) {
  if (!shared || !client) throw new Error("test database unavailable");
  const suffix = crypto.randomUUID();
  const userId = `context-owner-${suffix}`;
  const ownerSubjectId = `user:${userId}`;
  const access = await ensureManagedAccessForUser(client.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Context owner",
  });
  const grant = access.workspaceGrants[0]!;
  await shared.admin`
    update workspaces set settings = ${shared.admin.json({
      memoryEnabled: true,
      memoryPromptMode: options.mode ?? "legacy_standing",
    })}::jsonb
    where id = ${grant.workspaceId}
  `;
  const root = await withSessionRlsActorContext({ subjectId: ownerSubjectId }, async () =>
    createSession(client!.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "root context task",
      resources: [],
      metadata: {},
      model: "test-model",
      sandboxBackend: "none",
      createdBy: { kind: "subject", subjectId: ownerSubjectId },
      createdByContext: {},
    }),
  );
  const child = options.child
    ? await withSessionRlsActorContext({ subjectId: ownerSubjectId }, async () =>
        createSession(client!.db, {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          parentSessionId: root.id,
          initialMessage: "child context task",
          resources: [],
          metadata: {},
          model: "test-model",
          sandboxBackend: "none",
          createdBy: { kind: "subject", subjectId: ownerSubjectId },
          createdByContext: {},
        }),
      )
    : null;
  return { grant, ownerSubjectId, root, child };
}

async function seedAttempt(input: {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  ownerSubjectId: string;
  turnId?: string;
  generation?: number;
}): Promise<Attempt> {
  if (!shared) throw new Error("test database unavailable");
  const turnId = input.turnId ?? crypto.randomUUID();
  const attemptId = crypto.randomUUID();
  const generation = input.generation ?? 1;
  await shared.admin.begin(async (sql) => {
    await sql`select set_config('opengeni.session_inference_claim', '1', true)`;
    if (input.turnId) {
      await sql`
        update session_turn_attempts set state = 'closed', outcome = 'interrupted_recoverable',
          closed_at = now() where workspace_id = ${input.workspaceId} and turn_id = ${turnId}
          and state in ('claimed','running')
      `;
      await sql`
        update session_turns set execution_generation = ${generation}, active_attempt_id = null,
          status = 'recovering' where workspace_id = ${input.workspaceId} and id = ${turnId}
      `;
    } else {
      await sql`
        insert into session_turns (
          id, account_id, workspace_id, session_id, trigger_event_id,
          temporal_workflow_id, status, source, position, prompt, model,
          reasoning_effort, sandbox_backend, execution_generation,
          initiator_kind, initiator_subject_id, initiator_context,
          initiating_human_subject_id
        ) values (
          ${turnId}, ${input.accountId}, ${input.workspaceId}, ${input.sessionId},
          ${crypto.randomUUID()}, ${`context-selection-${turnId}`}, 'running', 'user', 1,
          'context selection fixture', 'test-model', 'medium', 'none', ${generation},
          'subject', ${input.ownerSubjectId}, '{}'::jsonb, ${input.ownerSubjectId}
        )
      `;
    }
    await sql`
      insert into session_turn_attempts (
        id, account_id, workspace_id, session_id, turn_id, execution_generation,
        state, temporal_workflow_id, temporal_workflow_run_id,
        temporal_activity_id, verified_control_revision, mcp_approval_policies
      ) values (
        ${attemptId}, ${input.accountId}, ${input.workspaceId}, ${input.sessionId},
        ${turnId}, ${generation}, 'running', ${`context-selection-${turnId}`},
        ${`run-${attemptId}`}, ${`activity-${attemptId}`}, 0, '{}'::jsonb
      )
    `;
    await sql`
      update session_turns set active_attempt_id = ${attemptId}, status = 'running'
      where workspace_id = ${input.workspaceId} and id = ${turnId}
    `;
    await sql`
      update sessions set active_turn_id = ${turnId}, status = 'running'
      where workspace_id = ${input.workspaceId} and id = ${input.sessionId}
    `;
  });
  return { ...input, turnId, attemptId, executionGeneration: generation };
}

function claims(attempt: Attempt) {
  return {
    accountId: attempt.accountId,
    workspaceId: attempt.workspaceId,
    sessionId: attempt.sessionId,
    turnId: attempt.turnId,
    attemptId: attempt.attemptId,
    executionGeneration: attempt.executionGeneration,
  };
}

async function prepareSnapshots(attempt: Attempt): Promise<void> {
  await withSessionRlsActorContext(
    {
      subjectId: "worker:context",
      initiatingHumanSubjectId: attempt.ownerSubjectId,
    },
    async () => {
      await getOrCreateCompanyProfileSnapshot(client!.db, claims(attempt));
      await getOrCreateWorkspaceInstructionPolicySnapshot(client!.db, claims(attempt));
      await getOrCreatePreferenceRegistrySnapshot(client!.db, claims(attempt));
    },
  );
}

async function resolve(attempt: Attempt) {
  return await withSessionRlsActorContext(
    {
      subjectId: "worker:context",
      initiatingHumanSubjectId: attempt.ownerSubjectId,
    },
    async () => resolveCompanyBrainContextSelection(client!.db, claims(attempt)),
  );
}

async function expectSqlState(action: () => Promise<unknown>, state: string): Promise<void> {
  let failure: unknown;
  try {
    await action();
  } catch (error) {
    failure = error;
  }
  expect(nestedPostgresSqlState(failure)).toBe(state);
}

describe("accepted-turn Company Brain context selection", () => {
  test("declares a bounded content-free rolling receipt and target-schema-safe function", async () => {
    const sql = await readFile(migrationPath, "utf8");
    expect(sql.split(/\r?\n/, 1)[0]).toBe("-- deployment-mode: rolling");
    expect(sql).toContain("SET LOCAL lock_timeout = '5s'");
    expect(sql).toContain("SET LOCAL statement_timeout = '10min'");
    expect(sql).toContain("jsonb_array_length(value) > 50");
    expect(sql).toContain("octet_length(value::text) > 16384");
    expect(sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(sql).toContain("session_visibility_isolation");
    expect(sql).toContain("ALTER FUNCTION %1$I.company_brain_context_get_or_create_selection");
    expect(sql).not.toContain("memory.text'\n");
    expect(sql).not.toContain("task_notes note");
    if (shared) {
      const [installed] = await shared.admin<{ function_schema: string; current_schema: string }[]>`
        select routine_schema as function_schema, current_schema() as current_schema
        from information_schema.routines
        where routine_schema = current_schema()
          and routine_name = 'company_brain_context_get_or_create_selection'
      `;
      expect(installed?.function_schema).toBe(installed?.current_schema);
    }
  });

  test("reuses one logical-turn selection across attempt replacement and shrinks on revocation or hash drift", async () => {
    if (!shared || !client) return;
    const f = await fixture();
    const firstMemory = await saveWorkspaceMemory(client.db, {
      accountId: f.grant.accountId,
      workspaceId: f.grant.workspaceId,
      text: "Pinned architecture discovery.",
      kind: "semantic",
      pinned: true,
    });
    const secondMemory = await saveWorkspaceMemory(client.db, {
      accountId: f.grant.accountId,
      workspaceId: f.grant.workspaceId,
      text: "Secondary implementation discovery.",
      kind: "decision",
    });
    const firstAttempt = await seedAttempt({
      accountId: f.grant.accountId,
      workspaceId: f.grant.workspaceId,
      sessionId: f.root.id,
      ownerSubjectId: f.ownerSubjectId,
    });
    await saveWorkspaceMemory(client.db, {
      accountId: f.grant.accountId,
      workspaceId: f.grant.workspaceId,
      text: "Created after turn acceptance and before first selection.",
      kind: "semantic",
    });
    await prepareSnapshots(firstAttempt);
    const first = await resolve(firstAttempt);
    expect(first.receipt).toMatchObject({
      sessionRole: "root",
      memoryPromptMode: "legacy_standing",
      companyProfileIncluded: true,
      selectedMemoryCount: 2,
      visibleMemoryCount: 2,
      omittedMemoryCount: 0,
    });
    expect(first.workspaceMemory).toContain("Pinned architecture discovery.");
    expect(first.workspaceMemory).not.toContain("after turn acceptance");
    expect(first.workspaceMemory!.indexOf("Pinned architecture discovery.")).toBeLessThan(
      first.workspaceMemory!.indexOf("Secondary implementation discovery."),
    );
    const [durableReceipt] = await shared.admin<
      Array<{ memorySelections: Array<Record<string, unknown>> }>
    >`
      select memory_selections as "memorySelections"
      from company_brain_context_selection_receipts
      where workspace_id = ${f.grant.workspaceId} and turn_id = ${firstAttempt.turnId}
    `;
    expect(JSON.stringify(durableReceipt?.memorySelections)).not.toContain(
      "Pinned architecture discovery.",
    );
    expect(Object.keys(durableReceipt!.memorySelections[0]!).sort()).toEqual(
      [
        "contentHash",
        "id",
        "kind",
        "memoryVersion",
        "pinned",
        "textCodecVersion",
        "textHash",
      ].sort(),
    );

    await saveWorkspaceMemory(client.db, {
      accountId: f.grant.accountId,
      workspaceId: f.grant.workspaceId,
      text: "A newer row must not move an accepted logical turn.",
      kind: "semantic",
    });
    await shared.admin`
      update workspaces set settings = ${shared.admin.json({
        memoryEnabled: false,
        memoryPromptMode: "retrieval_only",
      })}::jsonb
      where id = ${f.grant.workspaceId}
    `;
    const recovery = await seedAttempt({
      ...firstAttempt,
      turnId: firstAttempt.turnId,
      generation: 2,
    });
    await prepareSnapshots(recovery);
    const replay = await resolve(recovery);
    expect(replay.receipt.id).toBe(first.receipt.id);
    expect(replay.receipt.selectionHash).toBe(first.receipt.selectionHash);
    expect(replay.receipt.memoryEnabled).toBe(true);
    expect(replay.receipt.memoryPromptMode).toBe("legacy_standing");
    expect(replay.receipt.selectedMemoryCount).toBe(2);
    expect(replay.workspaceMemory).not.toContain("newer row");

    await correctWorkspaceMemory(client.db, {
      accountId: f.grant.accountId,
      workspaceId: f.grant.workspaceId,
      id: firstMemory.memory.id,
      reason: "revoked during recovery",
    });
    await withWorkspaceRls(client.db, f.grant.workspaceId, async (tx) => {
      await tx.execute(dbSql`
        update knowledge_memories set text = 'Hash-drifted content'
        where workspace_id = ${f.grant.workspaceId}::uuid and id = ${secondMemory.memory.id}::uuid
      `);
    });
    const shrunk = await resolve(recovery);
    expect(shrunk.receipt.id).toBe(first.receipt.id);
    expect(shrunk.receipt).toMatchObject({
      selectedMemoryCount: 2,
      visibleMemoryCount: 0,
      omittedMemoryCount: 2,
    });
    expect(shrunk.workspaceMemory).toContain("currently empty");
    expect(shrunk.workspaceMemory).not.toContain("Hash-drifted content");
  }, 180_000);

  test("derives root and child containment and denies cross-session, cross-tenant, and direct runtime table access", async () => {
    if (!shared || !client) return;
    const f = await fixture({ child: true, mode: "retrieval_only" });
    const rootAttempt = await seedAttempt({
      accountId: f.grant.accountId,
      workspaceId: f.grant.workspaceId,
      sessionId: f.root.id,
      ownerSubjectId: f.ownerSubjectId,
    });
    const childAttempt = await seedAttempt({
      accountId: f.grant.accountId,
      workspaceId: f.grant.workspaceId,
      sessionId: f.child!.id,
      ownerSubjectId: f.ownerSubjectId,
    });
    await prepareSnapshots(rootAttempt);
    await prepareSnapshots(childAttempt);
    expect((await resolve(rootAttempt)).receipt).toMatchObject({
      rootSessionId: f.root.id,
      sessionRole: "root",
      companyProfileIncluded: true,
      selectedMemoryCount: 0,
    });
    expect((await resolve(childAttempt)).receipt).toMatchObject({
      rootSessionId: f.root.id,
      sessionRole: "child",
      companyProfileIncluded: false,
      selectedMemoryCount: 0,
    });
    expect((await resolve(childAttempt)).workspaceMemory).toBeNull();

    await expectSqlState(
      () =>
        resolveCompanyBrainContextSelection(client!.db, {
          ...claims(childAttempt),
          sessionId: f.root.id,
        }),
      "42501",
    );
    const other = await fixture();
    await expectSqlState(
      () =>
        resolveCompanyBrainContextSelection(client!.db, {
          ...claims(childAttempt),
          accountId: other.grant.accountId,
          workspaceId: other.grant.workspaceId,
        }),
      "42501",
    );

    const app = postgres(shared.appUrl, { max: 1, prepare: false });
    try {
      await expectSqlState(
        () =>
          app.begin(async (sql) => {
            await sql`select set_config('opengeni.account_id', ${f.grant.accountId}, true)`;
            await sql`select set_config('opengeni.workspace_id', ${f.grant.workspaceId}, true)`;
            await sql`select * from company_brain_context_selection_receipts limit 1`;
          }),
        "42501",
      );
      await expectSqlState(
        () =>
          app.begin(async (sql) => {
            await sql`select set_config('opengeni.account_id', ${f.grant.accountId}, true)`;
            await sql`select set_config('opengeni.workspace_id', ${f.grant.workspaceId}, true)`;
            await sql`delete from company_brain_context_selection_receipts where false`;
          }),
        "42501",
      );
    } finally {
      await app.end();
    }
  }, 180_000);

  test("caps deterministic candidate order and renders only whole entries inside the standing token budget", async () => {
    if (!shared || !client) return;
    const f = await fixture();
    const writes = Array.from({ length: 52 }, (_, index) =>
      saveWorkspaceMemory(client!.db, {
        accountId: f.grant.accountId,
        workspaceId: f.grant.workspaceId,
        text: `bounded-${String(index).padStart(2, "0")}-${"x".repeat(700)}`,
        kind: "semantic",
        pinned: index === 0,
      }),
    );
    await Promise.all(writes);
    const attempt = await seedAttempt({
      accountId: f.grant.accountId,
      workspaceId: f.grant.workspaceId,
      sessionId: f.root.id,
      ownerSubjectId: f.ownerSubjectId,
    });
    await prepareSnapshots(attempt);
    const selected = await resolve(attempt);
    expect(selected.receipt.selectedMemoryCount).toBe(50);
    expect(selected.receipt.visibleMemoryCount).toBe(50);
    expect(selected.workspaceMemory).toContain("bounded-00-");
    expect(selected.workspaceMemory!.indexOf("bounded-00-")).toBeLessThan(
      selected.workspaceMemory!.indexOf("bounded-51-"),
    );
    expect(selected.workspaceMemory).not.toContain("bounded-01-");
    expect(Buffer.byteLength(selected.workspaceMemory!, "utf8")).toBeLessThan(16_000);
    for (const renderedLine of selected
      .workspaceMemory!.split("\n")
      .filter((candidateLine) => candidateLine.startsWith("- ["))) {
      expect(renderedLine.endsWith("x".repeat(700))).toBe(true);
    }
  }, 180_000);
});
