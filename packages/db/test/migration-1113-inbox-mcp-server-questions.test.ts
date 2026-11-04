import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing/shared-pg";
import {
  appendSessionEvents,
  bootstrapWorkspace,
  createDb,
  createSession,
  listInboxItems,
  registerNativePushDevice,
  type DbClient,
} from "../src/index";
import {
  ensureCanonicalHumanIdentityForAuthUser,
  getCanonicalHumanExactLoginBindingForAuthUser,
  getCanonicalHumanIdentityProjection,
  synchronizeCanonicalHumanLoginBindings,
} from "../src/canonical-human-identities";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";

const MIGRATION = "1113_inbox_mcp_server_questions.sql";
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

setDefaultTimeout(60_000);

let owned: OwnerMigratedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  owned = await acquireOwnerMigratedTestDatabase("inbox-mcp-server-questions");
  if (!owned) {
    if (requireRealDatabase) throw new Error("inbox PostgreSQL fixture is unavailable");
    return;
  }
  // As in production: the NOSUPERUSER NOBYPASSRLS owner runs the triggers
  // under FORCE RLS, and the application role writes events and reads items.
  await migrate(owned.ownerUrl);
  await provisionRoles(owned.adminUrl, { appPassword: owned.appPassword, rlsStrategy: "force" });
  const appUrl = new URL(owned.ownerUrl);
  appUrl.username = "opengeni_app";
  appUrl.password = owned.appPassword;
  client = createDb(appUrl.toString(), { max: 4, rlsStrategy: "force" });
}, 900_000);

afterAll(async () => {
  await client?.close();
  await owned?.release();
}, 60_000);

const db = () => client!.db;

/** A person signed in to the phone app with alerts for what needs them, and their session. */
async function person(label: string) {
  const userId = crypto.randomUUID();
  const subjectId = `user:${userId}`;
  await owned!.admin`
    insert into auth_users (id, name, email, email_verified)
    values (${userId}, ${`Questions ${label}`}, ${`questions-${userId}@example.test`}, true)`;
  await owned!.admin`
    insert into auth_identities (id, user_id, account_id, provider_id, created_at, updated_at)
    values (${crypto.randomUUID()}, ${userId}, ${userId}, 'credential', now(), now())`;
  await ensureCanonicalHumanIdentityForAuthUser(db(), userId);
  await synchronizeCanonicalHumanLoginBindings(db(), userId);
  const projection = await getCanonicalHumanIdentityProjection(db(), userId);
  const binding = await getCanonicalHumanExactLoginBindingForAuthUser(db(), {
    authUserId: userId,
    providerId: "credential",
  });
  const authSessionId = crypto.randomUUID();
  await owned!.admin`
    insert into auth_sessions (
      id, user_id, token, expires_at, user_agent,
      identity_id, identity_revision, auth_revision, login_binding_id, login_binding_revision
    ) values (
      ${authSessionId}, ${userId}, ${crypto.randomUUID()}, now() + interval '7 days',
      'OpenGeni app (iOS)', ${projection.activeIdentity.id},
      ${projection.activeIdentity.identityRevision}, ${projection.activeIdentity.authRevision},
      ${binding.id}, ${binding.revision}
    )`;
  const access = await bootstrapWorkspace(db(), {
    accountExternalSource: "migration-1113",
    accountExternalId: `account:${label}:${crypto.randomUUID()}`,
    accountName: `Questions ${label}`,
    workspaceExternalSource: "migration-1113",
    workspaceExternalId: `workspace:${label}:${crypto.randomUUID()}`,
    workspaceName: `Questions ${label}`,
    subjectId,
  });
  const grant = access.workspaceGrants[0]!;
  const scope = { accountId: grant.accountId, workspaceId: grant.workspaceId! };
  const session = await createSession(db(), {
    ...scope,
    initialMessage: `initial ${label}`,
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none",
    createdBy: { kind: "subject", subjectId, label: `User ${label}` },
    createdByContext: { label: `User ${label}` },
  });
  await registerNativePushDevice(db(), {
    authSessionId,
    platform: "ios",
    appId: "ai.opengeni.app",
    environment: "development",
    token: "e".repeat(64),
    rules: ["needs_input"],
  });
  return { scope, session, subjectId, authSessionId };
}

