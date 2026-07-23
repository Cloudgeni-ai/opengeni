import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { SESSION_EVENT_RAW_DELTA_TYPES, resolveSessionEventTypeFilters } from "@opengeni/contracts";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { eq } from "drizzle-orm";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  listSessionEventPage,
  withWorkspaceRls,
} from "../src";
import * as schema from "../src/schema";

setDefaultTimeout(180_000);

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
let workspaceId: string;
let sessionId: string;
let otherWorkspaceId: string;
let otherSessionId: string;

async function createFixture(label: string): Promise<{
  accountId: string;
  workspaceId: string;
  sessionId: string;
}> {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `${label}-account-${suffix}`,
    accountName: `${label} account`,
    workspaceExternalSource: "test",
    workspaceExternalId: `${label}-workspace-${suffix}`,
    workspaceName: `${label} workspace`,
    subjectId: `${label}-subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    initialMessage: `${label} session`,
    resources: [],
    metadata: {},
    model: "test-model",
    sandboxBackend: "none",
  });
  return {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    sessionId: session.id,
  };
}

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("session-event-monitoring");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 2 });

  const fixture = await createFixture("monitoring");
  workspaceId = fixture.workspaceId;
  sessionId = fixture.sessionId;
  const other = await createFixture("other-tenant");
  otherWorkspaceId = other.workspaceId;
  otherSessionId = other.sessionId;

  await shared.admin`
    insert into session_events (
      account_id, workspace_id, session_id, sequence, type, payload, turn_generation
    )
    select ${fixture.accountId}, ${workspaceId}, ${sessionId}, sequence,
      case when sequence = 100000 then 'agent.reasoning.delta' else 'agent.message.delta' end,
      ${shared.admin.json({ text: "raw-token-fragment" })}, 1
    from generate_series(1, 200000) as sequence`;
  await shared.admin`
    insert into session_events (
      account_id, workspace_id, session_id, sequence, type, payload, turn_generation
    ) values
      (${fixture.accountId}, ${workspaceId}, ${sessionId}, 200001,
        'session.context.compacted', ${shared.admin.json({ checkpoint: "current" })}, 6),
      (${fixture.accountId}, ${workspaceId}, ${sessionId}, 200002,
        'machine.op.failed', ${shared.admin.json({ code: "OFFLINE", detail: "bounded" })}, 6),
      (${fixture.accountId}, ${workspaceId}, ${sessionId}, 200003,
        'agent.toolCall.output',
        ${shared.admin.json({ name: "sessions_list", output: "x".repeat(12000) })}, 6),
      (${fixture.accountId}, ${workspaceId}, ${sessionId}, 200004,
        'turn.completed', ${shared.admin.json({ result: "stale" })}, 6),
      (${fixture.accountId}, ${workspaceId}, ${sessionId}, 200005,
        'turn.completed', ${shared.admin.json({ result: "authoritative" })}, 7),
      (${fixture.accountId}, ${workspaceId}, ${sessionId}, 200006,
        'agent.model.usage', ${shared.admin.json({ sourceKey: "canonical-provider-response" })}, 7)`;
  await shared.admin`
    insert into session_events (
      account_id, workspace_id, session_id, sequence, type, payload
    ) values (
      ${other.accountId}, ${otherWorkspaceId}, ${otherSessionId}, 1,
      'turn.completed', ${shared.admin.json({ secret: "other-tenant" })}
    )`;
  await shared.admin`analyze session_events`;
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

describe("session event monitoring (real PostgreSQL)", () => {
  test("reads the newest semantic tail without materializing 200,000 raw deltas", async () => {
    const page = await listSessionEventPage(client.db, workspaceId, sessionId, {
      direction: "before",
      limit: 40,
      defaultExcludeTypes: SESSION_EVENT_RAW_DELTA_TYPES,
      payloadMode: "summary",
    });

    expect(page.events.map((event) => event.sequence)).toEqual([
      200001, 200002, 200003, 200004, 200005, 200006,
    ]);
    expect(page.events.some((event) => event.type === "agent.message.delta")).toBeFalse();
    expect(page.coveredSequence).toEqual({ first: 200001, last: 200006 });
    expect(page.nextBefore).toBe(200001);
    expect(page.bytes).toBe(Buffer.byteLength(JSON.stringify(page.events), "utf8"));
    expect(page.bytes).toBeLessThan(10_000);
  });

  test("applies the shared include/exclude algebra and lets explicit includes override defaults", async () => {
    const resolved = resolveSessionEventTypeFilters({
      includeClasses: ["failure"],
      includeTypes: ["turn.completed"],
      excludeTypes: ["machine.op.failed"],
      defaultExcludeTypes: SESSION_EVENT_RAW_DELTA_TYPES,
    });
    expect(resolved.includeTypes).toContain("turn.completed");
    expect(resolved.includeTypes).toContain("turn.failed");
    expect(resolved.includeTypes).not.toContain("machine.op.failed");
    expect(resolved.excludeTypes).toEqual(
      expect.arrayContaining(["machine.op.failed", ...SESSION_EVENT_RAW_DELTA_TYPES]),
    );

    const excludedFailure = await listSessionEventPage(client.db, workspaceId, sessionId, {
      direction: "before",
      limit: 10,
      includeClasses: ["failure"],
      includeTypes: ["turn.completed"],
      excludeTypes: ["machine.op.failed"],
      defaultExcludeTypes: SESSION_EVENT_RAW_DELTA_TYPES,
      payloadMode: "none",
    });
    expect(excludedFailure.events.map((event) => event.type)).toEqual([
      "turn.completed",
      "turn.completed",
    ]);

    const explicitlyIncludedDeltas = await listSessionEventPage(client.db, workspaceId, sessionId, {
      direction: "before",
      limit: 2,
      includeTypes: ["agent.message.delta"],
      defaultExcludeTypes: SESSION_EVENT_RAW_DELTA_TYPES,
      payloadMode: "none",
    });
    expect(explicitlyIncludedDeltas.events.map((event) => event.sequence)).toEqual([
      199999, 200000,
    ]);
  });

  test("paginates both directions without gaps, duplicates, or cursor over-advance", async () => {
    const backwardSequences: number[] = [];
    let before: number | undefined;
    for (;;) {
      const page = await listSessionEventPage(client.db, workspaceId, sessionId, {
        direction: "before",
        ...(before === undefined ? {} : { before }),
        limit: 2,
        defaultExcludeTypes: SESSION_EVENT_RAW_DELTA_TYPES,
        payloadMode: "none",
      });
      backwardSequences.push(...page.events.map((event) => event.sequence));
      if (!page.hasMore) break;
      expect(page.nextBefore).not.toBeNull();
      before = page.nextBefore!;
    }
    expect([...new Set(backwardSequences)].sort((a, b) => a - b)).toEqual([
      200001, 200002, 200003, 200004, 200005, 200006,
    ]);
    expect(backwardSequences).toHaveLength(6);

    const forwardSequences: number[] = [];
    let after = 199990;
    for (;;) {
      const page = await listSessionEventPage(client.db, workspaceId, sessionId, {
        direction: "after",
        after,
        before: 200006,
        limit: 4,
        payloadMode: "none",
      });
      forwardSequences.push(...page.events.map((event) => event.sequence));
      if (!page.hasMore) break;
      expect(page.nextAfter).toBe(page.events.at(-1)!.sequence);
      after = page.nextAfter!;
    }
    expect(forwardSequences).toEqual(Array.from({ length: 15 }, (_, index) => 199991 + index));
  });

  test("keeps none, summary, and explicit full payload representations truthful", async () => {
    const options = {
      direction: "before" as const,
      limit: 1,
      includeClasses: ["tool_receipt" as const],
    };
    const none = await listSessionEventPage(client.db, workspaceId, sessionId, {
      ...options,
      payloadMode: "none",
    });
    expect(none.events[0]?.payload).toMatchObject({
      _monitoring: {
        payloadMode: "none",
        payloadOmitted: true,
        projectedPayloadBytes: expect.any(Number),
      },
    });

    const summary = await listSessionEventPage(client.db, workspaceId, sessionId, {
      ...options,
      payloadMode: "summary",
    });
    expect(summary.events[0]?.payload).toMatchObject({
      _monitoring: {
        payloadMode: "summary",
        payloadTruncated: true,
        projectedPayloadBytes: expect.any(Number),
      },
    });
    expect(Buffer.byteLength(JSON.stringify(summary.events[0]?.payload), "utf8")).toBeLessThan(
      4_096,
    );

    const full = await listSessionEventPage(client.db, workspaceId, sessionId, {
      ...options,
      payloadMode: "full",
    });
    expect(full.events[0]?.payload).toMatchObject({
      name: "sessions_list",
      output: "x".repeat(12000),
    });
  });

  test("returns authoritative typed latest events and enforces tenant RLS", async () => {
    for (const [semanticClass, sequence] of [
      ["terminal", 200005],
      ["checkpoint", 200001],
      ["tool_receipt", 200003],
    ] as const) {
      const page = await listSessionEventPage(client.db, workspaceId, sessionId, {
        direction: "before",
        limit: 1,
        includeClasses: [semanticClass],
        payloadMode: "none",
      });
      expect(page.events[0]?.sequence).toBe(sequence);
    }
    const latestTerminal = await listSessionEventPage(client.db, workspaceId, sessionId, {
      direction: "before",
      limit: 1,
      includeClasses: ["terminal"],
      payloadMode: "full",
    });
    expect(latestTerminal.events[0]).toMatchObject({
      sequence: 200005,
      turnGeneration: 7,
      payload: { result: "authoritative" },
    });

    const [session] = await shared.admin<Array<{ accountId: string }>>`
      select account_id as "accountId" from sessions where id = ${sessionId}`;
    const [canonicalProvider] = await shared.admin<Array<{ id: string }>>`
      select id from session_events
      where session_id = ${sessionId} and sequence = 200006`;
    await shared.admin`
      insert into session_events (
        account_id, workspace_id, session_id, sequence, type, payload,
        turn_generation, turn_association, duplicate_of_event_id, duplicate_reason
      ) values
        (${session!.accountId}, ${workspaceId}, ${sessionId}, 200007,
          'turn.completed', ${shared.admin.json({ result: "older-generation-later-sequence" })}, 6, 'current', null, null),
        (${session!.accountId}, ${workspaceId}, ${sessionId}, 200008,
          'turn.completed', ${shared.admin.json({ result: "late-rejected-newer" })}, 99, 'late_rejected', null, null),
        (${session!.accountId}, ${workspaceId}, ${sessionId}, 200009,
          'agent.model.usage', ${shared.admin.json({ sourceKey: "canonical-provider-response" })}, 100, 'duplicate',
          ${canonicalProvider!.id}, 'duplicate_provider_response_usage'),
        (${session!.accountId}, ${workspaceId}, ${sessionId}, 200010,
          'agent.message.completed', ${shared.admin.json({ text: "newest-authoritative-message" })}, 8, 'current', null, null),
        (${session!.accountId}, ${workspaceId}, ${sessionId}, 200011,
          'goal.completed', ${shared.admin.json({ status: "completed" })}, null, 'current', null, null)`;

    const generationFirst = await listSessionEventPage(client.db, workspaceId, sessionId, {
      direction: "before",
      limit: 1,
      includeTypes: ["turn.completed"],
      payloadMode: "full",
      authoritativeLatest: true,
    });
    expect(generationFirst.events[0]).toMatchObject({
      sequence: 200005,
      turnGeneration: 7,
      payload: { result: "authoritative" },
    });

    const providerAccount = await listSessionEventPage(client.db, workspaceId, sessionId, {
      direction: "before",
      limit: 1,
      includeClasses: ["provider_account"],
      payloadMode: "full",
      authoritativeLatest: true,
    });
    expect(providerAccount.events[0]).toMatchObject({
      sequence: 200006,
      turnGeneration: 7,
      payload: { sourceKey: "canonical-provider-response" },
      turnAssociation: null,
    });

    const authoritative = await listSessionEventPage(client.db, workspaceId, sessionId, {
      direction: "before",
      limit: 1,
      includeClasses: ["terminal"],
      payloadMode: "full",
      authoritativeLatest: true,
    });
    expect(authoritative.events[0]).toMatchObject({
      sequence: 200010,
      turnGeneration: 8,
      payload: { text: "newest-authoritative-message" },
      turnAssociation: "current",
    });

    const nullGenerationFallback = await listSessionEventPage(client.db, workspaceId, sessionId, {
      direction: "before",
      limit: 1,
      includeTypes: ["goal.completed"],
      payloadMode: "none",
      authoritativeLatest: true,
    });
    expect(nullGenerationFallback.events[0]).toMatchObject({
      sequence: 200011,
      turnGeneration: null,
      turnAssociation: "current",
    });

    const leaked = await withWorkspaceRls(client.db, workspaceId, async (scopedDb) =>
      scopedDb
        .select({ id: schema.sessionEvents.id })
        .from(schema.sessionEvents)
        .where(eq(schema.sessionEvents.sessionId, otherSessionId)),
    );
    expect(leaked).toEqual([]);
    const mismatched = await listSessionEventPage(client.db, workspaceId, otherSessionId, {
      direction: "before",
      limit: 10,
    });
    expect(mismatched.events).toEqual([]);
  });

  test("uses the rolling partial-tail and typed-sequence indexes", async () => {
    const indexes = await shared.admin<Array<{ name: string }>>`
      select indexname as name from pg_indexes
      where schemaname = 'public' and indexname in (
        'session_events_workspace_session_monitoring_tail_idx',
        'session_events_workspace_session_type_sequence_idx'
      ) order by indexname`;
    expect(indexes.map((row) => row.name)).toEqual([
      "session_events_workspace_session_monitoring_tail_idx",
      "session_events_workspace_session_type_sequence_idx",
    ]);

    const monitoringPlan = await shared.admin`
      explain (format json, costs off)
      select sequence from session_events
      where workspace_id = ${workspaceId} and session_id = ${sessionId}
        and sequence > 0
        and type not in (
          'agent.message.delta',
          'agent.reasoning.delta',
          'sandbox.command.output.delta',
          'terminal.pty.output.delta'
        )
      order by sequence desc limit 40`;
    expect(JSON.stringify(monitoringPlan)).toContain(
      "session_events_workspace_session_monitoring_tail_idx",
    );

    const typedPlan = await shared.admin`
      explain (format json, costs off)
      select sequence from session_events
      where workspace_id = ${workspaceId} and session_id = ${sessionId}
        and type = 'agent.reasoning.delta' and sequence > 0
      order by sequence desc limit 1`;
    expect(JSON.stringify(typedPlan)).toContain(
      "session_events_workspace_session_type_sequence_idx",
    );
  });
});
