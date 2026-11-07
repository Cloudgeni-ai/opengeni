// The agents tables under the production database setup: a NOSUPERUSER
// NOBYPASSRLS migration owner, a dedicated data schema, FORCE RLS and the
// restricted runtime role. Covers RLS on agents, revisions and Slack
// installations, revision and sessions.agent_id immutability, and the trigger
// function posture. (The expand-era backfill and legacy sync were covered here
// until the legacy drop removed bot_templates and slack_agents.)
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql as drizzleSql } from "drizzle-orm";
import postgres from "postgres";
import {
  acquireRestrictedRuntimeTestDatabase,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing/shared-pg";
import { createDb, createSession, withWorkspaceSessionActivityRls } from "../src/index";
import { withSessionRlsActorContext } from "../src/database";

let shared: RestrictedRuntimeTestDatabase;
let app: ReturnType<typeof createDb>;
let appSql: postgres.Sql;

beforeAll(async () => {
  const acquired = await acquireRestrictedRuntimeTestDatabase("agents-rls");
  if (!acquired) throw new Error("PostgreSQL required");
  shared = acquired;
  app = createDb(shared.appUrl, { searchPath: shared.schema });
  appSql = postgres(shared.appUrl, { max: 2, connection: { search_path: shared.schema } });
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
};

/** One runtime-role transaction in a tenancy scope, as the application sets it. */
async function asApp<T>(scope: Scope, run: (sql: postgres.TransactionSql) => Promise<T>) {
  return (await appSql.begin(async (sql) => {
    await sql`select set_config('opengeni.account_id', ${scope.accountId}, true),
      set_config('opengeni.workspace_id', ${scope.workspaceId}, true),
      set_config('opengeni.subject_id', ${scope.subjectId ?? ""}, true)`;
    return await run(sql);
  })) as T;
}

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

/** An agent with revision 1, written as the table owner; optionally in Slack. */
async function insertAgent(
  org: Org,
  input: { name: string; visibility?: "workspace" | "private"; slack?: boolean },
) {
  const id = crypto.randomUUID();
  const visibility = input.visibility ?? "workspace";
  const nameKey = input.name.toLowerCase();
  await shared.admin.begin(async (sql) => {
    await sql`insert into agents (id, account_id, workspace_id, visibility, owner_subject_id,
        name, name_key, origin, current_revision)
      values (${id}, ${org.accountId}, ${org.home}, ${visibility},
        ${visibility === "private" ? org.owner : null}, ${input.name}, ${nameKey}, 'app', 1)`;
    await sql`insert into agent_revisions (agent_id, account_id, workspace_id, revision, name)
      values (${id}, ${org.accountId}, ${org.home}, 1, ${input.name})`;
    if (input.slack) {
      await sql`insert into agent_slack_installs (agent_id, account_id, workspace_id,
          connection_id, install_workspace_id, slack_team_id, name_key)
        values (${id}, ${org.accountId}, ${org.home}, ${org.connectionId}, ${org.install},
          'T0AGENTS', ${nameKey})`;
    }
  });
  return id;
}

describe("RLS on the agents tables", () => {
  test("home workspace, organization read of shared agents only, Only me for its owner", async () => {
    const org = await organization();
    const sharedId = await insertAgent(org, { name: "Shared", slack: true });
    const onlyMe = await insertAgent(org, { name: "Mine", visibility: "private" });
    // An Only me agent made available in Slack by new code.
    await asApp(
      { accountId: org.accountId, workspaceId: org.home, subjectId: org.owner },
      (sql) => sql`insert into agent_slack_installs (agent_id, account_id, workspace_id,
          connection_id, install_workspace_id, slack_team_id, name_key)
        values (${onlyMe}, ${org.accountId}, ${org.home}, ${org.connectionId}, ${org.install},
          'T0AGENTS', 'mine')`,
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
    const id = await insertAgent(org, { name: "Immutable" });
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
});

describe("trigger functions", () => {
  test("run as the writer and the runtime cannot call them", async () => {
    const routines = await shared.admin<{ name: string; definer: boolean; runtime: boolean }[]>`
      select p.proname as name, p.prosecdef as definer,
        has_function_privilege('opengeni_app', p.oid, 'EXECUTE') as runtime
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = ${shared.schema}
        and p.proname in ('sync_agent_from_bot_template', 'sync_agent_from_slack_agent',
          'fill_agent_slack_install_workspace', 'guard_session_agent_id_immutable')
      order by p.proname`;
    // 1330 dropped the legacy tables' trigger functions.
    expect([...routines]).toEqual([
      { name: "guard_session_agent_id_immutable", definer: false, runtime: false },
    ]);
  });
});
