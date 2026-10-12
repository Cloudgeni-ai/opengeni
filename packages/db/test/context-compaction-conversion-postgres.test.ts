import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { eq, sql } from "drizzle-orm";
import {
  appendSessionHistoryItems,
  applyContextCompaction,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  clearSessionContext,
  createDb,
  createSession,
  enqueueSessionTurn,
  getActiveSessionHistoryItems,
  requireWorkspace,
} from "../src/index";
import { withSessionActivityRlsContext } from "../src/database";
import { lockTurnAttemptWriteFenceTx } from "../src/session-attempt-fence";
import {
  readCompactionConversionSnapshot,
  finishCompactionConversion,
  type CompactionConversionAttempt,
  prepareCompactionConversion,
  compactionConversionRequestId,
  recordCompactionConversionChunk,
  readCompactionConversionChunks,
  type PreparedCompactionConversion,
  type CompactionConversionSnapshot,
} from "../src/context-compaction-conversion";
import * as schema from "../src/schema";
import {
  rebuildCompactionConversation,
  planCompactionConversionStep,
} from "../../runtime/src/compaction-conversion";
import { conversionChunkKey, conversionDigest, type ConversionCheckpoint } from "@opengeni/codex";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("context-compaction-conversion");
  if (!acquired) throw new Error("Real PostgreSQL is required");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

const message = (content: string) => ({ type: "message", role: "user", content });
const budget = { inputTokens: 10_000, outputTokens: 200, calls: 20, totalTokens: 200_000 };

async function planFor(input: CompactionConversionAttempt, before: CompactionConversionSnapshot) {
  const connectionId = crypto.randomUUID();
  await shared.admin`insert into subscription_connections(id, account_id, provider, kind, credential_encrypted, ownership, scope_kind,
    provider_account_id, provider_subject_id, label) values (${connectionId}, ${input.accountId}, 'codex', 'subscription', 'test-only', 'shared', 'organization', ${connectionId}, ${connectionId}, 'conversion test')`;
  return prepareCompactionConversion(
    before,
    { provider: "codex", modelId: "test/model", connectionId },
    budget,
  );
}

// Model I/O is not in E1. Seed only its retained nonsecret physical receipt as
// owner; every checkpoint/read/install below uses the restricted app role.
async function receipt(
  input: CompactionConversionAttempt,
  plan: PreparedCompactionConversion,
  key: string,
  outcome = "response_received",
  requestId = compactionConversionRequestId(plan, key),
  transportAttempt = 1,
) {
  const operationId = crypto.randomUUID();
  await shared.admin.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`insert into subscription_operation_leases(account_id,workspace_id,operation_id,attempt_id,operation_kind,session_id,turn_id,
      provider,connection_id,holder_id,generation,leased_until,request_id,transport_attempt,request_reserved_at,request_outcome,request_observed_at)
      values (${input.accountId},${input.workspaceId},${operationId},${input.attemptId},'model',${input.sessionId},${input.turnId},
        ${plan.target.provider},${plan.target.connectionId},'test-settled-request',${input.executionGeneration},now(),${requestId},${transportAttempt},now(),${outcome},now())`;
  });
  return operationId;
}

async function conversionResult(
  input: CompactionConversionAttempt,
  before: CompactionConversionSnapshot,
) {
  const { plan, checkpoint } = await preparedChunk(input, before);
  const operationId = await receipt(input, plan, checkpoint.key);
  expect(
    await recordCompactionConversionChunk(client.db, input, plan, checkpoint, operationId),
  ).toEqual({ recorded: true, duplicate: false });
  return {
    kind: "converted" as const,
    plan,
    rootKey: checkpoint.key,
    droppedWorkUnits: 0 as const,
  };
}

