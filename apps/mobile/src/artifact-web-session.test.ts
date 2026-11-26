import { afterAll, beforeEach, expect, mock, test } from "bun:test";

const tokens = new Map<string, string>();
mock.module("expo-secure-store", () => ({
  getItemAsync: async (key: string) => tokens.get(key) ?? null,
  setItemAsync: async () => undefined,
  deleteItemAsync: async () => undefined,
}));
mock.module("react-native", () => ({
  Linking: { openURL: async () => true },
  Platform: { OS: "ios" },
}));

const { signInWebViews } = await import("./artifact-web-session");

const realFetch = globalThis.fetch;
const posts: string[] = [];
beforeEach(() => {
  posts.length = 0;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    posts.push(String(headers.authorization));
    return new Response(null, { status: 204 });
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

const setToken = (id: string, token: string) => tokens.set(`opengeni.accounts.token.${id}`, token);

test("one server's sign-in is reused for the same account and token", async () => {
  setToken("a", "token-a");
  const a = { id: "a", baseUrl: "https://reuse.example" };
  expect(await signInWebViews(a)).toBe(true);
  expect(await signInWebViews(a)).toBe(true);
  expect(posts).toEqual(["Bearer token-a"]);
});

test("another account on the same server signs the web views in again", async () => {
  setToken("a", "token-a");
  setToken("b", "token-b");
  const server = "https://switch.example";
  await signInWebViews({ id: "a", baseUrl: server });
  await signInWebViews({ id: "b", baseUrl: server });
  // Back to A: the cookie now belongs to B, so A must sign in again.
  await signInWebViews({ id: "a", baseUrl: server });
  expect(posts).toEqual(["Bearer token-a", "Bearer token-b", "Bearer token-a"]);
});

test("a new token after signing in again signs the web views in again", async () => {
  const a = { id: "a", baseUrl: "https://resign.example" };
  setToken("a", "old");
  await signInWebViews(a);
  setToken("a", "new");
  await signInWebViews(a);
  expect(posts).toEqual(["Bearer old", "Bearer new"]);
});

test("signed out: no request", async () => {
  expect(await signInWebViews({ id: "nobody", baseUrl: "https://none.example" })).toBe(false);
  expect(posts).toEqual([]);
});
