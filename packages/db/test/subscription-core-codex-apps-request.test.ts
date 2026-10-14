import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { testSettings } from "@opengeni/testing";
import {
  subscriptionCoreCodexAppsRequestAuth,
  SubscriptionCoreCodexAppsUnavailableError,
  type SubscriptionCoreCodexAppsDeps,
} from "../src/subscription-core-codex-apps";
import * as database from "../src/database";
import * as requests from "../src/subscription-core-codex-requests";

const target = {
  accountId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
  connectionId: "00000000-0000-4000-8000-000000000003",
};
const db = {} as database.Database;
const settings = testSettings({ codexConnectedAppsEnabled: true });
const token: { accessToken: string; chatgptAccountId: string | null } = {
  accessToken: "fake-apps-token",
  chatgptAccountId: "fake-apps-account",
};
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
  const resolveToken = mock(async () => token);
  const reserveRequest = mock<NonNullable<SubscriptionCoreCodexAppsDeps["reserveRequest"]>>(
    async () => {
      if (disconnected) throw new SubscriptionCoreCodexAppsUnavailableError();
      return { operationId: crypto.randomUUID() };
    },
  );
  const settleRequest = mock<NonNullable<SubscriptionCoreCodexAppsDeps["settleRequest"]>>(
    async () => undefined,
  );
  const auth = subscriptionCoreCodexAppsRequestAuth(db, settings, target, {
    resolveToken,
    reserveRequest,
    settleRequest,
  });
  return {
    auth,
    reserveRequest,
    settleRequest,
    resolveToken,
    disconnect: () => (disconnected = true),
  };
}

