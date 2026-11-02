import { afterAll, beforeAll, expect, setDefaultTimeout, spyOn, test } from "bun:test";
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
import { UNSERVED_HOST_SANDBOX_BACKEND_MESSAGE, type Settings } from "@opengeni/config";
import type { SandboxBackend } from "@opengeni/contracts";
import {
  PROVIDER_REGISTRY,
  SANDBOX_BACKEND_NOT_SERVED_CODE,
  createProductionAgentRuntime,
  resolveTurnModel,
  type OpenGeniRuntime,
} from "@opengeni/runtime";
import { createActivityTestHarness } from "../src/activities";

// Defence in depth behind the create-time gate (`sandboxBackendServed`): a
// session row stored before that gate, or a shared-box child inheriting its
// parent's backend, may still name `local` or `docker` on a cloud deployment.
// The worker must refuse it through the real turn path and real PostgreSQL
// before any box, hook or agent is built, and fail the turn terminally with a
// visible reason. The local provider is fully runnable in this test process
// (Node/Bun and a writable temp directory), so the refusal is proven to come
// from deployment configuration, not from the host lacking a runtime.
setDefaultTimeout(120_000);
let shared: RestrictedRuntimeTestDatabase;
let app: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireRestrictedRuntimeTestDatabase("unserved-host-sandbox-backend");
  if (!acquired) throw new Error("Native PostgreSQL required for host sandbox backend tests");
  shared = acquired;
  app = createDb(shared.appUrl, { searchPath: shared.schema });
}, 600_000);
afterAll(async () => {
  await app?.close();
  await shared?.release();
}, 60_000);

async function fixture() {
  const subjectId = `user:unserved-host-backend:${crypto.randomUUID()}`;
  const access = await bootstrapWorkspace(app.db, {
    accountExternalSource: "unserved-host-backend",
    accountExternalId: crypto.randomUUID(),
    accountName: "Unserved host backend",
    workspaceExternalSource: "unserved-host-backend",
    workspaceExternalId: crypto.randomUUID(),
    workspaceName: "Unserved host backend",
    subjectId,
  });
  const grant = access.workspaceGrants[0]!;
  return { accountId: grant.accountId, workspaceId: grant.workspaceId!, subjectId };
}

type Ctx = Awaited<ReturnType<typeof fixture>>;

/** A stored session row, written directly as rows stored before the create gate were. */
async function storedSession(
  ctx: Ctx,
  sandboxBackend: SandboxBackend,
  parent?: { id: string; sandboxGroupId: string },
) {
  const session = await createSession(app.db, {
    accountId: ctx.accountId,
    workspaceId: ctx.workspaceId,
    createdBy: { kind: "subject", subjectId: ctx.subjectId },
    initialMessage: "Run ls in the workspace",
    resources: [],
    tools: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend,
    ...(parent ? { parentSessionId: parent.id, sandboxGroupId: parent.sandboxGroupId } : {}),
  });
  await initializeSessionStartAtomically(app.db, {
    accountId: ctx.accountId,
    workspaceId: ctx.workspaceId,
    sessionId: session.id,
    reasoningEffortFallback: "medium",
    createdEventPayload: {},
    goal: null,
  });
  return session;
}

