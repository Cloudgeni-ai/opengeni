// Fresh-process fixture for home-client-repair.test.ts. Only external DB and
// provider boundaries are doubled; worker mutation and routing wiring are real.
import assert from "node:assert/strict";
import { mock } from "bun:test";
import type { EstablishedSandboxSession } from "@opengeni/runtime";
import type { SandboxTurnRuntimeDeps } from "../../src/activities/agent-turn/sandbox-runtime";

const scenario = process.argv[2]!;
const dbModule = await import("@opengeni/db");
const runtimeModule = await import("@opengeni/runtime");
const makeRealActiveBackendResolver = runtimeModule.makeActiveBackendResolver;
const { testSettings } = await import("@opengeni/testing");
const events: string[] = [];
const admission = { workspaceGeneration: 42 };
const failure = new Error("fixture repair failure");
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
const admitted = deferred();
const prepared = deferred();
const settled = deferred();
const allowAdmission = deferred();
const allowPreparation = deferred();
const allowSettlement = deferred();
const rawOld = { label: "old raw" };
const rawNew = { label: "replacement raw" };
const proxy = { label: "stable SDK proxy" };
const established = (session: unknown, instanceId: string, backendId = "modal") => ({
  session, instanceId, backendId, client: {}, sessionState: { instanceId },
}) as unknown as EstablishedSandboxSession;
const old = established(rawOld, "old-instance");
const replacement = established(rawNew, "new-instance");
let admissionIdentity: Record<string, unknown> | undefined;
let resumeCount = 0;
let resolveHome!: () => Promise<unknown>;
let hookCount = 0;
const commandFence = {
  runSandboxCommand() { assert.equal(this, commandFence); events.push("command"); },
};

mock.module("@opengeni/db", () => ({
  ...dbModule,
  advanceWorkspaceGeneration: async (_db: unknown, identity: Record<string, unknown>) => {
    events.push("admission");
    admissionIdentity = identity;
    admitted.resolve();
    await allowAdmission.promise;
    if (scenario === "admission-failure") throw failure;
    return admission;
  },
  verifyWorkspaceMutationSettlement: async (_db: unknown, identity: Record<string, unknown>) => {
    assert.deepEqual(identity, {
      ...admissionIdentity, admission,
      outcome: scenario === "preparation-failure" ? "rejected" : "resolved",
    });
    events.push("settlement");
    settled.resolve();
    await allowSettlement.promise;
    if (scenario === "settlement-failure") throw failure;
  },
  readLease: async () => ({
    leaseEpoch: 19, liveness: "warm", instanceId: scenario === "routing-unchanged" ? "old-instance" : "new-instance",
    backend: "modal", resumeBackendId: "modal", resumeState: { fixture: true },
    recovery: {
      provider: { status: "exists", instanceId: scenario === "routing-unchanged" ? "old-instance" : "new-instance" },
      workspace: { status: "ready" }, restore: { status: "ready" },
    },
  }),
}));
mock.module("@opengeni/runtime", () => ({
  ...runtimeModule,
  runManagedCodemodeClientHook: async (session: unknown, options: {
    environment: Record<string, string>; commandRunner: () => void;
  }) => {
    hookCount++;
    assert.equal(session, rawNew);
    assert.deepEqual(options.environment, {});
    assert.deepEqual(Object.keys(options).sort(), ["commandRunner", "environment"]);
    options.commandRunner();
    events.push("preparation");
    prepared.resolve();
    await allowPreparation.promise;
    if (scenario === "preparation-failure") throw failure;
  },
  establishSandboxSessionFromEnvelope: async (_settings: unknown, _state: unknown, options: unknown) => {
    assert.deepEqual(options, { sessionId: "session", recovery: "resume-only", backendOverride: "modal" });
    resumeCount++;
    return replacement;
  },
  verifySandboxExecReadiness: async (value: unknown) => { assert.equal(value, replacement); },
  sandboxProviderInstanceIdFromEnvelope: () => "new-instance",
  makeActiveBackendResolver: (options: Parameters<typeof runtimeModule.makeActiveBackendResolver>[0]) => {
    resolveHome = options.resolveDefaultBackend!;
    return makeRealActiveBackendResolver(options);
  },
}));