async function preparedChunk(
  input: CompactionConversionAttempt,
  before: CompactionConversionSnapshot,
  limits = budget,
) {
  const initial = await planFor(input, before);
  const plan = prepareCompactionConversion(before, initial.target, limits);
  const rebuilt = rebuildCompactionConversation(before);
  if (!rebuilt.rebuilt) throw new Error("rebuild failed");
  const step = planCompactionConversionStep({
    rebuilt,
    target: plan.target,
    budget: plan.budget,
    checkpoints: [],
    countTokens: (text) => text.length,
  });
  if (step.kind !== "request") throw new Error(`plan failed: ${JSON.stringify(step)}`);
  const checkpoint: ConversionCheckpoint = {
    ...step.chunk,
    summary: "portable summary",
    outputTokens: 16,
  };
  return { plan, checkpoint };
}

async function fixture(accountExternalId?: string): Promise<CompactionConversionAttempt> {
  const id = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: accountExternalId ?? id,
    accountName: "Conversion fixture",
    workspaceExternalSource: "test",
    workspaceExternalId: id,
    workspaceName: "Conversion fixture",
    subjectId: `test-${id}`,
  });
  const workspaceId = access.workspaceGrants[0]!.workspaceId!;
  const accountId = (await requireWorkspace(client.db, workspaceId)).accountId;
  const session = await createSession(client.db, {
    accountId,
    workspaceId,
    initialMessage: "original",
    model: "codex/gpt-5.6",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    resources: [],
    metadata: {},
    frozenCodexCompactionMode: "remote_v2",
  });
  const turn = await enqueueSessionTurn(client.db, {
    accountId,
    workspaceId,
    sessionId: session.id,
    triggerEventId: crypto.randomUUID(),
    temporalWorkflowId: `session-${session.id}`,
    source: "user",
    prompt: "original",
    resources: [],
    tools: [],
    model: "codex/gpt-5.6",
    reasoningEffort: "medium",
    sandboxBackend: "none",
    metadata: {},
    initiator: { kind: "service", subjectId: "service:conversion-test" },
  });
  const attemptId = crypto.randomUUID();
  const claim = await claimSessionWorkForAttempt(client.db, workspaceId, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    dispatchId: crypto.randomUUID(),
    attemptId,
    trigger: { kind: "next" },
  });
  if (claim.action !== "claimed") throw new Error(`Claim failed: ${claim.reason}`);
  return {
    accountId,
    workspaceId,
    sessionId: session.id,
    turnId: turn.id,
    attemptId,
    executionGeneration: claim.turn.executionGeneration,
  };
}

async function snapshot(input: CompactionConversionAttempt) {
  const read = await readCompactionConversionSnapshot(client.db, input);
  if (!read.available) throw new Error(`Snapshot unavailable: ${read.reason}`);
  return read.snapshot;
}

async function append(input: CompactionConversionAttempt, position: number, content: string) {
  expect(
    await appendSessionHistoryItems(client.db, {
      ...input,
      expectedExecutionGeneration: input.executionGeneration,
      expectedAttemptId: input.attemptId,
      items: [{ position, item: message(content) }],
    }),
  ).toBe(true);
}

test("SUB-FAIL-09 app role is non-owner, non-superuser and cannot bypass RLS", async () => {
  const result = await client.db
    .execute(sql`select r.rolsuper, r.rolbypassrls, c.relowner = r.oid as owner
    from pg_roles r, pg_class c where r.rolname = current_user and c.oid = 'sessions'::regclass`);
  expect(result[0]).toMatchObject({ rolsuper: false, rolbypassrls: false, owner: false });
});

