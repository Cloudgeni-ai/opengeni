import { describe, expect, test } from "bun:test";
import { withModelTransportStartedObserver } from "../src/model-preparation-diagnostics";
import { instrumentedModelFetch } from "../src/model-provider-client";
import { withModelCallLifecycle } from "../src/model-request-capture";
import { withClaudeUsageObserver } from "../src/claude-subscription-usage";
import {
  responsesTransport,
  OPENAI_RESPONSES_WEBSOCKET_ENDPOINT,
} from "@opengeni/network/responses-websocket";

type Clock = { dispatchedAtUnixMs: number; monotonicTimeMs: number };

function held<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const request = ["https://provider.invalid/v1/responses", { method: "POST", body: "{}" }] as const;

describe("model transport handoff diagnostic", () => {
  test.each([null, undefined])(
    "HTTP fallback reports dispatch when socket support is %s",
    async (createSocket) => {
      const order: string[] = [];
      const transport = responsesTransport(
        async () => {
          order.push("fetch");
          return new Response("{}");
        },
        { endpoint: OPENAI_RESPONSES_WEBSOCKET_ENDPOINT, createSocket },
      );
      const fetcher = instrumentedModelFetch("openai", transport as typeof fetch, true);
      await withModelTransportStartedObserver(
        undefined,
        () => fetcher(...request),
        () => {
          order.push("dispatch");
        },
      );
      expect(order).toEqual(["dispatch", "fetch"]);
    },
  );

  test("dispatch waits for credential custody and precedes the physical fetch without an async gap", async () => {
    const custody = held();
    const entered = held();
    const order: string[] = [];
    const fetcher = instrumentedModelFetch("organization-claude-subscription", (async () => {
      order.push("fetch");
      return new Response("{}");
    }) as typeof globalThis.fetch);
    const pending = withClaudeUsageObserver(
      () => undefined,
      () =>
        withModelTransportStartedObserver(
          () => {
            order.push("audit");
          },
          () => fetcher("https://api.anthropic.com/v1/messages", { method: "POST", body: "{}" }),
          () => {
            order.push("dispatch");
            queueMicrotask(() => order.push("preparation"));
          },
        ),
      async (_provider, headers) => ({
        headers,
        observe: () => undefined,
        custody: {
          admit: async () => {
            order.push("custody-start");
            entered.resolve();
            await custody.promise;
            order.push("custody-complete");
          },
          responded: async (response) => response,
          failed: async () => undefined,
        },
      }),
    );
    await entered.promise;
    expect(order).toEqual(["audit", "custody-start"]);
    custody.resolve();
    await pending;
    expect(order).toEqual([
      "audit",
      "custody-start",
      "custody-complete",
      "dispatch",
      "fetch",
      "preparation",
    ]);
  });

  test("captures after the held audit and synchronously before underlying fetch", async () => {
    const audit = held();
    const entered = held();
    const order: string[] = [];
    let clock: Clock | undefined;
    const fetch = instrumentedModelFetch("azure", (async () => {
      order.push("fetch");
      expect(clock).toBeDefined();
      expect(clock!.monotonicTimeMs).toBeLessThanOrEqual(performance.now());
      expect(clock!.dispatchedAtUnixMs).toBeLessThanOrEqual(Date.now());
      return new Response("{}");
    }) as typeof globalThis.fetch);
    const pending = withModelTransportStartedObserver(
      async () => {
        order.push("audit-start");
        entered.resolve();
        await audit.promise;
        order.push("audit-complete");
      },
      () => fetch(...request),
      (observed: Clock) => {
        clock = observed;
        order.push("dispatch-clock");
      },
    );
    await entered.promise;
    expect(order).toEqual(["audit-start"]);
    expect(clock).toBeUndefined();
    audit.resolve();
    await pending;
    expect(order).toEqual(["audit-start", "audit-complete", "dispatch-clock", "fetch"]);
  });

  test("audit refusal emits neither a clock nor a physical dispatch", async () => {
    const refusal = new Error("audit fenced");
    let observations = 0;
    let wireCalls = 0;
    const fetch = instrumentedModelFetch("azure", (async () => {
      wireCalls += 1;
      return new Response("{}");
    }) as typeof globalThis.fetch);
    await expect(
      withModelTransportStartedObserver(
        () => {
          throw refusal;
        },
        () => fetch(...request),
        () => {
          observations += 1;
        },
      ),
    ).rejects.toBe(refusal);
    expect(observations).toBe(0);
    expect(wireCalls).toBe(0);
  });

  test("producer admission failure reaches neither audit, clock nor fetch", async () => {
    const refusal = new Error("allowance refused");
    const order: string[] = [];
    const fetch = instrumentedModelFetch("azure", (async () => {
      order.push("fetch");
      return new Response("{}");
    }) as typeof globalThis.fetch);
    await expect(
      withModelCallLifecycle(
        {
          beforeModelRequest: async () => {
            throw refusal;
          },
        },
        () =>
          withModelTransportStartedObserver(
            () => {
              order.push("audit");
            },
            () => fetch(...request),
            () => {
              order.push("clock");
            },
          ),
      ),
    ).rejects.toBe(refusal);
    expect(order).toEqual([]);
  });

  test("diagnostic errors and returned promises cannot delay or fail fetch", async () => {
    let wireCalls = 0;
    let observations = 0;
    const neverJoined = held();
    const fetch = instrumentedModelFetch("azure", (async () => {
      wireCalls += 1;
      return new Response("{}");
    }) as typeof globalThis.fetch);
    for (const observer of [
      () => {
        observations += 1;
        throw new Error("diagnostic only");
      },
      () => {
        observations += 1;
        return neverJoined.promise;
      },
      async () => {
        observations += 1;
        throw new Error("async diagnostic only");
      },
    ]) {
      expect(
        (await withModelTransportStartedObserver(undefined, () => fetch(...request), observer)).ok,
      ).toBe(true);
    }
    expect(observations).toBe(3);
    expect(wireCalls).toBe(3);
    neverJoined.resolve();
  });

  test("concurrent attempts sharing a transport keep their own observer", async () => {
    const audits = [held(), held()];
    const entered = [held(), held()];
    const clocks: number[] = [];
    const fetch = instrumentedModelFetch(
      "azure",
      (async () => new Response("{}")) as typeof globalThis.fetch,
    );
    const pending = audits.map((audit, index) =>
      withModelTransportStartedObserver(
        async () => {
          entered[index]!.resolve();
          await audit.promise;
        },
        () => fetch(...request),
        () => clocks.push(index),
      ),
    );
    await Promise.all(entered.map((gate) => gate.promise));
    audits[1]!.resolve();
    await pending[1];
    expect(clocks).toEqual([1]);
    audits[0]!.resolve();
    await pending[0];
    expect(clocks).toEqual([1, 0]);
  });

  test("non-model fetches do not emit model dispatch diagnostics", async () => {
    let observations = 0;
    const fetch = instrumentedModelFetch(
      "azure",
      (async () => new Response("{}")) as typeof globalThis.fetch,
    );
    await withModelTransportStartedObserver(
      () => {
        throw new Error("not a model request");
      },
      () => fetch("https://provider.invalid/v1/files"),
      () => {
        observations += 1;
      },
    );
    expect(observations).toBe(0);
  });
});
