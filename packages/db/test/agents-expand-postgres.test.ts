// Agents expand (1243-1245) under the production database setup: a
// NOSUPERUSER NOBYPASSRLS migration owner, a dedicated data schema, FORCE RLS
// and the restricted runtime role. Covers the backfill mapping, the legacy
// sync triggers (and their opengeni.agents_dual_write no-op), RLS on the new
// tables, revision and sessions.agent_id immutability, and the wider legacy
// checks.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { sql as drizzleSql } from "drizzle-orm";
import postgres from "postgres";
import {
  acquireRestrictedRuntimeTestDatabase,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing/shared-pg";
import {
  createDb,
  createSession,
  deleteWorkspace,
  withWorkspaceSessionActivityRls,
} from "../src/index";
import { withSessionRlsActorContext } from "../src/database";

const migration1239 = readFileSync(new URL("../drizzle/1243_agents.sql", import.meta.url), "utf8");
const migration1240 = readFileSync(
  new URL("../drizzle/1244_session_agents.sql", import.meta.url),
  "utf8",
);
// The one-time backfills, from lifting FORCE ROW LEVEL SECURITY to restoring it.
const agentsBackfill = migration1239.slice(
  migration1239.indexOf("ALTER TABLE slack_agents NO FORCE ROW LEVEL SECURITY;"),
);
const sessionsBackfill = migration1240.slice(
  migration1240.indexOf("ALTER TABLE sessions NO FORCE ROW LEVEL SECURITY;"),
);

let shared: RestrictedRuntimeTestDatabase;
let app: ReturnType<typeof createDb>;
let appSql: postgres.Sql;
const notices: string[] = [];

beforeAll(async () => {
  const acquired = await acquireRestrictedRuntimeTestDatabase("agents-expand");
  if (!acquired) throw new Error("PostgreSQL required");
  shared = acquired;
  app = createDb(shared.appUrl, { searchPath: shared.schema });
  appSql = postgres(shared.appUrl, {
    max: 2,
    connection: { search_path: shared.schema },
    onnotice: (notice) => notices.push(String(notice.message)),
  });
}, 900_000);

afterAll(async () => {
  await appSql?.end().catch(() => undefined);
  await app?.close();
  await shared?.release();
}, 60_000);

type Org = Awaited<ReturnType<typeof organization>>;

/**
 * One organization: the Slack installation's workspace, the agents' home
 * workspace (a Slack agent's target), another workspace, and three people.
 */
async function organization() {
  const accountId = crypto.randomUUID();
  const install = crypto.randomUUID();
  const home = crypto.randomUUID();
  const other = crypto.randomUUID();
  const owner = `user:${crypto.randomUUID()}`;
  const colleague = `user:${crypto.randomUUID()}`;
  const outsider = `user:${crypto.randomUUID()}`;
  const connectionId = crypto.randomUUID();
  await shared.admin`insert into managed_accounts (id, name) values (${accountId}, 'Agents')`;
  for (const [id, name] of [
    [install, "Slack home"],
    [home, "Team"],
    [other, "Elsewhere"],
  ] as const) {
    await shared.admin`insert into workspaces (id, account_id, name) values (${id}, ${accountId}, ${name})`;
    await shared.admin`insert into workspace_inference_controls (account_id, workspace_id)
      values (${accountId}, ${id}) on conflict (workspace_id) do nothing`;
  }
  const personal = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()] as const;
  for (const id of personal) {
    await shared.admin`insert into workspaces (id, account_id, name) values (${id}, ${accountId}, 'Personal')`;
  }
  await shared.admin`insert into organization_memberships (account_id, subject_id, role, status, personal_workspace_id)
    values (${accountId}, ${owner}, 'member', 'active', ${personal[0]}),
      (${accountId}, ${colleague}, 'member', 'active', ${personal[1]}),
      (${accountId}, ${outsider}, 'member', 'active', ${personal[2]})`;
  await shared.admin`insert into workspace_memberships (account_id, workspace_id, subject_id, role, permissions)
    values (${accountId}, ${home}, ${owner}, 'member', opengeni_private.workspace_member_role_permissions('member')),
      (${accountId}, ${home}, ${colleague}, 'member', opengeni_private.workspace_member_role_permissions('member')),
      (${accountId}, ${other}, ${outsider}, 'member', opengeni_private.workspace_member_role_permissions('member'))`;
  await shared.admin`insert into connections
    (id, account_id, workspace_id, provider_domain, kind, status, credential_encrypted)
    values (${connectionId}, ${accountId}, ${install}, 'slack.com', 'app_install', 'active', '\\x00'::bytea)`;
  return { accountId, install, home, other, owner, colleague, outsider, connectionId };
}

type Scope = {
  accountId: string;
  workspaceId: string;
  subjectId?: string | undefined;
  dualWrite?: boolean;
};

/** One runtime-role transaction in a tenancy scope, as the application sets it. */
async function asApp<T>(scope: Scope, run: (sql: postgres.TransactionSql) => Promise<T>) {
  return (await appSql.begin(async (sql) => {
    await sql`select set_config('opengeni.account_id', ${scope.accountId}, true),
      set_config('opengeni.workspace_id', ${scope.workspaceId}, true),
      set_config('opengeni.subject_id', ${scope.subjectId ?? ""}, true),
      set_config('opengeni.agents_dual_write', ${scope.dualWrite ? "1" : ""}, true)`;
    return await run(sql);
  })) as T;
}

/** Replays a backfill as the migration owner, exactly as `migrate` runs it. */
async function asOwner(body: string) {
  await shared.admin.begin(async (sql) => {
    await sql.unsafe(`SET LOCAL ROLE "${shared.ownerRole}"`);
    await sql.unsafe(`SELECT
      pg_catalog.set_config('lock_timeout', '5s', true),
      pg_catalog.set_config('opengeni.sandbox_recovery_protocol_v2', '1', true),
      pg_catalog.set_config('opengeni.session_variable_set_attachments_v1', '1', true);`);
    await sql.unsafe(body);
  });
}

