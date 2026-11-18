import { resolveMx } from "node:dns/promises";
import type { Settings } from "@opengeni/config";
import type { SignupMailSignal } from "@opengeni/db";

/**
 * Disposable or temporary-inbox mail services: their own domains and the MX
 * hosts they receive mail on. Anyone can read an inbox there, so a domain on
 * this list, or a custom domain whose MX points at one of these hosts, is a
 * throwaway address. A name matches itself and its subdomains. Operators add
 * more with OPENGENI_SIGNUP_DISPOSABLE_MAIL_DOMAINS. Never list a general
 * mail host (Google, Microsoft, Yandex, Cloudflare routing, forwarding
 * services): custom domains of real companies point there too.
 */
export const DISPOSABLE_MAIL_PROVIDERS: readonly string[] = [
  // Temporary inboxes on many custom domains (receive-only MX hosts).
  "chatgpt.org.uk",
  "gravityengine.cc",
  "215.im",
  "cleantempmail.com",
  "mail.td",
  "add5000.com",
  "wabblywabble.com",
  "wallywatts.com",
  // Well-known temporary-inbox services and their MX hosts.
  "mailinator.com",
  "guerrillamail.com",
  "guerrillamail.net",
  "guerrillamail.org",
  "guerrillamail.biz",
  "guerrillamailblock.com",
  "sharklasers.com",
  "grr.la",
  "pokemail.net",
  "spam4.me",
  "yopmail.com",
  "yopmail.fr",
  "yopmail.net",
  "1secmail.com",
  "1secmail.net",
  "1secmail.org",
  "dropmail.me",
  "maildrop.cc",
  "getnada.com",
  "nada.email",
  "burnermail.io",
  "trashmail.com",
  "trashmail.de",
  "trashmail.net",
  "mailnesia.com",
  "tempmail.net",
  "tempail.com",
  "temp-mail.org",
  "temp-mail.io",
  "tempmailo.com",
  "tempmail.plus",
  "tempr.email",
  "discard.email",
  "minuteinbox.com",
  "fakemail.net",
  "harakirimail.com",
  "mailsac.com",
  "moakt.com",
  "tmail.ws",
  "spamgourmet.com",
  "mailcatch.com",
  "mytemp.email",
  "inboxkitten.com",
  "emailondeck.com",
  "10minutemail.com",
  "10minutemail.net",
  "20minutemail.com",
  "mail.tm",
  "mail.gw",
  "throwawaymail.com",
  "emailfake.com",
  "generator.email",
  "mail-temp.com",
  "etempmail.com",
  "mohmal.com",
  "snapmailnow.com",
  "catchmail.io",
  "mailpoof.com",
  "getairmail.com",
  "33mailbox.com",
  "fakeinbox.com",
  "spambox.us",
  "mintemail.com",
  "tempinbox.com",
  "dispostable.com",
  "mvrht.com",
  "emailtemporario.com.br",
  "linshiyouxiang.net",
  "bccto.me",
  "chacuo.net",
];

/** Lowercase name without a trailing dot, or null when it is not a host name. */
function hostName(value: string): string | null {
  const name = value.trim().toLowerCase().replace(/\.$/u, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/u.test(name) ? name : null;
}

/** The built-in list plus the operator's additions. */
export function disposableMailProviders(
  settings: Pick<Settings, "signupDisposableMailDomains">,
): Set<string> {
  const extra = settings.signupDisposableMailDomains
    .split(",")
    .map(hostName)
    .filter((name): name is string => name !== null);
  return new Set([...DISPOSABLE_MAIL_PROVIDERS, ...extra]);
}

/** Whether `name` is a listed provider or a subdomain of one. */
export function isDisposableMailHost(name: string, providers: ReadonlySet<string>): boolean {
  const host = hostName(name);
  if (!host) return false;
  const labels = host.split(".");
  for (let index = 0; index < labels.length - 1; index += 1) {
    if (providers.has(labels.slice(index).join("."))) return true;
  }
  return false;
}

export type MxResolver = (domain: string) => Promise<readonly { exchange: string }[]>;

const MX_CACHE_TTL_MS = 60 * 60 * 1000;
const MX_CACHE_MAX = 5_000;
// Answered lookups only: a timeout or a DNS failure is retried next time.
const mxCache = new Map<string, { hosts: string[]; expiresAt: number }>();

/** Test seam: forget cached MX answers. */
export function resetSignupMailMxCache(): void {
  mxCache.clear();
}

async function mailExchangers(
  domain: string,
  timeoutMs: number,
  resolver: MxResolver,
  now: number,
): Promise<string[] | null> {
  const cached = mxCache.get(domain);
  if (cached && cached.expiresAt > now) return cached.hosts;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const records = await Promise.race([
      resolver(domain),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
    if (records === null) return null;
    const hosts = records.map((record) => record.exchange.toLowerCase());
    if (mxCache.size >= MX_CACHE_MAX) {
      const oldest = mxCache.keys().next().value;
      if (oldest !== undefined) mxCache.delete(oldest);
    }
    mxCache.set(domain, { hosts, expiresAt: now + MX_CACHE_TTL_MS });
    return hosts;
  } catch (error) {
    // No MX record (NODATA/ENOTFOUND) is an answer too: nothing to match.
    const code = (error as { code?: unknown } | null)?.code;
    if (code === "ENODATA" || code === "ENOTFOUND") {
      mxCache.set(domain, { hosts: [], expiresAt: now + MX_CACHE_TTL_MS });
      return [];
    }
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Whether the owner's mail address is a disposable inbox: its domain, or one
 * of the domain's MX hosts, is a listed temporary-inbox service. `clear` when
 * neither is; null when the address has no domain, or the MX lookup is off,
 * slow or failed and the domain alone is not listed (fail open: nothing is
 * recorded). Never throws.
 */
export async function signupMailSignal(
  email: string | null | undefined,
  settings: Pick<Settings, "signupDisposableMailDomains" | "signupMailMxLookupTimeoutMs">,
  resolver: MxResolver = resolveMx,
): Promise<SignupMailSignal | null> {
  try {
    const at = (email ?? "").lastIndexOf("@");
    const domain = at < 0 ? null : hostName((email ?? "").slice(at + 1));
    if (!domain) return null;
    const providers = disposableMailProviders(settings);
    if (isDisposableMailHost(domain, providers)) return "disposable";
    if (settings.signupMailMxLookupTimeoutMs <= 0) return null;
    const hosts = await mailExchangers(
      domain,
      settings.signupMailMxLookupTimeoutMs,
      resolver,
      Date.now(),
    );
    if (hosts === null) return null;
    return hosts.some((host) => isDisposableMailHost(host, providers)) ? "disposable" : "clear";
  } catch {
    return null;
  }
}
