import { afterEach, expect, spyOn, test } from "bun:test";
import { collectSse } from "../src/sse";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test.each(["before collection", "during lazy initialization"])(
  "SSE forwards caller cancellation %s",
  async (phase) => {
    const controller = new AbortController();
    let requestSignal: AbortSignal | null | undefined;
    globalThis.fetch = Object.assign(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        requestSignal = init?.signal;
        return new Response("");
      },
      { preconnect: originalFetch.preconnect },
    );
    if (phase === "before collection") controller.abort();
    const collection = collectSse("https://example.invalid/events", {
      count: 1,
      signal: controller.signal,
    });
    if (phase === "during lazy initialization") controller.abort();
    await collection;
    expect(requestSignal).toBeDefined();
    expect(requestSignal?.aborted).toBe(true);
  },
);

test("SSE removes its caller abort listener after collection", async () => {
  const controller = new AbortController();
  const add = spyOn(controller.signal, "addEventListener");
  const remove = spyOn(controller.signal, "removeEventListener");
  globalThis.fetch = Object.assign(async () => new Response(""), {
    preconnect: originalFetch.preconnect,
  });
  try {
    expect(
      await collectSse("https://example.invalid/events", { count: 1, signal: controller.signal }),
    ).toEqual([]);
    const registered = add.mock.calls.find(([event]) => event === "abort");
    expect(registered).toBeDefined();
    expect(remove).toHaveBeenCalledWith("abort", registered?.[1]);
  } finally {
    add.mockRestore();
    remove.mockRestore();
  }
});
