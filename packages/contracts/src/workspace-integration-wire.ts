/**
 * Dependency-free wire constants and the OpenGeni-Signature scheme shared by
 * workspace webhooks and credential providers. Kept free of zod so browser and
 * React Native bundles can verify signatures without the schema runtime.
 */

export const WORKSPACE_WEBHOOK_EVENT_TYPES = [
  "turn.completed",
  "turn.failed",
  "turn.cancelled",
  "session.status.changed",
  "session.requiresAction",
  "session.humanInput.requested",
  "usage.threshold_reached",
  "usage.exhausted",
  "usage.period_reset",
] as const;

export const OPENGENI_SIGNATURE_HEADER = "OpenGeni-Signature";
export const OPENGENI_EVENT_ID_HEADER = "OpenGeni-Event-Id";
export const OPENGENI_DELIVERY_ID_HEADER = "OpenGeni-Delivery-Id";
export const OPENGENI_SIGNATURE_TOLERANCE_SECONDS = 300;

const encoder = new TextEncoder();

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
  return Array.from(signature, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqualHex(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

/**
 * `OpenGeni-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`.
 * The timestamp is signed so a captured request cannot be replayed later.
 */
export async function signOpenGeniPayload(
  secret: string,
  body: string,
  timestampSeconds = Math.floor(Date.now() / 1000),
): Promise<string> {
  return `t=${timestampSeconds},v1=${await hmacSha256Hex(secret, `${timestampSeconds}.${body}`)}`;
}

export type VerifyOpenGeniSignatureInput = {
  secret: string;
  /** The exact raw request body, before JSON parsing. */
  body: string;
  /** The `OpenGeni-Signature` header value. */
  signature: string | null | undefined;
  toleranceSeconds?: number;
  nowSeconds?: number;
};

export async function verifyOpenGeniSignature(
  input: VerifyOpenGeniSignatureInput,
): Promise<boolean> {
  if (!input.signature) return false;
  let timestamp: number | null = null;
  const candidates: string[] = [];
  for (const part of input.signature.split(",")) {
    const [key, value] = part.trim().split("=", 2);
    if (key === "t" && value && /^\d{1,12}$/.test(value)) timestamp = Number(value);
    if (key === "v1" && value && /^[0-9a-f]{64}$/.test(value)) candidates.push(value);
  }
  if (timestamp === null || candidates.length === 0) return false;
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = input.toleranceSeconds ?? OPENGENI_SIGNATURE_TOLERANCE_SECONDS;
  if (Math.abs(now - timestamp) > tolerance) return false;
  const expected = await hmacSha256Hex(input.secret, `${timestamp}.${input.body}`);
  return candidates.some((candidate) => constantTimeEqualHex(candidate, expected));
}
