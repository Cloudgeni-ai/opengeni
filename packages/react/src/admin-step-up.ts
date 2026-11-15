import { PASSKEY_STEP_UP_HANDOFF_PATH } from "@opengeni/contracts/managed-sign-in-methods";

/**
 * An admin change the API refused until the person confirms it's them with a
 * passkey (`ADMIN_PASSKEY_STEP_UP_REQUIRED`).
 */
export type AdminStepUpRequest = Readonly<{
  /** False: the person has no passkey yet and has to add one first. */
  passkeyRegistered: boolean;
}>;

/**
 * Lets the person confirm it's them, the host's way. Resolves true once they
 * did, so the refused change is sent again at once; false when they cancelled
 * or went elsewhere to do it (the card then offers Try again).
 */
export type AdminStepUpHandler = (request: AdminStepUpRequest) => boolean | Promise<boolean>;

/** The Opengeni app's page where a person adds a passkey. */
export const ADMIN_PASSKEY_SETTINGS_PATH = "/settings/security";

/** The Opengeni app's page for a step-up: adding a passkey, or confirming with one. */
export function adminStepUpPagePath(request: AdminStepUpRequest): string {
  return request.passkeyRegistered ? PASSKEY_STEP_UP_HANDOFF_PATH : ADMIN_PASSKEY_SETTINGS_PATH;
}

/**
 * The default for a host that sets no handler: open the Opengeni app's page
 * for it (`open` resolves the path against the app), then let the person try
 * again here.
 */
export function openAdminStepUpPage(open: (path: string) => void): AdminStepUpHandler {
  return (request) => {
    open(adminStepUpPagePath(request));
    return false;
  };
}