test("SUB-FAIL-09 real writer snapshot reconstructs and installs mode/history/event atomically once", async () => {
  const input = await fixture();
  const first = await snapshot(input);
  await append(input, first.boundary.maxPosition + 1, "retained");
  const applied = await applyContextCompaction(client.db, {
    ...input,
    expectedExecutionGeneration: input.executionGeneration,
    expectedAttemptId: input.attemptId,
    replacementItems: [message("retained")],
    summaryItem: { type: "compaction", encrypted_content: "test-opaque" },
    eventPayload: { implementation: "responses_compaction_v2" },
  });
  expect(applied.applied).toBe(true);
  const before = await snapshot(input);
  const originalRows =
    await shared.admin`select to_jsonb(h)-'active' as row from session_history_items h where session_id=${input.sessionId} order by position`;
  const originalEvents =
    await shared.admin`select to_jsonb(e) as row from session_events e where session_id=${input.sessionId} order by sequence`;
  const rebuilt = rebuildCompactionConversation(before);
  expect(rebuilt.rebuilt).toBe(true);
  const converted = await conversionResult(input, before);
  const result = await finishCompactionConversion(client.db, input, before, converted);
  expect(result.applied).toBe(true);
  if (!result.applied) return;
  expect(result.event.payload).toMatchObject({
    conversion: "remote_to_portable",
    droppedWorkUnits: 0,
    blockLength: 1,
  });
  const [session] =
    await shared.admin`select codex_compaction_mode, last_input_tokens, compact_requested from sessions where id=${input.sessionId}`;
  expect(session).toMatchObject({
    codex_compaction_mode: "portable",
    last_input_tokens: null,
    compact_requested: false,
  });
  expect(
    (await getActiveSessionHistoryItems(client.db, input.workspaceId, input.sessionId)).map(
      (r) => r.item,
    ),
  ).toEqual([
    {
      type: "message",
      role: "assistant",
      content: "portable summary",
      opengeni_context_summary: true,
    },
  ]);
  expect(await finishCompactionConversion(client.db, input, before, converted)).toEqual(result);
  const [count] =
    await shared.admin`select count(*)::int as count from session_events where session_id=${input.sessionId} and payload->>'conversion'='remote_to_portable'`;
  expect(count!.count).toBe(1);
  expect(
    Array.from(
      await shared.admin`select to_jsonb(h)-'active' as row from session_history_items h where session_id=${input.sessionId} and position<=${before.boundary.maxPosition} order by position`,
    ),
  ).toEqual(Array.from(originalRows));
  expect(
    Array.from(
      await shared.admin`select to_jsonb(e) as row from session_events e where session_id=${input.sessionId} and id<>${result.event.id} order by sequence`,
    ),
  ).toEqual(Array.from(originalEvents));
  expect(await readCompactionConversionSnapshot(client.db, input)).toEqual({
    available: false,
    reason: "not_remote",
  });
}, 30_000);

test("SUB-FAIL-09 event failure rolls back history and mode together", async () => {
  const input = await fixture();
  const before = await snapshot(input);
  const converted = await conversionResult(input, before);
  // A real event-write failure occurs after history/mode writes. All three
  // must share the transaction, not merely return a single logical result.
  await shared.admin`create function test_conversion_event_fault() returns trigger language plpgsql as
    'begin raise exception ''conversion event fault''; end'`;
  await shared.admin
    .unsafe(`create trigger test_conversion_event_fault before insert on session_events
    for each row when (new.session_id = '${input.sessionId}'::uuid and new.type = 'session.context.compacted')
    execute function test_conversion_event_fault()`);
  try {
    await expect(finishCompactionConversion(client.db, input, before, converted)).rejects.toThrow();
  } finally {
    await shared.admin`drop trigger test_conversion_event_fault on session_events`;
    await shared.admin`drop function test_conversion_event_fault()`;
  }
  expect(await snapshot(input)).toEqual(before);
}, 30_000);

test("SUB-FAIL-09 budget exhaustion cannot install a summary that dropped original work", async () => {
  const input = await fixture();
  const before = await snapshot(input);
  const converted = await conversionResult(input, before);
  await expect(
    finishCompactionConversion(client.db, input, before, {
      ...converted,
      droppedWorkUnits: 1 as 0,
    }),
  ).rejects.toThrow("conversion_unsummarized_units");
  expect(await snapshot(input)).toEqual(before);
}, 30_000);

test("SUB-FAIL-09 every snapshot boundary component is independently fenced", async () => {
  const input = await fixture();
  const before = await snapshot(input);
  const converted = await conversionResult(input, before);
  for (const boundary of [
    { ...before.boundary, maxPosition: before.boundary.maxPosition + 1 },
    { ...before.boundary, rowCount: before.boundary.rowCount + 1 },
    { ...before.boundary, lastClearPosition: 100 },
    { ...before.boundary, lastCompactionId: crypto.randomUUID() },
  ]) {
    expect(
      await finishCompactionConversion(client.db, input, { ...before, boundary }, converted),
    ).toEqual({ applied: false, reason: "history_changed" });
  }
}, 30_000);

