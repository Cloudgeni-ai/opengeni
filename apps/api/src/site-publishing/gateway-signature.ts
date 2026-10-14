import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  siteGatewayCanonicalString,
  SITE_GATEWAY_BODY_SHA256_HEADER,
  SITE_GATEWAY_CLIENT_IP_HEADER,
  SITE_GATEWAY_HOST_HEADER,
  SITE_GATEWAY_HUMAN_HEADER,
  SITE_GATEWAY_MAX_SKEW_SECONDS,
  SITE_GATEWAY_SESSION_HEADER,
  SITE_GATEWAY_SIGNATURE_HEADER,
  SITE_GATEWAY_SIGNATURE_VERSION,
  SITE_GATEWAY_TIMESTAMP_HEADER,
  SITE_GATEWAY_VISITOR_HEADER,
} from "@opengeni/contracts";

/**
 * Verification of gateway-signed site-runtime requests. The gateway HMACs
 * `siteGatewayCanonicalString` with the shared secret; the API accepts the
 * current or the previous secret (rotation), within 30 s of its clock. The
 * signed body hash travels in its own header, so the signature is checked
 * from the headers alone, before the body is read; the route then hashes the
 * body as it reads it and refuses a body that does not match. Nothing else
 * about the request is trusted before this passes.
 */

export type SiteGatewayFields = {
  host: string;
  session: string;
  visitor: string;
  clientIp: string;
  human: boolean;
};

export type SiteGatewayVerification =
  | {
      ok: true;
      fields: SiteGatewayFields;
      /** The signed hex SHA-256 the body read afterwards must match. */
      bodySha256: string;
    }
  | {
      ok: false;
      reason:
        | "not_configured"
        | "missing_headers"
        | "bad_timestamp"
        | "skew"
        | "bad_body_hash"
        | "bad_signature"
        | "body_mismatch"
        | "credentials";
    };

const SHA256_HEX = /^[0-9a-f]{64}$/u;

/** Request headers that carry Opengeni app credentials; site-runtime refuses them. */
export const SITE_RUNTIME_REFUSED_HEADERS: readonly string[] = Object.freeze([
  "authorization",
  "proxy-authorization",
  "cookie",
  "x-api-key",
  "x-opengeni-external-actor",
]);

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function siteGatewaySignature(secret: string, canonical: string): string {
  return `${SITE_GATEWAY_SIGNATURE_VERSION}=${createHmac("sha256", secret)
    .update(canonical, "utf8")
    .digest("base64url")}`;
}

