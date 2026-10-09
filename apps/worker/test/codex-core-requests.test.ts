import { expect, test } from "bun:test";
import {
  codexRequestStorage,
  codexSubscriptionFetch,
  type CodexRequestContext,
} from "@opengeni/codex";
import { SubscriptionCoreCodexRequestOutcomeUnknownError } from "@opengeni/db";
import { createCoreCodexRequests } from "../src/activities/agent-turn/codex-core-requests";
import { sessionTitleCodexRequestContext } from "../src/activities/agent-turn/run";

const request = { requestId: "r1", transportAttempt: 1 };
function fixture() {
  const operations = new Set<string>();
  const settled: Array<{ operationId: string; outcome: string }> = [];
  let reservations = 0;
  let failSettlement = false;
  const tracker = createCoreCodexRequests({
    reserve: async ({ requestId, transportAttempt }) => {
      reservations++;
      const operationId = `${requestId}/${transportAttempt}`;
      if (operations.has(operationId)) throw new Error("duplicate reservation");
      operations.add(operationId);
      return { operationId };
    },
    settle: async (value) => {
      if (failSettlement) throw new Error("persistence unavailable");
      settled.push(value);
    },
  });
  return {
    tracker,
    settled,
    reservations: () => reservations,
    fail: (value: boolean) => {
      failSettlement = value;
    },
  };
}

test("observed response is not persisted response; checkpoint commits once", async () => {
  const { tracker, settled } = fixture();
  await tracker.reserve(request);
  await tracker.observe({ ...request, outcome: "response_received" });
  expect(tracker.canRecover()).toBe(false);
  expect(settled).toEqual([]);
  await tracker.checkpoint();
  await tracker.checkpoint();
  expect(settled).toEqual([{ operationId: "r1/1", outcome: "response_received" }]);
  expect(tracker.canRecover()).toBe(true);
  await expect(tracker.reserve(request)).rejects.toThrow("duplicate reservation");
});

test.each(["unknown", "refused"] as const)(
  "%s retains its replay meaning after settlement",
  async (outcome) => {
    const { tracker, settled } = fixture();
    await tracker.reserve(request);
    await tracker.observe({ ...request, outcome });
    await tracker.checkpoint();
    expect(tracker.canRecover()).toBe(outcome === "refused");
    expect(settled).toEqual([{ operationId: "r1/1", outcome }]);
    if (outcome === "unknown") {
      await expect(
        tracker.reserve({ requestId: "r2", transportAttempt: 1 }),
      ).rejects.toBeInstanceOf(SubscriptionCoreCodexRequestOutcomeUnknownError);
    } else {
      await tracker.reserve({ ...request, transportAttempt: 2 });
    }
  },
);

test("failed durable settlement never releases replay; same response receipt can be retried", async () => {
  const { tracker, fail } = fixture();
  await tracker.reserve(request);
  await tracker.observe({ ...request, outcome: "response_received" });
  fail(true);
  await expect(tracker.checkpoint()).rejects.toThrow("persistence unavailable");
  expect(tracker.canRecover()).toBe(false);
  fail(false);
  await tracker.checkpoint();
  expect(tracker.canRecover()).toBe(true);
});

test("reservation and started evidence alone never authorize recovery", async () => {
  const { tracker, settled } = fixture();
  await tracker.reserve(request);
  await tracker.checkpoint();
  expect(settled).toEqual([]);
  expect(tracker.canRecover()).toBe(false);
});

test.each([
  "response_uncheckpointed",
  "response_write_failed",
  "unknown_write_failed",
  "refused_write_failed",
] as const)(
  "physical client retry after %s acquires no second DB permit or fetch",
  async (state) => {
    const { tracker, fail, reservations } = fixture();
    let sequence = 0;
    let fetches = 0;
    const context: CodexRequestContext = {
      clientVersion: "fixture",
      getToken: async () => ({ accessToken: "fixture", chatgptAccountId: null, isFedramp: false }),
      refresh: async () => {
        throw new Error("must not refresh an unsettled refusal");
      },
      resolveModel: (model) => model,
      nextRequestId: () => `request-${++sequence}`,
      beforeProviderDispatch: (value) => tracker.reserve(value!),
      onProviderRequestSettled: tracker.observe,
    };
    const transport = codexSubscriptionFetch(async () => {
      fetches++;
      if (state === "unknown_write_failed") throw new Error("response lost");
      if (state === "refused_write_failed") return new Response("{}", { status: 401 });
      return new Response(
        'data: {"type":"response.completed","response":{"id":"response","status":"completed","output":[]}}\n\n',
        {
          headers: { "content-type": "text/event-stream" },
        },
      );
    });
    const dispatch = () =>
      codexRequestStorage.run(context, async () => {
        const response = await transport("https://fixture.invalid/responses", {
          method: "POST",
          body: JSON.stringify({ model: "fixture", input: [], stream: true }),
        });
        await response.text();
      });
    if (state === "unknown_write_failed" || state === "refused_write_failed") {
      fail(true);
      await expect(dispatch()).rejects.toThrow();
    } else {
      await dispatch();
      if (state === "response_write_failed") {
        fail(true);
        await expect(tracker.checkpoint()).rejects.toThrow("persistence unavailable");
      }
    }
    await expect(dispatch()).rejects.toBeInstanceOf(
      SubscriptionCoreCodexRequestOutcomeUnknownError,
    );
    expect(reservations()).toBe(1);
    expect(fetches).toBe(1);
    expect(tracker.canRecover()).toBe(false);
  },
);

test("a native cross-attempt outcome fence remains locally irreversible", async () => {
  let reservations = 0;
  const tracker = createCoreCodexRequests({
    reserve: async () => {
      reservations++;
      throw new SubscriptionCoreCodexRequestOutcomeUnknownError();
    },
    settle: async () => {
      throw new Error("no reservation was issued");
    },
  });
  await expect(tracker.reserve(request)).rejects.toBeInstanceOf(
    SubscriptionCoreCodexRequestOutcomeUnknownError,
  );
  await expect(tracker.reserve({ ...request, transportAttempt: 2 })).rejects.toBeInstanceOf(
    SubscriptionCoreCodexRequestOutcomeUnknownError,
  );
  expect(reservations).toBe(1);
  expect(tracker.canRecover()).toBe(false);
});

test("title responses retain separate custody and cannot be settled by the conversation checkpoint", async () => {
  const main = fixture();
  const title = fixture();
  let prechecks = 0;
  const context = sessionTitleCodexRequestContext(
    {
      clientVersion: "fixture",
      getToken: async () => ({ accessToken: "fixture", chatgptAccountId: null, isFedramp: false }),
      refresh: async () => {
        throw new Error("not used");
      },
      resolveModel: (value) => value,
      beforeProviderDispatch: async (value) => {
        prechecks++;
        if (value) await main.tracker.reserve(value);
      },
      onProviderRequestSettled: main.tracker.observe,
    },
    () => "title",
    title.tracker,
  );
  await context.beforeProviderDispatch!({ requestId: "title", transportAttempt: 1 });
  await context.onProviderRequestSettled!({
    requestId: "title",
    transportAttempt: 1,
    outcome: "response_received",
  });
  await main.tracker.checkpoint();
  expect(prechecks).toBe(1);
  expect(main.tracker.canRecover()).toBe(true);
  expect(title.tracker.canRecover()).toBe(false);
  expect(title.settled).toEqual([]);
  await title.tracker.checkpoint();
  expect(title.settled).toEqual([{ operationId: "title/1", outcome: "response_received" }]);
});
