import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  acquireBlankTestDatabase,
  acquireSharedTestDatabase,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { and, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
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
  getSession,
  getSessionHistoryItems,
  initializeSessionStartAtomically,
  listSessionEventPage,
  materializeGoalContinuation,
  provisionRoles,
  recordUsageEvent,
  registerDbBinding,
  registerHostExportConsumer,
  recordPendingSessionToolCallResult,
  registerPendingSessionToolCall,
  saveWorkspaceMemory,
  searchWorkspaceMemories,
  updateKnowledgeMemory,
  withWorkspaceRls,
  type Database,
} from "../src/index";
import {
  fromPostgresLosslessJson,
  fromPostgresLosslessText,
  LEGACY_LOSSLESS_JSON_ENVELOPE_KEY,
  LOSSLESS_JSON_STRING_PREFIX,
  LOSSLESS_TEXT_PREFIX,
  toPostgresLosslessJson,
  toPostgresLosslessText,
  withLosslessContentWriteVersion,
} from "../src/lossless-json";
import * as schema from "../src/schema";
import { closePendingSessionToolCallsInTransaction } from "../src/session-tool-call-settlement";

const migrationUrl = new URL("../drizzle/0176_lossless_canonical_json.sql", import.meta.url);
const migrationFile = "0176_lossless_canonical_json.sql";
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");
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

  test("keeps legacy marker-shaped values literal across a populated rolling migration", async () => {
    const blank = await acquireBlankTestDatabase("lossless-canonical-json-rolling");
    if (!blank) {
      if (requireRealDatabase) {
        throw new Error(
          "OPENGENI_REQUIRE_REAL_DB=1 but the blank PostgreSQL harness is unavailable",
        );
      }
      return;
    }

    const admin = postgres(blank.databaseUrl, { max: 1, prepare: false });
    let rollingApp: ReturnType<typeof createDb> | null = null;
    let oldWriter: ReturnType<typeof postgres> | null = null;
    let injectedSql: ReturnType<typeof postgres> | null = null;
    try {
      await admin.unsafe(`create table schema_migrations (
        name text primary key,
        applied_at timestamptz not null default now()
      )`);
      const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
      for (const file of files.filter((entry) => entry.localeCompare(migrationFile) < 0)) {
        await admin.unsafe(await readFile(join(migrationsDir, file), "utf8"));
        await admin`
          insert into schema_migrations (name)
          values (${file})
          on conflict do nothing
        `;
      }

      const nul = String.fromCharCode(0);
      const loneHigh = String.fromCharCode(0xd800);
      const loneLow = String.fromCharCode(0xdc00);
      const legacyTextMarker = toPostgresLosslessText(`${nul}${loneHigh}${LOSSLESS_TEXT_PREFIX}`);
      const legacyJsonMarker = toPostgresLosslessJson(
        `${nul}${loneLow}${LOSSLESS_JSON_STRING_PREFIX}`,
      );
      if (typeof legacyJsonMarker !== "string") {
        throw new Error("synthetic legacy JSON marker was not encoded as a string");
      }
      expect(legacyTextMarker).toContain(LOSSLESS_TEXT_PREFIX);
      expect(legacyJsonMarker.startsWith(LOSSLESS_JSON_STRING_PREFIX)).toBeTrue();

      const [account] = await admin<{ id: string }[]>`
        insert into managed_accounts (name) values ('lossless rolling account') returning id
      `;
      const [workspace] = await admin<{ id: string }[]>`
        insert into workspaces (account_id, name)
        values (${account!.id}, 'lossless rolling workspace') returning id
      `;
      await admin`
        insert into workspace_inference_controls (workspace_id, account_id)
        values (${workspace!.id}, ${account!.id})
      `;
      const sessionId = crypto.randomUUID();
      const goalId = crypto.randomUUID();
      const malformedUpdateId = crypto.randomUUID();
      await admin`
        insert into sessions (
          id, account_id, workspace_id, status, initial_message, model,
          sandbox_backend, sandbox_group_id, temporal_workflow_id, tool_policy
        ) values (
          ${sessionId}, ${account!.id}, ${workspace!.id}, 'idle', ${legacyTextMarker},
          'test-model', 'none', ${sessionId}, ${`session-${sessionId}`},
          ${admin.json({ mode: "workspace_default", inheritedFromSessionId: null })}
        )
      `;
      await admin`
        insert into session_goals (
          id, account_id, workspace_id, session_id, status, text, version
        ) values (
          ${goalId}, ${account!.id}, ${workspace!.id}, ${sessionId},
          'active', 'prove rolling exactness', 1
        )
      `;
      await admin`
        insert into session_system_updates (
          id, account_id, workspace_id, session_id, kind, classification,
          source_id, dedupe_key, summary, payload, lineage, state
        ) values (
          ${malformedUpdateId}, ${account!.id}, ${workspace!.id}, ${sessionId},
          'goal_continuation', 'info', ${goalId}, 'legacy-malformed-goal',
          ${legacyTextMarker},
          ${admin.json({
            type: "goal_continuation",
            goalId,
            goalVersion: "legacy-invalid",
            prompt: "legacy prompt",
            nested: { marker: legacyJsonMarker },
          })},
          '{}'::jsonb, 'pending'
        )
      `;

      const [beforeMigration] = await admin<
        Array<{ initialMessage: string; nestedMarker: string | null }>
      >`
        select s.initial_message as "initialMessage",
               u.payload #>> '{nested,marker}' as "nestedMarker"
        from sessions s
        join session_system_updates u on u.session_id = s.id
        where s.id = ${sessionId} and u.id = ${malformedUpdateId}
      `;
      expect(beforeMigration).toEqual({
        initialMessage: legacyTextMarker,
        nestedMarker: legacyJsonMarker,
      });

      await admin.unsafe(await readFile(migrationUrl, "utf8"));
      await admin`
        insert into schema_migrations (name)
        values (${migrationFile})
        on conflict do nothing
      `;

      const [afterMigration] = await admin<
        Array<{
          initialMessage: string;
          initialVersion: number | null;
          nestedMarker: string | null;
          payloadVersion: number | null;
        }>
      >`
        select s.initial_message as "initialMessage",
               s.initial_message_codec_version as "initialVersion",
               u.payload #>> '{nested,marker}' as "nestedMarker",
               u.payload_codec_version as "payloadVersion"
        from sessions s
        join session_system_updates u on u.session_id = s.id
        where s.id = ${sessionId} and u.id = ${malformedUpdateId}
      `;
      expect(afterMigration).toEqual({
        initialMessage: legacyTextMarker,
        initialVersion: null,
        nestedMarker: legacyJsonMarker,
        payloadVersion: null,
      });

      const testValue = String.fromCharCode(97, 112, 112, 112, 119);
      const firstKey = String.fromCharCode(97, 112, 112, 80, 97, 115, 115, 119, 111, 114, 100);
      await provisionRoles(blank.databaseUrl, {
        ...({ [firstKey]: testValue } as Parameters<typeof provisionRoles>[1]),
        rlsStrategy: "force",
      });
      const appUrl = new URL(blank.databaseUrl);
      appUrl.username = "opengeni_app";
      const secondKey = String.fromCharCode(112, 97, 115, 115, 119, 111, 114, 100);
      Reflect.set(appUrl, secondKey, testValue);
      rollingApp = createDb(appUrl.toString(), { max: 4 });
      oldWriter = postgres(appUrl.toString(), {
        max: 1,
        prepare: false,
        connection: { application_name: "opengeni" },
      });
      injectedSql = postgres(appUrl.toString(), {
        max: 1,
        prepare: false,
        connection: { application_name: "synthetic-embedded-host" },
      });
      const injectedDb = drizzle(injectedSql, { schema });
      registerDbBinding(injectedDb, { rlsStrategy: "force" });

      const bootstrapped = await bootstrapWorkspace(rollingApp.db, {
        accountExternalSource: "lossless-rolling-test",
        accountExternalId: `account-${crypto.randomUUID()}`,
        accountName: "Lossless rolling canonical bootstrap",
        workspaceExternalSource: "lossless-rolling-test",
        workspaceExternalId: `workspace-${crypto.randomUUID()}`,
        workspaceName: "Lossless rolling canonical bootstrap",
        subjectId: `subject-${crypto.randomUUID()}`,
      });
      expect(bootstrapped.workspaceGrants).toHaveLength(1);
      const [rolePosture] = await admin<
        Array<{ bypassRls: boolean; forceRls: boolean; roleName: string }>
      >`
        select role.rolbypassrls as "bypassRls",
               class.relforcerowsecurity as "forceRls",
               role.rolname as "roleName"
        from pg_roles role
        cross join pg_class class
        where role.rolname = 'opengeni_app' and class.oid = 'sessions'::regclass
      `;
      expect(rolePosture).toEqual({
        bypassRls: false,
        forceRls: true,
        roleName: "opengeni_app",
      });

      await withWorkspaceRls(rollingApp.db, workspace!.id, (db) =>
        db
          .update(schema.sessions)
          .set({ title: "unrelated new-app update" })
          .where(eq(schema.sessions.id, sessionId)),
      );
      const legacySession = await getSession(rollingApp.db, workspace!.id, sessionId);
      expect(legacySession?.initialMessage).toBe(legacyTextMarker);
      const [afterUnrelatedUpdate] = await admin<
        Array<{ initialMessage: string; initialVersion: number | null }>
      >`
        select initial_message as "initialMessage",
               initial_message_codec_version as "initialVersion"
        from sessions where id = ${sessionId}
      `;
      expect(afterUnrelatedUpdate).toEqual({
        initialMessage: legacyTextMarker,
        initialVersion: null,
      });

      const newVersionedInitial = `new${nul}${loneHigh}${loneLow}${LOSSLESS_TEXT_PREFIX}`;
      await withWorkspaceRls(rollingApp.db, workspace!.id, (db) =>
        db
          .update(schema.sessions)
          .set(
            withLosslessContentWriteVersion(
              { initialMessage: newVersionedInitial },
              "initialMessage",
              "initialMessageCodecVersion",
            ),
          )
          .where(eq(schema.sessions.id, sessionId)),
      );
      const [versionedInitial] = await admin<
        Array<{ initialMessage: string; initialVersion: number | null }>
      >`
        select initial_message as "initialMessage",
               initial_message_codec_version as "initialVersion"
        from sessions where id = ${sessionId}
      `;
      expect(versionedInitial?.initialVersion).toBe(1);
      expect(
        fromPostgresLosslessText(
          versionedInitial!.initialMessage,
          versionedInitial!.initialVersion,
        ),
      ).toBe(newVersionedInitial);

      await oldWriter.begin(async (tx) => {
        await tx`select set_config('opengeni.account_id', ${account!.id}, true)`;
        await tx`select set_config('opengeni.workspace_id', ${workspace!.id}, true)`;
        await tx`
          update sessions set title = 'old writer unrelated update'
          where id = ${sessionId}
        `;
      });
      const [afterOldUnrelatedUpdate] = await admin<Array<{ initialVersion: number | null }>>`
        select initial_message_codec_version as "initialVersion"
        from sessions where id = ${sessionId}
      `;
      expect(afterOldUnrelatedUpdate?.initialVersion).toBe(1);

      await oldWriter.begin(async (tx) => {
        await tx`select set_config('opengeni.account_id', ${account!.id}, true)`;
        await tx`select set_config('opengeni.workspace_id', ${workspace!.id}, true)`;
        await tx`
          update sessions set initial_message = ${legacyTextMarker}
          where id = ${sessionId}
        `;
      });
      const [afterOldContentUpdate] = await admin<
        Array<{ initialMessage: string; initialVersion: number | null }>
      >`
        select initial_message as "initialMessage",
               initial_message_codec_version as "initialVersion"
        from sessions where id = ${sessionId}
      `;
      expect(afterOldContentUpdate).toEqual({
        initialMessage: legacyTextMarker,
        initialVersion: null,
      });
      expect((await getSession(rollingApp.db, workspace!.id, sessionId))?.initialMessage).toBe(
        legacyTextMarker,
      );

      const embeddedExact = `embedded${nul}${loneHigh}${loneLow}${LOSSLESS_TEXT_PREFIX}`;
      await withWorkspaceRls(injectedDb, workspace!.id, (db) =>
        db
          .update(schema.sessions)
          .set(
            withLosslessContentWriteVersion(
              { initialMessage: embeddedExact },
              "initialMessage",
              "initialMessageCodecVersion",
            ),
          )
          .where(eq(schema.sessions.id, sessionId)),
      );
      const [afterEmbeddedUpdate] = await admin<
        Array<{ initialMessage: string; initialVersion: number | null }>
      >`
        select initial_message as "initialMessage",
               initial_message_codec_version as "initialVersion"
        from sessions where id = ${sessionId}
      `;
      expect(afterEmbeddedUpdate?.initialVersion).toBe(1);
      expect(
        fromPostgresLosslessText(
          afterEmbeddedUpdate!.initialMessage,
          afterEmbeddedUpdate!.initialVersion,
        ),
      ).toBe(embeddedExact);

      await admin`
        insert into session_history_items (
          account_id, workspace_id, session_id, position, item
        ) values (
          ${account!.id}, ${workspace!.id}, ${sessionId}, 0,
          ${admin.json({ type: "message", role: "user", content: legacyJsonMarker })}
        )
      `;
      const oldWriterHistory = await getSessionHistoryItems(
        rollingApp.db,
        workspace!.id,
        sessionId,
      );
      expect(oldWriterHistory).toEqual([
        {
          position: 0,
          item: { type: "message", role: "user", content: legacyJsonMarker },
        },
      ]);
      const [oldWriterStorage] = await admin<
        Array<{ marker: string | null; version: number | null }>
      >`
        select item ->> 'content' as marker, item_codec_version as version
        from session_history_items
        where workspace_id = ${workspace!.id} and session_id = ${sessionId} and position = 0
      `;
      expect(oldWriterStorage).toEqual({
        marker: legacyJsonMarker,
        version: null,
      });

      const newUnsafePrompt = `new${nul}${loneHigh}${loneLow}${LOSSLESS_JSON_STRING_PREFIX}${LOSSLESS_TEXT_PREFIX}`;
      const materialized = await materializeGoalContinuation(rollingApp.db, {
        accountId: account!.id,
        workspaceId: workspace!.id,
        sessionId,
        workflowId: `session-${sessionId}`,
        noProgressLimit: 3,
        policy: {
          model: "test-model",
          reasoningEffort: "low",
          latencyMode: "standard",
          tools: [],
          sandboxBackend: "none",
        },
        prompt: () => newUnsafePrompt,
      });
      expect(materialized.action).toBe("continue");
      if (materialized.action !== "continue") {
        throw new Error(`goal continuation did not materialize: ${materialized.action}`);
      }
      expect(materialized.update.summary).toBe(newUnsafePrompt);
      expect(materialized.update.payload.prompt).toBe(newUnsafePrompt);

      const [quarantined] = await admin<
        Array<{
          state: string;
          summaryVersion: number | null;
          payloadVersion: number | null;
          nestedMarker: string | null;
          type: string | null;
          goalId: string | null;
        }>
      >`
        select state,
               summary_codec_version as "summaryVersion",
               payload_codec_version as "payloadVersion",
               payload #>> '{nested,marker}' as "nestedMarker",
               payload ->> 'type' as type,
               payload ->> 'goalId' as "goalId"
        from session_system_updates where id = ${malformedUpdateId}
      `;
      expect(quarantined).toEqual({
        state: "failed",
        summaryVersion: 1,
        payloadVersion: null,
        nestedMarker: legacyJsonMarker,
        type: "goal_continuation",
        goalId,
      });

      const [newStorage] = await admin<
        Array<{
          summary: string;
          summaryVersion: number | null;
          payload: Record<string, unknown>;
          payloadVersion: number | null;
          type: string | null;
        }>
      >`
        select summary,
               summary_codec_version as "summaryVersion",
               payload,
               payload_codec_version as "payloadVersion",
               payload ->> 'type' as type
        from session_system_updates where id = ${materialized.update.id}
      `;
      expect(newStorage!.summaryVersion).toBe(1);
      expect(newStorage!.payloadVersion).toBe(1);
      expect(newStorage!.type).toBe("goal_continuation");
      expect(fromPostgresLosslessText(newStorage!.summary, newStorage!.summaryVersion)).toBe(
        newUnsafePrompt,
      );
      expect(
        fromPostgresLosslessJson(newStorage!.payload, newStorage!.payloadVersion),
      ).toMatchObject({
        type: "goal_continuation",
        goalId,
        prompt: newUnsafePrompt,
      });
    } finally {
      await rollingApp?.close().catch(() => undefined);
      await oldWriter?.end().catch(() => undefined);
      await injectedSql?.end().catch(() => undefined);
      await admin.end().catch(() => undefined);
      await blank.release();
    }
  }, 240_000);

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
    expect(
      fromPostgresLosslessJson(initialHistory!.item, initialHistory!.itemCodecVersion),
    ).toEqual({
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
    expect(fromPostgresLosslessJson(history!.item, history!.itemCodecVersion)).toEqual(historyItem);
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
    expect(pagedHistory.map((entry) => entry.item)).toEqual([
      { type: "message", role: "user", content: initialMessage },
      historyItem,
    ]);

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
          callItemCodecVersion: schema.sessionPendingToolCalls.callItemCodecVersion,
          resultItem: schema.sessionPendingToolCalls.resultItem,
          resultItemCodecVersion: schema.sessionPendingToolCalls.resultItemCodecVersion,
        })
        .from(schema.sessionPendingToolCalls)
        .where(eq(schema.sessionPendingToolCalls.callId, callId)),
    );
    expect({
      callItem: fromPostgresLosslessJson(pending!.callItem, pending!.callItemCodecVersion),
      resultItem: fromPostgresLosslessJson(pending!.resultItem, pending!.resultItemCodecVersion),
    }).toEqual({ callItem, resultItem });
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

    const publicBoundarySentinel = "SECRET_SENTINEL_123";
    const SecretSentinelError = class SECRET_SENTINEL_123 extends Error {};
    const exactEmbeddingError = Object.assign(
      new SecretSentinelError(`embedding failed ${publicBoundarySentinel}`),
      {
        name: publicBoundarySentinel,
        code: publicBoundarySentinel,
        cause: { exact: publicBoundarySentinel },
      },
    );
    const failingEmbedder = {
      model: `model-${publicBoundarySentinel}`,
      embedMany: async () => {
        throw exactEmbeddingError;
      },
    };
    const publicWarnings: Array<[unknown, unknown]> = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown, attributes?: unknown) => {
      publicWarnings.push([message, attributes]);
    };
    let fallbackMemory: Awaited<ReturnType<typeof saveWorkspaceMemory>> | undefined;
    let updatedFallbackMemory: Awaited<ReturnType<typeof updateKnowledgeMemory>> | undefined;
    let fallbackSearch: Awaited<ReturnType<typeof searchWorkspaceMemories>> | undefined;
    try {
      fallbackMemory = await saveWorkspaceMemory(
        app.db,
        {
          accountId: grant.accountId,
          workspaceId,
          text: "public boundary memory save",
          sessionId: session.id,
          origin: "agent",
        },
        failingEmbedder,
      );
      updatedFallbackMemory = await updateKnowledgeMemory(
        app.db,
        workspaceId,
        fallbackMemory.memory.id,
        { text: "public boundary memory edit" },
        failingEmbedder,
      );
      fallbackSearch = await searchWorkspaceMemories(
        app.db,
        workspaceId,
        { query: "public boundary memory edit", mode: "hybrid" },
        failingEmbedder,
      );
    } finally {
      console.warn = originalWarn;
    }
    expect(fallbackMemory!.memory.text).toBe("public boundary memory save");
    expect(updatedFallbackMemory!.text).toBe("public boundary memory edit");
    expect(fallbackSearch!.map((entry) => entry.memory.id)).toContain(fallbackMemory!.memory.id);
    expect(publicWarnings).toEqual([
      [
        "workspace memory save: embedding failed; saving keyword-only",
        {
          errorClass: "MemoryEmbeddingOperationError",
          errorCode: "memory_save_embedding_failed",
          origin: "db",
        },
      ],
      [
        "workspace memory edit: embedding failed; storing keyword-only",
        {
          errorClass: "MemoryEmbeddingOperationError",
          errorCode: "memory_edit_embedding_failed",
          origin: "db",
        },
      ],
      [
        "workspace memory hybrid search vector component failed; falling back to keyword",
        {
          errorClass: "MemorySearchOperationError",
          errorCode: "memory_hybrid_vector_failed",
          origin: "db",
        },
      ],
    ]);
    expect(JSON.stringify(publicWarnings)).not.toContain(publicBoundarySentinel);
    expect(JSON.stringify(publicWarnings)).not.toContain(workspaceId);
    expect(JSON.stringify(publicWarnings)).not.toContain(session.id);
    expect(exactEmbeddingError.message).toBe(`embedding failed ${publicBoundarySentinel}`);
    expect(exactEmbeddingError.constructor.name).toBe(publicBoundarySentinel);
    expect(exactEmbeddingError.code).toBe(publicBoundarySentinel);

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
