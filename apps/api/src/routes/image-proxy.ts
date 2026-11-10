// Image proxy for the console.
//
// The console's Content-Security-Policy lists exact image origins (storage,
// sign-in avatars, catalog logos; see http/console-content-security.ts). An
// image anywhere else, such as a picture an agent links in markdown or a
// workspace's own model or plugin logo, is loaded through this route instead,
// so it still shows without a scheme-wide `img-src https:`.
//
// Safety:
// - A signed-in person only, GET only, and a per-person rate limit. An <img>
//   carries the browser's sign-in cookie, or, where the page signs in with a
//   bearer token an <img> cannot send (the Excel add-in), a short-lived
//   signed ticket from GET /v1/image-proxy/ticket that only this route
//   accepts.
// - HTTPS upstreams only. Every hop, including each redirect (at most three),
//   resolves DNS once, refuses private, loopback, link-local, CGNAT, metadata
//   and other special-use addresses, and connects to exactly the vetted
//   addresses (@opengeni/network pinnedFetch).
// - The upstream request carries no cookies, credentials or referrer.
// - A deadline and a byte cap; only image types identified by their leading
//   bytes (never the upstream Content-Type): raster formats and SVG.
// - The response is inert: sniffed Content-Type, `nosniff`, a sandboxing
//   `default-src 'none'` policy (SVG may use its own inline styles, nothing
//   else; an <img> never runs SVG scripts and the policy blocks them when the
//   URL is opened directly) and an inline disposition with a fixed name.
import {
  DestinationPolicyError,
  RequestDeadlineError,
  ResponseBodyLimitError,
  pinnedFetch,
  readResponseBodyBounded,
  type DnsLookup,
  type FetchLike,
  type PinnedFetchOptions,
} from "@opengeni/network";
import { createHmac, timingSafeEqual } from "node:crypto";
import { requireAccessContext } from "@opengeni/core";
import type { Settings } from "@opengeni/config";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ApiRouteDeps } from "@opengeni/core";
import { IMAGE_PROXY_PATH } from "../http/console-content-security";
import { PublicSetupRateLimiter } from "./managed-onboarding";

export const IMAGE_PROXY_MAX_BYTES = 10 * 1024 * 1024;
export const IMAGE_PROXY_TIMEOUT_MS = 10_000;
export const IMAGE_PROXY_MAX_REDIRECTS = 3;
const IMAGE_PROXY_MAX_URL_LENGTH = 4096;

export const IMAGE_PROXY_RESPONSE_CSP = "default-src 'none'; sandbox";
export const IMAGE_PROXY_SVG_RESPONSE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; sandbox";
export const IMAGE_PROXY_TICKET_PATH = "/v1/image-proxy/ticket";
export const IMAGE_PROXY_TICKET_TTL_SECONDS = 12 * 60 * 60;

export type ImageProxyOptions = {
  /** Test seams for the pinned transport. */
  fetchImpl?: FetchLike;
  dnsLookup?: DnsLookup;
  agentFactory?: PinnedFetchOptions["agentFactory"];
  limiter?: PublicSetupRateLimiter;
  timeoutMs?: number;
  /** Who is asking (the rate-limit key); defaults to the signed-in access context. Tests inject it. */
  subject?: (c: Context) => Promise<string>;
  /** Signs tickets; defaults to the deployment's auth secret. */
  ticketSecret?: string | null;
  now?: () => number;
};

/** The secret behind image proxy tickets, or null when the deployment has none. */
export function imageProxyTicketSecret(settings: Settings): string | null {
  const secret =
    settings.betterAuthSecret ?? settings.delegationSecret ?? settings.integrationsStateSecret;
  return secret
    ? createHmac("sha256", secret).update("opengeni-image-proxy-ticket:v1").digest("base64url")
    : null;
}