if (scenario.startsWith("routing-")) {
  const { wrapTurnBoxWithRouting } = await import("../../src/sandbox-routing");
  let callbackCount = 0;
  wrapTurnBoxWithRouting({
    db: {} as never, settings: testSettings(), opJournal: {} as never,
    onHomeSandboxRebound: async (value) => {
      callbackCount++;
      assert.equal(value.leaseEpoch, 19);
      assert.equal(value.established,
        scenario === "routing-unchanged" || (callbackCount > 1 && scenario !== "routing-rejection")
          ? old : replacement);
      prepared.resolve();
      await allowPreparation.promise;
      if (scenario === "routing-rejection") throw failure;
    },
  }, {
    workspaceId: "workspace", sessionId: "session",
    homeLease: { accountId: "account", sandboxGroupId: "group", backend: "modal" },
  }, old);
  let completed = false;
  const pending = resolveHome().then((value) => { completed = true; return value; });
  const result = pending.then((value) => ({ value }), (error: unknown) => ({ error }));
  await prepared.promise;
  assert.equal(completed, false);
  assert.equal(old.session, rawOld);
  assert.equal(old.instanceId, "old-instance");
  allowPreparation.resolve();
  const outcome = await result;
  if (scenario === "routing-rejection") {
    assert.deepEqual(outcome, { error: failure });
    assert.equal(old.session, rawOld);
    assert.equal(old.instanceId, "old-instance");
    // A rejected callback cannot poison the mutable home cache: retry resumes
    // the durable replacement again instead of accepting an unpublished handle.
    await assert.rejects(resolveHome(), (error) => error === failure);
    assert.equal(resumeCount, 2);
  } else {
    assert.equal(completed, true);
    assert.equal(old.session, scenario === "routing-unchanged" ? rawOld : rawNew);
    await resolveHome();
    assert.equal(resumeCount, scenario === "routing-unchanged" ? 0 : 1);
  }
  assert.equal(callbackCount, 2);
  assert.equal(hookCount, 0);
} else {
  const { createSandboxTurnRuntime } = await import("../../src/activities/agent-turn/sandbox-runtime");
  const eager = scenario !== "lazy";
  const current = { established: established(eager ? proxy : rawOld, "old-instance"), leaseEpoch: 3 };
  const state = {
    resolvedSandbox: current, setupBoxSession: rawOld,
    sandboxGroupId: "group", sandboxHolderId: "holder",
  } as unknown as SandboxTurnRuntimeDeps["sandboxState"];
  const runtime = createSandboxTurnRuntime({
    input: { accountId: "account", workspaceId: "workspace", sessionId: "session", attemptId: "attempt" },
    settings: testSettings(), db: {}, sandboxState: state,
    eventing: { toolCancellationFenceRef: { current: commandFence } },
    attempt: { turnId: "turn", executionGeneration: 7 },
    sandboxRotationController: new AbortController(),
  } as unknown as SandboxTurnRuntimeDeps);
  const rebound = scenario === "native" ? established(rawNew, "new-instance", "selfhosted")
    : scenario === "unchanged" ? established(rawNew, "old-instance") : replacement;
  const previousEstablished = current.established;
  const unchangedState = () => {
    assert.equal(state.setupBoxSession, rawOld);
    assert.equal(current.established, previousEstablished);
    assert.equal(current.leaseEpoch, 3);
  };
  const pending = runtime.onHomeSandboxRebound({ established: rebound, leaseEpoch: 19 });
  const result = pending.then(() => ({ error: undefined }), (error: unknown) => ({ error }));
  if (scenario === "native" || scenario === "unchanged") {
    assert.deepEqual(await result, { error: undefined });
    assert.equal(hookCount, 0);
    assert.deepEqual(events, []);
  } else {
    await admitted.promise;
    unchangedState();
    assert.equal(hookCount, 0);
    assert.deepEqual(admissionIdentity, {
      accountId: "account", workspaceId: "workspace", sessionId: "session", attemptId: "attempt",
      turnId: "turn", executionGeneration: 7, holderId: "holder", sandboxGroupId: "group",
      expectedEpoch: 19, expectedInstanceId: "new-instance", operation: "homeSandboxClientPreparation",
      captureWaitMs: admissionIdentity!.captureWaitMs,
    });
    assert.equal(typeof admissionIdentity!.captureWaitMs, "number");
    allowAdmission.resolve();
    if (scenario !== "admission-failure") {
      await prepared.promise;
      unchangedState();
      assert.deepEqual(events, ["admission", "command", "preparation"]);
      allowPreparation.resolve();
      await settled.promise;
      unchangedState();
      allowSettlement.resolve();
    }
    const outcome = await result;
    if (scenario.endsWith("failure")) {
      assert.ok(outcome.error);
      if (scenario === "settlement-failure") {
        assert.ok(outcome.error instanceof runtimeModule.RoutingMutationOutcomeUnknownError);
      } else assert.equal(outcome.error, failure);
      unchangedState();
      assert.equal(hookCount, scenario === "admission-failure" ? 0 : 1);
    } else {
      assert.equal(outcome.error, undefined);
      assert.equal(hookCount, 1);
    }
  }
  if (!scenario.endsWith("failure")) {
    assert.equal(state.setupBoxSession, rawNew);
    assert.equal(current.leaseEpoch, 19);
    assert.equal(current.established.instanceId, rebound.instanceId);
    assert.equal(current.established.backendId, rebound.backendId);
    assert.equal(current.established.session, eager ? proxy : rawNew);
    assert.equal(current.established.client, rebound.client);
    assert.equal(current.established.sessionState, rebound.sessionState);
  }
  assert.equal(resumeCount, 0);
}
console.log(`passed:${scenario}`);