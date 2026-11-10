import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createDb,
  readSignupNetworkVelocitySettings,
  setSignupNetworkVelocitySettings,
  type DbClient,
  type SignupNetworkVelocityChanges,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";

import { createApp } from "../src/app";
import { signupNetworkSource, SIGNUP_NETWORK_RATE_LIMIT_MESSAGE } from "../src/auth/signup-network";
import { apiRequestBindingsForTransportPeer } from "../src/http/request-source";

// Documentation-range addresses only (RFC 5737 / RFC 3849).
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
let ownerClient: DbClient | null = null;

const settings = testSettings({
  productAccessMode: "managed",
  publicBaseUrl: "http://opengeni.test",
  betterAuthSecret: "signup-network-onboarding-test-secret-32-bytes",
});

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("signup-network-onboarding-api");
  if (!shared && process.env.OPENGENI_REQUIRE_REAL_DB === "1") {
    throw new Error("signup network onboarding API tests require PostgreSQL");
  }
  if (shared) {
    settings.databaseUrl = shared.adminUrl;
    client = createDb(shared.appUrl, { max: 8 });
    ownerClient = createDb(shared.adminUrl, { max: 2 });
  }
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await ownerClient?.close().catch(() => undefined);
  await shared?.release();
}, 60_000);

let created: ReturnType<typeof createApp> | null = null;
function app() {
  return (created ??= createApp({
    settings,
    db: client!.db,
    bus: new MemoryEventBus(),
    workflowClient: {} as never,
  }));
}

async function configure(changes: SignupNetworkVelocityChanges) {
  const current = await readSignupNetworkVelocitySettings(ownerClient!.db);
  await setSignupNetworkVelocitySettings(ownerClient!.db, {
    changes,
    operator: "operator:test",
    reason: "signup network onboarding route test",
    expectedRevision: current.revision,
  });
}

/** A verified, signed-in user who has not set up an organization yet. */
async function signedInUser(): Promise<string> {
  const api = app();
  const email = `network-${crypto.randomUUID()}@example.test`;
  const password = "password1234";
  const signup = await api.request("/v1/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Network Owner", email, password }),
  });
  expect(signup.status).toBe(200);
  await shared!
    .admin`update auth_users set email_verified = true where lower(email) = lower(${email})`;
  const signin = await api.request("/v1/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password, rememberMe: true }),
  });
  expect(signin.status).toBe(200);
  const cookie = signin.headers
    .getSetCookie()
    .find((value) => value.includes("better-auth.session_token="))!;
  return cookie.split(";", 1)[0]!;
}

async function setUp(cookie: string, address: string | null, operationId = crypto.randomUUID()) {
  return await app().request(
    "/v1/auth/organization-onboarding",
    {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ organizationName: "Network Test", operationId, useCase: "embed" }),
    },
    apiRequestBindingsForTransportPeer(address),
  );
}

async function recordedFor(address: string) {
  const source = signupNetworkSource(address, settings.betterAuthSecret)!;
  const [row] = await shared!.admin<Array<{ count: number }>>`
    select count(*)::int as count from opengeni_private.signup_network_sources
    where address_hash = ${source.addressHash}`;
  return row?.count ?? 0;
}

