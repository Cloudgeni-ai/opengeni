/**
 * Heedeo signup scoring in the browser (docs/signup-abuse-protection.md,
 * "Heedeo shadow scoring"). The sign-in and sign-up pages load Heedeo's script
 * when the client config offers it; each signup path asks it for a one-time
 * token just before it submits. Nothing here ever blocks or fails a sign-in or
 * sign-up: a missing script, a rejection or a slow answer submits no token.
 */

type HeedeoAgent = { identify(): Promise<{ token?: unknown }> };

export type HeedeoClientConfig = { publishableKey: string; scriptUrl: string };

/** Heedeo's identify() rejects within 3 seconds; a signup waits at most this long. */
export const HEEDEO_TOKEN_WAIT_MS = 1_800;

let configured: HeedeoClientConfig | null = null;
let script: HTMLScriptElement | null = null;
/** The script ran; without `window.heedeo` then (a blocker's stub), no token comes. */
let loaded = false;

function heedeoScriptSource(config: HeedeoClientConfig): string | null {
  try {
    const url = new URL(config.scriptUrl);
    if (url.protocol !== "https:" && url.hostname !== "localhost") return null;
    url.searchParams.set("key", config.publishableKey);
    return url.toString();
  } catch {
    return null;
  }
}

/** Loads Heedeo's script once, async, when the config offers it. */
export function preloadHeedeo(config: HeedeoClientConfig | null | undefined): void {
  if (!config?.publishableKey || typeof document === "undefined") return;
  const source = heedeoScriptSource(config);
  if (!source) return;
  configured = config;
  if (script) return;
  script = document.createElement("script");
  script.src = source;
  script.async = true;
  script.onload = () => {
    loaded = true;
  };
  script.onerror = () => {
    // Blocked or offline: signups go on at once without a token; a later
    // page load tries again.
    script?.remove();
    script = null;
    configured = null;
  };
  document.head.append(script);
}

const scriptLoaded = () => loaded;

function agent(): HeedeoAgent | undefined {
  const candidate = (window as unknown as { heedeo?: unknown }).heedeo;
  return candidate && typeof (candidate as HeedeoAgent).identify === "function"
    ? (candidate as HeedeoAgent)
    : undefined;
}

/**
 * A fresh single-use Heedeo token for one signup attempt, or undefined. Waits
 * for the async script and identify() together for at most `waitMs`; never
 * throws.
 */
export async function heedeoSignupToken(
  waitMs: number = HEEDEO_TOKEN_WAIT_MS,
): Promise<string | undefined> {
  if (!configured || typeof window === "undefined") return undefined;
  const deadline = Date.now() + waitMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), waitMs);
  });
  const identify = (async () => {
    let heedeo = agent();
    // `loaded` changes in the script's onload while this waits.
    while (!heedeo && !scriptLoaded() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      heedeo = agent();
    }
    if (!heedeo) return undefined;
    const result = await heedeo.identify();
    return typeof result?.token === "string" && result.token.length <= 4096
      ? result.token
      : undefined;
  })().catch(() => undefined);
  try {
    return await Promise.race([identify, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Tests only. */
export function resetHeedeoForTests(): void {
  configured = null;
  loaded = false;
  script?.remove();
  script = null;
}
