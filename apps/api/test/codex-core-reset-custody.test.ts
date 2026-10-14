import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Hono } from "hono";
import * as core from "@opengeni/core";
import * as dbApi from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
import type { CodexFetch } from "@opengeni/codex";
import {
  hashCodexBrowserSession,
  signCodexRedemptionConfirmation,
} from "../src/codex-redemption-security";
import { registerCodexRoutes } from "../src/routes/codex";

const ACCOUNT = "00000000-0000-4000-8000-000000000001";
const WS = "00000000-0000-4000-8000-000000000002";
const CONNECTION = "00000000-0000-4000-8000-000000000003";
const SUBJECT = "user:reset-owner";
const ORIGIN = "http://opengeni.test";
const settings = testSettings({
  productAccessMode: "managed",
  publicBaseUrl: ORIGIN,
  codexSubscriptionEnabled: true,
  betterAuthSecret: "fake-reset-confirmation-secret-for-test-only",
});
const realOperationFetch = dbApi.buildSubscriptionCoreCodexOperationFetch;
const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length) restores.pop()!();
});

function dbMock<K extends keyof typeof dbApi>(name: K, impl: (...args: never[]) => unknown) {
  const spy = spyOn(dbApi, name as never).mockImplementation(impl as never);
  restores.push(() => spy.mockRestore());
  return spy as unknown as { mock: { calls: unknown[][] } };
}

async function fixture(transport: CodexFetch) {
  let disconnected = false;
  const attempt = {
    id: crypto.randomUUID(),
    creditId: "test-credit",
    status: "processing",
    upstreamIdempotencyKey: crypto.randomUUID(),
    credentialId: CONNECTION,
  };
  const access = spyOn(core, "requireAccessGrant").mockResolvedValue({
    accountId: ACCOUNT,
    workspaceId: WS,
    subjectId: SUBJECT,
    permissions: ["connections:write"],
  } as never);
  const session = spyOn(core, "getManagedSession").mockResolvedValue({
    session: { id: "fake-browser-session" },
    user: { id: "reset-owner" },
  } as never);
  restores.push(
    () => access.mockRestore(),
    () => session.mockRestore(),
  );
  dbMock("readCodexCutoverDisposition", async () => "core");
  dbMock("resolveSubscriptionCoreCodexConnectionId", async () => CONNECTION);
  dbMock("getSubscriptionCoreCodexWorkspaceProjection", async () => ({
    accounts: [{ id: CONNECTION, source: "workspace", status: "active" }],
  }));
  const claim = dbMock("claimCodexResetRedemption", async () => ({ kind: "claimed", attempt }));
  const fence = dbMock("fenceCodexResetRedemptionSend", async () => ({
    kind: "ready",
    attempt: { ...attempt, status: "provider_started" },
  }));
  const complete = dbMock("completeSubscriptionCoreCodexResetRedemption", async () => ({
    attempt: { ...attempt, status: "completed", outcome: "reset" },
    wake: null,
  }));
  const released = dbMock("releaseCodexResetRedemptionClaim", async () => undefined);
  dbMock("abandonCodexResetRedemptionBeforeProvider", async () => true);
  dbMock("deliverSubscriptionCoreCodexWake", async () => undefined);
  dbMock("buildSubscriptionCoreCodexConnectionTokenResolver", () => ({
    getToken: async () => ({
      accessToken: "fake-memory-bearer",
      chatgptAccountId: null,
      isFedramp: false,
      credentialVersion: 1,
    }),
  }));
  type RequestDeps = NonNullable<Parameters<typeof realOperationFetch>[5]>;
  const reserve = mock<NonNullable<RequestDeps["reserve"]>>(async () => {
    if (disconnected) throw new dbApi.SubscriptionCoreCodexSourceDisconnectedError();
    return { operationId: crypto.randomUUID() };
  });
  const settle = mock<NonNullable<RequestDeps["settle"]>>(async () => undefined);
  const wrapper = spyOn(dbApi, "buildSubscriptionCoreCodexOperationFetch").mockImplementation(
    (db, scope, ref, connectionId, fetchImpl) =>
      realOperationFetch(db, scope, ref, connectionId, fetchImpl, { reserve, settle }),
  );
  restores.push(() => wrapper.mockRestore());
  const api = new Hono();
  registerCodexRoutes(api, {
    settings,
    db: {} as dbApi.Database,
    managedAuth: {},
    codexFetch: transport,
  } as never);
  const confirmationToken = await signCodexRedemptionConfirmation(settings.betterAuthSecret!, {
    version: 1,
    attemptId: attempt.id,
    creditId: attempt.creditId,
    workspaceId: WS,
    credentialId: CONNECTION,
    subjectId: SUBJECT,
    browserSessionHash: await hashCodexBrowserSession("fake-browser-session"),
    expiresAt: Math.floor(Date.now() / 1000) + 300,
  });
  const redeem = (extraHeaders: Record<string, string> = {}) =>
    api.request(`${ORIGIN}/v1/workspaces/${WS}/codex/accounts/${CONNECTION}/reset-credits/redeem`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        "sec-fetch-site": "same-origin",
        cookie: "fake=browser",
        ...extraHeaders,
      },
      body: JSON.stringify({
        attemptId: attempt.id,
        creditId: attempt.creditId,
        confirmationToken,
        confirmation: "REDEEM_USAGE_LIMIT_RESET",
      }),
    });
  return {
    api,
    attempt,
    redeem,
    reserve,
    settle,
    access,
    claim,
    fence,
    complete,
    released,
    disconnect: () => (disconnected = true),
  };
}