test("SUB-FAIL-09 a concurrent clear wins its workspace/history fence and invalidates the attempt", async () => {
  const input = await fixture();
  const before = await snapshot(input);
  const converted = await conversionResult(input, before);
  let install: ReturnType<typeof finishCompactionConversion>;
  await withSessionActivityRlsContext(client.db, input, async (tx) => {
    // clearSessionContext requires quiescent session state and the exclusive
    // workspace prefix. Arrange that state in this isolated fixture, not by
    // weakening the live clear API to operate during a running attempt.
    await tx
      .select()
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, input.workspaceId))
      .for("update");
    await tx
      .update(schema.sessions)
      .set({ activeTurnId: null, status: "idle" })
      .where(eq(schema.sessions.id, input.sessionId));
    install = finishCompactionConversion(client.db, input, before, converted);
    for (let tries = 0; ; tries++) {
      const [waiting] =
        await shared.admin`select count(*)::int as count from pg_stat_activity where datname=current_database() and wait_event_type='Lock'`;
      if (waiting!.count > 0) break;
      if (tries > 200) throw new Error("install did not wait on clear fence");
      await Bun.sleep(10);
    }
    await clearSessionContext(tx, input);
  });
  expect(await install!).toEqual({ applied: false, reason: "active_turn_changed" });
  expect(
    (await getActiveSessionHistoryItems(client.db, input.workspaceId, input.sessionId)).map(
      (r) => r.item,
    ),
  ).toEqual([message("[context cleared]")]);
}, 30_000);

test("SUB-FAIL-09 stale generation, wrong attempt and foreign workspace cannot read or install", async () => {
  const input = await fixture();
  const before = await snapshot(input);
  const converted = await conversionResult(input, before);
  const foreign = await fixture();
  for (const bad of [
    { ...input, executionGeneration: input.executionGeneration + 1 },
    { ...input, attemptId: crypto.randomUUID() },
    { ...input, workspaceId: foreign.workspaceId, accountId: foreign.accountId },
  ]) {
    expect((await readCompactionConversionSnapshot(client.db, bad)).available).toBe(false);
    expect((await finishCompactionConversion(client.db, bad, before, converted)).applied).toBe(
      false,
    );
  }
  expect(await finishCompactionConversion(client.db, foreign, before, converted)).toEqual({
    applied: false,
    reason: "history_changed",
  });
  expect(await snapshot(input)).toEqual(before);
}, 30_000);

test("SUB-FAIL-09 refusal is durable, leaves history/mode untouched, and blocks conversion", async () => {
  const input = await fixture();
  const before = await snapshot(input);
  const converted = await conversionResult(input, before);
  const result = await finishCompactionConversion(client.db, input, before, {
    kind: "refused",
    reason: "missing_event",
  });
  expect(result.applied).toBe(true);
  expect(await readCompactionConversionSnapshot(client.db, input)).toEqual({
    available: false,
    reason: "conversion_refused",
  });
  expect(await finishCompactionConversion(client.db, input, before, converted)).toEqual({
    applied: false,
    reason: "conversion_refused",
  });
  const [session] =
    await shared.admin`select codex_compaction_mode, compaction_conversion_refused_at from sessions where id=${input.sessionId}`;
  expect(session!.codex_compaction_mode).toBe("remote_v2");
  expect(session!.compaction_conversion_refused_at).not.toBeNull();
  expect(
    (await getActiveSessionHistoryItems(client.db, input.workspaceId, input.sessionId)).length,
  ).toBe(before.rows.length);
}, 30_000);

test("SUB-FAIL-09 archived sessions are refused", async () => {
  const input = await fixture();
  const before = await snapshot(input);
  const converted = await conversionResult(input, before);
  await shared.admin`update sessions set content_archive_state='archived', content_archive_started_at=now(), content_archived_at=now(), content_archive='{"sha256":"test"}' where id=${input.sessionId}`;
  expect(await readCompactionConversionSnapshot(client.db, input)).toEqual({
    available: false,
    reason: "archived",
  });
  expect(await finishCompactionConversion(client.db, input, before, converted)).toEqual({
    applied: false,
    reason: "archived",
  });
}, 30_000);

