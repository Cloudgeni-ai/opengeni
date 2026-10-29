import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import {
  appendSessionHistoryItems,
  applyContextCompaction,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  clearedContextMarkerItem,
  convertSessionToPortableCompactionForModelSwitch,
  createDb,
  createSession,
  getSession,
  isSessionCompactionRequested,
  readActiveSessionHistory,
  withWorkspaceRls,
} from "../src/index";
import * as schema from "../src/schema";
import { submitTestHumanPrompt } from "../../../test/integration/helpers/session-control";

// A Codex remote_v2 chat switching to another provider's model: the session
// converts to portable compaction, and its context is rebuilt from the stored
// transcript rather than the Codex-only checkpoint.

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
setDefaultTimeout(30_000);
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("codex-model-switch-history");
  if (!acquired) throw new Error("Restricted PostgreSQL fixture required");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 2 });
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
});

async function remoteSession() {
  const id = crypto.randomUUID();
  const {
    workspaceGrants: [grant],
  } = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: id,
    accountName: "Codex model switch",
    workspaceExternalSource: "test",
    workspaceExternalId: id,
    workspaceName: "Codex model switch",
    subjectId: id,
  });
  if (!grant) throw new Error("Missing fixture grant");
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    initialMessage: "",
    resources: [],
    metadata: {},
    model: "codex/gpt-5.4",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    frozenCodexCompactionMode: "remote_v2",
  });
  return {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId: grant.subjectId,
    sessionId: session.id,
  };
}

