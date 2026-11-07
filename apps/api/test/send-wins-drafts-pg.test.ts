import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { signDelegatedAccessToken, type AccessGrant } from "@opengeni/contracts";
import { bootstrapWorkspace, createDb, type DbClient } from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
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
  if (shared) client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

const settings = testSettings({ delegationSecret: SECRET, sandboxBackend: "none" });

type Draft = { revision: number; text: string };

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
    };
  }
  return { newChat, chat, json };
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
});