function ticketSignature(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/** A ticket naming `subject` until `expiresAt` (seconds). */
export function createImageProxyTicket(secret: string, subject: string, expiresAt: number): string {
  const payload = Buffer.from(JSON.stringify({ s: subject, e: expiresAt })).toString("base64url");
  return `${payload}.${ticketSignature(secret, payload)}`;
}

/** The subject of a valid, unexpired ticket, or null. */
export function readImageProxyTicket(
  secret: string,
  ticket: string,
  nowSeconds: number,
): string | null {
  const [payload, signature, extra] = ticket.split(".");
  if (!payload || !signature || extra !== undefined || ticket.length > 1024) return null;
  const expected = Buffer.from(ticketSignature(secret, payload));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  try {
    const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      s?: unknown;
      e?: unknown;
    };
    if (typeof value.s !== "string" || !value.s || typeof value.e !== "number") return null;
    return value.e > nowSeconds ? value.s : null;
  } catch {
    return null;
  }
}

type ImageType = { contentType: string; extension: string };

/** The raster type the leading bytes identify, or null. */
export function sniffRasterImage(bytes: Uint8Array): ImageType | null {
  const starts = (signature: readonly number[], offset = 0) =>
    bytes.length >= offset + signature.length &&
    signature.every((value, index) => bytes[offset + index] === value);
  const ascii = (text: string, offset = 0) =>
    starts(
      [...text].map((char) => char.charCodeAt(0)),
      offset,
    );
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return { contentType: "image/png", extension: "png" };
  if (starts([0xff, 0xd8, 0xff])) return { contentType: "image/jpeg", extension: "jpg" };
  if (ascii("GIF87a") || ascii("GIF89a")) return { contentType: "image/gif", extension: "gif" };
  if (ascii("RIFF") && ascii("WEBP", 8)) return { contentType: "image/webp", extension: "webp" };
  if (ascii("ftyp", 4) && (ascii("avif", 8) || ascii("avis", 8)))
    return { contentType: "image/avif", extension: "avif" };
  if (ascii("BM") && bytes.length >= 26) return { contentType: "image/bmp", extension: "bmp" };
  if (starts([0x00, 0x00, 0x01, 0x00]) && bytes.length >= 22)
    return { contentType: "image/x-icon", extension: "ico" };
  return null;
}

// An SVG document: optional BOM, XML declaration, comments and doctype, then
// the <svg> root element.
const SVG_PROLOGUE =
  /^\uFEFF?\s*(?:<\?xml[^>]*\?>\s*)?(?:(?:<!--[\s\S]*?-->|<!doctype\s+svg[^>]*>)\s*)*<svg[\s>/]/iu;

/** The image type the leading bytes identify (raster or SVG), or null. */
export function sniffImage(bytes: Uint8Array): ImageType | null {
  const raster = sniffRasterImage(bytes);
  if (raster) return raster;
  const head = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, 4096));
  return SVG_PROLOGUE.test(head) ? { contentType: "image/svg+xml", extension: "svg" } : null;
}

function refuse(status: 400 | 403 | 413 | 415 | 429 | 502 | 504, message: string): never {
  throw new HTTPException(status, { message });
}

function upstreamUrl(raw: string | undefined): URL {
  if (!raw || raw.length > IMAGE_PROXY_MAX_URL_LENGTH) refuse(400, "url must be an https URL");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    refuse(400, "url must be an https URL");
  }
  if (url.protocol !== "https:" || url.username || url.password || !url.hostname)
    refuse(400, "url must be an https URL");
  url.hash = "";
  return url;
}