/** Production runtime with an offline scripted model; records every agent build. */
function scriptedRuntime(scripted: ScriptedModel, built: Settings["sandboxBackend"][]) {
  const production = createProductionAgentRuntime({ model: scripted });
  const runtime: OpenGeniRuntime = {
    ...production,
    configure: () => {},
    buildAgent: (settings, resources, options) => {
      built.push(settings.sandboxBackend);
      return production.buildAgent(settings, resources, options);
    },
    resolveTurnModel: (settings, modelId) => {
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
  return runtime;
}

async function runTurn(
  ctx: Ctx,
  sessionId: string,
  settings: Partial<Settings>,
  scripted: ScriptedModel,
  built: Settings["sandboxBackend"][],
) {
  const activities = createActivityTestHarness({
    settings: testSettings({
      databaseUrl: shared.appUrl,
      openaiModel: "scripted-model",
      // Eager ownership: without the refusal, the turn would build its box
      // and run its setup hooks before the first model call.
      sandboxOwnershipEnabled: true,
      sandboxLazyProvisionEnabled: false,
      ...settings,
    }),
    db: app.db,
    bus: new MemoryEventBus(),
    runtime: scriptedRuntime(scripted, built),
  });
  return await activities
    .runAgentTurn({
      accountId: ctx.accountId,
      workspaceId: ctx.workspaceId,
      sessionId,
      workflowId: `session-${sessionId}`,
      workflowRunId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      trigger: { kind: "next" },
    })
    .catch((error: unknown) => ({ status: "threw", error }));
}

async function leaseCount(sandboxGroupId: string): Promise<number> {
  const [row] = await shared.admin<{ n: number }[]>`
    select count(*)::int as n from ${shared.admin(shared.schema)}.sandbox_leases
    where sandbox_group_id = ${sandboxGroupId}`;
  return row!.n;
}

async function expectRefusedBeforeAnySandboxWork(input: {
  ctx: Ctx;
  session: { id: string; sandboxGroupId: string };
  backend: "local" | "docker";
  settings: Partial<Settings>;
}) {
  const scripted = new ScriptedModel([
    { inputTokens: 100, output: [assistantMessage("must not dispatch")] },
  ]);
  const built: Settings["sandboxBackend"][] = [];
  const hostBuild = spyOn(PROVIDER_REGISTRY[input.backend], "build");
  const hostValidate = spyOn(PROVIDER_REGISTRY[input.backend], "validateCredentials");
  let result: unknown;
  try {
    result = await runTurn(input.ctx, input.session.id, input.settings, scripted, built);
  } finally {
    hostBuild.mockRestore();
    hostValidate.mockRestore();
  }

  expect(result).toMatchObject({ status: "failed" });
  // Nothing touched the host provider, no agent (and so no clone, setup,
  // Rig or hydration hook) was built, and no model call was made.
  expect(hostBuild).not.toHaveBeenCalled();
  expect(hostValidate).not.toHaveBeenCalled();
  expect(built).toEqual([]);
  expect(scripted.calls).toBe(0);
  expect(await leaseCount(input.session.sandboxGroupId)).toBe(0);

  const timeline = await listSessionEvents(app.db, input.ctx.workspaceId, input.session.id, {
    after: 0,
    limit: 200,
  });
  expect(timeline.filter((event) => event.type.startsWith("sandbox."))).toEqual([]);
  const failed = timeline.filter((event) => event.type === "turn.failed");
  expect(failed).toHaveLength(1);
  expect(failed[0]!.payload).toMatchObject({
    code: SANDBOX_BACKEND_NOT_SERVED_CODE,
    retryable: false,
  });
  expect((failed[0]!.payload as { error: string }).error).toBe(
    UNSERVED_HOST_SANDBOX_BACKEND_MESSAGE,
  );
  expect(timeline.some((event) => event.type === "turn.completed")).toBe(false);
  expect(await getSession(app.db, input.ctx.workspaceId, input.session.id)).toMatchObject({
    activeTurnId: null,
  });
}

test("a stored local row on a Modal deployment fails visibly before any box or hook", async () => {
  const ctx = await fixture();
  const session = await storedSession(ctx, "local");
  await expectRefusedBeforeAnySandboxWork({
    ctx,
    session,
    backend: "local",
    settings: {
      sandboxBackend: "modal",
      modalTokenId: "ak-test",
      modalTokenSecret: "as-test",
    },
  });
});

test("a stored docker row on an Opengeni compute deployment fails visibly before any box or hook", async () => {
  const ctx = await fixture();
  const session = await storedSession(ctx, "docker");
  await expectRefusedBeforeAnySandboxWork({
    ctx,
    session,
    backend: "docker",
    settings: {
      sandboxBackend: "compute",
      computeApiUrl: "https://compute.invalid",
      computeApiKey: "compute-test-key",
    },
  });
});

test("a shared-box child inheriting its parent's local backend is refused the same way", async () => {
  const ctx = await fixture();
  const parent = await storedSession(ctx, "local");
  const child = await storedSession(ctx, "local", parent);
  expect(child.sandboxGroupId).toBe(parent.sandboxGroupId);
  expect(child.parentSessionId).toBe(parent.id);
  await expectRefusedBeforeAnySandboxWork({
    ctx,
    session: child,
    backend: "local",
    settings: {
      sandboxBackend: "modal",
      modalTokenId: "ak-test",
      modalTokenSecret: "as-test",
    },
  });
});

test("the default local backend on a development deployment still runs a turn", async () => {
  const ctx = await fixture();
  const session = await storedSession(ctx, "local");
  const scripted = new ScriptedModel([
    { inputTokens: 100, output: [assistantMessage("local turn finished")] },
  ]);
  const built: Settings["sandboxBackend"][] = [];
  const result = await runTurn(
    ctx,
    session.id,
    // Lazy provisioning: a text-only reply needs no box, so this proves the
    // refusal lets the deployment's own host backend through end to end.
    { sandboxBackend: "local", sandboxLazyProvisionEnabled: true },
    scripted,
    built,
  );

  expect(result).not.toMatchObject({ status: "failed" });
  expect(built).toContain("local");
  expect(scripted.calls).toBe(1);
  const timeline = await listSessionEvents(app.db, ctx.workspaceId, session.id, {
    after: 0,
    limit: 200,
  });
  expect(timeline.some((event) => event.type === "turn.failed")).toBe(false);
  expect(timeline.some((event) => event.type === "turn.completed")).toBe(true);
});

test("the default local backend on a development deployment still builds its box eagerly", async () => {
  const ctx = await fixture();
  const session = await storedSession(ctx, "local");
  const scripted = new ScriptedModel([
    { inputTokens: 100, output: [assistantMessage("eager local turn finished")] },
  ]);
  const built: Settings["sandboxBackend"][] = [];
  const hostBuild = spyOn(PROVIDER_REGISTRY.local, "build");
  let result: unknown;
  try {
    // Eager ownership: the turn builds the deployment's own host box (and runs
    // its setup) before the first model call.
    result = await runTurn(ctx, session.id, { sandboxBackend: "local" }, scripted, built);
    expect(hostBuild).toHaveBeenCalled();
  } finally {
    hostBuild.mockRestore();
  }

  expect(result).not.toMatchObject({ status: "failed" });
  expect(built).toContain("local");
  expect(scripted.calls).toBe(1);
  expect(await leaseCount(session.sandboxGroupId)).toBe(1);
  const timeline = await listSessionEvents(app.db, ctx.workspaceId, session.id, {
    after: 0,
    limit: 200,
  });
  expect(timeline.some((event) => event.type === "turn.failed")).toBe(false);
  expect(timeline.some((event) => event.type === "turn.completed")).toBe(true);
});
