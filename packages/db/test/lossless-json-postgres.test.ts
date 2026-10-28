import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";

import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { renderMessageSentAtForModel } from "@opengeni/contracts";
import { and, asc, eq } from "drizzle-orm";

import postgres from "postgres";
import {
  acknowledgeHostExportBatch,
  appendSessionEvents,
  appendSessionHistoryItems,
  bootstrapWorkspace,
  claimHostExportBatch,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  deadLetterHostExportHead,
  getActiveSessionHistoryItemsPaged,
  initializeSessionStartAtomically,
  listSessionEventPage,
  recordUsageEvent,
  registerHostExportConsumer,
  recordPendingSessionToolCallResult,
  registerPendingSessionToolCall,
  saveKnowledgeEntry,
  getKnowledgeEntry,
  listKnowledgeEntries,
  type KnowledgeContext,
  withWorkspaceRls,
  type Database,
} from "../src/index";
import {
  fromPostgresLosslessJson,
  fromPostgresLosslessText,
  LEGACY_LOSSLESS_JSON_ENVELOPE_KEY,
  LOSSLESS_JSON_STRING_PREFIX,
  LOSSLESS_TEXT_PREFIX,
  withLosslessContentWriteVersion,
} from "../src/lossless-json";
import * as schema from "../src/schema";