type Person = Awaited<ReturnType<typeof person>>;

const confirm = {
  server: "Messages",
  round: 1,
  requests: [
    {
      id: "confirm",
      message: "Send “On my way” to Design team? It isn't on your list of chats.",
      requestedSchema: { type: "object", properties: {} },
    },
  ],
};

const form = {
  server: "Calendar",
  round: 1,
  requests: [
    {
      id: "details",
      message: "Which room should I book?",
      requestedSchema: {
        type: "object",
        properties: { room: { type: "string", enum: ["small", "large"] } },
        required: ["room"],
      },
    },
  ],
};

function approval(id: string, elicitation?: unknown) {
  return {
    id,
    name: "send_message",
    arguments: '{"to":"Design team"}',
    display: { toolName: "send_message", title: "Send message", serverName: "Messages" },
    ...(elicitation ? { elicitation } : {}),
  };
}

async function ask(owner: Person, approvals: unknown[]) {
  await appendSessionEvents(db(), owner.scope.workspaceId, owner.session.id, [
    { type: "session.requiresAction", payload: { approvals } },
  ]);
}

async function items(owner: Person) {
  return await listInboxItems(db(), {
    accountId: owner.scope.accountId,
    subjectId: owner.subjectId,
  });
}

async function pushes(owner: Person) {
  return await owned!.admin<Array<{ payload: Record<string, unknown> }>>`
    select payload from opengeni_private.native_push_deliveries
    where auth_session_id = ${owner.authSessionId}
    order by created_at`;
}