test("SUB-FAIL-09 append and compaction after snapshot invalidate installation", async () => {
  for (const change of ["append", "compaction"] as const) {
    const input = await fixture();
    const before = await snapshot(input);
    const converted = await conversionResult(input, before);
    if (change === "append") await append(input, before.boundary.maxPosition + 1, "new");
    else
      await applyContextCompaction(client.db, {
        ...input,
        expectedExecutionGeneration: input.executionGeneration,
        expectedAttemptId: input.attemptId,
        replacementItems: [],
        summaryItem: { type: "compaction", encrypted_content: "new" },
        eventPayload: { implementation: "responses_compaction_v2" },
      });
    expect(await finishCompactionConversion(client.db, input, before, converted)).toEqual({
      applied: false,
      reason: "history_changed",
    });
  }
}, 30_000);

test("SUB-FAIL-09 concurrent append is serialized by the history write fence", async () => {
  const input = await fixture();
  const before = await snapshot(input);
  const converted = await conversionResult(input, before);
  let install: ReturnType<typeof finishCompactionConversion>;
  await withSessionActivityRlsContext(client.db, input, async (tx) => {
    expect((await lockTurnAttemptWriteFenceTx(tx, input)).allowed).toBe(true);
    install = finishCompactionConversion(client.db, input, before, converted);
    // Wait for actual lock contention, not a timing assumption.
    for (let tries = 0; ; tries++) {
      const [waiting] =
        await shared.admin`select count(*)::int as count from pg_stat_activity where datname=current_database() and wait_event_type='Lock'`;
      if (waiting!.count > 0) break;
      if (tries > 200) throw new Error("install did not wait on history fence");
      await Bun.sleep(10);
    }
    await appendSessionHistoryItems(tx, {
      ...input,
      expectedExecutionGeneration: input.executionGeneration,
      expectedAttemptId: input.attemptId,
      items: [{ position: before.boundary.maxPosition + 1, item: message("concurrent append") }],
    });
    await tx
      .update(schema.sessions)
      .set({ lastInputTokens: 123 })
      .where(eq(schema.sessions.id, input.sessionId));
  });
  expect(await install!).toEqual({ applied: false, reason: "history_changed" });
}, 30_000);

test("SUB-FAIL-09 settled-request crash window blocks replay until its exact checkpoint is recovered", async () => {
  const input = await fixture();
  const before = await snapshot(input);
  const { plan, checkpoint } = await preparedChunk(input, before);
  expect(await readCompactionConversionChunks(client.db, input, plan)).toEqual({
    available: true,
    checkpoints: [],
  });
  const operation = await receipt(input, plan, checkpoint.key);
  expect(await readCompactionConversionChunks(client.db, input, plan)).toEqual({
    available: false,
    reason: "request_unsettled",
  });
  for (const alternate of [
    prepareCompactionConversion(before, { ...plan.target, modelId: "other/model" }, plan.budget),
    prepareCompactionConversion(before, plan.target, {
      ...plan.budget,
      calls: plan.budget.calls + 1,
    }),
  ])
    expect(await readCompactionConversionChunks(client.db, input, alternate)).toEqual({
      available: false,
      reason: "request_unsettled",
    });
  expect(await snapshot(input)).toEqual(before);
  const results = await Promise.all(
    [1, 2].map(() =>
      recordCompactionConversionChunk(client.db, input, plan, checkpoint, operation),
    ),
  );
  expect(results).toContainEqual({ recorded: true, duplicate: false });
  expect(results).toContainEqual({ recorded: true, duplicate: true });
  expect(await readCompactionConversionChunks(client.db, input, plan)).toEqual({
    available: true,
    checkpoints: [checkpoint],
  });
  expect(
    await recordCompactionConversionChunk(
      client.db,
      input,
      plan,
      { ...checkpoint, summary: "conflicting summary" },
      operation,
    ),
  ).toEqual({ recorded: false, reason: "checkpoint_conflict" });
  expect(
    await recordCompactionConversionChunk(client.db, input, plan, checkpoint, crypto.randomUUID()),
  ).toEqual({ recorded: false, reason: "checkpoint_conflict" });
}, 30_000);