const avatar = { kind: "emoji", emoji: "🛠️", hue: 210 };
/** A Slack agent avatar above the 1,024-byte template bound and within its own 4,096. */
const largeAvatar = { kind: "image", data: "a".repeat(3_000) };

type SlackAgentInput = {
  id?: string;
  name: string;
  nameKey: string;
  description?: string;
  instructions?: string;
  open?: boolean;
  collectionId?: string | null;
  avatar?: Record<string, unknown>;
};

/** A Slack agent as an older binary writes it: in the installation's workspace. */
async function insertSlackAgent(org: Org, input: SlackAgentInput, scope: Partial<Scope> = {}) {
  const id = input.id ?? crypto.randomUUID();
  await asApp(
    { accountId: org.accountId, workspaceId: org.install, subjectId: org.owner, ...scope },
    (
      sql,
    ) => sql`insert into slack_agents (id, account_id, workspace_id, connection_id, slack_team_id,
        target_account_id, target_workspace_id, name, name_key, description, avatar, instructions,
        knowledge_collection_id, open, created_by_subject_id)
      values (${id}, ${org.accountId}, ${org.install}, ${org.connectionId}, 'T0AGENTS',
        ${org.accountId}, ${org.home}, ${input.name}, ${input.nameKey},
        ${input.description ?? "Helps with releases"}, ${sql.json((input.avatar ?? avatar) as never)},
        ${input.instructions ?? "Be brief."}, ${input.collectionId ?? null}, ${input.open ?? false},
        ${org.owner})`,
  );
  return id;
}

type TemplateInput = {
  id?: string;
  name: string;
  description?: string;
  setup?: string;
  visibility?: "private" | "workspace";
  createdBy?: string | null;
  sourceSessionId?: string | null;
  avatar?: Record<string, unknown> | null;
};

/** A bot template as an older binary writes it. */
async function insertTemplate(org: Org, input: TemplateInput, scope: Partial<Scope> = {}) {
  const id = input.id ?? crypto.randomUUID();
  await asApp(
    { accountId: org.accountId, workspaceId: org.home, subjectId: org.owner, ...scope },
    (sql) => sql`insert into bot_templates (id, account_id, workspace_id, name, description, avatar,
        setup_instructions, visibility, source_session_id, created_by_subject_id)
      values (${id}, ${org.accountId}, ${org.home}, ${input.name}, ${input.description ?? ""},
        ${input.avatar === undefined ? null : input.avatar === null ? null : sql.json(input.avatar as never)},
        ${input.setup ?? "Create a weekly schedule."}, ${input.visibility ?? "workspace"},
        ${input.sourceSessionId ?? null},
        ${input.createdBy === undefined ? org.owner : input.createdBy})`,
  );
  return id;
}

type AgentRow = {
  id: string;
  accountId: string;
  workspaceId: string;
  visibility: string;
  ownerSubjectId: string | null;
  name: string;
  nameKey: string;
  description: string;
  avatar: unknown;
  memoryEnabled: boolean;
  memoryCollectionId: string | null;
  currentRevision: number;
  origin: string;
  sourceSessionId: string | null;
  createdBySubjectId: string | null;
  version: number;
};

/** Ground truth, read past RLS. */
async function agent(id: string): Promise<AgentRow | undefined> {
  const [row] = await shared.admin<AgentRow[]>`
    select id, account_id as "accountId", workspace_id as "workspaceId", visibility,
      owner_subject_id as "ownerSubjectId", name, name_key as "nameKey", description, avatar,
      memory_enabled as "memoryEnabled", memory_collection_id as "memoryCollectionId",
      current_revision as "currentRevision", origin, source_session_id as "sourceSessionId",
      created_by_subject_id as "createdBySubjectId", version
    from agents where id = ${id}`;
  return row;
}

async function revisions(agentId: string) {
  return [
    ...(await shared.admin<
      {
        revision: number;
        workspaceId: string;
        name: string;
        description: string;
        instructions: string;
        firstMessage: string;
        createdBy: string | null;
      }[]
    >`select revision, workspace_id as "workspaceId", name, description, instructions,
        first_message as "firstMessage", created_by_subject_id as "createdBy"
      from agent_revisions where agent_id = ${agentId} order by revision`),
  ];
}

async function installs(agentId: string) {
  return [
    ...(await shared.admin<
      {
        workspaceId: string;
        connectionId: string;
        slackTeamId: string;
        nameKey: string;
        open: boolean;
        enabledBy: string | null;
      }[]
    >`select workspace_id as "workspaceId", connection_id as "connectionId",
        slack_team_id as "slackTeamId", name_key as "nameKey", open,
        enabled_by_subject_id as "enabledBy"
      from agent_slack_installs where agent_id = ${agentId}`),
  ];
}

/** The error a promise rejects with, flattened past ORM wrappers. */
async function rejection(
  promise: Promise<unknown>,
): Promise<{ code: string | undefined; message: string }> {
  try {
    await promise;
  } catch (error) {
    const err = error as {
      code?: string;
      message?: string;
      cause?: { code?: string; message?: string };
    };
    return {
      code: err.code ?? err.cause?.code,
      message: `${err.message ?? ""} ${err.cause?.message ?? ""}`,
    };
  }
  throw new Error("expected the statement to fail");
}