function sameText(expected: string, presented: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(presented, "utf8");
  // Equal-length compare; a length mismatch still spends a compare.
  if (a.length !== b.length) {
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

/** Bounded header value: the gateway never sends long values here. */
function header(headers: Headers, name: string, max = 512): string | null {
  const value = headers.get(name);
  if (value === null) return null;
  return value.length > max ? null : value;
}

/**
 * Verify a signed request from its headers alone; the body is not needed.
 * On success the caller reads the body (capped) and checks it against
 * `bodySha256` with `sameSha256Hex`, refusing a mismatch as `body_mismatch`.
 */
export function verifySiteGatewayRequest(input: {
  method: string;
  pathWithQuery: string;
  headers: Headers;
  secrets: readonly (string | undefined)[];
  nowMs?: number;
}): SiteGatewayVerification {
  const secrets = input.secrets.filter((secret): secret is string => Boolean(secret));
  if (secrets.length === 0) return { ok: false, reason: "not_configured" };
  const signature = header(input.headers, SITE_GATEWAY_SIGNATURE_HEADER, 128);
  const timestampText = header(input.headers, SITE_GATEWAY_TIMESTAMP_HEADER, 16);
  const host = header(input.headers, SITE_GATEWAY_HOST_HEADER, 253);
  const bodySha256 = input.headers.get(SITE_GATEWAY_BODY_SHA256_HEADER);
  if (!signature || !timestampText || !host || bodySha256 === null)
    return { ok: false, reason: "missing_headers" };
  if (!/^\d{1,12}$/u.test(timestampText)) return { ok: false, reason: "bad_timestamp" };
  const timestamp = Number(timestampText);
  const now = Math.floor((input.nowMs ?? Date.now()) / 1000);
  if (Math.abs(now - timestamp) > SITE_GATEWAY_MAX_SKEW_SECONDS)
    return { ok: false, reason: "skew" };
  // The hash must be lowercase hex, exactly as the gateway signs it.
  if (!SHA256_HEX.test(bodySha256)) return { ok: false, reason: "bad_body_hash" };
  const session = header(input.headers, SITE_GATEWAY_SESSION_HEADER) ?? "";
  const visitor = header(input.headers, SITE_GATEWAY_VISITOR_HEADER) ?? "";
  const clientIp = header(input.headers, SITE_GATEWAY_CLIENT_IP_HEADER, 64) ?? "";
  const human = header(input.headers, SITE_GATEWAY_HUMAN_HEADER, 8) ?? "";
  const canonical = siteGatewayCanonicalString({
    method: input.method,
    host,
    pathWithQuery: input.pathWithQuery,
    timestamp,
    bodySha256,
    session,
    visitor,
    clientIp,
    human,
  });
  // Check every configured secret, so timing does not reveal which one matched.
  let matched = false;
  for (const secret of secrets)
    matched = sameText(siteGatewaySignature(secret, canonical), signature) || matched;
  if (!matched) return { ok: false, reason: "bad_signature" };
  // Signed requests never carry app credentials; a request that does is refused.
  if (SITE_RUNTIME_REFUSED_HEADERS.some((name) => input.headers.has(name)))
    return { ok: false, reason: "credentials" };
  return {
    ok: true,
    fields: { host: host.toLowerCase(), session, visitor, clientIp, human: human === "1" },
    bodySha256,
  };
}

/** Whether two hex digests are equal, compared in constant time. */
export function sameSha256Hex(actual: string, signed: string): boolean {
  return sameText(actual, signed);
}

/** Sign a request as the gateway does (tests and local tools). */
export function signSiteGatewayRequest(input: {
  secret: string;
  method: string;
  pathWithQuery: string;
  host: string;
  body?: Uint8Array | string;
  session?: string;
  visitor?: string;
  clientIp?: string;
  human?: boolean;
  nowMs?: number;
}): Record<string, string> {
  const body =
    typeof input.body === "string"
      ? new TextEncoder().encode(input.body)
      : (input.body ?? new Uint8Array());
  const timestamp = Math.floor((input.nowMs ?? Date.now()) / 1000);
  const fields = {
    session: input.session ?? "",
    visitor: input.visitor ?? "",
    clientIp: input.clientIp ?? "",
    human: input.human ? "1" : "",
  };
  const bodySha256 = sha256Hex(body);
  const canonical = siteGatewayCanonicalString({
    method: input.method,
    host: input.host,
    pathWithQuery: input.pathWithQuery,
    timestamp,
    bodySha256,
    ...fields,
  });
  return {
    [SITE_GATEWAY_BODY_SHA256_HEADER]: bodySha256,
    [SITE_GATEWAY_TIMESTAMP_HEADER]: String(timestamp),
    [SITE_GATEWAY_SIGNATURE_HEADER]: siteGatewaySignature(input.secret, canonical),
    [SITE_GATEWAY_HOST_HEADER]: input.host,
    ...(fields.session ? { [SITE_GATEWAY_SESSION_HEADER]: fields.session } : {}),
    ...(fields.visitor ? { [SITE_GATEWAY_VISITOR_HEADER]: fields.visitor } : {}),
    ...(fields.clientIp ? { [SITE_GATEWAY_CLIENT_IP_HEADER]: fields.clientIp } : {}),
    ...(fields.human ? { [SITE_GATEWAY_HUMAN_HEADER]: fields.human } : {}),
  };
}
