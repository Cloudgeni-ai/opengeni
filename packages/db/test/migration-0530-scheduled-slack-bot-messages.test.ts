import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  OPENGENI_SLACK_BOT_CREDENTIAL_LABEL,
  OPENGENI_SLACK_BOT_CREDENTIAL_ROLE,
  OPENGENI_SLACK_BOT_REQUIRED_SCOPES,
  OPENGENI_SLACK_BOT_SESSION_METADATA_KEY,
} from "@opengeni/contracts";
import { acquireOwnerMigratedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";
import { createDb } from "../src/database";
import { createConnection, createScheduledTask, createSession } from "../src";
import {
  prepareScheduledSlackBotMessage,
  readScheduledSlackBotMessage,
} from "../src/scheduled-slack-bot-messages";
import { LOSSLESS_CONTENT_WRITER_APPLICATION_NAME } from "../src/lossless-json";

const migration = new URL("../drizzle/0530_scheduled_slack_bot_messages.sql", import.meta.url);

test("scheduled Slack bot messages are a rolling, private relation behind two capabilities", async () => {
  const source = await readFile(migration, "utf8");
  expect(source.startsWith("-- deployment-mode: rolling\n")).toBe(true);
  expect(source).toContain("CREATE TABLE opengeni_private.scheduled_slack_bot_messages");
  expect(source).toContain("FORCE ROW LEVEL SECURITY");
  expect(source).toContain("opengeni_private.workspace_rls_visible(account_id, workspace_id)");
  expect(source).toContain("p_account IS DISTINCT FROM opengeni_private.current_account_id()");
  expect(source).toContain("p_workspace IS DISTINCT FROM opengeni_private.current_workspace_id()");
  // The destination is the task's human-chosen channel, re-read at prepare time.
  expect(source).toContain("t.agent_config->>'slackBotChannelId' = p_channel");
  expect(source).toContain("s.created_by_subject_id = 'scheduler'");
  expect(source).not.toContain("SET search_path FROM CURRENT");
  expect(
    source.match(
      /ALTER FUNCTION opengeni_private\.(?:prepare_scheduled_slack_bot_message|read_scheduled_slack_bot_message)\([^)]*\) SET search_path = pg_catalog, %I, pg_temp/g,
    ),
  ).toHaveLength(2);
  expect(source).not.toMatch(/GRANT\s+(SELECT|INSERT|UPDATE|DELETE)\b/);
});

// Reported as skipped when the real PostgreSQL fixture cannot start; the static
// test above is not a substitute for it.
const postgresTest =
  process.env.CI || process.env.OPENGENI_REQUIRE_REAL_DB === "1" || Bun.which("docker")
    ? test
    : test.skip;