describe("1243 backfill", () => {
  test("maps Slack agents and bot templates onto agents, revisions and Slack installs", async () => {
    const org = await organization();
    const collectionId = crypto.randomUUID();
    const sourceSessionId = crypto.randomUUID();
    // Legacy rows written while the sync triggers stand aside, so only the
    // backfill can create their agents.
    const dual = { dualWrite: true };
    const slackId = await insertSlackAgent(
      org,
      {
        name: "  Release Bot ",
        nameKey: "release_bot",
        description: " Ships releases ",
        instructions: "Follow the release checklist.",
        open: true,
        collectionId,
      },
      dual,
    );
    const shared1 = await insertTemplate(
      org,
      {
        name: " Weekly report ",
        description: " Writes the report ",
        setup: "Create a weekly schedule that writes the report.",
        sourceSessionId,
        avatar,
      },
      dual,
    );
    const onlyMe = await insertTemplate(
      org,
      { name: "My helper", visibility: "private", createdBy: org.colleague },
      dual,
    );
    const bigAvatar = await insertSlackAgent(
      org,
      { name: "Designer", nameKey: "designer", avatar: largeAvatar },
      dual,
    );
    // A template that shares the Slack agent's id: the Slack agent wins.
    await insertTemplate(org, { id: slackId, name: "Clashing template" }, dual);
    expect(await agent(slackId)).toBeUndefined();
    expect(await agent(shared1)).toBeUndefined();

    await asOwner(`ALTER TABLE agents NO FORCE ROW LEVEL SECURITY;
      ALTER TABLE agent_revisions NO FORCE ROW LEVEL SECURITY;
      ALTER TABLE agent_slack_installs NO FORCE ROW LEVEL SECURITY;
      ${agentsBackfill}`);

    expect(await agent(slackId)).toMatchObject({
      accountId: org.accountId,
      workspaceId: org.home,
      visibility: "workspace",
      ownerSubjectId: null,
      name: "Release Bot",
      nameKey: "release bot",
      description: "Ships releases",
      avatar,
      memoryEnabled: true,
      memoryCollectionId: collectionId,
      currentRevision: 1,
      origin: "slack_agent",
      sourceSessionId: null,
      createdBySubjectId: org.owner,
      version: 1,
    });
    expect(await revisions(slackId)).toEqual([
      {
        revision: 1,
        workspaceId: org.home,
        name: "Release Bot",
        description: "Ships releases",
        instructions: "Follow the release checklist.",
        firstMessage: "",
        createdBy: org.owner,
      },
    ]);
    expect(await installs(slackId)).toEqual([
      {
        workspaceId: org.home,
        connectionId: org.connectionId,
        slackTeamId: "T0AGENTS",
        nameKey: "release_bot",
        open: true,
        enabledBy: org.owner,
      },
    ]);

    expect(await agent(shared1)).toMatchObject({
      workspaceId: org.home,
      visibility: "workspace",
      ownerSubjectId: null,
      name: "Weekly report",
      nameKey: "weekly report",
      description: "Writes the report",
      avatar,
      memoryEnabled: false,
      memoryCollectionId: null,
      currentRevision: 1,
      origin: "bot_template",
      sourceSessionId,
      createdBySubjectId: org.owner,
    });
    expect(await revisions(shared1)).toEqual([
      {
        revision: 1,
        workspaceId: org.home,
        name: "Weekly report",
        description: "Writes the report",
        instructions: "",
        firstMessage: "Create a weekly schedule that writes the report.",
        createdBy: org.owner,
      },
    ]);
    expect(await installs(shared1)).toEqual([]);
    expect(await agent(onlyMe)).toMatchObject({
      visibility: "private",
      ownerSubjectId: org.colleague,
      avatar: null,
      origin: "bot_template",
    });
    expect((await agent(bigAvatar))!.avatar).toEqual(largeAvatar);

    // Rerunning changes nothing.
    const before = await shared.admin`select count(*)::int as n from agent_revisions
      where account_id = ${org.accountId}`;
    await asOwner(`ALTER TABLE agents NO FORCE ROW LEVEL SECURITY;
      ALTER TABLE agent_revisions NO FORCE ROW LEVEL SECURITY;
      ALTER TABLE agent_slack_installs NO FORCE ROW LEVEL SECURITY;
      ${agentsBackfill}`);
    const after = await shared.admin`select count(*)::int as n from agent_revisions
      where account_id = ${org.accountId}`;
    expect(after[0]!.n).toBe(before[0]!.n);
    expect((await agent(slackId))!.origin).toBe("slack_agent");

    // FORCE RLS is restored on every table the backfill relaxed.
    const forced = await shared.admin<{ relname: string; forced: boolean }[]>`
      select c.relname, c.relforcerowsecurity as forced from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = ${shared.schema}
        and c.relname in ('agents', 'agent_revisions', 'agent_slack_installs', 'bot_templates', 'slack_agents')`;
    expect(forced.every((row) => row.forced)).toBe(true);
    expect(forced).toHaveLength(5);
  }, 120_000);
});

