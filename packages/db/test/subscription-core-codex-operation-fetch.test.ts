import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  buildSubscriptionCoreCodexOperationFetch,
  fetchSubscriptionCoreCodexUsage,
  type SubscriptionCoreCodexOperationScope,
} from "../src/subscription-core-codex-operations";
import type { Database } from "../src/database";
import type { CodexFetch } from "@opengeni/codex";
import { testSettings } from "@opengeni/testing";
import * as requests from "../src/subscription-core-codex-requests";

const db = {} as Database;
const scope: SubscriptionCoreCodexOperationScope = {
  kind: "workspace",
  accountId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
  subjectId: "user:request-owner",
};
const connectionId = "00000000-0000-4000-8000-000000000003";
const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length) restores.pop()!();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

function fixture() {
  let disconnected = false;
  const reservations: Array<{ requestId: string; transportAttempt: number }> = [];
  const settlements: Array<{ operationId: string; outcome: string }> = [];
  type RequestDeps = NonNullable<Parameters<typeof buildSubscriptionCoreCodexOperationFetch>[5]>;
  const reserve = mock<NonNullable<RequestDeps["reserve"]>>(
    async (_db, _scope, _ref, _connection, request) => {
      if (disconnected) throw new Error("source disconnected");
      reservations.push(request);
      return { operationId: `physical-${reservations.length}` };
    },
  );
  const settle = mock<NonNullable<RequestDeps["settle"]>>(async (_db, _scope, request) => {
    settlements.push(request);
  });
  return { reserve, settle, reservations, settlements, disconnect: () => (disconnected = true) };
}

