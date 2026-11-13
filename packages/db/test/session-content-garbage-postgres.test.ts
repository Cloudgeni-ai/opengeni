/**
 * Migration 1359: unreferenced session content blobs are collected. A
 * replaced model-request snapshot leaves the body chunks only it named; the
 * collector deletes exactly those, never a blob a snapshot or tool catalog
 * still names, never a recent one, never while a writer or reader holds the
 * session's content lock, and never in an archiving or other workspace's
 * session.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createAttemptToolEnvironment } from "@opengeni/codemode";
import type { ModelContextSnapshot } from "@opengeni/contracts";
import {
  acquireSharedTestDatabase,
  grantDeferredRuntimeAccess,
  type SharedTestDatabase,
} from "@opengeni/testing/shared-pg";
import { sql } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import {
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  collectSessionContentGarbage,
  collectSessionContentGarbagePass,
  createDb,
  createSession,
  getAttemptToolCatalog,
  getLatestSessionModelContext,
  initializeSessionStartAtomically,
  listSessionContentGarbageCandidates,
  lockSessionContentShared,
  persistAttemptToolCatalog,
  persistModelContextSnapshot,
  withRlsContext,
} from "../src";
import { rawRows } from "../src/database";

setDefaultTimeout(60_000);

let shared: SharedTestDatabase | null = null;
let client: ReturnType<typeof createDb>;
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("session-content-garbage");
  if (!shared) {
    if (requireRealDatabase) throw new Error("session content garbage PostgreSQL is unavailable");
    console.warn("[session-content-garbage] postgres unavailable, skipping");
    return;
  }
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
});

type Scope = Awaited<ReturnType<typeof fixture>>;

async function fixture() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `garbage-account-${suffix}`,
    accountName: "Session content garbage test",
    workspaceExternalSource: "test",
    workspaceExternalId: `garbage-workspace-${suffix}`,
    workspaceName: "Session content garbage test",
    subjectId: `garbage-subject-${suffix}`,
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
    tools: [],
    skills: [],
    tokens: { instructions: 400, tools: 0, prefix: 400 },
  };
}

/** A request body whose items change from `from` on, like a rewritten history. */
function conversation(items: number, from: number, tag: string): string {
  let text = "";
  for (let index = 0; index < items; index += 1) {
    const label = index >= from ? `${tag}-${index}` : `turn-${index}`;
    text += `{"type":"message","role":"user","content":"${label} ${"x".repeat(index % 53)}"},`;
  }
  return `{"input":[${text}]}`;
}

async function persistCatalog(scope: Scope) {
  const catalog = createAttemptToolEnvironment({
    scope,
    generation: 1,
    createdAt: new Date("2026-10-08T12:00:00.000Z"),
    definitions: ["search", "fetch"].map((toolName) => ({
      identity: { serverId: "docs", toolName },
      modelName: `docs__${toolName}`,
      description: `Run ${toolName} `.repeat(50),
      inputSchema: { type: "object", additionalProperties: true },
      source: "docs" as const,
      approval: "none" as const,
      execute: async () => ({ content: [] }),
    })),
  }).catalog;
  await persistAttemptToolCatalog(client.db, catalog);
  return catalog;
}

async function blobDigests(scope: Scope): Promise<string[]> {
  const rows = await shared!.admin<{ digest: string }[]>`
    select digest from session_content_blobs
    where workspace_id = ${scope.workspaceId} and session_id = ${scope.sessionId}
    order by digest`;
  return rows.map((row) => row.digest);
}

/** The digests the session's stored rows name, read independently of the collector. */
async function referencedDigests(scope: Scope): Promise<string[]> {
  const rows = await shared!.admin<{ refs: unknown }[]>`
    select content_refs as refs from session_attempt_model_context_snapshots
    where session_id = ${scope.sessionId} and content_refs is not null
    union all
    select content_refs from session_attempt_tool_catalogs
    where session_id = ${scope.sessionId} and content_refs is not null`;
  const digests = new Set<string>();
  for (const { refs } of rows) {
    const value = refs as Record<string, unknown>;
    for (const item of Object.values(value)) {
      if (typeof item === "string" && /^[0-9a-f]{64}$/.test(item)) digests.add(item);
      if (Array.isArray(item)) for (const digest of item) digests.add(digest as string);
    }
  }
  return [...digests].sort();
}

async function age(scope: Scope, interval: string) {
  await shared!.admin.unsafe(
    `update session_content_blobs set created_at = created_at - interval '${interval}'
     where session_id = $1`,
    [scope.sessionId],
  );
}

async function forgetCollection(scope: Scope) {
  await shared!.admin`
    delete from opengeni_private.session_content_collections where session_id = ${scope.sessionId}`;
}

const farDeadline = () => Date.now() + 60_000;

