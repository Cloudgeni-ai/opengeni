import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  acquireRestrictedRuntimeTestDatabase,
  assistantMessage,
  MemoryEventBus,
  ScriptedModel,
  testSettings,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing";
import {
  applyCreditLedgerEntry,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  expirePlanCreditPeriod,
  freezeAgentLearningPolicy,
  grantPlanCreditPeriod,
  initializeSessionStartAtomically,
  listSessionEvents,
  nestedPostgresSqlState,
  setInitialSessionUsageLimitInTransaction,
  upsertOrganizationPlan,
  withSessionRlsActorContext,
  withSiteViewerRlsContext,
  withWorkspaceSessionActivityRls,
} from "@opengeni/db";
import { createProductionAgentRuntime, type OpenGeniRuntime } from "@opengeni/runtime";
import { createActivityTestHarness } from "../src/activities";

// Regression for the 19 October 2026 production failure: every "Anyone with
// the link" AI turn on a Site published from a personal workspace failed right
// after turn.started with db_failure 42501 (exec_stmt_raise), before any model
// call. The learning snapshot derived a Personal destination from the
// workspace kind and refused it because a guest turn has no initiating human.

// The deployed posture: a NOSUPERUSER migration owner, a dedicated data schema
// and the restricted application role under FORCE RLS.
let shared: RestrictedRuntimeTestDatabase;
let app: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireRestrictedRuntimeTestDatabase("site-guest-personal-workspace");
  if (!acquired) throw new Error("PostgreSQL required");
  shared = acquired;
  app = createDb(shared.appUrl, { searchPath: shared.schema });
}, 600_000);
afterAll(async () => {
  await app?.close();
  await shared?.release();
}, 60_000);

type Posture = "production" | "restricted";

// Production's migration owner, which owns the SECURITY DEFINER routines, has
// BYPASSRLS; the documented posture (this fixture's dedicated owner role) does
// not. Exercise both so owner posture can neither hide nor cause the failure.
// The owner role belongs to this test database alone and is created NOBYPASSRLS.
async function inPosture<T>(posture: Posture, fn: () => Promise<T>): Promise<T> {
  if (posture === "restricted") return await fn();
  const owner = `"${shared.ownerRole.replaceAll('"', '""')}"`;
  const [routine] = await shared.admin<Array<{ owner: string }>>`
    select pg_get_userbyid(proowner)::text as owner from pg_proc
    where oid='knowledge_learning_for_turn(uuid,uuid,uuid)'::regprocedure`;
  // The toggle is meaningful only if the routines run as this owner.
  if (routine?.owner !== shared.ownerRole) throw new Error("Learning routines are not owner-owned");
  await shared.admin.unsafe(`ALTER ROLE ${owner} BYPASSRLS`);
  try {
    return await fn();
  } finally {
    await shared.admin.unsafe(`ALTER ROLE ${owner} NOBYPASSRLS`);
  }
}

/** The production organization's shape: one owner whose personal workspace publishes the Site,
 * a plan row left on Free after a paid period expired, and optionally spendable credit. */
