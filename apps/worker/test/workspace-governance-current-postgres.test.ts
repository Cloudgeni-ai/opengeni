import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { tool, type ModelRequest } from "@openai/agents";
import {
  acquireRestrictedRuntimeTestDatabase,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { ScriptedModel, functionCall, assistantMessage } from "@opengeni/testing/scripted-model";
import { readWorkspaceGovernanceContext } from "@opengeni/contracts";
import {
  activateWorkspaceInstructionPolicyRevision,
  bootstrapWorkspace,
  createDb,
  createSession,
  createWorkspaceInstructionPolicyDraft,
  getActiveSessionHistoryItemsPaged,
  initializeSessionStartAtomically,
  listSessionEvents,
} from "@opengeni/db";
import { createProductionAgentRuntime, type OpenGeniRuntime } from "@opengeni/runtime";
import { createActivityTestHarness } from "../src/activities";

// Workspace governance through the real worker turn path: real PostgreSQL in
// the production posture and the real SDK call flow over an offline
// ScriptedModel. A turn runs each model request under the governance active
// when the request is built, and never changes what an earlier request sent.
setDefaultTimeout(120_000);
let shared: RestrictedRuntimeTestDatabase;
let app: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireRestrictedRuntimeTestDatabase("workspace-governance-current");
  if (!acquired) throw new Error("Native PostgreSQL required for workspace governance tests");
  shared = acquired;
  app = createDb(shared.appUrl, { searchPath: shared.schema });
}, 600_000);
afterAll(async () => {
  await app?.close();
  await shared?.release();
}, 60_000);

/** Records each request's input as sent, before the run appends to it. */
class RecordingModel extends ScriptedModel {
  sent: string[] = [];
  override async getResponse(request: ModelRequest) {
    this.sent.push(JSON.stringify(request.input));
    return await super.getResponse(request);
  }
  override async *getStreamedResponse(request: ModelRequest) {
    this.sent.push(JSON.stringify(request.input));
    yield* super.getStreamedResponse(request);
  }
}

