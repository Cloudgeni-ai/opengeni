import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDb, type DbClient } from "@opengeni/db";
import { migrate } from "@opengeni/db/migrate";
import { provisionRoles } from "@opengeni/db/provision-roles";
import {
  MANAGED_AUTH_SESSION_SET_API_CONTRACT_HEADER,
  MANAGED_AUTH_SESSION_SET_API_CONTRACT_REVISION,
  type ManagedAuthSessionSetProjection,
} from "@opengeni/contracts/managed-auth-session-sets";
import {
  MANAGED_AUTH_ACTOR_EPOCH_HEADER,
  MANAGED_AUTH_LOGIN_TRANSACTION_COOKIE,
  MANAGED_AUTH_SESSION_SET_COOKIE,
} from "@opengeni/core/managed-auth-session-sets";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";

import { createApp } from "../src/app";

// Adding an account with email and password in dual or broker session-set mode
// used to turn every refusal from Better Auth (a wrong password, an address
// the deployment doesn't allow, a session its hooks declined) into a 500
// internal_error, which the add-account window could only show as a failure
// to retry. Each refusal now has a typed 4xx and adds no account.

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
const PASSWORD = "add-account-password-123";

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("managed-auth-session-set-email-password-refusals");
  if (!shared) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") {
      throw new Error("session-set email/password refusal tests require PostgreSQL");
    }
    return;
  }
  await migrate(shared.adminUrl);
  await provisionRoles(shared.adminUrl, {
    appPassword: decodeURIComponent(new URL(shared.appUrl).password),
  });
  client = createDb(shared.appUrl, { max: 8 });
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 60_000);

function oneCookie(response: Response, name: string): string {
  const value = response.headers.getSetCookie().find((cookie) => cookie.startsWith(`${name}=`));
  if (!value) throw new Error(`response omitted ${name}`);
  return value.split(";", 1)[0]!;
}

function app(
  mode: "dual" | "broker",
  allowedUserEmails: string[],
  { requireEmailVerification = false }: { requireEmailVerification?: boolean } = {},
) {
  return createApp({
    settings: testSettings({
      databaseUrl: shared!.adminUrl,
      productAccessMode: "managed",
      managedAuthSessionSetMode: mode,
      betterAuthSecret: "managed-session-set-refusal-secret-at-least-32-bytes",
      publicBaseUrl: "http://opengeni.test",
      managedAuthRequireEmailVerification: requireEmailVerification,
      allowedUserEmails,
    }),
    db: client!.db,
    bus: new MemoryEventBus(),
    workflowClient: {} as never,
  });
}

/**
 * Opens the add-account window's transaction and submits email and password,
 * once per entry in `passwords`, as the window does when the person retries.
 */
async function addAccount(
  target: ReturnType<typeof app>,
  email: string,
  ...passwords: [string, ...string[]]
): Promise<{ completion: Response; earlier: Response[]; after: ManagedAuthSessionSetProjection }> {
  // In-process requests share one client address; each attempt here stands
  // for a different person, so the per-client login-transaction limit
  // mustn't decide the outcome.
  await shared!.admin`delete from managed_auth_login_transaction_rate_limits`;
  const initialResponse = await target.request("/v1/auth/session-set");
  const initial = (await initialResponse.json()) as ManagedAuthSessionSetProjection;
  const authorityCookie = oneCookie(initialResponse, MANAGED_AUTH_SESSION_SET_COOKIE);
  const headers = (cookie: string) => ({
    origin: "http://opengeni.test",
    "sec-fetch-site": "same-origin",
    "content-type": "application/json",
    [MANAGED_AUTH_SESSION_SET_API_CONTRACT_HEADER]: MANAGED_AUTH_SESSION_SET_API_CONTRACT_REVISION,
    "x-opengeni-session-csrf": initial.csrfToken,
    [MANAGED_AUTH_ACTOR_EPOCH_HEADER]: initial.actorEpoch,
    cookie,
  });
  const begin = await target.request("/v1/auth/session-set/transactions", {
    method: "POST",
    headers: headers(authorityCookie),
    body: JSON.stringify({
      operationId: crypto.randomUUID(),
      expectedGeneration: initial.generation,
      kind: "add",
    }),
  });
  expect(begin.status).toBe(200);
  const transaction = (await begin.json()) as { id: string };
  const transactionCookie = oneCookie(begin, MANAGED_AUTH_LOGIN_TRANSACTION_COOKIE);
  const completions: Response[] = [];
  for (const password of passwords) {
    completions.push(
      await target.request("/v1/auth/session-set/transactions/email-password", {
        method: "POST",
        headers: headers(`${authorityCookie}; ${transactionCookie}`),
        body: JSON.stringify({
          operationId: crypto.randomUUID(),
          expectedGeneration: initial.generation,
          transactionId: transaction.id,
          email,
          password,
        }),
      }),
    );
  }
  const afterResponse = await target.request("/v1/auth/session-set", {
    headers: { cookie: authorityCookie },
  });
  return {
    completion: completions.at(-1)!,
    earlier: completions.slice(0, -1),
    after: (await afterResponse.json()) as ManagedAuthSessionSetProjection,
  };
}

