import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import * as core from "@opengeni/core";
import * as opengeniDb from "@opengeni/db";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  maintainSessionUsageLimits,
  readSessionUsageLimit,
  setSessionUsageLimitInTransaction,
  withWorkspaceSubjectSessionActivityRls,
} from "@opengeni/db";
import * as runtimeModelCall from "@opengeni/runtime/model-call";
import {
  acquireRestrictedRuntimeTestDatabase,
  testSettings,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing";
import * as rls from "../src/access-grant-rls";
import { PendingUsageSettlements } from "../src/model-calls/pending-usage-settlements";
import { createModelCallService } from "../src/model-calls/service";

// F2/AC13: an attempt's single model call keeps durable custody of its task
// usage in PostgreSQL (production posture), not in one API process. A receipt
// whose write fails is fenced so EVERY replica refuses the task's next call
// until the owner fills it, and a marker whose owner died is disclosed as
// unpriced by maintenance. The provider is never called again for it.
setDefaultTimeout(120_000);
let shared: RestrictedRuntimeTestDatabase;
let client: ReturnType<typeof createDb>;
const restores: Array<() => void> = [];

beforeAll(async () => {
  const acquired = await acquireRestrictedRuntimeTestDatabase("session-usage-custody-api");
  if (!acquired) throw new Error("Session usage custody tests require PostgreSQL");
  shared = acquired;
  client = createDb(shared.appUrl, { searchPath: shared.schema });
}, 600_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);
afterEach(() => {
  while (restores.length > 0) restores.pop()?.();
});

function spy<T extends object, K extends keyof T>(target: T, key: K, impl: unknown) {
  const mocked = spyOn(target, key as never).mockImplementation(impl as never);
  restores.push(() => mocked.mockRestore());
  return mocked;
}

const settings = testSettings({
  billingMode: "disabled",
  sandboxBackend: "none",
  modelPricingJson: JSON.stringify({
    "scripted-model": { inputMicrosPerMillionTokens: 1_000_000, outputMicrosPerMillionTokens: 0 },
  }),
});

async function fixture() {
  const subjectId = `user:custody-${crypto.randomUUID()}`;
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "custody",
    accountExternalId: crypto.randomUUID(),
    accountName: "Custody",
    workspaceExternalSource: "custody",
    workspaceExternalId: crypto.randomUUID(),
    workspaceName: "Custody",
    subjectId,
  });
  const grant = access.workspaceGrants[0]!;
  const scope = { accountId: grant.accountId, workspaceId: grant.workspaceId!, subjectId };
  const session = await createSession(client.db, {
    accountId: scope.accountId,
    workspaceId: scope.workspaceId,
    createdBy: { kind: "subject", subjectId },
    initialMessage: "Single calls",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "low",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  const result = await withWorkspaceSubjectSessionActivityRls(
    client.db,
    scope.workspaceId,
    subjectId,
    async (tx) =>
      await setSessionUsageLimitInTransaction(tx, {
        accountId: scope.accountId,
        workspaceId: scope.workspaceId,
        sessionId: session.id,
        limitMicros: 1_000_000,
        expectedVersion: 0,
        operationId: crypto.randomUUID(),
        actor: { subjectId, type: "human" },
        producerEnabled: true,
      }),
  );
  expect(result.outcome).toBe("ok");
  return { ...scope, sessionId: session.id };
}
type Scope = Awaited<ReturnType<typeof fixture>>;

function offlineModel() {
  const selection = {
    model: {
      id: "scripted-model",
      label: "Scripted",
      providerLabel: "Offline",
      credentialSource: { kind: "deployment" },
      billing: { metering: "none", upstreamPayer: "deployment" },
      capabilities: { inputModalities: ["text"], structuredOutput: { runnable: true } },
    },
  };
  spy(
    rls,
    "withAccessGrantSessionRlsContext",
    async (_d: unknown, _g: unknown, fn: () => unknown) => fn(),
  );
  spy(core, "resolveWorkspaceCatalogSettings", async () => ({ settings }));
  spy(core, "resolveCallerWorkspaceModelSelections", async () => [selection]);
  spy(core, "admissibleWorkspaceModel", () => selection);
  spy(core, "admitModelCall", async () => ({ allowed: true }));
  spy(core, "settingsWithModelProviderCredentials", async () => settings);
  spy(runtimeModelCall.MultiProviderModelProvider.prototype, "resolveBinding", () => ({
    client: {},
    provider: { id: "offline" },
    modelId: "scripted-model",
  }));
  // 1,000 input tokens at $1/M = 1,000 micros per call.
  return spy(runtimeModelCall, "runSingleModelCall", async () => ({
    text: "answer",
    // The normalized shape the real transport returns (modelResponseUsageFromResponse).
    usage: { usage: { inputTokens: 1_000, outputTokens: 0, totalTokens: 1_000 } },
  }));
}

/** One API replica: its own process memory, the shared database. */
function replica() {
  const pending = new PendingUsageSettlements({ schedule: () => undefined });
  return {
    pending,
    service: createModelCallService({ db: client.db, settings, pendingUsageSettlements: pending }),
  };
}

function call(service: ReturnType<typeof replica>["service"], scope: Scope, requestId: string) {
  return service.call({
    grant: {
      accountId: scope.accountId,
      workspaceId: scope.workspaceId,
      subjectId: scope.subjectId,
      permissions: [],
      principalKind: "agent_attempt",
      metadata: { sessionId: scope.sessionId, turnId: crypto.randomUUID(), attemptId: "a" },
    },
    accountId: scope.accountId,
    workspaceId: scope.workspaceId,
    subjectId: scope.subjectId,
    model: "scripted-model",
    request: { messages: [{ role: "user", content: "hi" }] } as never,
    requestId,
  });
}

async function state(scope: Scope) {
  const read = await readSessionUsageLimit(client.db, {
    accountId: scope.accountId,
    workspaceId: scope.workspaceId,
    sessionId: scope.sessionId,
  });
  if (read.outcome !== "ok") throw new Error(read.outcome);
  return read.state;
}

async function markers(scope: Scope) {
  return await shared.admin<Array<{ source_id: string; status: string; fenced: boolean }>>`
    select source_id, status, fenced from opengeni_private.session_usage_limit_receipts
      where source_session_id = ${scope.sessionId} order by source_id`;
}

function failReceiptOnce(sourceId: string) {
  const original = opengeniDb.settleSessionUsageReceipt;
  let failed = false;
  return spy(
    opengeniDb,
    "settleSessionUsageReceipt",
    async (db: never, input: { sourceId: string }) => {
      if (!failed && input.sourceId === sourceId) {
        failed = true;
        throw Object.assign(new Error("permission denied for function"), { code: "42501" });
      }
      return await original(db, input as never);
    },
  );
}

test("a fenced receipt blocks the task on another replica until the owner fills it; no provider replay", async () => {
  const scope = await fixture();
  const provider = offlineModel();
  const a = replica();
  const b = replica();
  failReceiptOnce("model_call:req-1");
  const first = await call(a.service, scope, "req-1");
  expect(first.result).toMatchObject({ text: "answer" });
  expect(await markers(scope)).toEqual([
    { source_id: "model_call:req-1", status: "pending", fenced: true },
  ]);
  // Replica B never saw the failure: the durable fence still refuses it.
  const blocked = await call(b.service, scope, "req-2").catch((error: unknown) => error);
  expect(blocked).toMatchObject({ status: 503, code: "session_usage_limit_unavailable" });
  expect(provider).toHaveBeenCalledTimes(1);
  expect(await state(scope)).toMatchObject({ coverage: "partial" });
  // Replica A's DB-only retry fills the marker with the original amount.
  await a.pending.flush(scope.sessionId);
  await call(b.service, scope, "req-3");
  expect(provider).toHaveBeenCalledTimes(2);
  expect(await markers(scope)).toEqual([
    { source_id: "model_call:req-1", status: "priced", fenced: false },
    { source_id: "model_call:req-3", status: "priced", fenced: false },
  ]);
  expect(await state(scope)).toMatchObject({
    usedMicros: 2_000,
    pricedCalls: 2,
    coverage: "complete",
  });
});

test("a marker whose owning process died is disclosed as unpriced by maintenance, then the task continues", async () => {
  const scope = await fixture();
  const provider = offlineModel();
  const crashed = replica();
  failReceiptOnce("model_call:lost-1");
  await call(crashed.service, scope, "lost-1");
  // The process dies: its retained settlement is gone, the fenced marker is not.
  const survivor = replica();
  const blocked = await call(survivor.service, scope, "after-crash").catch((e: unknown) => e);
  expect(blocked).toMatchObject({ status: 503 });
  await shared.admin`update opengeni_private.session_usage_limit_receipts
    set recorded_at = now() - interval '31 minutes'
    where source_session_id = ${scope.sessionId} and status = 'pending'`;
  const maintenance = await maintainSessionUsageLimits(client.db, { limit: 50, budget: 50 });
  expect(maintenance.resolvedLost).toBeGreaterThanOrEqual(1);
  expect(await state(scope)).toMatchObject({
    usedMicros: 0,
    unpricedCalls: 1,
    coverage: "partial",
  });
  await call(survivor.service, scope, "after-resolution");
  expect(provider).toHaveBeenCalledTimes(2);
  expect(await state(scope)).toMatchObject({ usedMicros: 1_000, unpricedCalls: 1 });
});

test("a provider error releases the marker on the real database", async () => {
  const scope = await fixture();
  const provider = offlineModel();
  provider.mockImplementationOnce(async () => {
    throw new Error("upstream reset");
  });
  const { service } = replica();
  await call(service, scope, "reset-1").catch(() => undefined);
  expect(await markers(scope)).toEqual([]);
  await call(service, scope, "reset-2");
  expect(await markers(scope)).toEqual([
    { source_id: "model_call:reset-2", status: "priced", fenced: false },
  ]);
});
