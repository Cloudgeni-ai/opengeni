import { HTTPException } from "hono/http-exception";
import { nestedPostgresMessage, nestedPostgresSqlState } from "@opengeni/db";
import { organizationMembershipHttpStatus } from "../domain/organization-membership-lifecycle";

/** The HTTP refusal of a keyed external-membership operation, shared by the
 * external-members endpoints and memberships stated on a request. */
export function rethrowExternalWorkspaceOperation(error: unknown): never {
  const status = organizationMembershipHttpStatus(nestedPostgresSqlState(error));
  if (status) {
    const summary =
      status === 409
        ? "External membership operation changed or was cancelled"
        : "External membership operation is not available";
    // Permission fences (42501) raise fixed reasons without row data: name the
    // one that refused so an integrator can act on it. Other states can carry
    // identifiers in their message, so they keep only the summary; the cause
    // stays attached for our logs.
    const reason = status === 403 ? nestedPostgresMessage(error) : null;
    throw new HTTPException(status, {
      message: reason ? `${summary}: ${reason}` : summary,
      cause: error,
    });
  }
  throw error;
}
