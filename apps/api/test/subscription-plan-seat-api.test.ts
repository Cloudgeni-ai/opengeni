import { afterAll, beforeAll, expect, test } from "bun:test";
import type { ApiRouteDeps } from "@opengeni/core";
import { BillingBalance, ErrorEnvelope, OPENGENI_CORRELATION_HEADER } from "@opengeni/contracts";
import { formatErrorMessage, OpenGeniApiError } from "@opengeni/sdk";
import {
  acceptOrganizationInvitation,
  bindPendingOrganizationInvitationsForVerifiedEmail,
  completeSelfServiceOrganizationSetup,
  createDb,
  createOrganizationInvitation,
  readSubscriptionPlanCatalog,
  upsertOrganizationPlan,
  type DbClient,
} from "@opengeni/db";
import { synchronizeCanonicalHumanLoginBindings } from "@opengeni/db/canonical-human-identities";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import type { Hono } from "hono";
import { createApp } from "../src/app";

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
let app: Hono | null = null;
let accountId = "";
let settings: ApiRouteDeps["settings"] | null = null;
type TestSessionUser = { sessionId: string; id: string; email: string; name: string };
let sessionUser: TestSessionUser | null = null;
async function signInUser(name: string): Promise<TestSessionUser> {
  const id = crypto.randomUUID();
  const email = `${id}@example.test`;
  await shared!
    .admin`insert into auth_users(id,name,email,email_verified) values (${id},${name},${email},true)`;
  await shared!
    .admin`insert into auth_identities(id,user_id,provider_id,account_id) values (${crypto.randomUUID()},${id},'credential',${id})`;
  const identity = await synchronizeCanonicalHumanLoginBindings(client!.db, id);
  const sessionId = crypto.randomUUID();
  await shared!
    .admin`insert into auth_sessions(id,user_id,token,expires_at,identity_id,identity_revision,auth_revision)
    values (${sessionId},${id},${crypto.randomUUID()},clock_timestamp()+interval '1 hour',${identity.identityId},${identity.identityRevision},${identity.authRevision})`;
  return { sessionId, id, email, name };
}
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
  const owner = { sessionId, id: userId, email, name: "Plan owner" };
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
  settings = testSettings({
    productAccessMode: "managed",
    publicBaseUrl: "http://opengeni.test",
    betterAuthSecret: "plan-seat-api-secret-at-least-thirty-two-bytes",
  });
  const deps = {
    db: client.db,
    settings,
    managedAuth: {
      api: {
        getSession: async () => {
          const user = sessionUser ?? owner;
          return {
            headers: new Headers(),
            response: {
              session: { id: user.sessionId },
              user: { id: user.id, email: user.email, name: user.name, emailVerified: true },
            },
          };
        },
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
    details: { seatLimit: 5, seatsUsed: 5, action: { type: "upgrade", href: "/billing" } },
  });
  expect(envelope.error.details).not.toHaveProperty("upgradePlan");
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

test("with subscription plans on, the seat refusal names the one plan that adds the seat", async () => {
  if (!app || !client || !shared || !settings) return;
  const initial = await readSubscriptionPlanCatalog(client.db);
  // Bendik's limits: Free 1, Pro 2, Max 10, Enterprise unlimited. Five people
  // need six seats, so Pro's two are not the fix; Max is.
  const limits: Record<string, number | null> = { free: 1, pro: 2, max: 10, enterprise: null };
  const catalog = initial.plans.map((plan) => ({
    ...plan,
    seatLimit: limits[plan.key] ?? null,
    ...(plan.key === "pro" || plan.key === "max" ? { stripePriceId: `price_${plan.key}` } : {}),
  }));
  const previous = {
    subscriptionPlansEnabled: settings.subscriptionPlansEnabled,
    billingMode: settings.billingMode,
  };
  await shared.admin`select set_subscription_plan_catalog(${shared.admin.json(catalog)}, 'seat-api-test', 'Name the upgrade in seat refusals')`;
  Object.assign(settings, { subscriptionPlansEnabled: true, billingMode: "stripe" });
  try {
    const response = await app.request(`http://x/v1/organizations/${accountId}/invitations`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "session=present" },
      body: JSON.stringify({
        operationId: crypto.randomUUID(),
        email: "named-upgrade@example.test",
        role: "member",
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      }),
    });
    expect(response.status).toBe(402);
    const body = await response.text();
    expect(ErrorEnvelope.parse(JSON.parse(body)).error).toMatchObject({
      code: "seat_limit_reached",
      message: "Upgrade to Max to add more people.",
      details: {
        seatLimit: 1,
        seatsUsed: 5,
        upgradePlan: "max",
        upgradePlanLabel: "Max",
        action: { type: "upgrade", href: "/billing" },
      },
    });
    expect(
      formatErrorMessage(new OpenGeniApiError(response.status, body, { mutation: true })),
    ).toStartWith("Upgrade to Max to add more people.");
  } finally {
    Object.assign(settings, previous);
    await shared.admin`select set_subscription_plan_catalog(${shared.admin.json(initial.plans)}, 'seat-api-test', 'Restore fixture catalog')`;
  }
}, 180_000);

