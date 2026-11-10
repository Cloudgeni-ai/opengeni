import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createDb, type DbClient } from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";

import { createApp } from "../src/app";
import { MANAGED_AUTH_PASSWORD_COMPROMISED_CODE } from "../src/auth/password-breach";

const ORIGIN = "http://opengeni.test";
const SECRET = "managed-auth-breached-password-secret-0032";
const BREACHED = "correct horse battery staple";

let shared: SharedTestDatabase;
let client: DbClient;
const realFetch = globalThis.fetch;
const rangeRequests: string[] = [];

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("managed-auth-breached-password");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 4 });
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 60_000);

afterEach(() => {
  globalThis.fetch = realFetch;
  rangeRequests.length = 0;
});

/** Answers Have I Been Pwned range queries: only {@link BREACHED} is known. */
function stubPwnedPasswords(): void {
  const hash = createHash("sha1").update(BREACHED).digest("hex").toUpperCase();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith("https://api.pwnedpasswords.com/range/"))
      return await realFetch(input, init);
    const prefix = url.slice(-5);
    rangeRequests.push(prefix);
    const body =
      prefix === hash.slice(0, 5)
        ? `0000000000000000000000000000000000A:3\r\n${hash.slice(5)}:52\r\n`
        : "0000000000000000000000000000000000A:3\r\n";
    return new Response(body, { status: 200, headers: { "content-type": "text/plain" } });
  }) as typeof fetch;
}

function managedApp() {
  return createApp({
    settings: testSettings({
      databaseUrl: shared.appUrl,
      productAccessMode: "managed",
      managedAuthSessionSetMode: "legacy",
      managedAuthRequireEmailVerification: false,
      managedAuthBreachedPasswordCheck: true,
      betterAuthSecret: SECRET,
      publicBaseUrl: ORIGIN,
    }),
    db: client.db,
    bus: new MemoryEventBus(),
    workflowClient: {} as never,
  });
}

async function signUp(app: ReturnType<typeof managedApp>, password: string): Promise<Response> {
  return await app.request("/v1/auth/sign-up/email", {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({
      name: "Breach Check",
      email: `breach-${crypto.randomUUID()}@example.test`,
      password,
    }),
  });
}

describe("managed auth breached-password check", () => {
  test("refuses sign-up with a breached password and sends only a hash prefix", async () => {
    stubPwnedPasswords();
    const app = managedApp();

    const refused = await signUp(app, BREACHED);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ code: MANAGED_AUTH_PASSWORD_COMPROMISED_CODE });
    expect(rangeRequests).toEqual([
      createHash("sha1").update(BREACHED).digest("hex").toUpperCase().slice(0, 5),
    ]);

    const accepted = await signUp(app, "an unbreached passphrase 8c1f");
    expect(accepted.status).toBe(200);
  }, 60_000);

  test("lets sign-up through when the lookup service is unreachable", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith("https://api.pwnedpasswords.com/")) throw new TypeError("fetch failed");
      return await realFetch(input, init);
    }) as typeof fetch;
    const response = await signUp(managedApp(), BREACHED);
    expect(response.status).toBe(200);
  }, 60_000);
});