function details() {
  return Response.json({
    available_count: 1,
    credits: [
      {
        id: "test-credit",
        reset_type: "codex_rate_limits",
        status: "available",
        granted_at: new Date(Date.now() - 60_000).toISOString(),
        expires_at: null,
      },
    ],
  });
}

describe("core reset-credit physical request custody", () => {
  test("preflight and consume reserve independently under the browser human and native redemption key", async () => {
    const transport = mock<CodexFetch>(async (url) =>
      String(url).endsWith("/consume")
        ? Response.json({ code: "reset", windows_reset: 2 })
        : details(),
    );
    const f = await fixture(transport);
    const response = await f.redeem();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "completed", outcome: "reset" });
    expect(f.reserve).toHaveBeenCalledTimes(2);
    expect(f.reserve.mock.calls.map((call) => call[4].transportAttempt)).toEqual([1, 2]);
    expect(f.reserve.mock.calls[0]?.slice(1, 4)).toEqual([
      { kind: "workspace", accountId: ACCOUNT, workspaceId: WS, subjectId: SUBJECT },
      null,
      CONNECTION,
    ]);
    expect(f.settle.mock.calls.map((call) => call[2].outcome)).toEqual([
      "response_received",
      "response_received",
    ]);
    expect(JSON.parse(String(transport.mock.calls[1]?.[1]?.body))).toEqual({
      redeem_request_id: f.attempt.upstreamIdempotencyKey,
      credit_id: "test-credit",
    });
    expect(f.claim.mock.calls[0]?.[2]).toBe(dbApi.subscriptionCoreCodexResetAuthority);
    expect(f.fence.mock.calls[0]?.[2]).toBe(dbApi.subscriptionCoreCodexResetAuthority);
    expect(f.access.mock.calls[0]?.[3]).toBe("connections:write");
  });

  test("disconnect after preflight refuses consume even though the bearer is already in memory", async () => {
    let disconnect = () => {};
    const transport = mock<CodexFetch>(async () => {
      disconnect();
      return details();
    });
    const f = await fixture(transport);
    disconnect = f.disconnect;
    expect((await f.redeem()).status).toBe(503);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(f.reserve).toHaveBeenCalledTimes(2);
    expect(f.complete.mock.calls).toHaveLength(0);
  });

  test("unknown consume retains uncertainty without automatic replay", async () => {
    const transport = mock<CodexFetch>(async (url) => {
      if (String(url).endsWith("/consume")) throw new Error("response lost after dispatch");
      return details();
    });
    const f = await fixture(transport);
    const response = await f.redeem();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ status: "ambiguous" });
    expect(transport).toHaveBeenCalledTimes(2);
    expect(f.settle.mock.calls.map((call) => call[2].outcome)).toEqual([
      "response_received",
      "unknown",
    ]);
    expect(f.complete.mock.calls).toHaveLength(0);
    expect(f.released.mock.calls).toHaveLength(1);
  });

  test("consume settlement and redemption completion wait for the full body across disconnect", async () => {
    let started!: () => void;
    const dispatched = new Promise<void>((resolve) => (started = resolve));
    let body!: ReadableStreamDefaultController<Uint8Array>;
    const transport = mock<CodexFetch>(async (url) => {
      if (!String(url).endsWith("/consume")) return details();
      const response = new Response(new ReadableStream<Uint8Array>({ start: (c) => (body = c) }));
      started();
      return response;
    });
    const f = await fixture(transport);
    const pending = f.redeem();
    await dispatched;
    f.disconnect();
    expect(f.settle).toHaveBeenCalledTimes(1);
    expect(f.complete.mock.calls).toHaveLength(0);
    body.enqueue(new TextEncoder().encode('{"code":"reset","windows_reset":2}'));
    body.close();
    expect((await pending).status).toBe(200);
    expect(f.settle).toHaveBeenCalledTimes(2);
    expect(f.complete.mock.calls).toHaveLength(1);
    expect(transport).toHaveBeenCalledTimes(2);
  });

  test("overview reset details use the same physical admission under read-only caller authority", async () => {
    const transport = mock<CodexFetch>(async () => details());
    const f = await fixture(transport);
    dbMock("fetchSubscriptionCoreCodexUsage", async () => ({
      usage: {
        status: "ok",
        planType: "pro",
        fiveHour: null,
        weekly: null,
        limitReached: false,
        fetchedAt: new Date().toISOString(),
        rateLimitResetCredits: null,
      },
      recovered: false,
    }));
    const response = await f.api.request(`${ORIGIN}/v1/workspaces/${WS}/codex/overview`);
    expect(response.status).toBe(200);
    expect(f.reserve).toHaveBeenCalledTimes(1);
    expect(f.reserve.mock.calls[0]?.slice(1, 4)).toEqual([
      { kind: "workspace", accountId: ACCOUNT, workspaceId: WS, subjectId: SUBJECT },
      null,
      CONNECTION,
    ]);
    expect(f.settle.mock.calls[0]?.[2].outcome).toBe("response_received");
    expect(f.claim.mock.calls).toHaveLength(0);
    expect(f.access.mock.calls[0]?.[3]).toBe("workspace:read");
  });

  test("bearer callers cannot acquire a reservation through a browser cookie", async () => {
    const transport = mock<CodexFetch>(async () => {
      throw new Error("must not dispatch");
    });
    const f = await fixture(transport);
    expect((await f.redeem({ authorization: "Bearer fake-delegated-token" })).status).toBe(403);
    expect(f.reserve).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });
});