describe("legacy sync triggers", () => {
  test("Slack agent writes from the installation's workspace reach the agent's home", async () => {
    const org = await organization();
    const id = crypto.randomUUID();
    const settings = await asApp(
      { accountId: org.accountId, workspaceId: org.install, subjectId: org.owner },
      async (sql) => {
        await sql`insert into slack_agents (id, account_id, workspace_id, connection_id, slack_team_id,
            target_account_id, target_workspace_id, name, name_key, description, avatar, instructions,
            open, created_by_subject_id)
          values (${id}, ${org.accountId}, ${org.install}, ${org.connectionId}, 'T0AGENTS',
            ${org.accountId}, ${org.home}, 'Triage', 'triage', 'Sorts issues', ${sql.json(avatar)},
            'Label every issue.', false, ${org.owner})`;
        // The trigger restores the writer's tenancy settings.
        const [row] = await sql<{ workspace: string; subject: string }[]>`
          select current_setting('opengeni.workspace_id') as workspace,
            current_setting('opengeni.subject_id') as subject`;
        return row!;
      },
    );
    expect(settings).toEqual({ workspace: org.install, subject: org.owner });
    expect(await agent(id)).toMatchObject({
      workspaceId: org.home,
      visibility: "workspace",
      name: "Triage",
      memoryEnabled: true,
      currentRevision: 1,
      origin: "slack_agent",
      version: 1,
    });
    expect(await revisions(id)).toMatchObject([
      { revision: 1, instructions: "Label every issue.", firstMessage: "", createdBy: org.owner },
    ]);
    expect(await installs(id)).toMatchObject([
      { workspaceId: org.home, connectionId: org.connectionId, nameKey: "triage", open: false },
    ]);

    // A rename changes the directory and the Slack handle, not the revision.
    await asApp(
      { accountId: org.accountId, workspaceId: org.install, subjectId: org.colleague },
      (sql) =>
        sql`update slack_agents set name = 'Issue triage', name_key = 'issue_triage',
        description = 'Sorts every issue' where id = ${id}`,
    );
    expect(await agent(id)).toMatchObject({
      name: "Issue triage",
      nameKey: "issue triage",
      description: "Sorts every issue",
      currentRevision: 1,
      version: 2,
    });
    expect(await installs(id)).toMatchObject([{ nameKey: "issue_triage", open: false }]);

    // Open use and Memory follow their legacy columns.
    const collectionId = crypto.randomUUID();
    await asApp(
      { accountId: org.accountId, workspaceId: org.install },
      (sql) =>
        sql`update slack_agents set open = true, knowledge_collection_id = ${collectionId}
        where id = ${id}`,
    );
    expect(await installs(id)).toMatchObject([{ open: true }]);
    expect((await agent(id))!.memoryCollectionId).toBe(collectionId);

    // New code wrote a First message in revision 2 (both shapes, so the
    // triggers stood aside). An older binary's Instructions edit keeps it.
    await asApp(
      { accountId: org.accountId, workspaceId: org.home, subjectId: org.owner, dualWrite: true },
      async (sql) => {
        await sql`insert into agent_revisions (agent_id, account_id, workspace_id, revision, name,
            description, instructions, first_message, created_by_subject_id)
          values (${id}, ${org.accountId}, ${org.home}, 2, 'Issue triage', 'Sorts every issue',
            'Label every issue.', 'What should I triage?', ${org.owner})`;
        await sql`update agents set current_revision = 2 where id = ${id}`;
      },
    );
    await asApp(
      { accountId: org.accountId, workspaceId: org.install, subjectId: org.colleague },
      (sql) =>
        sql`update slack_agents set instructions = 'Label and assign every issue.' where id = ${id}`,
    );
    expect((await agent(id))!.currentRevision).toBe(3);
    expect((await revisions(id)).at(-1)).toEqual({
      revision: 3,
      workspaceId: org.home,
      name: "Issue triage",
      description: "Sorts every issue",
      instructions: "Label and assign every issue.",
      firstMessage: "What should I triage?",
      createdBy: org.colleague,
    });

    // Deleting the Slack agent deletes the agent with its revisions and install.
    await asApp(
      { accountId: org.accountId, workspaceId: org.install },
      (sql) => sql`delete from slack_agents where id = ${id}`,
    );
    expect(await agent(id)).toBeUndefined();
    expect(await revisions(id)).toEqual([]);
    expect(await installs(id)).toEqual([]);
  }, 60_000);

  test("bot template writes reach the agent; a template never changes a Slack agent", async () => {
    const org = await organization();
    const id = await insertTemplate(org, { name: "Standup", setup: "Ask for updates." });
    expect(await agent(id)).toMatchObject({
      workspaceId: org.home,
      visibility: "workspace",
      ownerSubjectId: null,
      memoryEnabled: false,
      origin: "bot_template",
      currentRevision: 1,
    });
    expect(await revisions(id)).toMatchObject([
      { revision: 1, instructions: "", firstMessage: "Ask for updates." },
    ]);

    // Instructions written by new code are carried into the next revision.
    await asApp(
      { accountId: org.accountId, workspaceId: org.home, dualWrite: true },
      async (sql) => {
        await sql`insert into agent_revisions (agent_id, account_id, workspace_id, revision, name,
          description, instructions, first_message)
        values (${id}, ${org.accountId}, ${org.home}, 2, 'Standup', '', 'Keep it short.',
          'Ask for updates.')`;
        await sql`update agents set current_revision = 2 where id = ${id}`;
      },
    );
    await asApp(
      { accountId: org.accountId, workspaceId: org.home, subjectId: org.colleague },
      (sql) =>
        sql`update bot_templates set setup_instructions = 'Ask everyone for updates.',
        name = 'Daily standup' where id = ${id}`,
    );
    expect(await agent(id)).toMatchObject({
      name: "Daily standup",
      currentRevision: 3,
      version: 2,
    });
    expect((await revisions(id)).at(-1)).toMatchObject({
      revision: 3,
      name: "Daily standup",
      instructions: "Keep it short.",
      firstMessage: "Ask everyone for updates.",
      createdBy: org.colleague,
    });

    // A description-only edit adds no revision.
    await asApp(
      { accountId: org.accountId, workspaceId: org.home },
      (sql) => sql`update bot_templates set description = ' Every morning ' where id = ${id}`,
    );
    expect(await agent(id)).toMatchObject({ description: "Every morning", currentRevision: 3 });

    // Only me: the owner is whoever saved the template.
    await asApp(
      { accountId: org.accountId, workspaceId: org.home },
      (sql) => sql`update bot_templates set visibility = 'private' where id = ${id}`,
    );
    expect(await agent(id)).toMatchObject({ visibility: "private", ownerSubjectId: org.owner });

    await asApp(
      { accountId: org.accountId, workspaceId: org.home },
      (sql) => sql`delete from bot_templates where id = ${id}`,
    );
    expect(await agent(id)).toBeUndefined();
    expect(await revisions(id)).toEqual([]);

    // A template sharing a Slack agent's id never changes that agent.
    const slackId = await insertSlackAgent(org, { name: "Ops", nameKey: "ops" });
    notices.length = 0;
    await insertTemplate(org, { id: slackId, name: "Clash", setup: "Clash text" });
    await asApp(
      { accountId: org.accountId, workspaceId: org.home },
      (sql) => sql`update bot_templates set name = 'Clash 2' where id = ${slackId}`,
    );
    await asApp(
      { accountId: org.accountId, workspaceId: org.home },
      (sql) => sql`delete from bot_templates where id = ${slackId}`,
    );
    expect(await agent(slackId)).toMatchObject({ name: "Ops", origin: "slack_agent" });
    expect(await revisions(slackId)).toHaveLength(1);
    expect(notices.some((notice) => notice.includes("shares its id with a Slack agent"))).toBe(
      true,
    );
  }, 60_000);

  test("template visibility and owner changes, and all-blank names", async () => {
    const org = await organization();
    const id = await insertTemplate(org, {
      name: "Private helper",
      visibility: "private",
      createdBy: org.colleague,
    });
    expect(await agent(id)).toMatchObject({ visibility: "private", ownerSubjectId: org.colleague });
    // A new saver of an Only me template becomes its owner.
    await asApp(
      { accountId: org.accountId, workspaceId: org.home },
      (sql) => sql`update bot_templates set created_by_subject_id = ${org.owner} where id = ${id}`,
    );
    expect(await agent(id)).toMatchObject({ visibility: "private", ownerSubjectId: org.owner });
    // Shared again: no owner.
    await asApp(
      { accountId: org.accountId, workspaceId: org.home },
      (sql) => sql`update bot_templates set visibility = 'workspace' where id = ${id}`,
    );
    expect(await agent(id)).toMatchObject({
      visibility: "workspace",
      ownerSubjectId: null,
      createdBySubjectId: org.colleague,
    });

    // bot_templates accepts an all-blank name; the agent gets a placeholder
    // instead of failing the older binary's write.
    const blank = await insertTemplate(org, { name: "   " });
    expect(await agent(blank)).toMatchObject({ name: "Bot template", nameKey: "bot template" });
    expect((await revisions(blank))[0]!.name).toBe("Bot template");
    await asApp(
      { accountId: org.accountId, workspaceId: org.home },
      (sql) => sql`update bot_templates set name = 'Named' where id = ${blank}`,
    );
    await asApp(
      { accountId: org.accountId, workspaceId: org.home },
      (sql) => sql`update bot_templates set name = ' ' where id = ${blank}`,
    );
    expect(await agent(blank)).toMatchObject({ name: "Bot template" });

    // The backfill maps it the same way.
    const blankBackfilled = await insertTemplate(org, { name: "  " }, { dualWrite: true });
    await asOwner(`ALTER TABLE agents NO FORCE ROW LEVEL SECURITY;
      ALTER TABLE agent_revisions NO FORCE ROW LEVEL SECURITY;
      ALTER TABLE agent_slack_installs NO FORCE ROW LEVEL SECURITY;
      ${agentsBackfill}`);
    expect(await agent(blankBackfilled)).toMatchObject({ name: "Bot template" });
    expect((await revisions(blankBackfilled))[0]!.name).toBe("Bot template");
  }, 60_000);

  test("a new Slack agent sharing a template agent's id takes the agent over", async () => {
    const org = await organization();
    const id = await insertTemplate(org, {
      name: "Helper",
      setup: "Template text.",
      visibility: "private",
      createdBy: org.colleague,
    });
    const collectionId = crypto.randomUUID();
    await insertSlackAgent(org, {
      id,
      name: "Helper desk",
      nameKey: "helper_desk",
      instructions: "Answer helpdesk questions.",
      collectionId,
    });
    expect(await agent(id)).toMatchObject({
      workspaceId: org.home,
      origin: "slack_agent",
      visibility: "workspace",
      ownerSubjectId: null,
      memoryEnabled: true,
      memoryCollectionId: collectionId,
      name: "Helper desk",
      currentRevision: 2,
    });
    expect((await revisions(id)).at(-1)).toMatchObject({
      revision: 2,
      instructions: "Answer helpdesk questions.",
      firstMessage: "Template text.",
    });
    expect(await installs(id)).toHaveLength(1);

    // The template no longer changes it, and deleting the template keeps it.
    await asApp(
      { accountId: org.accountId, workspaceId: org.home },
      (sql) => sql`update bot_templates set name = 'Changed', setup_instructions = 'New'
        where id = ${id}`,
    );
    await asApp(
      { accountId: org.accountId, workspaceId: org.home },
      (sql) => sql`delete from bot_templates where id = ${id}`,
    );
    expect(await agent(id)).toMatchObject({ name: "Helper desk", currentRevision: 2 });
    expect(await installs(id)).toHaveLength(1);
  }, 60_000);

  test("opengeni.agents_dual_write = '1' turns every sync off", async () => {
    const org = await organization();
    const dual = { dualWrite: true };
    const slackId = await insertSlackAgent(org, { name: "Quiet", nameKey: "quiet" }, dual);
    const templateId = await insertTemplate(org, { name: "Quiet template" }, dual);
    expect(await agent(slackId)).toBeUndefined();
    expect(await agent(templateId)).toBeUndefined();

    // Rows that exist are neither changed nor deleted while it is set: new
    // code turning Slack off deletes the legacy row and keeps the agent.
    const kept = await insertSlackAgent(org, { name: "Kept", nameKey: "kept" });
    const keptTemplate = await insertTemplate(org, { name: "Kept template" });
    await asApp(
      { accountId: org.accountId, workspaceId: org.install, dualWrite: true },
      (sql) =>
        sql`update slack_agents set name = 'Renamed', instructions = 'Changed' where id = ${kept}`,
    );
    await asApp(
      { accountId: org.accountId, workspaceId: org.home, dualWrite: true },
      (sql) =>
        sql`update bot_templates set setup_instructions = 'Changed' where id = ${keptTemplate}`,
    );
    expect(await agent(kept)).toMatchObject({ name: "Kept", currentRevision: 1, version: 1 });
    expect(await agent(keptTemplate)).toMatchObject({ currentRevision: 1, version: 1 });
    await asApp(
      { accountId: org.accountId, workspaceId: org.install, dualWrite: true },
      (sql) => sql`delete from slack_agents where id = ${kept}`,
    );
    await asApp(
      { accountId: org.accountId, workspaceId: org.home, dualWrite: true },
      (sql) => sql`delete from bot_templates where id = ${keptTemplate}`,
    );
    expect(await agent(kept)).toMatchObject({ name: "Kept" });
    expect(await installs(kept)).toHaveLength(1);
    expect(await agent(keptTemplate)).toMatchObject({ name: "Kept template" });
  }, 60_000);

  test("a legacy write whose agent is out of reach fails instead of syncing nothing", async () => {
    const org = await organization();
    // An agent with this id already lives in another workspace.
    const id = crypto.randomUUID();
    await asApp(
      { accountId: org.accountId, workspaceId: org.other },
      (sql) =>
        sql`insert into agents (id, account_id, workspace_id, visibility, name, name_key, origin)
        values (${id}, ${org.accountId}, ${org.other}, 'workspace', 'Elsewhere', 'elsewhere', 'app')`,
    );
    const failed = await rejection(insertTemplate(org, { id, name: "Same id" }));
    expect(failed.code).toBe("23505");
    expect(await shared.admin`select 1 from bot_templates where id = ${id}`).toHaveLength(0);
    expect(await agent(id)).toMatchObject({ workspaceId: org.other, name: "Elsewhere" });
  }, 60_000);

  test("deletes by the table owner and runtime workspace deletions delete the agent", async () => {
    const org = await organization();
    const asTableOwner = (statement: (sql: postgres.TransactionSql) => Promise<unknown>) =>
      shared.admin.begin(async (sql) => {
        await sql.unsafe(`SET LOCAL ROLE "${shared.ownerRole}"`);
        await sql`select set_config('opengeni.account_id', ${org.accountId}, true),
          set_config('opengeni.workspace_id', ${org.install}, true)`;
        await statement(sql);
      });
    // FORCE RLS binds the owner, so the trigger's switch to the agent's home
    // workspace is what lets it reach the agent.
    const id = await insertSlackAgent(org, { name: "Owner", nameKey: "owner_delete" });
    await asTableOwner(async (sql) => {
      expect(await sql`delete from slack_agents where id = ${id} returning id`).toHaveLength(1);
    });
    expect(await agent(id)).toBeUndefined();

    // Deleting the installation's workspace as the runtime cascades to its
    // Slack agents; their AFTER triggers run as the runtime and reach the
    // agents in the target workspace.
    const cascaded = await insertSlackAgent(org, { name: "Cascade", nameKey: "cascade" });
    await deleteWorkspace(app.db, org.install);
    expect(await shared.admin`select 1 from slack_agents where id = ${cascaded}`).toHaveLength(0);
    expect(await agent(cascaded)).toBeUndefined();

    // Deleting the agent's home workspace deletes its agents and the Slack
    // agents that target it, whichever the cascade reaches first.
    const second = await organization();
    const homed = await insertSlackAgent(second, { name: "Homed", nameKey: "homed" });
    const template = await insertTemplate(second, { name: "Homed template" });
    await deleteWorkspace(app.db, second.home);
    expect(await shared.admin`select 1 from slack_agents where id = ${homed}`).toHaveLength(0);
    expect(await agent(homed)).toBeUndefined();
    expect(await agent(template)).toBeUndefined();
  }, 60_000);
});

