import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Webhook signature schemes event sources use: Standard Webhooks (used by
 * custom senders and by MCP Events webhook delivery) and the plain hex
 * HMAC-SHA256 of the raw body that Linear and Sentry send.
 */

/** Standard Webhooks rejects deliveries signed more than this long ago or ahead. */
export const STANDARD_WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

const STANDARD_WEBHOOK_SECRET_PREFIX = "whsec_";
const WEBHOOK_ID_PATTERN = /^[\x21-\x7e]{1,256}$/u;

/** A new Standard Webhooks secret: `whsec_` and the base64 of 32 random bytes. */
export function generateStandardWebhookSecret(): string {
  return `${STANDARD_WEBHOOK_SECRET_PREFIX}${randomBytes(32).toString("base64")}`;
}

/** The HMAC key of a `whsec_` secret, or null when the value is not one. */
export function standardWebhookSecretKey(secret: string): Buffer | null {
  if (!secret.startsWith(STANDARD_WEBHOOK_SECRET_PREFIX)) return null;
  const encoded = secret.slice(STANDARD_WEBHOOK_SECRET_PREFIX.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) return null;
  const key = Buffer.from(encoded, "base64");
  return key.byteLength >= 24 && key.byteLength <= 64 ? key : null;
}

export type StandardWebhookHeaders = {
  "webhook-id": string;
  "webhook-timestamp": string;
  "webhook-signature": string;
};

/** Sign a body as a Standard Webhooks sender would. Used by tests and test events. */
export function signStandardWebhook(input: {
  secret: string;
  webhookId: string;
  body: Uint8Array | string;
  timestampSeconds?: number;
}): StandardWebhookHeaders {
  const key = standardWebhookSecretKey(input.secret);
  if (!key) throw new Error("Standard Webhooks secrets start with whsec_");
  const timestamp = String(input.timestampSeconds ?? Math.floor(Date.now() / 1000));
  return {
    "webhook-id": input.webhookId,
    "webhook-timestamp": timestamp,
    "webhook-signature": `v1,${standardSignature(key, input.webhookId, timestamp, input.body)}`,
  };
}

function standardSignature(
  key: Buffer,
  webhookId: string,
  timestamp: string,
  body: Uint8Array | string,
): string {
  return createHmac("sha256", key)
    .update(`${webhookId}.${timestamp}.`, "utf8")
    .update(typeof body === "string" ? Buffer.from(body, "utf8") : body)
    .digest("base64");
}

export type WebhookVerification =
  | { ok: true; webhookId: string; timestampSeconds: number }
  | { ok: false; reason: string };

/**
 * Verify a Standard Webhooks delivery over the exact raw body. Any of several
 * space-separated `v1,` signatures may match (secret rotation); `v1a,`
 * asymmetric signatures are ignored.
 */
export function verifyStandardWebhook(input: {
  secret: string;
  headers: Headers;
  body: Uint8Array;
  nowSeconds?: number;
}): WebhookVerification {
  const key = standardWebhookSecretKey(input.secret);
  if (!key) return { ok: false, reason: "The signing secret is not a Standard Webhooks secret" };
  const webhookId = input.headers.get("webhook-id");
  const timestamp = input.headers.get("webhook-timestamp");
  const signatures = input.headers.get("webhook-signature");
  if (!webhookId || !timestamp || !signatures) {
    return {
      ok: false,
      reason: "Missing webhook-id, webhook-timestamp or webhook-signature header",
    };
  }
  if (!WEBHOOK_ID_PATTERN.test(webhookId)) {
    return { ok: false, reason: "The webhook-id header is not a valid message id" };
  }
  if (!/^\d{1,12}$/u.test(timestamp)) {
    return { ok: false, reason: "The webhook-timestamp header is not a Unix time in seconds" };
  }
  const timestampSeconds = Number(timestamp);
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestampSeconds) > STANDARD_WEBHOOK_TOLERANCE_SECONDS) {
    return { ok: false, reason: "The delivery was signed more than 5 minutes from now" };
  }
  const expected = Buffer.from(standardSignature(key, webhookId, timestamp, input.body), "base64");
  const matched = signatures
    .split(" ")
    .filter((entry) => entry.startsWith("v1,"))
    .some((entry) => constantTimeEqual(Buffer.from(entry.slice(3), "base64"), expected));
  return matched
    ? { ok: true, webhookId, timestampSeconds }
    : { ok: false, reason: "No webhook-signature matches the signing secret" };
}

/** Verify a hex HMAC-SHA256 of the raw body, as Linear and Sentry send it. */
export function verifyHexBodyHmac(input: {
  secret: string;
  signature: string | null;
  body: Uint8Array;
}): boolean {
  if (!input.signature || !/^(?:sha256=)?[0-9a-fA-F]{64}$/u.test(input.signature)) return false;
  const provided = Buffer.from(input.signature.replace(/^sha256=/u, ""), "hex");
  const expected = createHmac("sha256", Buffer.from(input.secret, "utf8"))
    .update(input.body)
    .digest();
  return constantTimeEqual(provided, expected);
}

/** A hex HMAC-SHA256 of a body, as Linear and Sentry would sign it. Used by tests. */
export function signHexBodyHmac(secret: string, body: Uint8Array | string): string {
  return createHmac("sha256", Buffer.from(secret, "utf8"))
    .update(typeof body === "string" ? Buffer.from(body, "utf8") : body)
    .digest("hex");
}

function constantTimeEqual(left: Buffer, right: Buffer): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}
