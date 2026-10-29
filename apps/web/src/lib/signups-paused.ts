export {
  MANAGED_AUTH_NEW_SIGNUPS_PAUSED_CODE,
  MANAGED_AUTH_SIGNUP_NOT_INVITED_CODE,
} from "@opengeni/contracts";

/** Shown wherever new account creation is refused while sign-ups are paused. */
export const SIGNUPS_PAUSED_MESSAGE =
  "We're at capacity for new accounts right now. Please try again later.";

/**
 * Shown wherever an invite-only deployment refuses to create an account for an
 * address it hasn't invited. Trying again can't help, so it says who to ask.
 */
export const SIGNUP_NOT_INVITED_MESSAGE =
  "New accounts here are by invitation only. Ask the person who runs this service, or someone who already uses it, to invite you. The invitation email has a link to set up your account.";
