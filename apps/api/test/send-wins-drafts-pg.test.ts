import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { signDelegatedAccessToken, type AccessGrant } from "@opengeni/contracts";
import {
  bootstrapWorkspace,
  createDb,
  sessionListChangesFor,
  type DbClient,
  type SessionListNotification,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { waitFor } from "@opengeni/testing/process";
import { testSettings } from "@opengeni/testing/settings";
import { createApp } from "../src/app";

// Send wins: a Send carries what is in the box and is never refused over the
// draft. Afterwards the draft is cleared only while it still holds what was
// sent. A newer draft from another of the person's devices stays as the draft.

const SECRET = "send-wins-drafts-secret";
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("send-wins-drafts");
  if (!shared && process.env.OPENGENI_REQUIRE_REAL_DB === "1") {
    throw new Error("Send-wins draft tests require real PostgreSQL");
  }
  // The handle's own LISTEN source, as the API's live streams use it.
  if (shared) client = createDb(shared.appUrl, { notificationDatabaseUrl: shared.appUrl });
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

const settings = testSettings({ delegationSecret: SECRET, sandboxBackend: "none" });

type Draft = { revision: number; text: string; sourceTurnId?: string | null };
type Turn = { id: string; version: number };

async function fixture() {
  if (!client) throw new Error("PostgreSQL fixture unavailable");
  const context = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test:send-wins-drafts",
    accountExternalId: crypto.randomUUID(),
    accountName: "Send wins",
    workspaceExternalSource: "test:send-wins-drafts",
    workspaceExternalId: crypto.randomUUID(),
    workspaceName: "Send wins",
    subjectId: `user:send-wins-${crypto.randomUUID()}`,
  });
  const grant = context.workspaceGrants[0]! as AccessGrant;
  const app = createApp({
    settings,
    db: client.db,
    bus: new MemoryEventBus(),
    workflowClient: {
      signalUserMessage: async () => undefined,
      wakeSessionWorkflow: async () => undefined,
      requestSessionWorkflowWakeDispatch: async () => undefined,
    } as never,
    managedAuth: null,
  });
  async function request(method: "GET" | "POST" | "PUT", path: string, body?: unknown) {
    return app.request(`/v1/workspaces/${grant.workspaceId}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${await signDelegatedAccessToken(SECRET, {
          ...grant,
          principalKind: "human_session",
          exp: Math.floor(Date.now() / 1_000) + 3_600,
        })}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  /** The body of an accepted response; `status` 0 accepts any success. */
  async function json<T>(response: Response, status: number): Promise<T> {
    const text = await response.clone().text();
    if (status === 0) expect(response.status, text).toBeLessThan(300);
    else expect(response.status, text).toBe(status);
    return (await response.json()) as T;
  }

  const newChat = {
    read: async () => await json<Draft>(await request("GET", "/new-session-draft"), 200),
    save: async (text: string, expectedRevision: number) =>
      await json<Draft>(
        await request("PUT", "/new-session-draft", {
          text,
          resources: [],
          tools: [],
          toolsProvided: false,
          model: settings.openaiModel,
          reasoningEffort: settings.openaiReasoningEffort,
          latencyMode: "standard",
          modelProvided: true,
          options: {},
          expectedRevision,
        }),
        200,
      ),
    send: async (text: string, basis: number | undefined, keys = sendKeys()) =>
      await request("POST", "/sessions", {
        initialMessage: text,
        model: settings.openaiModel,
        reasoningEffort: settings.openaiReasoningEffort,
        latencyMode: "standard",
        ...keys,
        ...(basis === undefined ? {} : { expectedNewSessionDraftRevision: basis }),
      }),
  };

  async function chat() {
    const created = await json<{ id: string }>(
      await request("POST", "/sessions", {
        initialMessage: "Read the release notes",
        model: settings.openaiModel,
        reasoningEffort: settings.openaiReasoningEffort,
        ...sendKeys(),
      }),
      202,
    );
    const path = `/sessions/${created.id}/composer-draft`;
    return {
      id: created.id,
      read: async () => await json<Draft>(await request("GET", path), 200),
      save: async (text: string, expectedRevision: number) =>
        await json<Draft>(
          await request("PUT", path, { text, annotations: [], resources: [], expectedRevision }),
          200,
        ),
      send: async (text: string, basis: number, clientEventId = crypto.randomUUID()) =>
        await request("POST", `${path}/submit`, {
          text,
          annotations: [],
          resources: [],
          expectedDraftRevision: basis,
          clientEventId,
          delivery: "send",
        }),
      /** Edit, from the queue: the queued message comes back into the draft. */
      edit: async (turn: Turn, expectedDraftRevision: number) =>
        await json<{ draft: Draft }>(
          await request("POST", `/sessions/${created.id}/queue/${turn.id}/edit`, {
            clientEventId: crypto.randomUUID(),
            expectedTurnVersion: turn.version,
            expectedDraftRevision,
            replaceDraft: false,
          }),
          200,
        ),
    };
  }
  return { newChat, chat, json, workspaceId: grant.workspaceId!, subjectId: grant.subjectId };
}

function sendKeys() {
  return { clientEventId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID() };
}

describe("a new chat's Send wins over its draft", () => {
  test("a newer draft saved on another device stays as the draft", async () => {
    if (!client) return;
    const f = await fixture();
    const mine = await f.newChat.save("Plan the launch", 0);
    // Another device keeps typing after this one composed its Send.
    const theirs = await f.newChat.save("Plan the launch and the follow-up", mine.revision);
    await f.json(await f.newChat.send("Plan the launch", mine.revision), 202);
    expect(await f.newChat.read()).toMatchObject({
      revision: theirs.revision,
      text: "Plan the launch and the follow-up",
    });
  }, 180_000);

  test("text typed after the last save is sent, and the draft it came from is cleared", async () => {
    if (!client) return;
    const f = await fixture();
    const saved = await f.newChat.save("Plan the", 0);
    await f.json(await f.newChat.send("Plan the launch", saved.revision), 202);
    expect(await f.newChat.read()).toMatchObject({ revision: saved.revision + 1, text: "" });
  }, 180_000);

  test("a Send from a revision the server never had still starts the chat", async () => {
    if (!client) return;
    const f = await fixture();
    const saved = await f.newChat.save("Keep this for later", 0);
    await f.json(await f.newChat.send("Something else", saved.revision + 40), 202);
    await f.json(await f.newChat.send("No draft named", undefined), 202);
    expect(await f.newChat.read()).toMatchObject({
      revision: saved.revision,
      text: "Keep this for later",
    });
  }, 180_000);

  test("a retried Send starts one chat", async () => {
    if (!client) return;
    const f = await fixture();
    const saved = await f.newChat.save("Plan the launch", 0);
    const keys = sendKeys();
    const first = await f.json<{ id: string }>(
      await f.newChat.send("Plan the launch", saved.revision, keys),
      202,
    );
    const newer = await f.newChat.save("Next idea", saved.revision + 1);
    const retried = await f.newChat.send("Plan the launch", saved.revision, keys);
    expect(retried.status).toBeLessThan(300);
    expect(((await retried.json()) as { id: string }).id).toBe(first.id);
    // The retry is the same accepted Send: it never clears the newer draft.
    expect(await f.newChat.read()).toMatchObject({ revision: newer.revision, text: "Next idea" });
  }, 180_000);
});

describe("a follow-up's Send wins over its draft", () => {
  test("a newer draft saved on another device stays as the draft", async () => {
    if (!client) return;
    const f = await fixture();
    const chat = await f.chat();
    const mine = await chat.save("What changed?", (await chat.read()).revision);
    const theirs = await chat.save("What changed, and why?", mine.revision);
    const submitted = await f.json<{ draft: Draft }>(
      await chat.send("What changed?", mine.revision),
      0,
    );
    expect(submitted.draft).toMatchObject({ revision: theirs.revision, text: theirs.text });
    expect(await chat.read()).toMatchObject({ revision: theirs.revision, text: theirs.text });
  }, 180_000);

  test("text typed after the last save is sent, and the draft it came from is cleared", async () => {
    if (!client) return;
    const f = await fixture();
    const chat = await f.chat();
    const saved = await chat.save("What", (await chat.read()).revision);
    const submitted = await f.json<{ draft: Draft }>(
      await chat.send("What changed?", saved.revision),
      0,
    );
    expect(submitted.draft).toMatchObject({ revision: saved.revision + 1, text: "" });
  }, 180_000);

  test("a draft that moved on but holds exactly what was sent is cleared", async () => {
    if (!client) return;
    const f = await fixture();
    const chat = await f.chat();
    const before = await chat.save("What", (await chat.read()).revision);
    const saved = await chat.save("What changed?", before.revision);
    const submitted = await f.json<{ draft: Draft }>(
      await chat.send("What changed?", before.revision),
      0,
    );
    expect(submitted.draft).toMatchObject({ revision: saved.revision + 1, text: "" });
  }, 180_000);

  test("a retried Send adds one message", async () => {
    if (!client) return;
    const f = await fixture();
    const chat = await f.chat();
    const saved = await chat.save("What changed?", (await chat.read()).revision);
    const clientEventId = crypto.randomUUID();
    const first = await f.json<{ turn: { id: string } }>(
      await chat.send("What changed?", saved.revision, clientEventId),
      0,
    );
    const retried = await chat.send("What changed?", saved.revision, clientEventId);
    expect(retried.status, await retried.clone().text()).toBeLessThan(300);
    expect(((await retried.json()) as { turn: { id: string } }).turn.id).toBe(first.turn.id);
  }, 180_000);

  test("with no saved draft, a Send from any revision returns the empty draft, also on retry", async () => {
    if (!client) return;
    const f = await fixture();
    const chat = await f.chat();
    expect(await chat.read()).toMatchObject({ revision: 0, text: "" });
    const clientEventId = crypto.randomUUID();
    const first = await f.json<{ turn: { id: string }; draft: Draft }>(
      await chat.send("What changed?", 3, clientEventId),
      0,
    );
    expect(first.draft).toMatchObject({ revision: 0, text: "" });
    const retried = await f.json<{ turn: { id: string }; draft: Draft }>(
      await chat.send("What changed?", 3, clientEventId),
      0,
    );
    expect(retried.turn.id).toBe(first.turn.id);
    expect(retried.draft).toMatchObject({ revision: 0, text: "" });
  }, 180_000);

  test("a Send from before another device's queue Edit is queued, and the edited message stays in the draft", async () => {
    if (!client) return;
    const f = await fixture();
    const chat = await f.chat();
    const typed = await chat.save("And the migration plan?", (await chat.read()).revision);
    const queued = await f.json<{ turn: Turn; draft: Draft }>(
      await chat.send("And the migration plan?", typed.revision),
      0,
    );
    const seen = queued.draft.revision;
    // Another device takes the queued message back into the draft to edit it.
    const edited = await chat.edit(queued.turn, seen);
    expect(edited.draft).toMatchObject({
      text: "And the migration plan?",
      sourceTurnId: queued.turn.id,
    });
    const stale = await f.json<{ turn: Turn; draft: Draft }>(
      await chat.send("Also the rollback steps", seen),
      0,
    );
    expect(stale.turn.id).not.toBe(queued.turn.id);
    expect(stale.draft).toMatchObject({
      revision: edited.draft.revision,
      text: "And the migration plan?",
      sourceTurnId: queued.turn.id,
    });
    expect(await chat.read()).toMatchObject({
      revision: edited.draft.revision,
      sourceTurnId: queued.turn.id,
    });
  }, 180_000);
});

describe("draft changes reach the author's other devices", () => {
  test("save, Send, queue Edit and the new-chat clear each announce a change; a Send that leaves the draft alone announces none", async () => {
    if (!client || !shared) return;
    const f = await fixture();
    const source = sessionListChangesFor(client.db);
    if (!source) throw new Error("The database handle has no notification source");
    const events: SessionListNotification[] = [];
    const release = source.subscribe((event) => events.push(event));
    const hints = () =>
      events.flatMap((event) =>
        event.type === "change" && event.change.workspaceId === f.workspaceId && event.change.draft
          ? [{ sessionId: event.change.sessionId, subjectId: event.change.subjectId }]
          : [],
      );
    // Notifications arrive in commit order: a later marker proves nothing
    // else is still on its way.
    const settle = async () => {
      const marker = crypto.randomUUID();
      await shared!.admin`select pg_notify('opengeni_session_lists', ${JSON.stringify({
        schema: "public",
        workspaceId: marker,
        sessionId: null,
        subjectId: null,
        all: true,
      })})`;
      await waitFor(() =>
        events.some((event) => event.type === "change" && event.change.workspaceId === marker),
      );
    };
    try {
      await waitFor(() => events.some((event) => event.type === "connected"));
      const newChat = { sessionId: null, subjectId: f.subjectId };

      const saved = await f.newChat.save("Plan the launch", 0);
      await settle();
      expect(hints()).toEqual([newChat]);

      // Started from the saved draft: it is cleared.
      await f.json(await f.newChat.send("Plan the launch", saved.revision), 202);
      await settle();
      expect(hints()).toEqual([newChat, newChat]);

      // Started without naming the draft, and from a draft that moved on:
      // neither touches it, so neither announces anything.
      const kept = await f.newChat.save("Next idea", saved.revision + 1);
      await f.json(await f.newChat.send("Something else", undefined), 202);
      await f.json(await f.newChat.send("Something else", kept.revision - 1), 202);
      await settle();
      expect(hints()).toEqual([newChat, newChat, newChat]);

      const chat = await f.chat();
      const inChat = { sessionId: chat.id, subjectId: f.subjectId };
      const before = hints().length;
      const draft = await chat.save("And the migration plan?", (await chat.read()).revision);
      const queued = await f.json<{ turn: Turn; draft: Draft }>(
        await chat.send("And the migration plan?", draft.revision),
        0,
      );
      await chat.edit(queued.turn, queued.draft.revision);
      await settle();
      expect(hints().slice(before)).toEqual([inChat, inChat, inChat]);
    } finally {
      release();
    }
  }, 180_000);
});