test("an invitee refused by a full organization is told to ask an owner", async () => {
  if (!app || !client || !shared) return;
  const founder = await signInUser("Full org owner");
  const organizationId = (
    await completeSelfServiceOrganizationSetup(client.db, {
      authUserId: founder.id,
      actorSubjectId: `user:${founder.id}`,
      organizationName: "Full organization",
      operationId: crypto.randomUUID(),
      requestFingerprint: "b".repeat(64),
      trialCreditsEnabled: false,
    })
  ).organizationId;
  const invitee = await signInUser("Invitee");
  const invitation = await createOrganizationInvitation(client.db, {
    organizationId,
    actorSubjectId: `user:${founder.id}`,
    operationId: crypto.randomUUID(),
    targetSubjectId: null,
    targetEmail: invitee.email,
    role: "member",
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  });
  await bindPendingOrganizationInvitationsForVerifiedEmail(client.db, {
    subjectId: `user:${invitee.id}`,
    email: invitee.email,
  });
  const [{ revision }] = await shared.admin<Array<{ revision: number }>>`
    select revision from organization_membership_invitations where id = ${invitation.id}`;
  // Accepting holds the invitation's seat, so the trigger never refuses it
  // today; force the refusal to pin the invitee-facing copy.
  const suffix = crypto.randomUUID().replaceAll("-", "");
  await shared.admin.unsafe(`
    CREATE FUNCTION refuse_accept_${suffix}() RETURNS trigger LANGUAGE plpgsql AS $f$
    BEGIN
      IF NEW.account_id = '${organizationId}' THEN
        RAISE EXCEPTION 'organization seat limit reached' USING ERRCODE = 'P0S01',
          DETAIL = '{"seatLimit": 1, "seatsUsed": 1, "planKey": "free"}';
      END IF;
      RETURN NEW;
    END $f$;
    CREATE TRIGGER refuse_accept_${suffix} BEFORE INSERT ON organization_memberships
      FOR EACH ROW EXECUTE FUNCTION refuse_accept_${suffix}();`);
  sessionUser = invitee;
  try {
    const response = await app.request(
      `http://x/v1/organization-invitations/${invitation.id}/accept`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: "session=present",
          origin: "http://opengeni.test",
        },
        body: JSON.stringify({
          operationId: crypto.randomUUID(),
          expectedRevision: Number(revision),
        }),
      },
    );
    const body = await response.text();
    expect(response.status).toBe(402);
    expect(ErrorEnvelope.parse(JSON.parse(body)).error).toMatchObject({
      code: "seat_limit_reached",
      message: "This organization is full. Ask an organization owner to upgrade.",
      details: { askOwner: true },
    });
    expect(
      formatErrorMessage(new OpenGeniApiError(response.status, body, { mutation: true })),
    ).toStartWith("This organization is full. Ask an organization owner to upgrade.");
  } finally {
    sessionUser = null;
    await shared.admin.unsafe(`
      DROP TRIGGER refuse_accept_${suffix} ON organization_memberships;
      DROP FUNCTION refuse_accept_${suffix}();`);
  }
}, 180_000);

