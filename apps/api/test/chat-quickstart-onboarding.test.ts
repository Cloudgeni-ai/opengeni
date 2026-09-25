import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { OpenGeni } from "@opengeni/sdk/chat";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { createDb, createOrganizationApiKey, type DbClient } from "@opengeni/db";
import {
  createQuickstartChatHandler,
  onboardChatUser,
} from "../../../examples/chat-quickstart/quickstart";
import { registerSessionRoutes } from "../src/routes/sessions";
import { registerWorkspaceRoutes } from "../src/routes/workspaces";
import { organizationApiKeyPermissionsForAccess } from "../src/routes/api-keys";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let available = true;
let shared: SharedTestDatabase;
let db: DbClient;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("chat-quickstart-onboarding");
  if (!acquired) {
    if (requireRealDatabase) {
      throw new Error("PostgreSQL test database unavailable while OPENGENI_REQUIRE_REAL_DB=1");
    }
    available = false;
    return;
  }
  shared = acquired;
  db = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await db?.close();
  await shared?.release();
});

async function fixture() {
  const [account] =
    await shared.admin`insert into managed_accounts (name) values ('Chat quickstart') returning id`;
  const accountId = String(account!.id);
  const token = crypto.randomUUID();
  await createOrganizationApiKey(db.db, {
    accountId,
    name: "Chat quickstart backend",
    prefix: "test",
    keyHash: createHash("sha256").update(token).digest("hex"),
    permissions: organizationApiKeyPermissionsForAccess("full"),
  });
  const noop = async () => undefined;
  const deps = {
    db: db.db,
    settings: testSettings({
      databaseUrl: shared.appUrl,
      productAccessMode: "configured",
      sandboxBackend: "none",
    }),
    bus: new MemoryEventBus(),
    objectStorage: null,
    workflowClient: {
      signalUserMessage: noop,
      wakeSessionWorkflow: noop,
      requestSessionWorkflowWakeDispatch: noop,
      signalSessionControl: noop,
    },
    documentIndexer: { indexDocument: noop },
    getDocumentServices: () => ({}),
  } as unknown as ApiRouteDeps;
  const api = new Hono();
  api.onError((error, c) => {
    if (error instanceof HTTPException) return c.json({ message: error.message }, error.status);
    throw error;
  });
  registerWorkspaceRoutes(api, deps);
  registerSessionRoutes(api, deps);
  const og = new OpenGeni({
    apiKey: token,
    organizationId: accountId,
    baseUrl: "http://opengeni.test",
    source: "chat-quickstart",
    fetch: async (input, init) => await api.request(input, init),
  });
  const chat = createQuickstartChatHandler(og, "demo-tenant");
  const call = (method: "GET" | "POST", body?: unknown, signal?: AbortSignal) =>
    chat(
      new Request("http://127.0.0.1:4200/api/chat", {
        method,
        headers: {
          "content-type": "application/json",
          "x-demo-user": "u_42",
          "x-opengeni-conversation": "c_1",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(signal ? { signal } : {}),
      }),
    );
  return { og, call };
}

type History = {
  sessionId: string;
  created: boolean;
  messages: { role: string; text: string }[];
};

/**
 * Send one message through the quickstart handler and stop reading its stream
 * once the durable timeline shows the message (no worker runs the turn here).
 * Progress is watched with the organization key so the only request made as
 * the product user is the send itself.
 */
async function send(
  f: Awaited<ReturnType<typeof fixture>>,
  target: { workspaceId: string; sessionId: string },
  message: string,
): Promise<void> {
  const abort = new AbortController();
  const response = await f.call("POST", { message }, abort.signal);
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  const reading = reader.read().then(
    (chunk) => (chunk.value ? new TextDecoder().decode(chunk.value) : ""),
    () => "",
  );
  let delivered = false;
  for (let attempt = 0; attempt < 200 && !delivered; attempt += 1) {
    const page = await f.og.client
      .listEventPage(target.workspaceId, target.sessionId, { includeTypes: ["user.message"] })
      .catch(() => null);
    delivered =
      page?.events.some((event) => (event.payload as { text?: unknown }).text === message) ?? false;
    if (!delivered) await Bun.sleep(25);
  }
  abort.abort();
  await reader.cancel().catch(() => undefined);
  // A failed create or send would surface as a native `event: error` chunk.
  expect(await reading).not.toContain("event: error");
  expect(delivered).toBe(true);
}

test("the chat quickstart works as written once the user is onboarded", async () => {
  if (!available) return;
  const f = await fixture();

  // Chat requests never grant workspace membership: before onboarding the
  // API refuses the product user, which the handler returns as a 403.
  expect((await f.call("POST", { message: "Hello" })).status).toBe(403);
  expect((await f.call("GET")).status).toBe(403);

  const workspaceId = await onboardChatUser(f.og, {
    tenant: "demo-tenant",
    user: "u_42",
    operationId: crypto.randomUUID(),
  });

  const empty = (await (await f.call("GET")).json()) as History;
  expect(empty).toMatchObject({ created: false, messages: [] });
  const target = { workspaceId, sessionId: empty.sessionId };

  await send(f, target, "Hello");
  // A follow-up in the same conversation uses the membership's session control.
  await send(f, target, "And the next step?");

  const history = (await (await f.call("GET")).json()) as History;
  expect(history.created).toBe(true);
  expect(history.messages.map(({ role, text }) => ({ role, text }))).toEqual([
    { role: "user", text: "Hello" },
    { role: "user", text: "And the next step?" },
  ]);
}, 60_000);