test("SUB-FAIL-09 missing, unknown, wrong-target and duplicate physical receipts fail closed", async () => {
  for (const wrong of [
    "missing",
    "outcome_unknown",
    "reserved",
    "refused",
    "request",
    "provider",
    "model",
    "account",
    "generation",
    "duplicate",
  ] as const) {
    const input = await fixture();
    const before = await snapshot(input);
    const { plan, checkpoint } = await preparedChunk(input, before);
    let operation = crypto.randomUUID();
    if (wrong !== "missing") {
      operation = await receipt(
        wrong === "generation"
          ? { ...input, executionGeneration: input.executionGeneration + 1 }
          : input,
        plan,
        checkpoint.key,
        wrong === "outcome_unknown"
          ? "unknown"
          : wrong === "reserved" || wrong === "refused"
            ? wrong
            : "response_received",
        wrong === "request"
          ? "unrelated-request"
          : compactionConversionRequestId(plan, checkpoint.key),
      );
      if (wrong === "duplicate")
        await receipt(
          input,
          plan,
          checkpoint.key,
          "response_received",
          compactionConversionRequestId(plan, checkpoint.key),
          2,
        );
    }
    const checkedPlan =
      wrong === "model"
        ? { ...plan, target: { ...plan.target, modelId: "other/model" } }
        : wrong === "provider"
          ? { ...plan, target: { ...plan.target, provider: "other" } }
          : plan;
    const checkedInput = wrong === "account" ? { ...input, accountId: crypto.randomUUID() } : input;
    if (wrong === "account") {
      // A foreign account hides the mandatory control row before the typed
      // fence can return a result; this is an RLS refusal, not missing data.
      await expect(
        recordCompactionConversionChunk(
          client.db,
          checkedInput,
          checkedPlan,
          checkpoint,
          operation,
        ),
      ).rejects.toThrow("mandatory inference-control row");
      expect(await snapshot(input)).toEqual(before);
      continue;
    }
    expect(
      (
        await recordCompactionConversionChunk(
          client.db,
          checkedInput,
          checkedPlan,
          checkpoint,
          operation,
        )
      ).recorded,
    ).toBe(false);
    expect(await snapshot(input)).toEqual(before);
  }
}, 30_000);

test("SUB-FAIL-09 database independently rejects malicious coverage, input and summary budgets", async () => {
  const input = await fixture();
  await append(
    input,
    (await snapshot(input)).boundary.maxPosition + 1,
    "retained work ".repeat(30),
  );
  const before = await snapshot(input);
  const { plan, checkpoint } = await preparedChunk(input, before);
  for (const changed of [
    { coverage: [] },
    { coverage: ["foreign-row"] },
    { coverage: [...checkpoint.coverage, ...checkpoint.coverage] },
    { inputDigest: conversionDigest("different input") },
    { children: ["missing-child"] },
    { summary: "" },
    { outputTokens: plan.budget.outputTokens + 1 },
    { outputTokens: checkpoint.inputTokens },
    { inputTokens: plan.budget.inputTokens + 1 },
  ]) {
    const bad = { ...checkpoint, ...changed };
    bad.key = conversionChunkKey(plan.manifest, plan.target, plan.budget, bad);
    expect(
      await recordCompactionConversionChunk(client.db, input, plan, bad, crypto.randomUUID()),
    ).toEqual({ recorded: false, reason: "coverage_invalid" });
  }
  const bounded = prepareCompactionConversion(before, plan.target, { ...budget, totalTokens: 1 });
  // Planner refuses before dispatch; a forged caller cannot bypass the DB budget.
  const overBudget = {
    ...checkpoint,
    key: conversionChunkKey(bounded.manifest, bounded.target, bounded.budget, checkpoint),
  };
  const operation = await receipt(input, bounded, overBudget.key);
  expect(
    await recordCompactionConversionChunk(client.db, input, bounded, overBudget, operation),
  ).toEqual({ recorded: false, reason: "conversion_budget_exhausted" });
}, 30_000);