describe("non-chat Codex physical request custody", () => {
  test("waits for committed admission, then owns the entire body across disconnect", async () => {
    const f = fixture();
    const committed = deferred<void>();
    const dispatched = deferred<void>();
    let body!: ReadableStreamDefaultController<Uint8Array>;
    const upstream = new Response(new ReadableStream<Uint8Array>({ start: (c) => (body = c) }));
    const fetchImpl = mock<CodexFetch>(async () => {
      dispatched.resolve();
      return upstream;
    });
    const reserve = mock(async (...args: Parameters<typeof f.reserve>) => {
      await committed.promise;
      return await f.reserve(...args);
    });
    const request = buildSubscriptionCoreCodexOperationFetch(
      db,
      scope,
      null,
      connectionId,
      fetchImpl,
      { reserve, settle: f.settle },
    );
    const response = request("https://provider.test/transcribe", {
      headers: { Authorization: "Bearer fake-in-memory-token" },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    committed.resolve();
    await dispatched.promise;
    f.disconnect();
    body.enqueue(new TextEncoder().encode('{"text":"kept across disconnect"}'));
    expect(f.settlements).toEqual([]);
    body.close();
    expect(await (await response).json()).toEqual({ text: "kept across disconnect" });
    expect(f.settlements).toEqual([{ operationId: "physical-1", outcome: "response_received" }]);
    await expect(request("https://provider.test/transcribe")).rejects.toThrow(
      "source disconnected",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({
      redirect: "error",
      headers: { Authorization: "Bearer fake-in-memory-token" },
    });
  });

  test("each request and retry has its own native reservation identity", async () => {
    const f = fixture();
    const fetchImpl = mock(async () => new Response("body"));
    const request = buildSubscriptionCoreCodexOperationFetch(
      db,
      scope,
      null,
      connectionId,
      fetchImpl,
      f,
    );
    await request("https://provider.test/config");
    await request("https://provider.test/call");
    const nextRequest = buildSubscriptionCoreCodexOperationFetch(
      db,
      scope,
      null,
      connectionId,
      fetchImpl,
      f,
    );
    await nextRequest("https://provider.test/config");
    expect(f.reservations[0]?.requestId).toBe(f.reservations[1]?.requestId);
    expect(f.reservations.map((r) => r.transportAttempt)).toEqual([1, 2, 1]);
    expect(f.reservations[2]?.requestId).not.toBe(f.reservations[0]?.requestId);
    expect(f.reserve.mock.calls[0]?.slice(0, 4)).toEqual([db, scope, null, connectionId]);
  });

  test("a refused or duplicate admission never starts a fetch", async () => {
    const f = fixture();
    f.reserve.mockRejectedValue(new Error("duplicate reservation is not dispatch permission"));
    const fetchImpl = mock(async () => new Response());
    const request = buildSubscriptionCoreCodexOperationFetch(
      db,
      scope,
      null,
      connectionId,
      fetchImpl,
      f,
    );
    await expect(request("https://provider.test/call")).rejects.toThrow("duplicate reservation");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(f.settle).not.toHaveBeenCalled();
  });

  test("recreating a durable logical request cannot resurrect an ambiguous first attempt", async () => {
    const identities = new Set<string>();
    const f = fixture();
    f.reserve.mockImplementation(async (_db, _scope, _ref, _connection, request) => {
      const key = `${request.requestId}:${request.transportAttempt}`;
      if (identities.has(key)) throw new Error("duplicate reservation");
      identities.add(key);
      return { operationId: "ambiguous-original" };
    });
    const upstream = mock<CodexFetch>(async () => {
      throw new Error("response lost");
    });
    for (const expected of ["response lost", "duplicate reservation"]) {
      const request = buildSubscriptionCoreCodexOperationFetch(
        db,
        scope,
        null,
        connectionId,
        upstream,
        {
          ...f,
          requestId: "transcription:durable-request",
        },
      );
      await expect(request("https://provider.test/transcribe")).rejects.toThrow(expected);
    }
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(f.settlements).toEqual([{ operationId: "ambiguous-original", outcome: "unknown" }]);
  });

  test("aborting before admission starts nothing; aborting during admission refuses before dispatch", async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = mock(async () => new Response());
    const request = buildSubscriptionCoreCodexOperationFetch(
      db,
      scope,
      null,
      connectionId,
      fetchImpl,
      f,
    );
    await expect(
      request("https://provider.test/call", { signal: controller.signal }),
    ).rejects.toThrow();
    expect(f.reserve).not.toHaveBeenCalled();
    const late = new AbortController();
    f.reserve.mockImplementation(async () => {
      late.abort();
      return { operationId: "reserved-but-unsent" };
    });
    await expect(request("https://provider.test/call", { signal: late.signal })).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(f.settlements).toEqual([{ operationId: "reserved-but-unsent", outcome: "refused" }]);
  });

  test("network and truncated-body failures remain unknown and never replay", async () => {
    for (const failBody of [false, true]) {
      const f = fixture();
      const fetchImpl = mock(async () => {
        if (!failBody) throw new Error("lost response");
        return new Response(
          new ReadableStream({
            start(c) {
              c.error(new Error("lost body"));
            },
          }),
        );
      });
      const request = buildSubscriptionCoreCodexOperationFetch(
        db,
        scope,
        null,
        connectionId,
        fetchImpl,
        f,
      );
      await expect(request("https://provider.test/call")).rejects.toThrow();
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(f.settlements).toEqual([{ operationId: "physical-1", outcome: "unknown" }]);
    }
  });

  test("a timed-out custom fetch stays unknown even when its ignored-abort body arrives later", async () => {
    const f = fixture();
    const started = deferred<void>();
    const result = deferred<Response>();
    const controller = new AbortController();
    const fetchImpl = mock(async () => {
      started.resolve();
      return await result.promise;
    });
    const request = buildSubscriptionCoreCodexOperationFetch(
      db,
      scope,
      null,
      connectionId,
      fetchImpl,
      f,
    );
    const pending = request("https://provider.test/call", { signal: controller.signal });
    await started.promise;
    controller.abort();
    expect(f.settlements).toEqual([{ operationId: "physical-1", outcome: "unknown" }]);
    result.resolve(new Response("late response"));
    expect(await (await pending).text()).toBe("late response");
    expect(f.settle).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("settlement failure does not discard a consumed response or replay its request", async () => {
    const f = fixture();
    f.settle.mockRejectedValue(new Error("database unavailable"));
    const fetchImpl = mock(async () => new Response("answer"));
    const request = buildSubscriptionCoreCodexOperationFetch(
      db,
      scope,
      null,
      connectionId,
      fetchImpl,
      f,
    );
    expect(await (await request("https://provider.test/call")).text()).toBe("answer");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(f.settle).toHaveBeenCalledTimes(1);
  });

  test("oversized non-chat bodies fail closed without unbounded buffering or remote completion proof", async () => {
    const f = fixture();
    const upstream = mock<CodexFetch>(
      async () => new Response(new Uint8Array(8 * 1024 * 1024 + 1)),
    );
    const request = buildSubscriptionCoreCodexOperationFetch(
      db,
      scope,
      null,
      connectionId,
      upstream,
      f,
    );
    await expect(request("https://provider.test/call")).rejects.toThrow("byte limit");
    expect(f.settlements).toEqual([{ operationId: "physical-1", outcome: "unknown" }]);
    expect(upstream).toHaveBeenCalledTimes(1);
  });
});

describe("core usage physical request custody", () => {
  function usageFixture() {
    const f = fixture();
    const reserve = spyOn(
      requests,
      "reserveSubscriptionCoreCodexOperationRequest",
    ).mockImplementation(f.reserve);
    const settle = spyOn(
      requests,
      "settleSubscriptionCoreCodexOperationRequest",
    ).mockImplementation(f.settle);
    restores.push(
      () => reserve.mockRestore(),
      () => settle.mockRestore(),
    );
    const deps: NonNullable<Parameters<typeof fetchSubscriptionCoreCodexUsage>[5]> = {
      load: async () => ({
        kind: "loaded",
        credential: {
          connectionId,
          refreshGeneration: 1,
          tokens: {
            accessToken: "fake-usage-token",
            refreshToken: "fake-refresh",
            idToken: "fake-id",
          },
          chatgptAccountId: null,
          isFedramp: false,
          planType: "pro",
          expiresAt: new Date(Date.now() + 3_600_000),
          lastRefreshAt: new Date(),
        },
      }),
      refreshCredential: async () => {
        throw new Error("fresh token must not refresh");
      },
    };
    const read = (fetchImpl: CodexFetch) =>
      fetchSubscriptionCoreCodexUsage(
        db,
        testSettings({ codexSubscriptionEnabled: true }),
        scope as Extract<SubscriptionCoreCodexOperationScope, { kind: "workspace" }>,
        connectionId,
        fetchImpl,
        deps,
      );
    return { ...f, read };
  }

  test("usage keeps full body custody when the connection disappears after dispatch", async () => {
    const f = usageFixture();
    const started = deferred<void>();
    let body!: ReadableStreamDefaultController<Uint8Array>;
    const upstream = mock<CodexFetch>(async () => {
      const response = new Response(new ReadableStream<Uint8Array>({ start: (c) => (body = c) }));
      started.resolve();
      return response;
    });
    const reading = f.read(upstream);
    await started.promise;
    f.disconnect();
    expect(f.settlements).toEqual([]);
    body.enqueue(
      new TextEncoder().encode(
        '{"plan_type":"pro","rate_limit_reset_credits":{"available_count":2}}',
      ),
    );
    body.close();
    expect(await reading).toMatchObject({
      usage: { planType: "pro", rateLimitResetCredits: { availableCount: 2 } },
      recovered: false,
    });
    expect(f.settlements).toEqual([{ operationId: "physical-1", outcome: "response_received" }]);
    expect(f.reserve.mock.calls[0]?.slice(1, 4)).toEqual([scope, null, connectionId]);
  });

  test("usage admission refuses a source removed after token load without a provider call", async () => {
    const f = usageFixture();
    f.disconnect();
    const upstream = mock<CodexFetch>(async () => Response.json({}));
    expect(await f.read(upstream)).toMatchObject({ usage: { status: "error" }, recovered: false });
    expect(upstream).not.toHaveBeenCalled();
    expect(f.settlements).toEqual([]);
  });
});
