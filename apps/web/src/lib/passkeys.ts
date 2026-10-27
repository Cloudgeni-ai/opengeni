import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/browser";

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

// The ceremony library loads only when someone actually uses a passkey.
export async function askForPasskey(
  ceremony: PasskeyCeremony,
): Promise<AuthenticationResponseJSON> {
  const { startAuthentication } = await import("@simplewebauthn/browser");
  return await startAuthentication({
    optionsJSON: ceremony.options as unknown as PublicKeyCredentialRequestOptionsJSON,
  });
}

export async function createPasskey(ceremony: PasskeyCeremony): Promise<RegistrationResponseJSON> {
  const { startRegistration } = await import("@simplewebauthn/browser");
  return await startRegistration({
    optionsJSON: ceremony.options as unknown as PublicKeyCredentialCreationOptionsJSON,
  });
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