describe("RLS on the agents tables", () => {
  test("home workspace, organization read of shared agents only, Only me for its owner", async () => {
    const org = await organization();
    const sharedId = await insertSlackAgent(org, { name: "Shared", nameKey: "shared" });
    const onlyMe = await insertTemplate(org, { name: "Mine", visibility: "private" });
    // An Only me agent made available in Slack by new code.
    await asApp(
      { accountId: org.accountId, workspaceId: org.home, subjectId: org.owner },
      (sql) => sql`insert into agent_slack_installs (agent_id, account_id, workspace_id,
          connection_id, slack_team_id, name_key)
        values (${onlyMe}, ${org.accountId}, ${org.home}, ${org.connectionId}, 'T0AGENTS', 'mine')`,
    );
    const visible = async (scope: Scope) =>
      await asApp(scope, async (sql) => ({
        agents: (await sql<{ id: string }[]>`select id from agents order by name`).map((r) => r.id),
        revisions: (
          await sql<
            { agentId: string }[]
          >`select distinct agent_id as "agentId" from agent_revisions`
        )
          .map((r) => r.agentId)
          .sort(),
        installs: (
          await sql<{ agentId: string }[]>`select agent_id as "agentId" from agent_slack_installs`
        )
          .map((r) => r.agentId)
          .sort(),
      }));
    const home = { accountId: org.accountId, workspaceId: org.home };
    const both = [sharedId, onlyMe].sort();

    // The owner and system work see both; a colleague only the shared one,
    // including its Slack installs.
    expect(await visible({ ...home, subjectId: org.owner })).toEqual({
      agents: [onlyMe, sharedId],
      revisions: both,
      installs: both,
    });
    expect((await visible(home)).agents.sort()).toEqual(both);
    expect(await visible({ ...home, subjectId: org.colleague })).toEqual({
      agents: [sharedId],
      revisions: [sharedId],
      installs: [sharedId],
    });

    // Elsewhere in the organization: the directory and Slack installs of
    // shared agents, never revisions, never an Only me agent (not even its owner's).
    for (const subjectId of [org.outsider, org.owner, undefined]) {
      expect(
        await visible({ accountId: org.accountId, workspaceId: org.other, subjectId }),
      ).toEqual({
        agents: [sharedId],
        revisions: [],
        installs: [sharedId],
      });
    }

    // Another organization sees nothing.
    const stranger = await organization();
    expect(
      await visible({
        accountId: stranger.accountId,
        workspaceId: stranger.home,
        subjectId: stranger.owner,
      }),
    ).toEqual({ agents: [], revisions: [], installs: [] });

    // The organization read is read only.
    const changed = await asApp(
      { accountId: org.accountId, workspaceId: org.other, subjectId: org.outsider },
      (sql) => sql`update agents set name = 'Hijacked' where id = ${sharedId} returning id`,
    );
    expect(changed).toHaveLength(0);
    const removed = await asApp(
      { accountId: org.accountId, workspaceId: org.other, subjectId: org.outsider },
      (sql) => sql`delete from agent_slack_installs where agent_id = ${sharedId} returning id`,
    );
    expect(removed).toHaveLength(0);

    // Nobody writes an Only me agent for someone else.
    const forColleague = await rejection(
      asApp(
        { ...home, subjectId: org.owner },
        (sql) =>
          sql`insert into agents (account_id, workspace_id, visibility, owner_subject_id, name, name_key, origin)
          values (${org.accountId}, ${org.home}, 'private', ${org.colleague}, 'Theirs', 'theirs', 'app')`,
      ),
    );
    expect(forColleague.code).toBe("42501");
    const own = await asApp(
      { ...home, subjectId: org.owner },
      (sql) =>
        sql`insert into agents (account_id, workspace_id, visibility, owner_subject_id, name, name_key, origin)
        values (${org.accountId}, ${org.home}, 'private', ${org.owner}, 'Mine too', 'mine too', 'app')
        returning id`,
    );
    expect(own).toHaveLength(1);
    // ...nor a revision of an agent the writer cannot see.
    const hiddenRevision = await rejection(
      asApp(
        { ...home, subjectId: org.colleague },
        (sql) =>
          sql`insert into agent_revisions (agent_id, account_id, workspace_id, revision, name)
          values (${onlyMe}, ${org.accountId}, ${org.home}, 9, 'Mine')`,
      ),
    );
    expect(hiddenRevision.code).toBe("42501");
  }, 60_000);

  test("revisions are immutable for the runtime", async () => {
    const org = await organization();
    const id = await insertTemplate(org, { name: "Immutable" });
    const home = { accountId: org.accountId, workspaceId: org.home, subjectId: org.owner };
    expect(
      (
        await rejection(
          asApp(
            home,
            (sql) => sql`update agent_revisions set instructions = 'x' where agent_id = ${id}`,
          ),
        )
      ).code,
    ).toBe("42501");
    expect(
      (
        await rejection(
          asApp(home, (sql) => sql`delete from agent_revisions where agent_id = ${id}`),
        )
      ).code,
    ).toBe("42501");
    const grants = await shared.admin<{ privilege: string }[]>`
      select privilege_type as privilege from information_schema.role_table_grants
      where grantee = 'opengeni_app' and table_schema = ${shared.schema} and table_name = 'agent_revisions'
      order by privilege_type`;
    expect(grants.map((row) => row.privilege)).toEqual(["INSERT", "SELECT"]);
  }, 60_000);
});

