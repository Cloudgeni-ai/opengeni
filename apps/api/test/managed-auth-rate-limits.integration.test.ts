import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDb, type DbClient } from "@opengeni/db";
import type { ManagedAuthSessionSetProjection } from "@opengeni/contracts/managed-auth-session-sets";
import {
  MANAGED_AUTH_SESSION_SET_API_CONTRACT_HEADER,
  MANAGED_AUTH_SESSION_SET_API_CONTRACT_REVISION,
} from "@opengeni/contracts/managed-auth-session-sets";
import {
  MANAGED_AUTH_ACTOR_EPOCH_HEADER,
  MANAGED_AUTH_LOGIN_TRANSACTION_COOKIE,
  MANAGED_AUTH_SESSION_SET_COOKIE,
} from "@opengeni/core/managed-auth-session-sets";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import type { Settings } from "@opengeni/config";

import { createApp } from "../src/app";
import { createManagedAuthDatabasePool, hashManagedAuthPassword } from "../src/auth/managed-auth";
import {
  consumeManagedAuthEmailThrottle,
  managedAuthEmailSourceThrottleKey,
  managedAuthEmailThrottleKey,
  MANAGED_AUTH_CLIENT_RATE_LIMIT_RULES,
  MANAGED_AUTH_EMAIL_THROTTLE_KEY_PREFIX,
  MANAGED_AUTH_EMAIL_THROTTLES,
} from "../src/auth/managed-auth-rate-limits";
import {
  apiRequestBindingsForTransportPeer,
  TRUSTED_CLIENT_ADDRESS_HEADER,
} from "../src/http/request-source";

const ORIGIN = "http://opengeni.test";
const SECRET = "managed-auth-rate-limit-integration-secret-32";
const EDGE_PEER = "10.0.0.10";

let shared: SharedTestDatabase;
let client: DbClient;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("managed-auth-rate-limits");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 8 });
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 60_000);

function managedApp(overrides: Partial<Settings> = {}) {
  return createApp({
    settings: testSettings({
      databaseUrl: shared.appUrl,
      productAccessMode: "managed",
      managedAuthSessionSetMode: "legacy",
      betterAuthSecret: SECRET,
      publicBaseUrl: ORIGIN,
      apiTrustedProxyHops: 1,
      apiTrustedProxyCidrs: "10.0.0.0/24",
      ...overrides,
    }),
    db: client.db,
    bus: new MemoryEventBus(),
    workflowClient: {} as never,
  });
}

async function postFromClient(
  app: ReturnType<typeof managedApp>,
  path: string,
  forwardedFor: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
  transportPeer = EDGE_PEER,
): Promise<Response> {
  return await app.request(
    path,
    {
      method: "POST",
      headers: {
        origin: ORIGIN,
        "content-type": "application/json",
        // ingress-nginx overwrites X-Forwarded-For with the address it saw;
        // an appending proxy leaves caller-supplied values on the left.
        "x-forwarded-for": forwardedFor,
        ...headers,
      },
      body: JSON.stringify(body),
    },
    apiRequestBindingsForTransportPeer(transportPeer),
  );
}

function uniqueEmail(label: string): string {
  return `rate-limit-${label}-${crypto.randomUUID()}@example.test`;
}

