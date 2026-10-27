import { afterAll, beforeAll, expect, test } from "bun:test";
import type { AccessGrant } from "@opengeni/contracts";
import {
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createSession,
  initializeSessionStartAtomically,
  createDb,
  scheduledTaskViewerSubject,
  withDatabaseTimingObserver,
  type DbClient,
} from "@opengeni/db";
import {
  acquireRestrictedRuntimeTestDatabase,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing/shared-pg";
import { creationInitiatorForGrant } from "../src/domain/sessions";
import { scheduledTaskViewerSubjectForGrant } from "../src/domain/scheduled-task-audience";
import { siteViewerForGrant } from "../src/domain/site-audience";

let fixture: RestrictedRuntimeTestDatabase;
let client: DbClient;
let grant: AccessGrant;
beforeAll(async () => {
  const acquired = await acquireRestrictedRuntimeTestDatabase("audience-viewer");
  if (!acquired) throw new Error("Real PostgreSQL is required");
  fixture = acquired;
  client = createDb(fixture.appUrl, { searchPath: fixture.schema });
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "audience-viewer",
    accountExternalId: suffix,
    accountName: "Audience viewer",
    workspaceExternalSource: "audience-viewer",
    workspaceExternalId: suffix,
    workspaceName: "Audience viewer",
    subjectId: `user:${suffix}`,
  });
  grant = { ...access.workspaceGrants[0]!, principalKind: "human_session" };
}, 180_000);
afterAll(async () => {
  await client?.close();
  await fixture?.release();
}, 60_000);

async function previousViewer(input: AccessGrant) {
  const creator = creationInitiatorForGrant(input);
  return scheduledTaskViewerSubject(client.db, {
    workspaceId: input.workspaceId,
    ...(creator.initiator ? { createdBy: creator.initiator } : {}),
    ...(creator.context ? { createdByContext: creator.context } : {}),
    createdByActor: creator.actor ?? null,
  });
}
async function observed<T>(work: () => Promise<T>) {
  let transactions = 0;
  const result = await withDatabaseTimingObserver((event) => {
    if (event.stage === "transaction_admission") transactions++;
  }, work);
  return { result, transactions };
}
async function outcome(work: () => Promise<unknown>) {
  try {
    return { value: await work() };
  } catch (error) {
    return { name: (error as Error).name, message: (error as Error).message };
  }
}

test("immutable human/service audience projection matches PostgreSQL without opening an empty scope", async () => {
  const inputs: AccessGrant[] = [
    grant,
    { ...grant, subjectId: "external_user:viewer" },
    { ...grant, metadata: { delegated: true } },
    { ...grant, principalKind: "service", subjectId: "service:viewer" },
    { ...grant, principalKind: "api_key", subjectId: "api_key:" + crypto.randomUUID() },
    { ...grant, principalKind: "configured_key", subjectId: "configured:viewer" },
    { ...grant, subjectId: "api_key:" + crypto.randomUUID() },
    { ...grant, serviceInitiator: { kind: "service", subjectId: "host:job" } },
  ];
  for (const input of inputs) {
    const before = await observed(() => previousViewer(input));
    const after = await observed(() => scheduledTaskViewerSubjectForGrant(client.db, input));
    const site = await observed(() => siteViewerForGrant(client.db, input));
    expect(after.result).toEqual(before.result);
    expect(site.result).toEqual({ subjectId: before.result });
    expect(before.transactions).toBe(1);
    expect(after.transactions).toBe(0);
    expect(site.transactions).toBe(0);
  }
  console.info(
    "audience-viewer-work",
    JSON.stringify({
      cases: inputs.length,
      beforeTransactionsPerCall: 1,
      afterTransactionsPerCall: 0,
    }),
  );
});

test("malformed signed initiators and incomplete attempts retain their exact denial", async () => {
  const inputs = [
    { ...grant, serviceInitiatorContext: { job: "42" } },
    { ...grant, serviceInitiator: { kind: "subject", subjectId: grant.subjectId } },
    { ...grant, metadata: { turnId: crypto.randomUUID() } },
    {
      ...grant,
      serviceInitiator: { kind: "service", subjectId: "host:job" },
      metadata: { turnId: crypto.randomUUID() },
    },
  ] as AccessGrant[];
  for (const input of inputs) {
    const before = await outcome(() => previousViewer(input));
    expect(before).toHaveProperty("message");
    expect(await outcome(() => scheduledTaskViewerSubjectForGrant(client.db, input))).toEqual(
      before,
    );
    expect(await outcome(() => siteViewerForGrant(client.db, input))).toEqual(before);
  }
});

test("an exact-shaped but stale agent still enters the live PostgreSQL authority boundary", async () => {
  const input: AccessGrant = {
    ...grant,
    principalKind: "agent_attempt",
    metadata: {
      sessionId: crypto.randomUUID(),
      turnId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      executionGeneration: 1,
    },
  };
  const before = await observed(() => outcome(() => previousViewer(input)));
  const after = await observed(() =>
    outcome(() => scheduledTaskViewerSubjectForGrant(client.db, input)),
  );
  const site = await observed(() => outcome(() => siteViewerForGrant(client.db, input)));
  expect(before.result).toHaveProperty("message");
  expect(after.result).toEqual(before.result);
  expect(site.result).toEqual(before.result);
  expect(before.transactions).toBe(1);
  expect(after.transactions).toBe(1);
  expect(site.transactions).toBe(1);
});

test("a live agent derives the frozen initiating human instead of its technical bearer subject", async () => {
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    initialMessage: "Audience fixture",
    resources: [],
    metadata: {},
    createdBy: { kind: "subject", subjectId: grant.subjectId },
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  const start = await initializeSessionStartAtomically(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    sessionId: session.id,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
  });
  if (!start.turn) throw new Error("Fixture turn did not start");
  const attemptId = crypto.randomUUID();
  const claim = await claimSessionWorkForAttempt(client.db, grant.workspaceId, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  if (claim.action !== "claimed") throw new Error("Fixture attempt was not claimed");
  const agent: AccessGrant = {
    ...grant,
    subjectId: "service:agent-turn",
    principalKind: "agent_attempt",
    metadata: {
      sessionId: session.id,
      turnId: start.turn.id,
      attemptId,
      executionGeneration: claim.turn.executionGeneration,
    },
  };
  const before = await observed(() => previousViewer(agent));
  const after = await observed(() => scheduledTaskViewerSubjectForGrant(client.db, agent));
  const site = await observed(() => siteViewerForGrant(client.db, agent));
  expect(before.result).toBe(grant.subjectId);
  expect(after.result).toBe(before.result);
  expect(site.result).toEqual({ subjectId: grant.subjectId });
  expect(before.transactions).toBe(1);
  expect(after.transactions).toBe(1);
  expect(site.transactions).toBe(1);
  const superseded = {
    ...agent,
    metadata: { ...agent.metadata, executionGeneration: claim.turn.executionGeneration + 1 },
  };
  const denial = await outcome(() => previousViewer(superseded));
  expect(denial).toHaveProperty("message");
  expect(await outcome(() => scheduledTaskViewerSubjectForGrant(client.db, superseded))).toEqual(
    denial,
  );
  expect(await outcome(() => siteViewerForGrant(client.db, superseded))).toEqual(denial);
});