describe("sessions.agent_id", () => {
  const chat = (org: Org, workspaceId = org.home) =>
    withSessionRlsActorContext({ subjectId: org.owner }, () =>
      createSession(app.db, {
        accountId: org.accountId,
        workspaceId,
        initialMessage: "",
        resources: [],
        metadata: {},
        createdBy: { kind: "subject", subjectId: org.owner },
        createdByContext: {},
        model: "gpt-5.6-sol",
        reasoningEffort: "medium" as const,
        latencyMode: "standard" as const,
        sandboxBackend: "none",
      }),
    );
  const setAgent = (org: Org, sessionId: string, agentId: string | null, revision?: number) =>
    withWorkspaceSessionActivityRls(app.db, org.home, (scoped) =>
      scoped.execute(drizzleSql`update sessions set agent_id = ${agentId},
        agent_prompt_revision = ${revision ?? null} where id = ${sessionId}`),
    );
  const agentOf = async (sessionId: string) => {
    const [row] = await shared.admin<{ agentId: string | null }[]>`
      select agent_id as "agentId" from sessions where id = ${sessionId}`;
    return row!.agentId;
  };

  test("is set once from NULL and never changed", async () => {
    const org = await organization();
    const session = await chat(org);
    expect(await agentOf(session.id)).toBeNull();
    const first = crypto.randomUUID();
    await setAgent(org, session.id, first);
    expect(await agentOf(session.id)).toBe(first);
    await setAgent(org, session.id, first, 1); // unchanged agent: allowed
    const moved = await rejection(setAgent(org, session.id, crypto.randomUUID()));
    expect(moved.code).toBe("55000");
    expect(moved.message).toContain("cannot change");
    expect((await rejection(setAgent(org, session.id, null))).code).toBe("55000");
    expect(await agentOf(session.id)).toBe(first);

    // A prompt revision needs an agent.
    const plain = await chat(org);
    expect((await rejection(setAgent(org, plain.id, null, 1))).code).toBe("23514");
  }, 60_000);

  test("1244 links existing Slack agent chats to their agent", async () => {
    const org = await organization();
    const agentA = await insertSlackAgent(org, { name: "Alpha", nameKey: "alpha" });
    const agentB = await insertSlackAgent(org, { name: "Beta", nameKey: "beta" });
    const linked = await chat(org);
    const handedOff = await chat(org);
    const elsewhere = await chat(org, org.other);
    const plain = await chat(org);
    const interaction = async (
      sessionId: string,
      agentId: string,
      workspaceId: string,
      at: string,
    ) => {
      await shared.admin`insert into slack_interactions
        (account_id, workspace_id, connection_id, slack_team_id, slack_channel_id, slack_thread_ts,
         route_key, triggering_provider_event_id, owning_subject_id, visibility, session_id,
         session_reservation_id, slack_agent_id, created_at)
        values (${org.accountId}, ${workspaceId}, ${org.connectionId}, 'T0AGENTS', 'C0AGENTS',
          ${`${Date.now()}.${Math.floor(Math.random() * 1e6)}`}, ${crypto.randomUUID()},
          ${crypto.randomUUID()}, ${org.owner}, 'workspace', ${sessionId}, ${sessionId}, ${agentId},
          ${at})`;
    };
    await interaction(linked.id, agentA, org.home, "2026-11-01T10:00:00Z");
    // A chat bound by more than one interaction (one per workspace) belongs
    // to the agent of the first.
    await interaction(handedOff.id, agentB, org.home, "2026-11-01T10:00:00Z");
    await interaction(handedOff.id, agentA, org.install, "2026-11-01T11:00:00Z");
    // A chat outside the agent's home is never linked.
    await interaction(elsewhere.id, agentA, org.other, "2026-11-01T10:00:00Z");

    await asOwner(sessionsBackfill);

    expect(await agentOf(linked.id)).toBe(agentA);
    expect(await agentOf(handedOff.id)).toBe(agentB);
    expect(await agentOf(elsewhere.id)).toBeNull();
    expect(await agentOf(plain.id)).toBeNull();
    const [revision] = await shared.admin<{ revision: number | null }[]>`
      select agent_prompt_revision as revision from sessions where id = ${linked.id}`;
    expect(revision!.revision).toBeNull();

    // Rerunning is a no-op and FORCE RLS and the fence trigger are restored.
    await asOwner(sessionsBackfill);
    expect(await agentOf(handedOff.id)).toBe(agentB);
    const posture = await shared.admin<{ relname: string; forced: boolean }[]>`
      select c.relname, c.relforcerowsecurity as forced from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = ${shared.schema} and c.relname in ('sessions', 'slack_interactions', 'agents')`;
    expect(posture.every((row) => row.forced)).toBe(true);
    const [fence] = await shared.admin<{ enabled: string }[]>`
      select t.tgenabled as enabled from pg_trigger t join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = ${shared.schema} and c.relname = 'sessions'
        and t.tgname = 'session_tenancy_workspace_fence'`;
    expect(fence!.enabled).toBe("O");
  }, 60_000);
});

