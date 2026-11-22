import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  bootstrapWorkspace,
  createAgent,
  createDb,
  createScheduledTask,
  createSession,
  getScheduledTask,
  listScheduledTaskRuns,
  updateScheduledTask,
  type DbClient,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { createScheduledTaskActivities } from "../src/activities/scheduled-tasks";
import type { ActivityServices } from "../src/activities/types";

// An agent's automation run by the dispatch (real PostgreSQL): its own chat is
// started with the agent and kept, a changed agent gets a new chat with the
// new agent, and an existing chat with the agent receives the runs.

let available = true;
let shared: SharedTestDatabase | null = null;
let client: DbClient;
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("worker-scheduled-agent-chat");
  if (!shared) {
    if (requireRealDatabase) throw new Error("agent automation chat tests require PostgreSQL");
    available = false;
    console.warn("[worker-scheduled-agent-chat] PostgreSQL unavailable, skipping");
    return;
  }
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
});

function scheduledActivities() {
  const settings = testSettings({ databaseUrl: shared!.appUrl, sandboxBackend: "none" });
  return createScheduledTaskActivities(
    async () =>
      ({
        settings,
        db: client.db,
        bus: new MemoryEventBus(),
        wakeSessionWorkflow: async () => undefined,
      }) as unknown as ActivityServices,
  );
}

async function fixture() {
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `scheduled-agent-chat-account-${crypto.randomUUID()}`,
    accountName: "Agent automation chat account",
    workspaceExternalSource: "test",
    workspaceExternalId: `scheduled-agent-chat-workspace-${crypto.randomUUID()}`,
    workspaceName: "Agent automation chat workspace",
    subjectId: "user:scheduled-agent-chat-owner",
  });
  const grant = access.workspaceGrants[0]!;
  const [personal] = await shared!.admin`insert into workspaces (account_id, name)
    values (${grant.accountId}, 'Personal agent chat fixture') returning id`;
  await shared!.admin`insert into organization_memberships
    (account_id, subject_id, status, personal_workspace_id)
    values (${grant.accountId}, ${grant.subjectId}, 'active', ${personal!.id})`;
  const scope = { accountId: grant.accountId, workspaceId: grant.workspaceId };
  const agent = async (name: string) =>
    (
      await createAgent(client.db, scope, {
        visibility: "workspace",
        ownerSubjectId: null,
        name,
        description: "",
        avatar: { kind: "emoji", emoji: "🛠️", hue: 30 },
        instructions: `You are ${name}.`,
        memoryEnabled: false,
        origin: "app",
        sourceSessionId: null,
        createdBySubjectId: grant.subjectId,
        maxPerWorkspace: 500,
      })
    ).agent.id;
  const agentConfig = (agentId: string) => ({
    agentId,
    prompt: "Plan the day",
    resources: [],
    tools: [],
    metadata: {},
    sandboxBackend: "none" as const,
  });
  const dispatch = async (taskId: string) => {
    const result = await scheduledActivities().dispatchScheduledTaskRun({
      workspaceId: grant.workspaceId,
      taskId,
      triggerType: "scheduled",
      producerKey: `scheduled-agent-chat-${crypto.randomUUID()}`,
    });
    if (result.action !== "start" && result.action !== "signal") {
      const [run] = await listScheduledTaskRuns(client.db, grant.workspaceId, taskId, 1);
      throw new Error(
        `unexpected dispatch: ${JSON.stringify(result)}; run ${run?.status} ${run?.error}`,
      );
    }
    return result;
  };
  const chatAgent = async (sessionId: string) => {
    const [row] = await shared!.admin<{ agent_id: string | null }[]>`
      select agent_id from sessions where id = ${sessionId}`;
    return row?.agent_id ?? null;
  };
  const task = async (taskId: string) =>
    (await getScheduledTask(client.db, grant.workspaceId, taskId))!;
  return { grant, agent, agentConfig, dispatch, chatAgent, task };
}

