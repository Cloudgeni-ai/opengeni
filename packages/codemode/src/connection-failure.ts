/**
 * Plain, cause-specific messages for a Codemode request that never got an HTTP
 * answer. Node's fetch (undici) reports every such failure as "fetch failed"
 * and keeps the reason in `cause`; Bun puts the reason's code on the error
 * itself. Either way the person or agent reading `ogtool` output needs the
 * reason (a broken resolver, a wrong clock, a refused connection), not the
 * transport's generic wording.
 */

/** A Codemode request failed before Opengeni answered, for a known network reason. */
export class CodemodeConnectionError extends Error {
  readonly code = "codemode_connection_failed";

  constructor(
    message: string,
    /** The system or TLS code that explains the failure, such as `ENOTFOUND`. */
    readonly networkCode: string,
    options: { cause: unknown },
  ) {
    super(message, options);
    this.name = "CodemodeConnectionError";
  }
}

const DNS_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "EAI_FAIL", "EAI_NONAME", "EAI_NODATA"]);

const TLS_VERIFY_CODES = new Set([
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "CERT_UNTRUSTED",
  "CERT_REJECTED",
  "CERT_REVOKED",
  "CERT_SIGNATURE_FAILURE",
  "CERT_CHAIN_TOO_LONG",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

const REFUSED_CODES = new Set(["ECONNREFUSED", "ConnectionRefused"]);

const TIMEOUT_CODES = new Set(["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT"]);

/** The request reached Opengeni but no answer came back in time. */
const ANSWER_TIMEOUT_CODES = new Set(["UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]);

const CLOSED_CODES = new Set(["ECONNRESET", "EPIPE", "UND_ERR_SOCKET", "ConnectionClosed"]);

const UNREACHABLE_CODES = new Set(["ENETUNREACH", "EHOSTUNREACH", "ENETDOWN", "EADDRNOTAVAIL"]);

function isKnownCode(code: string): boolean {
  return (
    DNS_CODES.has(code) ||
    code === "CERT_NOT_YET_VALID" ||
    code === "CERT_HAS_EXPIRED" ||
    TLS_VERIFY_CODES.has(code) ||
    REFUSED_CODES.has(code) ||
    TIMEOUT_CODES.has(code) ||
    ANSWER_TIMEOUT_CODES.has(code) ||
    CLOSED_CODES.has(code) ||
    UNREACHABLE_CODES.has(code)
  );
}

/** The first known failure code on the error, its cause chain, or an aggregate's members. */
function knownFailureCode(error: unknown, depth = 0): string | null {
  if (!error || typeof error !== "object" || depth > 4) return null;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && isKnownCode(code)) return code;
  const errors = (error as { errors?: unknown }).errors;
  if (Array.isArray(errors)) {
    for (const member of errors) {
      const found = knownFailureCode(member, depth + 1);
      if (found) return found;
    }
  }
  return knownFailureCode((error as { cause?: unknown }).cause, depth + 1);
}

function isAbort(error: unknown): boolean {
  const name = error && typeof error === "object" ? (error as { name?: unknown }).name : null;
  return name === "AbortError" || name === "TimeoutError";
}

/** UTC, to the second, so the reader can compare it with the real time. */
function clockReading(now: Date): string {
  const time = now.getTime();
  if (!Number.isFinite(time)) return "an invalid time";
  return `${now.toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

function targetOf(url: string): { hostname: string; host: string } {
  try {
    const parsed = new URL(url);
    return { hostname: parsed.hostname, host: parsed.host };
  } catch {
    return { hostname: "the Opengeni host", host: "the Opengeni host" };
  }
}

/**
 * One short sentence naming why a request to `url` got no answer, with what
 * to check; null when the reason is unknown (the caller keeps its own error).
 */
export function describeCodemodeConnectionFailure(
  error: unknown,
  url: string,
  now: Date = new Date(),
  platform: string = process.platform,
): { message: string; networkCode: string } | null {
  if (isAbort(error)) return null;
  const code = knownFailureCode(error);
  if (!code) return null;
  const { hostname, host } = targetOf(url);
  const prefix = "Can't reach Opengeni:";
  let message: string;
  if (DNS_CODES.has(code)) {
    message = `${prefix} DNS lookup for ${hostname} failed (${code}). ${
      platform === "linux" ? "Check /etc/resolv.conf." : "Check this machine's DNS settings."
    }`;
  } else if (code === "CERT_NOT_YET_VALID") {
    message = `${prefix} TLS certificate not yet valid. This machine's clock says ${clockReading(now)}, so it is probably wrong.`;
  } else if (code === "CERT_HAS_EXPIRED") {
    message = `${prefix} the TLS certificate for ${hostname} has expired by this machine's clock (${clockReading(now)}). If that time is wrong, fix the clock; otherwise the server's certificate has expired.`;
  } else if (TLS_VERIFY_CODES.has(code)) {
    message = `${prefix} the TLS certificate of ${hostname} could not be verified (${code}). Check this machine's CA certificates and any HTTPS proxy.`;
  } else if (REFUSED_CODES.has(code)) {
    message = `${prefix} the connection to ${host} was refused (${code}). Check this machine's network, firewall and proxy settings.`;
  } else if (TIMEOUT_CODES.has(code)) {
    message = `${prefix} the connection to ${host} timed out (${code}). Check this machine's network, firewall and proxy settings.`;
  } else if (ANSWER_TIMEOUT_CODES.has(code)) {
    message = `${prefix} ${host} did not answer in time (${code}).`;
  } else if (CLOSED_CODES.has(code)) {
    message = `${prefix} the connection to ${host} closed unexpectedly (${code}). If it keeps happening, check this machine's network and proxy settings.`;
  } else {
    message = `${prefix} no network route to ${host} (${code}). Check this machine's network settings.`;
  }
  return { message, networkCode: code };
}