describe("signup network velocity on organization onboarding", () => {
  test("hashes are keyed and never contain the address; unknown sources yield nothing", () => {
    const source = signupNetworkSource("192.0.2.10", "secret-a-at-least-32-bytes-long-xx")!;
    expect(source.addressHash).toMatch(/^[0-9a-f]{64}$/);
    expect(source.prefixHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(source)).not.toContain("192.0.2");
    const sameNetwork = signupNetworkSource("192.0.2.11", "secret-a-at-least-32-bytes-long-xx")!;
    expect(sameNetwork.prefixHash).toBe(source.prefixHash);
    expect(sameNetwork.addressHash).not.toBe(source.addressHash);
    const otherKey = signupNetworkSource("192.0.2.10", "secret-b-at-least-32-bytes-long-xx")!;
    expect(otherKey.addressHash).not.toBe(source.addressHash);
    expect(signupNetworkSource("::ffff:192.0.2.10", "secret-a-at-least-32-bytes-long-xx")).toEqual(
      source,
    );
    expect(signupNetworkSource("unknown", "secret-a-at-least-32-bytes-long-xx")).toBeNull();
    expect(signupNetworkSource("192.0.2.10", undefined)).toBeNull();
  });

  test("records every new self-serve owner by network; an unknown address records nothing", async () => {
    if (!shared || !client) return;
    const recorded = await setUp(await signedInUser(), "192.0.2.20");
    expect(recorded.status).toBe(200);
    expect(await recordedFor("192.0.2.20")).toBe(1);
    const before = await shared.admin<Array<{ count: number }>>`
      select count(*)::int as count from opengeni_private.signup_network_sources`;
    const unknown = await setUp(await signedInUser(), null);
    expect(unknown.status).toBe(200);
    const after = await shared.admin<Array<{ count: number }>>`
      select count(*)::int as count from opengeni_private.signup_network_sources`;
    expect(after[0]?.count).toBe(before[0]?.count);
  }, 120_000);

  test("the rate limit allows 5 per network per hour, refuses the 6th with the message, and allows replays", async () => {
    if (!shared || !client) return;
    // Off by default: a 6th from the same network succeeds.
    for (let i = 0; i < 6; i++) {
      expect((await setUp(await signedInUser(), "192.0.2.30")).status).toBe(200);
    }
    await configure({ rateLimitEnabled: true });
    try {
      const address = "192.0.2.40";
      let lastCookie = "";
      let lastOperation = "";
      for (let i = 0; i < 5; i++) {
        lastCookie = await signedInUser();
        lastOperation = crypto.randomUUID();
        expect((await setUp(lastCookie, address, lastOperation)).status).toBe(200);
      }
      const refused = await setUp(await signedInUser(), address);
      expect(refused.status).toBe(429);
      const body = (await refused.json()) as {
        error: { code: string; message: string; details?: { managedAuthCode?: string } };
      };
      expect(body.error.code).toBe("limit_exceeded");
      expect(body.error.message).toBe(SIGNUP_NETWORK_RATE_LIMIT_MESSAGE);
      expect(body.error.details?.managedAuthCode).toBe("organization_setup_rate_limited");
      expect(await recordedFor(address)).toBe(5);
      // A replay of a committed setup is never refused.
      expect((await setUp(lastCookie, address, lastOperation)).status).toBe(200);
      // Another network and an unknown source are unaffected.
      expect((await setUp(await signedInUser(), "198.51.100.40")).status).toBe(200);
      expect((await setUp(await signedInUser(), null)).status).toBe(200);
    } finally {
      await configure({ rateLimitEnabled: false });
    }
  }, 300_000);

  test("in enforce the third setup from one network holds earlier same-network accounts too", async () => {
    if (!shared || !client) return;
    await configure({ mode: "enforce" });
    try {
      const address = "203.0.113.50";
      const organizations: string[] = [];
      for (let i = 0; i < 3; i++) {
        const response = await setUp(await signedInUser(), address);
        expect(response.status).toBe(200);
        organizations.push(((await response.json()) as { organizationId: string }).organizationId);
      }
      const single = await setUp(await signedInUser(), "203.0.113.51");
      const singleId = ((await single.json()) as { organizationId: string }).organizationId;
      const decisions = await shared.admin<Array<{ accountId: string; decision: string }>>`
        select account_id::text as "accountId", decision from promotion_decisions
        where account_id = any(${[...organizations, singleId]}::uuid[])`;
      const byAccount = new Map(decisions.map((row) => [row.accountId, row.decision]));
      for (const organization of organizations) expect(byAccount.get(organization)).toBe("held");
      expect(byAccount.get(singleId)).not.toBe("held");
    } finally {
      await configure({ mode: "off" });
    }
  }, 300_000);
});
