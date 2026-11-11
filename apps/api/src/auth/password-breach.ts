import type { Settings } from "@opengeni/config";
import { APIError } from "better-auth/api";
import { isPasswordCompromised } from "better-auth/plugins/haveibeenpwned";

/**
 * Refuses a new password that appears in the Have I Been Pwned breached
 * password corpus (ADA CASA / OWASP ASVS 2.1.7), through Better Auth's
 * k-anonymity lookup: only the first five characters of the password's SHA-1
 * hash leave the API.
 *
 * On by default outside local development and tests;
 * `OPENGENI_MANAGED_AUTH_BREACHED_PASSWORD_CHECK` overrides it. A lookup that
 * fails or takes longer than
 * {@link MANAGED_AUTH_PASSWORD_BREACH_LOOKUP_TIMEOUT_MS} lets the password
 * through and reports it, so an unreachable lookup service never blocks
 * sign-up or a password change.
 */
export const MANAGED_AUTH_PASSWORD_COMPROMISED_CODE = "PASSWORD_COMPROMISED";
export const MANAGED_AUTH_PASSWORD_COMPROMISED_MESSAGE =
  "This password has appeared in a data breach. Choose a different password.";
export const MANAGED_AUTH_PASSWORD_BREACH_LOOKUP_TIMEOUT_MS = 5_000;

/** Better Auth endpoints that set a new password, and the body field holding it. */
export const MANAGED_AUTH_NEW_PASSWORD_FIELDS: Readonly<
  Record<string, "password" | "newPassword">
> = {
  "/sign-up/email": "password",
  "/reset-password": "newPassword",
};

export type PasswordBreachLookup = (password: string) => Promise<boolean>;

export function managedAuthBreachedPasswordCheckEnabled(
  settings: Pick<Settings, "environment" | "managedAuthBreachedPasswordCheck">,
): boolean {
  return (
    settings.managedAuthBreachedPasswordCheck ??
    (settings.environment !== "local" && settings.environment !== "test")
  );
}

export class ManagedAuthPasswordCompromisedError extends APIError {
  constructor() {
    super("BAD_REQUEST", {
      code: MANAGED_AUTH_PASSWORD_COMPROMISED_CODE,
      message: MANAGED_AUTH_PASSWORD_COMPROMISED_MESSAGE,
    });
  }
}

/**
 * Whether `password` is known to be breached. False when the check is off,
 * and when the lookup fails or times out (`onUnavailable` is told).
 */
export async function managedAuthPasswordBreached(
  password: string,
  options: {
    enabled: boolean;
    lookup?: PasswordBreachLookup;
    timeoutMs?: number;
    onUnavailable?: (reason: "error" | "timeout") => void;
  },
): Promise<boolean> {
  if (!options.enabled || !password) return false;
  const lookup = options.lookup ?? isPasswordCompromised;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(
      () => resolve("timeout"),
      options.timeoutMs ?? MANAGED_AUTH_PASSWORD_BREACH_LOOKUP_TIMEOUT_MS,
    );
  });
  try {
    const result = await Promise.race([lookup(password), timeout]);
    if (result === "timeout") {
      options.onUnavailable?.("timeout");
      return false;
    }
    return result;
  } catch {
    options.onUnavailable?.("error");
    return false;
  } finally {
    clearTimeout(timer);
  }
}
