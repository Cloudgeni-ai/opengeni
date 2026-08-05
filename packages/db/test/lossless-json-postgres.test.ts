import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { and, asc, eq } from "drizzle-orm";
import {
  appendSessionEvents,
  appendSessionHistoryItems,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  initializeSessionStartAtomically,
  listSessionEventPage,
  recordPendingSessionToolCallResult,
  registerPendingSessionToolCall,
  saveWorkspaceMemory,
  searchWorkspaceMemories,
  withWorkspaceRls,
  type Database,
} from "../src/index";
import { LEGACY_LOSSLESS_JSON_ENVELOPE_KEY } from "../src/lossless-json";
import * as schema from "../src/schema";
import { closePendingSessionToolCallsInTransaction } from "../src/session-tool-call-settlement";

const migrationUrl = new URL("../drizzle/0176_lossless_canonical_json.sql", import.meta.url);
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let shared: SharedTestDatabase | null = null;
let app: ReturnType<typeof createDb> | null = null;

setDefaultTimeout(60_000);

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("lossless-canonical-json");
  if (!shared) {
    if (requireRealDatabase) {
      throw new Error("OPENGENI_REQUIRE_REAL_DB=1 but the PostgreSQL harness is unavailable");
    }
    return;
  }
  app = createDb(shared.appUrl, { max: 8 });
}, 180_000);

afterAll(async () => {
  await app?.close();
  await shared?.release();
}, 60_000);

