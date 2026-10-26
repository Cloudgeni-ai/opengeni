import { afterAll, beforeAll, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import * as opengeniDb from "@opengeni/db";
import {
  acquireRestrictedRuntimeTestDatabase,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { ScriptedModel, assistantMessage } from "@opengeni/testing/scripted-model";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  getSession,
  initializeSessionStartAtomically,
  listSessionEvents,
} from "@opengeni/db";
import type { Settings } from "@opengeni/config";
import {
  createProductionAgentRuntime,
  resolveTurnModel,
  type OpenGeniRuntime,
} from "@opengeni/runtime";
import { createActivityTestHarness } from "../src/activities";

// EU-only inference through the real worker turn path and real PostgreSQL:
// the setting is turned on after the claim read it, and the attempt's own
// read must still stop the turn before any model call. Offline: no provider.
setDefaultTimeout(120_000);
let shared: RestrictedRuntimeTestDatabase;
let app: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireRestrictedRuntimeTestDatabase("eu-only-turn-worker");
  if (!acquired) throw new Error("Native PostgreSQL required for EU-only turn tests");
  shared = acquired;
  app = createDb(shared.appUrl, { searchPath: shared.schema });
}, 600_000);
afterAll(async () => {
  await app?.close();
  await shared?.release();
}, 60_000);

async function fixture() {
  const subjectId = `user:eu-only-turn:${crypto.randomUUID()}`;
  const access = await bootstrapWorkspace(app.db, {
    accountExternalSource: "eu-only-turn",
    accountExternalId: crypto.randomUUID(),
    accountName: "EU-only turn",
    workspaceExternalSource: "eu-only-turn",
    workspaceExternalId: crypto.randomUUID(),
    workspaceName: "EU-only turn",
    subjectId,
  });
  const grant = access.workspaceGrants[0]!;
  return { accountId: grant.accountId, workspaceId: grant.workspaceId!, subjectId };
}

/** Offline runtime: resolution runs for real (and must refuse under EU), the model is scripted. */
function scriptedRuntime(scripted: ScriptedModel, resolvedWith: Settings[]): OpenGeniRuntime {
  const production = createProductionAgentRuntime({ model: scripted });
  return {
    ...production,
    configure: () => {},
    resolveTurnModel: (settings, modelId) => {
      resolvedWith.push(settings);
      resolveTurnModel(settings, modelId);
      return {
        provider: {
          id: "test-chat",
          label: "Offline",
          kind: "api-key",
          api: "chat",
          builtin: false,
        },
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
      };
    },
  };
}

test("EU-only turned on after the claim stops the turn once with region_restricted, before any model call", async () => {
  const ctx = await fixture();
  const session = await createSession(app.db, {
    accountId: ctx.accountId,
    workspaceId: ctx.workspaceId,
    createdBy: { kind: "subject", subjectId: ctx.subjectId },
    initialMessage: "Answer",
    resources: [],
    tools: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  await initializeSessionStartAtomically(app.db, {
    accountId: ctx.accountId,
    workspaceId: ctx.workspaceId,
    sessionId: session.id,
    reasoningEffortFallback: "medium",
    createdEventPayload: {},
    goal: null,
  });

  // The first read (the claim's) sees EU-only off; an admin turns it on
  // immediately after, so every later read sees it on.
  const original = opengeniDb.isWorkspaceEuOnly;
  let reads = 0;
  const euOnlyReads = spyOn(opengeniDb, "isWorkspaceEuOnly").mockImplementation(
    async (db, input) => {
      reads += 1;
      const euOnly = await original(db, input);
      if (reads === 1) {
        expect(euOnly).toBe(false);
        await shared.admin`insert into organization_inference_residency (account_id, eu_only, version)
          values (${ctx.accountId}, true, 1)
          on conflict (account_id) do update set eu_only = true, version = organization_inference_residency.version + 1`;
      }
      return euOnly;
    },
  );
  const scripted = new ScriptedModel([
    { inputTokens: 100, output: [assistantMessage("must not dispatch")] },
  ]);
  const resolvedWith: Settings[] = [];
  let result: unknown;
  try {
    const activities = createActivityTestHarness({
      settings: testSettings({
        databaseUrl: shared.appUrl,
        openaiModel: "scripted-model",
        sandboxBackend: "none",
      }),
      db: app.db,
      bus: new MemoryEventBus(),
      runtime: scriptedRuntime(scripted, resolvedWith),
    });
    result = await activities
      .runAgentTurn({
        accountId: ctx.accountId,
        workspaceId: ctx.workspaceId,
        sessionId: session.id,
        workflowId: `session-${session.id}`,
        workflowRunId: crypto.randomUUID(),
        attemptId: crypto.randomUUID(),
        trigger: { kind: "next" },
      })
      .catch((error: unknown) => ({ status: "threw", error }));
  } finally {
    euOnlyReads.mockRestore();
  }

  expect(result).toMatchObject({ status: "failed" });
  // The claim read it off, the attempt read it again and saw it on.
  expect(reads).toBeGreaterThanOrEqual(2);
  // Resolution ran with the narrowed settings and refused.
  expect(resolvedWith.length).toBeGreaterThan(0);
  expect(resolvedWith.every((settings) => settings.requiredModelGeography === "eu")).toBe(true);
  expect(scripted.calls).toBe(0);
  const timeline = await listSessionEvents(app.db, ctx.workspaceId, session.id, {
    after: 0,
    limit: 200,
  });
  const failed = timeline.filter((event) => event.type === "turn.failed");
  expect(failed).toHaveLength(1);
  expect(failed[0]!.payload).toMatchObject({ code: "region_restricted", retryable: false });
  expect(timeline.some((event) => event.type === "turn.completed")).toBe(false);
  expect(await getSession(app.db, ctx.workspaceId, session.id)).toMatchObject({
    activeTurnId: null,
  });
});