export function registerImageProxyRoutes(
  app: Hono,
  deps: ApiRouteDeps,
  options: ImageProxyOptions = {},
): void {
  // Per person: a catalog or a chat full of pictures loads at once, then
  // refills steadily. Browsers cache every answer for a day.
  const limiter =
    options.limiter ??
    new PublicSetupRateLimiter({
      globalCapacity: 5_000,
      globalRefillPerSecond: 500,
      clientCapacity: 600,
      clientRefillPerSecond: 20,
      maxClientKeys: 10_000,
    });
  const ticketSecret =
    options.ticketSecret === undefined
      ? deps.settings
        ? imageProxyTicketSecret(deps.settings)
        : null
      : options.ticketSecret;
  const nowSeconds = () => Math.floor((options.now?.() ?? Date.now()) / 1000);

  // A ticket for pages that sign in with a bearer token (an <img> cannot
  // send it). It identifies the person to the proxy and authorizes nothing
  // else.
  app.get(IMAGE_PROXY_TICKET_PATH, async (c: Context) => {
    if (!ticketSecret) throw new HTTPException(404, { message: "image proxy tickets are off" });
    const subject = options.subject
      ? await options.subject(c)
      : (await requireAccessContext(c, deps)).subjectId;
    const expiresAt = nowSeconds() + IMAGE_PROXY_TICKET_TTL_SECONDS;
    c.header("cache-control", "no-store");
    return c.json({
      ticket: createImageProxyTicket(ticketSecret, subject, expiresAt),
      expiresAt: new Date(expiresAt * 1000).toISOString(),
    });
  });
  // The proxy never reaches a private network, whatever the integration
  // settings or environment allow for operator-configured connectors.
  const network = { environment: "production", integrationsAllowPrivateNetworkTargets: false };
  const transport: PinnedFetchOptions = {
    label: "Image",
    requireHttpsOutsideLocalTest: true,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.dnsLookup ? { dnsLookup: options.dnsLookup } : {}),
    ...(options.agentFactory ? { agentFactory: options.agentFactory } : {}),
  };

  app.get(IMAGE_PROXY_PATH, async (c: Context) => {
    // An <img> sends the sign-in cookie or a ticket; it can never send
    // Authorization or an access key header.
    if (c.req.header("authorization") || c.req.header("x-opengeni-access-key"))
      refuse(403, "the image proxy serves signed-in browsers");
    const ticket = c.req.query("ticket");
    let subject: string;
    if (ticket !== undefined) {
      const fromTicket = ticketSecret
        ? readImageProxyTicket(ticketSecret, ticket, nowSeconds())
        : null;
      if (!fromTicket) throw new HTTPException(401, { message: "the image ticket is not valid" });
      subject = fromTicket;
    } else {
      subject = options.subject
        ? await options.subject(c)
        : (await requireAccessContext(c, deps)).subjectId;
    }
    if (!limiter.take(`image-proxy:${subject}`)) refuse(429, "too many image requests");
    let url = upstreamUrl(c.req.query("url"));

    const signal = AbortSignal.timeout(options.timeoutMs ?? IMAGE_PROXY_TIMEOUT_MS);
    let bytes: Uint8Array;
    try {
      let response: Response | null = null;
      for (let hop = 0; ; hop += 1) {
        response = await pinnedFetch(
          url,
          {
            method: "GET",
            headers: {
              accept: "image/avif,image/webp,image/png,image/jpeg,image/gif,image/*;q=0.8",
              "user-agent": "Opengeni-ImageProxy",
            },
            signal,
          },
          network,
          transport,
        );
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        const location = response.headers.get("location");
        await response.body?.cancel().catch(() => undefined);
        if (!location || hop >= IMAGE_PROXY_MAX_REDIRECTS)
          refuse(502, "the image redirects too often");
        url = upstreamUrl(new URL(location, url).toString());
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        refuse(502, "the image could not be loaded");
      }
      bytes = await readResponseBodyBounded(response, IMAGE_PROXY_MAX_BYTES, "Image", { signal });
    } catch (error) {
      if (error instanceof HTTPException) throw error;
      // One answer for every refused address, so callers cannot tell an
      // unresolvable name from a private one.
      if (error instanceof DestinationPolicyError) refuse(403, "the image address is not allowed");
      if (error instanceof ResponseBodyLimitError) refuse(413, "the image is too large");
      if (error instanceof RequestDeadlineError || signal.aborted)
        refuse(504, "the image took too long to load");
      refuse(502, "the image could not be loaded");
    }
    const type = sniffImage(bytes);
    if (!type) refuse(415, "not a supported image");
    return new Response(bytes as Uint8Array<ArrayBuffer>, {
      status: 200,
      headers: {
        "content-type": type.contentType,
        "content-length": String(bytes.byteLength),
        "content-disposition": `inline; filename="image.${type.extension}"`,
        "content-security-policy":
          type.contentType === "image/svg+xml"
            ? IMAGE_PROXY_SVG_RESPONSE_CSP
            : IMAGE_PROXY_RESPONSE_CSP,
        // A console on another origin than the API embeds it too.
        "cross-origin-resource-policy": "cross-origin",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        "cache-control": "private, max-age=86400",
      },
    });
  });
}
