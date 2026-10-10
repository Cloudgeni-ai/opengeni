import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  appendSessionEvents,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  getMemberNotificationsAllowed,
  grantWorkspaceAccess,
  initializeSessionStartAtomically,
  listInboxItems,
  setMemberNotificationsAllowed,
  type DbClient,
  type InboxItemRow,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  type SharedTestDatabase,
} from "@opengeni/testing";

import { registerNotificationTools } from "../src/mcp/notification-tools";
import { itemsWithUnavailableSession, presentInboxItem } from "../src/routes/inbox";

/* Notifying another member of the workspace: it reaches them only while they
   allow other members' agents to, shows who it came from, keeps per-person
   copies of one key, and never reaches non-members or speaks for nobody. */

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
setDefaultTimeout(60_000);

let shared: SharedTestDatabase | null = null;
let client: DbClient;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("inbox-member-notifications");
  if (!shared) {
    if (requireRealDatabase) throw new Error("PostgreSQL test database unavailable");
    return;
  }
  client = createDb(shared.appUrl, { max: 4 });
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 60_000);

type Handler = (input: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;

async function setup(options: { creator?: string } = {}) {
  const db = client.db;
  const ada = `user:${crypto.randomUUID()}`;
  const bea = `user:${crypto.randomUUID()}`;
  const access = await bootstrapWorkspace(db, {
    accountExternalSource: "inbox-member-notifications",
    accountExternalId: `account:${crypto.randomUUID()}`,
    accountName: "Team",
    workspaceExternalSource: "inbox-member-notifications",
    workspaceExternalId: `workspace:${crypto.randomUUID()}`,
    workspaceName: "Team",
    subjectId: ada,
    subjectLabel: "Ada",
  });
  const grant = access.workspaceGrants[0]!;
  const scope = { accountId: grant.accountId, workspaceId: grant.workspaceId! };
  await grantWorkspaceAccess(db, {
    ...scope,
    subjectId: bea,
    subjectLabel: "Bea",
    permissions: ["sessions:read"],
  });
  const creator = options.creator ?? ada;
  const session = await createSession(db, {
    ...scope,
    initialMessage: "Work",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none",
    createdBy: { kind: "subject", subjectId: creator, label: "Creator" },
    createdByContext: { label: "Creator" },
  });
  await initializeSessionStartAtomically(db, {
    ...scope,
    sessionId: session.id,
    clientEventId: `initial:${session.id}`,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
  });
  const attemptId = crypto.randomUUID();
  const claimed = await claimSessionWorkForAttempt(db, scope.workspaceId, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: `dispatch-${crypto.randomUUID()}`,
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") throw new Error(`expected a claim, got ${claimed.action}`);
  const handlers = new Map<string, Handler>();
  registerNotificationTools({
    server: {
      registerTool: (name: string, _config: unknown, handler: Handler) => {
        handlers.set(name, handler);
      },
    } as never,
    deps: { db, bus: new MemoryEventBus() } as never,
    grant: grant as never,
    sessionId: session.id,
    authorize: async () => undefined,
    attempt: () => ({
      callerTurnId: claimed.turn.id,
      callerExecutionGeneration: claimed.turn.executionGeneration,
      callerAttemptId: attemptId,
    }),
    json: (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }] }),
  });
  const call = async (name: string, input: Record<string, unknown>) =>
    JSON.parse((await handlers.get(name)!(input)).content[0]!.text) as Record<string, any>;
  const notify = (input: Record<string, unknown>) =>
    call("notify_user", { message: "", urgency: "normal", ...input });
  const inboxOf = async (subjectId: string) =>
    (await listInboxItems(db, { accountId: scope.accountId, subjectId })).filter(
      (item) => item.sessionId === session.id && item.kind === "notification",
    );
  return { db, scope, ada, bea, session, notify, call, inboxOf };
}

