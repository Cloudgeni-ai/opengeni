import { afterAll, beforeAll, expect, test } from "bun:test";
import { Runner, type AgentInputItem, type ModelRequest, type StreamEvent } from "@openai/agents";
import {
  acquireSharedTestDatabase,
  assistantMessage,
  functionCall,
  ScriptedModel,
  testSettings,
  type ScriptedModelStep,
  type SharedTestDatabase,
} from "@opengeni/testing";
import {
  appendSessionHistoryItems,
  applyContextCompaction,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  getActiveSessionHistoryItemsPaged,
  initializeSessionStartAtomically,
  nextSessionHistoryPosition,
} from "@opengeni/db";
import { saveSkill } from "@opengeni/core";
import { buildOpenGeniAgent, prepareAgentTools } from "@opengeni/runtime";
import { createWorkspaceSkillTools } from "../src/activities/agent-turn/skill-tools";
import {
  createTurnHistorySink,
  type TurnHistorySinkDeps,
} from "../src/activities/agent-turn/history-sink";
import { checkpointHistoryBeforeProviderDispatch } from "../src/activities/agent-turn/provider-dispatch-barrier";

let shared: SharedTestDatabase | null = null;
let app: ReturnType<typeof createDb> | null = null;
beforeAll(async () => {
  shared = await acquireSharedTestDatabase("skill-read-history");
  if (!shared) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") throw new Error("PostgreSQL required");
    return;
  }
  app = createDb(shared.appUrl, { max: 4 });
}, 180_000);
afterAll(async () => {
  await app?.close();
  await shared?.release();
}, 60_000);

const skillMarkdown = (body: string) =>
  `---\nname: replica-research\ndescription: Answer user questions from the replica\n---\n${body}`;

const receipt = (skill: string, revisionId: string) =>
  `Already in context: SKILL.md of ${JSON.stringify(skill)} revision ${revisionId} was returned earlier in this conversation and is unchanged. Use that copy. Re-read only if you need a fresh copy: call skill_read with paths ["SKILL.md"].`;

/** Every skill_read output the model received, in call order. */
function skillReadOutputs(history: ReadonlyArray<Record<string, unknown>>) {
  return history
    .filter((item) => item.type === "function_call_result" && item.name === "skill_read")
    .map((item) => {
      const output = item.output as Array<{ type: string; text: string }>;
      expect(output).toHaveLength(1);
      return JSON.parse(output[0]!.text) as Record<string, unknown>;
    });
}

