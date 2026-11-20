/**
 * How long ago a subscription account was signed in, and whether its sign-in
 * is close to the age at which its provider stops accepting it.
 *
 * Claude has refused sign-ins about 28 to 30 days after they were made (the
 * stored refresh no longer renews them), so its accounts warn from day 25.
 * ChatGPT and SuperGrok sign-ins have no observed limit; they show the age only.
 */
export const CLAUDE_SIGN_IN_WARNING_DAYS = 25;

const DAY_MS = 86_400_000;

export type SignInAge = {
  /** Whole days since the sign-in. */
  days: number;
  /** "Signed in today", "Signed in yesterday" or "Signed in 18 days ago". */
  text: string;
  /** The provider is expected to stop accepting it soon. */
  nearingExpiry: boolean;
};

export function subscriptionSignInAge(
  provider: "claude_subscription" | "supergrok" | "codex",
  signedInAt: string | null | undefined,
  now: number = Date.now(),
): SignInAge | null {
  const at = signedInAt ? Date.parse(signedInAt) : Number.NaN;
  if (!Number.isFinite(at)) return null;
  const days = Math.max(0, Math.floor((now - at) / DAY_MS));
  return {
    days,
    text:
      days === 0
        ? "Signed in today"
        : days === 1
          ? "Signed in yesterday"
          : `Signed in ${days} days ago`,
    nearingExpiry: provider === "claude_subscription" && days >= CLAUDE_SIGN_IN_WARNING_DAYS,
  };
}
