import { afterAll, beforeAll, expect, test } from "bun:test";
import type { ApiRouteDeps } from "@opengeni/core";
import { BillingBalance, ErrorEnvelope, OPENGENI_CORRELATION_HEADER } from "@opengeni/contracts";
import { OpenGeniApiError } from "@opengeni/sdk";
import {
  completeSelfServiceOrganizationSetup,
  createDb,
  createOrganizationInvitation,
  upsertOrganizationPlan,
  type DbClient,
} from "@opengeni/db";
import { synchronizeCanonicalHumanLoginBindings } from "@opengeni/db/canonical-human-identities";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import type { Hono } from "hono";
import { createApp } from "../src/app";

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
let app: Hono | null = null;
let accountId = "";
beforeAll(async () => {
  shared = await acquireSharedTestDatabase("subscription-plan-seat-api");
  if (!shared) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") throw new Error("PostgreSQL required");
    return;
  }
  client = createDb(shared.appUrl, { max: 4 });
  const userId = crypto.randomUUID();
  const email = `${userId}@example.test`;
  await shared.admin`insert into auth_users(id,name,email,email_verified) values (${userId},'Plan owner',${email},true)`;
  accountId = (
    await completeSelfServiceOrganizationSetup(client.db, {
      authUserId: userId,
      actorSubjectId: `user:${userId}`,
      organizationName: "Plan API test",
      operationId: crypto.randomUUID(),
      requestFingerprint: "a".repeat(64),
      trialCreditsEnabled: false,
    })
  ).organizationId;
  await shared.admin`insert into auth_identities(id,user_id,provider_id,account_id) values (${crypto.randomUUID()},${userId},'credential',${userId})`;
  const identity = await synchronizeCanonicalHumanLoginBindings(client.db, userId);
  const sessionId = crypto.randomUUID();
  await shared.admin`insert into auth_sessions(id,user_id,token,expires_at,identity_id,identity_revision,auth_revision)
    values (${sessionId},${userId},${crypto.randomUUID()},clock_timestamp()+interval '1 hour',${identity.identityId},${identity.identityRevision},${identity.authRevision})`;
  for (let i = 0; i < 4; i++) {
    await createOrganizationInvitation(client.db, {
      organizationId: accountId,
      actorSubjectId: `user:${userId}`,
      operationId: crypto.randomUUID(),
      targetSubjectId: null,
      targetEmail: `${crypto.randomUUID()}@example.test`,
      role: "member",
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    });
  }
  await upsertOrganizationPlan(client.db, { accountId, planKey: "free", status: "active" });
  const deps = {
    db: client.db,
    settings: testSettings({
      productAccessMode: "managed",
      publicBaseUrl: "http://opengeni.test",
      betterAuthSecret: "plan-seat-api-secret-at-least-thirty-two-bytes",
    }),
    managedAuth: {
      api: {
        getSession: async () => ({
          headers: new Headers(),
          response: {
            session: { id: sessionId },
            user: { id: userId, email, name: "Plan owner", emailVerified: true },
          },
        }),
      },
    } as never,
    managedEmailTransport: {
      sender: "Opengeni <auth@example.test>",
      idempotency: { scope: "test-plan-seats", retentionSeconds: 86400 },
      send: async () => ({ status: "sent", providerMessageId: "unexpected" }),
    },
  } as ApiRouteDeps;
  // Use the production composition: bare Hono honors HTTPException.res, but
  // the real app's onError normalizes every refusal into ErrorEnvelope.
  app = createApp({ ...deps, bus: {} as never, workflowClient: {} as never });
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

test("seat-limit errors are actionable HTTP 402 responses", async () => {
  if (!app) return;
  const response = await app.request(`http://x/v1/organizations/${accountId}/invitations`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: "session=present" },
    body: JSON.stringify({
      operationId: crypto.randomUUID(),
      email: "over-limit@example.test",
      role: "member",
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    }),
  });
  expect(response.status).toBe(402);
  const body = await response.text();
  const envelope = ErrorEnvelope.parse(JSON.parse(body));
  expect(envelope.error).toMatchObject({
    status: 402,
    code: "seat_limit_reached",
    message: "Organization seat limit reached. Upgrade your plan to add people.",
    retryable: false,
    details: { action: { type: "upgrade", href: "/billing" } },
  });
  expect(envelope.error.requestId).toBe(response.headers.get(OPENGENI_CORRELATION_HEADER));
  const sdkError = new OpenGeniApiError(response.status, body, { mutation: true });
  expect(sdkError.code).toBe("seat_limit_reached");
  expect(sdkError.details?.action).toEqual({ type: "upgrade", href: "/billing" });
  expect(sdkError.outcomeUnknown).toBe(false);
}, 180_000);

test("billing routes expose the shared optional plan projection without changing legacy fields", async () => {
  if (!app) return;
  const response = await app.request("http://x/v1/billing", {
    headers: { cookie: "session=present" },
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { balance: unknown };
  expect(BillingBalance.parse(body.balance)).toMatchObject({
    accountId,
    balanceMicros: 0,
    plan: { key: "free", creditRemainingMicros: 0, seatsUsed: 5, seatLimit: 5 },
  });
}, 180_000);
