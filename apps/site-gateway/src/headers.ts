/**
 * Edge security headers. The shell is strict (nonce scripts only, same-origin
 * connections and frames, never framed); Site HTML is sandboxed by its own
 * CSP header and framable only by its shell.
 */

/** iframe sandbox for Site HTML. Never `allow-same-origin`: the Site runs in an opaque origin. */
export const SITE_FRAME_SANDBOX =
  "allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals";

/**
 * CSP header on Site HTML. The `sandbox` directive repeats the frame's
 * sandbox so a direct navigation to /_og/v/<id> is just as isolated, and
 * only the Site's own shell may frame it. Inside that, the Site's own
 * scripts and resources run as they do in the console frame.
 */
export const SITE_HTML_CSP = `sandbox ${SITE_FRAME_SANDBOX}; frame-ancestors 'self'`;

export const PERMISSIONS_POLICY = [
  "accelerometer=()",
  "ambient-light-sensor=()",
  "autoplay=()",
  "bluetooth=()",
  "browsing-topics=()",
  "camera=()",
  "display-capture=()",
  "encrypted-media=()",
  "geolocation=()",
  "gyroscope=()",
  "hid=()",
  "identity-credentials-get=()",
  "idle-detection=()",
  "local-fonts=()",
  "magnetometer=()",
  "microphone=()",
  "midi=()",
  "otp-credentials=()",
  "payment=()",
  "publickey-credentials-create=()",
  "publickey-credentials-get=()",
  "screen-wake-lock=()",
  "serial=()",
  "usb=()",
  "web-share=()",
  "xr-spatial-tracking=()",
].join(", ");

const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";

/** CSP for the shell page. Turnstile's origin is added only when the human check is configured. */
export function shellCsp(nonce: string, options: { turnstile: boolean }): string {
  const turnstile = options.turnstile ? ` ${TURNSTILE_ORIGIN}` : "";
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'${turnstile}`,
    `style-src 'nonce-${nonce}'`,
    "img-src 'self' data:",
    `frame-src 'self'${turnstile}`,
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** CSP for the gateway's own small pages (neutral, takedown, report, errors): no script at all. */
export function pageCsp(nonce: string): string {
  return [
    "default-src 'none'",
    `style-src 'nonce-${nonce}'`,
    "img-src 'self' data:",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export type SecurityOptions = {
  noindex: boolean;
  /** HSTS is omitted for plain-HTTP local development. */
  hsts: boolean;
  /** `none` for shell and pages, `self` for Site HTML. */
  frameable?: "none" | "self";
};

/** Headers every gateway response carries. */
export function applySecurityHeaders(headers: Headers, options: SecurityOptions): Headers {
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Permissions-Policy", PERMISSIONS_POLICY);
  headers.set("X-Frame-Options", options.frameable === "self" ? "SAMEORIGIN" : "DENY");
  if (options.hsts) headers.set("Strict-Transport-Security", "max-age=31536000");
  if (options.noindex) headers.set("X-Robots-Tag", "noindex");
  return headers;
}

/** The nonce for one response: 128 bits, base64. */
export function newNonce(): string {
  let binary = "";
  for (const byte of crypto.getRandomValues(new Uint8Array(16)))
    binary += String.fromCharCode(byte);
  return btoa(binary);
}

export type ErrorBody = {
  code: string;
  message: string;
  retryable?: boolean;
  outcomeUnknown?: boolean;
};

/** The API's error envelope shape, so the Site SDK decodes gateway refusals like API errors. */
export function jsonError(
  status: number,
  error: ErrorBody,
  options: SecurityOptions & { headers?: HeadersInit } = { noindex: true, hsts: true },
): Response {
  const headers = applySecurityHeaders(new Headers(options.headers), options);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return new Response(
    JSON.stringify({
      error: {
        status,
        code: error.code,
        message: error.message,
        retryable: error.retryable ?? false,
        outcomeUnknown: error.outcomeUnknown ?? false,
      },
    }),
    { status, headers },
  );
}
