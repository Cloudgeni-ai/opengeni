import {
  createHmac,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  verify as verifySignature,
  type KeyObject,
} from "node:crypto";
import type { WebhookSignedContentPart } from "@opengeni/contracts";

/**
 * Webhook signature schemes event sources use: Standard Webhooks (used by
 * Opengeni's own format, Svix-based apps and MCP Events webhook delivery), an
 * HMAC-SHA256 of the raw body or of a layout around it (Linear, Sentry, Slack
 * and many others), a timestamped `t=…,v1=…` HMAC-SHA256 (Stripe, Tailscale),
 * Ed25519 (Discord), a shared token in a header, and a secret in the URL.
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

/**
 * The exact bytes an app signed: the layout's literal text, header values and
 * raw body, in order. Without a layout, the body alone.
 */
export function webhookSignedBytes(input: {
  layout: readonly WebhookSignedContentPart[] | null;
  headers: Headers;
  body: Uint8Array;
}): { ok: true; bytes: Uint8Array } | { ok: false; reason: string } {
  if (!input.layout) return { ok: true, bytes: input.body };
  const chunks: Uint8Array[] = [];
  for (const part of input.layout) {
    if (part.kind === "body") chunks.push(input.body);
    else if (part.kind === "text") chunks.push(Buffer.from(part.text, "utf8"));
    else {
      const value = input.headers.get(part.header);
      if (value === null)
        return { ok: false, reason: `Missing ${headerLabel(part.header)} header` };
      chunks.push(Buffer.from(value, "utf8"));
    }
  }
  return { ok: true, bytes: Buffer.concat(chunks) };
}

/** What the value of a header names when the header is absent or wrong. */
function headerLabel(header: string): string {
  return header.replace(
    /(^|-)([a-z])/gu,
    (_, dash: string, letter: string) => `${dash}${letter.toUpperCase()}`,
  );
}

/**
 * Verify an HMAC-SHA256 of the raw body (or of the signed bytes a layout
 * makes of it), keyed with the secret's UTF-8 bytes, in hex or base64 after an
 * optional prefix such as `sha256=`.
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
  const provided = signatureBytes(input, 32);
  if (!provided.ok) return provided;
  return provided.bytes && constantTimeEqual(provided.bytes, bodyHmac(input.secret, input.body))
    ? { ok: true }
    : { ok: false, reason: `The ${name} header does not match the signing secret` };
}

/**
 * A signature header's bytes: present, after its prefix, and `length` bytes
 * in hex or base64 (standard or URL-safe). `bytes` is null when it is
 * malformed, which the caller reports as not matching.
 */
function signatureBytes(
  input: { header: string; value: string | null; encoding: "hex" | "base64"; prefix: string },
  length: number,
): { ok: true; bytes: Buffer | null } | { ok: false; reason: string } {
  const name = headerLabel(input.header);
  const value = input.value?.trim() ?? "";
  if (!value) return { ok: false, reason: `Missing ${name} header` };
  if (input.prefix && !value.startsWith(input.prefix)) {
    return { ok: false, reason: `The ${name} header does not start with "${input.prefix}"` };
  }
  const encoded = value.slice(input.prefix.length);
  if (input.encoding === "hex") {
    return {
      ok: true,
      bytes: new RegExp(`^[0-9a-fA-F]{${length * 2}}$`, "u").test(encoded)
        ? Buffer.from(encoded, "hex")
        : null,
    };
  }
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/u.test(encoded)) return { ok: true, bytes: null };
  const bytes = Buffer.from(encoded.replace(/-/gu, "+").replace(/_/gu, "/"), "base64");
  return { ok: true, bytes: bytes.byteLength === length ? bytes : null };
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

/**
 * Verify a secret sent in the webhook address's query, as `?<parameter>=<secret>`,
 * for apps that can't sign their deliveries.
 */
export function verifyUrlToken(input: {
  secret: string;
  parameter: string;
  query: URLSearchParams;
}): { ok: true } | { ok: false; reason: string } {
  const provided = input.query.get(input.parameter);
  if (provided === null) {
    return { ok: false, reason: `The address has no ?${input.parameter}= secret` };
  }
  return constantTimeEqual(
    createHmac("sha256", "token").update(provided).digest(),
    createHmac("sha256", "token").update(input.secret).digest(),
  )
    ? { ok: true }
    : { ok: false, reason: `The address's ?${input.parameter}= is not the secret` };
}

/** The DER prefix of an Ed25519 SubjectPublicKeyInfo, before the 32 key bytes. */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/**
 * An app's Ed25519 public key as the source's secret holds it: 32 bytes in
 * hex or base64, or a PEM public key. Null when it is none of these.
 */
export function ed25519PublicKey(secret: string): KeyObject | null {
  const value = secret.trim();
  let raw: Buffer | null = null;
  if (/^[0-9a-fA-F]{64}$/u.test(value)) raw = Buffer.from(value, "hex");
  else if (/^[A-Za-z0-9+/_-]{43}={0,1}$/u.test(value)) {
    raw = Buffer.from(value.replace(/-/gu, "+").replace(/_/gu, "/"), "base64");
  }
  try {
    const key = raw
      ? createPublicKey({
          key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
          format: "der",
          type: "spki",
        })
      : value.startsWith("-----BEGIN PUBLIC KEY-----")
        ? createPublicKey(value)
        : null;
    return key?.asymmetricKeyType === "ed25519" ? key : null;
  } catch {
    return null;
  }
}

/**
 * Verify an Ed25519 signature in a header (hex or base64, after an optional
 * prefix) over the signed bytes, with the app's public key as the secret.
 */
export function verifyEd25519(input: {
  publicKey: string;
  header: string;
  value: string | null;
  signed: Uint8Array;
  encoding: "hex" | "base64";
  prefix: string;
}): { ok: true } | { ok: false; reason: string } {
  const name = headerLabel(input.header);
  const key = ed25519PublicKey(input.publicKey);
  if (!key) return { ok: false, reason: "The source's secret is not an Ed25519 public key" };
  const provided = signatureBytes(input, 64);
  if (!provided.ok) return provided;
  let valid = false;
  try {
    valid = provided.bytes !== null && verifySignature(null, input.signed, key, provided.bytes);
  } catch {
    valid = false;
  }
  return valid
    ? { ok: true }
    : { ok: false, reason: `The ${name} header is not a valid signature from the app's key` };
}

function constantTimeEqual(left: Buffer, right: Buffer): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}