async function personalWorkspaceSite(input: { funded: boolean; personal?: boolean }) {
  const accountId = crypto.randomUUID(),
    workspaceId = crypto.randomUUID(),
    siteId = crypto.randomUUID(),
    versionId = crypto.randomUUID(),
    owner = `user:${crypto.randomUUID()}`;
  await shared.admin`insert into managed_accounts(id,name) values(${accountId},'Guest Site')`;
  await shared.admin`insert into workspaces(id,account_id,name) values(${workspaceId},${accountId},'Guest Site')`;
  await shared.admin`insert into workspace_inference_controls(workspace_id,account_id) values(${workspaceId},${accountId})`;
  // A shared-workspace control gives the owner a separate personal workspace.
  const personalWorkspaceId = input.personal === false ? crypto.randomUUID() : workspaceId;
  if (personalWorkspaceId !== workspaceId) {
    await shared.admin`insert into workspaces(id,account_id,name) values(${personalWorkspaceId},${accountId},'Personal')`;
  }
  await shared.admin`insert into organization_memberships(account_id,subject_id,role,status,personal_workspace_id)
    values(${accountId},${owner},'owner','active',${personalWorkspaceId})`;
  await shared.admin.begin(async (tx) => {
    await tx`insert into workspace_artifacts(id,account_id,workspace_id,slug,title,current_version_id,created_by_subject_id)
      values(${siteId},${accountId},${workspaceId},'guest','Guest Site',${versionId},${owner})`;
    await tx`insert into workspace_artifact_versions(id,account_id,workspace_id,artifact_id,revision,content_key,content_sha256,size_bytes,operation_key,created_by_subject_id)
      values(${versionId},${accountId},${workspaceId},${siteId},1,'fixture',${"a".repeat(64)},1,'fixture',${owner})`;
  });
  const periodStart = new Date(Date.now() - 7_200_000);
  const periodEnd = new Date(Date.now() + 3_600_000);
  const stripeSubscriptionId = `sub_${crypto.randomUUID()}`;
  const plan = {
    accountId,
    status: "active",
    cancelAtPeriodEnd: false,
  } as const;
  await upsertOrganizationPlan(app.db, {
    ...plan,
    planKey: "pro",
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
    stripeSubscriptionId,
  });
  const period = await grantPlanCreditPeriod(app.db, {
    accountId,
    planKey: "pro",
    periodStart,
    periodEnd,
    stripeSubscriptionId,
  });
  await expirePlanCreditPeriod(app.db, { accountId, periodId: period.id, force: true });
  await upsertOrganizationPlan(app.db, {
    ...plan,
    planKey: "free",
    currentPeriodStart: null,
    currentPeriodEnd: null,
    stripeSubscriptionId: null,
  });
  if (input.funded) {
    await applyCreditLedgerEntry(app.db, {
      accountId,
      workspaceId,
      type: "purchase",
      amountMicros: 10_000_000,
      idempotencyKey: crypto.randomUUID(),
    });
  }
  return { accountId, workspaceId, siteId, owner };
}

async function startGuestSession(site: Awaited<ReturnType<typeof personalWorkspaceSite>>) {
  const { accountId, workspaceId, siteId } = site;
  const principal = `guest:${crypto.randomUUID()}`;
  const sessionId = crypto.randomUUID();
  await shared.admin`insert into site_runtime_conversations(session_id,account_id,workspace_id,site_id,viewer_principal,viewer_kind,limit_micros,reserved_micros)
    values(${sessionId},${accountId},${workspaceId},${siteId},${principal},'guest',250000,0)`;
  await withSiteViewerRlsContext({ siteId, principal }, () =>
    withSessionRlsActorContext({ subjectId: `site:${siteId}` }, () =>
      createSession(app.db, {
        requestedSessionId: sessionId,
        accountId,
        workspaceId,
        initialMessage: "Hello from a guest",
        resources: [],
        tools: [],
        metadata: {},
        model: "scripted-model",
        reasoningEffort: "medium",
        latencyMode: "standard",
        sandboxBackend: "none",
        createdBy: { kind: "service", subjectId: `site:${siteId}` },
      }),
    ),
  );
  // The Site host stamps a per-conversation usage limit, as in production.
  await withWorkspaceSessionActivityRls(app.db, workspaceId, (tx) =>
    setInitialSessionUsageLimitInTransaction(tx, {
      accountId,
      workspaceId,
      sessionId,
      limitMicros: 250_000,
      actor: { subjectId: `site:${siteId}`, type: "host" },
      producerEnabled: true,
    }),
  );
  const started = await initializeSessionStartAtomically(app.db, {
    accountId,
    workspaceId,
    sessionId,
    reasoningEffortFallback: "medium",
    createdEventPayload: {},
  });
  return { sessionId, workflowId: started.temporalWorkflowId };
}

function harness(model: ScriptedModel) {
  const production = createProductionAgentRuntime({ model });
  type ResolvedTurnModel = ReturnType<OpenGeniRuntime["resolveTurnModel"]>;
  // An offline model needs only the fields the turn reads; the full deployment
  // catalog shape is irrelevant to this regression.
  const resolved = {
    provider: { id: "test-chat", label: "Offline", kind: "api-key", api: "chat", builtin: false },
    client: {},
    model,
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
  } as unknown as ResolvedTurnModel;
  const runtime: OpenGeniRuntime = {
    ...production,
    configure: () => {},
    resolveTurnModel: () => resolved,
  };
  const settings = testSettings({
    databaseUrl: shared.appUrl,
    openaiModel: "scripted-model",
    sandboxBackend: "none",
    billingMode: "stripe",
    usageLimitsMode: "managed",
    modelPricingJson: JSON.stringify({
      "scripted-model": { inputMicrosPerMillionTokens: 1_000_000, outputMicrosPerMillionTokens: 0 },
    }),
  });
  return createActivityTestHarness({ settings, db: app.db, bus: new MemoryEventBus(), runtime });
}

