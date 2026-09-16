import {
  type AccessGrantAuthorization,
  SessionAuthorizationDeniedError,
  SessionAuthorizationUnavailableError,
  SessionTenancyManagedHumanRequiredError,
} from "@opengeni/core";
import { nestedPostgresSqlState, SessionTenancyNotActivatedError } from "@opengeni/db";
import type { UserResourceAuthoritySummary } from "@opengeni/db";
import {
  IssueConnectionUseGrantRequest,
  ListConnectionAuthoritiesResponse,
  type IssueConnectionUseGrantRequest as IssueConnectionUseGrantRequestValue,
} from "@opengeni/contracts/connection-authority";
import { HTTPException } from "hono/http-exception";

export function connectionAuthorityLifecycleError(error: unknown): never {
  if (
    error instanceof SessionAuthorizationDeniedError ||
    error instanceof SessionTenancyManagedHumanRequiredError ||
    error instanceof SessionTenancyNotActivatedError ||
    nestedPostgresSqlState(error) === "42501"
  )
    throw new HTTPException(403, { message: "connection authority denied" });
  if (error instanceof SessionAuthorizationUnavailableError)
    throw new HTTPException(503, { message: "session authorization unavailable" });
  if (nestedPostgresSqlState(error) === "22023")
    throw new HTTPException(422, { message: "invalid connection authority" });
  throw error;
}

/**
 * Personal connection authority is available only to the exact authenticated
 * human. API keys, delegated bearers, services, and agent attempts cannot name
 * or substitute a personal owner.
 */
export function requireConnectionAuthorityOwner(access: AccessGrantAuthorization): string {
  if (
    !access.contextIntegrity ||
    access.authenticatedSubjectId !== access.grant.subjectId ||
    access.grant.principalKind !== "human_session" ||
    access.grant.serviceInitiator ||
    access.grant.serviceInitiatorContext ||
    access.grant.subjectId.startsWith("api_key:")
  ) {
    throw new HTTPException(403, { message: "authenticated connection owner required" });
  }
  return access.grant.subjectId;
}

/** Removes generic resource kind and refuses non-connection grant actions. */
export function projectSelfConnectionAuthorities(page: {
  authorities: UserResourceAuthoritySummary[];
  nextCursor: string | null;
}) {
  return ListConnectionAuthoritiesResponse.parse({
    scope: "user",
    authorities: page.authorities
      .filter((authority) => authority.resourceKind === "connection")
      .map(({ resourceKind: _resourceKind, ...authority }) => authority),
    nextCursor: page.nextCursor,
  });
}

/** The API owns the action; callers supply neither action nor owner identity. */
export function connectionUseGrantLifecycleInput(input: unknown): {
  action: "connection.use";
  mode: IssueConnectionUseGrantRequestValue["mode"];
  context: IssueConnectionUseGrantRequestValue["context"];
  sessionId: string | null;
  expectedAuthorityEpoch: number | null;
  workspaceSharedAcknowledged: boolean;
} {
  const request = IssueConnectionUseGrantRequest.parse(input);
  return {
    action: "connection.use",
    mode: request.mode,
    context: request.context,
    sessionId: request.sessionId ?? null,
    expectedAuthorityEpoch: request.expectedAuthorityEpoch ?? null,
    workspaceSharedAcknowledged: request.workspaceSharedAcknowledged,
  };
}
