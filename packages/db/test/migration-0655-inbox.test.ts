import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { sql } from "drizzle-orm";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import {
  appendSessionEvents,
  bootstrapWorkspace,
  createDb,
  createSession,
  dismissInboxNotification,
  getInboxItem,
  getInboxSettings,
  getInboxTidyPolicy,
  listInboxItems,
  setInboxSettings,
  setInboxTidyPolicy,
  updateInboxItemAttention,
  type DbClient,
} from "../src/index";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";

const MIGRATION = "0655_inbox.sql";
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

setDefaultTimeout(60_000);

let owned: OwnerMigratedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  owned = await acquireOwnerMigratedTestDatabase("inbox");
  if (!owned) {
    if (requireRealDatabase) throw new Error("inbox PostgreSQL fixture is unavailable");
    return;
  }
  // Migrate as the NOSUPERUSER NOBYPASSRLS owner so the owner-run functions and
  // the session-event trigger run under FORCE RLS exactly as in production.
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

/** A person and a session they started. */
async function personWithSession(label: string, subjectId = `user:${crypto.randomUUID()}`) {
  const access = await bootstrapWorkspace(db(), {
    accountExternalSource: "migration-0655",
    accountExternalId: `account:${label}:${crypto.randomUUID()}`,
    accountName: `Inbox ${label}`,
    workspaceExternalSource: "migration-0655",
    workspaceExternalId: `workspace:${label}:${crypto.randomUUID()}`,
    workspaceName: `Inbox ${label}`,
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
  return { scope, session, subjectId };
}

async function inbox(person: { scope: { accountId: string }; subjectId: string }) {
  return await listInboxItems(db(), {
    accountId: person.scope.accountId,
    subjectId: person.subjectId,
  });
}

describe("0655 inbox", () => {
  test("is a rolling, additive migration with private, owner-run storage", async () => {
    if (!client) return;
    const source = await Bun.file(new URL(`../drizzle/${MIGRATION}`, import.meta.url)).text();
    expect(source).toStartWith("-- deployment-mode: rolling");
    expect(source).not.toMatch(/\bDROP\s+(TABLE|COLUMN|FUNCTION)\b/i);
    expect(source).not.toMatch(/\bALTER TABLE\s+"?session_events"?/i);
    const rows = await owned!.admin<
      Array<{ securityDefiner: boolean; config: string[] | null; publicExecute: boolean }>
    >`
      select procedure.prosecdef as "securityDefiner", procedure.proconfig as config,
        exists (
          select 1 from aclexplode(coalesce(procedure.proacl, acldefault('f', procedure.proowner))) acl
          where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
        ) as "publicExecute"
      from pg_proc procedure
      join pg_namespace namespace on namespace.oid = procedure.pronamespace
      where namespace.nspname = 'opengeni_private' and procedure.proname = any(${[
        "open_inbox_item_v1",
        "close_inbox_items_v1",
        "project_inbox_for_session_event_v1",
        "list_inbox_items_v1",
        "update_inbox_item_attention_v1",
        "dismiss_inbox_notification_v1",
        "inbox_item_v1",
        "inbox_settings_v1",
        "set_inbox_settings_v1",
      ]})`;
    expect(rows.length).toBe(9);
    for (const row of rows) {
      expect(row.securityDefiner).toBe(true);
      expect(row.publicExecute).toBe(false);
      expect(row.config?.some((entry) => entry.startsWith("search_path="))).toBe(true);
    }
    const direct = async () =>
      await db().execute(sql`select count(*) from opengeni_private.inbox_items`);
    await expect(direct()).rejects.toThrow();
  });

  test("questions and approvals open items that leave when answered or the turn ends", async () => {
    if (!client) return;
    const person = await personWithSession("needs-you");
    const requestId = crypto.randomUUID();
    await appendSessionEvents(db(), person.scope.workspaceId, person.session.id, [
      {
        type: "session.humanInput.requested",
        payload: {
          request: {
            id: requestId,
            questions: [{ prompt: "Which branch?" }, { prompt: "Squash?" }],
          },
        },
      },
      {
        type: "session.requiresAction",
        payload: {
          approvals: [
            { id: "call-1", name: "deploy", display: { toolName: "Deploy" } },
            { id: "call-2", name: "delete_file" },
          ],
        },
      },
    ]);
    const open = await inbox(person);
    expect(open.map((item) => [item.kind, item.title, item.body]).sort()).toEqual([
      ["approval", "Deploy", ""],
      ["approval", "delete_file", ""],
      ["question", "Which branch?", "1 more question"],
    ]);
    expect(open.every((item) => item.unread && item.sessionId === person.session.id)).toBe(true);
    expect(open.every((item) => item.choices.length === 0)).toBe(true);

    await appendSessionEvents(db(), person.scope.workspaceId, person.session.id, [
      { type: "user.humanInputResponse", payload: { requestId, response: { answers: [] } } },
      { type: "user.approvalDecision", payload: { approvalId: "call-1", decision: "approve" } },
    ]);
    expect((await inbox(person)).map((item) => item.sourceKey)).toEqual(["call-2"]);

    // The turn ending settles whatever was still pending.
    await appendSessionEvents(db(), person.scope.workspaceId, person.session.id, [
      { type: "turn.cancelled", payload: {} },
    ]);
    expect(await inbox(person)).toHaveLength(0);
  });

  test("a single short choice question carries its options as one-tap answers", async () => {
    if (!client) return;
    const person = await personWithSession("choices");
    const option = (id: string) => ({ id, label: `Option ${id}`, description: "ignored" });
    await appendSessionEvents(db(), person.scope.workspaceId, person.session.id, [
      {
        type: "session.humanInput.requested",
        payload: {
          request: {
            id: "short",
            questions: [
              {
                kind: "single_select",
                prompt: "Where first?",
                options: [option("a"), option("b")],
              },
            ],
          },
        },
      },
      {
        type: "session.humanInput.requested",
        payload: {
          request: {
            id: "long",
            questions: [
              {
                kind: "single_select",
                prompt: "Pick one",
                options: ["a", "b", "c", "d", "e"].map(option),
              },
            ],
          },
        },
      },
      {
        type: "session.humanInput.requested",
        payload: {
          request: {
            id: "multi",
            questions: [
              { kind: "multi_select", prompt: "Pick any", options: [option("a"), option("b")] },
            ],
          },
        },
      },
    ]);
    const bySource = new Map((await inbox(person)).map((item) => [item.sourceKey, item.choices]));
    expect(bySource.get("short")).toEqual([
      { id: "a", label: "Option a" },
      { id: "b", label: "Option b" },
    ]);
    expect(bySource.get("long")).toEqual([]);
    expect(bySource.get("multi")).toEqual([]);
  });

  test("paused goals stay out of the inbox until the person turns them on (0662)", async () => {
    if (!client) return;
    const person = await personWithSession("goal-off");
    const owner = { accountId: person.scope.accountId, subjectId: person.subjectId };
    expect(await getInboxSettings(db(), owner)).toEqual({
      tidyPolicy: "own_sessions",
      pausedGoals: false,
    });
    await appendSessionEvents(db(), person.scope.workspaceId, person.session.id, [
      {
        type: "goal.paused",
        payload: { actor: "agent", reason: "agent", rationale: "Done for now" },
      },
    ]);
    expect(await inbox(person)).toHaveLength(0);
    // A partial change keeps the other setting.
    await setInboxSettings(db(), { ...owner, tidyPolicy: "any_agent" });
    expect(await setInboxSettings(db(), { ...owner, pausedGoals: true })).toEqual({
      tidyPolicy: "any_agent",
      pausedGoals: true,
    });
  });

  test("an agent's pause waits on the person until the goal resumes", async () => {
    if (!client) return;
    const person = await personWithSession("goal");
    await setInboxSettings(db(), {
      accountId: person.scope.accountId,
      subjectId: person.subjectId,
      pausedGoals: true,
    });
    await appendSessionEvents(db(), person.scope.workspaceId, person.session.id, [
      { type: "goal.paused", payload: { actor: "user", reason: "user" } },
    ]);
    expect(await inbox(person)).toHaveLength(0);
    await appendSessionEvents(db(), person.scope.workspaceId, person.session.id, [
      {
        type: "goal.paused",
        payload: { actor: "agent", reason: "agent", rationale: "Sign in to the shop again" },
      },
    ]);
    const [paused] = await inbox(person);
    expect(paused).toMatchObject({ kind: "goal_paused", title: "Sign in to the shop again" });
    await appendSessionEvents(db(), person.scope.workspaceId, person.session.id, [
      { type: "goal.resumed", payload: { actor: "user" } },
    ]);
    expect(await inbox(person)).toHaveLength(0);
  });

  test("a sub-agent's paused goal waits on its parent, but its questions reach the person (0661)", async () => {
    if (!client) return;
    const person = await personWithSession("sub-agent");
    const child = await createSession(db(), {
      ...person.scope,
      initialMessage: "child",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium" as const,
      latencyMode: "standard" as const,
      sandboxBackend: "none",
      parentSessionId: person.session.id,
      createdBy: { kind: "subject", subjectId: person.subjectId, label: "User sub-agent" },
      createdByContext: { label: "User sub-agent" },
    });
    await appendSessionEvents(db(), person.scope.workspaceId, child.id, [
      {
        type: "goal.paused",
        payload: { actor: "agent", reason: "agent", rationale: "Waiting for the parent" },
      },
      {
        type: "session.humanInput.requested",
        payload: { request: { id: "child-question", questions: [{ prompt: "Which region?" }] } },
      },
    ]);
    const items = await inbox(person);
    expect(items.map((item) => [item.kind, item.sessionId])).toEqual([["question", child.id]]);
  });

  test("notifications update in place, keep the person's dismissal, and can be withdrawn", async () => {
    if (!client) return;
    const person = await personWithSession("notify");
    const post = (title: string, body = "") =>
      appendSessionEvents(db(), person.scope.workspaceId, person.session.id, [
        {
          type: "session.notification.posted",
          payload: { key: "migration", title, body, urgency: "normal", replaced: false },
        },
      ]);
    await post("Migration 7 of 10");
    let [item] = await inbox(person);
    expect(item).toMatchObject({ kind: "notification", title: "Migration 7 of 10", unread: true });
    await updateInboxItemAttention(db(), {
      itemId: item!.id,
      accountId: person.scope.accountId,
      subjectId: person.subjectId,
      seen: true,
    });
    expect((await inbox(person))[0]!.unread).toBe(false);

    // New content in place is unread again, but stays one item.
    await post("Migration 8 of 10");
    [item] = await inbox(person);
    expect(item).toMatchObject({ title: "Migration 8 of 10", unread: true });
    expect(await inbox(person)).toHaveLength(1);

    // A dismissal survives later updates.
    await updateInboxItemAttention(db(), {
      itemId: item!.id,
      accountId: person.scope.accountId,
      subjectId: person.subjectId,
      dismissed: true,
    });
    await post("Migration 9 of 10");
    expect(await inbox(person)).toHaveLength(0);

    // A withdrawn notification posted again opens again.
    await appendSessionEvents(db(), person.scope.workspaceId, person.session.id, [
      { type: "session.notification.withdrawn", payload: { key: "migration" } },
    ]);
    await post("Migration failed", "Step 9 hit a lock timeout.");
    expect(await inbox(person)).toHaveLength(1);
  });

  test("items belong to the session's starter only, and snooze and tidy are theirs", async () => {
    if (!client) return;
    const person = await personWithSession("owner");
    await appendSessionEvents(db(), person.scope.workspaceId, person.session.id, [
      {
        type: "session.notification.posted",
        payload: { key: "report", title: "Report ready", body: "", urgency: "normal" },
      },
    ]);
    const [item] = await inbox(person);
    const stranger = {
      accountId: person.scope.accountId,
      subjectId: `user:${crypto.randomUUID()}`,
    };
    expect(await listInboxItems(db(), stranger)).toHaveLength(0);
    expect(await getInboxItem(db(), { itemId: item!.id, ...stranger })).toBeNull();
    expect(
      await updateInboxItemAttention(db(), { itemId: item!.id, ...stranger, dismissed: true }),
    ).toBe(false);

    const until = new Date(Date.now() + 3_600_000).toISOString();
    expect(
      await updateInboxItemAttention(db(), {
        itemId: item!.id,
        accountId: person.scope.accountId,
        subjectId: person.subjectId,
        snoozedUntil: until,
      }),
    ).toBe(true);
    expect(new Date((await inbox(person))[0]!.snoozedUntil!).toISOString()).toBe(until);

    const owner = { accountId: person.scope.accountId, subjectId: person.subjectId };
    expect(await getInboxTidyPolicy(db(), owner)).toBe("own_sessions");
    expect(await setInboxTidyPolicy(db(), { ...owner, policy: "any_agent" })).toBe("any_agent");
    expect(await getInboxTidyPolicy(db(), owner)).toBe("any_agent");
    expect(await dismissInboxNotification(db(), { itemId: item!.id, ...owner })).toBe(true);
    expect(await inbox(person)).toHaveLength(0);
  });

  test("sessions started by an agent or a key have no inbox", async () => {
    if (!client) return;
    const person = await personWithSession("service", `apikey:${crypto.randomUUID()}`);
    await appendSessionEvents(db(), person.scope.workspaceId, person.session.id, [
      {
        type: "session.notification.posted",
        payload: { key: "x", title: "Nobody to tell", body: "", urgency: "normal" },
      },
    ]);
    const [count] = await owned!.admin<Array<{ count: number }>>`
      select count(*)::int as count from opengeni_private.inbox_items
      where session_id = ${person.session.id}`;
    expect(count?.count).toBe(0);
  });

  test("a session's owner is its recipient, else the person who started it (0656)", async () => {
    if (!client) return;
    const rows = await owned!.admin<Array<{ recipient: string | null }>>`
      select opengeni_private.session_recipient_v1(owner, creator) as recipient
      from (values
        ('user:owner', 'internal-update', 1),
        (null, 'user:starter', 2),
        ('user:owner', 'user:starter', 3),
        (null, 'internal-update', 4),
        ('apikey:x', 'apikey:y', 5)
      ) as cases(owner, creator, position)
      order by position`;
    expect(rows.map((row) => row.recipient)).toEqual([
      "user:owner",
      "user:starter",
      "user:owner",
      null,
      null,
    ]);
  });
});