describe("managed auth rate limits with Better Auth and PostgreSQL", () => {
  test("keys client-address limits on the trusted client, not the proxy peer", async () => {
    const app = managedApp();
    const limited = "203.0.113.10";
    const max = MANAGED_AUTH_CLIENT_RATE_LIMIT_RULES["/sign-in/email"].max;
    for (let attempt = 0; attempt < max; attempt += 1) {
      const response = await postFromClient(app, "/v1/auth/sign-in/email", limited, {
        email: uniqueEmail("address"),
        password: "wrong-password-123",
      });
      expect(response.status).toBe(401);
    }
    const refused = await postFromClient(app, "/v1/auth/sign-in/email", limited, {
      email: uniqueEmail("address"),
      password: "wrong-password-123",
    });
    expect(refused.status).toBe(429);

    // A caller-supplied copy of the app-owned header cannot pick a new bucket.
    const spoofed = await postFromClient(
      app,
      "/v1/auth/sign-in/email",
      limited,
      { email: uniqueEmail("address"), password: "wrong-password-123" },
      { [TRUSTED_CLIENT_ADDRESS_HEADER]: "198.51.100.77" },
    );
    expect(spoofed.status).toBe(429);

    // A caller-prepended forwarding value cannot pick a new bucket either.
    const prepended = await postFromClient(
      app,
      "/v1/auth/sign-in/email",
      `198.51.100.78, ${limited}`,
      { email: uniqueEmail("address"), password: "wrong-password-123" },
    );
    expect(prepended.status).toBe(429);

    // Another client behind the same proxy keeps its own bucket.
    const neighbour = await postFromClient(
      app,
      "/v1/auth/sign-in/email",
      "192.0.2.1, 203.0.113.11",
      { email: uniqueEmail("address"), password: "wrong-password-123" },
    );
    expect(neighbour.status).toBe(401);

    const keys = await shared.admin<Array<{ key: string }>>`
      select key from auth_rate_limits where key like ${"%|/sign-in/email"} order by key
    `;
    expect(keys.map(({ key }) => key)).toEqual([
      `${limited}|/sign-in/email`,
      "203.0.113.11|/sign-in/email",
    ]);
  }, 60_000);

  test("ignores forwarding headers unless a proxy chain is declared", async () => {
    const app = managedApp({ apiTrustedProxyHops: 0, apiTrustedProxyCidrs: "" });
    const peer = "10.0.0.99";
    const max = MANAGED_AUTH_CLIENT_RATE_LIMIT_RULES["/sign-up/email"].max;
    const statuses: number[] = [];
    for (let attempt = 0; attempt <= max; attempt += 1) {
      const response = await postFromClient(
        app,
        "/v1/auth/sign-up/email",
        `203.0.113.${100 + attempt}`,
        { name: "Rotating Caller", email: uniqueEmail("rotating"), password: "password-12345" },
        {},
        peer,
      );
      statuses.push(response.status);
    }
    expect(statuses.slice(0, max).every((status) => status < 300)).toBe(true);
    expect(statuses[max]).toBe(429);
    const keys = await shared.admin<Array<{ key: string }>>`
      select key from auth_rate_limits where key like ${"%|/sign-up/email"}
    `;
    expect(keys).toEqual([{ key: `${peer}|/sign-up/email` }]);
  }, 60_000);

  test("limits one client address per email without locking out other addresses", async () => {
    const app = managedApp();
    const email = uniqueEmail("one-source");
    const attacker = "198.19.0.1";
    const { perSourceMax } = MANAGED_AUTH_EMAIL_THROTTLES["/sign-in/email"];
    for (let attempt = 0; attempt < perSourceMax; attempt += 1) {
      const response = await postFromClient(app, "/v1/auth/sign-in/email", attacker, {
        email,
        password: "wrong-password-123",
      });
      expect(response.status).toBe(401);
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const refused = await postFromClient(app, "/v1/auth/sign-in/email", attacker, {
        email,
        password: "wrong-password-123",
      });
      expect(refused.status).toBe(429);
      expect(Number(refused.headers.get("x-retry-after"))).toBeGreaterThan(0);
    }

    // The account owner, from another address, is not locked out.
    const owner = await postFromClient(app, "/v1/auth/sign-in/email", "198.19.0.2", {
      email,
      password: "wrong-password-123",
    });
    expect(owner.status).toBe(401);

    // Refused attempts never reached the email's shared window.
    const [emailWindow] = await shared.admin<Array<{ count: number }>>`
      select count from auth_rate_limits
      where key = ${managedAuthEmailThrottleKey(SECRET, "sign_in", email)}
    `;
    expect(emailWindow).toMatchObject({ count: perSourceMax + 1 });
    const [attackerWindow] = await shared.admin<Array<{ count: number }>>`
      select count from auth_rate_limits
      where key = ${managedAuthEmailSourceThrottleKey(SECRET, "sign_in", email, attacker)}
    `;
    expect(attackerWindow).toMatchObject({ count: perSourceMax + 1 });
  }, 60_000);

  test("throttles one email across rotating client addresses without storing it", async () => {
    const app = managedApp();
    const email = uniqueEmail("victim");
    const { perEmailMax } = MANAGED_AUTH_EMAIL_THROTTLES["/sign-in/email"];
    for (let attempt = 0; attempt < perEmailMax; attempt += 1) {
      const response = await postFromClient(
        app,
        "/v1/auth/sign-in/email",
        `198.18.${Math.floor(attempt / 200)}.${(attempt % 200) + 1}`,
        {
          email,
          password: "wrong-password-123",
        },
      );
      expect(response.status).toBe(401);
    }
    const refused = await postFromClient(app, "/v1/auth/sign-in/email", "198.18.255.1", {
      email: email.toUpperCase(),
      password: "wrong-password-123",
    });
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("x-retry-after"))).toBeGreaterThan(0);
    expect(await refused.json()).toMatchObject({ code: "TOO_MANY_REQUESTS" });

    const otherEmail = await postFromClient(app, "/v1/auth/sign-in/email", "198.18.255.2", {
      email: uniqueEmail("other"),
      password: "wrong-password-123",
    });
    expect(otherEmail.status).toBe(401);

    const [stored] = await shared.admin<Array<{ key: string; count: number }>>`
      select key, count from auth_rate_limits
      where key = ${managedAuthEmailThrottleKey(SECRET, "sign_in", email)}
    `;
    expect(stored).toMatchObject({ count: perEmailMax + 1 });
    const leaked = await shared.admin<Array<{ key: string }>>`
      select key from auth_rate_limits where key ilike ${"%rate-limit-victim%"}
    `;
    expect(leaked).toEqual([]);
    // Better Auth's own keys hold the client address; the per-email ones never do.
    const addressed = await shared.admin<Array<{ key: string }>>`
      select key from auth_rate_limits
      where key like ${`${MANAGED_AUTH_EMAIL_THROTTLE_KEY_PREFIX}%`} and key like ${"%198.18.%"}
    `;
    expect(addressed).toEqual([]);
  }, 60_000);

  test("records the trusted client address on the created session", async () => {
    const app = managedApp();
    const email = uniqueEmail("session");
    const password = "correct-password-123";
    const userId = crypto.randomUUID();
    await shared.admin`
      insert into auth_users (id, name, email, email_verified)
      values (${userId}, 'Rate Limit Human', ${email}, true)
    `;
    await shared.admin`
      insert into auth_identities (id, user_id, provider_id, account_id, password, created_at, updated_at)
      values (${crypto.randomUUID()}, ${userId}, 'credential', ${userId},
        ${await hashManagedAuthPassword(password)}, now(), now())
    `;
    const response = await postFromClient(app, "/v1/auth/sign-in/email", "203.0.113.50", {
      email,
      password,
    });
    expect(response.status).toBe(200);
    const sessions = await shared.admin<Array<{ ip_address: string | null }>>`
      select ip_address from auth_sessions where user_id = ${userId}
    `;
    expect(sessions).toEqual([{ ip_address: "203.0.113.50" }]);
  }, 60_000);

  test("throttles the session-set email sign-in as a typed login rate limit", async () => {
    const app = managedApp({ managedAuthSessionSetMode: "dual" });
    const email = uniqueEmail("session-set");
    const { perEmailMax, windowSeconds } = MANAGED_AUTH_EMAIL_THROTTLES["/sign-in/email"];
    for (let attempt = 0; attempt < perEmailMax; attempt += 1) {
      await consumeManagedAuthEmailThrottle(client.db, {
        key: managedAuthEmailThrottleKey(SECRET, "sign_in", email),
        windowSeconds,
        max: perEmailMax,
      });
    }

    const initialResponse = await app.request("/v1/auth/session-set");
    const initial = (await initialResponse.json()) as ManagedAuthSessionSetProjection;
    const authority = oneCookie(initialResponse, MANAGED_AUTH_SESSION_SET_COOKIE);
    const begin = await app.request("/v1/auth/session-set/transactions", {
      method: "POST",
      headers: mutationHeaders(initial, authority),
      body: JSON.stringify({
        operationId: crypto.randomUUID(),
        expectedGeneration: initial.generation,
        kind: "add",
      }),
    });
    expect(begin.status).toBe(200);
    const transaction = (await begin.json()) as { id: string };
    const transactionCookie = oneCookie(begin, MANAGED_AUTH_LOGIN_TRANSACTION_COOKIE);
    const completion = await app.request("/v1/auth/session-set/transactions/email-password", {
      method: "POST",
      headers: mutationHeaders(initial, `${authority}; ${transactionCookie}`),
      body: JSON.stringify({
        operationId: crypto.randomUUID(),
        expectedGeneration: initial.generation,
        transactionId: transaction.id,
        email,
        password: "wrong-password-123",
      }),
    });
    expect(completion.status).toBe(429);
    const retryAfter = Number(completion.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThan(windowSeconds - 60);
    expect(retryAfter).toBeLessThanOrEqual(windowSeconds);
    expect(await completion.json()).toMatchObject({
      error: {
        details: {
          managedAuthCode: "login_transaction_rate_limited",
          retryAfterSeconds: retryAfter,
        },
      },
    });
  }, 60_000);

  test("expires a fixed per-email window after its deadline", async () => {
    const key = managedAuthEmailThrottleKey(SECRET, "password_reset", uniqueEmail("window"));
    const first = await consumeManagedAuthEmailThrottle(client.db, {
      key,
      windowSeconds: 3600,
      max: 1,
    });
    expect(first).toEqual({ allowed: true, retryAfterSeconds: 3600 });
    const second = await consumeManagedAuthEmailThrottle(client.db, {
      key,
      windowSeconds: 3600,
      max: 1,
    });
    expect(second.allowed).toBe(false);
    expect(second.retryAfterSeconds).toBeGreaterThan(3590);

    // Better Auth prunes rows whose `last_request` is over 60 s old; the
    // deadline keeps an active window's row alive until it expires.
    await shared.admin`
      update auth_rate_limits
      set last_request = (extract(epoch from clock_timestamp()) * 1000)::bigint - 1
      where key = ${key}
    `;
    const reopened = await consumeManagedAuthEmailThrottle(client.db, {
      key,
      windowSeconds: 3600,
      max: 1,
    });
    expect(reopened.allowed).toBe(true);
  });

  test("keeps serving after the server closes idle and checked-out connections", async () => {
    const warnings: string[] = [];
    const outcomes: unknown[] = [];
    const pool = createManagedAuthDatabasePool(shared.adminUrl, {
      warn: (message) => warnings.push(message),
      incrementCounter: ({ labels }) => outcomes.push(labels?.outcome),
    });
    try {
      const idle = await pool.connect();
      const [{ pid: idlePid }] = (await idle.query("select pg_backend_pid() as pid")).rows;
      idle.release();
      await shared.admin`select pg_terminate_backend(${idlePid}::integer)`;
      await waitFor(() => warnings.length === 1);
      expect((await pool.query("select 1 as ok")).rows).toEqual([{ ok: 1 }]);

      // A checked-out client reports the closed connection on itself; without
      // the pool's per-client listener this is an uncaught exception.
      const busy = await pool.connect();
      let busyFailed = false;
      busy.once("error", () => {
        busyFailed = true;
      });
      const [{ pid: busyPid }] = (await busy.query("select pg_backend_pid() as pid")).rows;
      await shared.admin`select pg_terminate_backend(${busyPid}::integer)`;
      await waitFor(() => busyFailed);
      await expect(busy.query("select 1")).rejects.toThrow();
      busy.release();
      expect((await pool.query("select 1 as ok")).rows).toEqual([{ ok: 1 }]);
      expect(outcomes).toEqual(["idle_connection_discarded", "checked_out_connection_failed"]);
    } finally {
      await pool.end();
    }
  }, 30_000);
});

function oneCookie(response: Response, name: string): string {
  const value = response.headers.getSetCookie().find((cookie) => cookie.startsWith(`${name}=`));
  if (!value) throw new Error(`response omitted ${name}`);
  return value.split(";", 1)[0]!;
}

function mutationHeaders(
  projection: ManagedAuthSessionSetProjection,
  cookies: string,
): Record<string, string> {
  return {
    origin: ORIGIN,
    "sec-fetch-site": "same-origin",
    "content-type": "application/json",
    [MANAGED_AUTH_SESSION_SET_API_CONTRACT_HEADER]: MANAGED_AUTH_SESSION_SET_API_CONTRACT_REVISION,
    "x-opengeni-session-csrf": projection.csrfToken,
    [MANAGED_AUTH_ACTOR_EPOCH_HEADER]: projection.actorEpoch,
    cookie: cookies,
  };
}

async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await Bun.sleep(25);
  }
}
