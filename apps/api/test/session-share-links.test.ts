import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { signDelegatedAccessToken } from "@opengeni/contracts";
import {
  SHARE_LINKS_EXTERNAL_PERSON_MESSAGE,
  SHARE_LINKS_NOT_STARTER_MESSAGE,
  SHARE_LINKS_OFF_MESSAGE,
  type ApiRouteDeps,
  type SessionWorkflowClient,
} from "@opengeni/core";
import { bootstrapWorkspace, createDb, createSession, type DbClient } from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { Hono } from "hono";
import { registerSessionShareLinkRoutes } from "../src/routes/session-share-links";
import { registerSessionRoutes } from "../src/routes/sessions";

// A chat's read-only share link: the person who started the chat creates,
// refreshes and stops it; anyone holding it reads only the visible
// conversation, without signing in, until it is stopped or links are off.

const SECRET = "session-share-links-test-secret";
const WEB = "https://app.example.test";
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

function appWith(sharingAllowed: boolean): Hono {
  const noop = async () => undefined;
  const app = new Hono();
  const deps = {
    settings: testSettings({
      productAccessMode: "managed",
      delegationSecret: SECRET,
      webBaseUrl: WEB,
      privacyChatShareLinksAllowed: sharingAllowed,
    }),
    db: client!.db,
    bus: new MemoryEventBus(),
    workflowClient: {
      signalUserMessage: noop,
      wakeSessionWorkflow: noop,
      requestSessionWorkflowWakeDispatch: noop,
      signalApprovalDecision: noop,
      signalSessionControl: noop,
      syncScheduledTask: noop,
      deleteScheduledTaskSchedule: noop,
      triggerScheduledTask: noop,
    } as unknown as SessionWorkflowClient,
    githubStateSecret: "test",
    objectStorage: null,
    documentIndexer: { indexDocument: noop },
    getDocumentServices: () => ({}) as never,
  } as unknown as ApiRouteDeps;
  registerSessionRoutes(app, deps);
  registerSessionShareLinkRoutes(app, deps);
  return app;
}

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("api-session-share-links");
  if (!shared) {
    if (requireRealDatabase) throw new Error("PostgreSQL is required");
    return;
  }
  client = createDb(shared.appUrl, { max: 2 });
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function bearer(
  grant: { accountId: string; workspaceId: string },
  subjectId: string,
): Promise<string> {
  return `Bearer ${await signDelegatedAccessToken(SECRET, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId,
    permissions: ["sessions:read", "sessions:control"],
    principalKind: "human_session",
    exp: Math.floor(Date.now() / 1000) + 3_600,
  })}`;
}

/** A workspace-shared chat started by `starter`, with a tool call that read private data. */
async function chat() {
  const suffix = crypto.randomUUID();
  const starter = `user:share-starter-${suffix}`;
  const access = await bootstrapWorkspace(client!.db, {
    accountExternalSource: "test",
    accountExternalId: `share-account-${suffix}`,
    accountName: "Share link account",
    workspaceExternalSource: "test",
    workspaceExternalId: `share-workspace-${suffix}`,
    workspaceName: "Share link workspace",
    subjectId: starter,
  });
  const grant = access.workspaceGrants[0]!;
  const session = await createSession(client!.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    initialMessage: "fixture",
    resources: [],
    metadata: {},
    model: "test-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    visibility: "workspace_shared",
    createdBy: { kind: "subject", subjectId: starter },
  } as Parameters<typeof createSession>[1]);
  const turn = crypto.randomUUID();
  const rows: Array<[number, string, Record<string, unknown>, string | null]> = [
    [
      1,
      "user.message",
      {
        text: "What's on my calendar this weekend?",
        initiator: { kind: "subject", subjectId: starter },
        modelContext: [{ text: "HIDDEN CONTEXT" }],
      },
      null,
    ],
    [2, "turn.started", {}, turn],
    [3, "agent.message.completed", { text: "Checking.", phase: "commentary" }, turn],
    [4, "agent.toolCall.created", { id: "c1", name: "calendar_read", arguments: {} }, turn],
    [5, "agent.toolCall.output", { id: "c1", output: "PRIVATE: doctor Saturday 9:00" }, turn],
    [
      6,
      "agent.message.completed",
      { text: "Your weekend is mostly free. ![map](artifact:1234)", phase: "final_answer" },
      turn,
    ],
    [7, "turn.completed", {}, turn],
  ];
  for (const [sequence, type, payload, turnId] of rows) {
    await shared!.admin`
      insert into session_events (account_id, workspace_id, session_id, turn_id, sequence, type, payload)
      values (${grant.accountId}, ${grant.workspaceId}, ${session.id}, ${turnId}, ${sequence}, ${type},
        ${shared!.admin.json(payload as never)})`;
  }
  const base = `http://x/v1/workspaces/${grant.workspaceId}/sessions/${session.id}/share-link`;
  return { grant, starter, session, base, authorization: await bearer(grant, starter) };
}

