import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as core from "@opengeni/core";
import { ModelCallError } from "@opengeni/core";
import * as opengeniDb from "@opengeni/db";
import type { Database } from "@opengeni/db";
import * as runtimeModelCall from "@opengeni/runtime/model-call";
import { testSettings } from "@opengeni/testing";
import * as rls from "../src/access-grant-rls";
import { createModelCallService } from "../src/model-calls/service";

// OPE-798 AC06: an attempt-authenticated single-model call (an agent's code
// calling the chat completions API with its attempt credential) counts
// against that task's usage limit and is refused once it is reached. Calls by
// people, hosts and services have no task and are unaffected.
const ACCOUNT = "00000000-0000-4000-8000-0000000000a1";
const WORKSPACE = "00000000-0000-4000-8000-0000000000a2";
const SESSION = "00000000-0000-4000-8000-0000000000a3";
const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length > 0) restores.pop()?.();
});

function spy<T extends object, K extends keyof T>(target: T, key: K, impl: unknown) {
  const mocked = spyOn(target, key as never).mockImplementation(impl as never);
  restores.push(() => mocked.mockRestore());
  return mocked;
}

function harness(
  admission: Awaited<ReturnType<typeof opengeniDb.checkSessionUsageLimitAdmission>>,
) {
  const settings = testSettings();
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
  const admit = spy(core, "admitModelCall", async () => ({ allowed: true }));
  spy(core, "settingsWithModelProviderCredentials", async () => settings);
  spy(runtimeModelCall.MultiProviderModelProvider.prototype, "resolveBinding", () => ({
    client: {},
    provider: { id: "offline" },
    modelId: "scripted-model",
  }));
  const provider = spy(runtimeModelCall, "runSingleModelCall", async () => ({
    text: "answer",
    usage: { usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } },
  }));
  const settle = spy(core, "settleModelUsage", async () => ({}));
  const check = spy(opengeniDb, "checkSessionUsageLimitAdmission", async () => admission);
  const service = createModelCallService({ db: {} as Database, settings });
  return { service, admit, provider, settle, check };
}

function call(
  service: ReturnType<typeof createModelCallService>,
  principalKind: "agent_attempt" | "human_session" | "api_key",
) {
  return service.call({
    grant: {
      accountId: ACCOUNT,
      workspaceId: WORKSPACE,
      subjectId: "user:alice",
      permissions: [],
      principalKind,
      ...(principalKind === "agent_attempt"
        ? { metadata: { sessionId: SESSION, turnId: "t", attemptId: "a" } }
        : {}),
    },
    accountId: ACCOUNT,
    workspaceId: WORKSPACE,
    subjectId: "user:alice",
    model: "scripted-model",
    request: { messages: [{ role: "user", content: "hi" }] } as never,
    requestId: "req-1",
  });
}

describe("single-model calls and task usage limits", () => {
  test("a reached task limit refuses an attempt's call before admission or provider dispatch", async () => {
    const h = harness({
      allowed: false,
      state: null as never,
      refusal: {
        code: "session_usage_limit_reached",
        basis: "model_api_equivalent_v1",
        rootSessionId: SESSION,
        limitMicros: 100,
        usedMicros: 120,
        message: "This task's usage limit is reached.",
      },
    });
    const error = await call(h.service, "agent_attempt").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ModelCallError);
    expect(error).toMatchObject({
      status: 402,
      type: "insufficient_quota",
      code: "session_usage_limit_reached",
    });
    expect(h.check).toHaveBeenCalledTimes(1);
    expect(h.check.mock.calls[0]![1]).toMatchObject({ sessionId: SESSION });
    expect(h.admit).not.toHaveBeenCalled();
    expect(h.provider).not.toHaveBeenCalled();
    expect(h.settle).not.toHaveBeenCalled();
  });

  test("an unreadable usage state refuses the attempt's call, never unlimited", async () => {
    const h = harness({ allowed: true, state: null });
    h.check.mockImplementation(async () => {
      throw new opengeniDb.SessionUsageLimitUnavailableError();
    });
    const error = await call(h.service, "agent_attempt").catch((caught: unknown) => caught);
    expect(error).toMatchObject({ status: 503, code: "session_usage_limit_unavailable" });
    expect(h.provider).not.toHaveBeenCalled();
  });

  test("an allowed attempt call settles against its task with the request's source id", async () => {
    const h = harness({ allowed: true, state: null });
    await call(h.service, "agent_attempt");
    expect(h.provider).toHaveBeenCalledTimes(1);
    expect(h.settle.mock.calls[0]![2]).toMatchObject({
      sourceId: "model_call:req-1",
      usageLimitSessionId: SESSION,
    });
    // Existing usage attribution is unchanged: no session on the usage event.
    expect(h.settle.mock.calls[0]![2]).not.toHaveProperty("sessionId");
  });

  test.each(["human_session", "api_key"] as const)(
    "a %s call has no task: no usage-limit read or receipt",
    async (principalKind) => {
      const h = harness({ allowed: true, state: null });
      await call(h.service, principalKind);
      expect(h.check).not.toHaveBeenCalled();
      expect(h.settle.mock.calls[0]![2]).not.toHaveProperty("usageLimitSessionId");
    },
  );
});