async function refusal(
  completion: Response,
): Promise<{ status: number; managedAuthCode: unknown }> {
  const body = (await completion.json()) as {
    error?: { details?: { managedAuthCode?: unknown } };
  };
  return { status: completion.status, managedAuthCode: body.error?.details?.managedAuthCode };
}

for (const mode of ["dual", "broker"] as const) {
  describe(`adding an account with email and password in ${mode} mode`, () => {
    const kept = `kept-${mode}-${crypto.randomUUID()}@example.test`;
    const removed = `removed-${mode}-${crypto.randomUUID()}@example.test`;
    const unverified = `unverified-${mode}-${crypto.randomUUID()}@example.test`;

    beforeAll(async () => {
      if (!shared || !client) return;
      const open = app(mode, [kept, removed, unverified]);
      for (const email of [kept, removed, unverified]) {
        const created = await open.request("/v1/auth/sign-up/email", {
          method: "POST",
          headers: { "content-type": "application/json", origin: "http://opengeni.test" },
          body: JSON.stringify({ name: "Add Account Human", email, password: PASSWORD }),
        });
        expect(created.status).toBeLessThan(300);
      }
      await shared.admin`
        update auth_users set email_verified = (email <> ${unverified})
        where email in (${kept}, ${removed}, ${unverified})`;
    }, 120_000);

    test("a wrong password is reported as wrong credentials, not a server error", async () => {
      if (!shared || !client) return;
      const { completion, after } = await addAccount(app(mode, [kept]), kept, "wrong-password-123");
      expect(await refusal(completion)).toEqual({
        status: 401,
        managedAuthCode: "invalid_credentials",
      });
      expect(after.slots).toEqual([]);
    }, 60_000);

    test("a password longer than any account can have is wrong credentials too", async () => {
      if (!shared || !client) return;
      const { completion, after } = await addAccount(app(mode, [kept]), kept, "x".repeat(200));
      expect(await refusal(completion)).toEqual({
        status: 401,
        managedAuthCode: "invalid_credentials",
      });
      expect(after.slots).toEqual([]);
    }, 60_000);

    test("an address the deployment doesn't allow is told so, whatever the password", async () => {
      if (!shared || !client) return;
      const target = app(mode, [kept]);
      for (const password of [PASSWORD, "wrong-password-123"]) {
        const { completion, after } = await addAccount(target, removed, password);
        expect(await refusal(completion)).toEqual({
          status: 403,
          managedAuthCode: "sign_in_email_not_allowed",
        });
        expect(after.slots).toEqual([]);
      }
    }, 60_000);

    test("a session the sign-in hooks decline is a refusal, not a server error", async () => {
      if (!shared || !client) return;
      const { completion, after } = await addAccount(
        app(mode, [kept, unverified]),
        unverified,
        PASSWORD,
      );
      expect(await refusal(completion)).toEqual({
        status: 403,
        managedAuthCode: "sign_in_refused",
      });
      expect(after.slots).toEqual([]);
    }, 60_000);

    test("an unverified address is told to verify it where the deployment requires that", async () => {
      if (!shared || !client) return;
      const { completion, after } = await addAccount(
        app(mode, [kept, unverified], { requireEmailVerification: true }),
        unverified,
        PASSWORD,
      );
      expect(await refusal(completion)).toEqual({
        status: 403,
        managedAuthCode: "email_not_verified",
      });
      expect(after.slots).toEqual([]);
    }, 60_000);

    test("an allowed address with the right password is still added", async () => {
      if (!shared || !client) return;
      const { completion, after } = await addAccount(app(mode, [kept]), kept, PASSWORD);
      expect(completion.status).toBe(200);
      expect(after.slots).toHaveLength(1);
      expect(after.slots[0]?.verifiedClaim).toEqual({ kind: "email", value: kept });
    }, 60_000);

    test("after a wrong password, the right one in the same window adds the account", async () => {
      if (!shared || !client) return;
      const { completion, earlier, after } = await addAccount(
        app(mode, [kept]),
        kept,
        "wrong-password-123",
        PASSWORD,
      );
      expect(await Promise.all(earlier.map(refusal))).toEqual([
        { status: 401, managedAuthCode: "invalid_credentials" },
      ]);
      expect(completion.status).toBe(200);
      expect(after.slots).toHaveLength(1);
    }, 60_000);
  });
}
