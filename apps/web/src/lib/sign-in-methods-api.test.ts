import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { configureClientAuth, configureManagedActorEpoch, setStoredAccessKey } from "@/api";
import { createSignInMethodsApi } from "./sign-in-methods-api";

if (!globalThis.document) GlobalRegistrator.register();
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  configureManagedActorEpoch(null);
  localStorage.clear();
});
afterAll(() => GlobalRegistrator.unregister());
const projection = {
  mode: "broker",
  generation: "1",
  actorEpoch: "7",
  csrfToken: "c".repeat(43),
  selectedSlotId: "00000000-0000-4000-8000-000000000001",
  state: "ready",
  slots: [
    {
      id: "00000000-0000-4000-8000-000000000001",
      displayName: "Person",
      verifiedClaim: { kind: "email", value: "person@example.com" },
      state: "active",
    },
  ],
};
test("security mutations use cookie-only actor and CSRF admission, preserving exact replay", async () => {
  configureClientAuth({
    mode: "managedSession",
    session: "cookie",
    socialProviders: ["google", "github"],
  });
  configureManagedActorEpoch("7");
  setStoredAccessKey("test-key-must-not-leave-browser");
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    return Response.json(
      url.endsWith("session-set")
        ? projection
        : { reauthenticationRequired: true, notification: "sent" },
    );
  }) as typeof fetch;
  const api = createSignInMethodsApi("broker");
  const command = await api.prepare("disconnect", {
    operationId: "00000000-0000-4000-8000-000000000002",
    expectedIdentityRevision: 4,
    expectedIdentityId: "00000000-0000-4000-8000-000000000003",
    provider: "github",
  });
  await api.execute(command);
  await api.execute(command);
  const mutations = calls.filter((call) => call.init.method === "POST");
  expect(mutations).toHaveLength(2);
  expect(mutations[0]!.init.body).toBe(mutations[1]!.init.body);
  const headers = new Headers(mutations[0]!.init.headers);
  expect(headers.get("x-opengeni-session-csrf")).toBe(projection.csrfToken);
  expect(headers.get("x-opengeni-actor-epoch")).toBe("7");
  expect(headers.has("authorization")).toBe(false);
  expect(headers.has("x-opengeni-access-key")).toBe(false);
  expect(mutations[0]!.init.credentials).toBe("include");
  expect(JSON.parse(String(mutations[0]!.init.body)).expectedIdentityId).toBe(
    "00000000-0000-4000-8000-000000000003",
  );
  expect(mutations[0]!.url).toEndWith("/v1/auth/sign-in-methods/disconnect");
});

test("legacy refuses inventory and commands without an expected canonical identity", async () => {
  let calls = 0;
  globalThis.fetch = (async (_input: unknown) => {
    calls++;
    return Response.json({ email: "old@example.com", identityRevision: 1, methods: [] });
  }) as typeof fetch;
  const api = createSignInMethodsApi("legacy");
  await expect(api.list()).rejects.toThrow("Missing canonical identity binding");
  await expect(
    api.prepare("disconnect", {
      operationId: "00000000-0000-4000-8000-000000000002",
      expectedIdentityRevision: 1,
      expectedIdentityId: "",
      provider: "google",
    }),
  ).rejects.toThrow("Missing expected canonical identity binding");
  expect(calls).toBe(1);
});
test("legacy uses no session-set lookup and carries current password only in the body", async () => {
  const urls: string[] = [];
  globalThis.fetch = (async (input) => {
    urls.push(String(input));
    return Response.json({ reauthenticationRequired: true, notification: "failed" });
  }) as typeof fetch;
  const api = createSignInMethodsApi("legacy");
  const command = await api.prepare("password", {
    operationId: "00000000-0000-4000-8000-000000000002",
    expectedIdentityRevision: 4,
    expectedIdentityId: "00000000-0000-4000-8000-000000000003",
    newPassword: "test-new-password",
    currentPassword: "test-current-password",
  });
  expect(command.headers).toEqual({});
  await api.execute(command);
  expect(urls).toEqual(["/v1/auth/sign-in-methods/password"]);
});
test("an actor switch rejects old clients before dispatch and late responses after dispatch", async () => {
  configureManagedActorEpoch("7");
  const api = createSignInMethodsApi("broker");
  configureManagedActorEpoch("8");
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return Response.json({});
  }) as unknown as typeof fetch;
  await expect(api.list()).rejects.toThrow("browser account changed");
  expect(calls).toBe(0);
  let release!: (response: Response) => void;
  const nextApi = createSignInMethodsApi("broker");
  globalThis.fetch = (() =>
    new Promise((resolve) => {
      release = resolve;
    })) as unknown as typeof fetch;
  const pending = nextApi.list();
  configureManagedActorEpoch("9");
  release(Response.json({ email: "old@example.com" }));
  await expect(pending).rejects.toThrow();
});

test("reads the auth route's flat error envelope without losing the stable security code", async () => {
  globalThis.fetch = (async (_input: unknown) =>
    Response.json(
      { code: "SIGN_IN_METHOD_LAST_USABLE_METHOD", message: "last usable method" },
      { status: 403 },
    )) as typeof fetch;
  const api = createSignInMethodsApi("legacy");
  const command = await api.prepare("disconnect", {
    operationId: "00000000-0000-4000-8000-000000000002",
    expectedIdentityRevision: 4,
    expectedIdentityId: "00000000-0000-4000-8000-000000000003",
    provider: "google",
  });
  await expect(api.execute(command)).rejects.toMatchObject({
    status: 403,
    code: "SIGN_IN_METHOD_LAST_USABLE_METHOD",
  });
});
