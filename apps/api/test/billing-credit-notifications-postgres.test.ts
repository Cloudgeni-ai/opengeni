import { afterAll, beforeAll, expect, test } from "bun:test";
import { Hono } from "hono";
import {
  acquireRestrictedRuntimeTestDatabase,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import {
  createDb,
  ensureManagedAccessForUser,
  enqueueBillingCreditNotification,
  type DbClient,
} from "@opengeni/db";
import {
  deliverBillingCreditNotification,
  stampDelegatedHumanAuthorization,
  type ApiRouteDeps,
  type ManagedEmailTransport,
} from "@opengeni/core";
import type { Permission } from "@opengeni/contracts";
import { registerBillingRoutes } from "../src/routes/billing";
import { startBillingCreditNotificationDelivery } from "../src/billing-credit-notifications";

let fixture: RestrictedRuntimeTestDatabase | null = null,
  client: DbClient | null = null;
beforeAll(async () => {
  fixture = await acquireRestrictedRuntimeTestDatabase("credit-alert-api", "credit_alert_api");
  if (!fixture) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") throw new Error("PostgreSQL required");
    return;
  }
  client = createDb(fixture.appUrl, { searchPath: fixture.schema, max: 4 });
}, 180_000);
afterAll(async () => {
  await client?.close();
  await fixture?.release();
}, 180_000);

async function organization() {
  const id = crypto.randomUUID();
  await fixture!
    .admin`insert into auth_users(id,name,email,email_verified) values(${id},'Alert admin',${`${id}@example.test`},true)`;
  const access = await ensureManagedAccessForUser(client!.db, {
    userId: id,
    email: `${id}@example.test`,
    name: "Alert admin",
  });
  return { accountId: access.defaultAccountId!, subjectId: `user:${id}` };
}

test("real billing HTTP settings require current organization billing authority and round-trip micros", async () => {
  if (!client) return;
  const org = await organization();
  const app = new Hono();
  registerBillingRoutes(app, {
    db: client.db,
    settings: testSettings({ productAccessMode: "managed" }),
    managedAuth: null,
  } as ApiRouteDeps);
  const call = async (method: string, path: string, permissions: Permission[], body?: unknown) => {
    const request = new Request(`http://api.test${path}`, {
      method,
      ...(body
        ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
        : {}),
    });
    stampDelegatedHumanAuthorization(request, {
      organizationId: org.accountId,
      subjectId: org.subjectId,
      permissions,
      workspaceScope: { kind: "all" },
    });
    return app.fetch(request);
  };
  const path = `/v1/billing/alerts?accountId=${org.accountId}`;
  expect((await call("GET", path, ["billing:read"])).status).toBe(200);
  const settings = { accountId: org.accountId, lowBalanceThresholdMicros: 25_000_000 };
  expect((await call("PUT", "/v1/billing/alerts", ["billing:read"], settings)).status).toBe(403);
  const changed = await call("PUT", "/v1/billing/alerts", ["billing:manage"], settings);
  expect(changed.status).toBe(200);
  expect(await changed.json()).toEqual(settings);
  expect(
    (
      await call("PUT", "/v1/billing/alerts", ["billing:manage"], {
        ...settings,
        lowBalanceThresholdMicros: -1,
      })
    ).status,
  ).toBe(400);
  expect(
    (await call("GET", `/v1/billing/alerts?accountId=${crypto.randomUUID()}`, ["billing:read"]))
      .status,
  ).toBe(403);
  await fixture!
    .admin`update organization_memberships set role='member' where account_id=${org.accountId} and subject_id=${org.subjectId}`;
  expect((await call("GET", path, ["billing:read"])).status).toBe(403);
});

test("provider accepted-but-reply-lost retries the same key once, then records success", async () => {
  if (!client) return;
  const org = await organization();
  await enqueueBillingCreditNotification(client.db, {
    accountId: org.accountId,
    operationKey: "test:unknown",
    kind: "topup_failed",
    details: { availableBalanceMicros: 0, amountMicros: 20_000_000 },
  });
  const accepted = new Set<string>();
  const attempts: string[] = [];
  let loseReply = true;
  const transport: ManagedEmailTransport = {
    sender: "sender@example.test",
    idempotency: { scope: "fake-durable-v1", retentionSeconds: 86400 },
    send: async (message) => {
      attempts.push(message.idempotencyKey!);
      accepted.add(message.idempotencyKey!);
      if (loseReply) {
        loseReply = false;
        throw new Error("reply lost after provider acceptance");
      }
      return { status: "sent", providerMessageId: "provider-accepted" };
    },
  };
  const input = { db: client.db, accountId: org.accountId, transport, appUrl: "https://app.test" };
  expect(await deliverBillingCreditNotification(input)).toBe(true);
  const [unknown] = await fixture!
    .admin`select status from billing_credit_notification_deliveries where account_id=${org.accountId}`;
  expect(unknown!.status).toBe("outcome_unknown");
  await fixture!
    .admin`update billing_credit_notification_deliveries set next_attempt_at=now()-interval '1 minute' where account_id=${org.accountId}`;
  expect(await deliverBillingCreditNotification(input)).toBe(true);
  expect(accepted.size).toBe(1);
  expect(attempts).toHaveLength(2);
  expect(attempts[0]).toBe(attempts[1]);
  expect(await deliverBillingCreditNotification(input)).toBe(false);
});

test("the server-owned pump discovers and settles a durable notice before shutdown", async () => {
  if (!client) return;
  const org = await organization();
  const notificationId = await enqueueBillingCreditNotification(client.db, {
    accountId: org.accountId,
    operationKey: "test:pump",
    kind: "topup_success",
    details: { availableBalanceMicros: 20_000_000, amountMicros: 20_000_000 },
  });
  let sent!: () => void;
  const delivered = new Promise<void>((resolve) => {
    sent = resolve;
  });
  let calls = 0;
  const stop = startBillingCreditNotificationDelivery(
    client.db,
    {
      sender: "sender@example.test",
      idempotency: { scope: "pump-durable-v1", retentionSeconds: 86400 },
      send: async () => {
        calls++;
        sent();
        return { status: "sent", providerMessageId: "pump-provider-accepted" };
      },
    },
    "https://app.test",
  );
  try {
    await delivered;
  } finally {
    await stop();
  }
  expect(calls).toBe(1);
  const [row] = await fixture!.admin`
    select status,provider_message_id from billing_credit_notification_deliveries
    where notification_id=${notificationId}::uuid`;
  expect(row).toEqual({ status: "sent", provider_message_id: "pump-provider-accepted" });
});
