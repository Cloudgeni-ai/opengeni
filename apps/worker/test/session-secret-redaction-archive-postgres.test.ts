import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import { zstdDecompressSync } from "node:zlib";
import type { ModelContextSnapshot } from "@opengeni/contracts";
import { runSessionSecretRedaction, secretRedactionMatcherForValue } from "@opengeni/core";
import * as dbModule from "@opengeni/db";
import {
  appendSessionHistoryItems,
  applySessionTurnSettlement,
  bootstrapWorkspace,
  chunkTextByContent,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  digestContentValue,
  hydrateModelContextSnapshotFromValues,
  modelContextSnapshotRefDigests,
  persistModelContextSnapshot,
  submitHumanPromptInTransaction,
  withWorkspaceSessionActivityRls,
} from "@opengeni/db";
import type { ObjectStorage } from "@opengeni/storage";
import {
  acquireSharedTestDatabase,
  grantDeferredRuntimeAccess,
  type SharedTestDatabase,
} from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import { createSessionArchiveActivities } from "../src/activities/session-archive";
import type { ActivityServices } from "../src/activities/types";

// The secret history scrub on an archived session (docs/secrets.md, "Removing
// secrets from stored history"): the bundle and transcript in object storage
// are rewritten under new keys and the manifest is swapped to them. Values are
// obviously fake.

const FAKE_TOKEN = "ghp_Fk3Q9zLm2Xv8Rt5Wy1Pn7Bc4Hd6Js0KaQe";
const SPLIT = straddlingBody(FAKE_TOKEN);
const HALVES = SPLIT.pieces;

// The manifest swap, made to fail before its commit or after it (a lost
// acknowledgement), to lose its compare-and-swap, or to fail before its
// commit with the manifest then read as gone or not readable at all, when a
// test asks for it; otherwise the real one.
let swapFault:
  | "none"
  | "before_commit"
  | "after_commit"
  | "cas_miss"
  | "reread_null"
  | "reread_error" = "none";
let swapAttempted = false;
const realSwap = dbModule.replaceSessionArchiveManifestForRedaction;
const realRead = dbModule.readSessionArchiveManifestForRedaction;
const lostConnection = () => Object.assign(new Error("connection lost"), { code: "ECONNRESET" });
mock.module("@opengeni/db", () => ({
  ...dbModule,
  replaceSessionArchiveManifestForRedaction: async (...args: Parameters<typeof realSwap>) => {
    swapAttempted = true;
    if (swapFault === "cas_miss") return false;
    if (swapFault === "before_commit" || swapFault.startsWith("reread_")) throw lostConnection();
    const swapped = await realSwap(...args);
    if (swapFault === "after_commit") throw lostConnection();
    return swapped;
  },
  readSessionArchiveManifestForRedaction: async (...args: Parameters<typeof realRead>) => {
    if (swapAttempted && swapFault === "reread_null") return null;
    if (swapAttempted && swapFault === "reread_error") throw lostConnection();
    return realRead(...args);
  },
}));

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("session-secret-redaction-archive");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  await grantDeferredRuntimeAccess(shared.admin);
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

function memoryStorage() {
  const objects = new Map<string, Uint8Array>();
  const versionOf = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  const storage = {
    backend: "s3-compatible" as const,
    async putObjectStream(input: { key: string; chunks: AsyncIterable<Uint8Array> }) {
      const chunks: Uint8Array[] = [];
      for await (const chunk of input.chunks) chunks.push(chunk);
      objects.set(input.key, Buffer.concat(chunks));
    },
    async headObject(key: string) {
      const bytes = objects.get(key);
      return bytes ? { ContentLength: bytes.length, VersionToken: versionOf(bytes) } : null;
    },
    async getObjectRange(input: {
      key: string;
      start: number;
      endInclusive: number;
      expectedVersionToken: string;
    }) {
      const bytes = objects.get(input.key);
      if (!bytes || versionOf(bytes) !== input.expectedVersionToken) return null;
      return {
        bytes: bytes.subarray(input.start, input.endInclusive + 1),
        versionToken: versionOf(bytes),
      };
    },
    async deleteObject(key: string) {
      objects.delete(key);
    },
  };
  return { objects, storage: storage as unknown as ObjectStorage };
}

