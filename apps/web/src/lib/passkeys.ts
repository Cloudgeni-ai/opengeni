import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/browser";
import { desktopCapability, desktopPlatformFromUserAgent } from "@opengeni/react/app/lib/desktop";

/** Options for one WebAuthn ceremony and the single-use id that answers it. */
export type PasskeyCeremony = { challengeId: string; options: Record<string, unknown> };

/** Whether this browser can run a passkey ceremony at all. */
export function browserSupportsPasskeys(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.PublicKeyCredential === "function" &&
    typeof navigator.credentials?.get === "function"
  );
}

/**
 * Whether passkeys must be used in the person's own browser rather than here:
 * inside the Opengeni desktop app (any of its windows). Electron has no
 * WebAuthn UI on macOS or Linux, so a ceremony there never reaches the system
 * passkey sheet or a password manager and never settles.
 */
export function passkeysNeedBrowser(
  userAgent: string = typeof navigator === "undefined" ? "" : navigator.userAgent,
): boolean {
  return desktopPlatformFromUserAgent(userAgent) !== null;
}

/** Open a page of this server in the person's own browser (from the desktop app). */
export function openInBrowser(url: string): void {
  const bridge = desktopCapability("openExternal");
  if (bridge) {
    void bridge.openExternal(url).catch(() => window.open(url, "_blank", "noopener"));
    return;
  }
  // The desktop shell opens any window with a real address in the browser.
  window.open(url, "_blank", "noopener");
}

/** The browser's passkey prompt never opened or never answered. */
export class PasskeyPromptUnavailableError extends Error {
  readonly code = "PASSKEY_PROMPT_UNAVAILABLE";
  constructor() {
    super("The passkey prompt didn't open");
    this.name = "PasskeyPromptUnavailableError";
  }
}

export function passkeyPromptUnavailable(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "PASSKEY_PROMPT_UNAVAILABLE";
}

const DEFAULT_CEREMONY_TIMEOUT_MS = 120_000;
const MAX_CEREMONY_TIMEOUT_MS = 300_000;
const DEADLINE_GRACE_MS = 15_000;

/** How long a ceremony may take before the page gives up on the browser: its own timeout and a little more. */
export function passkeyCeremonyDeadline(ceremony: PasskeyCeremony): number {
  const timeout = ceremony.options.timeout;
  const asked =
    typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0
      ? Math.min(timeout, MAX_CEREMONY_TIMEOUT_MS)
      : DEFAULT_CEREMONY_TIMEOUT_MS;
  return asked + DEADLINE_GRACE_MS;
}

/**
 * Run a ceremony, but never wait forever: a browser that never shows its
 * prompt (an embedded app window) is cancelled after the deadline and the
 * caller gets a PasskeyPromptUnavailableError to explain.
 */
export async function withPasskeyDeadline<T>(
  run: () => Promise<T>,
  deadlineMs: number,
  cancel: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      cancel();
      reject(new PasskeyPromptUnavailableError());
    }, deadlineMs);
  });
  try {
    return await Promise.race([run(), expired]);
  } finally {
    clearTimeout(timer);
  }
}

// The ceremony library loads only when someone actually uses a passkey.
export async function askForPasskey(
  ceremony: PasskeyCeremony,
  deadlineMs: number = passkeyCeremonyDeadline(ceremony),
): Promise<AuthenticationResponseJSON> {
  const { startAuthentication, WebAuthnAbortService } = await import("@simplewebauthn/browser");
  return await withPasskeyDeadline(
    () =>
      startAuthentication({
        optionsJSON: ceremony.options as unknown as PublicKeyCredentialRequestOptionsJSON,
      }),
    deadlineMs,
    () => WebAuthnAbortService.cancelCeremony(),
  );
}

export async function createPasskey(
  ceremony: PasskeyCeremony,
  deadlineMs: number = passkeyCeremonyDeadline(ceremony),
): Promise<RegistrationResponseJSON> {
  const { startRegistration, WebAuthnAbortService } = await import("@simplewebauthn/browser");
  return await withPasskeyDeadline(
    () =>
      startRegistration({
        optionsJSON: ceremony.options as unknown as PublicKeyCredentialCreationOptionsJSON,
      }),
    deadlineMs,
    () => WebAuthnAbortService.cancelCeremony(),
  );
}

function errorName(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const cause = (error as { cause?: unknown }).cause;
  return cause instanceof Error ? cause.name : error.name;
}

/** The person closed the browser's passkey prompt, or it timed out. */
export function passkeyPromptDismissed(error: unknown): boolean {
  const name = errorName(error);
  return (
    name === "NotAllowedError" ||
    name === "AbortError" ||
    (error as { code?: unknown } | null)?.code === "ERROR_CEREMONY_ABORTED"
  );
}

/** This authenticator already holds a passkey for the account. */
export function passkeyAlreadyRegistered(error: unknown): boolean {
  return (
    errorName(error) === "InvalidStateError" ||
    (error as { code?: unknown } | null)?.code === "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED"
  );
}