describe("lossless canonical JSON PostgreSQL boundary", () => {
  test("migration removes write-time projection and size constraints", async () => {
    const source = await readFile(migrationUrl, "utf8");
    expect(source.startsWith("-- deployment-mode: rolling\n")).toBeTrue();
    expect(source).toContain(
      "DROP TRIGGER IF EXISTS session_events_bound_payload_before_insert ON session_events",
    );
    expect(source).toContain("DROP CONSTRAINT IF EXISTS session_events_payload_bytes_check");
    expect(source).toContain("session_realtime_entries_text_check");
    expect(source).toContain("session_realtime_entries_payload_check");
    expect(source).toContain(
      "CREATE OR REPLACE FUNCTION opengeni_private.project_session_event_payload",
    );
    expect(source).toContain("'fullPayload', 'request payloadMode=full explicitly'");
    expect(source).not.toContain("'available', false");
    expect(source).not.toContain("UPDATE session_events");
    expect(source).not.toContain("UPDATE session_history_items");
  });

  test("round-trips exact internal content through the app role and FORCE RLS", async () => {
    if (!shared || !app) return;
    const suffix = crypto.randomUUID();
    const access = await bootstrapWorkspace(app.db, {
      accountExternalSource: "lossless-json-test",
      accountExternalId: `account-${suffix}`,
      accountName: "Lossless PostgreSQL boundary",
      workspaceExternalSource: "lossless-json-test",
      workspaceExternalId: `workspace-${suffix}`,
      workspaceName: "Lossless PostgreSQL boundary",
      subjectId: `subject-${suffix}`,
    });
    const grant = access.workspaceGrants[0]!;
    const workspaceId = grant.workspaceId!;
    const nul = String.fromCharCode(0);
    const loneHigh = String.fromCharCode(0xd800);
    const loneLow = String.fromCharCode(0xdc00);
    const unsafeText = `before${nul}middle${loneHigh}low${loneLow}after`;
    const exactCommand = 'stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")';
    const initialMessage = `run exactly: ${exactCommand}\n${unsafeText}`;

    const [rolePosture] = await shared.admin<
      Array<{ bypassRls: boolean; forceRls: boolean; roleName: string }>
    >`
      select role.rolbypassrls as "bypassRls",
             class.relforcerowsecurity as "forceRls",
             role.rolname as "roleName"
      from pg_roles role
      cross join pg_class class
      where role.rolname = 'opengeni_app' and class.oid = 'sessions'::regclass`;
    expect(rolePosture).toEqual({ bypassRls: false, forceRls: true, roleName: "opengeni_app" });

    const session = await createSession(app.db, {
      accountId: grant.accountId,
      workspaceId,
      initialMessage,
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    expect(session.initialMessage).toBe(initialMessage);

    const started = await initializeSessionStartAtomically(app.db, {
      accountId: grant.accountId,
      workspaceId,
      sessionId: session.id,
      reasoningEffortFallback: "low",
      createdEventPayload: { exactCommand },
    });
    if (!started.turn) throw new Error("canonical session bootstrap did not create a turn");
    const attemptId = crypto.randomUUID();
    const claim = await claimSessionWorkForAttempt(app.db, workspaceId, {
      sessionId: session.id,
      workflowId: `session-${session.id}`,
      workflowRunId: crypto.randomUUID(),
      dispatchId: `dispatch-${crypto.randomUUID()}`,
      attemptId,
      trigger: { kind: "next" },
    });
    if (claim.action !== "claimed") {
      throw new Error(`canonical session turn was not claimable: ${claim.reason}`);
    }
    const turn = claim.turn;
    expect(turn.prompt).toBe(initialMessage);

    const queryablePayload = {
      id: "synthetic-call-id",
      updateId: "synthetic-update-id",
      sourceKey: "synthetic-source-key",
      recordingId: "synthetic-recording-id",
      code: "synthetic_code",
      type: "agent.toolCall.output",
      exactCommand,
      nested: { source: unsafeText },
    };
    const largePayload = {
      type: "agent.message.completed",
      id: "large-synthetic-event",
      body: "y".repeat(100 * 1024),
    };
    const appended = await appendSessionEvents(app.db, workspaceId, session.id, [
      {
        type: "agent.toolCall.output",
        payload: queryablePayload,
        turnId: turn.id,
        turnGeneration: turn.executionGeneration,
        turnAttemptId: attemptId,
      },
      {
        type: "agent.message.completed",
        payload: largePayload,
        turnId: turn.id,
        turnGeneration: turn.executionGeneration,
        turnAttemptId: attemptId,
      },
    ]);
    expect(appended[0]?.payload).toEqual(queryablePayload);
    expect(appended[1]?.payload).toEqual(largePayload);

    const [rawEvent] = await shared.admin<
      Array<{
        id: string | null;
        updateId: string | null;
        sourceKey: string | null;
        recordingId: string | null;
        code: string | null;
        type: string | null;
      }>
    >`
      select payload ->> 'id' as id,
             payload ->> 'updateId' as "updateId",
             payload ->> 'sourceKey' as "sourceKey",
             payload ->> 'recordingId' as "recordingId",
             payload ->> 'code' as code,
             payload ->> 'type' as type
      from session_events where id = ${appended[0]!.id}`;
    expect(rawEvent).toEqual({
      id: queryablePayload.id,
      updateId: queryablePayload.updateId,
      sourceKey: queryablePayload.sourceKey,
      recordingId: queryablePayload.recordingId,
      code: queryablePayload.code,
      type: queryablePayload.type,
    });

    const [largeRaw] = await shared.admin<Array<{ bytes: number }>>`
      select octet_length(payload::text)::integer as bytes
      from session_events where id = ${appended[1]!.id}`;
    expect(largeRaw!.bytes).toBeGreaterThan(96 * 1024);
    const fullPage = await listSessionEventPage(app.db, workspaceId, session.id, {
      payloadMode: "full",
      maxBytes: 256 * 1024,
    });
    expect(fullPage.events.find((event) => event.id === appended[1]!.id)?.payload).toEqual(
      largePayload,
    );

    const historyItem = {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: `${exactCommand}\n${unsafeText}` }],
    };
    const [initialHistory] = await withWorkspaceRls(app.db, workspaceId, (db) =>
      db
        .select({ item: schema.sessionHistoryItems.item })
        .from(schema.sessionHistoryItems)
        .where(
          and(
            eq(schema.sessionHistoryItems.sessionId, session.id),
            eq(schema.sessionHistoryItems.position, 0),
          ),
        ),
    );
    expect(initialHistory!.item).toEqual({
      type: "message",
      role: "user",
      content: initialMessage,
    });
    expect(
      await appendSessionHistoryItems(app.db, {
        accountId: grant.accountId,
        workspaceId,
        sessionId: session.id,
        turnId: turn.id,
        expectedExecutionGeneration: turn.executionGeneration,
        expectedAttemptId: attemptId,
        items: [{ position: 1, item: historyItem }],
      }),
    ).toBeTrue();
    const [history] = await withWorkspaceRls(app.db, workspaceId, (db) =>
      db
        .select({ item: schema.sessionHistoryItems.item })
        .from(schema.sessionHistoryItems)
        .where(
          and(
            eq(schema.sessionHistoryItems.sessionId, session.id),
            eq(schema.sessionHistoryItems.position, 1),
          ),
        ),
    );
    expect(history!.item).toEqual(historyItem);
    const [rawHistory] = await shared.admin<Array<{ type: string | null }>>`
      select item ->> 'type' as type from session_history_items
      where workspace_id = ${workspaceId} and session_id = ${session.id} and position = 1`;
    expect(rawHistory).toEqual({ type: "message" });

    const callId = "pending-synthetic-call";
    const callItem = {
      type: "function_call",
      callId,
      name: "synthetic_tool",
      arguments: `${exactCommand}\n${unsafeText}`,
    };
    const resultItem = {
      type: "function_call_result",
      callId,
      output: { type: "text", text: unsafeText },
    };
    expect(
      await registerPendingSessionToolCall(app.db, {
        accountId: grant.accountId,
        workspaceId,
        sessionId: session.id,
        turnId: turn.id,
        executionGeneration: turn.executionGeneration,
        attemptId,
        callId,
        callType: "function_call",
        callItem,
      }),
    ).toEqual({ accepted: true, registered: true });
    expect(
      await recordPendingSessionToolCallResult(app.db, {
        accountId: grant.accountId,
        workspaceId,
        sessionId: session.id,
        turnId: turn.id,
        executionGeneration: turn.executionGeneration,
        attemptId,
        callId,
        resultItem,
      }),
    ).toEqual({ accepted: true, recorded: true });
    const [pending] = await withWorkspaceRls(app.db, workspaceId, (db) =>
      db
        .select({
          callItem: schema.sessionPendingToolCalls.callItem,
          resultItem: schema.sessionPendingToolCalls.resultItem,
        })
        .from(schema.sessionPendingToolCalls)
        .where(eq(schema.sessionPendingToolCalls.callId, callId)),
    );
    expect(pending).toEqual({ callItem, resultItem });
    const [rawPending] = await shared.admin<
      Array<{ callType: string | null; resultType: string | null }>
    >`
      select call_item ->> 'type' as "callType", result_item ->> 'type' as "resultType"
      from session_pending_tool_calls where call_id = ${callId}`;
    expect(rawPending).toEqual({
      callType: "function_call",
      resultType: "function_call_result",
    });

    const settled = await withWorkspaceRls(app.db, workspaceId, (db) =>
      db.transaction(async (tx) => {
        const [lockedSession] = await tx
          .select({ lastSequence: schema.sessions.lastSequence })
          .from(schema.sessions)
          .where(eq(schema.sessions.id, session.id))
          .for("update");
        const result = await closePendingSessionToolCallsInTransaction(tx as unknown as Database, {
          accountId: grant.accountId,
          workspaceId,
          sessionId: session.id,
          turnId: turn.id,
          reason: "synthetic settlement",
          sequence: lockedSession!.lastSequence,
          now: new Date(),
        });
        await tx
          .update(schema.sessions)
          .set({ lastSequence: result.sequence })
          .where(eq(schema.sessions.id, session.id));
        return result;
      }),
    );
    expect(settled.closed).toBe(1);
    const settledHistory = await withWorkspaceRls(app.db, workspaceId, (db) =>
      db
        .select({ item: schema.sessionHistoryItems.item })
        .from(schema.sessionHistoryItems)
        .where(eq(schema.sessionHistoryItems.turnId, turn.id))
        .orderBy(asc(schema.sessionHistoryItems.position)),
    );
    expect(settledHistory.map((entry) => entry.item)).toContainEqual(callItem);
    expect(settledHistory.map((entry) => entry.item)).toContainEqual(resultItem);

    const [rig] = await withWorkspaceRls(app.db, workspaceId, (db) =>
      db
        .insert(schema.rigs)
        .values({
          accountId: grant.accountId,
          workspaceId,
          name: `lossless-rig-${suffix}`,
        })
        .returning(),
    );
    const rigPayload = { command: exactCommand, nested: { source: unsafeText } };
    const verification = { passed: false, log: unsafeText };
    const [rigChange] = await withWorkspaceRls(app.db, workspaceId, (db) =>
      db
        .insert(schema.rigChanges)
        .values({
          accountId: grant.accountId,
          workspaceId,
          rigId: rig!.id,
          kind: "setup_append",
          payload: rigPayload,
          verification,
        })
        .returning(),
    );
    expect(rigChange).toMatchObject({ payload: rigPayload, verification });
    const [rawRig] = await shared.admin<Array<{ command: string | null }>>`
      select payload ->> 'command' as command from rig_changes where id = ${rigChange!.id}`;
    expect(rawRig).toEqual({ command: exactCommand });

    const [recording] = await withWorkspaceRls(app.db, workspaceId, (db) =>
      db
        .insert(schema.sessionRecordings)
        .values({
          accountId: grant.accountId,
          workspaceId,
          sessionId: session.id,
          turnId: turn.id,
          state: "failed",
          mode: "on-turn",
          codec: "h264-mp4",
          width: 1280,
          height: 720,
          reason: unsafeText,
        })
        .returning(),
    );
    expect(recording!.reason).toBe(unsafeText);

    const memoryText = `searchable${nul}needle ${loneHigh} exact memory`;
    const savedMemory = await saveWorkspaceMemory(app.db, {
      accountId: grant.accountId,
      workspaceId,
      text: memoryText,
      sessionId: session.id,
      origin: "agent",
    });
    expect(savedMemory.memory.text).toBe(memoryText);
    const duplicateMemory = await saveWorkspaceMemory(app.db, {
      accountId: grant.accountId,
      workspaceId,
      text: memoryText,
      sessionId: session.id,
      origin: "agent",
    });
    expect(duplicateMemory).toMatchObject({
      deduped: true,
      dedupeReason: "exact",
      memory: { id: savedMemory.memory.id, text: memoryText },
    });
    const memorySearch = await searchWorkspaceMemories(app.db, workspaceId, {
      query: "searchable needle",
      mode: "keyword",
    });
    expect(memorySearch.map((entry) => entry.memory.id)).toContain(savedMemory.memory.id);
    expect(
      memorySearch.find((entry) => entry.memory.id === savedMemory.memory.id)?.memory.text,
    ).toBe(memoryText);

    const legacyPayload = {
      [LEGACY_LOSSLESS_JSON_ENVELOPE_KEY]: {
        version: 1,
        data: "b3BlbmdlbmktcHJlZXhpc3RpbmctZGF0YQ==",
      },
    };
    const [legacyEvent] = await appendSessionEvents(app.db, workspaceId, session.id, [
      { type: "agent.message.completed", payload: legacyPayload },
    ]);
    const [legacyRead] = await withWorkspaceRls(app.db, workspaceId, (db) =>
      db
        .select({ payload: schema.sessionEvents.payload })
        .from(schema.sessionEvents)
        .where(eq(schema.sessionEvents.id, legacyEvent!.id)),
    );
    expect(legacyRead!.payload).toEqual(legacyPayload);

    const [posture] = await shared.admin<
      Array<{ payloadConstraint: boolean; payloadTrigger: boolean; realtimeBounds: number }>
    >`
      select
        exists (
          select 1 from pg_constraint
          where conrelid = 'session_events'::regclass
            and conname = 'session_events_payload_bytes_check'
        ) as "payloadConstraint",
        exists (
          select 1 from pg_trigger
          where tgrelid = 'session_events'::regclass
            and tgname = 'session_events_bound_payload_before_insert'
            and not tgisinternal
        ) as "payloadTrigger",
        (
          select count(*)::integer from pg_constraint
          where conrelid = 'session_realtime_entries'::regclass
            and conname in (
              'session_realtime_entries_text_check',
              'session_realtime_entries_payload_check'
            )
        ) as "realtimeBounds"`;
    expect(posture).toEqual({
      payloadConstraint: false,
      payloadTrigger: false,
      realtimeBounds: 0,
    });
  }, 180_000);
});
