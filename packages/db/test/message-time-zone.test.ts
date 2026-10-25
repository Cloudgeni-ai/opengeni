import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { MESSAGE_TIME_ZONE_METADATA_KEY, renderMessageSentAtForModel } from "@opengeni/contracts";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import {
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  getSessionTurn,
  initializeSessionStartAtomically,
  submitHumanPromptInTransaction,
  withWorkspaceSessionActivityRls as withWorkspaceRls,
  withWorkspaceSubjectSessionActivityRls as withWorkspaceSubjectRls,
} from "../src/index";
import * as schema from "../src/schema";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("message-time-zone");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function fixture() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "message-time-zone-test",
    accountExternalId: `account-${suffix}`,
    accountName: "Message time zone test",
    workspaceExternalSource: "message-time-zone-test",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "Message time zone test",
    subjectId: `user:creator-${suffix}`,
    subjectLabel: "Creator",
  });
  return access.workspaceGrants[0]!;
}

function sessionInput(grant: Awaited<ReturnType<typeof fixture>>) {
  return {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    initialMessage: "initial",
    resources: [],
    metadata: {},
    createdBy: {
      kind: "subject" as const,
      subjectId: grant.subjectId,
      ...(grant.subjectLabel ? { label: grant.subjectLabel } : {}),
    },
    model: "scripted-model",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none" as const,
  };
}

async function claimNext(workspaceId: string, sessionId: string) {
  const claimed = await claimSessionWorkForAttempt(client.db, workspaceId, {
    sessionId,
    workflowId: `session-${sessionId}`,
    workflowRunId: crypto.randomUUID(),
    attemptId: crypto.randomUUID(),
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") throw new Error("turn was not claimed");
  return claimed;
}

async function historyContent(workspaceId: string, turnId: string) {
  const rows = await withWorkspaceRls(client.db, workspaceId, (db) =>
    db
      .select({ item: schema.sessionHistoryItems.item })
      .from(schema.sessionHistoryItems)
      .where(eq(schema.sessionHistoryItems.turnId, turnId))
      .orderBy(schema.sessionHistoryItems.position),
  );
  return rows.map(({ item }) => item.content);
}

async function sendPrompt(
  grant: Awaited<ReturnType<typeof fixture>>,
  sessionId: string,
  turnMetadata?: Record<string, unknown>,
) {
  const sender = `user:sender-${crypto.randomUUID()}`;
  return await withWorkspaceSubjectRls(client.db, grant.workspaceId!, sender, (db) =>
    db.transaction((tx) =>
      submitHumanPromptInTransaction(tx as unknown as typeof db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId!,
        sessionId,
        subjectId: sender,
        subjectLabel: "Ada",
        actor: { type: "human", subjectId: sender },
        operationKey: crypto.randomUUID(),
        delivery: "send",
        text: "Remind me tomorrow at 9.",
        resources: [],
        reasoningEffortFallback: "low",
        source: "user",
        ...(turnMetadata ? { turnMetadata } : {}),
      }),
    ),
  );
}

describe("message time zone persistence", () => {
  test("a zoned prompt freezes its zone on the turn and renders it into history", async () => {
    const grant = await fixture();
    const session = await createSession(client.db, sessionInput(grant));
    const sent = await sendPrompt(grant, session.id, {
      [MESSAGE_TIME_ZONE_METADATA_KEY]: "Europe/Oslo",
    });
    const claimed = await claimNext(grant.workspaceId!, session.id);
    expect(claimed.turn.id).toBe(sent.turnId);

    const turn = await getSessionTurn(client.db, grant.workspaceId!, sent.turnId);
    expect(turn?.metadata[MESSAGE_TIME_ZONE_METADATA_KEY]).toBe("Europe/Oslo");

    const [content] = await historyContent(grant.workspaceId!, sent.turnId);
    const expectedLine = renderMessageSentAtForModel(claimed.turn.createdAt, "Ada", "Europe/Oslo");
    expect(expectedLine).toContain(" Europe/Oslo (");
    expect(expectedLine).toContain(" UTC) by Ada]");
    expect(content).toEqual([
      { type: "input_text", text: expectedLine },
      { type: "input_text", text: "Remind me tomorrow at 9." },
    ]);
  }, 60_000);

  test("an unzoned prompt renders exactly the UTC line", async () => {
    const grant = await fixture();
    const session = await createSession(client.db, sessionInput(grant));
    const sent = await sendPrompt(grant, session.id);
    const claimed = await claimNext(grant.workspaceId!, session.id);
    const turn = await getSessionTurn(client.db, grant.workspaceId!, sent.turnId);
    expect(turn?.metadata[MESSAGE_TIME_ZONE_METADATA_KEY]).toBeUndefined();
    const [content] = await historyContent(grant.workspaceId!, sent.turnId);
    expect(content).toEqual([
      { type: "input_text", text: renderMessageSentAtForModel(claimed.turn.createdAt, "Ada") },
      { type: "input_text", text: "Remind me tomorrow at 9." },
    ]);
  }, 60_000);

  test("the initial message of a created session keeps the create request's zone", async () => {
    const grant = await fixture();
    const session = await createSession(client.db, sessionInput(grant));
    const started = await initializeSessionStartAtomically(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      sessionId: session.id,
      reasoningEffortFallback: "low",
      createdEventPayload: {},
      initialTimeZone: "America/Los_Angeles",
    });
    if (!started.turn) throw new Error("initial turn was not created");
    expect(started.turn.metadata[MESSAGE_TIME_ZONE_METADATA_KEY]).toBe("America/Los_Angeles");

    const claimed = await claimNext(grant.workspaceId!, session.id);
    expect(claimed.turn.id).toBe(started.turn.id);
    const [content] = await historyContent(grant.workspaceId!, started.turn.id);
    const serialized = JSON.stringify(content);
    expect(serialized).toContain(
      JSON.stringify(
        renderMessageSentAtForModel(claimed.turn.createdAt, "Creator", "America/Los_Angeles"),
      ),
    );
  }, 60_000);

  test("an unresolvable initial zone is ignored", async () => {
    const grant = await fixture();
    const session = await createSession(client.db, sessionInput(grant));
    const started = await initializeSessionStartAtomically(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      sessionId: session.id,
      reasoningEffortFallback: "low",
      createdEventPayload: {},
      initialTimeZone: "Mars/Olympus_Mons",
    });
    if (!started.turn) throw new Error("initial turn was not created");
    expect(started.turn.metadata[MESSAGE_TIME_ZONE_METADATA_KEY]).toBeUndefined();
  }, 60_000);
});
