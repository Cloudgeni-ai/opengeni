import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireBlankTestDatabase,
  acquireSharedTestDatabase,
  type BlankTestDatabase,
  type SharedTestDatabase,
} from "@opengeni/testing/shared-pg";
import type { McpConnectionAccountBinding } from "@opengeni/contracts";
import postgres from "postgres";
import {
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  submitHumanPromptInTransaction,
  upsertConnectorActionPolicy,
  withWorkspaceSubjectSessionActivityRls,
  type DbClient,
} from "../src";
import { migrate } from "../src/migrate";

// A personal login's tool choices belong to the login and follow it between
// workspaces (docs/design/ownership-and-reach.md, rule 10). They are kept in
// the workspace the login was connected from, and a turn in another workspace
// starts with them.

const MIGRATION = "1145_personal_login_choices_follow_the_login.sql";

let shared: SharedTestDatabase | null = null;
let client: DbClient;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("connector-choices-follow-login");
  if (!shared) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") throw new Error("PostgreSQL required");
    return;
  }
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
});

type Fixture = {
  accountId: string;
  originId: string;
  sharedId: string;
  alice: string;
  aliceLogin: string;
  bobLogin: string;
  workspaceLogin: string;
};

async function fixture(sql: postgres.Sql): Promise<Fixture> {
  const [account] =
    await sql`insert into managed_accounts (name) values ('choices follow the login') returning id`;
  const accountId = account!.id as string;
  const [origin] =
    await sql`insert into workspaces (account_id, name) values (${accountId}, 'origin') returning id`;
  const [sharedWorkspace] =
    await sql`insert into workspaces (account_id, name) values (${accountId}, 'shared') returning id`;
  const alice = `user:${crypto.randomUUID()}`;
  const bob = `user:${crypto.randomUUID()}`;
  const logins: string[] = [];
  for (const subject of [alice, bob]) {
    const [personal] =
      await sql`insert into workspaces (account_id, name) values (${accountId}, 'personal') returning id`;
    await sql`insert into organization_memberships (account_id, subject_id, status, personal_workspace_id)
      values (${accountId}, ${subject}, 'active', ${personal!.id})`;
    await sql`insert into workspace_memberships (account_id, workspace_id, subject_id)
      values (${accountId}, ${sharedWorkspace!.id}, ${subject})`;
    logins.push(
      await sql.begin(async (tx) => {
        await tx`select set_config('opengeni.account_id', ${accountId}, true),
          set_config('opengeni.workspace_id', ${origin!.id}, true),
          set_config('opengeni.subject_id', ${subject}, true)`;
        const [connection] = await tx`insert into connections
          (account_id, workspace_id, subject_id, provider_domain, kind, credential_encrypted)
          values (${accountId}, ${origin!.id}, ${subject}, 'mail.example.test', 'oauth2', 'fixture-ciphertext')
          returning id`;
        return connection!.id as string;
      }),
    );
  }
  await sql`insert into workspace_inference_controls (account_id, workspace_id)
    values (${accountId}, ${sharedWorkspace!.id})`;
  const [workspaceConnection] = await sql`insert into connections
    (account_id, workspace_id, provider_domain, kind, credential_encrypted)
    values (${accountId}, ${sharedWorkspace!.id}, 'files.example.test', 'oauth2', 'fixture-ciphertext')
    returning id`;
  return {
    accountId,
    originId: origin!.id as string,
    sharedId: sharedWorkspace!.id as string,
    alice,
    aliceLogin: logins[0]!,
    bobLogin: logins[1]!,
    workspaceLogin: workspaceConnection!.id as string,
  };
}

function personalBinding(f: Fixture): McpConnectionAccountBinding {
  return {
    serverId: "mail",
    canonicalServerId: "mail",
    connectionId: f.aliceLogin,
    originWorkspaceId: f.originId,
    subjectScope: "subject",
    ownerSubjectId: f.alice,
    accountLabel: "alice@mail.example.test",
    providerDomain: "mail.example.test",
    kind: "oauth2",
    connectionRef: {
      connectionId: f.aliceLogin,
      providerDomain: "mail.example.test",
      subjectScope: "subject",
      kind: "oauth2",
    },
  };
}