async function fixture() {
  const subjectId = `user:governance-current:${crypto.randomUUID()}`;
  const access = await bootstrapWorkspace(app.db, {
    accountExternalSource: "governance-current",
    accountExternalId: crypto.randomUUID(),
    accountName: "Governance current",
    workspaceExternalSource: "governance-current",
    workspaceExternalId: crypto.randomUUID(),
    workspaceName: "Governance current",
    subjectId,
  });
  const grant = access.workspaceGrants[0]!;
  const ctx = { accountId: grant.accountId, workspaceId: grant.workspaceId!, subjectId };
  let current: { id: string; version: number } | null = null;
  /** Activate a new global workspace policy, as an owner would. */
  const activatePolicy = async (content: string) => {
    const draft = await createWorkspaceInstructionPolicyDraft(app.db, {
      accountId: ctx.accountId,
      workspaceId: ctx.workspaceId,
      kind: "policy",
      scope: "global",
      roleKey: null,
      content,
      provenanceSource: "human",
      provenanceSourceId: null,
      supersedesRevisionId: current?.id ?? null,
      createdBySubjectId: subjectId,
    });
    await activateWorkspaceInstructionPolicyRevision(app.db, {
      accountId: ctx.accountId,
      workspaceId: ctx.workspaceId,
      revisionId: draft.id,
      expectedCurrentRevisionId: current?.id ?? null,
      expectedActivationVersion: current?.version ?? 0,
      actorSubjectId: subjectId,
      reason: "Governance test",
    });
    current = { id: draft.id, version: (current?.version ?? 0) + 1 };
  };
  const session = await createSession(app.db, {
    accountId: ctx.accountId,
    workspaceId: ctx.workspaceId,
    createdBy: { kind: "subject", subjectId },
    initialMessage: "Run the local tool, then answer",
    resources: [],
    tools: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  return { ...ctx, session, activatePolicy };
}

/** Offline runtime: the production SDK call flow plus one local tool. */
function scriptedRuntime(scripted: ScriptedModel, onTool: () => Promise<void>): OpenGeniRuntime {
  const production = createProductionAgentRuntime({ model: scripted });
  return {
    ...production,
    configure: () => {},
    resolveTurnModel: () => ({
      provider: { id: "test-chat", label: "Offline", kind: "api-key", api: "chat", builtin: false },
      client: {} as NonNullable<ReturnType<OpenGeniRuntime["resolveTurnModel"]>>["client"],
      model: scripted,
      configured: {
        id: "scripted-model",
        label: "Offline",
        providerId: "test-chat",
        providerLabel: "Offline",
        api: "chat",
        contextWindowTokens: 250_000,
        effectiveContextWindowTokens: 250_000,
        autoCompactTokenLimit: 225_000,
        reasoningEffort: false,
        hostedWebSearch: false,
      },
    }),
    buildAgent: (...args) => {
      const agent = production.buildAgent(...args);
      agent.tools.push(
        tool({
          name: "local_fixture",
          description: "Offline no-op",
          parameters: { type: "object", properties: {}, additionalProperties: false },
          strict: false,
          execute: async () => {
            await onTool();
            return "local result";
          },
        }),
      );
      return agent;
    },
  };
}

async function runTurn(
  f: Awaited<ReturnType<typeof fixture>>,
  scripted: ScriptedModel,
  onTool: () => Promise<void> = async () => {},
) {
  const activities = createActivityTestHarness({
    settings: testSettings({
      databaseUrl: shared.appUrl,
      openaiModel: "scripted-model",
      sandboxBackend: "none",
    }),
    db: app.db,
    bus: new MemoryEventBus(),
    runtime: scriptedRuntime(scripted, onTool),
  });
  return await activities.runAgentTurn({
    accountId: f.accountId,
    workspaceId: f.workspaceId,
    sessionId: f.session.id,
    workflowId: `session-${f.session.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
}

async function start(f: Awaited<ReturnType<typeof fixture>>) {
  await initializeSessionStartAtomically(app.db, {
    accountId: f.accountId,
    workspaceId: f.workspaceId,
    sessionId: f.session.id,
    reasoningEffortFallback: "medium",
    createdEventPayload: {},
    goal: null,
  });
}

async function governanceHistory(f: Awaited<ReturnType<typeof fixture>>) {
  const history = await getActiveSessionHistoryItemsPaged(app.db, f.workspaceId, f.session.id);
  return history
    .map((row) => readWorkspaceGovernanceContext(row.item as Record<string, unknown>))
    .filter((value) => value !== null);
}

test("a turn that waited after acceptance sends its first request under the governance activated meanwhile", async () => {
  const f = await fixture();
  await f.activatePolicy("RULE_BEFORE_ACCEPTANCE");
  // The turn is accepted, then waits (for example for subscription capacity)
  // while an owner activates a new policy.
  await start(f);
  await f.activatePolicy("RULE_WHILE_WAITING");
  const scripted = new RecordingModel([{ output: [assistantMessage("done")] }]);
  expect((await runTurn(f, scripted)).status).toBe("idle");
  expect(scripted.sent).toHaveLength(1);
  expect(scripted.sent[0]).toContain("RULE_WHILE_WAITING");
  expect(scripted.sent[0]).not.toContain("RULE_BEFORE_ACCEPTANCE");
});

test("governance activated between two model requests is appended before the next one; what was sent stays identical", async () => {
  const f = await fixture();
  await f.activatePolicy("RULE_A");
  await start(f);
  const scripted = new RecordingModel([
    { output: [functionCall("local_fixture", {}, "call-governance")] },
    { output: [assistantMessage("done")] },
  ]);
  // The tool runs between the two requests; the owner changes the policy then.
  const first = await runTurn(f, scripted, async () => await f.activatePolicy("RULE_B"));
  // The second request was refused before it was sent; the same turn continues.
  expect(first.status).toBe("recovering");
  expect(scripted.sent).toHaveLength(1);
  const recovery = (
    await listSessionEvents(app.db, f.workspaceId, f.session.id, { after: 0, limit: 200 })
  ).find((event) => event.type === "turn.recovery.requested");
  expect(recovery?.payload).toMatchObject({ reason: "workspace_governance_changed" });

  expect((await runTurn(f, scripted)).status).toBe("idle");
  expect(scripted.sent).toHaveLength(2);
  const [before, after] = scripted.sent.map((sent) => JSON.parse(sent) as unknown[]);
  // Every item the first request sent is sent again unchanged, first.
  expect(after!.slice(0, before!.length)).toEqual(before!);
  expect(JSON.stringify(after!.slice(0, before!.length))).toBe(JSON.stringify(before));
  expect(JSON.stringify(before)).toContain("RULE_A");
  expect(JSON.stringify(before)).not.toContain("RULE_B");
  // The new governance is the last item, after the tool call and its output.
  const tail = JSON.stringify(after!.slice(before!.length));
  expect(tail).toContain("call-governance");
  expect(tail.lastIndexOf("RULE_B")).toBeGreaterThan(tail.lastIndexOf("local result"));
  expect(await governanceHistory(f)).toHaveLength(2);
  expect((await governanceHistory(f))[1]).toContain("RULE_B");
});
