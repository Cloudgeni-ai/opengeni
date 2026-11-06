import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  appendSessionEvents,
  bootstrapWorkspace,
  createDb,
  createSession,
  listInboxItems,
  setInboxSettings,
  submitHumanPromptInTransaction,
  withWorkspaceSubjectSessionActivityRls,
  type DbClient,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";

import { registerNotificationTools } from "../src/mcp/notification-tools";

/* The inbox tool against real PostgreSQL: by default an agent sees and tidies
   only notifications; with full access it sees every open item, needs-you
   first, and can snooze, unsnooze and dismiss any of them without answering.
   It acts for the person whose message started the calling turn, so another
   member's turn in a shared chat never reaches the chat owner's inbox. */

let shared: SharedTestDatabase;
let client: DbClient;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("inbox-agent-access");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 4 });
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 60_000);

type Handler = (input: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;

async function setup() {
  const db = client.db;
  const subjectId = `user:${crypto.randomUUID()}`;
  const access = await bootstrapWorkspace(db, {
    accountExternalSource: "inbox-agent-access",
    accountExternalId: `account:${crypto.randomUUID()}`,
    accountName: "Inbox access",
    workspaceExternalSource: "inbox-agent-access",
    workspaceExternalId: `workspace:${crypto.randomUUID()}`,
    workspaceName: "Inbox access",
    subjectId,
  });
  const grant = access.workspaceGrants[0]!;
  const scope = { accountId: grant.accountId, workspaceId: grant.workspaceId! };
  const start = async (label: string) =>
    await createSession(db, {
      ...scope,
      initialMessage: label,
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium" as const,
      latencyMode: "standard" as const,
      sandboxBackend: "none",
      createdBy: { kind: "subject", subjectId, label: "Person" },
      createdByContext: { label: "Person" },
    });
  const agent = await start("agent");
  const other = await start("other");
  await appendSessionEvents(db, scope.workspaceId, other.id, [
    {
      type: "session.humanInput.requested",
      payload: { request: { id: "which", questions: [{ prompt: "Which branch?" }] } },
    },
    {
      type: "session.notification.posted",
      payload: { key: "deploy", title: "Deployed", body: "All green", urgency: "normal" },
    },
  ]);
  /** A message `sender` sends into the agent's chat; returns its turn. */
  const send = async (sender: string) => {
    await withWorkspaceSubjectSessionActivityRls(db, scope.workspaceId, sender, (scoped) =>
      scoped.transaction((tx) =>
        submitHumanPromptInTransaction(tx as unknown as typeof scoped, {
          ...scope,
          sessionId: agent.id,
          subjectId: sender,
          actor: { type: "human", subjectId: sender },
          operationKey: `send-${crypto.randomUUID()}`,
          delivery: "send",
          text: "tidy my inbox",
          resources: [],
          reasoningEffortFallback: "low",
          source: "user",
        }),
      ),
    );
    const [turn] = await shared.admin<{ id: string }[]>`
      select id from session_turns
      where session_id = ${agent.id} and initiating_human_subject_id = ${sender}
      order by position desc limit 1`;
    return turn!.id;
  };
  /** inbox_tidy as the agent runs it in the turn `turnId`. */
  const tidyIn = (turnId: string) => {
    const handlers = new Map<string, Handler>();
    registerNotificationTools({
      server: {
        registerTool: (name: string, _config: unknown, handler: Handler) => {
          handlers.set(name, handler);
        },
      } as never,
      deps: { db, bus: new MemoryEventBus() } as never,
      grant: grant as never,
      sessionId: agent.id,
      authorize: async () => undefined,
      attempt: () => ({
        callerTurnId: turnId,
        callerExecutionGeneration: 1,
        callerAttemptId: crypto.randomUUID(),
      }),
      json: (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }] }),
    });
    return async (input: Record<string, unknown> = {}) => {
      const result = await handlers.get("inbox_tidy")!({
        dismissItemIds: [],
        snooze: [],
        unsnoozeItemIds: [],
        ...input,
      });
      return JSON.parse(result.content[0]!.text) as Record<string, any>;
    };
  };
  const tidy = tidyIn(await send(subjectId));
  const owner = { accountId: scope.accountId, subjectId };
  return { db, owner, scope, send, tidyIn, tidy };
}

