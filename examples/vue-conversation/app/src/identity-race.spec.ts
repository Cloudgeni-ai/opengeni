import { afterEach, expect, test } from "bun:test";
import { createSSRApp, h } from "vue";
import { renderToString } from "vue/server-renderer";
import { useConversation } from "./useConversation";

const originalFetch = globalThis.fetch;
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
const originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [name, descriptor] of [
    ["sessionStorage", originalStorage],
    ["location", originalLocation],
  ] as const) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture() {
  const storage = new Map<string, string>();
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
  });
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { origin: "https://host.example" },
  });
  let state!: ReturnType<typeof useConversation>;
  // Invoke the composable inside real Vue setup so lifecycle registration is valid.
  await renderToString(
    createSSRApp({
      setup() {
        state = useConversation();
        return () => h("div");
      },
    }),
  );
  return { state, storage };
}
const hostContext = (user: string) =>
  Response.json({ workspaceId: `ws-${user}`, storageScope: user, csrf: `csrf-${user}` });

test("a stale account's create cannot render private data or clear the new account's pending request", async () => {
  const { state, storage } = await fixture();
  let user = "A";
  const createA = deferred<Response>();
  const createB = deferred<Response>();
  const startedA = deferred<void>();
  const startedB = deferred<void>();
  globalThis.fetch = (async (input, init) => {
    const path = new URL(String(input), "https://host.example").pathname;
    if (path === "/api/context") return hostContext(user);
    if (init?.method === "POST") {
      const csrf = new Headers(init.headers).get("x-host-csrf");
      if (csrf === "csrf-A") {
        startedA.resolve();
        return createA.promise;
      }
      startedB.resolve();
      return createB.promise;
    }
    return Response.json({ sessions: [], pinned: [], nextCursor: null });
  }) as typeof fetch;
  await state.load();
  const sendingA = state.send("Private account A message");
  await startedA.promise;
  user = "B";
  await state.load();
  const sendingB = state.send("Account B message");
  await startedB.promise;
  const savedB = storage.get("harbor:B:pending");
  createA.resolve(
    Response.json({
      id: "session-A",
      workspaceId: "ws-A",
      title: "Private A title",
      initialMessage: "Private account A message",
      status: "idle",
    }),
  );
  await sendingA;
  expect(state.active.value).toBeNull();
  expect(state.sessions.value).toEqual([]);
  expect(state.pending.value?.text).toBe("Account B message");
  expect(storage.get("harbor:B:pending")).toBe(savedB);
  expect(storage.has("harbor:B:session")).toBe(false);
  expect(storage.has("harbor:A:pending")).toBe(true);
  expect(state.busy.value).toBe(true);
  createB.resolve(Response.json({ code: "unavailable", retryable: false }, { status: 503 }));
  await sendingB;
});

test("an old host-context load cannot overwrite a newer account's loaded state", async () => {
  const { state, storage } = await fixture();
  const delayedA = deferred<Response>();
  let contexts = 0;
  globalThis.fetch = (async (input) => {
    if (String(input) === "/api/context")
      return ++contexts === 1 ? delayedA.promise : hostContext("B");
    return Response.json({ sessions: [], pinned: [], nextCursor: null });
  }) as typeof fetch;
  storage.set(
    "harbor:A:pending",
    JSON.stringify({ kind: "create", text: "Private A pending", id: "A-id" }),
  );
  storage.set(
    "harbor:B:pending",
    JSON.stringify({ kind: "create", text: "B pending", id: "B-id" }),
  );
  const loadingA = state.load();
  await state.load();
  delayedA.resolve(hostContext("A"));
  await loadingA;
  expect(state.signedIn.value).toBe(true);
  expect(state.pending.value?.text).toBe("B pending");
  expect(state.error.value).toBe("");
});
