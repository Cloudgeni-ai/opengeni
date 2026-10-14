import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as core from "@opengeni/core";
import { ModelCallError } from "@opengeni/core";
import * as opengeniDb from "@opengeni/db";
import type { Database } from "@opengeni/db";
import * as runtimeModelCall from "@opengeni/runtime/model-call";
import { testSettings } from "@opengeni/testing";
import * as rls from "../src/access-grant-rls";
import { PendingUsageSettlements } from "../src/model-calls/pending-usage-settlements";
import { createModelCallService } from "../src/model-calls/service";

// an attempt-authenticated single-model call (an agent's code
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
  const receipt = spy(opengeniDb, "settleSessionUsageReceipt", async () => ({
    outcome: "recorded",
    state: null,
  }));
  const fence = spy(opengeniDb, "fenceSessionUsageReceipt", async () => ({ outcome: "fenced" }));
  const release = spy(opengeniDb, "releaseSessionUsageReceipt", async () => ({
    outcome: "released",
  }));
  const pending = new PendingUsageSettlements({ schedule: () => undefined });
  const service = createModelCallService({
    db: {} as Database,
    settings,
    pendingUsageSettlements: pending,
  });
  return { service, admit, provider, settle, check, receipt, fence, release, pending };
}

function call(
  service: ReturnType<typeof createModelCallService>,
  principalKind: "agent_attempt" | "human_session" | "api_key",
  requestId = "req-1",
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
    requestId,
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

  test("admission is runtime and opens this call's durable custody marker", async () => {
    const h = harness({ allowed: true, state: null });
    await call(h.service, "agent_attempt", "req-9");
    expect(h.check.mock.calls[0]![1]).toMatchObject({
      sessionId: SESSION,
      runtime: true,
      openSourceId: "model_call:req-9",
    });
    expect(h.release).not.toHaveBeenCalled();
    expect(h.fence).not.toHaveBeenCalled();
  });

  test("a provider failure releases the marker: no response, no usage", async () => {
    const h = harness({ allowed: true, state: null });
    h.provider.mockImplementationOnce(async () => {
      throw new Error("upstream reset");
    });
    await call(h.service, "agent_attempt", "req-1").catch(() => undefined);
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(h.release.mock.calls[0]![1]).toMatchObject({
      sessionId: SESSION,
      sourceId: "model_call:req-1",
    });
    expect(h.settle).not.toHaveBeenCalled();
  });

  test("an allowance denial after the marker opened releases it", async () => {
    const h = harness({ allowed: true, state: null });
    h.admit.mockImplementationOnce(async () => ({
      allowed: false,
      denial: "insufficient_credits",
      message: "No credits",
    }));
    const error = await call(h.service, "agent_attempt").catch((caught: unknown) => caught);
    expect(error).toMatchObject({ status: 402, code: "insufficient_credits" });
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(h.provider).not.toHaveBeenCalled();
  });

  test.each([
    ["a connection loss", Object.assign(new Error("connection terminated"), { code: "08006" })],
    ["a permission error", Object.assign(new Error("permission denied"), { code: "42501" })],
    ["an unclassified error", new Error("unexpected")],
  ])(
    "%s writing the receipt retains it, fences the marker and blocks the task's next call until DB-only recovery",
    async (_label, failure) => {
      const h = harness({ allowed: true, state: null });
      const held = {
        sessionId: SESSION,
        sourceId: "model_call:req-1",
        turnId: null,
        amountMicros: 1_234,
        pricingSource: "configured_list_price",
        model: "scripted-model",
      };
      h.settle.mockImplementationOnce(async (_s: unknown, _d: unknown, input: unknown) => {
        (input as { receiptCustody: (r: unknown, e: unknown) => void }).receiptCustody(
          held,
          failure,
        );
        return {};
      });
      // The completed answer is still returned; the exact receipt is owed.
      const first = await call(h.service, "agent_attempt", "req-1");
      expect(first.result).toMatchObject({ text: "answer" });
      expect(h.pending.has(SESSION)).toBe(true);
      expect(h.fence).toHaveBeenCalledTimes(1);
      expect(h.fence.mock.calls[0]![1]).toMatchObject({ sourceId: "model_call:req-1" });

      // Still failing: the next call is refused before admission or provider.
      h.receipt.mockImplementationOnce(async () => {
        throw failure;
      });
      const blocked = await call(h.service, "agent_attempt", "req-2").catch(
        (caught: unknown) => caught,
      );
      expect(blocked).toMatchObject({ status: 503, code: "session_usage_limit_unavailable" });
      expect(h.provider).toHaveBeenCalledTimes(1);
      expect(h.check).toHaveBeenCalledTimes(1);

      // Recovery writes only the original receipt, then admits.
      await call(h.service, "agent_attempt", "req-3");
      expect(h.provider).toHaveBeenCalledTimes(2);
      expect(h.receipt.mock.calls.map((args) => args[1])).toEqual([
        expect.objectContaining({ sourceId: "model_call:req-1", amountMicros: 1_234 }),
        expect.objectContaining({ sourceId: "model_call:req-1", amountMicros: 1_234 }),
      ]);
      expect(h.pending.has(SESSION)).toBe(false);
    },
  );

  test("a response without a usage report is an unpriced receipt, never free", async () => {
    const h = harness({ allowed: true, state: null });
    h.provider.mockImplementationOnce(async () => ({ text: "answer" }) as never);
    await call(h.service, "agent_attempt", "req-1");
    expect(h.settle).not.toHaveBeenCalled();
    expect(h.receipt.mock.calls[0]![1]).toMatchObject({
      sourceId: "model_call:req-1",
      amountMicros: null,
      pricingSource: null,
    });
  });

  test("a settlement error before the receipt discloses the call as unpriced and does not block", async () => {
    const h = harness({ allowed: true, state: null });
    h.settle.mockImplementationOnce(async () => {
      throw new Error("AI Gateway reported unapproved provider");
    });
    await call(h.service, "agent_attempt", "req-1");
    expect(h.receipt.mock.calls[0]![1]).toMatchObject({
      sourceId: "model_call:req-1",
      amountMicros: null,
    });
    expect(h.pending.size).toBe(0);
    await call(h.service, "agent_attempt", "req-2");
    expect(h.provider).toHaveBeenCalledTimes(2);
  });

  test("a process at its retained-receipt capacity refuses new task calls instead of dropping one", async () => {
    const h = harness({ allowed: true, state: null });
    const full = new PendingUsageSettlements({ maxEntries: 1, schedule: () => undefined });
    full.retain("other-session", "model_call:x", async () => {
      throw new Error("down");
    });
    const service = createModelCallService({
      db: {} as Database,
      settings: testSettings(),
      pendingUsageSettlements: full,
    });
    const error = await call(service, "agent_attempt").catch((caught: unknown) => caught);
    expect(error).toMatchObject({ status: 503, code: "session_usage_limit_unavailable" });
    expect(h.check).not.toHaveBeenCalled();
    expect(h.provider).not.toHaveBeenCalled();
    expect(full.size).toBe(1);
  });
});