async function claimAliceTurn(f: Fixture, bindings: McpConnectionAccountBinding[]) {
  const session = await createSession(client.db, {
    accountId: f.accountId,
    workspaceId: f.sharedId,
    subjectId: f.alice,
    createdBy: { kind: "subject", subjectId: f.alice },
    initialMessage: "",
    resources: [],
    tools: [],
    metadata: {},
    model: "test-model",
    reasoningEffort: "low",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  await withWorkspaceSubjectSessionActivityRls(client.db, f.sharedId, f.alice, (tx) =>
    submitHumanPromptInTransaction(tx, {
      accountId: f.accountId,
      workspaceId: f.sharedId,
      sessionId: session.id,
      subjectId: f.alice,
      actor: { type: "human", subjectId: f.alice },
      operationKey: crypto.randomUUID(),
      delivery: "send",
      text: "Send the summary from my mail",
      resources: [],
      model: "test-model",
      reasoningEffort: "low",
      reasoningEffortFallback: "low",
      source: "user",
      personalConnectionDelegations: [
        {
          serverId: "mail",
          connectionId: f.aliceLogin,
          originWorkspaceId: f.originId,
          ownerSubjectId: f.alice,
          providerDomain: "mail.example.test",
          kind: "oauth2",
          connectionType: "mcp",
        },
      ],
      mcpAccountBindings: bindings,
    }),
  );
  const attemptId = crypto.randomUUID();
  const claim = await claimSessionWorkForAttempt(client.db, f.sharedId, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  if (claim.action !== "claimed") throw new Error("The turn was not claimed");
  const [attempt] = await shared!.admin<{ policies: unknown }[]>`
    select connector_action_policies as policies from session_turn_attempts where id = ${attemptId}`;
  return attempt!.policies as Array<{ connectionId: string; toolName: string; policy: string }>;
}

function choice(
  f: Fixture,
  workspaceId: string,
  connectionId: string,
  toolName: string,
  policy: "allow" | "ask" | "block",
) {
  return upsertConnectorActionPolicy(client.db, {
    accountId: f.accountId,
    workspaceId,
    subjectId: f.alice,
    connectionId,
    serverId: "mail",
    toolName,
    actionName: "*",
    policy,
  });
}

describe("a personal login's tool choices follow the login", () => {
  test("a turn in another workspace starts with the login's own choices", async () => {
    if (!shared) return;
    const f = await fixture(shared.admin);
    await choice(f, f.originId, f.aliceLogin, "send", "allow");
    // A copy left in the shared workspace by the previous release is ignored.
    await choice(f, f.sharedId, f.aliceLogin, "send", "block");
    // Another person's login in the same workspace never comes along.
    await choice(f, f.originId, f.bobLogin, "send", "block");
    // The shared workspace's own login keeps the shared workspace's choices.
    await choice(f, f.sharedId, f.workspaceLogin, "read", "ask");

    const policies = await claimAliceTurn(f, [personalBinding(f)]);
    expect(
      policies.map(({ connectionId, toolName, policy }) => ({ connectionId, toolName, policy })),
    ).toEqual([
      { connectionId: f.workspaceLogin, toolName: "read", policy: "ask" },
      { connectionId: f.aliceLogin, toolName: "send", policy: "allow" },
    ]);
  });

  test("without the login on the turn, its choices stay home", async () => {
    if (!shared) return;
    const f = await fixture(shared.admin);
    await choice(f, f.originId, f.aliceLogin, "send", "allow");
    const policies = await claimAliceTurn(f, []);
    expect(policies).toEqual([]);
  });

  test("a login whose choices don't fit the snapshot is left out whole", async () => {
    if (!shared) return;
    const f = await fixture(shared.admin);
    await choice(f, f.originId, f.aliceLogin, "*", "allow");
    await choice(f, f.originId, f.aliceLogin, "send", "ask");
    // 2047 workspace choices leave room for one more row, not the login's two.
    await shared.admin`
      insert into connector_action_policies
        (account_id, workspace_id, connection_id, server_id, tool_name, action_name, policy,
         created_by_subject_id, updated_by_subject_id)
      select ${f.accountId}, ${f.sharedId}, ${f.workspaceLogin}, 'files', 'tool-' || n, '*', 'ask',
        ${f.alice}, ${f.alice}
      from generate_series(1, 2047) n`;
    const policies = await claimAliceTurn(f, [personalBinding(f)]);
    expect(policies).toHaveLength(2047);
    expect(policies.some((row) => row.connectionId === f.aliceLogin)).toBe(false);
  });
});

describe("migration 1145 merges a personal login's choices into its own workspace", () => {
  let blank: BlankTestDatabase | null = null;
  let migrations: string | null = null;
  let admin: postgres.Sql | null = null;

  beforeAll(async () => {
    if (!shared) return;
    blank = await acquireBlankTestDatabase("connector-choices-follow-login-migration");
    if (!blank) throw new Error("PostgreSQL test database unavailable");
    const shipped = new URL("../drizzle/", import.meta.url).pathname;
    migrations = await mkdtemp(join(tmpdir(), "connector-choices-follow-login-"));
    for (const file of await readdir(shipped)) {
      if (file.endsWith(".sql") && file < MIGRATION) {
        await symlink(join(shipped, file), join(migrations, file));
      }
    }
    await migrate(blank.databaseUrl, undefined, { migrationsDirectory: migrations });
    admin = postgres(blank.databaseUrl, { max: 1, onnotice: () => undefined });
  }, 900_000);

  afterAll(async () => {
    await admin?.end({ timeout: 5 });
    await blank?.release();
    if (migrations) await rm(migrations, { recursive: true, force: true });
  }, 180_000);

  test("the strictest copy wins, workspace logins are untouched", async () => {
    if (!shared || !admin || !migrations) return;
    const sql = admin;
    const [account] =
      await sql`insert into managed_accounts (name) values ('migration 1145') returning id`;
    const accountId = account!.id as string;
    const [home] =
      await sql`insert into workspaces (account_id, name) values (${accountId}, 'home') returning id`;
    const [other] =
      await sql`insert into workspaces (account_id, name) values (${accountId}, 'other') returning id`;
    const [third] =
      await sql`insert into workspaces (account_id, name) values (${accountId}, 'third') returning id`;
    const person = `user:${crypto.randomUUID()}`;
    const [login] = await sql.begin(async (tx) => {
      await tx`select set_config('opengeni.account_id', ${accountId}, true),
        set_config('opengeni.workspace_id', ${home!.id}, true),
        set_config('opengeni.subject_id', ${person}, true)`;
      return await tx`insert into connections
        (account_id, workspace_id, subject_id, provider_domain, kind, credential_encrypted)
        values (${accountId}, ${home!.id}, ${person}, 'mail.example.test', 'oauth2', 'fixture-ciphertext')
        returning id`;
    });
    const [workspaceLogin] = await sql`insert into connections
      (account_id, workspace_id, provider_domain, kind, credential_encrypted)
      values (${accountId}, ${other!.id}, 'mail.example.test', 'oauth2', 'fixture-ciphertext')
      returning id`;
    const row = async (
      workspaceId: string,
      connectionId: string,
      toolName: string,
      policy: string,
      updatedAt: string,
    ) => {
      await sql`insert into connector_action_policies
        (account_id, workspace_id, connection_id, server_id, tool_name, action_name, policy,
         created_by_subject_id, updated_by_subject_id, updated_at)
        values (${accountId}, ${workspaceId}, ${connectionId}, 'mail', ${toolName}, '*', ${policy},
          ${person}, ${person}, ${updatedAt}::timestamptz)`;
    };
    const loginId = login!.id as string;
    const workspaceLoginId = workspaceLogin!.id as string;
    // Home has Allow; elsewhere Block: home becomes Block, with a new version.
    await row(home!.id, loginId, "delete", "allow", "2026-10-20T00:00:00Z");
    await row(other!.id, loginId, "delete", "block", "2026-10-01T00:00:00Z");
    // Not at home; Allow (newer) and Ask (older) elsewhere: Ask moves home.
    await row(other!.id, loginId, "send", "allow", "2026-10-25T00:00:00Z");
    await row(third!.id, loginId, "send", "ask", "2026-10-02T00:00:00Z");
    // Only elsewhere: moves home unchanged.
    await row(third!.id, loginId, "draft", "allow", "2026-10-03T00:00:00Z");
    // Home only: untouched.
    await row(home!.id, loginId, "read", "allow", "2026-10-04T00:00:00Z");
    // A workspace login's choice stays in its workspace.
    await row(other!.id, workspaceLoginId, "send", "allow", "2026-10-05T00:00:00Z");

    const shipped = new URL("../drizzle/", import.meta.url).pathname;
    await symlink(join(shipped, MIGRATION), join(migrations, MIGRATION));
    await migrate(blank!.databaseUrl, undefined, { migrationsDirectory: migrations });

    const after = await sql<
      {
        workspace_id: string;
        connection_id: string;
        tool_name: string;
        policy: string;
        version: number;
      }[]
    >`select workspace_id, connection_id, tool_name, policy, version
      from connector_action_policies where account_id = ${accountId}
      order by connection_id = ${workspaceLoginId}, tool_name`;
    expect([...after]).toEqual([
      {
        workspace_id: home!.id,
        connection_id: loginId,
        tool_name: "delete",
        policy: "block",
        version: 2,
      },
      {
        workspace_id: home!.id,
        connection_id: loginId,
        tool_name: "draft",
        policy: "allow",
        version: 2,
      },
      {
        workspace_id: home!.id,
        connection_id: loginId,
        tool_name: "read",
        policy: "allow",
        version: 1,
      },
      {
        workspace_id: home!.id,
        connection_id: loginId,
        tool_name: "send",
        policy: "ask",
        version: 2,
      },
      {
        workspace_id: other!.id,
        connection_id: workspaceLoginId,
        tool_name: "send",
        policy: "allow",
        version: 1,
      },
    ]);
  }, 180_000);
});
