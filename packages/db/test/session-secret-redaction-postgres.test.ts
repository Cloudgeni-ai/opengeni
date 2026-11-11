import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelContextSnapshot } from "@opengeni/contracts";
import {
  acquireBlankTestDatabase,
  acquireSharedTestDatabase,
  grantDeferredRuntimeAccess,
  type BlankTestDatabase,
  type SharedTestDatabase,
} from "@opengeni/testing/shared-pg";
import postgres from "postgres";
import SCRUB_GUARD_ADDITIONS from "./fixtures/session-secret-redaction-guard-additions.json";
import {
  appendSessionEvents,
  appendSessionHistoryItems,
  bootstrapWorkspace,
  chunkTextByContent,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  createSessionGoal,
  createTaskNote,
  initializeSessionStartAtomically,
  listSessionsForSecretRedaction,
  persistModelContextSnapshot,
  scrubSessionSecretHistory,
  secretRedactionMarker,
  SessionSecretRedactionTooManySessionsError,
  type SecretRedactionMatcher,
  type SessionSecretRedactionReport,
} from "../src";
import { fromPostgresLosslessJson, LOSSLESS_CONTENT_CODEC_VERSION } from "../src/lossless-json";
import { migrate } from "../src/migrate";

// The secret history scrub (docs/secrets.md, "Removing secrets from stored
// history") against real PostgreSQL, as opengeni_app so FORCE RLS applies.
// Values are obviously fake. The matchers here are literal stand-ins; the
// production matchers come from the masking module and are tested there.

const FAKE_TOKEN = "ghp_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE0000";
const OTHER_FAKE = "ghp_OTHEROTHEROTHEROTHEROTHEROTHER1111";

let available = true;
let shared: SharedTestDatabase | null = null;
let client: ReturnType<typeof createDb>;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("session-secret-redaction");
  if (!shared) {
    available = false;
    console.warn("[session-secret-redaction] postgres unavailable, skipping");
    return;
  }
  // 1091 withholds the scrub routines' runtime grant for one release; most
  // tests run as the runtime will once it is granted, one checks the meantime.
  await grantDeferredRuntimeAccess(shared.admin);
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

