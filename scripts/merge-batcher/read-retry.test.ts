import { expect, test } from "bun:test";
import { retryRead, ReadUnavailable, type ReadRetryClock } from "./read-retry";

function harness(statuses: (number | Error)[]) {
  let now = 0;
  const sleeps: number[] = [];
  let calls = 0;
  const time: ReadRetryClock = {
    now: () => now,
    random: () => 0.5,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
  };
  const transport = (async () => {
    const value = statuses[Math.min(calls++, statuses.length - 1)]!;
    if (value instanceof Error) throw value;
    return new Response("{}", { status: value });
  }) as unknown as typeof fetch;
  return { time, transport, sleeps, calls: () => calls };
}
test("502 retries with bounded exponential backoff and jitter", async () => {
  const h = harness([502, 502, 200]);
  expect(
    (
      await retryRead(
        h.transport,
        "https://api.github.com/repos/a/b/actions/runs/1/jobs",
        {},
        h.time,
      )
    ).status,
  ).toBe(200);
  expect(h.calls()).toBe(3);
  expect(h.sleeps).toEqual([375, 625]);
});
test("persistent read fails after five attempts and omits query credentials", async () => {
  const h = harness([503]);
  try {
    await retryRead(h.transport, "https://api.github.com/repos/a/b/jobs?token=private", {}, h.time);
    throw Error("expected failure");
  } catch (error) {
    expect(error).toBeInstanceOf(ReadUnavailable);
    expect((error as ReadUnavailable).attempts).toBe(5);
    expect(String(error)).not.toContain("private");
  }
  expect(h.calls()).toBe(5);
});
test("network timeout retries but permanent response does not", async () => {
  const h = harness([new DOMException("timeout", "TimeoutError"), 404]);
  expect((await retryRead(h.transport, "https://api.github.com/x", {}, h.time)).status).toBe(404);
  expect(h.calls()).toBe(2);
});
test("rate-limit beyond local deadline defers without violating retry-after", async () => {
  const h = harness([200]);
  let calls = 0;
  const transport = (async () => {
    calls++;
    return new Response("", { status: 429, headers: { "retry-after": "120" } });
  }) as unknown as typeof fetch;
  await expect(retryRead(transport, "https://api.github.com/x", {}, h.time)).rejects.toMatchObject({
    retryAfterSeconds: 120,
    attempts: 1,
  });
  expect(calls).toBe(1);
  expect(h.sleeps).toEqual([]);
});
test("GraphQL query retries, mutation is never submitted", async () => {
  const h = harness([502, 200]);
  await retryRead(
    h.transport,
    "https://api.github.com/graphql",
    { method: "POST", body: JSON.stringify({ query: "query Read { viewer { login } }" }) },
    h.time,
  );
  expect(h.calls()).toBe(2);
  await expect(
    retryRead(
      h.transport,
      "https://api.github.com/graphql",
      { method: "POST", body: JSON.stringify({ query: "mutation Change { doIt }" }) },
      h.time,
    ),
  ).rejects.toThrow("forbids mutations");
  expect(h.calls()).toBe(2);
});
test("explicit caller abort is not retried", async () => {
  const h = harness([200]);
  const abort = new AbortController();
  abort.abort();
  await expect(
    retryRead(h.transport, "https://api.github.com/x", { signal: abort.signal }, h.time),
  ).rejects.toThrow();
  expect(h.calls()).toBe(0);
});
test("transport failure while reading the response body retries the read", async () => {
  const h = harness([200]);
  let calls = 0;
  const transport = (async () => {
    calls++;
    if (calls === 1)
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new TypeError("connection reset"));
          },
        }),
      );
    return Response.json({ complete: true });
  }) as unknown as typeof fetch;
  expect(await (await retryRead(transport, "https://api.github.com/x", {}, h.time)).json()).toEqual(
    { complete: true },
  );
  expect(calls).toBe(2);
});
