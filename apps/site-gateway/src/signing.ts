import {
  SITE_GATEWAY_CLIENT_IP_HEADER,
  SITE_GATEWAY_HOST_HEADER,
  SITE_GATEWAY_HUMAN_HEADER,
  SITE_GATEWAY_SESSION_HEADER,
  SITE_GATEWAY_SIGNATURE_HEADER,
  SITE_GATEWAY_SIGNATURE_VERSION,
  SITE_GATEWAY_TIMESTAMP_HEADER,
  SITE_GATEWAY_VISITOR_HEADER,
  SITE_RUNTIME_API_PREFIX,
  siteGatewayCanonicalString,
  type SiteGatewaySignedFields,
} from "@opengeni/contracts";
import { hmacBase64url, sha256Hex } from "./crypto";
import type { GatewayConfig } from "./env";

/** `v1=<base64url HMAC-SHA256>` over the shared canonical string. */
export async function signGatewayFields(
  secret: string,
  fields: SiteGatewaySignedFields,
): Promise<string> {
  return `${SITE_GATEWAY_SIGNATURE_VERSION}=${await hmacBase64url(
    secret,
    siteGatewayCanonicalString(fields),
  )}`;
}

/** Who is calling, as the gateway verified it. Empty strings mean absent. */
export type GatewayCaller = {
  host: string;
  session: string;
  visitor: string;
  clientIp: string;
  human: boolean;
};

export type SignedApiRequestInit = {
  method: string;
  /** Path after /v1/site-runtime, starting with "/" (or "" for the prefix itself). */
  suffix: string;
  /** "" or "?..." exactly as it will be sent. */
  search?: string;
  body?: Uint8Array<ArrayBuffer> | null;
  headers?: Headers;
  signal?: AbortSignal;
  now?: number;
};

/**
 * Build a signed request to the site-runtime API. Only the gateway's own
 * headers and the caller-filtered `headers` travel; inbound cookies and
 * authorization never do.
 */
export async function signedApiRequest(
  config: Pick<GatewayConfig, "apiOrigin" | "secret">,
  caller: GatewayCaller,
  init: SignedApiRequestInit,
): Promise<Request> {
  const method = init.method.toUpperCase();
  const pathWithQuery = `${SITE_RUNTIME_API_PREFIX}${init.suffix}${init.search ?? ""}`;
  const body = init.body && init.body.byteLength > 0 ? init.body : null;
  const timestamp = Math.floor((init.now ?? Date.now()) / 1000);
  const human = caller.human ? "1" : "";
  const signature = await signGatewayFields(config.secret, {
    method,
    pathWithQuery,
    timestamp,
    bodySha256: await sha256Hex(body ?? ""),
    host: caller.host,
    session: caller.session,
    visitor: caller.visitor,
    clientIp: caller.clientIp,
    human,
  });
  const headers = new Headers(init.headers);
  headers.set(SITE_GATEWAY_TIMESTAMP_HEADER, String(timestamp));
  headers.set(SITE_GATEWAY_SIGNATURE_HEADER, signature);
  headers.set(SITE_GATEWAY_HOST_HEADER, caller.host.toLowerCase());
  if (caller.session) headers.set(SITE_GATEWAY_SESSION_HEADER, caller.session);
  if (caller.visitor) headers.set(SITE_GATEWAY_VISITOR_HEADER, caller.visitor);
  if (caller.clientIp) headers.set(SITE_GATEWAY_CLIENT_IP_HEADER, caller.clientIp);
  if (human) headers.set(SITE_GATEWAY_HUMAN_HEADER, human);
  return new Request(`${config.apiOrigin}${pathWithQuery}`, {
    method,
    headers,
    ...(body ? { body } : {}),
    redirect: "manual",
    ...(init.signal ? { signal: init.signal } : {}),
  });
}