/**
 * A long request body in which the secret straddles two content chunks, and
 * the pieces of the secret each chunk holds. The filler is lower case and
 * digits, so a piece with an upper-case letter or "_" is found only where the
 * secret was.
 */
function straddlingBody(secret: string): { body: string; pieces: string[] } {
  const filler = Array.from({ length: 6_000 }, (_, index) => `w${(index * 7919) % 10007}`).join(
    " ",
  );
  for (let at = 2_100; at < filler.length - secret.length; at += 13) {
    const body = `${filler.slice(0, at)}${secret}${filler.slice(at)}`;
    const pieces: string[] = [];
    let offset = 0;
    for (const chunk of chunkTextByContent(body)) {
      const start = Math.max(offset, at);
      const end = Math.min(offset + chunk.length, at + secret.length);
      if (end > start) pieces.push(body.slice(start, end));
      offset += chunk.length;
    }
    const distinct = (piece: string) => piece.length >= 3 && /[A-Z_]/u.test(piece);
    if (pieces.length > 1 && pieces.every(distinct)) return { body, pieces };
  }
  throw new Error("no body splits the secret");
}

function snapshot(body: string): ModelContextSnapshot {
  return {
    version: 1,
    capturedAt: new Date(Date.UTC(2026, 9, 26, 12, 0, 0)).toISOString(),
    source: "model_request",
    requestIndex: 1,
    instructions: "You are a careful assistant. ".repeat(200),
    providerRequest: {
      provider: "openai",
      body,
      parts: [{ key: "input", estimatedTokens: 10, utf8Bytes: body.length }],
    },
    layers: [],
    tools: [],
    skills: [],
    tokens: { instructions: 400, tools: 0, prefix: 400 },
  };
}

