import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  agentInstructionsContextItem,
  agentInstructionsContextText,
  readAgentInstructionsContext,
} from "@opengeni/contracts";
import {
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  getActiveSessionHistoryItems,
  readSessionAgentPrompt,
  submitHumanPromptInTransaction,
  withWorkspaceRls,
  withWorkspaceSubjectSessionActivityRls,
} from "@opengeni/db";
import * as schema from "@opengeni/db/schema";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import { maybeCompactContext } from "../src/activities/context-compaction";

const EDIT = agentInstructionsContextText({
  kind: "revision",
  revision: 2,
  instructions: "Use imperial units.",
});

describe("compaction of an agent chat", () => {
  let shared: SharedTestDatabase;
  let client: ReturnType<typeof createDb>;
  beforeAll(async () => {
    const acquired = await acquireSharedTestDatabase("context-compaction-agent-instructions");
    if (!acquired) throw new Error("PostgreSQL test database unavailable");
    shared = acquired;
    client = createDb(shared.appUrl);
  }, 180_000);
  afterAll(async () => {
    await client?.close();
    await shared?.release();
  }, 60_000);

  const EARLIER_HISTORY = [
    { type: "message", role: "user", content: "How far is it?" },
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "About 5 km. ".repeat(2_000) }],
    },
    agentInstructionsContextItem(EDIT),
    { type: "message", role: "user", content: "And in the other direction?" },
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "About 3 miles. ".repeat(2_000) }],
    },
  ];

  /** An agent chat at revision 1 whose history already shows the edit to revision 2. */
  async function fixture(history: Record<string, unknown>[] = EARLIER_HISTORY) {
    const suffix = crypto.randomUUID();
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId: `account-${suffix}`,
      accountName: "Agent compaction",
      workspaceExternalSource: "test",
      workspaceExternalId: `workspace-${suffix}`,
      workspaceName: "Agent compaction",
      subjectId: `subject-${suffix}`,
    });
    const grant = access.workspaceGrants[0]!;
    const accountId = grant.accountId;
    const workspaceId = grant.workspaceId!;
    const session = await createSession(client.db, {
      accountId,
      workspaceId,
      initialMessage: "",
      resources: [],
      metadata: {},
      model: "scripted-compactor",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    const agentId = crypto.randomUUID();
    await shared.admin`
      insert into agents (id, account_id, workspace_id, visibility, name, name_key, origin,
        current_revision)
      values (${agentId}, ${accountId}, ${workspaceId}, 'workspace', 'Units', 'units', 'app', 3)`;
    await shared.admin`
      insert into agent_revisions (agent_id, account_id, workspace_id, revision, name, instructions)
      values (${agentId}, ${accountId}, ${workspaceId}, 1, 'Units', 'Use metric units.'),
        (${agentId}, ${accountId}, ${workspaceId}, 2, 'Units', 'Use imperial units.'),
        (${agentId}, ${accountId}, ${workspaceId}, 3, 'Units', 'Use both units.')`;
    await shared.admin`
      update sessions set agent_id = ${agentId}, agent_prompt_revision = 1
      where id = ${session.id}`;
    await withWorkspaceRls(client.db, workspaceId, async (db) => {
      await db.insert(schema.sessionHistoryItems).values(
        history.map((item, position) => ({
          accountId,
          workspaceId,
          sessionId: session.id,
          position,
          item,
        })),
      );
    });
    await withWorkspaceSubjectSessionActivityRls(client.db, workspaceId, grant.subjectId, (db) =>
      submitHumanPromptInTransaction(db, {
        accountId,
        workspaceId,
        sessionId: session.id,
        subjectId: grant.subjectId,
        actor: { type: "human", subjectId: grant.subjectId },
        operationKey: crypto.randomUUID(),
        delivery: "send",
        text: "Thanks",
        resources: [],
        reasoningEffort: "medium",
        reasoningEffortFallback: "medium",
        source: "user",
      }),
    );
    const attemptId = crypto.randomUUID();
    const claimed = await claimSessionWorkForAttempt(client.db, workspaceId, {
      agentInstructionsProtocol: 1,
      sessionId: session.id,
      workflowId: `session-${session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId,
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    if (claimed.action !== "claimed") throw new Error("not claimed");
    const scope = {
      accountId,
      workspaceId,
      sessionId: session.id,
      turnId: claimed.turn.id,
      executionGeneration: claimed.turn.executionGeneration,
      attemptId,
    };
    const agentItems = async () =>
      (await getActiveSessionHistoryItems(client.db, workspaceId, session.id))
        .map((row) => readAgentInstructionsContext(row.item))
        .filter((text) => text !== null);
    const prompt = () =>
      readSessionAgentPrompt(client.db, { accountId, workspaceId, sessionId: session.id });
    return { scope, agentItems, prompt };
  }

  for (const mode of ["portable", "remote_v2"] as const) {
    for (const continuing of [true, false]) {
      test(`${mode}: folds the newest revision into the prompt${continuing ? " and re-adds it for the running turn" : ""}`, async () => {
        const f = await fixture();
        expect(await f.agentItems()).toEqual([EDIT]);
        const outcome = await maybeCompactContext(
          client.db,
          testSettings({ contextWindowTokens: 250_000 }),
          f.scope,
          null,
          async () => "Distances were discussed.",
          {
            force: true,
            codexCompactionMode: mode,
            isCodexSubscriptionTurn: mode === "remote_v2",
            requestRemoteCompactionV2: async () => ({
              type: "compaction",
              encrypted_content: `checkpoint-${crypto.randomUUID()}`,
            }),
            agentPrompt: { revision: 1, ...(continuing ? { inPrompt: 1 } : {}) },
          },
        );
        expect(outcome.compacted).toBe(true);
        expect(await f.prompt()).toMatchObject({
          revision: 2,
          instructions: "Use imperial units.",
        });
        // The running turn's system prompt still shows revision 1, so it keeps
        // seeing the edit; a compaction-only turn has nothing after it.
        expect(await f.agentItems()).toEqual(continuing ? [EDIT] : []);
      }, 180_000);
    }
  }

  for (const continuing of [true, false]) {
    test(`portable: an edit in the deferred tail stays active and only the summarized one folds${continuing ? " (continuing turn)" : ""}`, async () => {
      const LATER = agentInstructionsContextText({
        kind: "revision",
        revision: 3,
        instructions: "Use both units.",
      });
      const f = await fixture([
        ...EARLIER_HISTORY,
        agentInstructionsContextItem(LATER),
        { type: "message", role: "user", content: "And upwards?" },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "About 2 km. ".repeat(2_000) }],
        },
      ]);
      expect(await f.agentItems()).toEqual([EDIT, LATER]);
      // The provider request only fits without the later edit, so it stays in
      // the deferred tail.
      const summarize = Object.assign(async () => "Distances were discussed.", {
        measureInputBytes: async (_settings: unknown, input: unknown[]) =>
          JSON.stringify(input).includes("Use both units.") ? Number.MAX_SAFE_INTEGER : 1,
      });
      const outcome = await maybeCompactContext(
        client.db,
        testSettings({ contextWindowTokens: 250_000 }),
        f.scope,
        null,
        summarize,
        {
          force: true,
          codexCompactionMode: "portable",
          isCodexSubscriptionTurn: false,
          agentPrompt: { revision: 1, ...(continuing ? { inPrompt: 1 } : {}) },
        },
      );
      expect(outcome.compacted).toBe(true);
      expect(await f.prompt()).toMatchObject({ revision: 2, instructions: "Use imperial units." });
      // The tail's edit stays the newest item, so the next turn writes nothing.
      expect(await f.agentItems()).toEqual(continuing ? [EDIT, LATER] : [LATER]);
    }, 180_000);
  }
});