async function turnEvents(workspaceId: string, sessionId: string) {
  return (await listSessionEvents(app.db, workspaceId, sessionId, { after: 0, limit: 100 }))
    .filter((event) => event.type.startsWith("turn."))
    .map((event) => ({ type: event.type, payload: event.payload as Record<string, unknown> }));
}

for (const posture of ["production", "restricted"] as const) {
  test(`a funded guest turn on a personal-workspace Site reaches the model (${posture} owner)`, async () => {
    const site = await personalWorkspaceSite({ funded: true });
    const guest = await startGuestSession(site);
    const model = new ScriptedModel([{ inputTokens: 10, output: [assistantMessage("Hi guest")] }]);
    const result = await inPosture(posture, () =>
      harness(model).runAgentTurn({
        accountId: site.accountId,
        workspaceId: site.workspaceId,
        sessionId: guest.sessionId,
        workflowId: guest.workflowId,
        workflowRunId: crypto.randomUUID(),
        attemptId: crypto.randomUUID(),
        trigger: { kind: "next" },
      }),
    );
    const events = await turnEvents(site.workspaceId, guest.sessionId);
    expect(events.find((event) => event.type === "turn.failed")).toBeUndefined();
    expect(result.status).toBe("idle");
    expect(model.calls).toBe(1);
    expect(events.at(-1)).toMatchObject({
      type: "turn.completed",
      payload: { output: "Hi guest" },
    });
    // The guest's agent never holds the owner's Personal layer.
    // It reads but saves nothing in the personal workspace's hidden Workspace layer.
    const [snapshot] = await shared.admin<
      Array<{ scope: string; subject: string | null; effective: Record<string, string> }>
    >`
      select snapshot->>'defaultScope' as scope, snapshot->>'subjectId' as subject,
        snapshot->'effective' as effective
      from agent_learning_snapshots where session_id=${guest.sessionId}`;
    expect(snapshot).toEqual({
      scope: "workspace",
      subject: null,
      effective: { knowledge: "off", instructions: "off", skills: "off" },
    });
  }, 120_000);

  test(`a zero-balance guest turn on a personal-workspace Site is refused for credit, not 42501 (${posture} owner)`, async () => {
    const site = await personalWorkspaceSite({ funded: false });
    const guest = await startGuestSession(site);
    const model = new ScriptedModel([{ inputTokens: 10, output: [assistantMessage("unused")] }]);
    const refused = await inPosture(posture, () =>
      harness(model).runAgentTurn({
        accountId: site.accountId,
        workspaceId: site.workspaceId,
        sessionId: guest.sessionId,
        workflowId: guest.workflowId,
        workflowRunId: crypto.randomUUID(),
        attemptId: crypto.randomUUID(),
        trigger: { kind: "next" },
      }),
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(Error);
    expect((refused as Error).message).toBe("insufficient Opengeni credits");
    expect(nestedPostgresSqlState(refused) ?? null).toBeNull();
    expect(model.calls).toBe(0);
    expect(
      (await turnEvents(site.workspaceId, guest.sessionId)).map((event) => event.type),
    ).not.toContain("turn.failed");
  }, 120_000);
}

async function claimForLearning(
  site: { accountId: string; workspaceId: string },
  sessionId: string,
  workflowId: string,
) {
  const attemptId = crypto.randomUUID();
  const claim = await claimSessionWorkForAttempt(app.db, site.workspaceId, {
    sessionId,
    workflowId,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  if (claim.action !== "claimed") throw new Error(`Claim failed: ${claim.reason}`);
  return {
    accountId: site.accountId,
    workspaceId: site.workspaceId,
    actor: {
      kind: "agent" as const,
      sessionId,
      turnId: claim.turn.id,
      attemptId,
      executionGeneration: claim.turn.executionGeneration,
    },
  };
}

test("the owner keeps Personal learning in the personal workspace; a human-less user-memory session still refuses", async () => {
  const site = await personalWorkspaceSite({ funded: true });
  const own = await createSession(app.db, {
    accountId: site.accountId,
    workspaceId: site.workspaceId,
    initialMessage: "Owner turn",
    resources: [],
    tools: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    createdBy: { kind: "subject", subjectId: site.owner },
  });
  const ownStart = await initializeSessionStartAtomically(app.db, {
    accountId: site.accountId,
    workspaceId: site.workspaceId,
    sessionId: own.id,
    reasoningEffortFallback: "medium",
    createdEventPayload: {},
  });
  const ownPolicy = await freezeAgentLearningPolicy(
    app.db,
    await claimForLearning(site, own.id, ownStart.temporalWorkflowId),
  );
  expect(ownPolicy).toMatchObject({ defaultScope: "personal", subjectId: site.owner });
  expect(ownPolicy.effective.skills).not.toBe("off");

  // A session that explicitly chose user memory still needs its verified owner.
  const guest = await startGuestSession(site);
  await shared.admin`update sessions set memory_scope='user' where id=${guest.sessionId}`;
  const refused = await freezeAgentLearningPolicy(
    app.db,
    await claimForLearning(site, guest.sessionId, guest.workflowId),
  ).then(
    () => null,
    (error: unknown) => error,
  );
  expect(nestedPostgresSqlState(refused)).toBe("42501");
  expect(String((refused as { cause?: Error }).cause?.message)).toMatch(
    /^Personal Knowledge requires the verified initiating owner$/,
  );
}, 120_000);

test("human-less work never takes over the owner's private chat", async () => {
  const site = await personalWorkspaceSite({ funded: true });
  const guest = await startGuestSession(site);
  // Fixture state only: skip the visibility-transition fences, which guard the
  // product path to a private chat rather than the learning check under test.
  await shared.admin.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`update sessions s set visibility='user_private', owner_subject_id=m.subject_id,
        owner_organization_membership_id=m.id
      from organization_memberships m
      where s.id=${guest.sessionId} and m.account_id=s.account_id and m.subject_id=${site.owner}`;
  });
  const refused = await freezeAgentLearningPolicy(
    app.db,
    await claimForLearning(site, guest.sessionId, guest.workflowId),
  ).then(
    () => null,
    (error: unknown) => error,
  );
  expect(nestedPostgresSqlState(refused)).toBe("42501");
  expect(String((refused as { cause?: Error }).cause?.message)).toMatch(
    /^Personal Knowledge requires the verified initiating owner$/,
  );
}, 120_000);

test("other human-less work in a personal workspace starts, reads Workspace and saves nothing", async () => {
  const site = await personalWorkspaceSite({ funded: true });
  const subjectId = `api_key:${crypto.randomUUID()}`;
  const session = await withSessionRlsActorContext({ subjectId }, () =>
    createSession(app.db, {
      accountId: site.accountId,
      workspaceId: site.workspaceId,
      initialMessage: "Service turn",
      resources: [],
      tools: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      createdBy: { kind: "service", subjectId },
    }),
  );
  const started = await initializeSessionStartAtomically(app.db, {
    accountId: site.accountId,
    workspaceId: site.workspaceId,
    sessionId: session.id,
    reasoningEffortFallback: "medium",
    createdEventPayload: {},
  });
  const policy = await freezeAgentLearningPolicy(
    app.db,
    await claimForLearning(site, session.id, started.temporalWorkflowId),
  );
  expect(policy).toMatchObject({
    defaultScope: "workspace",
    subjectId: null,
    effective: { knowledge: "off", instructions: "off", skills: "off" },
  });
}, 120_000);

test("a guest turn on a shared-workspace Site keeps its workspace learning destination", async () => {
  const site = await personalWorkspaceSite({ funded: true, personal: false });
  const guest = await startGuestSession(site);
  const policy = await freezeAgentLearningPolicy(
    app.db,
    await claimForLearning(site, guest.sessionId, guest.workflowId),
  );
  expect(policy).toMatchObject({ defaultScope: "workspace", subjectId: null });
  // Shared workspaces keep their visible Workspace learning modes.
  expect(policy.effective.skills).not.toBe("off");
}, 120_000);
