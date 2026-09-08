import type { AccessGrant } from "@opengeni/contracts";
import { HTTPException } from "hono/http-exception";
import { externalAttributionForAuthorization, type AccessGrantAuthorization } from "../access";

export const EXTERNAL_CREATION_ATTRIBUTION_KEY = "opengeniExternalCreationAttribution";

/** Retained alongside session.created metadata; this is not a live permission
 * snapshot and must never authorize a follow-up, child, or scheduled turn. */
export function externalCreationMetadata(
  metadata: Record<string, unknown> | undefined,
  authorization: AccessGrantAuthorization | undefined,
  grant: AccessGrant,
): Record<string, unknown> | undefined {
  if (metadata && Object.hasOwn(metadata, EXTERNAL_CREATION_ATTRIBUTION_KEY)) {
    throw new HTTPException(422, {
      message: `${EXTERNAL_CREATION_ATTRIBUTION_KEY} is server-owned`,
    });
  }
  const attribution = externalAttributionForAuthorization(authorization, grant);
  if (!attribution) return metadata;
  return { ...metadata, [EXTERNAL_CREATION_ATTRIBUTION_KEY]: attribution };
}