describe("core Apps physical request custody", () => {
  test("a committed request keeps its streaming response across disconnect; headers do not settle it", async () => {
    const f = fixture();
    let body!: ReadableStreamDefaultController<Uint8Array>;
    const dispatch = mock(async (snapshot: typeof token) => {
      expect(snapshot).toEqual(token);
      return new Response(new ReadableStream<Uint8Array>({ start: (c) => (body = c) }), {
        headers: { "content-type": "text/event-stream" },
      });
    });
    const response = await f.auth.withRequest(dispatch);
    f.disconnect();
    expect(f.settleRequest).not.toHaveBeenCalled();
    body.enqueue(new TextEncoder().encode('data: {"result":"kept"}\n\n'));
    const consuming = response.text();
    expect(f.settleRequest).not.toHaveBeenCalled();
    body.close();
    expect(await consuming).toContain('"result":"kept"');
    expect(f.settleRequest.mock.calls[0]?.[2].outcome).toBe("response_received");
    await expect(f.auth.withRequest(dispatch)).rejects.toBeInstanceOf(
      SubscriptionCoreCodexAppsUnavailableError,
    );
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  test("every physical request has a fresh designation admission without synthesized human authority", async () => {
    const f = fixture();
    await database.withSessionRlsActorContext(
      { subjectId: "user:apps-caller", initiatingHumanSubjectId: "user:apps-caller" },
      async () => {
        for (let index = 0; index < 2; index++) {
          const response = await f.auth.withRequest(async () => new Response("done"));
          await response.text();
        }
      },
    );
    expect(f.reserveRequest).toHaveBeenCalledTimes(2);
    expect(f.reserveRequest.mock.calls[0]?.[1]).toEqual(target);
    const first = f.reserveRequest.mock.calls[0]![2];
    const second = f.reserveRequest.mock.calls[1]![2];
    expect(first.requestId).not.toBe(second.requestId);
    expect(first.transportAttempt).toBe(1);
    expect(second.transportAttempt).toBe(1);
  });

  test("response cancellation and truncated bodies remain unknown", async () => {
    for (const cancelled of [true, false]) {
      const f = fixture();
      const response = await f.auth.withRequest(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                if (!cancelled) controller.error(new Error("truncated Apps response"));
              },
            }),
          ),
      );
      if (cancelled) await response.body!.cancel();
      else await expect(response.text()).rejects.toThrow("truncated Apps response");
      expect(f.settleRequest).toHaveBeenCalledTimes(1);
      expect(f.settleRequest.mock.calls[0]?.[2].outcome).toBe("unknown");
      expect(f.reserveRequest).toHaveBeenCalledTimes(1);
    }
  });

  test("an ambiguous dispatch is recorded once and never replayed", async () => {
    const f = fixture();
    const dispatch = mock(async () => {
      throw new Error("provider response lost");
    });
    await expect(f.auth.withRequest(dispatch)).rejects.toThrow("provider response lost");
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(f.settleRequest.mock.calls[0]?.[2].outcome).toBe("unknown");
  });

  test("abort before dispatch refuses the reserved request without sending", async () => {
    const f = fixture();
    const controller = new AbortController();
    f.reserveRequest.mockImplementation(async () => {
      controller.abort();
      return { operationId: "unsent-apps" };
    });
    const dispatch = mock(async () => new Response("must not send"));
    await expect(f.auth.withRequest(dispatch, { signal: controller.signal })).rejects.toThrow();
    expect(dispatch).not.toHaveBeenCalled();
    expect(f.settleRequest.mock.calls[0]?.[2]).toEqual({
      operationId: "unsent-apps",
      outcome: "refused",
    });
  });

  test("an already-aborted request neither reads a bearer nor reserves or dispatches", async () => {
    const f = fixture();
    const dispatch = mock(async () => new Response("must not send"));
    await expect(f.auth.withRequest(dispatch, { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(f.resolveToken).not.toHaveBeenCalled();
    expect(f.reserveRequest).not.toHaveBeenCalled();
    expect(f.settleRequest).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  test("credential resolution refusal cannot fall through to admission or dispatch", async () => {
    const f = fixture();
    f.resolveToken.mockRejectedValue(new SubscriptionCoreCodexAppsUnavailableError());
    const dispatch = mock(async () => new Response("must not send"));
    await expect(f.auth.withRequest(dispatch)).rejects.toBeInstanceOf(
      SubscriptionCoreCodexAppsUnavailableError,
    );
    expect(f.reserveRequest).not.toHaveBeenCalled();
    expect(f.settleRequest).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  test("settlement failure preserves the received response without replay", async () => {
    const f = fixture();
    f.settleRequest.mockRejectedValue(new Error("native outcome write unavailable"));
    const dispatch = mock(async () => new Response("received once"));
    expect(await (await f.auth.withRequest(dispatch)).text()).toBe("received once");
    expect(f.settleRequest).toHaveBeenCalledTimes(1);
    expect(f.settleRequest.mock.calls[0]?.[2].outcome).toBe("response_received");
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(f.reserveRequest).toHaveBeenCalledTimes(1);
  });

  test("a timed-out custom transport stays unknown after its late response EOF", async () => {
    const f = fixture();
    const started = deferred<void>();
    const reply = deferred<Response>();
    const controller = new AbortController();
    const pending = f.auth.withRequest(
      async () => {
        started.resolve();
        return await reply.promise;
      },
      { signal: controller.signal },
    );
    await started.promise;
    controller.abort();
    expect(f.settleRequest.mock.calls[0]?.[2].outcome).toBe("unknown");
    reply.resolve(new Response("late Apps response"));
    expect(await (await pending).text()).toBe("late Apps response");
    expect(f.settleRequest).toHaveBeenCalledTimes(1);
  });

  test("the physical callback waits for the native designation admission commit", async () => {
    const commit = deferred<void>();
    const reserved = deferred<void>();
    const order: string[] = [];
    const reserve = spyOn(requests, "reserveSubscriptionCoreCodexAppsRequest").mockImplementation(
      async () => {
        order.push("native designation reservation");
        reserved.resolve();
        await commit.promise;
        order.push("commit");
        return { operationId: "committed-apps" };
      },
    );
    restores.push(() => reserve.mockRestore());
    const auth = subscriptionCoreCodexAppsRequestAuth(db, settings, target, {
      resolveToken: async () => token,
      settleRequest: async () => undefined,
    });
    const pending = auth.withRequest(async () => {
      order.push("physical request");
      return new Response(null, { status: 204 });
    });
    await reserved.promise;
    expect(order).toEqual(["native designation reservation"]);
    commit.resolve();
    expect((await pending).status).toBe(204);
    expect(order).toEqual(["native designation reservation", "commit", "physical request"]);
    expect(reserve.mock.calls[0]?.[1]).toEqual(target);
  });

  test("a refused native designation admission prevents provider work", async () => {
    const reserve = spyOn(requests, "reserveSubscriptionCoreCodexAppsRequest").mockRejectedValue(
      new SubscriptionCoreCodexAppsUnavailableError(),
    );
    restores.push(() => reserve.mockRestore());
    const auth = subscriptionCoreCodexAppsRequestAuth(db, settings, target, {
      resolveToken: async () => token,
    });
    const dispatch = mock(async () => new Response());
    await expect(auth.withRequest(dispatch)).rejects.toBeInstanceOf(
      SubscriptionCoreCodexAppsUnavailableError,
    );
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