import { closePendingSessionToolCallsInTransaction } from "../src/session-tool-call-settlement";

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
    const unsafeText =
      `before${nul}middle${loneHigh}low${loneLow}after` +
      `${LOSSLESS_JSON_STRING_PREFIX}${LOSSLESS_TEXT_PREFIX}`;
    const literalPrefixCollision = `${LOSSLESS_JSON_STRING_PREFIX}literal-prefix-collision`;
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
    expect(rolePosture).toEqual({
      bypassRls: false,
      forceRls: true,
      roleName: "opengeni_app",
    });

    const session = await createSession(app.db, {
      accountId: grant.accountId,
      workspaceId,
      initialMessage,
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium" as const,
      latencyMode: "standard" as const,
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
      hostile: JSON.parse(`{"__proto__":{"polluted":true},"safe":"x\\u0000y"}`) as Record<
        string,
        unknown
      >,
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
    const restoredHostile = (appended[0]!.payload as typeof queryablePayload).hostile;
    expect(Object.keys(restoredHostile)).toHaveLength(2);
    expect(Object.keys(restoredHostile)).toContain("__proto__");
    expect(Object.keys(restoredHostile)).toContain("safe");
    expect(Object.hasOwn(restoredHostile, "__proto__")).toBeTrue();
    expect(Object.getPrototypeOf(restoredHostile)).toBe(Object.prototype);
    expect((restoredHostile as { polluted?: unknown }).polluted).toBeUndefined();
    expect(restoredHostile["__proto__"]).toEqual({ polluted: true });

    const [rawEvent] = await shared.admin<
      Array<{
        id: string | null;
        updateId: string | null;
        sourceKey: string | null;
        recordingId: string | null;
        code: string | null;
        type: string | null;
        hostileHasProto: boolean;
        hostilePolluted: string | null;
      }>
    >`
      select payload ->> 'id' as id,
             payload ->> 'updateId' as "updateId",
             payload ->> 'sourceKey' as "sourceKey",
             payload ->> 'recordingId' as "recordingId",
             payload ->> 'code' as code,
             payload ->> 'type' as type,
             (payload -> 'hostile') ? '__proto__' as "hostileHasProto",
             payload #>> '{hostile,__proto__,polluted}' as "hostilePolluted"
      from session_events where id = ${appended[0]!.id}`;
    expect(rawEvent).toEqual({
      id: queryablePayload.id,
      updateId: queryablePayload.updateId,
      sourceKey: queryablePayload.sourceKey,
      recordingId: queryablePayload.recordingId,
      code: queryablePayload.code,
      type: queryablePayload.type,
      hostileHasProto: true,
      hostilePolluted: "true",
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
      orderedProbe: {
        query: "search",
        names: ["tool"],
        limit: 5,
        schema: { zebra: { type: "string" }, alpha: { type: "number" } },
      },
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: `${exactCommand}\n${unsafeText}` },
        { type: "input_text", text: literalPrefixCollision },
      ],
    };
    const [initialHistory] = await withWorkspaceRls(app.db, workspaceId, (db) =>
      db
        .select({
          item: schema.sessionHistoryItems.item,
          itemCodecVersion: schema.sessionHistoryItems.itemCodecVersion,
        })
        .from(schema.sessionHistoryItems)
        .where(
          and(
            eq(schema.sessionHistoryItems.sessionId, session.id),
            eq(schema.sessionHistoryItems.position, 0),
          ),
        ),
    );
    const initialUserItem = {
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: renderMessageSentAtForModel(turn.createdAt) },
        { type: "input_text", text: initialMessage },
      ],
    };
    expect(
      fromPostgresLosslessJson(initialHistory!.item, initialHistory!.itemCodecVersion),
    ).toEqual(initialUserItem);
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
        .select({
          item: schema.sessionHistoryItems.item,
          itemCodecVersion: schema.sessionHistoryItems.itemCodecVersion,
        })
        .from(schema.sessionHistoryItems)
        .where(
          and(
            eq(schema.sessionHistoryItems.sessionId, session.id),
            eq(schema.sessionHistoryItems.position, 1),
          ),
        ),
    );
    expect(JSON.stringify(fromPostgresLosslessJson(history!.item, history!.itemCodecVersion))).toBe(
      JSON.stringify(historyItem),
    );
    const [rawHistory] = await shared.admin<Array<{ type: string | null }>>`
      select item ->> 'type' as type from session_history_items
      where workspace_id = ${workspaceId} and session_id = ${session.id} and position = 1`;
    expect(rawHistory).toEqual({ type: "message" });
    const pagedHistory = await getActiveSessionHistoryItemsPaged(
      app.db,
      workspaceId,
      session.id,
      1,
    );
    expect(pagedHistory.map((entry) => entry.item)).toEqual([initialUserItem, historyItem]);
    expect(
      (await getActiveSessionHistoryItemsPaged(app.db, workspaceId, session.id)).map(
        (entry) => entry.item,
      ),
    ).toEqual(pagedHistory.map((entry) => entry.item));

    const callId = "pending-synthetic-call";
    const callItem = {
      orderedProbe: { query: "search", names: [], limit: 5 },
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
    const eventOutput = {
      content: [{ type: "text", text: unsafeText }],
      structuredContent: { exactCommand },
      isError: false,
      vendorReceipt: { id: unsafeText },
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
        eventOutput,
      }),
    ).toEqual({ accepted: true, recorded: true });
    const [pending] = await withWorkspaceRls(app.db, workspaceId, (db) =>
      db
        .select({
          callItem: schema.sessionPendingToolCalls.callItem,
          callItemCodecVersion: schema.sessionPendingToolCalls.callItemCodecVersion,
          resultItem: schema.sessionPendingToolCalls.resultItem,
          resultItemCodecVersion: schema.sessionPendingToolCalls.resultItemCodecVersion,
          eventOutput: schema.sessionPendingToolCalls.eventOutput,
          eventOutputCodecVersion: schema.sessionPendingToolCalls.eventOutputCodecVersion,
        })
        .from(schema.sessionPendingToolCalls)
        .where(eq(schema.sessionPendingToolCalls.callId, callId)),
    );
    if (!pending?.eventOutput) throw new Error("Pending tool event output was not retained");
    expect(
      JSON.stringify(fromPostgresLosslessJson(pending.callItem, pending.callItemCodecVersion)),
    ).toBe(JSON.stringify(callItem));
    expect({
      callItem: fromPostgresLosslessJson(pending.callItem, pending.callItemCodecVersion),
      resultItem: fromPostgresLosslessJson(pending.resultItem, pending.resultItemCodecVersion),
      eventOutput: fromPostgresLosslessJson(pending.eventOutput, pending.eventOutputCodecVersion)
        .value,
    }).toEqual({ callItem, resultItem, eventOutput });
    const [rawPending] = await shared.admin<
      Array<{ callType: string | null; resultType: string | null }>
    >`
      select call_item ->> 'type' as "callType", result_item ->> 'type' as "resultType"
      from session_pending_tool_calls where call_id = ${callId}`;
    expect(rawPending).toEqual({
      callType: "function_call",
      resultType: "function_call_result",
    });
    const legacyApp = postgres(shared.appUrl, { max: 1, onnotice: () => undefined });
    try {
      await expect(
        legacyApp.begin(async (sql) => {
          await sql`select set_config('opengeni.account_id', ${grant.accountId}, true)`;
          await sql`select set_config('opengeni.workspace_id', ${workspaceId}, true)`;
          await sql`select set_config(
            'opengeni.session_variable_set_attachments_v1',
            '1',
            true
          )`;
          await sql`delete from session_pending_tool_calls where call_id = ${callId}`;
        }),
      ).rejects.toThrow("rich pending tool output requires a v1-aware settlement worker");
    } finally {
      await legacyApp.end();
    }
    const [retainedAfterLegacyDelete] = await shared.admin<Array<{ eventOutput: unknown | null }>>`
      select event_output as "eventOutput"
      from session_pending_tool_calls where call_id = ${callId}`;
    expect(retainedAfterLegacyDelete?.eventOutput).not.toBeNull();

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
    expect(settled.events).toContainEqual(
      expect.objectContaining({
        type: "agent.toolCall.output",
        payload: expect.objectContaining({ id: callId, output: eventOutput }),
      }),
    );
    const settledHistory = await withWorkspaceRls(app.db, workspaceId, (db) =>
      db
        .select({
          item: schema.sessionHistoryItems.item,
          itemCodecVersion: schema.sessionHistoryItems.itemCodecVersion,
        })
        .from(schema.sessionHistoryItems)
        .where(eq(schema.sessionHistoryItems.turnId, turn.id))
        .orderBy(asc(schema.sessionHistoryItems.position)),
    );
    const settledItems = settledHistory.map((entry) =>
      fromPostgresLosslessJson(entry.item, entry.itemCodecVersion),
    );
    expect(settledItems).toContainEqual(callItem);
    expect(settledItems).toContainEqual(resultItem);

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
    const rigPayload = {
      command: exactCommand,
      nested: { source: unsafeText },
    };
    const verification = { passed: false, log: unsafeText };
    const [rigChange] = await withWorkspaceRls(app.db, workspaceId, (db) =>
      db
        .insert(schema.rigChanges)
        .values(
          withLosslessContentWriteVersion(
            withLosslessContentWriteVersion(
              {
                accountId: grant.accountId,
                workspaceId,
                rigId: rig!.id,
                kind: "setup_append",
                payload: rigPayload,
                verification,
              },
              "payload",
              "payloadCodecVersion",
            ),
            "verification",
            "verificationCodecVersion",
          ),
        )
        .returning(),
    );
    expect({
      payload: fromPostgresLosslessJson(rigChange!.payload, rigChange!.payloadCodecVersion),
      verification: fromPostgresLosslessJson(
        rigChange!.verification,
        rigChange!.verificationCodecVersion,
      ),
    }).toEqual({ payload: rigPayload, verification });
    const [rawRig] = await shared.admin<Array<{ command: string | null }>>`
      select payload ->> 'command' as command from rig_changes where id = ${rigChange!.id}`;
    expect(rawRig).toEqual({ command: exactCommand });

    const [recording] = await withWorkspaceRls(app.db, workspaceId, (db) =>
      db
        .insert(schema.sessionRecordings)
        .values(
          withLosslessContentWriteVersion(
            {
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
            },
            "reason",
            "reasonCodecVersion",
          ),
        )
        .returning(),
    );
    expect(fromPostgresLosslessText(recording!.reason!, recording!.reasonCodecVersion)).toBe(
      unsafeText,
    );

    const knowledgeText = `searchable${nul}needle ${loneHigh} exact retained knowledge`;
    const knowledgeContext: KnowledgeContext = {
      accountId: grant.accountId,
      workspaceId,
      actor: {
        kind: "human",
        principalKind: "human_session",
        subjectId: grant.subjectId,
        writeScopes: ["workspace"],
        settingsScopes: [],
        review: true,
      },
    };
    const knowledgeRequest = {
      operationId: crypto.randomUUID(),
      entryId: crypto.randomUUID(),
      expectedVersion: 0,
      entry: { kind: "fact" as const, title: "Exact retained content", content: knowledgeText },
    };
    const savedKnowledge = await saveKnowledgeEntry(app.db, knowledgeContext, knowledgeRequest);
    const repeatedKnowledge = await saveKnowledgeEntry(app.db, knowledgeContext, knowledgeRequest);
    expect(repeatedKnowledge).toEqual({ ...savedKnowledge, replayed: true });
    const retained = await getKnowledgeEntry(app.db, knowledgeContext, savedKnowledge.entryId);
    expect(retained?.revision.entry.content).toBe(knowledgeText);
    const knowledgeSearch = await listKnowledgeEntries(app.db, knowledgeContext, {
      query: "searchable needle",
    });
    expect(knowledgeSearch.entries.map((entry) => entry.id)).toContain(savedKnowledge.entryId);
    const correctedText = `${knowledgeText} corrected${nul}exact`;
    await saveKnowledgeEntry(app.db, knowledgeContext, {
      ...knowledgeRequest,
      operationId: crypto.randomUUID(),
      expectedVersion: 1,
      entry: { ...knowledgeRequest.entry, content: correctedText },
    });
    expect(
      (await getKnowledgeEntry(app.db, knowledgeContext, savedKnowledge.entryId))?.revision.entry
        .content,
    ).toBe(correctedText);

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
        .select({
          payload: schema.sessionEvents.payload,
          payloadCodecVersion: schema.sessionEvents.payloadCodecVersion,
        })
        .from(schema.sessionEvents)
        .where(eq(schema.sessionEvents.id, legacyEvent!.id)),
    );
    expect(fromPostgresLosslessJson(legacyRead!.payload, legacyRead!.payloadCodecVersion)).toEqual(
      legacyPayload,
    );

    const [posture] = await shared.admin<
      Array<{
        payloadConstraint: boolean;
        payloadTrigger: boolean;
        realtimeBounds: number;
      }>
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

  test("materializes exact host exports and nested dead-letter payloads", async () => {
    if (!shared || !app) return;
    const suffix = crypto.randomUUID();
    const access = await bootstrapWorkspace(app.db, {
      accountExternalSource: "lossless-host-export-test",
      accountExternalId: `account-${suffix}`,
      accountName: "Lossless host export",
      workspaceExternalSource: "lossless-host-export-test",
      workspaceExternalId: `workspace-${suffix}`,
      workspaceName: "Lossless host export",
      subjectId: `subject-${suffix}`,
    });
    const grant = access.workspaceGrants[0]!;
    const workspaceId = grant.workspaceId!;
    const session = await createSession(app.db, {
      accountId: grant.accountId,
      workspaceId,
      initialMessage: "prepare exact host export",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium" as const,
      latencyMode: "standard" as const,
      sandboxBackend: "none",
    });
    const started = await initializeSessionStartAtomically(app.db, {
      accountId: grant.accountId,
      workspaceId,
      sessionId: session.id,
      reasoningEffortFallback: "low",
      createdEventPayload: {},
    });
    if (!started.turn) throw new Error("host-export fixture did not create a turn");

    const exporter = createDb(shared.adminUrl, { max: 2 });
    const eventConsumerId = `lossless-event-${suffix}`;
    const usageConsumerId = `lossless-usage-${suffix}`;
    try {
      await registerHostExportConsumer(exporter.db, {
        kind: "session_event",
        consumerId: eventConsumerId,
      });
      await registerHostExportConsumer(exporter.db, {
        kind: "usage_event",
        consumerId: usageConsumerId,
      });

      const nul = String.fromCharCode(0);
      const loneHigh = String.fromCharCode(0xd800);
      const loneLow = String.fromCharCode(0xdc00);
      const activePrefixCollision = `${LOSSLESS_JSON_STRING_PREFIX}QQAAAA==`;
      const exactPayload = {
        id: `call-${suffix}`,
        updateId: `update-${suffix}`,
        sourceKey: `source-${suffix}`,
        recordingId: `recording-${suffix}`,
        code: "synthetic_exact_host_export",
        type: "agent.toolCall.output",
        output: `before${nul}${loneHigh}${loneLow}after`,
        collision: activePrefixCollision,
      };
      const [event] = await appendSessionEvents(app.db, workspaceId, session.id, [
        {
          type: "agent.toolCall.output",
          payload: exactPayload,
          turnId: started.turn.id,
        },
      ]);
      const usage = await recordUsageEvent(app.db, {
        accountId: grant.accountId,
        workspaceId,
        eventType: "synthetic.host.export",
        quantity: 1,
        unit: "event",
        sessionId: session.id,
        turnId: started.turn.id,
        idempotencyKey: `lossless-host-usage-${suffix}`,
      });

      const eventBatch = await claimHostExportBatch(exporter.db, {
        kind: "session_event",
        consumerId: eventConsumerId,
        leaseToken: crypto.randomUUID(),
        leaseHolderId: `lossless-host-${suffix}`,
      });
      expect(eventBatch?.events).toHaveLength(1);
      expect(eventBatch?.events[0]?.event.id).toBe(event!.id);
      expect(eventBatch?.events[0]?.event.payload).toEqual(exactPayload);

      const [outbox] = await shared.admin<
        Array<{
          payloadVersion: number | null;
          id: string | null;
          updateId: string | null;
          sourceKey: string | null;
          recordingId: string | null;
          code: string | null;
          type: string | null;
        }>
      >`
        select payload_codec_version as "payloadVersion",
               payload ->> 'id' as id,
               payload ->> 'updateId' as "updateId",
               payload ->> 'sourceKey' as "sourceKey",
               payload ->> 'recordingId' as "recordingId",
               payload ->> 'code' as code,
               payload ->> 'type' as type
        from host_export_outbox
        where export_kind = 'session_event' and source_id = ${event!.id}::uuid
      `;
      expect(outbox).toEqual({
        payloadVersion: 1,
        id: exactPayload.id,
        updateId: exactPayload.updateId,
        sourceKey: exactPayload.sourceKey,
        recordingId: exactPayload.recordingId,
        code: exactPayload.code,
        type: exactPayload.type,
      });

      const usageBatch = await claimHostExportBatch(exporter.db, {
        kind: "usage_event",
        consumerId: usageConsumerId,
        leaseToken: crypto.randomUUID(),
        leaseHolderId: `lossless-usage-${suffix}`,
      });
      expect(usageBatch?.events).toHaveLength(1);
      expect(usageBatch?.events[0]?.usage.id).toBe(usage.id);
      const [usageOutbox] = await shared.admin<Array<{ payloadVersion: number | null }>>`
        select payload_codec_version as "payloadVersion"
        from host_export_outbox
        where export_kind = 'usage_event' and source_id = ${usage.id}::uuid
      `;
      expect(usageOutbox?.payloadVersion).toBeNull();
      await acknowledgeHostExportBatch(exporter.db, {
        kind: "usage_event",
        consumerId: usageConsumerId,
        leaseToken: usageBatch!.leaseToken,
      });

      await deadLetterHostExportHead(exporter.db, {
        kind: "session_event",
        consumerId: eventConsumerId,
        leaseToken: eventBatch!.leaseToken,
        cursor: eventBatch!.events[0]!.cursor,
        reason: "synthetic exact-content disposition",
      });
      const [deadLetter] = await shared.admin<
        Array<{
          envelope: Record<string, unknown>;
          envelopeVersion: number | null;
          eventPayloadVersion: number | null;
        }>
      >`
        select envelope,
               envelope_codec_version as "envelopeVersion",
               event_payload_codec_version as "eventPayloadVersion"
        from host_export_dead_letters
        where export_kind = 'session_event'
          and consumer_id = ${eventConsumerId}
          and export_cursor = ${eventBatch!.events[0]!.cursor}::bigint
      `;
      expect(deadLetter?.envelopeVersion).toBeNull();
      expect(deadLetter?.eventPayloadVersion).toBe(1);
      const deadLetterEvent = deadLetter?.envelope.event as Record<string, unknown>;
      expect(
        fromPostgresLosslessJson(deadLetterEvent.payload, deadLetter?.eventPayloadVersion),
      ).toEqual(exactPayload);
    } finally {
      await exporter.close();
    }
  }, 180_000);
});
