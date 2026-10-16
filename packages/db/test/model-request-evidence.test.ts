import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ModelRequestEvidence } from "@opengeni/contracts";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  appendSessionEventsForTurnAttempt,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  applySessionTurnSettlement,
  beginSessionArchive,
  completeSessionArchive,
  purgeArchivedSessionContent,
  createDb,
  createSession,
  initializeSessionStartAtomically,
  SESSION_ARCHIVE_EXPORT_TABLES,
  readSessionArchiveRows,
  withRlsContext,
  readSessionContentBlobs,
} from "../src";
import {
  decodeModelEvidenceContent,
  encodeModelEvidenceContent,
  getSessionModelEvidence,
  storeModelEvidenceContent,
} from "../src/model-request-evidence";

const record = (
  ordinal = 1,
  content: unknown = { body: "system prompt, tools and input" },
): ModelRequestEvidence => ({
  version: 1,
  scopeId: "scope-one",
  ordinal,
  purpose: "main",
  kind: "request",
  status: "captured",
  content,
  physical: { requestId: "physical-one", transportAttempt: 1, identitySource: "codex_custody" },
});

describe("model evidence content codec", () => {
  test("lossless chunking, repetition deduplication and exact source text", () => {
    const original = record(1, {
      body: "x\u0000😀".repeat(30_000),
      partial: { head: "first", tail: "last", truncated: true },
      error: "exit 2",
    });
    const encoded = encodeModelEvidenceContent(original);
    expect(encoded.stored.content).toBeNull();
    expect(JSON.stringify(encoded.stored)).not.toContain("first");
    expect(decodeModelEvidenceContent(encoded.stored, encoded.blobs)).toEqual(original);
    expect([...encodeModelEvidenceContent(original).blobs]).toEqual([...encoded.blobs]);
  });
  test("missing or changed content is a gap, never empty data", () => {
    const encoded = encodeModelEvidenceContent(record());
    expect(() => decodeModelEvidenceContent(encoded.stored, new Map())).toThrow(
      "missing or corrupt",
    );
    const corrupt = new Map(encoded.blobs);
    corrupt.set(encoded.stored.contentRefs[0]!, "different");
    expect(() => decodeModelEvidenceContent(encoded.stored, corrupt)).toThrow("missing or corrupt");
  });
  test("archive bundle carries both owning events and every referenced blob", () => {
    expect(SESSION_ARCHIVE_EXPORT_TABLES.some((table) => table.table === "session_events")).toBe(
      true,
    );
    expect(
      SESSION_ARCHIVE_EXPORT_TABLES.some((table) => table.table === "session_content_blobs"),
    ).toBe(true);
  });
});

