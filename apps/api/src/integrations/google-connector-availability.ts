import type { Settings } from "@opengeni/config";
import { HTTPException } from "hono/http-exception";

export const GOOGLE_CONNECTOR_SETUP_UNAVAILABLE =
  "New Gmail and Google Drive connections are temporarily unavailable while Google data-access verification is completed.";

/** Setup only. Existing grants, refresh, schedules and Google sign-in are independent. */
export function assertGoogleConnectorSetupEnabled(settings: Settings): void {
  if (!settings.googleConnectorSetupEnabled) {
    throw new HTTPException(503, { message: GOOGLE_CONNECTOR_SETUP_UNAVAILABLE });
  }
}
