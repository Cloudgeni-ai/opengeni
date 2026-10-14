import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  appendSessionEvents,
  bootstrapWorkspace,
  createDb,
  createSession,
  listInboxItems,
  setInboxSettings,
  type DbClient,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  type SharedTestDatabase,
} from "@opengeni/testing";

import { registerNotificationTools } from "../src/mcp/notification-tools";

/* The inbox tool against real PostgreSQL: by default an agent sees and tidies
   only notifications; with full access it sees every open item, needs-you
   first, and can snooze, unsnooze and dismiss any of them without answering. */

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
    attempt: () => {
      throw new Error("not used");
    },
    json: (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }] }),
  });
  const tidy = async (input: Record<string, unknown> = {}) => {
    const result = await handlers.get("inbox_tidy")!({
      dismissItemIds: [],
      snooze: [],
      unsnoozeItemIds: [],
      ...input,
    });
    return JSON.parse(result.content[0]!.text) as Record<string, any>;
  };
  const owner = { accountId: scope.accountId, subjectId };
  return { db, owner, tidy };
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
});