function literalMatcher(value: string, label: string): SecretRedactionMatcher {
  const marker = secretRedactionMarker(label);
  return { marker, redact: (text) => text.split(value).join(marker) };
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

async function seededSession(
  secret: string,
  options: { active?: boolean; body?: string; goalCriteria?: string } = {},
) {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `scrub-account-${suffix}`,
    accountName: "Secret scrub test",
    workspaceExternalSource: "test",
    workspaceExternalId: `scrub-workspace-${suffix}`,
    workspaceName: "Secret scrub test",
    subjectId: `scrub-subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const scope = { accountId: grant.accountId, workspaceId: grant.workspaceId! };
  const session = await createSession(client.db, {
    ...scope,
    initialMessage: `Clone with token ${secret} please`,
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none",
  });
  const started = await initializeSessionStartAtomically(client.db, {
    ...scope,
    sessionId: session.id,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
  });
  if (!started.turn) throw new Error("initial turn was not created");
  const attemptId = crypto.randomUUID();
  const claimed = await claimSessionWorkForAttempt(client.db, scope.workspaceId, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    dispatchId: crypto.randomUUID(),
    attemptId,
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") throw new Error(`claim failed: ${claimed.reason}`);
  const turnId = claimed.turn.id;
  const executionGeneration = claimed.turn.executionGeneration;
  await appendSessionEvents(client.db, scope.workspaceId, session.id, [
    {
      type: "agent.toolCall.output",
      turnId,
      payload: { callId: "call-1", output: `env dump: GITHUB_TOKEN=${secret}\nok` },
    },
  ]);
  const appended = await appendSessionHistoryItems(client.db, {
    ...scope,
    sessionId: session.id,
    turnId,
    expectedExecutionGeneration: executionGeneration,
    expectedAttemptId: attemptId,
    items: [
      {
        position: 1,
        item: {
          type: "function_call_output",
          call_id: "call-1",
          output: `{"token":"${secret}","host":"github.com"}`,
        },
      },
    ],
  });
  expect(appended).toBe(true);
  await persistModelContextSnapshot(client.db, {
    ...scope,
    sessionId: session.id,
    turnId,
    attemptId,
    executionGeneration,
    snapshot: snapshot(options.body ?? `${"history ".repeat(4_000)} user said: token ${secret}`),
  });
  await createSessionGoal(client.db, {
    ...scope,
    sessionId: session.id,
    text: `Push with ${secret}`,
    ...(options.goalCriteria ? { successCriteria: options.goalCriteria } : {}),
    createdBy: "api",
  });
  await createTaskNote(client.db, {
    ...scope,
    sessionId: session.id,
    turnId,
    attemptId,
    executionGeneration,
    operationId: crypto.randomUUID(),
    kind: "finding",
    text: `The token is ${secret}`,
    expiresInDays: 7,
  });
  if (!options.active) {
    // A turn in progress could write the text again; the scrub leaves such
    // sessions alone, so most tests use a session at rest.
    await shared!.admin`
      update sessions set status = 'idle', active_turn_id = null where id = ${session.id}`;
  }
  return { scope, sessionId: session.id, turnId, attemptId };
}

/** Every row that still holds the value anywhere, read as the table owner. */
async function remainingCopies(workspaceId: string, value: string) {
  const tables = [
    "sessions",
    "session_turns",
    "session_events",
    "session_history_items",
    "session_attempt_model_context_snapshots",
    "session_content_blobs",
    "session_message_search_texts",
    "session_goals",
    "session_goal_revisions",
    "task_notes",
  ];
  const found: Record<string, number> = {};
  for (const table of tables) {
    const [row] = await shared!.admin.unsafe(
      `select count(*)::int as n from ${table} t
        where t.workspace_id = $1::uuid and strpos(row_to_json(t)::text, $2) > 0`,
      [workspaceId, value],
    );
    if (Number(row?.n ?? 0) > 0) found[table] = Number(row!.n);
  }
  return found;
}

function total(
  report: SessionSecretRedactionReport,
  field: "rowsMatched" | "rowsChanged" | "matches",
) {
  return Object.values(report.tables).reduce((sum, counts) => sum + counts[field], 0);
}

describe("secret history scrub", () => {
  test("a dry run counts every copy and changes nothing", async () => {
    if (!available) return;
    const seeded = await seededSession(FAKE_TOKEN);
    const before = await remainingCopies(seeded.scope.workspaceId, FAKE_TOKEN);
    const report = await scrubSessionSecretHistory(client.db, seeded.scope, {
      sessionIds: [seeded.sessionId],
      matchers: [literalMatcher(FAKE_TOKEN, "test/token")],
      dryRun: true,
    });
    expect(report.dryRun).toBe(true);
    expect(report.failures).toEqual([]);
    expect(report.pending).toEqual([]);
    expect(total(report, "rowsChanged")).toBe(0);
    for (const table of [
      "sessions",
      "session_events",
      "session_history_items",
      "session_attempt_model_context_snapshots",
      "session_content_blobs",
      "session_goals",
      "task_notes",
    ]) {
      expect(report.tables[table]!.rowsMatched).toBeGreaterThan(0);
    }
    expect(await remainingCopies(seeded.scope.workspaceId, FAKE_TOKEN)).toEqual(before);
    expect(JSON.stringify(report)).not.toContain(FAKE_TOKEN);
  }, 120_000);

  test("a run removes every stored copy, keeps other text, and a second run is a no-op", async () => {
    if (!available) return;
    const seeded = await seededSession(FAKE_TOKEN);
    const matchers = [literalMatcher(FAKE_TOKEN, "test/token")];
    const first = await scrubSessionSecretHistory(client.db, seeded.scope, {
      sessionIds: [seeded.sessionId],
      matchers,
      dryRun: false,
      pageRows: 2,
    });
    expect(first.failures).toEqual([]);
    expect(total(first, "rowsChanged")).toBeGreaterThan(0);
    expect(JSON.stringify(first)).not.toContain(FAKE_TOKEN);
    expect(await remainingCopies(seeded.scope.workspaceId, FAKE_TOKEN)).toEqual({});

    // The marker took the value's place and the rest of the text survived.
    const [row] = await shared!.admin`
      select initial_message from sessions where id = ${seeded.sessionId}`;
    expect(String(row!.initial_message)).toContain(
      "Clone with token [redacted: test/token] please",
    );
    const [note] = await shared!.admin`
      select text from task_notes where workspace_id = ${seeded.scope.workspaceId}`;
    expect(String(note!.text)).toBe("The token is [redacted: test/token]");

    const second = await scrubSessionSecretHistory(client.db, seeded.scope, {
      sessionIds: [seeded.sessionId],
      matchers,
      dryRun: false,
    });
    expect(second.failures).toEqual([]);
    expect(total(second, "rowsMatched")).toBe(0);
    expect(total(second, "rowsChanged")).toBe(0);
  }, 120_000);

  test("only the chosen sessions and matches are touched", async () => {
    if (!available) return;
    const target = await seededSession(FAKE_TOKEN);
    const bystander = await seededSession(OTHER_FAKE);
    const report = await scrubSessionSecretHistory(client.db, target.scope, {
      sessionIds: [target.sessionId],
      matchers: [literalMatcher(OTHER_FAKE, "test/other")],
      dryRun: false,
    });
    expect(total(report, "rowsMatched")).toBe(0);
    // The other workspace's session is invisible here and keeps its copies.
    const foreign = await scrubSessionSecretHistory(client.db, target.scope, {
      sessionIds: [bystander.sessionId],
      matchers: [literalMatcher(OTHER_FAKE, "test/other")],
      dryRun: false,
    });
    expect(foreign.sessions).toEqual([]);
    expect(
      Object.keys(await remainingCopies(bystander.scope.workspaceId, OTHER_FAKE)).length,
    ).toBeGreaterThan(3);
    expect(
      Object.keys(await remainingCopies(target.scope.workspaceId, FAKE_TOKEN)).length,
    ).toBeGreaterThan(3);
  }, 120_000);

  test("an archived session's retained rows are rewritten", async () => {
    if (!available) return;
    const seeded = await seededSession(FAKE_TOKEN);
    await shared!.admin`
      update sessions set content_archive_state = 'archived', content_archive_started_at = now(),
        content_archived_at = now(),
        content_archive = '{"format":"opengeni.session-archive","version":1,"objectKeys":[],"sha256":"0"}'::jsonb
      where id = ${seeded.sessionId}`;
    const report = await scrubSessionSecretHistory(client.db, seeded.scope, {
      sessionIds: [seeded.sessionId],
      matchers: [literalMatcher(FAKE_TOKEN, "test/token")],
      dryRun: false,
    });
    expect(report.failures).toEqual([]);
    expect(report.sessions[0]!.archived).toBe(true);
    expect(await remainingCopies(seeded.scope.workspaceId, FAKE_TOKEN)).toEqual({});
  }, 120_000);

  test("before the routines are granted, private tables are pending and still counted where readable", async () => {
    if (!available) return;
    const seeded = await seededSession(FAKE_TOKEN);
    await shared!.admin.unsafe(`
      revoke execute on function opengeni_private.session_secret_redaction_rows_v1(uuid, uuid[], text, uuid, integer) from opengeni_app;
      revoke execute on function opengeni_private.redact_session_secret_cells_v1(uuid, text, jsonb) from opengeni_app;
    `);
    try {
      const report = await scrubSessionSecretHistory(client.db, seeded.scope, {
        sessionIds: [seeded.sessionId],
        matchers: [literalMatcher(FAKE_TOKEN, "test/token")],
        dryRun: false,
      });
      expect(report.failures).toEqual([]);
      expect(report.pending).toContain("task_notes");
      expect(report.pending).toContain("session_goals");
      const left = await remainingCopies(seeded.scope.workspaceId, FAKE_TOKEN);
      expect(left.session_events).toBeUndefined();
      expect(left.session_history_items).toBeUndefined();
      expect(left.sessions).toBeUndefined();
      expect(left.task_notes).toBe(1);
    } finally {
      await grantDeferredRuntimeAccess(shared!.admin);
    }
  }, 120_000);

  test("descendants are included on request and the session limit is enforced", async () => {
    if (!available) return;
    const seeded = await seededSession(FAKE_TOKEN);
    const child = await createSession(client.db, {
      ...seeded.scope,
      parentSessionId: seeded.sessionId,
      initialMessage: `child ${FAKE_TOKEN}`,
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium" as const,
      latencyMode: "standard" as const,
      sandboxBackend: "none",
    });
    const alone = await listSessionsForSecretRedaction(client.db, seeded.scope, {
      sessionIds: [seeded.sessionId],
      includeDescendants: false,
    });
    expect(alone.map((row) => row.id)).toEqual([seeded.sessionId]);
    const tree = await listSessionsForSecretRedaction(client.db, seeded.scope, {
      sessionIds: [seeded.sessionId],
      includeDescendants: true,
    });
    expect(tree.map((row) => row.id)).toEqual([seeded.sessionId, child.id]);
    await expect(
      listSessionsForSecretRedaction(client.db, seeded.scope, {
        sessionIds: [seeded.sessionId],
        includeDescendants: true,
        limit: 1,
      }),
    ).rejects.toBeInstanceOf(SessionSecretRedactionTooManySessionsError);
  }, 120_000);
  test("a secret split across two model-request chunks leaves no piece in any blob", async () => {
    if (!available) return;
    const split = straddlingBody(FAKE_TOKEN);
    const seeded = await seededSession(FAKE_TOKEN, { body: split.body });
    const halves = split.pieces;
    const blobsHolding = async (piece: string) => {
      const [row] = await shared!.admin`
        select count(*)::int as n from session_content_blobs
        where session_id = ${seeded.sessionId} and strpos(value::text, ${piece}) > 0`;
      return Number(row!.n);
    };
    // Each half sits in its own chunk; no blob holds the whole value.
    expect(await blobsHolding(FAKE_TOKEN)).toBe(0);
    for (const half of halves) expect(await blobsHolding(half)).toBeGreaterThan(0);
    const report = await scrubSessionSecretHistory(client.db, seeded.scope, {
      sessionIds: [seeded.sessionId],
      matchers: [literalMatcher(FAKE_TOKEN, "test/token")],
      dryRun: false,
    });
    expect(report.failures).toEqual([]);
    expect(report.orphanedBlobs).toEqual({});
    for (const half of halves) expect(await blobsHolding(half)).toBe(0);
    // Every digest the rewritten snapshot names still exists.
    const [missing] = await shared!.admin`
      select count(*)::int as n
      from session_attempt_model_context_snapshots s,
        jsonb_array_elements_text(
          jsonb_build_array(s.content_refs->'instructions', s.content_refs->'layers',
            s.content_refs->'tools', s.content_refs->'skills')
          || coalesce(s.content_refs->'body', '[]'::jsonb)) as ref(digest)
      where s.session_id = ${seeded.sessionId}
        and not exists (select 1 from session_content_blobs b
          where b.session_id = s.session_id and b.digest = ref.digest)`;
    expect(Number(missing!.n)).toBe(0);
    const second = await scrubSessionSecretHistory(client.db, seeded.scope, {
      sessionIds: [seeded.sessionId],
      matchers: [literalMatcher(FAKE_TOKEN, "test/token")],
      dryRun: false,
    });
    expect(total(second, "rowsMatched")).toBe(0);
  }, 120_000);

  test("a rerun removes old chunks a failed run left unreferenced, and keeps young ones", async () => {
    if (!available) return;
    const split = straddlingBody(FAKE_TOKEN);
    const seeded = await seededSession(FAKE_TOKEN, { body: split.body });
    const blobsHolding = async (piece: string) => {
      const [row] = await shared!.admin`
        select count(*)::int as n from session_content_blobs
        where session_id = ${seeded.sessionId} and strpos(value::text, ${piece}) > 0`;
      return Number(row!.n);
    };
    // As if an earlier run rewrote the snapshot and then failed before its
    // blob pass: the chunks holding the pieces are old and nothing refers
    // to them. No piece matches on its own.
    await shared!.admin`
      delete from session_attempt_model_context_snapshots where session_id = ${seeded.sessionId}`;
    await shared!.admin`
      update session_content_blobs set created_at = now() - interval '1 hour'
      where session_id = ${seeded.sessionId}`;
    const young = "f".repeat(64);
    await shared!.admin`
      insert into session_content_blobs (account_id, workspace_id, session_id, digest, value)
      values (${seeded.scope.accountId}, ${seeded.scope.workspaceId}, ${seeded.sessionId},
        ${young}, '"a write still in flight"'::jsonb)`;
    for (const piece of split.pieces) expect(await blobsHolding(piece)).toBeGreaterThan(0);
    const report = await scrubSessionSecretHistory(client.db, seeded.scope, {
      sessionIds: [seeded.sessionId],
      matchers: [literalMatcher(FAKE_TOKEN, "test/token")],
      dryRun: false,
    });
    expect(report.failures).toEqual([]);
    for (const piece of split.pieces) expect(await blobsHolding(piece)).toBe(0);
    const [kept] = await shared!.admin`
      select count(*)::int as n from session_content_blobs
      where session_id = ${seeded.sessionId} and digest = ${young}`;
    expect(Number(kept!.n)).toBe(1);
  }, 120_000);

  test("one refused cell in a multi-cell goal row is reported, not hidden by its neighbour", async () => {
    if (!available) return;
    const seeded = await seededSession(FAKE_TOKEN, {
      goalCriteria: `Done when pushed with ${FAKE_TOKEN}`,
    });
    const [before] = await shared!.admin`
      select count(*)::int as n from session_goals
      where session_id = ${seeded.sessionId} and strpos(success_criteria, ${FAKE_TOKEN}) > 0
        and strpos(text, ${FAKE_TOKEN}) > 0`;
    expect(Number(before!.n)).toBeGreaterThan(0);
    // The criteria's edit is not a marker, so the cell writer's shape check
    // refuses that one cell while the goal text in the same row is rewritten.
    const literal = literalMatcher(FAKE_TOKEN, "test/token");
    const picky: SecretRedactionMatcher = {
      marker: literal.marker,
      redact: (text) =>
        text.startsWith("Done when")
          ? text.split(FAKE_TOKEN).join("not-a-marker")
          : literal.redact(text),
    };
    const report = await scrubSessionSecretHistory(client.db, seeded.scope, {
      sessionIds: [seeded.sessionId],
      matchers: [picky],
      dryRun: false,
    });
    expect(report.failures).toContainEqual({
      sessionId: seeded.sessionId,
      table: "session_goals",
      code: "cell_not_rewritten",
    });
    const [after] = await shared!.admin`
      select count(*)::int as n from session_goals
      where session_id = ${seeded.sessionId} and strpos(text, ${FAKE_TOKEN}) > 0`;
    expect(Number(after!.n)).toBe(0);
  }, 120_000);

  test("an encoded search-mirror row is found and resynced on the run after a pending one", async () => {
    if (!available) return;
    const seeded = await seededSession(FAKE_TOKEN);
    // A NUL makes the event text (and so its mirror row) lossless-encoded.
    await appendSessionEvents(client.db, seeded.scope.workspaceId, seeded.sessionId, [
      {
        type: "user.message",
        turnId: seeded.turnId,
        payload: { text: `nul\u0000 then ${FAKE_TOKEN}` },
      },
    ]);
    const mirrorCopies = async () => {
      const rows = await shared!.admin<Array<{ text: string; encoded: boolean }>>`
        select text, encoded from session_message_search_texts
        where session_id = ${seeded.sessionId}`;
      const holding = (row: { text: string; encoded: boolean }) =>
        (row.encoded
          ? fromPostgresLosslessJson(row.text, LOSSLESS_CONTENT_CODEC_VERSION)
          : row.text
        ).includes(FAKE_TOKEN);
      return {
        encoded: rows.filter((row) => row.encoded && holding(row)).length,
        all: rows.filter(holding).length,
      };
    };
    const seen = await mirrorCopies();
    expect(seen.encoded).toBe(1);
    const run = (dryRun: boolean) =>
      scrubSessionSecretHistory(client.db, seeded.scope, {
        sessionIds: [seeded.sessionId],
        matchers: [literalMatcher(FAKE_TOKEN, "test/token")],
        dryRun,
      });
    const counted = await run(true);
    // Every mirror copy is found, the encoded one included.
    expect(counted.tables.session_message_search_texts!.rowsMatched).toBe(seen.all);
    // First run while the routines are pending: the events are rewritten,
    // the mirror cannot be.
    await shared!.admin.unsafe(`
      revoke execute on function opengeni_private.session_secret_redaction_rows_v1(uuid, uuid[], text, uuid, integer) from opengeni_app;
      revoke execute on function opengeni_private.redact_session_secret_cells_v1(uuid, text, jsonb) from opengeni_app;
    `);
    try {
      await run(false);
    } finally {
      await grantDeferredRuntimeAccess(shared!.admin);
    }
    expect((await mirrorCopies()).encoded).toBe(1);
    // The rerun finds the events clean and must still resync the mirror.
    const second = await run(false);
    expect(second.failures).toEqual([]);
    expect(await mirrorCopies()).toEqual({ encoded: 0, all: 0 });
  }, 120_000);

  test("a session being moved to long-term storage is counted but not changed", async () => {
    if (!available) return;
    const seeded = await seededSession(FAKE_TOKEN);
    // The archive export is reading this session's rows right now.
    await shared!.admin`
      update sessions set content_archive_state = 'archiving',
        content_archive_started_at = now(), content_archive = '{}'::jsonb
      where id = ${seeded.sessionId}`;
    const before = await remainingCopies(seeded.scope.workspaceId, FAKE_TOKEN);
    const run = (dryRun: boolean) =>
      scrubSessionSecretHistory(client.db, seeded.scope, {
        sessionIds: [seeded.sessionId],
        matchers: [literalMatcher(FAKE_TOKEN, "test/token")],
        dryRun,
      });
    expect(total(await run(true), "rowsMatched")).toBeGreaterThan(0);
    const report = await run(false);
    expect(report.failures).toContainEqual({
      sessionId: seeded.sessionId,
      table: "sessions",
      code: "session_archiving",
    });
    expect(total(report, "rowsChanged")).toBe(0);
    expect(await remainingCopies(seeded.scope.workspaceId, FAKE_TOKEN)).toEqual(before);
  }, 120_000);

  test("a mirror row the resync cannot fix is reported", async () => {
    if (!available) return;
    const seeded = await seededSession(FAKE_TOKEN);
    // The first message's event no longer holds text the resync can copy,
    // while its mirror row still holds the token (triggers held off).
    await shared!.admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`
        update session_events set payload = jsonb_set(payload, '{text}', '1'::jsonb)
        where session_id = ${seeded.sessionId} and type = 'user.message'`;
    });
    const report = await scrubSessionSecretHistory(client.db, seeded.scope, {
      sessionIds: [seeded.sessionId],
      matchers: [literalMatcher(FAKE_TOKEN, "test/token")],
      dryRun: false,
    });
    expect(report.failures).toContainEqual({
      sessionId: seeded.sessionId,
      table: "session_message_search_texts",
      code: "cell_not_rewritten",
    });
    const [left] = await shared!.admin`
      select count(*)::int as n from session_message_search_texts
      where session_id = ${seeded.sessionId} and strpos(text, ${FAKE_TOKEN}) > 0`;
    expect(Number(left!.n)).toBe(1);
  }, 120_000);

  test("an undecodable encoded mirror row is reported and then rebuilt from its event", async () => {
    if (!available) return;
    const seeded = await seededSession(FAKE_TOKEN);
    await shared!.admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`
        update session_message_search_texts
        set text = 'opengeni_lossless_json_string_v2_81f06e15:@@not-base64@@', encoded = true
        where session_id = ${seeded.sessionId}`;
    });
    const run = (dryRun: boolean) =>
      scrubSessionSecretHistory(client.db, seeded.scope, {
        sessionIds: [seeded.sessionId],
        matchers: [literalMatcher(FAKE_TOKEN, "test/token")],
        dryRun,
      });
    expect((await run(true)).failures).toContainEqual({
      sessionId: seeded.sessionId,
      table: "session_message_search_texts",
      code: "mirror_row_unreadable",
    });
    const applied = await run(false);
    expect(applied.failures).toEqual([]);
    const [left] = await shared!.admin`
      select count(*)::int as n from session_message_search_texts
      where session_id = ${seeded.sessionId} and strpos(text, '@@not-base64@@') > 0`;
    expect(Number(left!.n)).toBe(0);
  }, 120_000);

  test("a session with a turn in progress is skipped and left alone", async () => {
    if (!available) return;
    const seeded = await seededSession(FAKE_TOKEN, { active: true });
    const before = await remainingCopies(seeded.scope.workspaceId, FAKE_TOKEN);
    const report = await scrubSessionSecretHistory(client.db, seeded.scope, {
      sessionIds: [seeded.sessionId],
      matchers: [literalMatcher(FAKE_TOKEN, "test/token")],
      dryRun: false,
    });
    expect(report.failures).toContainEqual({
      sessionId: seeded.sessionId,
      table: "sessions",
      code: "session_active",
    });
    expect(total(report, "rowsChanged")).toBe(0);
    expect(await remainingCopies(seeded.scope.workspaceId, FAKE_TOKEN)).toEqual(before);
  }, 120_000);

  test("under the scrub marker an archived session admits content edits only", async () => {
    if (!available) return;
    const seeded = await seededSession(FAKE_TOKEN);
    await shared!.admin`
      update sessions set content_archive_state = 'archived', content_archive_started_at = now(),
        content_archived_at = now(),
        content_archive = '{"format":"opengeni.session-archive","version":1,"objectKeys":[],"sha256":"0"}'::jsonb
      where id = ${seeded.sessionId}`;
    const marked = async (statement: string) =>
      await shared!.admin.begin(async (sql) => {
        await sql`select set_config('opengeni.session_secret_redaction', 'v1', true)`;
        await sql.unsafe(statement, [seeded.sessionId]);
      });
    await marked(
      `update session_turns set prompt = 'Clone with token [redacted: x] please' where session_id = $1::uuid`,
    );
    await expect(
      marked(`update session_turns set status = 'cancelled' where session_id = $1::uuid`),
    ).rejects.toMatchObject({ code: "OG002" });
    await expect(
      marked(`update session_turn_attempts set updated_at = now() where session_id = $1::uuid`),
    ).rejects.toMatchObject({ code: "OG002" });
  }, 120_000);

  test("the cell writer takes only marker edits of the named session's rows", async () => {
    if (!available) return;
    const seeded = await seededSession(FAKE_TOKEN);
    const other = await seededSession(OTHER_FAKE);
    const [goal] = await shared!.admin`
      select id::text as id, text, md5(text) as before from session_goals
      where session_id = ${seeded.sessionId}`;
    const call = async (table: string, cells: unknown[]) =>
      await shared!.admin.begin(async (sql) => {
        await sql`select set_config('opengeni.workspace_id', ${seeded.scope.workspaceId}, true)`;
        const [row] = await sql`select opengeni_private.redact_session_secret_cells_v1(
            ${seeded.scope.workspaceId}::uuid, ${table}, ${JSON.stringify(cells)}::text::jsonb) as n`;
        return Number(row!.n);
      });
    const cell = (value: string, session: string) => ({
      key: goal!.id,
      session,
      column: "text",
      before: goal!.before,
      value,
    });
    // Not a marker-only edit of the stored text.
    expect(await call("session_goals", [cell("Push with something else", seeded.sessionId)])).toBe(
      0,
    );
    // A row of another session than the one named.
    expect(await call("session_goals", [cell("Push with [redacted: x]", other.sessionId)])).toBe(0);
    expect(await call("session_goals", [cell("Push with [redacted: x]", seeded.sessionId)])).toBe(
      1,
    );
    const [after] = await shared!.admin`select text from session_goals where id = ${goal!.id}`;
    expect(String(after!.text)).toBe("Push with [redacted: x]");
    // A manifest pointing outside the session's archive prefix is refused.
    await expect(
      call("sessions", [
        {
          key: seeded.sessionId,
          before: "0",
          value: JSON.stringify({
            bundle: { key: "elsewhere/bundle" },
            transcript: { key: "elsewhere/transcript" },
            objectKeys: ["elsewhere/bundle", "elsewhere/transcript"],
          }),
        },
      ]),
    ).rejects.toMatchObject({ code: "22023" });
  }, 120_000);
});

// The scrub migration replaces or patches these guards to admit its own
// marker edits. Every clause and setting they had before it must survive, so a
// later in-place patch (as 0717 made to the scheduled-occurrence fence) is
// never silently dropped.
const SCRUB_MIGRATION = "1091_session_secret_redaction.sql";
const SCRUB_REPLACED_GUARDS = [
  "fence_scheduled_occurrence_update()",
  "guard_imported_archive_identity()",
  "guard_task_note_mutation()",
  "opengeni_private.guard_mcp_operation_immutable()",
  "refuse_imported_archive_execution()",
  "session_goal_reject_turn_snapshot_mutation()",
  "session_goal_revision_after_write()",
  "session_goal_revision_before_write()",
  "session_goal_revision_reject_mutation()",
];

// Lines the scrub migration rewords without changing their logic: the MCP
// guard's one condition is split into two IFs so the scrub's exemption sits
// between them.
const SCRUB_REWORDED_GUARD_LINES: Record<string, Record<string, string>> = {
  "opengeni_private.guard_mcp_operation_immutable()": {
    "OR (OLD.original_outcome<>'captured' AND": "IF (OLD.original_outcome<>'captured' AND",
  },
};

describe("guards the scrub migration replaces", () => {
  // The schema just before the scrub migration: every shipped migration but it.
  let blank: BlankTestDatabase | null = null;
  let before: postgres.Sql | null = null;
  let migrations: string | null = null;

  beforeAll(async () => {
    if (!available) return;
    blank = await acquireBlankTestDatabase("session-secret-redaction-guards");
    if (!blank) throw new Error("PostgreSQL test database unavailable");
    const shipped = new URL("../drizzle/", import.meta.url).pathname;
    migrations = await mkdtemp(join(tmpdir(), "scrub-guards-"));
    for (const file of await readdir(shipped)) {
      if (file.endsWith(".sql") && file !== SCRUB_MIGRATION) {
        await symlink(join(shipped, file), join(migrations, file));
      }
    }
    await migrate(blank.databaseUrl, undefined, { migrationsDirectory: migrations });
    before = postgres(blank.databaseUrl, { max: 1, onnotice: () => undefined });
  }, 900_000);

  afterAll(async () => {
    await before?.end({ timeout: 5 });
    await blank?.release();
    if (migrations) await rm(migrations, { recursive: true, force: true });
  }, 180_000);

  async function guards(admin: postgres.Sql) {
    const rows = await admin<
      { name: string; definition: string; config: string[] | null; definer: boolean }[]
    >`select routine.name, pg_get_functiondef(p.oid) as definition,
        p.proconfig as config, p.prosecdef as definer
      from unnest(${SCRUB_REPLACED_GUARDS}::text[]) as routine(name)
      join pg_proc p on p.oid = to_regprocedure(routine.name)`;
    return new Map(rows.map((row) => [row.name, row]));
  }

  function definitionLines(definition: string): string[] {
    return definition
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  /**
   * Walk the current definition against the earlier one in order: earlier
   * lines not found in that order were dropped or moved, and the current
   * lines left over are what the migration added, as runs pinned to the
   * earlier lines on either side, so a block moved elsewhere shows up too.
   */
  function splice(earlier: readonly string[], current: readonly string[]) {
    type Hunk = { after: string | null; before: string | null; lines: string[] };
    const added: Hunk[] = [];
    let open: Hunk | null = null;
    let next = 0;
    for (const line of current) {
      if (next < earlier.length && line === earlier[next]) {
        if (open) open.before = line;
        open = null;
        next += 1;
      } else {
        if (!open) {
          open = { after: next > 0 ? earlier[next - 1]! : null, before: null, lines: [] };
          added.push(open);
        }
        open.lines.push(line);
      }
    }
    return { dropped: earlier.slice(next), added };
  }

  test("keep every earlier clause, setting and security mode", async () => {
    if (!available || !before) return;
    const earlier = await guards(before);
    const current = await guards(shared!.admin);
    expect([...earlier.keys()].sort()).toEqual([...SCRUB_REPLACED_GUARDS].sort());
    expect([...current.keys()].sort()).toEqual([...SCRUB_REPLACED_GUARDS].sort());
    const additions: Record<string, unknown> = {};
    for (const name of SCRUB_REPLACED_GUARDS) {
      const was = earlier.get(name)!;
      const now = current.get(name)!;
      expect({ name, config: now.config, definer: now.definer }).toEqual({
        name,
        config: was.config,
        definer: was.definer,
      });
      const reworded = SCRUB_REWORDED_GUARD_LINES[name] ?? {};
      const { dropped, added } = splice(
        definitionLines(was.definition).map((line) => reworded[line] ?? line),
        definitionLines(now.definition),
      );
      expect({ name, dropped }).toEqual({ name, dropped: [] });
      additions[name] = added;
    }
    // And each adds exactly the scrub's exemption block, in order: an extra
    // early RETURN, a moved block or a loosened condition shows up here.
    expect(additions).toEqual(SCRUB_GUARD_ADDITIONS);
    // The occurrence fence still refuses a changed subscription authority and
    // Claude snapshot for every role (0717).
    const fence = current.get("fence_scheduled_occurrence_update()")!.definition;
    expect(fence).toContain(
      "NEW.subscription_authority IS DISTINCT FROM OLD.subscription_authority",
    );
    expect(fence).toContain("NEW.claude_provider_account_authority_snapshot");
    expect(fence).toContain("session_secret_redaction_writer_v1()");
  }, 120_000);
});
