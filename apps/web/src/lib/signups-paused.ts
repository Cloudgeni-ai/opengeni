export {
  MANAGED_AUTH_NEW_SIGNUPS_PAUSED_CODE,
  MANAGED_AUTH_SIGN_IN_EMAIL_NOT_ALLOWED_CODE,
  MANAGED_AUTH_SIGNUP_EMAIL_NOT_ALLOWED_CODE,
} from "@opengeni/contracts";

/** Shown wherever new account creation is refused while sign-ups are paused. */
export const SIGNUPS_PAUSED_MESSAGE =
  "We're at capacity for new accounts right now. Please try again later.";

/**
 * Shown wherever a deployment that only lets listed email addresses sign up
 * refuses an address that isn't on its list. Trying again can't help and a
 * team invitation doesn't add an address to the list, so it says the one step
 * that does: ask whoever runs the service to allow the address.
 */
export const SIGNUP_EMAIL_NOT_ALLOWED_MESSAGE =
  "Only approved email addresses can create an account here. Ask whoever runs this service to allow your email address, then sign up again.";

/**
 * Shown when the same kind of deployment refuses to sign in an address that
 * isn't on its list. It names the one step that helps; a team invitation
 * doesn't add the address, and it says nothing about the password.
 */
export const SIGN_IN_EMAIL_NOT_ALLOWED_MESSAGE =
  "This email address can't sign in here. Ask whoever runs this service to allow it.";