test("an admin without billing access is told which plan to ask an owner for", async () => {
  if (!app || !client || !shared || !settings) return;
  const founder = await signInUser("Owner");
  const organizationId = (
    await completeSelfServiceOrganizationSetup(client.db, {
      authUserId: founder.id,
      actorSubjectId: `user:${founder.id}`,
      organizationName: "Admin-invited organization",
      operationId: crypto.randomUUID(),
      requestFingerprint: "c".repeat(64),
      trialCreditsEnabled: false,
    })
  ).organizationId;
  const admin = await signInUser("Admin");
  const invitation = await createOrganizationInvitation(client.db, {
    organizationId,
    actorSubjectId: `user:${founder.id}`,
    operationId: crypto.randomUUID(),
    targetSubjectId: null,
    targetEmail: admin.email,
    role: "admin",
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  });
  await bindPendingOrganizationInvitationsForVerifiedEmail(client.db, {
    subjectId: `user:${admin.id}`,
    email: admin.email,
  });
  const [{ revision }] = await shared.admin<Array<{ revision: number }>>`
    select revision from organization_membership_invitations where id = ${invitation.id}`;
  await acceptOrganizationInvitation(client.db, {
    organizationId,
    actorSubjectId: `user:${admin.id}`,
    operationId: crypto.randomUUID(),
    invitationId: invitation.id,
    expectedRevision: Number(revision),
  });
  const initial = await readSubscriptionPlanCatalog(client.db);
  const limits: Record<string, number | null> = { free: 1, pro: 2, max: 10, enterprise: null };
  const catalog = initial.plans.map((plan) => ({
    ...plan,
    seatLimit: limits[plan.key] ?? null,
    ...(plan.key === "pro" || plan.key === "max" ? { stripePriceId: `price_${plan.key}` } : {}),
  }));
  const previous = {
    subscriptionPlansEnabled: settings.subscriptionPlansEnabled,
    billingMode: settings.billingMode,
  };
  await shared.admin`select set_subscription_plan_catalog(${shared.admin.json(catalog)}, 'seat-api-test', 'Admin seat refusal')`;
  await upsertOrganizationPlan(client.db, {
    accountId: organizationId,
    planKey: "free",
    status: "active",
  });
  Object.assign(settings, { subscriptionPlansEnabled: true, billingMode: "stripe" });
  sessionUser = admin;
  try {
    const response = await app.request(`http://x/v1/organizations/${organizationId}/invitations`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "session=present" },
      body: JSON.stringify({
        operationId: crypto.randomUUID(),
        email: "admin-invite@example.test",
        role: "member",
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      }),
    });
    const body = await response.text();
    expect(response.status).toBe(402);
    const refusal = ErrorEnvelope.parse(JSON.parse(body)).error;
    // Two people on Free (1 seat) need a third seat: Max adds it, Pro doesn't.
    expect(refusal).toMatchObject({
      code: "seat_limit_reached",
      message: "Ask an organization owner to upgrade to Max.",
      details: { seatLimit: 1, seatsUsed: 2, upgradePlan: "max", askOwner: true },
    });
    expect(refusal.details).not.toHaveProperty("action");
    expect(
      formatErrorMessage(new OpenGeniApiError(response.status, body, { mutation: true })),
    ).toStartWith("Ask an organization owner to upgrade to Max.");
  } finally {
    sessionUser = null;
    Object.assign(settings, previous);
    await shared.admin`select set_subscription_plan_catalog(${shared.admin.json(initial.plans)}, 'seat-api-test', 'Restore fixture catalog')`;
  }
}, 180_000);
