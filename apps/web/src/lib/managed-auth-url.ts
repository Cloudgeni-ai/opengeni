import type { ManagedAuthMode } from "./managed-auth-form";

/**
 * `?mode=signup` deep link (marketing "Get started" CTAs) opens the Sign up
 * tab. Anything else keeps the default Sign in tab.
 */
export function managedAuthModeFromSearch(search: string): ManagedAuthMode | undefined {
  const modes = new URLSearchParams(search).getAll("mode");
  return modes.length === 1 && modes[0]?.toLowerCase() === "signup" ? "signup" : undefined;
}

export type VerificationLinkError = "expired" | "invalid";

/**
 * Better Auth redirects a failed email-verification link back to the app with
 * `?error=TOKEN_EXPIRED` or `?error=INVALID_TOKEN`. Only those two exact codes
 * are recognized; any other callback text stays on the generic path.
 */
export function verificationLinkErrorFromSearch(search: string): VerificationLinkError | null {
  const errors = new URLSearchParams(search).getAll("error");
  if (errors.length !== 1) return null;
  const code = errors[0]!.toUpperCase();
  if (code === "TOKEN_EXPIRED") return "expired";
  if (code === "INVALID_TOKEN") return "invalid";
  return null;
}

/**
 * Drop a verification-link error the auth panel has taken over from the
 * address bar, so a reload shows ordinary sign-in instead of the resend form
 * again. Other parameters (such as attribution) and other errors are kept.
 */
export function clearVerificationLinkErrorFromLocation(
  target: Pick<Window, "location" | "history">,
): void {
  const url = new URL(target.location.href);
  if (!verificationLinkErrorFromSearch(url.search)) return;
  url.searchParams.delete("error");
  target.history.replaceState(target.history.state, "", url.pathname + url.search + url.hash);
}
