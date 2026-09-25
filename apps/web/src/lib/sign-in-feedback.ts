/** Callback query strings are untrusted hints, never evidence of a linked account. */
export function signInCallbackError(code: string | null | undefined): string | null {
  if (!code) return null;
  switch (code.toLowerCase()) {
    case "access_denied":
    case "user_cancelled":
      return "Sign-in was cancelled. No account connection has been confirmed. Please try again when you're ready.";
    case "email_not_verified":
    case "email_verification_required":
      return "Verify your email before using this sign-in method. Use your existing sign-in method to access your account.";
    case "account_not_linked":
    case "account_linking_disabled":
      return "This sign-in method isn't connected. Sign in with an existing method, then connect it in Personal settings → Security.";
    case "account_already_linked":
    case "identity_conflict":
      return "This provider account is already connected to another OpenGeni account. Use a different provider account; accounts are not merged.";
    case "token_expired":
    case "invalid_token":
      return "This email verification link has expired or is no longer valid. Request a new verification email to finish setting up your account.";
    case "state_mismatch":
    case "state_not_found":
    case "invalid_state":
    case "session_expired":
      return "This sign-in request expired or no longer matches this browser. Start sign-in again from OpenGeni.";
    default:
      return "Sign-in couldn't be completed. Try again, or use an existing sign-in method. No account connection has been confirmed.";
  }
}

export type SignInChangeFeedback = {
  userId: string;
  email: string;
  message: string;
  expiresAt: number;
};
const feedbackKey = "opengeni:sign-in-change-feedback";
export const signInFeedbackEvent = "opengeni:sign-in-change-feedback";

/** Non-secret UI receipt, never an authorization or a reason to replay a mutation. */
export function retainSignInChangeFeedback(
  feedback: Omit<SignInChangeFeedback, "expiresAt">,
): void {
  try {
    sessionStorage.setItem(
      feedbackKey,
      JSON.stringify({ ...feedback, expiresAt: Date.now() + 15 * 60_000 }),
    );
  } catch {
    /* In-memory UI still shows the result. */
  }
  window.dispatchEvent(new Event(signInFeedbackEvent));
}
export function readSignInChangeFeedback(): SignInChangeFeedback | null {
  try {
    const value = JSON.parse(
      sessionStorage.getItem(feedbackKey) ?? "null",
    ) as SignInChangeFeedback | null;
    return value &&
      typeof value.userId === "string" &&
      typeof value.email === "string" &&
      typeof value.message === "string" &&
      value.expiresAt > Date.now()
      ? value
      : null;
  } catch {
    return null;
  }
}
export function clearSignInChangeFeedback(): void {
  try {
    sessionStorage.removeItem(feedbackKey);
  } catch {
    /* Optional UX storage. */
  }
  window.dispatchEvent(new Event(signInFeedbackEvent));
}

export function readSignInCallbackError(search: string): string | null {
  const params = new URLSearchParams(search);
  const errors = params.getAll("error");
  // Never render provider error descriptions or arbitrary callback text.
  return errors.length ? signInCallbackError(errors.length === 1 ? errors[0] : "unknown") : null;
}

/** Fixed local destination only; never carry a caller-supplied return URL or provider text. */
export function securityReauthenticationPath(search: string): string {
  const params = new URLSearchParams(search);
  const outcomes = params.getAll("signInMethod");
  const outcome = outcomes.length === 1 ? outcomes[0] : null;
  return outcome === "connected" || outcome === "error"
    ? `/settings/security?signInMethod=${outcome}`
    : "/settings/security";
}
