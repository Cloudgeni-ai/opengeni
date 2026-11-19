// The publish "move running chats" activities against real PostgreSQL: chats
// are moved in batches per workspace, busy chats are deferred and moved by a
// later scan, counts land on the publish operation, and a newer publish stops
// the move.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import { createObservability } from "@opengeni/observability";
import {
  applySessionTurnSettlement,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  submitHumanPromptInTransaction,
  withWorkspaceSubjectSessionActivityRls,
} from "@opengeni/db";
import {
  createOrgAgentPublishMoveActivities,
  type OrgAgentPublishMoveCursor,
} from "../src/activities/org-agent-publish-move";
import type { ControlActivityServices } from "../src/activities/types";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const db = await acquireSharedTestDatabase("org-agent-publish-move");
  if (!db) throw new Error("test postgres unavailable");
  shared = db;
  client = createDb(db.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

const settings = testSettings();
const observability = createObservability(settings, { component: "worker-test" });

async function fixture() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: suffix,
    accountName: "org agents",
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: "org agents",
    subjectId: `subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const accountId = grant.accountId;
  const workspaceId = grant.workspaceId!;
  const subjectId = grant.subjectId;
  await shared.admin`insert into organization_managed_workspaces (account_id, workspace_id, source)
    values (${accountId}, ${workspaceId}, 'console')`;
  await shared.admin`insert into organization_tool_servers (account_id, server_key, name, url, auth_mode)
    values (${accountId}, 'crm', 'CRM', 'https://crm.example.com/mcp', 'none')`;
  const agentId = crypto.randomUUID();
  await shared.admin`insert into agents (id, account_id, workspace_id, scope, visibility, name,
      name_key, origin, current_revision, agent_key, managed_by, published_revision)
    values (${agentId}, ${accountId}, null, 'organization', 'workspace', 'Support', 'support', 'app',
      2, 'support', 'console', 2)`;
  const configs = [
    { toolServers: [{ server: "crm", tools: { enabled: ["lookup"] } }] },
    { toolServers: [{ server: "crm", tools: { enabled: ["lookup", "export"] } }] },
  ];
  for (const [index, config] of configs.entries()) {
    await shared.admin`insert into agent_revisions (agent_id, account_id, workspace_id, revision,
        name, instructions, config, tool_catalog, source, config_hash)
      values (${agentId}, ${accountId}, null, ${index + 1}, 'Support', ${`v${index + 1}`},
        ${JSON.stringify(config)}::text::jsonb, '{}'::jsonb, 'console',
        ${`sha256:${createHash("sha256").update(`${agentId}:${index}`).digest("hex")}`})`;
  }
  const chat = (version: number) =>
    createSession(client.db, {
      accountId,
      workspaceId,
      initialMessage: "",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "low",
      latencyMode: "standard",
      sandboxBackend: "none",
      tools: [{ kind: "mcp", id: "crm" }],
      mcpServers: [
        {
          id: "crm",
          name: "CRM",
          url: "https://crm.example.com/mcp",
          allowedTools: version === 1 ? ["lookup"] : ["lookup", "export"],
        },
      ],
      orgAgent: { agentId, version, promptVersion: version, overrides: null },
    });
  async function claim(sessionId: string) {
    await withWorkspaceSubjectSessionActivityRls(client.db, workspaceId, subjectId, (db) =>
      submitHumanPromptInTransaction(db, {
        accountId,
        workspaceId,
        sessionId,
        subjectId,
        actor: { type: "human", subjectId },
        operationKey: crypto.randomUUID(),
        delivery: "send",
        text: "work",
        resources: [],
        reasoningEffort: "low",
        reasoningEffortFallback: "low",
        source: "user",
      }),
    );
    const result = await claimSessionWorkForAttempt(client.db, workspaceId, {
      sessionId,
      workflowId: `session-${sessionId}`,
      workflowRunId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
      agentInstructionsProtocol: 1,
      orgAgentProtocol: 1,
    });
    if (result.action !== "claimed") throw new Error(`not claimed: ${result.action}`);
    const turn = result.turn;
    return () =>
      applySessionTurnSettlement(client.db, workspaceId, {
        sessionId,
        turnId: turn.id,
        triggerEventId: turn.triggerEventId,
        attemptId: turn.activeAttemptId!,
        turnStatus: "completed",
        sessionStatus: "idle",
        activeTurnId: null,
        events: [{ type: "turn.completed", payload: {} }],
      });
  }
  const [operation] = await shared.admin<{ id: string }[]>`
    insert into agent_publish_operations (account_id, agent_id, from_revision, to_revision,
      move_running_chats)
    values (${accountId}, ${agentId}, 1, 2, true) returning id::text`;
  const versionOf = async (sessionId: string) =>
    Number(
      (
        await shared.admin<{ agent_version: number }[]>`
          select agent_version from sessions where id = ${sessionId}`
      )[0]!.agent_version,
    );
  const operationRow = async () =>
    (
      await shared.admin<
        { status: string; moved_count: number; failed_count: number; finished_at: Date | null }[]
      >`select status, moved_count, failed_count, finished_at from agent_publish_operations
        where id = ${operation!.id}`
    )[0]!;
  return {
    accountId,
    workspaceId,
    agentId,
    operationId: operation!.id,
    chat,
    claim,
    versionOf,
    operationRow,
  };
}

describe("publish move activities", () => {
  test("batches, deferral, a later scan, counts and finish", async () => {
    const f = await fixture();
    const idle = [await f.chat(1), await f.chat(1), await f.chat(1)];
    const busy = await f.chat(1);
    const current = await f.chat(2);
    const settleBusy = await f.claim(busy.id);
    const activities = createOrgAgentPublishMoveActivities(
      async () => ({ db: client.db, bus: null, observability }) as unknown as ControlActivityServices,
      { batchSize: 2 },
    );
    const input = { accountId: f.accountId, agentId: f.agentId, operationId: f.operationId };
    expect(await activities.beginOrgAgentPublishMove(input)).toEqual({
      proceed: true,
      toVersion: 2,
      moveRunningChats: true,
    });
    expect((await f.operationRow()).status).toBe("running");

    async function scan() {
      let cursor: OrgAgentPublishMoveCursor = { workspaceIndex: 0, afterSessionId: null };
      const totals = { batches: 0, moved: 0, deferred: 0, failed: 0, superseded: false };
      for (;;) {
        const batch = await activities.moveOrgAgentChatsBatch({ ...input, toVersion: 2, cursor });
        totals.batches += 1;
        totals.moved += batch.moved;
        totals.deferred += batch.deferred;
        totals.failed += batch.failed;
        totals.superseded ||= batch.superseded;
        cursor = batch.cursor;
        if (batch.done) return totals;
      }
    }
    // Four chats on version 1 in batches of two; the busy one waits.
    expect(await scan()).toEqual({ batches: 3, moved: 3, deferred: 1, failed: 0, superseded: false });
    for (const session of idle) expect(await f.versionOf(session.id)).toBe(2);
    expect(await f.versionOf(busy.id)).toBe(1);
    expect(await f.versionOf(current.id)).toBe(2);
    expect(await f.operationRow()).toMatchObject({ status: "running", moved_count: 3, failed_count: 0 });

    // After its turn, the next scan moves it.
    await settleBusy();
    expect(await scan()).toMatchObject({ moved: 1, deferred: 0, failed: 0 });
    expect(await f.versionOf(busy.id)).toBe(2);
    await activities.finishOrgAgentPublishMove({ ...input, status: "succeeded", remainingDeferred: 0 });
    const finished = await f.operationRow();
    expect(finished).toMatchObject({ status: "succeeded", moved_count: 4, failed_count: 0 });
    expect(finished.finished_at).toBeInstanceOf(Date);
    // A finished operation does not start again.
    expect(await activities.beginOrgAgentPublishMove(input)).toEqual({ proceed: false });
  }, 180_000);

  test("a newer publish stops the move", async () => {
    const f = await fixture();
    await f.chat(1);
    const activities = createOrgAgentPublishMoveActivities(
      async () => ({ db: client.db, bus: null, observability }) as unknown as ControlActivityServices,
    );
    const input = { accountId: f.accountId, agentId: f.agentId, operationId: f.operationId };
    await activities.beginOrgAgentPublishMove(input);
    await shared.admin`update agents set published_revision = 1 where id = ${f.agentId}`;
    expect(
      await activities.moveOrgAgentChatsBatch({
        ...input,
        toVersion: 2,
        cursor: { workspaceIndex: 0, afterSessionId: null },
      }),
    ).toMatchObject({ done: true, superseded: true, moved: 0 });
  }, 180_000);
});
