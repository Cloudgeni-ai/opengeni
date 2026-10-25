import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing/shared-pg";
import {
  appendSessionEvents,
  bootstrapWorkspace,
  createDb,
  createScheduledTask,
  createSession,
  getSessionReplyMuteScope,
  getSessionRepliesMuted,
  listInboxItems,
  setInboxSettings,
  setSessionRepliesMuted,
  type DbClient,
} from "../src/index";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";

const MIGRATION = "0915_inbox_mute_scheduled_runs.sql";
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

setDefaultTimeout(60_000);

let owned: OwnerMigratedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  owned = await acquireOwnerMigratedTestDatabase("inbox-schedule-mutes");
  if (!owned) {
    if (requireRealDatabase) throw new Error("inbox PostgreSQL fixture is unavailable");
    return;
  }
  // As in production: the NOSUPERUSER NOBYPASSRLS owner runs the functions
  // under FORCE RLS, and the application role calls them.
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

type Person = {
  scope: { accountId: string; workspaceId: string };
  subjectId: string;
};

async function person(label: string): Promise<Person> {
  const subjectId = `user:${crypto.randomUUID()}`;
  const access = await bootstrapWorkspace(db(), {
    accountExternalSource: "migration-0915",
    accountExternalId: `account:${label}:${crypto.randomUUID()}`,
    accountName: `Schedule mutes ${label}`,
    workspaceExternalSource: "migration-0915",
    workspaceExternalId: `workspace:${label}:${crypto.randomUUID()}`,
    workspaceName: `Schedule mutes ${label}`,
    subjectId,
  });
  const grant = access.workspaceGrants[0]!;
  const owner = { accountId: grant.accountId, subjectId };
  await setInboxSettings(db(), { ...owner, replies: true });
  return { scope: { accountId: grant.accountId, workspaceId: grant.workspaceId! }, subjectId };
}

type RunMode = "new_session_per_run" | "existing_session" | "reusable_session";

async function schedule(owner: Person, runMode: RunMode, targetSessionId?: string) {
  return await createScheduledTask(db(), {
    ...owner.scope,
    name: `Every five minutes (${runMode})`,
    status: "active",
    schedule: { type: "manual" },
    temporalScheduleId: `schedule-mutes-${crypto.randomUUID()}`,
    runMode,
    overlapPolicy: "allow_concurrent",
    agentConfig: { prompt: "Take a snapshot", resources: [], tools: [], metadata: {} },
    createdBy: { kind: "subject", subjectId: owner.subjectId },
    ...(targetSessionId ? { targetSessionId } : {}),
    metadata: {},
  });
}

/** A session the scheduler starts, so it works for the schedule's owner. */
async function schedulerSession(owner: Person, label: string) {
  return await createSession(db(), {
    ...owner.scope,
    initialMessage: `run ${label}`,
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none",
    createdBy: { kind: "service", subjectId: "scheduler" },
    createdByContext: { label: "Scheduler" },
  });
}

/** Seed only the run's link from schedule to session; its execution is not under test. */
async function recordRun(owner: Person, taskId: string, sessionId: string) {
  await owned!.admin.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`
      insert into scheduled_task_runs (task_id, account_id, workspace_id, session_id, status, trigger_type)
      values (${taskId}, ${owner.scope.accountId}, ${owner.scope.workspaceId}, ${sessionId},
        'succeeded', 'scheduled')`;
  });
}

/** One run of the schedule: a new session started for it. */
async function run(owner: Person, taskId: string, label: string) {
  const session = await schedulerSession(owner, label);
  await recordRun(owner, taskId, session.id);
  return session;
}

