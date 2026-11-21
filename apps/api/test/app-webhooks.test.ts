import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { signTimestampedHmac } from "@opengeni/core";
import { appWebhookOperations, verifyAppWebhookDelivery } from "../src/app-webhooks/service";

const secret = "ogwh_test-secret";
const row = {
  secretHash: createHash("sha256").update(secret).digest("hex"),
  secretEncrypted: "sealed",
};
const body = new TextEncoder().encode('{"id":1}');
const now = Math.floor(Date.now() / 1000);
const verify = (headers: Record<string, string>) =>
  verifyAppWebhookDelivery({
    row,
    headers: new Headers(headers),
    body,
    decrypt: (stored) => (stored === "sealed" ? secret : "wrong"),
    nowSeconds: now,
  });

test("a delivery authenticates with the secret as a bearer or a fresh signature", () => {
  expect(verify({ authorization: `Bearer ${secret}` }).ok).toBe(true);
  expect(verify({ authorization: "Bearer ogwh_other" }).ok).toBe(false);
  expect(verify({ authorization: `Basic ${secret}` }).ok).toBe(false);
  const signature = signTimestampedHmac({ secret, body, timestampSeconds: now });
  expect(verify({ "x-opengeni-signature": signature }).ok).toBe(true);
  const stale = signTimestampedHmac({ secret, body, timestampSeconds: now - 301 });
  expect(verify({ "x-opengeni-signature": stale }).ok).toBe(false);
  const forged = signTimestampedHmac({ secret: "other", body, timestampSeconds: now });
  expect(verify({ "x-opengeni-signature": forged }).ok).toBe(false);
  expect(verify({}).ok).toBe(false);
});

test("with a key records are put by key with kept fields; without, inserted idempotently", () => {
  const keyed = appWebhookOperations(
    { data: [{ id: "a", total: 1, extra: true }, { total: 2 }] },
    { collection: "orders", recordsPath: "data", key: "id", fields: ["id", "total"] },
    "d-1",
  );
  expect(keyed.skipped).toBe(1);
  expect(keyed.operations).toEqual([
    { op: "put", collection: "orders", key: "a", data: { id: "a", total: 1 } } as never,
  ]);

  const single = appWebhookOperations(
    { kind: "paid", amount: 3 },
    { collection: "events", recordsPath: null, key: null, fields: null },
    "d-2",
  );
  expect(single).toEqual({
    operations: [
      {
        op: "insert",
        collection: "events",
        data: { kind: "paid", amount: 3 },
        idempotencyKey: "d-2",
      },
    ],
    skipped: 0,
  });
  const many = appWebhookOperations(
    [{ a: 1 }, 2, { b: { c: 3 } }],
    { collection: "events", recordsPath: null, key: null, fields: ["b.c"] },
    "d-3",
  );
  expect(many.skipped).toBe(1);
  expect(many.operations.map((op) => (op as { idempotencyKey?: string }).idempotencyKey)).toEqual([
    "d-3:0",
    "d-3:2",
  ]);
  expect((many.operations[1] as { data: unknown }).data).toEqual({ b: { c: 3 } });
  expect(
    appWebhookOperations(
      { a: 1 },
      { collection: "e", recordsPath: null, key: null, fields: null },
      null,
    ).operations[0],
  ).not.toHaveProperty("idempotencyKey");
});