describe("wider legacy checks", () => {
  test("accept the agents limits, keep their new bounds, and are validated", async () => {
    const org = await organization();
    const longName = "N".repeat(110);
    const id = await insertSlackAgent(org, {
      name: longName,
      nameKey: "long",
      description: "",
      instructions: "i".repeat(20_000),
    });
    expect(await agent(id)).toMatchObject({ name: longName, description: "" });
    expect((await revisions(id))[0]!.instructions).toHaveLength(20_000);
    // An untrimmed name is accepted (the length check trims) and a Slack agent
    // avatar above the template bound syncs.
    const roomy = await insertSlackAgent(org, {
      name: `  ${"P".repeat(118)}  `,
      nameKey: "roomy",
      avatar: largeAvatar,
    });
    expect(await agent(roomy)).toMatchObject({ name: "P".repeat(118), avatar: largeAvatar });
    const emptyFirstMessage = await insertTemplate(org, { name: "Empty", setup: "" });
    expect((await revisions(emptyFirstMessage))[0]!.firstMessage).toBe("");

    const tooLong = await rejection(
      insertSlackAgent(org, {
        name: "Too long",
        nameKey: "too_long",
        instructions: "i".repeat(20_001),
      }),
    );
    expect(tooLong.code).toBe("23514");
    const tooLongName = await rejection(
      insertSlackAgent(org, { name: "N".repeat(121), nameKey: "too_long_name" }),
    );
    expect(tooLongName.code).toBe("23514");
    const tooLongSetup = await rejection(
      insertTemplate(org, { name: "Long", setup: "s".repeat(20_001) }),
    );
    expect(tooLongSetup.code).toBe("23514");

    const constraints = await shared.admin<{ name: string; validated: boolean }[]>`
      select con.conname as name, con.convalidated as validated from pg_constraint con
      join pg_class c on c.oid = con.conrelid join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = ${shared.schema}
        and con.conname in ('slack_agents_bounds_check', 'bot_templates_setup_instructions_check')
      order by con.conname`;
    expect([...constraints]).toEqual([
      { name: "bot_templates_setup_instructions_check", validated: true },
      { name: "slack_agents_bounds_check", validated: true },
    ]);
  }, 60_000);

  test("trigger functions run as the writer and the runtime cannot call them", async () => {
    const routines = await shared.admin<{ name: string; definer: boolean; runtime: boolean }[]>`
      select p.proname as name, p.prosecdef as definer,
        has_function_privilege('opengeni_app', p.oid, 'EXECUTE') as runtime
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = ${shared.schema}
        and p.proname in ('sync_agent_from_bot_template', 'sync_agent_from_slack_agent',
          'guard_session_agent_id_immutable')
      order by p.proname`;
    expect([...routines]).toEqual([
      { name: "guard_session_agent_id_immutable", definer: false, runtime: false },
      { name: "sync_agent_from_bot_template", definer: false, runtime: false },
      { name: "sync_agent_from_slack_agent", definer: false, runtime: false },
    ]);
  });
});
