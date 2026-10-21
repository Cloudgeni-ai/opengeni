import { afterEach, expect, jest, test } from "bun:test";
import { readBootstrap } from "./bootstrap-read";

afterEach(() => jest.useRealTimers());
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

test("an already cancelled bootstrap never starts a request", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const error = await readBootstrap({
    context: "client_configuration",
    signal: controller.signal,
    request: async () => {
      calls++;
      return "unused";
    },
  }).catch((failure) => failure);
  expect(error.name).toBe("AbortError");
  expect(calls).toBe(0);
});

test("terminal sibling failure cancels pending access retries", async () => {
  jest.useFakeTimers();
  const controller = new AbortController();
  let calls = 0;
  const permanent = { status: 403 };
  const pending = readBootstrap({
    context: "workspace_access",
    signal: controller.signal,
    request: async () => {
      calls++;
      throw { status: 503 };
    },
  });
  const denied = readBootstrap({
    context: "workspace_access",
    signal: controller.signal,
    request: async () => {
      throw permanent;
    },
  });
  const result = await Promise.all([pending, denied]).catch((error) => {
    controller.abort();
    return error;
  });
  expect(result).toBe(permanent);
  jest.advanceTimersByTime(60_000);
  await flush();
  expect(calls).toBe(1);
});

test.each([500, 502, 503, 504, new TypeError("Failed to fetch")])(
  "recovers from %s",
  async (failure) => {
    jest.useFakeTimers();
    let calls = 0;
    const result = readBootstrap({
      context: "workspace_access",
      signal: new AbortController().signal,
      request: async () => {
        if (++calls === 1) throw typeof failure === "number" ? { status: failure } : failure;
        return "ready";
      },
    });
    await flush();
    expect(calls).toBe(1);
    jest.advanceTimersByTime(499);
    await flush();
    expect(calls).toBe(1);
    jest.advanceTimersByTime(1);
    expect(await result).toBe("ready");
    expect(calls).toBe(2);
  },
);

test("exhausts exactly three attempts and preserves the last failure", async () => {
  jest.useFakeTimers();
  let calls = 0;
  const error = { status: 503 };
  const result = readBootstrap({
    context: "client_configuration",
    signal: new AbortController().signal,
    request: async () => {
      calls++;
      throw error;
    },
  }).catch((failure) => failure);
  await flush();
  jest.advanceTimersByTime(500);
  await flush();
  expect(calls).toBe(2);
  jest.advanceTimersByTime(1_500);
  expect(await result).toBe(error);
  jest.advanceTimersByTime(60_000);
  expect(calls).toBe(3);
});

test.each([
  { status: 400 },
  { status: 401 },
  { status: 403 },
  { status: 404 },
  { status: 409 },
  { status: 500 },
  { status: 422 },
  { status: 429 },
  { status: 501 },
  { status: 503, body: '{"error":"maintenance"}' },
  new SyntaxError("Invalid JSON"),
  new TypeError("Cannot read properties of undefined"),
  new DOMException("Aborted", "AbortError"),
  new Error("invalid config"),
])("does not retry permanent failures: %s", async (error) => {
  let calls = 0;
  const result = readBootstrap({
    context: "client_configuration",
    signal: new AbortController().signal,
    request: async () => {
      calls++;
      throw error;
    },
  }).catch((failure) => failure);
  expect(await result).toBe(error);
  expect(calls).toBe(1);
});

test.each(["abort", "principal"])("%s prevents a scheduled retry", async (transition) => {
  jest.useFakeTimers();
  const controller = new AbortController();
  let current = true;
  let calls = 0;
  const result = readBootstrap({
    context: "workspace_access",
    signal: controller.signal,
    isCurrent: () => current,
    request: async () => {
      calls++;
      throw { status: 503 };
    },
  }).catch((error) => error);
  await flush();
  if (transition === "abort") controller.abort();
  else current = false;
  jest.advanceTimersByTime(500);
  expect((await result).name).toBe("AbortError");
  expect(calls).toBe(1);
});

test.each([true, false])("discards stale in-flight success=%s", async (success) => {
  let current = true;
  let resolve!: (value: string) => void;
  let reject!: (error: unknown) => void;
  const result = readBootstrap({
    context: "workspace_access",
    signal: new AbortController().signal,
    isCurrent: () => current,
    request: () =>
      new Promise<string>((yes, no) => {
        resolve = yes;
        reject = no;
      }),
  }).catch((error) => error);
  current = false;
  if (success) resolve("old principal");
  else reject({ status: 503 });
  expect((await result).name).toBe("AbortError");
});