let position = 0;
/** The agent finishes a turn in this session with a reply. */
async function reply(owner: Person, sessionId: string, text: string) {
  const turnId = crypto.randomUUID();
  position += 1;
  await owned!.admin.begin(async (tx) => {
    await tx`select set_config('opengeni.session_inference_claim', '1', true)`;
    await tx`select set_config('opengeni.session_variable_set_attachments_v1', '1', true)`;
    await tx`select set_config('opengeni.account_id', ${owner.scope.accountId}, true)`;
    await tx`select set_config('opengeni.workspace_id', ${owner.scope.workspaceId}, true)`;
    await tx`
      insert into session_turns (
        id, account_id, workspace_id, session_id, trigger_event_id,
        temporal_workflow_id, status, source, position, prompt, model,
        reasoning_effort, sandbox_backend, execution_generation,
        initiator_kind, initiator_subject_id, initiator_context
      ) values (
        ${turnId}, ${owner.scope.accountId}, ${owner.scope.workspaceId},
        ${sessionId}, ${crypto.randomUUID()}, ${`schedule-mute-${turnId}`},
        'queued', 'user', ${position}, 'work', 'test-model', 'medium', 'none', 1,
        'service', 'scheduler', '{}'::jsonb
      )`;
  });
  await appendSessionEvents(db(), owner.scope.workspaceId, sessionId, [
    { type: "agent.message.completed" as const, turnId, payload: { text } },
    { type: "turn.completed", turnId, payload: {} },
  ]);
  await owned!.admin.begin(async (tx) => {
    await tx`select set_config('opengeni.session_inference_claim', '1', true)`;
    await tx`select set_config('opengeni.account_id', ${owner.scope.accountId}, true)`;
    await tx`select set_config('opengeni.workspace_id', ${owner.scope.workspaceId}, true)`;
    await tx`update session_turns set status = 'completed' where id = ${turnId}`;
  });
}

async function replies(owner: Person) {
  const items = await listInboxItems(db(), {
    accountId: owner.scope.accountId,
    subjectId: owner.subjectId,
  });
  return items.filter((item) => item.kind === "reply").map((item) => item.title);
}

const muteOf = (owner: Person, sessionId: string) => ({
  workspaceId: owner.scope.workspaceId,
  sessionId,
  subjectId: owner.subjectId,
});

