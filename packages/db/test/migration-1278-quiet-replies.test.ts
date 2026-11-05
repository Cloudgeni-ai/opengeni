import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { sql } from "drizzle-orm";
import { isNoReplyText } from "@opengeni/contracts/no-reply";
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
  setInboxSettings,
  type AppendEventInput,
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
import { withSessionActivityRlsContext } from "../src/database";
import { noReplyTextSql } from "../src/session-meaningful-events";

const MIGRATION = "1278_quiet_replies_leave_no_trace.sql";
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

setDefaultTimeout(60_000);

let owned: OwnerMigratedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  owned = await acquireOwnerMigratedTestDatabase("quiet-replies");
  if (!owned) {
    if (requireRealDatabase) throw new Error("quiet replies PostgreSQL fixture is unavailable");
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

/**
 * A person signed in to the phone app with alerts for replies, who keeps
 * replies in their inbox, and their session with its first turn.
 */
async function person(label: string) {
  const userId = crypto.randomUUID();
  const subjectId = `user:${userId}`;
  await owned!.admin`
    insert into auth_users (id, name, email, email_verified)
    values (${userId}, ${`Quiet ${label}`}, ${`quiet-${userId}@example.test`}, true)`;
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
    accountExternalSource: "migration-1278",
    accountExternalId: `account:${label}:${crypto.randomUUID()}`,
    accountName: `Quiet ${label}`,
    workspaceExternalSource: "migration-1278",
    workspaceExternalId: `workspace:${label}:${crypto.randomUUID()}`,
    workspaceName: `Quiet ${label}`,
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
    rules: ["needs_input", "reply_ready", "failed"],
  });
  await setInboxSettings(db(), { accountId: scope.accountId, subjectId, replies: true });
  const turnId = crypto.randomUUID();
  await withSessionActivityRlsContext(db(), scope, async (tx) => {
    await tx.execute(
      sql`insert into session_turns (id, account_id, workspace_id, session_id,
        trigger_event_id, temporal_workflow_id, status, source, position, prompt, model,
        reasoning_effort, latency_mode, sandbox_backend, finished_at)
      values (${turnId}::uuid, ${scope.accountId}::uuid, ${scope.workspaceId}::uuid,
        ${session.id}::uuid, gen_random_uuid(), ${`quiet-${turnId}`}, 'completed', 'user', 1,
        'go', 'scripted-model', 'medium', 'standard', 'none', now())`,
    );
  });
  return { scope, session, subjectId, authSessionId, turnId };
}

type Person = Awaited<ReturnType<typeof person>>;

/** The turn ends with these messages, as a worker settles it. */
async function finish(
  owner: Person,
  messages: Array<{ text: string; phase?: string }>,
  turn: Record<string, unknown> = { output: messages.at(-1)?.text ?? "" },
) {
  const events: AppendEventInput[] = [
    ...messages.map((payload) => ({
      type: "agent.message.completed" as const,
      payload,
      turnId: owner.turnId,
    })),
    { type: "turn.completed", payload: turn, turnId: owner.turnId },
    { type: "session.status.changed", payload: { status: "idle" }, turnId: owner.turnId },
  ];
  return await appendSessionEvents(db(), owner.scope.workspaceId, owner.session.id, events);
}

async function replyItems(owner: Person) {
  return (
    await listInboxItems(db(), { accountId: owner.scope.accountId, subjectId: owner.subjectId })
  ).filter((item) => item.kind === "reply");
}

async function pushes(owner: Person) {
  const rows = await owned!.admin<Array<{ rule: string; payload: Record<string, unknown> }>>`
    select rule, payload from opengeni_private.native_push_deliveries
    where auth_session_id = ${owner.authSessionId}
    order by created_at`;
  return [...rows];
}

async function unreadFrontier(owner: Person) {
  const [cursor] = await owned!.admin<Array<{ last_meaningful_sequence: number }>>`
    select last_meaningful_sequence from session_event_cursors
    where session_id = ${owner.session.id}`;
  return cursor!.last_meaningful_sequence;
}