postgresTest(
  "a scheduled run can prepare messages only for its task's fixed channel",
  async () => {
    const owned = await acquireOwnerMigratedTestDatabase("scheduled-slack-bot-messages");
    if (!owned) throw new Error("PostgreSQL verification requires the Docker fixture");
    let client: ReturnType<typeof createDb> | undefined;
    try {
      await migrate(owned.ownerUrl);
      await provisionRoles(owned.adminUrl, { appPassword: owned.appPassword });
      const appUrl = new URL(owned.ownerUrl);
      appUrl.username = "opengeni_app";
      appUrl.password = owned.appPassword;
      client = createDb(appUrl.toString());
      const db = client.db;
      const scope = { accountId: crypto.randomUUID(), workspaceId: crypto.randomUUID() };
      await owned.admin`INSERT INTO managed_accounts(id,name) VALUES(${scope.accountId},'Scheduled Slack')`;
      await owned.admin`INSERT INTO workspaces(id,account_id,name,settings) VALUES(${scope.workspaceId},${scope.accountId},'Scheduled Slack','{}')`;
      await owned.admin`INSERT INTO workspace_inference_controls(workspace_id,account_id) VALUES(${scope.workspaceId},${scope.accountId})`;
      const suffix = crypto.randomUUID().replaceAll("-", "").toUpperCase();
      const bot = await createConnection(db, {
        ...scope,
        subjectId: null,
        providerDomain: "slack.com",
        kind: "app_install",
        credentialEncrypted: "fixture-bot-credential",
        grantedScopes: [...OPENGENI_SLACK_BOT_REQUIRED_SCOPES],
        verifiedInstallAt: new Date(0),
        verifiedInstallVersion: 1,
        metadata: {
          credentialRole: OPENGENI_SLACK_BOT_CREDENTIAL_ROLE,
          credentialLabel: OPENGENI_SLACK_BOT_CREDENTIAL_LABEL,
          slackTeamId: `T${suffix}`,
          slackTeamName: "Scheduled Slack",
          botUserId: `U${suffix}`,
          botId: `B${suffix}`,
          botDisplayName: "OpenGeni",
          verifiedAt: new Date(0).toISOString(),
        },
        createdBySubjectId: "user:owner",
      });
      const channelId = "C0FIXED01";
      const task = await createScheduledTask(db, {
        ...scope,
        name: "Daily Slack summary",
        status: "active",
        schedule: { type: "interval", everySeconds: 3_600 },
        temporalScheduleId: `scheduled-task-${crypto.randomUUID()}`,
        runMode: "new_session_per_run",
        overlapPolicy: "skip",
        agentConfig: {
          prompt: "Post the daily summary",
          resources: [],
          tools: [],
          metadata: {},
          slackBotConnectionId: bot.id,
          slackBotChannelId: channelId,
        },
        metadata: {},
      });
      const runId = crypto.randomUUID();
      const scheduled = await createSession(db, {
        ...scope,
        initialMessage: "Post the daily summary",
        model: "test-model",
        resources: [],
        metadata: {
          scheduledTaskId: task.id,
          scheduledTaskRunId: runId,
          [OPENGENI_SLACK_BOT_SESSION_METADATA_KEY]: bot.id,
        },
        reasoningEffort: "medium",
        latencyMode: "standard",
        sandboxBackend: "none",
        createdBy: { kind: "service", subjectId: "scheduler" },
        createdByContext: {
          label: "OpenGeni scheduler",
          scheduledTaskId: task.id,
          scheduledTaskRunId: runId,
        },
      });
      const ordinary = await createSession(db, {
        ...scope,
        initialMessage: "Forged routing",
        model: "test-model",
        resources: [],
        metadata: {
          scheduledTaskId: task.id,
          scheduledTaskRunId: runId,
          [OPENGENI_SLACK_BOT_SESSION_METADATA_KEY]: bot.id,
        },
        reasoningEffort: "medium",
        latencyMode: "standard",
        sandboxBackend: "none",
        createdBy: { kind: "subject", subjectId: "user:owner" },
        createdByContext: {},
      });
      const prepare = (overrides: Partial<Parameters<typeof prepareScheduledSlackBotMessage>[1]>) =>
        prepareScheduledSlackBotMessage(db, {
          ...scope,
          sessionId: scheduled.id,
          scheduledTaskId: task.id,
          connectionId: bot.id,
          connectionVersion: bot.version,
          channelId,
          threadTimestamp: null,
          text: "Daily summary",
          ...overrides,
        });

      const prepared = await prepare({});
      expect(prepared).toMatchObject({ channelId, text: "Daily summary", connectionId: bot.id });
      expect(
        await readScheduledSlackBotMessage(db, {
          ...scope,
          sessionId: scheduled.id,
          id: prepared.id,
        }),
      ).toEqual(prepared);
      // A message is readable only from the session that prepared it.
      expect(
        await readScheduledSlackBotMessage(db, {
          ...scope,
          sessionId: ordinary.id,
          id: prepared.id,
        }),
      ).toBeNull();
      const threaded = await prepare({ threadTimestamp: "1700000000.000100" });
      expect(threaded.threadTimestamp).toBe("1700000000.000100");

      // The agent never chooses the destination: any other channel is refused.
      await expect(prepare({ channelId: "C0OTHER01" })).rejects.toThrow("destination unavailable");
      // Only the scheduler-created run of this task may post.
      await expect(prepare({ sessionId: ordinary.id })).rejects.toThrow("session unavailable");
      await expect(prepare({ scheduledTaskId: crypto.randomUUID() })).rejects.toThrow(
        "session unavailable",
      );
      // A reinstalled or changed bot credential must be resolved again.
      await expect(prepare({ connectionVersion: bot.version + 1 })).rejects.toThrow(
        "connection unavailable",
      );
      // A person changing or clearing the channel takes effect at the next post.
      await owned.admin`UPDATE scheduled_tasks
        SET agent_config = agent_config || '{"slackBotChannelId":"C0MOVED01"}'::jsonb
        WHERE id = ${task.id}`;
      await expect(prepare({})).rejects.toThrow("destination unavailable");
      expect((await prepare({ channelId: "C0MOVED01" })).channelId).toBe("C0MOVED01");
      await owned.admin`UPDATE scheduled_tasks
        SET agent_config = agent_config - 'slackBotChannelId' WHERE id = ${task.id}`;
      await expect(prepare({ channelId: "C0MOVED01" })).rejects.toThrow("destination unavailable");

      const privileges = await owned.admin`SELECT
        has_table_privilege('opengeni_app','opengeni_private.scheduled_slack_bot_messages','SELECT') AS read,
        has_table_privilege('opengeni_app','opengeni_private.scheduled_slack_bot_messages','INSERT') AS insert,
        has_table_privilege('opengeni_app','opengeni_private.scheduled_slack_bot_messages','UPDATE') AS update`;
      expect(privileges[0]).toMatchObject({ read: false, insert: false, update: false });
      const configs = await owned.admin`SELECT p.proconfig, p.prosecdef FROM pg_proc p
        JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='opengeni_private'
          AND p.proname IN ('prepare_scheduled_slack_bot_message','read_scheduled_slack_bot_message')`;
      expect(configs).toHaveLength(2);
      for (const config of configs) {
        expect(config.prosecdef).toBe(true);
        expect(config.proconfig).toContain("search_path=pg_catalog, public, pg_temp");
      }

      const raw = postgres(appUrl.toString(), {
        max: 1,
        connection: {
          application_name: LOSSLESS_CONTENT_WRITER_APPLICATION_NAME,
          statement_timeout: 30_000,
        },
      });
      try {
        // Without the caller's tenant scope the capability refuses.
        await expect(
          raw`SELECT * FROM opengeni_private.read_scheduled_slack_bot_message(${scope.accountId},${scope.workspaceId},${scheduled.id},${prepared.id})`.execute(),
        ).rejects.toMatchObject({ code: "42501" });
        await expect(
          raw`SELECT id FROM opengeni_private.scheduled_slack_bot_messages`.execute(),
        ).rejects.toMatchObject({ code: "42501" });
      } finally {
        await raw.end({ timeout: 5 });
      }
    } finally {
      await client?.close();
      await owned.release();
    }
  },
  180_000,
);