describe("notifying another member of the workspace", () => {
  test("is off by default: the agent is told and nothing reaches the member", async () => {
    if (!shared) return;
    const { scope, bea, notify, inboxOf } = await setup();
    expect(await getMemberNotificationsAllowed(client.db, { ...scope, subjectId: bea })).toBe(
      false,
    );
    await expect(
      notify({ title: "Review ready", key: "review", recipient: "Bea" }),
    ).rejects.toThrow("Bea hasn't allowed other people's agents to notify them in this workspace");
    expect(await inboxOf(bea)).toEqual([]);
  });

  test("never reaches someone outside the workspace", async () => {
    if (!shared) return;
    const { notify } = await setup();
    const outsider = `user:${crypto.randomUUID()}`;
    await expect(notify({ title: "Hi", recipient: outsider })).rejects.toThrow(
      "is not a member of this workspace",
    );
    await expect(notify({ title: "Hi", recipient: "Nobody" })).rejects.toThrow(
      "is not a member of this workspace",
    );
  });

  test("a session that works for no person cannot notify members", async () => {
    if (!shared) return;
    const { scope, bea, notify } = await setup({ creator: "service:nightly" });
    await setMemberNotificationsAllowed(client.db, { ...scope, subjectId: bea, allowed: true });
    await expect(notify({ title: "Hi", recipient: "Bea" })).rejects.toThrow(
      "This session works for no person",
    );
  });

  test("once allowed, it reaches the member, says who sent it, and keeps per-person copies", async () => {
    if (!shared) return;
    const { scope, ada, bea, notify, call, inboxOf } = await setup();
    await setMemberNotificationsAllowed(client.db, { ...scope, subjectId: bea, allowed: true });

    const sent = await notify({ title: "Review ready", key: "review", recipient: "bea" });
    expect(sent).toMatchObject({ ok: true, delivered: true, recipient: "Bea" });
    expect(await inboxOf(ada)).toEqual([]);
    const [theirs] = await inboxOf(bea);
    expect(theirs).toMatchObject({
      title: "Review ready",
      sourceKey: "review",
      sender: { subjectId: ada, label: "Ada" },
    });

    // The same key to the person the session works for is a separate item.
    await notify({ title: "Review sent to Bea", key: "review" });
    expect((await inboxOf(ada)).map((item) => [item.title, item.sender])).toEqual([
      ["Review sent to Bea", null],
    ]);
    // Posting again to Bea updates her copy in place.
    const again = await notify({ title: "Review ready (v2)", key: "review", recipient: bea });
    expect(again.updatedInPlace).toBe(true);
    expect((await inboxOf(bea)).map((item) => item.title)).toEqual(["Review ready (v2)"]);

    // Withdrawing Bea's copy leaves Ada's.
    await call("notification_withdraw", { key: "review", recipient: "Bea" });
    expect(await inboxOf(bea)).toEqual([]);
    expect((await inboxOf(ada)).map((item) => item.title)).toEqual(["Review sent to Bea"]);
  });

  test("the inbox itself refuses an event for a member who has not allowed it", async () => {
    if (!shared) return;
    const { scope, bea, session, inboxOf } = await setup();
    // Even an event written past the tool reaches nobody without the setting.
    await appendSessionEvents(client.db, scope.workspaceId, session.id, [
      {
        type: "session.notification.posted",
        payload: {
          key: "sneaky",
          title: "Hello",
          body: "",
          urgency: "normal",
          recipientSubjectId: bea,
          sender: { subjectId: "user:x", label: "X" },
        },
      },
    ]);
    expect(await inboxOf(bea)).toEqual([]);
    // ...and turning it off again stops new ones.
    await setMemberNotificationsAllowed(client.db, { ...scope, subjectId: bea, allowed: true });
    await setMemberNotificationsAllowed(client.db, { ...scope, subjectId: bea, allowed: false });
    await appendSessionEvents(client.db, scope.workspaceId, session.id, [
      {
        type: "session.notification.posted",
        payload: {
          key: "later",
          title: "Later",
          body: "",
          urgency: "normal",
          recipientSubjectId: bea,
        },
      },
    ]);
    expect(await inboxOf(bea)).toEqual([]);
  });
});

describe("the inbox links another member's session only when the person can open it", () => {
  const row = (id: string, sender: InboxItemRow["sender"]): InboxItemRow => ({
    id,
    workspaceId: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    kind: "notification",
    sourceKey: "k",
    title: "Hello",
    subtitle: "",
    body: "",
    facts: [],
    link: null,
    eventSequence: 7,
    choices: [],
    urgency: "normal",
    status: "open",
    unread: true,
    snoozedUntil: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    resolvedAt: null,
    sender,
  });

  test("own items are never checked; an unreadable sender session is hidden", async () => {
    const own = row("own", null);
    const visible = row("shared", { subjectId: "user:a", label: "Ada" });
    const hidden = row("private", { subjectId: "user:a", label: "Ada" });
    const checked: string[] = [];
    const unavailable = await itemsWithUnavailableSession([own, visible, hidden], async (item) => {
      checked.push(item.id);
      return item.id === "shared";
    });
    expect(checked).toEqual(["shared", "private"]);
    expect([...unavailable]).toEqual(["private"]);
    expect(presentInboxItem(hidden, "Secret plans", false)).toMatchObject({
      sessionTitle: null,
      eventSequence: null,
      sessionAvailable: false,
      sender: { label: "Ada" },
    });
    expect(presentInboxItem(visible, "Release", true)).toMatchObject({
      sessionTitle: "Release",
      eventSequence: 7,
      sessionAvailable: true,
    });
  });
});