describe("1278 a quiet run leaves no trace for the person", () => {
  test("is a rolling migration that replaces functions in place", async () => {
    if (!client) return;
    const source = await Bun.file(new URL(`../drizzle/${MIGRATION}`, import.meta.url)).text();
    expect(source).toStartWith("-- deployment-mode: rolling");
    expect(source).not.toMatch(/\bDROP\s+(TABLE|COLUMN|FUNCTION|INDEX)\b/i);
    expect(source).not.toMatch(/CREATE\s+FUNCTION/i);
    expect(source).not.toMatch(/CREATE\s+(UNIQUE\s+)?INDEX/i);
  });

  test("the database knows the no-reply token exactly as the timelines do", async () => {
    if (!client) return;
    const corpus = [
      "NO_REPLY",
      "no_reply",
      " NO_REPLY.\n",
      "`NO_REPLY`",
      "**NO_REPLY**",
      "“NO_REPLY”",
      "_NO_REPLY_!",
      "NO_REPLY because nothing changed",
      "NO REPLY",
      "NO_REPLY_",
      "Nothing new. NO_REPLY",
      "",
      "Done.",
      `${"*".repeat(300)}NO_REPLY`,
    ];
    for (const text of corpus) {
      const [owner] = await owned!.admin<Array<{ quiet: boolean }>>`
        select opengeni_private.no_reply_text_v1(${text}::text) as quiet`;
      // The application role's attention queries inline the same test.
      const [app] = (await db().execute(
        sql`select ${noReplyTextSql(sql`${text}::text`)} as quiet`,
      )) as unknown as Array<{ quiet: boolean }>;
      // Wrapping longer than any real answer is not the token in SQL; the
      // timelines never see such text either.
      const expected = text.length <= 256 && isNoReplyText(text);
      expect({ text, quiet: owner!.quiet }).toEqual({ text, quiet: expected });
      expect({ text, quiet: app!.quiet }).toEqual({ text, quiet: expected });
    }
    const [nil] = await owned!.admin<Array<{ quiet: boolean }>>`
      select opengeni_private.no_reply_text_v1(null) as quiet`;
    expect(nil!.quiet).toBe(false);
  });

  test("a run that answers NO_REPLY sets no unread mark, opens no inbox item and sends no push", async () => {
    if (!client) return;
    const owner = await person("quiet");
    const before = await unreadFrontier(owner);
    await finish(owner, [
      { text: "Checking the ticket.", phase: "commentary" },
      { text: "NO_REPLY" },
    ]);
    expect(await unreadFrontier(owner)).toBe(before);
    expect(await replyItems(owner)).toEqual([]);
    expect(await pushes(owner)).toEqual([]);
    // The run stays in the session's own history.
    const [kept] = await owned!.admin<Array<{ count: number }>>`
      select count(*)::integer as count from session_events
      where session_id = ${owner.session.id} and payload ->> 'text' = 'NO_REPLY'`;
    expect(kept!.count).toBe(1);
  });

  test("a wrapped token is quiet too", async () => {
    if (!client) return;
    const owner = await person("wrapped");
    const before = await unreadFrontier(owner);
    await finish(owner, [{ text: "**NO_REPLY**" }]);
    expect(await unreadFrontier(owner)).toBe(before);
    expect(await replyItems(owner)).toEqual([]);
    expect(await pushes(owner)).toEqual([]);
  });

  test("the phone shows the answer the chat shows", async () => {
    if (!client) return;
    const owner = await person("answer");
    const answer =
      "Ticket T-4907 was reassigned to you.\n\nThe customer asked for a refund of **$40**.";
    const events = await finish(owner, [
      { text: "Reading the ticket.", phase: "commentary" },
      { text: `\n${answer}\n` },
    ]);
    const completed = events.find((event) => event.type === "turn.completed")!;
    expect(await unreadFrontier(owner)).toBe(completed.sequence);
    const all = await pushes(owner);
    // One finished run, one notification, carrying the chat's answer.
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      rule: "reply_ready",
      payload: { eventType: "turn.completed", body: answer, sequence: completed.sequence },
    });
    const [item] = await replyItems(owner);
    expect(item).toMatchObject({
      title: "Ticket T-4907 was reassigned to you.",
      body: "The customer asked for a refund of **$40**.",
    });
  });

  test("a turn with no answer sends no push", async () => {
    if (!client) return;
    const owner = await person("silent");
    await finish(owner, [{ text: "Looking around.", phase: "commentary" }], { output: "" });
    expect(await pushes(owner)).toEqual([]);
    expect(await replyItems(owner)).toEqual([]);
  });

  test("a long answer is bounded for the phone", async () => {
    if (!client) return;
    const owner = await person("long");
    const answer = `Summary: ${"word ".repeat(400)}`.trim();
    await finish(owner, [{ text: answer }]);
    const [push] = await pushes(owner);
    expect(push!.payload.body).toBe(answer.slice(0, 1000));
  });

  test("a question, approval or failure in a quiet run still reaches the person", async () => {
    if (!client) return;
    const owner = await person("blocked");
    await appendSessionEvents(db(), owner.scope.workspaceId, owner.session.id, [
      {
        type: "session.humanInput.requested",
        payload: { request: { id: "q1", questions: [{ prompt: "Which account?" }] } },
        turnId: owner.turnId,
      },
    ]);
    const asked = await unreadFrontier(owner);
    expect(asked).toBeGreaterThan(0);
    expect((await pushes(owner)).map((push) => push.rule)).toEqual(["needs_input"]);
  });
});
