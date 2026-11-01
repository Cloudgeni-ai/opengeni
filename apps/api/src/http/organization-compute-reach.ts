// Where an organization machine or rig works: the shared parts of
// PUT .../machines/:enrollmentId/reach and PUT .../rigs/:rigId/reach.

import type { OrganizationComputeReachResponse } from "@opengeni/contracts";
import type { OrganizationComputeReachUpdate } from "@opengeni/db";
import { grantHasAgentAttemptAuthority } from "@opengeni/core";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { ApiHttpError } from "./api-error";
import { requireFullAccessIfAgent } from "./acting-person";

/**
 * Where something works decides who else can use it, so a person decides it:
 * in the app, through the API, or through an agent with their full access. An
 * agent acting as itself, or with less than the person's access, is refused.
 */
export function requireComputeReachCaller(
  c: Context,
  grant: Parameters<typeof grantHasAgentAttemptAuthority>[0],
  what: "machine" | "sandbox environment",
): void {
  if (grantHasAgentAttemptAuthority(grant)) {
    throw new HTTPException(403, {
      message: `only a person, or an agent they gave admin access acting as them, can change where an organization ${what} works`,
    });
  }
  requireFullAccessIfAgent(c, `Changing where an organization ${what} works`);
}

/** The organization's own resources only: anything else has its owner's reach. */
export function requireOrganizationCompute(
  scope: "organization" | "workspace" | "user",
  what: "machine" | "sandbox environment",
): void {
  if (scope === "organization") return;
  throw new HTTPException(409, {
    message:
      scope === "workspace"
        ? `this ${what} belongs to its workspace and works only there; only an organization ${what} works in chosen workspaces`
        : `this ${what} is Only me and works wherever its owner uses it; only an organization ${what} works in chosen workspaces`,
  });
}

export function organizationComputeReachResponse(
  result: OrganizationComputeReachUpdate,
  what: "machine" | "sandbox environment",
): OrganizationComputeReachResponse {
  if (result.status === "updated") return { reach: result.reach };
  if (result.status === "not_found") {
    throw new HTTPException(404, { message: `${what} not found in this access scope` });
  }
  throw new ApiHttpError(400, {
    code: "validation_failed",
    message: "Some of these workspaces are not shared workspaces of this organization.",
    retryable: false,
    details: { workspaceIds: result.workspaceIds },
  });
}
