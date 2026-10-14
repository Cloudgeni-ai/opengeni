import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createAttemptToolEnvironment } from "@opengeni/codemode";
import type { ModelContextSnapshot } from "@opengeni/contracts";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { and, eq, sql } from "drizzle-orm";
import {
  bootstrapWorkspace,
  canonicalJsonForContentDigest,
  chunkTextByContent,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  digestContentValue,
  encodeModelContextSnapshotContent,
  compactLegacySessionContent,
  compactSessionContentRow,
  getAttemptToolCatalog,
  getLatestSessionModelContext,
  initializeSessionStartAtomically,
  persistAttemptToolCatalog,
  persistModelContextSnapshot,
  writeSessionContentBlobs,
  withRlsContext,
} from "../src";
import { rawRows } from "../src/database";
import * as schema from "../src/schema";

describe("session content codec", () => {
  test("digests are independent of object key order", () => {
    const left = { b: [1, { y: 2, x: "z" }], a: null };
    const right = { a: null, b: [1, { x: "z", y: 2 }] };
    expect(canonicalJsonForContentDigest(left)).toBe(canonicalJsonForContentDigest(right));
    expect(digestContentValue(left)).toBe(digestContentValue(right));
    expect(digestContentValue([1, 2])).not.toBe(digestContentValue([2, 1]));
  });

  test("content-defined chunks concatenate exactly and survive appended content", () => {
    let text = "";
    for (let index = 0; index < 4_000; index += 1) {
      text += `{"role":"user","content":"message ${index} ${"x".repeat(index % 97)}"},`;
    }
    const chunks = chunkTextByContent(text);
    expect(chunks.join("")).toBe(text);
    expect(chunks.length).toBeGreaterThan(5);
    expect(Math.max(...chunks.map((chunk) => chunk.length))).toBeLessThanOrEqual(65_536);

    const grown = `${text}{"role":"assistant","content":"a new reply"}`;
    const grownChunks = chunkTextByContent(grown);
    expect(grownChunks.join("")).toBe(grown);
    const shared = new Set(chunks);
    const reused = grownChunks.filter((chunk) => shared.has(chunk)).length;
    expect(reused).toBeGreaterThanOrEqual(chunks.length - 1);
  });

  test("chunk boundaries never split a surrogate pair", () => {
    const text = "😀".repeat(70_000);
    const chunks = chunkTextByContent(text);
    expect(chunks.join("")).toBe(text);
    for (const chunk of chunks) {
      // In Unicode mode a well-formed pair is one code point; \p{Cs} matches only lone halves.
      expect(/\p{Cs}/u.test(chunk)).toBe(false);
    }
  });

  test("snapshot encoding externalizes the repeated prefix and request body", () => {
    const snapshot = snapshotFixture(1, "body ".repeat(5_000));
    const encoded = encodeModelContextSnapshotContent(snapshot);
    expect(encoded.stored.instructions).toBe("");
    expect(encoded.stored.layers).toEqual([]);
    expect(encoded.stored.tools).toEqual([]);
    expect(encoded.stored.providerRequest?.body).toBeNull();
    expect(encoded.stored.tokens).toEqual(snapshot.tokens);
    expect(encoded.refs.body?.length).toBeGreaterThan(0);
    expect(encoded.blobs.get(encoded.refs.instructions)).toBe(snapshot.instructions);
  });
});

let available = true;
let shared: SharedTestDatabase | null = null;
let client: ReturnType<typeof createDb>;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("session-content-blobs");
  if (!shared) {
    available = false;
    console.warn("[session-content-blobs] postgres unavailable, skipping");
    return;
  }
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
});