describe("an agent's automation chat, run by the dispatch (real PostgreSQL)", () => {
  test("its own chat is started with the agent, kept, and replaced with the new agent", async () => {
    if (!available) return;
    const f = await fixture();
    const planner = await f.agent("Planner");
    const reviewer = await f.agent("Reviewer");
    const created = await createScheduledTask(client.db, {
      accountId: f.grant.accountId,
      workspaceId: f.grant.workspaceId,
      createdBy: { kind: "subject", subjectId: f.grant.subjectId },
      name: "Daily plan",
      status: "active",
      schedule: { type: "manual" },
      temporalScheduleId: `scheduled-agent-chat-${crypto.randomUUID()}`,
      runMode: "reusable_session",
      overlapPolicy: "allow_concurrent",
      agentConfig: f.agentConfig(planner),
      metadata: {},
    });

    // The first run starts the automation's chat with Planner and keeps it.
    const first = await f.dispatch(created.id);
    expect(first.action).toBe("start");
    expect(await f.chatAgent(first.sessionId)).toBe(planner);
    expect((await f.task(created.id)).reusableSessionId).toBe(first.sessionId);

    // The next run goes to the same chat.
    const second = await f.dispatch(created.id);
    expect(second).toMatchObject({ action: "signal", sessionId: first.sessionId });

    // A new agent clears the chat, as saving the change does; the next run
    // starts one with Reviewer and keeps that, leaving Planner's chat as it was.
    const current = await f.task(created.id);
    await updateScheduledTask(client.db, f.grant.workspaceId, created.id, {
      agentConfig: { ...current.agentConfig, agentId: reviewer },
      reusableSessionId: null,
    });
    const third = await f.dispatch(created.id);
    expect(third.action).toBe("start");
    expect(third.sessionId).not.toBe(first.sessionId);
    expect(await f.chatAgent(third.sessionId)).toBe(reviewer);
    expect(await f.chatAgent(first.sessionId)).toBe(planner);
    expect((await f.task(created.id)).reusableSessionId).toBe(third.sessionId);
    const fourth = await f.dispatch(created.id);
    expect(fourth).toMatchObject({ action: "signal", sessionId: third.sessionId });
  }, 120_000);

  test("an existing chat with the agent receives every run", async () => {
    if (!available) return;
    const f = await fixture();
    const planner = await f.agent("Planner");
    const target = await createSession(client.db, {
      accountId: f.grant.accountId,
      workspaceId: f.grant.workspaceId,
      initialMessage: "Work with Planner",
      resources: [],
      tools: [],
      metadata: {},
      createdBy: { kind: "subject", subjectId: f.grant.subjectId },
      subjectId: f.grant.subjectId,
      model: testSettings().openaiModel,
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      agent: { id: planner, subjectId: f.grant.subjectId },
    });
    expect(await f.chatAgent(target.id)).toBe(planner);
    const created = await createScheduledTask(client.db, {
      accountId: f.grant.accountId,
      workspaceId: f.grant.workspaceId,
      createdBy: { kind: "subject", subjectId: f.grant.subjectId },
      name: "Morning check-in",
      status: "active",
      schedule: { type: "manual" },
      temporalScheduleId: `scheduled-agent-chat-${crypto.randomUUID()}`,
      runMode: "existing_session",
      targetSessionId: target.id,
      overlapPolicy: "allow_concurrent",
      agentConfig: f.agentConfig(planner),
      metadata: {},
    });
    for (let index = 0; index < 2; index += 1) {
      const run = await f.dispatch(created.id);
      expect(run).toMatchObject({ action: "signal", sessionId: target.id });
    }
    expect(await f.chatAgent(target.id)).toBe(planner);
    const runs = await listScheduledTaskRuns(client.db, f.grant.workspaceId, created.id, 10);
    expect(runs.map((run) => run.sessionId)).toEqual([target.id, target.id]);
  }, 120_000);
});
