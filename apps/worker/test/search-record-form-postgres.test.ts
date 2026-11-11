import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { bootstrapWorkspace, createDb, createSession, type DbClient } from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { hostedSearchFixture } from "../../../packages/runtime/test/fixtures/hosted-search";
import {
  loadTurnSearchRecords,
  settleTurnSearchRecords,
} from "../src/activities/search-record-form";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("search-record-form");
  if (!shared) {
    if (requireRealDatabase) throw new Error("Search record PostgreSQL harness is unavailable");
    return;
  }
  client = createDb(shared.appUrl, { max: 2 });
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

async function sessionFixture(db: DbClient["db"]) {
  const id = crypto.randomUUID();
  const {
    workspaceGrants: [grant],
  } = await bootstrapWorkspace(db, {
    accountExternalSource: "test",
    accountExternalId: id,
    accountName: "Search records",
    workspaceExternalSource: "test",
    workspaceExternalId: id,
    workspaceName: "Search records",
    subjectId: id,
  });
  if (!grant) throw new Error("Missing fixture grant");
  const session = await createSession(db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    initialMessage: "",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  return { workspaceId: grant.workspaceId, sessionId: session.id };
}

describe("a session's hosted web-search record form", () => {
  const conversation = [
    { type: "message", role: "user", content: "What changed?" },
    { type: "message", role: "assistant", content: "Version 2 adds search." },
  ];

  test("a session moves to runtime records only while that changes no sent text, and stays there", async () => {
    if (!client) return;
    const { db } = client;
    const fresh = await sessionFixture(db);
    // Every session starts in the original form.
    const first = await loadTurnSearchRecords(db, fresh.workspaceId, fresh.sessionId);
    expect(first.form).toBe("assistant");
    // Its history projects the same in both forms, so its first turn moves.
    expect(
      await settleTurnSearchRecords(db, fresh.workspaceId, fresh.sessionId, first, conversation),
    ).toBe("runtime");
    expect(first.form).toBe("runtime");
    // The move is durable: later turns, with searches in history, keep it.
    const later = await loadTurnSearchRecords(db, fresh.workspaceId, fresh.sessionId);
    expect(later.form).toBe("runtime");
    expect(
      await settleTurnSearchRecords(db, fresh.workspaceId, fresh.sessionId, later, [
        ...conversation,
        hostedSearchFixture(),
      ]),
    ).toBe("runtime");

    // A session whose sent history holds a search stays in the original form
    // until compaction or clearing leaves none, then moves once.
    const older = await sessionFixture(db);
    const records = await loadTurnSearchRecords(db, older.workspaceId, older.sessionId);
    expect(
      await settleTurnSearchRecords(db, older.workspaceId, older.sessionId, records, [
        ...conversation,
        hostedSearchFixture(),
      ]),
    ).toBe("assistant");
    expect((await loadTurnSearchRecords(db, older.workspaceId, older.sessionId)).form).toBe(
      "assistant",
    );
    const compacted = [{ type: "message", role: "user", content: "Summary of earlier work" }];
    expect(
      await settleTurnSearchRecords(db, older.workspaceId, older.sessionId, records, compacted),
    ).toBe("runtime");
    expect((await loadTurnSearchRecords(db, older.workspaceId, older.sessionId)).form).toBe(
      "runtime",
    );
    // Another session is untouched.
    const other = await sessionFixture(db);
    expect((await loadTurnSearchRecords(db, other.workspaceId, other.sessionId)).form).toBe(
      "assistant",
    );
  });
});