test("skill_read returns a short receipt while the same revision is in active model history", async () => {
  if (!app || !shared) return;
  const db = app.db;
  const suffix = crypto.randomUUID();
  const subjectId = `user:skill-read-history-${suffix}`;
  const grant = (
    await bootstrapWorkspace(db, {
      accountExternalSource: "skill-read-history-test",
      accountExternalId: suffix,
      accountName: "Test",
      workspaceExternalSource: "skill-read-history-test",
      workspaceExternalId: suffix,
      workspaceName: "Test",
      subjectId,
    })
  ).workspaceGrants[0]!;
  const accountId = grant.accountId;
  const workspaceId = grant.workspaceId!;
  const human = {
    accountId,
    workspaceId,
    actor: { kind: "human", subjectId, principalKind: "human_session" } as const,
  };
  const skillId = crypto.randomUUID();
  const firstMarkdown = skillMarkdown("# Replica research\nRun scripts/users.py active.");
  const first = await saveSkill(db, {
    ...human,
    operationId: crypto.randomUUID(),
    skillId,
    expectedRevisionId: null,
    expectedScopeVersion: 1,
    stableKey: `replica-${suffix}`,
    files: [
      { path: "SKILL.md", content: firstMarkdown },
      { path: "references/schema.md", content: "users(id, created_at)" },
    ],
    reason: "Fixture",
  });

  const session = await createSession(db, {
    accountId,
    workspaceId,
    initialMessage: "How many users signed up today?",
    resources: [],
    metadata: {},
    model: "scripted",
    reasoningEffort: "low",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  await initializeSessionStartAtomically(db, {
    accountId,
    workspaceId,
    sessionId: session.id,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
  });
  const attemptId = crypto.randomUUID();
  const claim = await claimSessionWorkForAttempt(db, workspaceId, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    dispatchId: suffix,
    attemptId,
    trigger: { kind: "next" },
  });
  if (claim.action !== "claimed") throw new Error("Could not claim fixture turn");
  const turnId = claim.turn.id;
  const executionGeneration = claim.turn.executionGeneration;
  const write = {
    accountId,
    workspaceId,
    sessionId: session.id,
    turnId,
    expectedExecutionGeneration: executionGeneration,
    expectedAttemptId: attemptId,
  };
  const appendUserMessage = async (content: string) => {
    await appendSessionHistoryItems(db, {
      ...write,
      items: [
        {
          position: await nextSessionHistoryPosition(db, workspaceId, session.id),
          item: { type: "message", role: "user", content },
        },
      ],
    });
  };
  await appendUserMessage("How many users signed up today?");

  const settings = testSettings({ sandboxBackend: "none", mcpServers: [] });
  const skillRead = createWorkspaceSkillTools({
    db,
    settings,
    accountId,
    workspaceId,
    actor: { kind: "agent", sessionId: session.id, turnId, attemptId, executionGeneration },
    selected: [],
    filesystem: async () => {
      throw new Error("skill_read must not need a sandbox");
    },
  }).find((definition) => definition.modelName === "skill_read")!;
  const prepared = await prepareAgentTools(settings, [], {
    accountId,
    workspaceId,
    sessionId: session.id,
    turnId,
    attemptId,
    executionGeneration,
    attemptToolDefinitions: [skillRead],
  });

  /**
   * One production-shaped model run: the real SDK projects the gateway result
   * through the local MCP server, and the turn sink persists every complete
   * call/result pair before the next provider request.
   */
  async function run(steps: ScriptedModelStep[]) {
    const initial = (await getActiveSessionHistoryItemsPaged(db, workspaceId, session.id)).map(
      (row) => row.item,
    );
    let stream: Awaited<ReturnType<Runner["run"]>> | undefined;
    const sink = createTurnHistorySink({
      db,
      accountId,
      workspaceId,
      sessionId: session.id,
      attemptId,
      media: {
        retainNativeGeneratedImagesFromHistory: async () => {},
        retainedScreenshotReceiptsByCallId: new Map(),
        generatedImageReceiptsByProviderItemId: new Map(),
      } as TurnHistorySinkDeps["media"],
      getTurnId: () => turnId,
      getStream: () => stream as ReturnType<TurnHistorySinkDeps["getStream"]>,
      getModelRunSettings: () => settings,
      getExecutionGeneration: () => executionGeneration,
    });
    sink.seedHistory(initial, initial.length);
    sink.nextHistoryPosition = await nextSessionHistoryPosition(db, workspaceId, session.id);
    class CheckpointedModel extends ScriptedModel {
      override async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
        await checkpointHistoryBeforeProviderDispatch(sink);
        yield* super.getStreamedResponse(request);
      }
    }
    const agent = buildOpenGeniAgent(settings, [], {
      model: new CheckpointedModel(steps),
      skillCatalog: [],
      mcpServers: prepared.mcpServers,
    });
    const result = await new Runner({ tracingDisabled: true }).run(
      agent,
      initial as AgentInputItem[],
      { stream: true, historyOwnership: "external", maxTurns: 20 },
    );
    stream = result;
    for await (const _ of result.toStream()) {
      /* the checkpoint barrier persists each complete pair */
    }
    await result.completed;
    await sink.reconcileConversationTruth({ requireDurable: true });
    const history = (await getActiveSessionHistoryItemsPaged(db, workspaceId, session.id)).map(
      (row) => row.item,
    );
    return skillReadOutputs(history).slice(-(steps.length - 1));
  }

  try {
    const identity = { skillId, revisionId: first.revisionId, scopeVersion: 1 };
    const fullRead = { ...identity, files: [{ path: "SKILL.md", content: firstMarkdown }] };

    // Within one turn: a repeat by id, a repeat by name, then an explicit
    // SKILL.md path, which is the fresh-copy request.
    const firstTurn = await run([
      { output: [functionCall("skill_read", { skill: skillId }, "read-1")] },
      { output: [functionCall("skill_read", { skill: skillId }, "read-2")] },
      { output: [functionCall("skill_read", { skill: "replica-research" }, "read-3")] },
      {
        output: [functionCall("skill_read", { skill: skillId, paths: ["SKILL.md"] }, "read-4")],
      },
      { output: [assistantMessage("12 users signed up today.")] },
    ]);
    expect(firstTurn).toEqual([
      fullRead,
      { ...identity, alreadyInContext: true, message: receipt(skillId, first.revisionId) },
      {
        ...identity,
        alreadyInContext: true,
        message: receipt("replica-research", first.revisionId),
      },
      fullRead,
    ]);

    // A later question in the same session: the read is still in history.
    await appendUserMessage("And since noon?");
    expect(
      await run([
        { output: [functionCall("skill_read", { skill: skillId }, "read-5")] },
        { output: [assistantMessage("3 users signed up since then.")] },
      ]),
    ).toEqual([
      { ...identity, alreadyInContext: true, message: receipt(skillId, first.revisionId) },
    ]);

    // Compaction removes the earlier outputs from model history, so the next
    // read returns the full text again.
    const compacted = await applyContextCompaction(db, {
      ...write,
      replacementItems: [{ type: "message", role: "user", content: "And since noon?" }],
      summaryItem: {
        type: "message",
        role: "user",
        content: "Summary: the agent answered two user-count questions.",
      },
    });
    expect(compacted.applied).toBe(true);
    await appendUserMessage("And this week?");
    expect(
      await run([
        { output: [functionCall("skill_read", { skill: skillId }, "read-6")] },
        { output: [functionCall("skill_read", { skill: skillId }, "read-7")] },
        { output: [assistantMessage("5 users signed up this week.")] },
      ]),
    ).toEqual([
      fullRead,
      { ...identity, alreadyInContext: true, message: receipt(skillId, first.revisionId) },
    ]);

    // A new revision is not in context until it has been read once.
    const secondMarkdown = skillMarkdown("# Replica research\nRun scripts/users.py new.");
    const second = await saveSkill(db, {
      ...human,
      operationId: crypto.randomUUID(),
      skillId,
      expectedRevisionId: first.revisionId,
      expectedScopeVersion: 1,
      stableKey: `replica-${suffix}`,
      files: [{ path: "SKILL.md", content: secondMarkdown }],
      reason: "Fixture update",
    });
    expect(second.revisionId).not.toBe(first.revisionId);
    const updated = { ...identity, revisionId: second.revisionId };
    await appendUserMessage("Use the updated procedure.");
    expect(
      await run([
        { output: [functionCall("skill_read", { skill: skillId }, "read-8")] },
        { output: [functionCall("skill_read", { skill: skillId }, "read-9")] },
        { output: [assistantMessage("Done.")] },
      ]),
    ).toEqual([
      { ...updated, files: [{ path: "SKILL.md", content: secondMarkdown }] },
      { ...updated, alreadyInContext: true, message: receipt(skillId, second.revisionId) },
    ]);
  } finally {
    await prepared.close();
  }
}, 180_000);