describe("1113 MCP server questions in the inbox and phone alerts", () => {
  test("is a rolling, additive migration", async () => {
    if (!client) return;
    const source = await Bun.file(new URL(`../drizzle/${MIGRATION}`, import.meta.url)).text();
    expect(source).toStartWith("-- deployment-mode: rolling");
    expect(source).not.toMatch(/\bDROP\s+(TABLE|COLUMN|FUNCTION)\b/i);
    // The previous release's readiness check rejects any SECURITY DEFINER
    // routine it does not know, so the list keeps its shipped name.
    expect(source).not.toMatch(/CREATE\s+FUNCTION/i);
  });

  test("the previous release reads the list unchanged: no choices on approval items", async () => {
    if (!client) return;
    const owner = await person("previous");
    await ask(owner, [approval("call_previous", confirm)]);
    const [item] = await items(owner);
    // The server question rides as a {serverQuestion} element of choices,
    // which every release's choices reader drops.
    expect(item?.choices).toEqual([]);
    expect(item?.serverQuestion).toEqual({ server: "Messages", kind: "confirm", round: 1 });
    const [raw] = await owned!.admin<Array<{ choices: unknown }>>`
      select item.choices from opengeni_private.inbox_items item
      where item.source_key = 'call_previous'`;
    expect(raw?.choices).toEqual([]);
  });

  test("a server's confirmation reads as its question and is answered in one tap", async () => {
    if (!client) return;
    const owner = await person("confirm");
    await ask(owner, [approval("call_confirm", confirm)]);
    const [item] = await items(owner);
    expect(item).toMatchObject({
      kind: "approval",
      sourceKey: "call_confirm",
      title: "Send “On my way” to Design team? It isn't on your list of chats.",
      body: "Send message",
      serverQuestion: { server: "Messages", kind: "confirm", round: 1 },
    });
    const [push] = await pushes(owner);
    // Marked as a server question, so the push offers no lock-screen Approve
    // that could answer a question asked after it.
    expect(push!.payload).toMatchObject({
      eventType: "session.requiresAction",
      body: "Messages asks: Send “On my way” to Design team? It isn't on your list of chats.",
      serverQuestionKind: "confirm",
    });
  });

  test("a question with fields is marked for its form, with no lock-screen answer", async () => {
    if (!client) return;
    const owner = await person("form");
    await ask(owner, [approval("call_form", form)]);
    const [item] = await items(owner);
    expect(item).toMatchObject({
      title: "Which room should I book?",
      serverQuestion: { server: "Calendar", kind: "form", round: 1 },
    });
    const [push] = await pushes(owner);
    expect(push!.payload).toMatchObject({
      body: "Calendar asks: Which room should I book?",
      serverQuestionKind: "form",
    });
  });

  test("a confirmation the title cannot show whole is answered in the session", async () => {
    if (!client) return;
    const owner = await person("long");
    const message = `Send this? ${"x".repeat(240)}`;
    await ask(owner, [
      approval("call_long", { ...confirm, requests: [{ ...confirm.requests[0]!, message }] }),
    ]);
    const [item] = await items(owner);
    expect(item?.title).toBe(message.slice(0, 200));
    expect(item?.serverQuestion).toEqual({ server: "Messages", kind: "form", round: 1 });
    // Two questions are answered together in the session as well.
    const two = await person("two");
    await ask(two, [
      approval("call_two", {
        ...confirm,
        requests: [confirm.requests[0], { ...confirm.requests[0]!, id: "again" }],
      }),
    ]);
    expect((await items(two))[0]?.serverQuestion).toMatchObject({ kind: "form" });
  });

  test("an entry without a round is not a server question", async () => {
    if (!client) return;
    const owner = await person("no-round");
    const { round: _round, ...withoutRound } = confirm;
    await ask(owner, [approval("call_no_round", withoutRound)]);
    const [item] = await items(owner);
    expect(item).toMatchObject({ title: "Send message", body: "Messages", serverQuestion: null });
  });

  test("a set-aside item comes back when the server asks a new question", async () => {
    if (!client) return;
    const owner = await person("dismissed");
    await ask(owner, [approval("call_dismissed", confirm)]);
    await owned!.admin`
      update opengeni_private.inbox_items set status = 'dismissed'
      where session_id = ${owner.session.id} and source_key = 'call_dismissed'`;
    // The same question again (a later pause of the turn) leaves it set aside.
    await ask(owner, [approval("call_dismissed", confirm)]);
    expect(await items(owner)).toHaveLength(0);
    await ask(owner, [{ id: "call_dismissed", elicitation: { ...form, round: 2 } }]);
    const [item] = await items(owner);
    expect(item).toMatchObject({
      sourceKey: "call_dismissed",
      title: "Which room should I book?",
      body: "Send message",
      serverQuestion: { server: "Calendar", kind: "form", round: 2 },
    });
  });

  test("an ordinary approval is unchanged", async () => {
    if (!client) return;
    const owner = await person("plain");
    await ask(owner, [approval("call_plain")]);
    const [item] = await items(owner);
    // As 1067 projects it: the call's title, under its server.
    expect(item).toMatchObject({ title: "Send message", body: "Messages", serverQuestion: null });
    const [push] = await pushes(owner);
    expect(push!.payload).toMatchObject({ body: "Needs your approval: Send message (Messages)" });
    expect(push!.payload).not.toHaveProperty("serverQuestionKind");
  });

  test("the server's next question about the same call reopens the item with it", async () => {
    if (!client) return;
    const owner = await person("again");
    await ask(owner, [approval("call_again", confirm)]);
    await appendSessionEvents(db(), owner.scope.workspaceId, owner.session.id, [
      { type: "user.approvalDecision", payload: { approvalId: "call_again", decision: "approve" } },
    ]);
    expect(await items(owner)).toHaveLength(0);
    await ask(owner, [approval("call_again", { ...form, round: 2 })]);
    const [item] = await items(owner);
    expect(item).toMatchObject({
      sourceKey: "call_again",
      title: "Which room should I book?",
      serverQuestion: { server: "Calendar", kind: "form", round: 2 },
      unread: true,
    });
  });
});