describe("model evidence exact-attempt persistence and export", () => {
  let shared: SharedTestDatabase;
  let client: ReturnType<typeof createDb>;
  beforeAll(async () => {
    const acquired = await acquireSharedTestDatabase("model-evidence");
    if (!acquired) throw new Error("PostgreSQL fixture required; not a synthetic persistence pass");
    shared = acquired;
    client = createDb(shared.appUrl);
  }, 180_000);
  afterAll(async () => {
    await client?.close();
    await shared?.release();
  }, 60_000);

  async function fixture() {
    const id = crypto.randomUUID();
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId: `evidence-${id}`,
      accountName: "Evidence fixture",
      workspaceExternalSource: "test",
      workspaceExternalId: `evidence-${id}`,
      workspaceName: "Evidence fixture",
      subjectId: `evidence-${id}`,
    });
    const grant = access.workspaceGrants[0]!;
    const session = await createSession(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      initialMessage: "fixture",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    await initializeSessionStartAtomically(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      sessionId: session.id,
      reasoningEffortFallback: "medium",
      createdEventPayload: {},
    });
    const attemptId = crypto.randomUUID();
    const claimed = await claimSessionWorkForAttempt(client.db, grant.workspaceId!, {
      sessionId: session.id,
      workflowId: `fixture-${id}`,
      workflowRunId: crypto.randomUUID(),
      dispatchId: crypto.randomUUID(),
      attemptId,
      trigger: { kind: "next" },
    });
    if (claimed.action !== "claimed") throw new Error("fixture claim failed");
    return {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      sessionId: session.id,
      turnId: claimed.turn.id,
      triggerEventId: claimed.turn.triggerEventId,
      attemptId,
      executionGeneration: claimed.turn.executionGeneration,
    };
  }
  type Scope = Awaited<ReturnType<typeof fixture>>;
  async function append(scope: Scope, evidence: ModelRequestEvidence) {
    const stored = await storeModelEvidenceContent(client.db, { ...scope, record: evidence });
    return appendSessionEventsForTurnAttempt(
      client.db,
      scope.workspaceId,
      scope.sessionId,
      scope.turnId,
      scope.executionGeneration,
      scope.attemptId,
      [
        {
          type: "agent.model.evidence",
          payload: stored,
          producerId: "evidence-fixture",
          producerSeq: evidence.ordinal,
        },
      ],
    );
  }

  test("concurrent records remain append-only, paginated and exactly hydrated", async () => {
    const scope = await fixture();
    await Promise.all([
      append(scope, record(1)),
      append(scope, record(2, { body: "different response" })),
    ]);
    const expected = encodeModelEvidenceContent(record());
    await withRlsContext(client.db, scope, async (tx) => {
      expect(
        decodeModelEvidenceContent(
          expected.stored,
          await readSessionContentBlobs(tx, scope, expected.stored.contentRefs),
        ),
      ).toEqual(record());
    });
    const first = await getSessionModelEvidence(client.db, { ...scope, limit: 1 });
    expect(first.events).toHaveLength(1);
    expect(first.hasMore).toBe(true);
    expect(first.attemptInventory.ids).toEqual([scope.attemptId]);
    expect(first.events[0]?.record.contentRefs).toBeUndefined();
    await append(scope, record(3, { body: "after watermark" }));
    const second = await getSessionModelEvidence(client.db, {
      ...scope,
      afterSequence: first.nextAfterSequence,
      throughSequence: first.throughSequence,
      limit: 1,
    });
    expect(second.events).toHaveLength(1);
    expect(second.hasMore).toBe(false);
    expect(second.events[0]?.record.ordinal).not.toBe(3);
    const latest = await getSessionModelEvidence(client.db, scope);
    expect(latest.events.map((event) => event.record.ordinal).sort()).toEqual([1, 2, 3]);
  }, 30_000);

  test("invalid and future cursors fail explicitly", async () => {
    const scope = await fixture();
    await expect(getSessionModelEvidence(client.db, { ...scope, limit: 0 })).rejects.toBeInstanceOf(
      RangeError,
    );
    await expect(
      getSessionModelEvidence(client.db, { ...scope, afterSequence: 100_000 }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      getSessionModelEvidence(client.db, { ...scope, throughSequence: 100_000 }),
    ).rejects.toBeInstanceOf(RangeError);
  }, 30_000);

  test("exact generation mismatch and stale publisher cannot certify current evidence", async () => {
    const scope = await fixture();
    await expect(
      storeModelEvidenceContent(client.db, {
        ...scope,
        executionGeneration: scope.executionGeneration + 1,
        record: record(),
      }),
    ).rejects.toThrow("exact attempt mismatch");
    const stored = await storeModelEvidenceContent(client.db, { ...scope, record: record() });
    const rejected = await appendSessionEventsForTurnAttempt(
      client.db,
      scope.workspaceId,
      scope.sessionId,
      scope.turnId,
      scope.executionGeneration + 1,
      scope.attemptId,
      [
        {
          type: "agent.model.evidence",
          payload: stored,
          producerId: "stale-fixture",
          producerSeq: 1,
        },
      ],
    );
    expect(rejected.accepted).toBe(false);
    expect((await getSessionModelEvidence(client.db, scope)).events).toHaveLength(0);
  }, 30_000);

  test("RLS and session scoping prevent cross-session hydration", async () => {
    const scope = await fixture(),
      other = await fixture();
    await append(scope, record());
    await expect(
      getSessionModelEvidence(client.db, {
        ...scope,
        workspaceId: other.workspaceId,
        accountId: other.accountId,
      }),
    ).rejects.toThrow("Session not found");
    expect((await getSessionModelEvidence(client.db, other)).events).toHaveLength(0);
  }, 30_000);

  test("missing blob returns explicit unavailable, not last snapshot or zero", async () => {
    const scope = await fixture();
    await append(scope, record());
    // Corruption fixture is performed only through the disposable test admin;
    // application DELETE is deliberately denied on append-only content blobs.
    await shared.admin`delete from session_content_blobs where workspace_id = ${scope.workspaceId}::uuid and session_id = ${scope.sessionId}::uuid`;
    const page = await getSessionModelEvidence(client.db, scope);
    expect(page.events[0]?.record.status).toBe("unavailable");
    expect(page.events[0]?.record.reason).toBe("stored_content_missing_or_corrupt");
  }, 30_000);

  test("existing archive row export retains exact manifests and chunks for offline hydration", async () => {
    const scope = await fixture();
    const original = record(1, { body: "archive\u0000😀".repeat(1000) });
    await append(scope, original);
    const eventSpec = SESSION_ARCHIVE_EXPORT_TABLES.find(
      (table) => table.table === "session_events",
    )!;
    const blobSpec = SESSION_ARCHIVE_EXPORT_TABLES.find(
      (table) => table.table === "session_content_blobs",
    )!;
    const eventRows = await readSessionArchiveRows(client.db, scope, eventSpec, {
      after: null,
      limit: 100,
    });
    const blobRows = await readSessionArchiveRows(client.db, scope, blobSpec, {
      after: null,
      limit: 100,
    });
    expect(eventRows.rows.some((line) => line.includes("agent.model.evidence"))).toBe(true);
    expect(blobRows.rows.length).toBeGreaterThan(0);
    // Real row export, not reconstructed model context: codec operates on verified bundle rows.
    const blobs = new Map(
      blobRows.rows.map((line) => {
        const row = JSON.parse(line);
        return [row.digest, row.value] as [string, unknown];
      }),
    );
    const evidence = eventRows.rows
      .map((line) => JSON.parse(line))
      .find((row) => row.type === "agent.model.evidence");
    expect(decodeModelEvidenceContent(evidence.payload, blobs)).toEqual(original);
  }, 30_000);

  test("archive/purge cannot become a falsely complete empty live export", async () => {
    const scope = await fixture();
    await append(scope, record());
    await applySessionTurnSettlement(client.db, scope.workspaceId, {
      sessionId: scope.sessionId,
      turnId: scope.turnId,
      triggerEventId: scope.triggerEventId,
      attemptId: scope.attemptId,
      turnStatus: "completed",
      sessionStatus: "idle",
      activeTurnId: null,
      events: [{ type: "turn.completed", payload: { output: "model-free fixture" } }],
    });
    // Elapsed-time fixture only, following the existing archive lifecycle tests.
    await shared.admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update session_turns set created_at = created_at - interval '45 days', updated_at = updated_at - interval '45 days' where session_id = ${scope.sessionId}`;
      await tx`update sessions set created_at = created_at - interval '45 days', updated_at = updated_at - interval '45 days' where id = ${scope.sessionId}`;
    });
    const keys = ["fixture/bundle", "fixture/transcript"];
    expect(
      await beginSessionArchive(client.db, scope, { idleSeconds: 30 * 86400, objectKeys: keys }),
    ).toBe(true);
    // Fake-object manifest exercises only the DB lifecycle; no storage upload is claimed.
    expect(
      await completeSessionArchive(client.db, scope, {
        format: "opengeni.session-archive",
        version: 1,
        objectKeys: keys,
        bundle: { key: keys[0]!, bytes: 1, sha256: "a".repeat(64) },
        transcript: { key: keys[1]!, bytes: 1, sha256: "b".repeat(64), events: 1 },
        sha256: "a".repeat(64),
        rowCounts: {},
        createdAt: new Date().toISOString(),
      }),
    ).toBe(true);
    for (let i = 0; i < 30; i++)
      if ((await purgeArchivedSessionContent(client.db, scope, { batchSize: 100 })).complete) break;
    const page = await getSessionModelEvidence(client.db, scope);
    expect(page.availability).toBe("archived");
    expect(page.events).toEqual([]);
    expect(page.completeness).toBe("requires_all_pages_and_scope_check");
    expect(page.attemptInventory.ids).toEqual([scope.attemptId]);
  }, 30_000);
});