test("SUB-FAIL-09 stale source and accepted authority invalidate checkpoints before mutation", async () => {
  for (const change of ["history", "authority"] as const) {
    const input = await fixture();
    const before = await snapshot(input);
    const { plan, checkpoint } = await preparedChunk(input, before);
    const operation = await receipt(input, plan, checkpoint.key);
    if (change === "history")
      await append(input, before.boundary.maxPosition + 1, "new retained work");
    else
      await shared.admin`update session_turns set metadata=metadata || '{"newAuthorityFact":true}'::jsonb where id=${input.turnId}`;
    expect(
      await recordCompactionConversionChunk(client.db, input, plan, checkpoint, operation),
    ).toEqual({ recorded: false, reason: "history_changed" });
    expect(await readCompactionConversionChunks(client.db, input, plan)).toEqual({
      available: false,
      reason: "history_changed",
    });
  }
}, 30_000);

test("SUB-FAIL-09 FORCE-RLS checkpoints reject cross-workspace direct writes and cannot be updated", async () => {
  // The harness normally provisions from runtime-posture after migration. Also
  // exercise the actual rolling migration grant, as an already deployed role
  // receives it, so reprovisioning cannot mask an over-broad migration grant.
  const migration = await Bun.file(
    new URL("../drizzle/0734_compaction_conversion_refusal.sql", import.meta.url),
  ).text();
  const grant = migration.match(
    /GRANT [A-Z, ]+ ON %I\.session_compaction_conversion_chunks TO opengeni_app/,
  )?.[0];
  if (!grant) throw new Error("missing conversion grant");
  const [app] = await client.db.execute<{ role: string }>(sql`select current_user as role`);
  const [statement] =
    await shared.admin`select format(${grant.replace("TO opengeni_app", "TO %I")}, current_schema(), ${app!.role}::text) as statement`;
  await shared.admin.unsafe(statement!.statement as string);
  const organization = crypto.randomUUID();
  const input = await fixture(organization);
  const before = await snapshot(input);
  const { plan, checkpoint } = await preparedChunk(input, before);
  const operation = await receipt(input, plan, checkpoint.key);
  expect(
    (await recordCompactionConversionChunk(client.db, input, plan, checkpoint, operation)).recorded,
  ).toBe(true);
  const foreign = await fixture(organization);
  expect(foreign.accountId).toBe(input.accountId);
  const [posture] =
    await shared.admin`select relrowsecurity, relforcerowsecurity from pg_class where oid='session_compaction_conversion_chunks'::regclass`;
  expect(posture).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
  await withSessionActivityRlsContext(client.db, foreign, async (tx) => {
    expect(
      await tx.execute(
        sql`select * from session_compaction_conversion_chunks where session_id=${input.sessionId}::uuid`,
      ),
    ).toHaveLength(0);
  });
  const insert = (scope: CompactionConversionAttempt) =>
    withSessionActivityRlsContext(client.db, scope, async (tx) => {
      await tx.execute(sql`insert into session_compaction_conversion_chunks(account_id,workspace_id,session_id,turn_id,attempt_id,generation,
      snapshot_id,source_digest,chunk_key,operation_id,target_provider,target_model,target_connection_id,checkpoint)
      values (${input.accountId}::uuid,${input.workspaceId}::uuid,${input.sessionId}::uuid,${input.turnId}::uuid,${input.attemptId}::uuid,${input.executionGeneration},
      ${plan.snapshotId},${plan.snapshot.boundary.contentDigest},${checkpoint.key},${operation}::uuid,${plan.target.provider},${plan.target.modelId},${plan.target.connectionId}::uuid,${JSON.stringify(checkpoint)}::jsonb)`);
    });
  await expect(insert(foreign)).rejects.toThrow();
  await expect(
    withSessionActivityRlsContext(client.db, input, (tx) =>
      tx.execute(sql`update session_compaction_conversion_chunks set checkpoint='{}'::jsonb`),
    ),
  ).rejects.toThrow();
  await expect(
    withSessionActivityRlsContext(client.db, input, (tx) =>
      tx.execute(sql`delete from session_compaction_conversion_chunks`),
    ),
  ).rejects.toThrow();
}, 30_000);

