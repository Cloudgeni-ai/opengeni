import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  SITE_GATEWAY_CLIENT_IP_HEADER,
  SITE_GATEWAY_HOST_HEADER,
  SITE_GATEWAY_HUMAN_HEADER,
  SITE_GATEWAY_MAX_SKEW_SECONDS,
  SITE_GATEWAY_SESSION_HEADER,
  SITE_GATEWAY_SIGNATURE_HEADER,
  SITE_GATEWAY_TIMESTAMP_HEADER,
  SITE_GATEWAY_VISITOR_HEADER,
  siteGatewayCanonicalString,
} from "@opengeni/contracts";

export const TEST_SECRET = "test-gateway-secret-0123456789abcdefghij";

/** Gateway-local header (src/signing.ts), spelled out independently here. */
export const BODY_SHA256_HEADER = "x-opengeni-site-body-sha256";

/**
 * What the API must do before reading the body, written independently of
 * the gateway (node:crypto, not WebCrypto): rebuild the canonical string
 * from the received headers, taking the body hash from
 * `x-opengeni-site-body-sha256`, and compare the HMAC in constant time,
 * within the allowed clock skew.
 */
export function verifyGatewayHeaders(
  secret: string,
  request: { method: string; url: string; headers: Headers },
  now = Date.now(),
): boolean {
  const url = new URL(request.url);
  const timestamp = Number(request.headers.get(SITE_GATEWAY_TIMESTAMP_HEADER));
  if (!Number.isInteger(timestamp)) return false;
  if (Math.abs(Math.floor(now / 1000) - timestamp) > SITE_GATEWAY_MAX_SKEW_SECONDS) return false;
  const bodySha256 = request.headers.get(BODY_SHA256_HEADER) ?? "";
  if (!/^[0-9a-f]{64}$/u.test(bodySha256)) return false;
  const canonical = siteGatewayCanonicalString({
    method: request.method,
    pathWithQuery: `${url.pathname}${url.search}`,
    timestamp,
    bodySha256,
    host: request.headers.get(SITE_GATEWAY_HOST_HEADER) ?? "",
    session: request.headers.get(SITE_GATEWAY_SESSION_HEADER) ?? "",
    visitor: request.headers.get(SITE_GATEWAY_VISITOR_HEADER) ?? "",
    clientIp: request.headers.get(SITE_GATEWAY_CLIENT_IP_HEADER) ?? "",
    human: request.headers.get(SITE_GATEWAY_HUMAN_HEADER) ?? "",
  });
  const expected = `v1=${createHmac("sha256", secret).update(canonical).digest("base64url")}`;
  const received = request.headers.get(SITE_GATEWAY_SIGNATURE_HEADER) ?? "";
  return (
    received.length === expected.length &&
    timingSafeEqual(Buffer.from(received), Buffer.from(expected))
  );
}

/** The full check: headers first, then the body read and compared with the signed hash. */
export function verifyGatewaySignature(
  secret: string,
  request: { method: string; url: string; headers: Headers },
  body: Uint8Array,
  now = Date.now(),
): boolean {
  return (
    verifyGatewayHeaders(secret, request, now) &&
    request.headers.get(BODY_SHA256_HEADER) === createHash("sha256").update(body).digest("hex")
  );
}