describe("agent access to the person's inbox", () => {
  test("without full access, another session's items stay out of reach", async () => {
    const { owner, tidy, db } = await setup();
    const own = await tidy();
    expect(own.policy).toBe("own_sessions");
    expect(own.notifications).toEqual([]);
    await setInboxSettings(db, { ...owner, tidyPolicy: "any_agent" });
    const anyAgent = await tidy();
    expect(anyAgent.notifications.map((item: any) => item.title)).toEqual(["Deployed"]);
    expect(anyAgent.items).toBeUndefined();
  });

  test("with full access, an agent sees everything and snoozes or dismisses without answering", async () => {
    const { owner, tidy, db } = await setup();
    await setInboxSettings(db, { ...owner, tidyPolicy: "full_access" });
    const listed = await tidy();
    expect(listed.policy).toBe("full_access");
    expect(
      listed.items.map((item: any) => [item.kind, item.title, item.needsPerson, item.sessionTitle]),
    ).toEqual([
      ["question", "Which branch?", true, "New conversation"],
      ["notification", "Deployed", false, "New conversation"],
    ]);
    const question = listed.items[0].itemId as string;
    const note = listed.items[1].itemId as string;

    const until = new Date(Date.now() + 3_600_000).toISOString();
    const snoozed = await tidy({ snooze: [{ itemId: question, until }] });
    expect(snoozed.snoozed).toEqual([{ itemId: question, until }]);
    expect(snoozed.items[0].snoozedUntil).toBe(until);

    const woken = await tidy({ unsnoozeItemIds: [question] });
    expect(woken.unsnoozed).toEqual([question]);
    expect(woken.items[0].snoozedUntil).toBeNull();

    await expect(
      tidy({ snooze: [{ itemId: note, until: new Date(Date.now() - 60_000).toISOString() }] }),
    ).rejects.toThrow(/future/);

    const cleared = await tidy({ dismissItemIds: [question, note] });
    expect(cleared.dismissed.sort()).toEqual([question, note].sort());
    expect(cleared.items).toEqual([]);
    expect(await listInboxItems(db, owner)).toEqual([]);
  });

  test("another member's turn in the owner's shared chat reaches only that member's inbox", async () => {
    const { owner, scope, send, tidyIn, db } = await setup();
    // Bob, another member of Alice's workspace, with a notification of his own.
    const bob = `user:${crypto.randomUUID()}`;
    await shared.admin`
      insert into workspace_memberships (account_id, workspace_id, subject_id)
      values (${scope.accountId}, ${scope.workspaceId}, ${bob})`;
    const bobs = await createSession(db, {
      ...scope,
      initialMessage: "bob's own",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium" as const,
      latencyMode: "standard" as const,
      sandboxBackend: "none",
      createdBy: { kind: "subject", subjectId: bob, label: "Bob" },
      createdByContext: { label: "Bob" },
    });
    await appendSessionEvents(db, scope.workspaceId, bobs.id, [
      {
        type: "session.notification.posted",
        payload: { key: "bob-build", title: "Bob's build", body: "Done", urgency: "normal" },
      },
    ]);
    const bobOwner = { accountId: scope.accountId, subjectId: bob };
    // Both let agents tidy everything; Alice's own inbox has a question and a note.
    await setInboxSettings(db, { ...owner, tidyPolicy: "full_access" });
    await setInboxSettings(db, { ...bobOwner, tidyPolicy: "full_access" });
    const alicesBefore = await listInboxItems(db, owner);
    expect(alicesBefore.map((item) => item.title).sort()).toEqual(["Deployed", "Which branch?"]);

    // Bob sends a message into Alice's chat; its turn tidies Bob's inbox only.
    const asBob = tidyIn(await send(bob));
    const listed = await asBob();
    expect(listed.items.map((item: any) => item.title)).toEqual(["Bob's build"]);
    const until = new Date(Date.now() + 3_600_000).toISOString();
    const touched = await asBob({
      dismissItemIds: alicesBefore.map((item) => item.id),
      snooze: alicesBefore.map((item) => ({ itemId: item.id, until })),
    });
    expect(touched.dismissed).toEqual([]);
    expect(touched.snoozed).toEqual([]);
    expect(await listInboxItems(db, owner)).toEqual(alicesBefore);

    // Alice's own turn in the same chat still tidies hers.
    const asAlice = tidyIn(await send(owner.subjectId));
    expect((await asAlice()).items.map((item: any) => item.title)).toEqual([
      "Which branch?",
      "Deployed",
    ]);
  });
});