describe("0915 muting a schedule's replies", () => {
  test("is a rolling migration that keeps every signature", async () => {
    const text = await readFile(new URL(`../drizzle/${MIGRATION}`, import.meta.url), "utf8");
    expect(text.startsWith("-- deployment-mode: rolling\n")).toBe(true);
    expect(text).not.toMatch(/DROP FUNCTION/i);
  });

  test("muting one run of a new-session-per-run schedule mutes all its runs", async () => {
    if (!client) return;
    const owner = await person("per-run");
    const task = await schedule(owner, "new_session_per_run");
    const first = await run(owner, task.id, "first");
    const second = await run(owner, task.id, "second");
    await reply(owner, second.id, "Second run's snapshot");
    expect(await replies(owner)).toEqual(["Second run's snapshot"]);
    expect(
      await getSessionReplyMuteScope(db(), {
        workspaceId: owner.scope.workspaceId,
        sessionId: first.id,
      }),
    ).toBe("schedule");

    // Muting the first run takes the second run's reply away too.
    expect(await setSessionRepliesMuted(db(), { ...muteOf(owner, first.id), muted: true })).toBe(
      true,
    );
    expect(await replies(owner)).toEqual([]);
    expect(await getSessionRepliesMuted(db(), muteOf(owner, second.id))).toBe(true);

    // A run started after the mute stays muted: its replies never arrive.
    const later = await run(owner, task.id, "later");
    expect(await getSessionRepliesMuted(db(), muteOf(owner, later.id))).toBe(true);
    await reply(owner, later.id, "Later run's snapshot");
    expect(await replies(owner)).toEqual([]);

    // Another person's mute changes nothing for the owner's other schedules.
    const other = await schedule(owner, "new_session_per_run");
    const otherRun = await run(owner, other.id, "other");
    expect(await getSessionRepliesMuted(db(), muteOf(owner, otherRun.id))).toBe(false);
    await reply(owner, otherRun.id, "Other schedule's snapshot");
    expect(await replies(owner)).toEqual(["Other schedule's snapshot"]);

    // Unmuting from any run brings the schedule's replies back.
    expect(await setSessionRepliesMuted(db(), { ...muteOf(owner, later.id), muted: false })).toBe(
      false,
    );
    expect(await getSessionRepliesMuted(db(), muteOf(owner, first.id))).toBe(false);
    const afterUnmute = await run(owner, task.id, "after-unmute");
    await reply(owner, afterUnmute.id, "Back again");
    expect((await replies(owner)).sort()).toEqual(["Back again", "Other schedule's snapshot"]);
  });

  test("a schedule that reuses or targets one session keeps the one-session mute", async () => {
    if (!client) return;
    const owner = await person("reused");
    const target = await schedulerSession(owner, "target");
    const existing = await schedule(owner, "existing_session", target.id);
    await recordRun(owner, existing.id, target.id);
    expect(
      await getSessionReplyMuteScope(db(), {
        workspaceId: owner.scope.workspaceId,
        sessionId: target.id,
      }),
    ).toBe("session");

    const reusable = await schedule(owner, "reusable_session");
    const reused = await run(owner, reusable.id, "reused");
    expect(
      await getSessionReplyMuteScope(db(), {
        workspaceId: owner.scope.workspaceId,
        sessionId: reused.id,
      }),
    ).toBe("session");
    await setSessionRepliesMuted(db(), { ...muteOf(owner, reused.id), muted: true });
    // A different session from the same schedule is not muted by it.
    const sibling = await run(owner, reusable.id, "sibling");
    expect(await getSessionRepliesMuted(db(), muteOf(owner, sibling.id))).toBe(false);
    await reply(owner, sibling.id, "Sibling reply");
    expect(await replies(owner)).toEqual(["Sibling reply"]);
    const stored = await owned!.admin<{ scheduled_task_id: string | null }[]>`
      select scheduled_task_id from opengeni_private.inbox_session_mutes
      where session_id = ${reused.id}`;
    expect(stored.map((row) => row.scheduled_task_id)).toEqual([null]);
  });

  test("mutes recorded before the migration are carried over to their schedule", async () => {
    if (!client) return;
    const owner = await person("backfill");
    const task = await schedule(owner, "new_session_per_run");
    const muted = await run(owner, task.id, "muted-before");
    // As the previous release stored it: one session, no schedule.
    await owned!.admin`
      insert into opengeni_private.inbox_session_mutes (account_id, workspace_id, session_id, subject_id)
      values (${owner.scope.accountId}, ${owner.scope.workspaceId}, ${muted.id}, ${owner.subjectId})`;
    const next = await run(owner, task.id, "next");
    expect(await getSessionRepliesMuted(db(), muteOf(owner, next.id))).toBe(false);

    const text = await readFile(new URL(`../drizzle/${MIGRATION}`, import.meta.url), "utf8");
    const backfill = text.match(
      /DO \$inbox_schedule_mute_backfill\$[\s\S]*?END \$inbox_schedule_mute_backfill\$;/,
    )?.[0];
    expect(backfill).toBeDefined();
    // As migrate() applies it: the RLS-bound owner, with migrate's preamble.
    const ownerSql = postgres(owned!.ownerUrl, { max: 1 });
    try {
      await ownerSql.begin(async (tx) => {
        await tx`select pg_catalog.set_config('opengeni.session_variable_set_attachments_v1', '1', true)`;
        await tx.unsafe(backfill!);
      });
    } finally {
      await ownerSql.end();
    }

    expect(await getSessionRepliesMuted(db(), muteOf(owner, next.id))).toBe(true);
    await reply(owner, next.id, "Should stay quiet");
    expect(await replies(owner)).toEqual([]);
  });
});