test("SUB-FAIL-09 incomplete roots and unaccounted outcomes never install or hide retained work", async () => {
  const input = await fixture();
  await append(
    input,
    (await snapshot(input)).boundary.maxPosition + 1,
    "additional work ".repeat(20),
  );
  const before = await snapshot(input);
  const { plan, checkpoint } = await preparedChunk(input, before, {
    ...budget,
    inputTokens: 400,
    outputTokens: 50,
  });
  expect(checkpoint.coverage.length).toBeLessThan(plan.manifest.rows.length);
  const operation = await receipt(input, plan, checkpoint.key);
  expect(
    (await recordCompactionConversionChunk(client.db, input, plan, checkpoint, operation)).recorded,
  ).toBe(true);
  expect(
    await finishCompactionConversion(client.db, input, before, {
      kind: "converted",
      plan,
      rootKey: checkpoint.key,
      droppedWorkUnits: 0,
    }),
  ).toEqual({ applied: false, reason: "coverage_invalid" });
  const other = await fixture();
  const old = await snapshot(other);
  const converted = await conversionResult(other, old);
  await receipt(other, converted.plan, "unaccounted", "unknown");
  expect(await finishCompactionConversion(client.db, other, old, converted)).toEqual({
    applied: false,
    reason: "request_unsettled",
  });
  expect(await readCompactionConversionChunks(client.db, other, converted.plan)).toEqual({
    available: false,
    reason: "request_unsettled",
  });
  expect(await snapshot(other)).toEqual(old);
  expect(await snapshot(input)).toEqual(before);
}, 30_000);

test("SUB-FAIL-09 complete reduction graph persists once without duplicate leaf or child consumption", async () => {
  const input = await fixture();
  const first = await snapshot(input);
  for (let i = 0; i < 12; i++)
    await append(input, first.boundary.maxPosition + 1 + i, `${i} ${"source ".repeat(14)}`);
  const before = await snapshot(input);
  const initial = await planFor(input, before);
  const plan = prepareCompactionConversion(before, initial.target, {
    inputTokens: 180,
    outputTokens: 32,
    calls: 30,
    totalTokens: 10_000,
  });
  const rebuilt = rebuildCompactionConversation(before);
  if (!rebuilt.rebuilt) throw new Error("missing source");
  let reductions = 0;
  for (let i = 0; i < 30; i++) {
    const saved = await readCompactionConversionChunks(client.db, input, plan);
    if (!saved.available) throw new Error(saved.reason);
    const step = planCompactionConversionStep({
      rebuilt,
      target: plan.target,
      budget: plan.budget,
      checkpoints: saved.checkpoints,
      countTokens: (text) => text.length,
    });
    if (step.kind === "complete") {
      expect(reductions).toBeGreaterThan(1);
      expect(step.checkpoint.coverage).toEqual(before.rows.map((row) => row.id));
      expect(
        (
          await finishCompactionConversion(client.db, input, before, {
            kind: "converted",
            plan,
            rootKey: step.checkpoint.key,
            droppedWorkUnits: 0,
          })
        ).applied,
      ).toBe(true);
      return;
    }
    if (step.kind !== "request") throw new Error(JSON.stringify(step));
    if (step.chunk.children.length) reductions++;
    const checkpoint = { ...step.chunk, summary: "portable summary", outputTokens: 16 };
    const operation = await receipt(input, plan, checkpoint.key);
    expect(
      (await recordCompactionConversionChunk(client.db, input, plan, checkpoint, operation))
        .recorded,
    ).toBe(true);
    const overlapping = { ...checkpoint, inputTokens: checkpoint.inputTokens + 1 };
    overlapping.key = conversionChunkKey(plan.manifest, plan.target, plan.budget, overlapping);
    expect(
      await recordCompactionConversionChunk(
        client.db,
        input,
        plan,
        overlapping,
        crypto.randomUUID(),
      ),
    ).toEqual({ recorded: false, reason: "coverage_invalid" });
  }
  throw new Error("reduction did not converge");
}, 30_000);