async function claimTurn(fixture: Awaited<ReturnType<typeof remoteSession>>, text: string) {
  await submitTestHumanPrompt(client.db, {
    ...fixture,
    text,
    resources: [],
    tools: [],
    reasoningEffortFallback: "medium",
  });
  const attemptId = crypto.randomUUID();
  const claim = await claimSessionWorkForAttempt(client.db, fixture.workspaceId, {
    sessionId: fixture.sessionId,
    attemptId,
    dispatchId: crypto.randomUUID(),
    workflowId: `session-${fixture.sessionId}`,
    workflowRunId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  if (claim.action !== "claimed") throw new Error("Missing fixture claim");
  return { turn: claim.turn, attemptId };
}

async function sessionRow(fixture: Awaited<ReturnType<typeof remoteSession>>) {
  const session = await getSession(client.db, fixture.workspaceId, fixture.sessionId);
  if (!session) throw new Error("Missing fixture session");
  return {
    codexCompactionMode: session.codexCompactionMode,
    compactRequested: await isSessionCompactionRequested(
      client.db,
      fixture.workspaceId,
      fixture.sessionId,
    ),
  };
}

function textOf(item: Record<string, unknown>): string {
  return JSON.stringify(item.content ?? item.encrypted_content ?? null);
}

describe("switching a Codex remote_v2 chat to another model", () => {
  test("a chat without a Codex checkpoint becomes portable at once", async () => {
    const fixture = await remoteSession();
    expect(
      await convertSessionToPortableCompactionForModelSwitch(
        client.db,
        fixture.workspaceId,
        fixture.sessionId,
      ),
    ).toEqual({ codexCompactionMode: "portable", compactRequested: false });
    expect(await sessionRow(fixture)).toEqual({
      codexCompactionMode: "portable",
      compactRequested: false,
    });
    // An already portable chat is left alone.
    expect(
      await convertSessionToPortableCompactionForModelSwitch(
        client.db,
        fixture.workspaceId,
        fixture.sessionId,
      ),
    ).toBeNull();
  });

  test("a Codex checkpoint is rebuilt from the stored transcript, then the chat turns portable", async () => {
    const fixture = await remoteSession();
    const { turn, attemptId } = await claimTurn(fixture, "first question");
    const fence = {
      accountId: fixture.accountId,
      workspaceId: fixture.workspaceId,
      sessionId: fixture.sessionId,
      turnId: turn.id,
      expectedExecutionGeneration: turn.executionGeneration,
      expectedAttemptId: attemptId,
    };
    const claimed = await readActiveSessionHistory(
      client.db,
      fixture.workspaceId,
      fixture.sessionId,
    );
    const next = Math.max(...claimed.items.map((row) => row.position)) + 1;
    expect(
      await appendSessionHistoryItems(client.db, {
        ...fence,
        modelToolOutputTruncationTokens: 100,
        items: [
          {
            position: next,
            item: { type: "message", role: "assistant", content: "first answer" },
          },
          { position: next + 1, item: { type: "message", role: "user", content: "follow-up" } },
        ],
      }),
    ).toBe(true);

    // Codex remote compaction: a retained copy of the latest request plus an
    // opaque checkpoint only Codex can read.
    expect(
      await applyContextCompaction(client.db, {
        ...fence,
        replacementItems: [{ type: "message", role: "user", content: "follow-up" }],
        summaryItem: { type: "compaction", encrypted_content: "opaque-codex-checkpoint" },
        eventPayload: { trigger: "auto", implementation: "responses_compaction_v2" },
      }),
    ).toMatchObject({ applied: true });
    const afterRemote = await readActiveSessionHistory(
      client.db,
      fixture.workspaceId,
      fixture.sessionId,
    );
    expect(afterRemote.items.map((row) => row.item.type)).toEqual(["message", "compaction"]);

    // The checkpoint is Codex-only, so the chat stays remote_v2 and requests
    // the rebuild that will switch it. A superseded attempt cannot convert it.
    const attempt = {
      turnId: turn.id,
      executionGeneration: turn.executionGeneration,
      attemptId,
    };
    expect(
      await convertSessionToPortableCompactionForModelSwitch(
        client.db,
        fixture.workspaceId,
        fixture.sessionId,
        { ...attempt, attemptId: crypto.randomUUID() },
      ),
    ).toBe("fenced");
    expect(await sessionRow(fixture)).toEqual({
      codexCompactionMode: "remote_v2",
      compactRequested: false,
    });
    expect(
      await convertSessionToPortableCompactionForModelSwitch(
        client.db,
        fixture.workspaceId,
        fixture.sessionId,
        attempt,
      ),
    ).toEqual({ codexCompactionMode: "remote_v2", compactRequested: true });

    // The stored transcript is the conversation itself: superseded rows are
    // back, and nothing the compaction wrote (the retained copy or the
    // checkpoint) is included.
    const transcript = await readActiveSessionHistory(
      client.db,
      fixture.workspaceId,
      fixture.sessionId,
      { rows: "stored_transcript" },
    );
    const texts = transcript.items.map((row) => textOf(row.item));
    expect(texts).toHaveLength(3);
    expect(texts[0]).toContain("first question");
    expect(texts.slice(1)).toEqual([JSON.stringify("first answer"), JSON.stringify("follow-up")]);
    expect(texts.join("\n")).not.toContain("opaque-codex-checkpoint");

    // Installing the portable rebuild switches the chat in the same write.
    expect(
      await applyContextCompaction(client.db, {
        ...fence,
        replacementItems: [],
        summaryItem: { type: "message", role: "user", content: "portable summary" },
        clearRequestedCompaction: true,
        switchToPortableCompaction: true,
        eventPayload: { trigger: "auto", implementation: "portable_model_switch" },
      }),
    ).toMatchObject({ applied: true });
    expect(await sessionRow(fixture)).toEqual({
      codexCompactionMode: "portable",
      compactRequested: false,
    });
    const rebuilt = await readActiveSessionHistory(
      client.db,
      fixture.workspaceId,
      fixture.sessionId,
    );
    expect(rebuilt.items.map((row) => textOf(row.item))).toEqual([
      JSON.stringify("portable summary"),
    ]);
  });

  test("the stored transcript starts at the latest context clear", async () => {
    const fixture = await remoteSession();
    const rows = [
      { item: { type: "message", role: "user", content: "before the clear" }, active: false },
      { item: clearedContextMarkerItem(), active: true },
      { item: { type: "message", role: "user", content: "after the clear" }, active: true },
    ];
    await withWorkspaceRls(client.db, fixture.workspaceId, async (db) => {
      await db.insert(schema.sessionHistoryItems).values(
        rows.map((row, position) => ({
          accountId: fixture.accountId,
          workspaceId: fixture.workspaceId,
          sessionId: fixture.sessionId,
          turnId: null,
          position,
          item: row.item,
          active: row.active,
        })),
      );
    });
    const transcript = await readActiveSessionHistory(
      client.db,
      fixture.workspaceId,
      fixture.sessionId,
      { rows: "stored_transcript" },
    );
    expect(transcript.items.map((row) => textOf(row.item))).toEqual([
      JSON.stringify("[context cleared]"),
      JSON.stringify("after the clear"),
    ]);
  });

  test("a Codex compaction after a clear keeps the conversation it summarized", async () => {
    const fixture = await remoteSession();
    await withWorkspaceRls(client.db, fixture.workspaceId, async (db) => {
      await db.insert(schema.sessionHistoryItems).values([
        {
          accountId: fixture.accountId,
          workspaceId: fixture.workspaceId,
          sessionId: fixture.sessionId,
          turnId: null,
          position: 0,
          item: { type: "message", role: "user", content: "before the clear" },
          active: false,
        },
        {
          accountId: fixture.accountId,
          workspaceId: fixture.workspaceId,
          sessionId: fixture.sessionId,
          turnId: null,
          position: 1,
          item: clearedContextMarkerItem(),
          active: true,
        },
      ]);
    });
    const { turn, attemptId } = await claimTurn(fixture, "question after the clear");
    const fence = {
      accountId: fixture.accountId,
      workspaceId: fixture.workspaceId,
      sessionId: fixture.sessionId,
      turnId: turn.id,
      expectedExecutionGeneration: turn.executionGeneration,
      expectedAttemptId: attemptId,
    };
    const claimed = await readActiveSessionHistory(
      client.db,
      fixture.workspaceId,
      fixture.sessionId,
    );
    const next = Math.max(...claimed.items.map((row) => row.position)) + 1;
    expect(
      await appendSessionHistoryItems(client.db, {
        ...fence,
        modelToolOutputTruncationTokens: 100,
        items: [
          { position: next, item: { type: "message", role: "assistant", content: "answer" } },
        ],
      }),
    ).toBe(true);
    // remote_v2 retains user messages, so the compaction copies the clear
    // marker after the rows it summarized. That copy is not a new clear.
    expect(
      await applyContextCompaction(client.db, {
        ...fence,
        replacementItems: [
          clearedContextMarkerItem(),
          { type: "message", role: "user", content: "question after the clear" },
        ],
        summaryItem: { type: "compaction", encrypted_content: "opaque-codex-checkpoint" },
        eventPayload: { trigger: "auto", implementation: "responses_compaction_v2" },
      }),
    ).toMatchObject({ applied: true });
    const transcript = await readActiveSessionHistory(
      client.db,
      fixture.workspaceId,
      fixture.sessionId,
      { rows: "stored_transcript" },
    );
    const texts = transcript.items.map((row) => textOf(row.item));
    expect(texts).toHaveLength(3);
    expect(texts[0]).toBe(JSON.stringify("[context cleared]"));
    expect(texts[1]).toContain("question after the clear");
    expect(texts[2]).toBe(JSON.stringify("answer"));
    expect(texts.join("\n")).not.toContain("opaque-codex-checkpoint");
    expect(texts.join("\n")).not.toContain("before the clear");
  });
});
