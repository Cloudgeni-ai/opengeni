import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  getSession,
  getSessionGoal,
  getSessionHistoryItems,
  getSessionTurn,
  initializeSessionStartAtomically,
  listSessionEvents,
  materializeGoalContinuation,
  setSessionGoalStatusWithEvent,
} from "@opengeni/db";
import { tool } from "@openai/agents";
import { z } from "zod";
import { createProductionAgentRuntime, prepareAgentTools } from "@opengeni/runtime";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { functionCall, ScriptedModel } from "@opengeni/testing/scripted-model";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { createActivityTestHarness } from "../src/activities";
import { hasFinalReplyNudge } from "../src/activities/agent-turn/final-reply";
import {
  GOAL_COMPLETE_REPLY_MESSAGE_ID,
  GOAL_COMPLETE_SIBLING_REFUSAL,
} from "../src/activities/agent-turn/input-wait-reply";

// goal_complete with a reply through the production worker turn (real
// PostgreSQL): the completion and the final answer are one model call, the
// reply is the turn's answer exactly once, and an unfinished goal still
// continues. The first-party MCP server is an in-process fake whose
// goal_complete commits the real goal completion with the calling attempt's
// authority, as the API does.

const FIRST_PARTY_URL = "http://127.0.0.1:8000/v1/workspaces/{workspaceId}/mcp";
const GOAL_TOOLS = [
  "goal_update",
  "goal_progress",
  "goal_complete",
  "goal_pause",
  "wait_for_input",
];