/** An idle, old session holding the token in its prompt, output, history and model request. */
async function idleSessionWithSecret() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: suffix,
    accountName: "Archive scrub",
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: "Archive scrub",
    subjectId: `subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    initialMessage: `Clone with ${FAKE_TOKEN}`,
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none" as const,
  });
  const scope = {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    sessionId: session.id,
  };
  await withWorkspaceSessionActivityRls(client.db, scope.workspaceId, (db) =>
    db.transaction((tx) =>
      submitHumanPromptInTransaction(tx as unknown as typeof db, {
        ...scope,
        subjectId: grant.subjectId,
        actor: { type: "human", subjectId: grant.subjectId },
        operationKey: crypto.randomUUID(),
        delivery: "send",
        text: `Push with token ${FAKE_TOKEN}`,
        resources: [],
        source: "user",
        reasoningEffortFallback: "medium",
      }),
    ),
  );
  const attemptId = crypto.randomUUID();
  const claimed = await claimSessionWorkForAttempt(client.db, scope.workspaceId, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") throw new Error("turn was not claimed");
  const turnId = claimed.turn.id;
  const executionGeneration = claimed.turn.executionGeneration;
  expect(
    await appendSessionHistoryItems(client.db, {
      ...scope,
      turnId,
      expectedExecutionGeneration: executionGeneration,
      expectedAttemptId: attemptId,
      items: [
        {
          position: 1,
          item: { type: "function_call_output", call_id: "c1", output: `token=${FAKE_TOKEN}` },
        },
      ],
    }),
  ).toBe(true);
  await persistModelContextSnapshot(client.db, {
    ...scope,
    turnId,
    attemptId,
    executionGeneration,
    snapshot: snapshot(SPLIT.body),
  });
  await applySessionTurnSettlement(client.db, scope.workspaceId, {
    sessionId: session.id,
    turnId,
    triggerEventId: claimed.turn.triggerEventId,
    attemptId,
    turnStatus: "completed",
    sessionStatus: "idle",
    activeTurnId: null,
    events: [
      { type: "agent.message.completed", payload: { text: `Pushed with ${FAKE_TOKEN}.` } },
      { type: "turn.completed", payload: { output: "Pushed." } },
    ],
  });
  await shared.admin.begin(async (sql) => {
    await sql`set local session_replication_role = replica`;
    await sql`update session_turns set created_at = created_at - interval '40 days',
        updated_at = updated_at - interval '40 days'
      where workspace_id = ${scope.workspaceId} and session_id = ${scope.sessionId}`;
    await sql`update sessions set created_at = created_at - interval '40 days',
        updated_at = updated_at - interval '40 days'
      where workspace_id = ${scope.workspaceId} and id = ${scope.sessionId}`;
  });
  return scope;
}

type Manifest = {
  objectKeys: string[];
  bundle: { key: string; bytes: number; sha256: string };
  transcript: { key: string; bytes: number; sha256: string };
  sha256: string;
  rowCounts: Record<string, number>;
};

async function manifestOf(sessionId: string): Promise<Manifest> {
  const [row] = await shared.admin`select content_archive from sessions where id = ${sessionId}`;
  return row!.content_archive as Manifest;
}

function text(bytes: Uint8Array): string {
  return new TextDecoder().decode(zstdDecompressSync(bytes));
}

describe("secret history scrub of a session archive", () => {
  test("rewrites the bundle and transcript under new keys, re-chunking split model requests", async () => {
    const scope = await idleSessionWithSecret();
    const { objects, storage } = memoryStorage();
    const archiver = createSessionArchiveActivities(
      async () =>
        ({
          db: client.db,
          objectStorage: storage,
          observability: { info: () => undefined, warn: () => undefined } as never,
          settings: testSettings({ sessionArchiveEnabled: true, sessionArchiveIdleDays: 30 }),
        }) as unknown as ActivityServices,
    );
    const archived = await archiver.archiveIdleSessions();
    expect(archived.failed).toBe(0);
    const before = await manifestOf(scope.sessionId);
    expect(text(objects.get(before.bundle.key)!)).toContain(HALVES[0]!);
    expect(text(objects.get(before.transcript.key)!)).toContain(FAKE_TOKEN);

    const matcher = secretRedactionMatcherForValue(FAKE_TOKEN, "secret:test/token")!;
    const dbScope = { accountId: scope.accountId, workspaceId: scope.workspaceId };
    const dry = await runSessionSecretRedaction(client.db, dbScope, {
      sessionIds: [scope.sessionId],
      matchers: [matcher],
      dryRun: true,
      storage,
    });
    expect(dry.failures).toEqual([]);
    expect(dry.tables.archive_bundle!.rowsMatched).toBeGreaterThan(0);
    expect(dry.tables.archive_transcript!.rowsMatched).toBeGreaterThan(0);
    expect(await manifestOf(scope.sessionId)).toEqual(before);

    // A failed upload, of the bundle or of the transcript after the bundle,
    // replaces nothing, leaves no uploaded object behind and still reports
    // what matched.
    const keysBefore = [...objects.keys()].sort();
    for (const failOnCall of [1, 2]) {
      let calls = 0;
      const refusing = {
        ...(storage as unknown as Record<string, unknown>),
        async putObjectStream(input: { key: string; chunks: AsyncIterable<Uint8Array> }) {
          calls += 1;
          if (calls === failOnCall) throw new Error("upload refused");
          await storage.putObjectStream(input as never);
        },
      } as unknown as ObjectStorage;
      const failed = await runSessionSecretRedaction(client.db, dbScope, {
        sessionIds: [scope.sessionId],
        matchers: [matcher],
        dryRun: false,
        storage: refusing,
      });
      expect(calls).toBe(failOnCall);
      expect(failed.failures.map((failure) => failure.table)).toEqual(["archive_bundle"]);
      expect(failed.tables.archive_bundle!.rowsMatched).toBe(
        dry.tables.archive_bundle!.rowsMatched,
      );
      expect(failed.tables.archive_transcript!.rowsMatched).toBe(
        dry.tables.archive_transcript!.rowsMatched,
      );
      expect(failed.tables.archive_bundle!.rowsChanged).toBe(0);
      expect(failed.tables.archive_transcript!.rowsChanged).toBe(0);
      expect(JSON.stringify(failed)).not.toContain(FAKE_TOKEN);
      expect(await manifestOf(scope.sessionId)).toEqual(before);
      expect([...objects.keys()].sort()).toEqual(keysBefore);
    }

    const run = await runSessionSecretRedaction(client.db, dbScope, {
      sessionIds: [scope.sessionId],
      matchers: [matcher],
      dryRun: false,
      storage,
    });
    expect(run.failures).toEqual([]);
    expect(run.pending).toEqual([]);
    expect(run.tables.archive_bundle!.rowsChanged).toBeGreaterThan(0);
    expect(JSON.stringify(run)).not.toContain(FAKE_TOKEN);

    const after = await manifestOf(scope.sessionId);
    expect(after.bundle.key).not.toBe(before.bundle.key);
    expect(after.transcript.key).not.toBe(before.transcript.key);
    expect(after.objectKeys).toEqual([after.bundle.key, after.transcript.key]);
    expect(after.sha256).toBe(after.bundle.sha256);
    const bundleBytes = objects.get(after.bundle.key)!;
    expect(bundleBytes.byteLength).toBe(after.bundle.bytes);
    expect(createHash("sha256").update(bundleBytes).digest("hex")).toBe(after.bundle.sha256);
    // The replaced objects are queued for the archive's ordinary deletion.
    const queued = await shared.admin`
      select object_key from opengeni_private.session_archive_object_deletions
      where session_id = ${scope.sessionId}`;
    expect(queued.map((row) => row.object_key).sort()).toEqual(
      [before.bundle.key, before.transcript.key].sort(),
    );

    const bundleText = text(bundleBytes);
    const transcriptText = text(objects.get(after.transcript.key)!);
    for (const piece of [FAKE_TOKEN, ...HALVES]) {
      expect(bundleText).not.toContain(piece);
      expect(transcriptText).not.toContain(piece);
    }
    expect(transcriptText).toContain("[redacted: secret:test/token]");

    // Content addressing holds: every blob's digest is its value's, the
    // snapshot's refs all resolve, and the counts follow the blobs.
    const lines = bundleText
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const blobs = new Map<string, unknown>();
    for (const line of lines) {
      if (line.table !== "session_content_blobs") continue;
      const row = line.row as { digest: string; value: unknown };
      expect(digestContentValue(row.value)).toBe(row.digest);
      blobs.set(row.digest, row.value);
    }
    const footer = lines.at(-1) as { end: boolean; rowCounts: Record<string, number> };
    expect(footer.rowCounts.session_content_blobs).toBe(blobs.size);
    expect(after.rowCounts).toEqual(footer.rowCounts);
    const snapshots = lines.filter(
      (line) => line.table === "session_attempt_model_context_snapshots",
    );
    expect(snapshots.length).toBe(1);
    const row = snapshots[0]!.row as { snapshot: unknown; content_refs: unknown };
    for (const digest of modelContextSnapshotRefDigests(row.content_refs)!) {
      expect(blobs.has(digest)).toBe(true);
    }
    const hydrated = hydrateModelContextSnapshotFromValues(
      row.snapshot,
      row.content_refs,
      blobs,
    ) as ModelContextSnapshot;
    expect(hydrated.providerRequest?.body).toContain("[redacted: secret:test/token]");

    const again = await runSessionSecretRedaction(client.db, dbScope, {
      sessionIds: [scope.sessionId],
      matchers: [matcher],
      dryRun: false,
      storage,
    });
    expect(again.failures).toEqual([]);
    expect(again.tables.archive_bundle!.rowsMatched).toBe(0);
    expect(again.tables.archive_transcript!.rowsMatched).toBe(0);
    expect(await manifestOf(scope.sessionId)).toEqual(after);
  }, 180_000);

  test("a session archived while the run is under way still has its archive scrubbed", async () => {
    // The session is archived, then made to look live, so the run lists it as
    // live. A test trigger restores its archive state when the run's live pass
    // rewrites its sessions row: the archive completed meanwhile, holding rows
    // the live pass never saw.
    const archivedMeanwhile = await idleSessionWithSecret();
    const { objects, storage } = memoryStorage();
    const archiver = createSessionArchiveActivities(
      async () =>
        ({
          db: client.db,
          objectStorage: storage,
          observability: { info: () => undefined, warn: () => undefined } as never,
          settings: testSettings({ sessionArchiveEnabled: true, sessionArchiveIdleDays: 30 }),
        }) as unknown as ActivityServices,
    );
    expect((await archiver.archiveIdleSessions()).failed).toBe(0);
    const before = await manifestOf(archivedMeanwhile.sessionId);
    expect(text(objects.get(before.transcript.key)!)).toContain(FAKE_TOKEN);
    await shared.admin.unsafe(`
      create table redaction_test_hold as
        select id as session_id, content_archive_state as state,
          content_archive_started_at as started, content_archived_at as archived,
          content_archive as manifest, content_archive_purged_at as purged
        from sessions where id = '${archivedMeanwhile.sessionId}'::uuid;
      create function redaction_test_archive_meanwhile() returns trigger
        language plpgsql security definer set search_path = pg_catalog, public as $body$
      begin
        perform set_config('session_replication_role', 'replica', true);
        update sessions s set content_archive_state = h.state,
          content_archive_started_at = h.started, content_archived_at = h.archived,
          content_archive = h.manifest, content_archive_purged_at = h.purged
        from redaction_test_hold h where s.id = h.session_id;
        delete from redaction_test_hold;
        perform set_config('session_replication_role', 'origin', true);
        return null;
      end $body$;
    `);
    await shared.admin.begin(async (sql) => {
      await sql`set local session_replication_role = replica`;
      await sql`update sessions set content_archive_state = null, content_archive_started_at = null,
          content_archived_at = null, content_archive = null, content_archive_purged_at = null
        where id = ${archivedMeanwhile.sessionId}`;
    });
    try {
      const matcher = secretRedactionMatcherForValue(FAKE_TOKEN, "secret:test/token")!;
      const dbScope = {
        accountId: archivedMeanwhile.accountId,
        workspaceId: archivedMeanwhile.workspaceId,
      };
      await shared.admin.unsafe(`
        create trigger redaction_test_archive_meanwhile after update on sessions
        for each row when (NEW.id = '${archivedMeanwhile.sessionId}'::uuid
          AND NEW.content_archive_state IS NULL)
        execute function redaction_test_archive_meanwhile();
      `);
      const run = await runSessionSecretRedaction(client.db, dbScope, {
        sessionIds: [archivedMeanwhile.sessionId],
        matchers: [matcher],
        dryRun: false,
        storage,
      });
      expect(run.failures).toEqual([]);
      expect(run.sessions[0]!.archived).toBe(true);
      expect(run.tables.archive_transcript!.rowsChanged).toBeGreaterThan(0);
      const after = await manifestOf(archivedMeanwhile.sessionId);
      expect(after.transcript.key).not.toBe(before.transcript.key);
      for (const piece of [FAKE_TOKEN, ...HALVES]) {
        expect(text(objects.get(after.bundle.key)!)).not.toContain(piece);
        expect(text(objects.get(after.transcript.key)!)).not.toContain(piece);
      }
    } finally {
      await shared.admin.unsafe(`
        drop trigger if exists redaction_test_archive_meanwhile on sessions;
        drop function if exists redaction_test_archive_meanwhile();
        drop table if exists redaction_test_hold;
      `);
    }
  }, 180_000);

  test("a manifest swap that did not happen deletes its uploads; one with an unknown outcome keeps them", async () => {
    // A swap that throws may still commit, or may have committed with its
    // acknowledgement lost, so the uploaded (already redacted) objects are
    // kept: an orphan costs storage, a manifest naming deleted objects loses
    // the archive. Only a lost compare-and-swap or a session that is gone
    // proves the swap did not happen.
    const scope = await idleSessionWithSecret();
    const { objects, storage } = memoryStorage();
    const archiver = createSessionArchiveActivities(
      async () =>
        ({
          db: client.db,
          objectStorage: storage,
          observability: { info: () => undefined, warn: () => undefined } as never,
          settings: testSettings({ sessionArchiveEnabled: true, sessionArchiveIdleDays: 30 }),
        }) as unknown as ActivityServices,
    );
    expect((await archiver.archiveIdleSessions()).failed).toBe(0);
    const before = await manifestOf(scope.sessionId);
    const matcher = secretRedactionMatcherForValue(FAKE_TOKEN, "secret:test/token")!;
    const dbScope = { accountId: scope.accountId, workspaceId: scope.workspaceId };
    const scrub = () =>
      runSessionSecretRedaction(client.db, dbScope, {
        sessionIds: [scope.sessionId],
        matchers: [matcher],
        dryRun: false,
        storage,
      });
    try {
      // The swap definitely did not happen: its compare-and-swap missed, or
      // it failed and the session is then read as gone. The uploaded objects
      // are deleted and the manifest is unchanged.
      for (const [fault, code] of [
        ["cas_miss", "archive_manifest_changed"],
        ["reread_null", "ECONNRESET"],
      ] as const) {
        const keysBefore = [...objects.keys()].sort();
        swapAttempted = false;
        swapFault = fault;
        const missed = await scrub();
        expect(swapAttempted).toBe(true);
        expect(missed.failures.map((failure) => [failure.table, failure.code])).toEqual([
          ["archive_bundle", code],
        ]);
        expect(await manifestOf(scope.sessionId)).toEqual(before);
        expect([...objects.keys()].sort()).toEqual(keysBefore);
      }

      // Fails before its commit, with the manifest then read back unchanged
      // or not readable at all: the manifest is unchanged and the two
      // uploaded objects stay as orphans.
      for (const fault of ["before_commit", "reread_error"] as const) {
        const keysBefore = new Set(objects.keys());
        swapAttempted = false;
        swapFault = fault;
        const lost = await scrub();
        expect(swapAttempted).toBe(true);
        expect(lost.failures.map((failure) => [failure.table, failure.code])).toEqual([
          ["archive_bundle", "ECONNRESET"],
        ]);
        expect(JSON.stringify(lost)).not.toContain(FAKE_TOKEN);
        expect(await manifestOf(scope.sessionId)).toEqual(before);
        const orphans = [...objects.keys()].filter((key) => !keysBefore.has(key));
        expect(orphans.length).toBe(2);
      }

      // Commits, then the acknowledgement is lost: the manifest names the
      // new objects, and they are still there.
      swapFault = "after_commit";
      const unknown = await scrub();
      expect(unknown.failures.map((failure) => failure.table)).toEqual(["archive_bundle"]);
      const after = await manifestOf(scope.sessionId);
      expect(after.bundle.key).not.toBe(before.bundle.key);
      expect(after.transcript.key).not.toBe(before.transcript.key);
      for (const key of [after.bundle.key, after.transcript.key]) {
        const bytes = objects.get(key);
        expect(bytes).toBeDefined();
        for (const piece of [FAKE_TOKEN, ...HALVES]) expect(text(bytes!)).not.toContain(piece);
      }
    } finally {
      swapFault = "none";
    }
    const again = await scrub();
    expect(again.failures).toEqual([]);
    expect(again.tables.archive_bundle!.rowsMatched).toBe(0);
    expect(again.tables.archive_transcript!.rowsMatched).toBe(0);
  }, 180_000);
});