async function fixture() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `content-account-${suffix}`,
    accountName: "Session content test",
    workspaceExternalSource: "test",
    workspaceExternalId: `content-workspace-${suffix}`,
    workspaceName: "Session content test",
    subjectId: `content-subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    initialMessage: "initial",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none",
  });
  const started = await initializeSessionStartAtomically(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    sessionId: session.id,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
  });
  if (!started.turn) throw new Error("initial turn was not created");
  const attemptId = crypto.randomUUID();
  const claimed = await claimSessionWorkForAttempt(client.db, grant.workspaceId!, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    dispatchId: crypto.randomUUID(),
    attemptId,
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") throw new Error(`claim failed: ${claimed.reason}`);
  return {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    sessionId: session.id,
    turnId: claimed.turn.id,
    attemptId,
    executionGeneration: claimed.turn.executionGeneration,
  };
}

function snapshotFixture(requestIndex: number, body: string): ModelContextSnapshot {
  return {
    version: 1,
    capturedAt: new Date(Date.UTC(2026, 9, 8, 12, 0, requestIndex)).toISOString(),
    source: "model_request",
    requestIndex,
    instructions: "You are a careful assistant. ".repeat(200),
    providerRequest: {
      provider: "openai",
      body,
      parts: [{ key: "input", estimatedTokens: 10, utf8Bytes: body.length }],
    },
    layers: [
      {
        id: "persona_and_core",
        title: "Core",
        content: "Core instructions. ".repeat(100),
        utf8Bytes: 1_900,
        estimatedTokens: 400,
      },
    ],
    tools: [
      {
        name: "search",
        type: "function",
        visibility: "eager",
        description: "Search the docs",
        schema: { type: "object", properties: { query: { type: "string" } } },
        utf8Bytes: 120,
        estimatedTokens: 30,
      },
    ],
    skills: [],
    tokens: { instructions: 400, tools: 30, prefix: 430 },
  };
}

async function blobCount(scope: Awaited<ReturnType<typeof fixture>>): Promise<number> {
  return await withRlsContext(
    client.db,
    { accountId: scope.accountId, workspaceId: scope.workspaceId },
    async (scopedDb) => {
      const [row] = await scopedDb
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.sessionContentBlobs)
        .where(
          and(
            eq(schema.sessionContentBlobs.workspaceId, scope.workspaceId),
            eq(schema.sessionContentBlobs.sessionId, scope.sessionId),
          ),
        );
      return row!.count;
    },
  );
}

describe("session content blobs in PostgreSQL", () => {
  test("snapshots round-trip exactly and repeated content is stored once", async () => {
    if (!available) return;
    const scope = await fixture();
    let conversation = "";
    for (let index = 0; index < 2_000; index += 1) {
      conversation += `{"type":"message","role":"user","content":"turn ${index}"},`;
    }
    const first = snapshotFixture(1, `{"input":[${conversation}]}`);
    await persistModelContextSnapshot(client.db, { ...scope, snapshot: first });
    const afterFirst = await blobCount(scope);
    expect((await getLatestSessionModelContext(client.db, scope)).snapshot).toEqual(first);

    const second = snapshotFixture(
      2,
      `{"input":[${conversation}{"type":"message","role":"assistant","content":"done"}]}`,
    );
    await persistModelContextSnapshot(client.db, { ...scope, snapshot: second });
    expect((await getLatestSessionModelContext(client.db, scope)).snapshot).toEqual(second);
    // Only the changed tail of the body is new; instructions, layers and tools repeat.
    expect((await blobCount(scope)) - afterFirst).toBeLessThanOrEqual(2);

    const [stored] = await withRlsContext(
      client.db,
      { accountId: scope.accountId, workspaceId: scope.workspaceId },
      async (scopedDb) =>
        await scopedDb
          .select({
            snapshot: schema.sessionAttemptModelContextSnapshots.snapshot,
            contentRefs: schema.sessionAttemptModelContextSnapshots.contentRefs,
          })
          .from(schema.sessionAttemptModelContextSnapshots)
          .where(eq(schema.sessionAttemptModelContextSnapshots.attemptId, scope.attemptId)),
    );
    expect(stored!.contentRefs).not.toBeNull();
    expect(stored!.snapshot.instructions).toBe("");
    expect(stored!.snapshot.providerRequest?.body).toBeNull();
  });

  test("legacy inline snapshots remain readable", async () => {
    if (!available) return;
    const scope = await fixture();
    const legacy = snapshotFixture(1, '{"input":[]}');
    await withRlsContext(
      client.db,
      { accountId: scope.accountId, workspaceId: scope.workspaceId },
      async (scopedDb) =>
        await scopedDb.insert(schema.sessionAttemptModelContextSnapshots).values({
          attemptId: scope.attemptId,
          accountId: scope.accountId,
          workspaceId: scope.workspaceId,
          sessionId: scope.sessionId,
          turnId: scope.turnId,
          executionGeneration: scope.executionGeneration,
          requestIndex: 1,
          capturedAt: new Date(legacy.capturedAt),
          snapshot: legacy,
          createdAt: new Date(legacy.capturedAt),
          updatedAt: new Date(legacy.capturedAt),
        }),
    );
    expect((await getLatestSessionModelContext(client.db, scope)).snapshot).toEqual(legacy);
    expect(await blobCount(scope)).toBe(0);
  });

  test("tool catalogs store entries by reference and hydrate exactly", async () => {
    if (!available) return;
    const scope = await fixture();
    const catalog = createAttemptToolEnvironment({
      scope,
      generation: 1,
      createdAt: new Date("2026-10-08T12:00:00.000Z"),
      definitions: ["search", "fetch", "summarize"].map((toolName) => ({
        identity: { serverId: "docs", toolName },
        modelName: `docs__${toolName}`,
        description: `Run ${toolName} `.repeat(50),
        inputSchema: { type: "object", additionalProperties: true },
        source: "docs" as const,
        approval: "none" as const,
        execute: async () => ({ content: [] }),
      })),
    }).catalog;
    expect(await persistAttemptToolCatalog(client.db, catalog)).toEqual(catalog);
    expect(await getAttemptToolCatalog(client.db, scope)).toEqual(catalog);
    expect(await blobCount(scope)).toBe(3);

    const [stored] = await withRlsContext(
      client.db,
      { accountId: scope.accountId, workspaceId: scope.workspaceId },
      async (scopedDb) =>
        await scopedDb
          .select({
            catalog: schema.sessionAttemptToolCatalogs.catalog,
            contentRefs: schema.sessionAttemptToolCatalogs.contentRefs,
          })
          .from(schema.sessionAttemptToolCatalogs)
          .where(eq(schema.sessionAttemptToolCatalogs.attemptId, scope.attemptId)),
    );
    expect(stored!.catalog.entries).toEqual([]);
    expect(stored!.contentRefs?.entries).toHaveLength(3);
  });

  test("blobs are invisible outside their workspace", async () => {
    if (!available) return;
    const scope = await fixture();
    const other = await fixture();
    await persistModelContextSnapshot(client.db, {
      ...scope,
      snapshot: snapshotFixture(1, "x".repeat(10_000)),
    });
    expect(await blobCount(scope)).toBeGreaterThan(0);
    const leaked = await withRlsContext(
      client.db,
      { accountId: other.accountId, workspaceId: other.workspaceId },
      async (scopedDb) =>
        await scopedDb
          .select({ digest: schema.sessionContentBlobs.digest })
          .from(schema.sessionContentBlobs)
          .where(eq(schema.sessionContentBlobs.sessionId, scope.sessionId)),
    );
    expect(leaked).toEqual([]);
  });
});

async function insertLegacyRows(scope: Awaited<ReturnType<typeof fixture>>) {
  const catalog = createAttemptToolEnvironment({
    scope,
    generation: 1,
    createdAt: new Date("2026-10-08T12:00:00.000Z"),
    definitions: ["alpha", "beta"].map((toolName) => ({
      identity: { serverId: "docs", toolName },
      modelName: `docs__${toolName}`,
      description: `Legacy ${toolName}`,
      inputSchema: { type: "object", additionalProperties: true },
      source: "docs" as const,
      approval: "none" as const,
      execute: async () => ({ content: [] }),
    })),
  }).catalog;
  const snapshot = snapshotFixture(1, `{"input":[${'{"role":"user"},'.repeat(3_000)}]}`);
  await withRlsContext(
    client.db,
    { accountId: scope.accountId, workspaceId: scope.workspaceId },
    async (scopedDb) => {
      await scopedDb.insert(schema.sessionAttemptToolCatalogs).values({
        attemptId: scope.attemptId,
        accountId: scope.accountId,
        workspaceId: scope.workspaceId,
        sessionId: scope.sessionId,
        turnId: scope.turnId,
        executionGeneration: scope.executionGeneration,
        catalogVersion: catalog.version,
        generation: catalog.generation,
        digest: catalog.digest,
        catalog,
        createdAt: new Date(catalog.createdAt),
      });
      await scopedDb.insert(schema.sessionAttemptModelContextSnapshots).values({
        attemptId: scope.attemptId,
        accountId: scope.accountId,
        workspaceId: scope.workspaceId,
        sessionId: scope.sessionId,
        turnId: scope.turnId,
        executionGeneration: scope.executionGeneration,
        requestIndex: 1,
        capturedAt: new Date(snapshot.capturedAt),
        snapshot,
        createdAt: new Date(snapshot.capturedAt),
        updatedAt: new Date(snapshot.capturedAt),
      });
    },
  );
  return { catalog, snapshot };
}

async function storedRefs(scope: Awaited<ReturnType<typeof fixture>>) {
  return await withRlsContext(
    client.db,
    { accountId: scope.accountId, workspaceId: scope.workspaceId },
    async (scopedDb) => {
      const [catalog] = await scopedDb
        .select({ refs: schema.sessionAttemptToolCatalogs.contentRefs })
        .from(schema.sessionAttemptToolCatalogs)
        .where(eq(schema.sessionAttemptToolCatalogs.attemptId, scope.attemptId));
      const [snapshot] = await scopedDb
        .select({ refs: schema.sessionAttemptModelContextSnapshots.contentRefs })
        .from(schema.sessionAttemptModelContextSnapshots)
        .where(eq(schema.sessionAttemptModelContextSnapshots.attemptId, scope.attemptId));
      return { catalog: catalog?.refs ?? null, snapshot: snapshot?.refs ?? null };
    },
  );
}

describe("legacy session content compaction", () => {
  test("rewrites legacy rows losslessly across workspaces and is idempotent", async () => {
    if (!available) return;
    const first = await fixture();
    const second = await fixture();
    const firstLegacy = await insertLegacyRows(first);
    const secondLegacy = await insertLegacyRows(second);

    const outcome = await compactLegacySessionContent(client.db, { batchSize: 1 });
    expect(outcome.failed).toBe(0);
    expect(outcome.compacted).toBeGreaterThanOrEqual(4);

    for (const [scope, legacy] of [
      [first, firstLegacy],
      [second, secondLegacy],
    ] as const) {
      const refs = await storedRefs(scope);
      expect(refs.catalog).not.toBeNull();
      expect(refs.snapshot).not.toBeNull();
      expect(await getAttemptToolCatalog(client.db, scope)).toEqual(legacy.catalog);
      expect((await getLatestSessionModelContext(client.db, scope)).snapshot).toEqual(
        legacy.snapshot,
      );
    }

    const again = await compactLegacySessionContent(client.db);
    expect(again.compacted).toBe(0);
  });

  test("refuses a rewrite whose blobs do not rebuild the original content", async () => {
    if (!available) return;
    const scope = await fixture();
    const legacy = await insertLegacyRows(scope);
    const forged = { ...legacy.catalog.entries[0]!, description: "forged" };
    const blobs = new Map<string, unknown>([[digestContentValue(forged), forged]]);
    const refused = await withRlsContext(
      client.db,
      { accountId: scope.accountId, workspaceId: scope.workspaceId },
      async (scopedDb) => {
        await writeSessionContentBlobs(scopedDb, scope, blobs);
        const [row] = await rawRows<{ compacted: boolean }>(
          scopedDb,
          sql`select opengeni_private.compact_session_content_row(
            'tool_catalog', ${scope.workspaceId}::uuid, ${scope.attemptId}::uuid,
            ${JSON.stringify({ ...legacy.catalog, entries: [] })}::jsonb,
            ${JSON.stringify({ v: 1, entries: [digestContentValue(forged), digestContentValue(forged)] })}::jsonb
          ) as compacted`,
        );
        return row!.compacted;
      },
    );
    expect(refused).toBe(false);
    expect((await storedRefs(scope)).catalog).toBeNull();
    expect(await getAttemptToolCatalog(client.db, scope)).toEqual(legacy.catalog);

    expect(
      await compactSessionContentRow(client.db, {
        kind: "tool_catalog",
        attemptId: scope.attemptId,
        accountId: scope.accountId,
        workspaceId: scope.workspaceId,
        sessionId: scope.sessionId,
      }),
    ).toBe(true);
    expect(await getAttemptToolCatalog(client.db, scope)).toEqual(legacy.catalog);
  });
});