describe("PendingUsageSettlements", () => {
  test("retries in the background with bounded backoff and never expires a receipt", async () => {
    const scheduled: Array<{ fn: () => void; delayMs: number }> = [];
    const pending = new PendingUsageSettlements({
      initialDelayMs: 100,
      maxDelayMs: 400,
      schedule: (fn, delayMs) => void scheduled.push({ fn, delayMs }),
    });
    let attempts = 0;
    pending.retain("s1", "src", async () => {
      attempts += 1;
      if (attempts < 6) throw new Error("still down");
    });
    const delays: number[] = [];
    while (scheduled.length > 0) {
      const next = scheduled.shift()!;
      delays.push(next.delayMs);
      next.fn();
      await Bun.sleep(0);
    }
    expect(attempts).toBe(6);
    expect(Math.max(...delays)).toBeLessThanOrEqual(400);
    expect(pending.size).toBe(0);
  });

  test("at capacity it refuses to retain more instead of evicting", () => {
    const pending = new PendingUsageSettlements({ maxEntries: 2, schedule: () => undefined });
    expect(pending.retain("a", "1", async () => undefined)).toBe(true);
    expect(pending.retain("b", "1", async () => undefined)).toBe(true);
    expect(pending.retain("a", "1", async () => undefined)).toBe(true);
    expect(pending.full).toBe(true);
    expect(pending.retain("c", "1", async () => undefined)).toBe(false);
    expect(pending.has("a")).toBe(true);
    expect(pending.has("b")).toBe(true);
  });

  test("flush records the session's receipts and rethrows a failure, keeping it", async () => {
    const pending = new PendingUsageSettlements({ schedule: () => undefined });
    pending.retain("s", "ok", async () => undefined);
    pending.retain("s", "bad", async () => {
      throw new Error("down");
    });
    pending.retain("t", "other", async () => undefined);
    await expect(pending.flush("s")).rejects.toThrow("down");
    expect(pending.size).toBe(2);
    expect(pending.has("s")).toBe(true);
  });
});
