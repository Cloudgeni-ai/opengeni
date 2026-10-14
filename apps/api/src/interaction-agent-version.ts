/**
 * Saved-secret typing needs a controller that understands the private
 * `secretValues` side map. Server-managed controllers always do; a Connected
 * Machine or attached browser runs whatever agent its owner installed, and an
 * agent built before the field existed rejects the whole command as malformed.
 * Refuse before anything is resolved or dispatched, and say how to fix it.
 */
import type { AccessGrant, InteractionPlacement } from "@opengeni/contracts";
import {
  type Database,
  getAttachedBrowserDevice,
  getLiveEnrollmentConnection,
  getSandbox,
} from "@opengeni/db";
import { ApiHttpError } from "./http/api-error";
import { compareAgentVersions } from "./sandbox/machines";

/** The first agent release whose controller accepts `secretValues`. */
export const MINIMUM_AGENT_VERSION_FOR_SECRET_VALUES = "0.1.56";

/** True only when the installed version is known and predates secret values.
 * An unknown or unparsable version is not refused on a guess. */
export function agentVersionRejectsSecretValues(agentVersion: string | null): boolean {
  if (!agentVersion) return false;
  const order = compareAgentVersions(agentVersion, MINIMUM_AGENT_VERSION_FOR_SECRET_VALUES);
  return order !== null && order < 0;
}

export function agentUpdateRequiredForSecretsError(agentVersion: string): ApiHttpError {
  return new ApiHttpError(422, {
    code: "validation_failed",
    message:
      `This machine runs Opengeni agent ${agentVersion}, which cannot type saved secrets. ` +
      `Update the machine's agent to ${MINIMUM_AGENT_VERSION_FOR_SECRET_VALUES} or newer ` +
      `(Machines, Update now), then retry. Nothing was typed.`,
    retryable: false,
    outcomeUnknown: false,
    details: {
      reason: "agent_update_required",
      agentVersion,
      minimumAgentVersion: MINIMUM_AGENT_VERSION_FOR_SECRET_VALUES,
    },
  });
}

/** The installed agent version behind a device placement; null for
 * server-managed placements or when the machine is not live. */
export async function placementAgentVersion(
  db: Database,
  grant: AccessGrant,
  workspaceId: string,
  placement: InteractionPlacement | null,
): Promise<string | null> {
  if (placement?.kind === "connected_machine") {
    const sandbox = await getSandbox(db, grant, placement.sandboxId);
    if (sandbox?.kind !== "selfhosted" || !sandbox.enrollmentId) return null;
    const enrollment = await getLiveEnrollmentConnection(db, grant, sandbox.enrollmentId);
    return enrollment?.agentVersion ?? null;
  }
  if (placement?.kind === "attached_device") {
    const device = await getAttachedBrowserDevice(db, {
      accountId: grant.accountId,
      workspaceId,
      deviceId: placement.deviceId,
    });
    const enrollment = await getLiveEnrollmentConnection(db, workspaceId, device.enrollmentId);
    return enrollment?.agentVersion ?? null;
  }
  return null;
}

/** A `beforeResolve` hook for `resolveInteractionSecretValues`. */
export function requirePlacementAcceptsSecretValues(
  db: Database,
  grant: AccessGrant,
  workspaceId: string,
  placement: InteractionPlacement | null,
): () => Promise<void> {
  return async () => {
    const agentVersion = await placementAgentVersion(db, grant, workspaceId, placement);
    if (agentVersion !== null && agentVersionRejectsSecretValues(agentVersion)) {
      throw agentUpdateRequiredForSecretsError(agentVersion);
    }
  };
}
