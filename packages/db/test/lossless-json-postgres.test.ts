import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { acquireBlankTestDatabase, type BlankTestDatabase } from "@opengeni/testing";
import { and, eq } from "drizzle-orm";
import postgres from "postgres";
import { createDb } from "../src/database";
import { listSessionEventPage } from "../src/index";
import { migrate } from "../src/migrate";
import * as schema from "../src/schema";

const migrationUrl = new URL("../drizzle/0175_lossless_canonical_json.sql", import.meta.url);
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let blank: BlankTestDatabase | null = null;

beforeAll(async () => {
  blank = await acquireBlankTestDatabase("lossless-canonical-json");
  if (!blank && requireRealDatabase) {
    throw new Error("OPENGENI_REQUIRE_REAL_DB=1 but the PostgreSQL harness is unavailable");
  }
}, 180_000);

afterAll(async () => {
  await blank?.release();
});

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

  test("round-trips exact event, history, rig-verification, and recording values", async () => {
    if (!blank) return;
    await migrate(blank.databaseUrl);
    const admin = postgres(blank.databaseUrl, { max: 1, onnotice: () => undefined });
    const app = createDb(blank.databaseUrl, { max: 1 });
    try {
      const [account] = await admin<{ id: string }[]>`
        insert into managed_accounts (name) values ('lossless-json-account') returning id`;
      const [workspace] = await admin<{ id: string }[]>`
        insert into workspaces (account_id, name)
        values (${account!.id}, 'lossless-json-workspace') returning id`;
      const sessionId = crypto.randomUUID();
      await admin`
        insert into sessions (
          id, account_id, workspace_id, status, initial_message, model,
          sandbox_backend, sandbox_group_id, temporal_workflow_id
        ) values (
          ${sessionId}, ${account!.id}, ${workspace!.id}, 'idle', 'lossless fixture',
          'scripted-model', 'none', ${sessionId}, ${`session-${sessionId}`}
        )`;

      const unsafeText = [
        "before",
        String.fromCharCode(0),
        "middle",
        String.fromCharCode(0xd800),
        "after",
      ].join("");
      const cyclic: Record<string, unknown> = {
        unsafeText,
        oversized: "x".repeat(96 * 1024),
      };
      cyclic.self = cyclic;
      await app.db.insert(schema.sessionEvents).values({
        accountId: account!.id,
        workspaceId: workspace!.id,
        sessionId,
        sequence: 1,
        type: "agent.toolCall.output",
        payload: cyclic,
      });
      const [event] = await app.db
        .select({ payload: schema.sessionEvents.payload })
        .from(schema.sessionEvents)
        .where(
          and(eq(schema.sessionEvents.sessionId, sessionId), eq(schema.sessionEvents.sequence, 1)),
        );
      const restoredEvent = event!.payload as typeof cyclic;
      expect(restoredEvent.unsafeText).toBe(unsafeText);
      expect(restoredEvent.oversized).toBe(cyclic.oversized);
      expect(restoredEvent.self).toBe(restoredEvent);

      const largeQueryablePayload = { type: "synthetic", body: "y".repeat(96 * 1024) };
      await app.db.insert(schema.sessionEvents).values({
        accountId: account!.id,
        workspaceId: workspace!.id,
        sessionId,
        sequence: 2,
        type: "agent.toolCall.output",
        payload: largeQueryablePayload,
      });
      const [largeEvent] = await admin<
        Array<{ payload: typeof largeQueryablePayload; bytes: number }>
      >`
        select payload, octet_length(payload::text)::integer as bytes
        from session_events where session_id = ${sessionId} and sequence = 2`;
      expect(largeEvent!.bytes).toBeGreaterThan(65_536);
      expect(largeEvent!.payload).toEqual(largeQueryablePayload);
      const fullPage = await listSessionEventPage(app.db, workspace!.id, sessionId, {
        payloadMode: "full",
        maxBytes: 256 * 1024,
      });
      expect(fullPage.events.find((candidate) => candidate.sequence === 2)?.payload).toEqual(
        largeQueryablePayload,
      );

      const historyItem = { type: "message", role: "user", content: unsafeText };
      await app.db.insert(schema.sessionHistoryItems).values({
        accountId: account!.id,
        workspaceId: workspace!.id,
        sessionId,
        position: 0,
        item: historyItem,
      });
      const [history] = await app.db
        .select({ item: schema.sessionHistoryItems.item })
        .from(schema.sessionHistoryItems)
        .where(
          and(
            eq(schema.sessionHistoryItems.workspaceId, workspace!.id),
            eq(schema.sessionHistoryItems.sessionId, sessionId),
            eq(schema.sessionHistoryItems.position, 0),
          ),
        );
      expect(history!.item).toEqual(historyItem);

      const [rig] = await admin<{ id: string }[]>`
        insert into rigs (account_id, workspace_id, name)
        values (${account!.id}, ${workspace!.id}, 'lossless-rig') returning id`;
      const rigPayload = { command: unsafeText };
      const verification: Record<string, unknown> = { log: unsafeText };
      verification.self = verification;
      await app.db.insert(schema.rigChanges).values({
        accountId: account!.id,
        workspaceId: workspace!.id,
        rigId: rig!.id,
        kind: "setup_append",
        payload: rigPayload,
        verification,
      });
      const [change] = await app.db
        .select({
          payload: schema.rigChanges.payload,
          verification: schema.rigChanges.verification,
        })
        .from(schema.rigChanges)
        .where(
          and(
            eq(schema.rigChanges.workspaceId, workspace!.id),
            eq(schema.rigChanges.rigId, rig!.id),
          ),
        );
      expect(change!.payload).toEqual(rigPayload);
      const restoredVerification = change!.verification as typeof verification;
      expect(restoredVerification.log).toBe(unsafeText);
      expect(restoredVerification.self).toBe(restoredVerification);

      await app.db.insert(schema.sessionRecordings).values({
        accountId: account!.id,
        workspaceId: workspace!.id,
        sessionId,
        state: "failed",
        mode: "on-turn",
        codec: "h264-mp4",
        width: 1280,
        height: 720,
        reason: unsafeText,
      });
      const [recording] = await app.db
        .select({ reason: schema.sessionRecordings.reason })
        .from(schema.sessionRecordings)
        .where(eq(schema.sessionRecordings.sessionId, sessionId));
      expect(recording!.reason).toBe(unsafeText);

      const [posture] = await admin<
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
    } finally {
      await app.close();
      await admin.end();
    }
  }, 180_000);
});