describe("chat share links", () => {
  test("the starter shares, refreshes and stops a link; anyone reads only the visible conversation", async () => {
    if (!client) return;
    const app = appWith(true);
    const { base, authorization, grant } = await chat();

    const before = await app.request(base, { headers: { authorization } });
    expect(before.status).toBe(200);
    expect(await before.json()).toEqual({ enabled: true, link: null });

    const created = await app.request(base, { method: "PUT", headers: { authorization } });
    expect(created.status).toBe(201);
    const link = (await created.json()) as { shareId: string; url: string; title: string };
    expect(link.url).toBe(`${WEB}/share/${link.shareId}`);
    expect(link.shareId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    // An untitled chat is titled by its first question.
    expect(link.title).toBe("What's on my calendar this weekend?");

    const read = await app.request(`http://x/v1/shared-sessions/${link.shareId}`);
    expect(read.status).toBe(200);
    expect(read.headers.get("cache-control")).toBe("no-store");
    expect(read.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    const body = await read.json();
    expect(body).toMatchObject({
      title: "What's on my calendar this weekend?",
      omittedMessageCount: 0,
      messages: [
        { role: "user", text: "What's on my calendar this weekend?" },
        { role: "assistant", text: "Your weekend is mostly free. [image not included]" },
      ],
    });
    const text = JSON.stringify(body);
    for (const secret of [
      "PRIVATE",
      "HIDDEN",
      "calendar_read",
      "Checking.",
      "artifact:",
      grant.workspaceId,
    ]) {
      expect(text).not.toContain(secret);
    }

    // Sharing again keeps the same link.
    const again = await app.request(base, { method: "PUT", headers: { authorization } });
    expect(again.status).toBe(200);
    expect(((await again.json()) as { shareId: string }).shareId).toBe(link.shareId);

    const listed = await app.request(`http://x/v1/workspaces/${grant.workspaceId}/share-links`, {
      headers: { authorization },
    });
    expect(((await listed.json()) as { links: Array<{ shareId: string }> }).links).toEqual([
      expect.objectContaining({ shareId: link.shareId }),
    ]);

    const stopped = await app.request(base, { method: "DELETE", headers: { authorization } });
    expect(await stopped.json()).toEqual({ revoked: true });
    expect((await app.request(`http://x/v1/shared-sessions/${link.shareId}`)).status).toBe(404);
    expect(await (await app.request(base, { headers: { authorization } })).json()).toEqual({
      enabled: true,
      link: null,
    });

    // A new share is a new link: the stopped one never opens again.
    const reshared = (await (
      await app.request(base, { method: "PUT", headers: { authorization } })
    ).json()) as { shareId: string };
    expect(reshared.shareId).not.toBe(link.shareId);
    expect((await app.request(`http://x/v1/shared-sessions/${link.shareId}`)).status).toBe(404);
  }, 120_000);

  test("only the person who started the chat can share it, and never someone from another product", async () => {
    if (!client) return;
    const app = appWith(true);
    const { base, grant } = await chat();

    const colleague = await bearer(grant, `user:share-colleague-${crypto.randomUUID()}`);
    const refused = await app.request(base, {
      method: "PUT",
      headers: { authorization: colleague },
    });
    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain(SHARE_LINKS_NOT_STARTER_MESSAGE);

    const external = await bearer(grant, `external_user:share-${crypto.randomUUID()}`);
    const externalRefused = await app.request(base, {
      method: "PUT",
      headers: { authorization: external },
    });
    expect(externalRefused.status).toBe(403);
    expect(await externalRefused.text()).toContain(SHARE_LINKS_EXTERNAL_PERSON_MESSAGE);
  }, 120_000);

  test("a deployment that turns links off refuses new ones and closes existing ones", async () => {
    if (!client) return;
    const { base, authorization } = await chat();
    const link = (await (
      await appWith(true).request(base, { method: "PUT", headers: { authorization } })
    ).json()) as { shareId: string };

    const off = appWith(false);
    expect((await off.request(`http://x/v1/shared-sessions/${link.shareId}`)).status).toBe(404);
    const refused = await off.request(base, { method: "PUT", headers: { authorization } });
    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain(SHARE_LINKS_OFF_MESSAGE);
    expect(await (await off.request(base, { headers: { authorization } })).json()).toEqual({
      enabled: false,
      link: null,
    });
    // Stopping still works with links off.
    const stopped = await off.request(base, { method: "DELETE", headers: { authorization } });
    expect(await stopped.json()).toEqual({ revoked: true });
  }, 120_000);

  test("unknown and malformed links don't open", async () => {
    if (!client) return;
    const app = appWith(true);
    expect((await app.request("http://x/v1/shared-sessions/AAAAAAAAAAAAAAAAAAAAAA")).status).toBe(
      404,
    );
    expect((await app.request("http://x/v1/shared-sessions/short")).status).toBe(404);
  }, 60_000);

  test("each person's messages carry the name the chat shows for them, never an email", async () => {
    if (!client) return;
    const app = appWith(true);
    const { base, authorization, grant, starter, session } = await chat();
    const starterUserId = starter.slice("user:".length);
    await shared!.admin`
      insert into auth_users (id, name, email, email_verified)
      values (${starterUserId}, 'Olav Berg', ${`${starterUserId}@example.test`}, true)`;
    const colleague = `user:share-colleague-${crypto.randomUUID()}`;
    await shared!.admin`
      insert into workspace_memberships (account_id, workspace_id, subject_id, subject_label, role, permissions)
      values (${grant.accountId}, ${grant.workspaceId}, ${colleague}, 'Kari Berg', 'member',
        ${shared!.admin.json(["workspace:read", "sessions:read"])})`;
    const visitor = `user:share-visitor-${crypto.randomUUID()}`;
    const rows: Array<[number, Record<string, unknown>]> = [
      [
        8,
        {
          text: "Can I join the dinner?",
          initiator: { kind: "subject", subjectId: colleague, label: "kari@example.test" },
        },
      ],
      [
        9,
        {
          text: "Me too",
          initiator: { kind: "subject", subjectId: visitor, label: "per@example.test" },
        },
      ],
    ];
    for (const [sequence, payload] of rows) {
      await shared!.admin`
        insert into session_events (account_id, workspace_id, session_id, sequence, type, payload)
        values (${grant.accountId}, ${grant.workspaceId}, ${session.id}, ${sequence}, 'user.message',
          ${shared!.admin.json(payload as never)})`;
    }

    const link = (await (
      await app.request(base, { method: "PUT", headers: { authorization } })
    ).json()) as { shareId: string };
    const body = (await (
      await app.request(`http://x/v1/shared-sessions/${link.shareId}`)
    ).json()) as { messages: Array<{ role: string; text: string; sender?: string }> };
    expect(body.messages).toEqual([
      { role: "user", text: "What's on my calendar this weekend?", sender: "Olav Berg" },
      { role: "assistant", text: "Your weekend is mostly free. [image not included]" },
      { role: "user", text: "Can I join the dinner?", sender: "Kari Berg" },
      // The chat knows this person only by an email address, so the link shows no name.
      { role: "user", text: "Me too" },
    ]);
    const text = JSON.stringify(body);
    for (const hidden of ["@example.test", colleague, visitor, starter]) {
      expect(text).not.toContain(hidden);
    }
  }, 120_000);

  test("a link opens only while the person who shared it can still read the chat", async () => {
    if (!client) return;
    const app = appWith(true);
    const { base, authorization, grant, starter } = await chat();
    const link = (await (
      await app.request(base, { method: "PUT", headers: { authorization } })
    ).json()) as { shareId: string };
    const open = async () =>
      (await app.request(`http://x/v1/shared-sessions/${link.shareId}`)).status;
    expect(await open()).toBe(200);

    // Losing access to the workspace's chats closes the link at once.
    await shared!.admin`
      update workspace_memberships set permissions = ${shared!.admin.json(["workspace:read"])}
      where workspace_id = ${grant.workspaceId} and subject_id = ${starter}`;
    expect(await open()).toBe(404);
    await shared!.admin`
      update workspace_memberships
      set permissions = ${shared!.admin.json(["workspace:read", "sessions:read"])}
      where workspace_id = ${grant.workspaceId} and subject_id = ${starter}`;
    expect(await open()).toBe(200);

    // Leaving the workspace closes it too.
    await shared!.admin`
      delete from workspace_memberships
      where workspace_id = ${grant.workspaceId} and subject_id = ${starter}`;
    expect(await open()).toBe(404);
  }, 120_000);
});