describe("goal_complete reply ends the turn (production worker, PostgreSQL)", () => {
  let shared: SharedTestDatabase;
  let client: ReturnType<typeof createDb>;
  beforeAll(async () => {
    const acquired = await acquireSharedTestDatabase("goal-complete-reply");
    if (!acquired) throw new Error("Real PostgreSQL is required");
    shared = acquired;
    client = createDb(shared.appUrl);
  }, 180_000);
  afterAll(async () => {
    await client?.close();
    await shared?.release();
  }, 60_000);

  async function run(steps: ConstructorParameters<typeof ScriptedModel>[0]) {
    const suffix = crypto.randomUUID();
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "goal-complete-reply",
      accountExternalId: suffix,
      accountName: "Goal complete reply",
      workspaceExternalSource: "goal-complete-reply",
      workspaceExternalId: suffix,
      workspaceName: "Goal complete reply",
      subjectId: `user:${suffix}`,
    });
    const grant = access.workspaceGrants[0]!;
    const workspaceId = grant.workspaceId!;
    const session = await createSession(client.db, {
      accountId: grant.accountId,
      workspaceId,
      initialMessage: "Fix the parser and report the result.",
      resources: [],
      tools: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      createdBy: { kind: "subject", subjectId: grant.subjectId },
    });
    await initializeSessionStartAtomically(client.db, {
      accountId: grant.accountId,
      workspaceId,
      sessionId: session.id,
      clientEventId: `initial:${suffix}`,
      reasoningEffortFallback: "low",
      createdEventPayload: {},
      goal: { text: "Complete the request in this session's first message." },
    });
    const completions: Array<Record<string, unknown>> = [];
    const completeGoal = async (args: Record<string, unknown>) => {
      completions.push(args);
      const active = await getSession(client.db, workspaceId, session.id);
      const turn = await getSessionTurn(client.db, workspaceId, active!.activeTurnId!);
      const evidence = String(args.evidence);
      await setSessionGoalStatusWithEvent(client.db, workspaceId, session.id, {
        status: "completed",
        evidence,
        event: { type: "goal.completed", evidence },
        commandActor: {
          type: "agent_attempt",
          sessionId: session.id,
          turnId: turn!.id,
          attemptId: turn!.activeAttemptId!,
          executionGeneration: turn!.executionGeneration,
        },
      });
      return {
        content: [{ type: "text", text: '{"operation":"goal_complete","committed":true}' }],
      };
    };
    const mcpFetchImpl = async (_url: unknown, init?: RequestInit) => {
      if (init?.method !== "POST") return new Response(null, { status: 405 });
      const request = JSON.parse(String(init.body));
      if (request.id === undefined) return new Response(null, { status: 202 });
      let result: unknown;
      if (request.method === "initialize") {
        result = {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "first-party-fake", version: "1" },
        };
      } else if (request.method === "tools/list") {
        result = {
          tools: GOAL_TOOLS.map((name) => ({
            name,
            inputSchema: {
              type: "object",
              properties:
                name === "goal_complete"
                  ? { evidence: { type: "string" }, reply: { type: "string" } }
                  : { reason: { type: "string" }, reply: { type: "string" } },
            },
          })),
        };
      } else if (request.method === "tools/call") {
        if (request.params.name !== "goal_complete") {
          throw new Error(`unexpected first-party call ${request.params.name}`);
        }
        result = await completeGoal(request.params.arguments ?? {});
      } else {
        throw new Error(`unexpected MCP method ${request.method}`);
      }
      return Response.json({ jsonrpc: "2.0", id: request.id, result });
    };
    const model = new ScriptedModel(steps);
    const production = createProductionAgentRuntime({ model });
    let toolCalls = 0;
    const runtime = {
      ...production,
      // Every scripted step is the agent's: no parallel title request.
      generateSessionTitle: undefined,
      prepareTools: async (...args: Parameters<typeof prepareAgentTools>) =>
        await prepareAgentTools(args[0], args[1], {
          ...args[2],
          mcpFetchImpl: mcpFetchImpl as never,
        }),
      buildAgent: (...args: Parameters<typeof production.buildAgent>) => {
        const agent = production.buildAgent(...args);
        agent.tools.push(
          tool({
            name: "verified_result",
            description: "Verify the result.",
            parameters: z.object({}),
            execute: async () => {
              toolCalls += 1;
              return "Verified result.";
            },
          }),
        );
        return agent;
      },
    };
    const activities = createActivityTestHarness({
      settings: testSettings({
        databaseUrl: shared.appUrl,
        openaiModel: "scripted-model",
        sandboxBackend: "none",
        lazyToolSearchEnabled: false,
        integrationsAllowPrivateNetworkTargets: true,
        mcpServers: [{ id: "opengeni", url: FIRST_PARTY_URL, cacheToolsList: false }],
      }),
      db: client.db,
      bus: new MemoryEventBus(),
      runtime,
    });
    const result = await activities.runAgentTurn({
      accountId: grant.accountId,
      workspaceId,
      sessionId: session.id,
      workflowId: `session-${session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    if (result.status === "unclaimed") throw new Error("Expected a claimed turn");
    return {
      result,
      model,
      toolCalls,
      completions,
      grant,
      session,
      turn: await getSessionTurn(client.db, workspaceId, result.turnId),
      goal: await getSessionGoal(client.db, workspaceId, session.id),
      history: await getSessionHistoryItems(client.db, workspaceId, session.id),
      events: await listSessionEvents(client.db, workspaceId, session.id),
    };
  }

  const evidence = "Parser tests pass: 12 passed, 0 failed.";
  const reply =
    "The parser now accepts empty input.\n\n| check | result |\n|---|---|\n| tests | pass |";

  test("completion and final answer are one model call, recorded once", async () => {
    const actual = await run([
      { output: [functionCall("opengeni__goal_complete", { evidence, reply }, "complete")] },
      { error: new Error("a completion with a reply must never request another model step") },
    ]);
    expect(actual.model.calls).toBe(1);
    expect(actual.completions).toEqual([{ evidence, reply }]);
    expect(actual.turn?.status).toBe("completed");
    expect(actual.goal?.status).toBe("completed");
    expect(actual.events.filter((event) => event.type === "goal.completed")).toHaveLength(1);
    const messages = actual.events.filter((event) => event.type === "agent.message.completed");
    expect(messages.map((event) => (event.payload as { text?: string }).text)).toEqual([reply]);
    expect(String((messages[0]!.payload as { messageId?: string }).messageId)).toStartWith(
      `${GOAL_COMPLETE_REPLY_MESSAGE_ID}:`,
    );
    // The turn's answer is the reply: what a parent reads as the child's
    // final answer and what Slack or the API return.
    expect(
      actual.events.filter((event) => event.type === "turn.completed").map((e) => e.payload),
    ).toEqual([{ output: reply }]);
    expect(
      hasFinalReplyNudge(
        actual.history.map((row) => row.item),
        actual.result.turnId,
      ),
    ).toBe(false);
  }, 60_000);

  test("a completion batched with another call is refused until the model has seen it", async () => {
    const actual = await run([
      {
        output: [
          functionCall("verified_result", {}, "check"),
          functionCall("opengeni__goal_complete", { evidence, reply }, "early"),
        ],
      },
      { output: [functionCall("opengeni__goal_complete", { evidence, reply }, "complete")] },
      { error: new Error("an accepted completion must never request another model step") },
    ]);
    expect(actual.model.calls).toBe(2);
    expect(actual.toolCalls).toBe(1);
    expect(actual.completions).toHaveLength(1);
    expect(JSON.stringify(actual.model.requests[1]?.input)).toContain(
      GOAL_COMPLETE_SIBLING_REFUSAL,
    );
    expect(actual.goal?.status).toBe("completed");
    expect(
      actual.events.filter((event) => event.type === "turn.completed").map((e) => e.payload),
    ).toEqual([{ output: reply }]);
  }, 60_000);

  test("an agent that stops without completing leaves the goal active and continuing", async () => {
    const actual = await run([{ outputText: "I looked at the parser; the fix is next." }]);
    expect(actual.model.calls).toBe(1);
    expect(actual.completions).toHaveLength(0);
    expect(actual.goal?.status).toBe("active");
    const continuation = await materializeGoalContinuation(client.db, {
      accountId: actual.grant.accountId,
      workspaceId: actual.grant.workspaceId!,
      sessionId: actual.session.id,
      workflowId: `session-${actual.session.id}`,
      defaultMaxAutoContinuations: null,
      budgetBlocked: null,
      policy: {
        model: "scripted-model",
        reasoningEffort: "low",
        latencyMode: "standard",
        tools: [],
        sandboxBackend: "none",
      },
      prompt: () => "Continue unfinished work.",
    });
    expect(continuation.action).toBe("continue");
  }, 60_000);
});
