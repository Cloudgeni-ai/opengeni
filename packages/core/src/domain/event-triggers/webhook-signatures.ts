import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Webhook signature schemes event sources use: Standard Webhooks (used by
 * Opengeni's own format, Svix-based apps and MCP Events webhook delivery), an
 * HMAC-SHA256 of the raw body (Linear, Sentry and many others), a timestamped
 * `t=…,v1=…` HMAC-SHA256 (Stripe, Tailscale) and a shared token.
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

function bodyBytes(body: Uint8Array | string): Uint8Array {
  return typeof body === "string" ? Buffer.from(body, "utf8") : body;
}

function bodyHmac(secret: string, body: Uint8Array | string): Buffer {
  return createHmac("sha256", Buffer.from(secret, "utf8")).update(bodyBytes(body)).digest();
}

/** What the value of a header names when the header is absent or wrong. */
function headerLabel(header: string): string {
  return header.replace(
    /(^|-)([a-z])/gu,
    (_, dash: string, letter: string) => `${dash}${letter.toUpperCase()}`,
  );
}

/**
 * Verify an HMAC-SHA256 of the raw body, keyed with the secret's UTF-8 bytes,
 * in hex or base64 after an optional prefix such as `sha256=`.
 */
export function verifyBodyHmac(input: {
  secret: string;
  header: string;
  value: string | null;
  body: Uint8Array;
  encoding: "hex" | "base64";
  prefix: string;
}): { ok: true } | { ok: false; reason: string } {
  const name = headerLabel(input.header);
  const value = input.value?.trim() ?? "";
  if (!value) return { ok: false, reason: `Missing ${name} header` };
  if (input.prefix && !value.startsWith(input.prefix)) {
    return { ok: false, reason: `The ${name} header does not start with "${input.prefix}"` };
  }
  const encoded = value.slice(input.prefix.length);
  const valid =
    input.encoding === "hex"
      ? /^[0-9a-fA-F]{64}$/u.test(encoded)
      : /^[A-Za-z0-9+/_-]{43}={0,1}$/u.test(encoded);
  const provided = valid
    ? Buffer.from(encoded.replace(/-/gu, "+").replace(/_/gu, "/"), input.encoding)
    : null;
  return provided && constantTimeEqual(provided, bodyHmac(input.secret, input.body))
    ? { ok: true }
    : { ok: false, reason: `The ${name} header does not match the signing secret` };
}

/** The header value `verifyBodyHmac` accepts. Used by tests and test deliveries. */
export function signBodyHmac(input: {
  secret: string;
  body: Uint8Array | string;
  encoding: "hex" | "base64";
  prefix?: string;
}): string {
  return `${input.prefix ?? ""}${bodyHmac(input.secret, input.body).toString(input.encoding)}`;
}

/**
 * Verify a `t=<unix seconds>,v1=<hex>` header (Stripe, Tailscale) whose
 * signature is the HMAC-SHA256 of `<t>.<raw body>`, keyed with the secret's
 * UTF-8 bytes. Any `v1` entry may match (secret rotation); other schemes in
 * the header are ignored.
 */
export function verifyTimestampedHmac(input: {
  secret: string;
  header: string;
  value: string | null;
  body: Uint8Array;
  toleranceSeconds: number;
  nowSeconds?: number;
}): { ok: true; timestampSeconds: number } | { ok: false; reason: string } {
  const name = headerLabel(input.header);
  let timestamp: string | null = null;
  const signatures: string[] = [];
  for (const element of (input.value ?? "").split(",")) {
    const separator = element.indexOf("=");
    if (separator < 0) continue;
    const key = element.slice(0, separator).trim();
    const value = element.slice(separator + 1).trim();
    if (key === "t" && timestamp === null) timestamp = value;
    else if (key === "v1") signatures.push(value);
  }
  if (timestamp === null || signatures.length === 0) {
    return { ok: false, reason: `Missing or malformed ${name} header` };
  }
  if (!/^\d{1,12}$/u.test(timestamp)) {
    return { ok: false, reason: `The ${name} time is not a Unix time` };
  }
  const timestampSeconds = Number(timestamp);
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestampSeconds) > input.toleranceSeconds) {
    return {
      ok: false,
      reason: `The delivery was signed more than ${input.toleranceSeconds} seconds from now`,
    };
  }
  const expected = timestampedHmac(input.secret, timestamp, input.body);
  const matched = signatures
    .filter((signature) => /^[0-9a-fA-F]{64}$/u.test(signature))
    .some((signature) => constantTimeEqual(Buffer.from(signature, "hex"), expected));
  return matched
    ? { ok: true, timestampSeconds }
    : { ok: false, reason: `The ${name} header does not match the signing secret` };
}

/** The header value `verifyTimestampedHmac` accepts. Used by tests and test deliveries. */
export function signTimestampedHmac(input: {
  secret: string;
  body: Uint8Array | string;
  timestampSeconds?: number;
}): string {
  const timestamp = String(input.timestampSeconds ?? Math.floor(Date.now() / 1000));
  return `t=${timestamp},v1=${timestampedHmac(input.secret, timestamp, input.body).toString("hex")}`;
}

function timestampedHmac(secret: string, timestamp: string, body: Uint8Array | string): Buffer {
  return createHmac("sha256", Buffer.from(secret, "utf8"))
    .update(`${timestamp}.`, "utf8")
    .update(bodyBytes(body))
    .digest();
}

/** Verify a shared token sent as a header's value, after an optional prefix such as `Bearer `. */
export function verifyHeaderToken(input: {
  secret: string;
  header: string;
  value: string | null;
  prefix: string;
}): { ok: true } | { ok: false; reason: string } {
  const name = headerLabel(input.header);
  if (input.value === null) return { ok: false, reason: `Missing ${name} header` };
  const provided = input.value.trim();
  const matched =
    provided.toLowerCase().startsWith(input.prefix.toLowerCase()) &&
    constantTimeEqual(
      createHmac("sha256", "token").update(provided.slice(input.prefix.length).trim()).digest(),
      createHmac("sha256", "token").update(input.secret).digest(),
    );
  return matched ? { ok: true } : { ok: false, reason: `The ${name} header is not the secret` };
}

function constantTimeEqual(left: Buffer, right: Buffer): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}