describe("session content garbage collection", () => {
  test("the migrated runtime role runs the collection pass without extra grants", async () => {
    if (!shared) return;
    const scope = await fixture();
    await persistModelContextSnapshot(client.db, {
      ...scope,
      snapshot: snapshotFixture(1, conversation(3_000, 3_000, "a")),
    });
    await persistModelContextSnapshot(client.db, {
      ...scope,
      snapshot: snapshotFixture(2, conversation(3_000, 100, "b")),
    });
    await age(scope, "1 hour");
    expect((await blobDigests(scope)).length).toBeGreaterThan(
      (await referencedDigests(scope)).length,
    );
    const pass = await collectSessionContentGarbagePass(client.db, { deadline: farDeadline() });
    expect(pass.available).toBe(true);
    expect(pass.failed).toBe(0);
    expect(await blobDigests(scope)).toEqual(await referencedDigests(scope));
  });

  test("deletes exactly the blobs no row names, and every stored value still reads back", async () => {
    if (!shared) return;
    await grantDeferredRuntimeAccess(shared.admin);
    const scope = await fixture();
    const catalog = await persistCatalog(scope);
    const requests = [
      snapshotFixture(1, conversation(3_000, 3_000, "a")),
      snapshotFixture(2, conversation(3_000, 200, "b")),
      snapshotFixture(3, conversation(3_100, 1_500, "c")),
    ];
    for (const snapshot of requests) {
      await persistModelContextSnapshot(client.db, { ...scope, snapshot });
    }
    await age(scope, "1 hour");
    const stored = await blobDigests(scope);
    const referenced = await referencedDigests(scope);
    expect(stored.length).toBeGreaterThan(referenced.length);

    const pass = await collectSessionContentGarbagePass(client.db, {
      deadline: farDeadline(),
      blobsPerCall: 3,
    });
    expect(pass.available).toBe(true);
    expect(pass.failed).toBe(0);
    // The pass also collects the other sessions earlier tests left behind.
    expect(pass.deleted).toBeGreaterThanOrEqual(stored.length - referenced.length);
    expect(await blobDigests(scope)).toEqual(referenced);
    expect((await getLatestSessionModelContext(client.db, scope)).snapshot).toEqual(requests[2]!);
    expect(await getAttemptToolCatalog(client.db, scope)).toEqual(catalog);

    // Collected: not listed again until a snapshot changes and ten minutes pass.
    const listed = await listSessionContentGarbageCandidates(client.db, 1_000);
    expect(listed.map((candidate) => candidate.sessionId)).not.toContain(scope.sessionId);
    expect(await collectSessionContentGarbage(client.db, scope, 100)).toBe(0);
  });

  test("keeps unreferenced blobs younger than ten minutes", async () => {
    if (!shared) return;
    await grantDeferredRuntimeAccess(shared.admin);
    const scope = await fixture();
    await persistModelContextSnapshot(client.db, {
      ...scope,
      snapshot: snapshotFixture(1, conversation(3_000, 3_000, "a")),
    });
    await persistModelContextSnapshot(client.db, {
      ...scope,
      snapshot: snapshotFixture(2, conversation(3_000, 100, "b")),
    });
    await age(scope, "5 minutes");
    const before = await blobDigests(scope);
    expect(before.length).toBeGreaterThan((await referencedDigests(scope)).length);
    expect(await collectSessionContentGarbage(client.db, scope, 1_000)).toBe(0);
    expect(await blobDigests(scope)).toEqual(before);
  });

  test("never deletes while a writer or reader holds the session content lock", async () => {
    if (!shared) return;
    await grantDeferredRuntimeAccess(shared.admin);
    const scope = await fixture();
    await persistModelContextSnapshot(client.db, {
      ...scope,
      snapshot: snapshotFixture(1, conversation(3_000, 3_000, "a")),
    });
    await persistModelContextSnapshot(client.db, {
      ...scope,
      snapshot: snapshotFixture(2, conversation(3_000, 100, "b")),
    });
    await age(scope, "1 hour");
    const before = await blobDigests(scope);

    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const holding = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = withRlsContext(
      client.db,
      { accountId: scope.accountId, workspaceId: scope.workspaceId },
      async (tx) => {
        await lockSessionContentShared(tx, scope.sessionId);
        locked();
        await released;
      },
    );
    await holding;
    try {
      expect(await collectSessionContentGarbage(client.db, scope, 1_000)).toBe(0);
      expect(await blobDigests(scope)).toEqual(before);
    } finally {
      release();
      await holder;
    }
    expect(await collectSessionContentGarbage(client.db, scope, 1_000)).toBeGreaterThan(0);
    expect(await blobDigests(scope)).toEqual(await referencedDigests(scope));
  });

  test("leaves archiving sessions and other workspaces' sessions alone", async () => {
    if (!shared) return;
    await grantDeferredRuntimeAccess(shared.admin);
    const scope = await fixture();
    const other = await fixture();
    for (const target of [scope, other]) {
      await persistModelContextSnapshot(client.db, {
        ...target,
        snapshot: snapshotFixture(1, conversation(3_000, 3_000, "a")),
      });
      await persistModelContextSnapshot(client.db, {
        ...target,
        snapshot: snapshotFixture(2, conversation(3_000, 100, "b")),
      });
      await age(target, "1 hour");
    }
    const otherBefore = await blobDigests(other);
    // The other session, named from this workspace's RLS context.
    expect(
      await collectSessionContentGarbage(
        client.db,
        { accountId: scope.accountId, workspaceId: scope.workspaceId, sessionId: other.sessionId },
        1_000,
      ),
    ).toBe(0);
    const [direct] = await withRlsContext(
      client.db,
      { accountId: scope.accountId, workspaceId: scope.workspaceId },
      async (tx) =>
        await rawRows<{ deleted: number }>(
          tx,
          sql`select opengeni_private.collect_session_content_garbage_v1(
            ${other.workspaceId}::uuid, ${other.sessionId}::uuid, 1000) as deleted`,
        ),
    );
    expect(direct!.deleted).toBe(0);
    expect(await blobDigests(other)).toEqual(otherBefore);

    const before = await blobDigests(scope);
    await shared.admin`
      update sessions set content_archive_state = 'archiving',
        content_archive_started_at = now(), content_archive = '{}'::jsonb
      where id = ${scope.sessionId}`;
    await forgetCollection(scope);
    const listed = await listSessionContentGarbageCandidates(client.db, 1_000);
    expect(listed.map((candidate) => candidate.sessionId)).not.toContain(scope.sessionId);
    expect(await collectSessionContentGarbage(client.db, scope, 1_000)).toBe(0);
    expect(await blobDigests(scope)).toEqual(before);
  });

  test("revisits a collected session once a later snapshot leaves new garbage", async () => {
    if (!shared) return;
    await grantDeferredRuntimeAccess(shared.admin);
    const scope = await fixture();
    await persistModelContextSnapshot(client.db, {
      ...scope,
      snapshot: snapshotFixture(1, conversation(3_000, 3_000, "a")),
    });
    await age(scope, "1 hour");
    expect(await collectSessionContentGarbage(client.db, scope, 1_000)).toBe(0);
    const listed = async () =>
      (await listSessionContentGarbageCandidates(client.db, 1_000)).map((row) => row.sessionId);
    expect(await listed()).not.toContain(scope.sessionId);

    // A later request replaces the snapshot. Its capture is after the point the
    // session was collected to; once that point is old enough it is listed.
    const later = {
      ...snapshotFixture(2, conversation(3_000, 50, "b")),
      capturedAt: new Date().toISOString(),
    };
    await persistModelContextSnapshot(client.db, { ...scope, snapshot: later });
    expect(await listed()).not.toContain(scope.sessionId);
    await shared.admin`
      update opengeni_private.session_content_collections
      set collected_before = collected_before - interval '30 minutes'
      where session_id = ${scope.sessionId}`;
    await age(scope, "1 hour");
    expect(await listed()).toContain(scope.sessionId);
    expect(await collectSessionContentGarbage(client.db, scope, 1_000)).toBeGreaterThan(0);
    expect(await blobDigests(scope)).toEqual(await referencedDigests(scope));
    expect((await getLatestSessionModelContext(client.db, scope)).snapshot).toEqual(later);
  });

  test("the documented operator block collects as the table owner", async () => {
    if (!shared) return;
    const scope = await fixture();
    const catalog = await persistCatalog(scope);
    const requests = [
      snapshotFixture(1, conversation(3_000, 3_000, "a")),
      snapshotFixture(2, conversation(3_000, 100, "b")),
    ];
    for (const snapshot of requests) {
      await persistModelContextSnapshot(client.db, { ...scope, snapshot });
    }
    await age(scope, "1 hour");
    const referenced = await referencedDigests(scope);
    expect((await blobDigests(scope)).length).toBeGreaterThan(referenced.length);

    // Runs exactly the block the storage lifecycle doc gives operators.
    const doc = await readFile(
      resolvePath(import.meta.dir, "../../../docs/session-storage-lifecycle.md"),
      "utf8",
    );
    const section = doc.slice(doc.indexOf("### Collecting unreferenced blobs"));
    const block = /```sql\n([\s\S]*?)```/.exec(section)?.[1];
    expect(block).toContain("collect_session_content_garbage_v1");
    await shared.admin.unsafe(block!);

    expect(await blobDigests(scope)).toEqual(referenced);
    expect((await getLatestSessionModelContext(client.db, scope)).snapshot).toEqual(requests[1]!);
    expect(await getAttemptToolCatalog(client.db, scope)).toEqual(catalog);
  });
});
