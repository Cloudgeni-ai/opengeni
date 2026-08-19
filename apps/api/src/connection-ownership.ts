import type { ConnectionOwnership } from "@opengeni/contracts";
import type { AccessGrantAuthorization } from "@opengeni/core";
import { HTTPException } from "hono/http-exception";

/**
 * Who may own a *personal* Connection.
 *
 * Connection setup defaults to a workspace-owned Connection; personal ownership
 * is the explicit "Connect only for me" choice (AGENTS.md, "Connection
 * ownership and executable personal authority are separate from turn
 * initiation"). Only a managed human can own one, for two independent reasons:
 * personal authority executes only through the immutable delegation snapshot
 * frozen on a *human's* causal turn or scheduled task, and
 * `bind_connection_authority` (migration 0256) can mint the `user` authority
 * scope only for a subject holding an active organization membership. A
 * machine-owned personal row therefore lands on the `legacy_user` compatibility
 * lane and can never become a real organization-scoped authority.
 *
 * `principalKind` is the trusted, allow-listed signal: exactly `human_session`
 * passes and every other value - including absent/unknown provenance - fails
 * closed. The delegated-token contract forbids a `human_session` claim from
 * carrying `serviceInitiator` or exact agent-attempt authority, so the claim
 * cannot be combined with machine authority.
 */

/**
 * Subject namespaces OpenGeni itself mints for machines. This is deliberately
 * NOT an allow-list of human subjects: `docs/embedding.md` states that
 * `subjectId` "remains opaque to OpenGeni" and that the kind must not be
 * inferred from a subject-id prefix "because the host owns that namespace", so
 * a trusted embedding host legitimately signs `human_session` over an opaque
 * subject that is not `user:`-prefixed. Restricting personal ownership to
 * `user:`/`dev` would break those hosts and would itself be the prefix-based
 * kind inference the embedding contract forbids.
 *
 * The allow-list that actually decides is `principalKind === "human_session"`.
 * This list is defence-in-depth against exactly one residual threat: a holder
 * of the first-party delegation secret signing a human claim over an
 * OpenGeni-minted machine subject. `connection-ownership.test.ts` enumerates
 * every machine subject OpenGeni mints and asserts each is rejected, so a new
 * machine namespace fails the test rather than silently passing this list.
 *
 * It is also no longer the sole signal on any OAuth callback: a callback that
 * persists a personal owner requires the HMAC-signed `personalOwnerVerified`
 * state claim minted by a start path that saw the live principal.
 */
const RESERVED_MACHINE_SUBJECT_NAMESPACES = ["api_key", "configured", "worker"] as const;

/** True only for an exact authenticated managed human. Unknown provenance fails closed. */
export function isPersonalConnectionOwnerPrincipal(access: AccessGrantAuthorization): boolean {
  const { grant } = access;
  return (
    // The anti-substitution invariant `requireConnectionAuthorityOwner` uses for
    // the same question: every context grant agrees on principal kind, delegated
    // flag and service flags, and the selected grant's account resolves to
    // exactly one matching account grant. Without it a grant whose account has
    // no matching account grant (a surviving membership row in an organization
    // where the membership is no longer active) could mint a personal
    // Connection that the sibling helper would refuse.
    access.contextIntegrity &&
    access.authenticatedSubjectId === grant.subjectId &&
    grant.principalKind === "human_session" &&
    !grant.serviceInitiator &&
    !grant.serviceInitiatorContext &&
    isPersonalConnectionOwnerSubject(grant.subjectId)
  );
}

/** Rejects an OpenGeni-minted machine subject; see the namespace list's rationale. */
export function isPersonalConnectionOwnerSubject(subjectId: string): boolean {
  const separator = subjectId.indexOf(":");
  if (separator < 0) {
    return true;
  }
  const namespace = subjectId.slice(0, separator);
  return !RESERVED_MACHINE_SUBJECT_NAMESPACES.some((reserved) => reserved === namespace);
}

export const PERSONAL_CONNECTION_PRINCIPAL_MESSAGE =
  "personal Connection ownership requires an authenticated human; API keys, configured keys, " +
  "services, and agent attempts can create only workspace-owned Connections";

/** Personal-only connectors cannot degrade to workspace ownership, so they say so exactly. */
export function personalOnlyConnectionPrincipalMessage(label: string): string {
  return (
    `${label} connects only as a personal Connection, which requires an authenticated human; ` +
    "API keys, configured keys, services, and agent attempts cannot own one"
  );
}

/**
 * Rejects a non-human principal before a personal Connection is created.
 * `label` names a personal-only connector, whose message must not suggest a
 * workspace-owned alternative that its provider profile forbids.
 *
 * This answers the same question as `requireConnectionAuthorityOwner` with the
 * same predicate but a different status: that helper guards a self-service
 * authority surface where the caller claims to *be* the owner (403 "not you"),
 * while this one rejects an ownership *value* that is unavailable to the
 * caller, alongside `assertOwnershipAllowed`'s existing 422 convention.
 */
export function assertPersonalConnectionOwnerPrincipal(
  access: AccessGrantAuthorization,
  label?: string,
): void {
  if (isPersonalConnectionOwnerPrincipal(access)) {
    return;
  }
  throw new HTTPException(422, {
    message: label
      ? personalOnlyConnectionPrincipalMessage(label)
      : PERSONAL_CONNECTION_PRINCIPAL_MESSAGE,
  });
}

/** The same fence expressed for a flow that resolves ownership after admission. */
export function assertConnectionOwnershipAllowedForPrincipal(
  ownership: ConnectionOwnership,
  personalOwnershipAllowed: boolean,
): void {
  if (ownership === "personal" && !personalOwnershipAllowed) {
    throw new HTTPException(422, { message: PERSONAL_CONNECTION_PRINCIPAL_MESSAGE });
  }
}

/**
 * The claim a start path mints into its HMAC-signed OAuth state when it has
 * verified the live principal may own a personal Connection.
 *
 * An OAuth callback carries signed state, not a live principal, so it cannot
 * re-evaluate `principalKind`. Requiring this claim makes the callback enforce
 * exactly what the start path decided with the full signal, instead of guessing
 * from the subject's shape. A state minted before this claim existed simply
 * lacks it and fails closed for personal ownership - which is precisely the
 * in-flight rolling-deploy window these fences exist to close.
 */
export const PERSONAL_OWNER_VERIFIED_STATE_CLAIM = "personalOwnerVerified" as const;

/** True only for an explicit boolean `true` claim; absent or malformed fails closed. */
export function personalOwnerVerifiedInState(payload: Record<string, unknown>): boolean {
  return payload[PERSONAL_OWNER_VERIFIED_STATE_CLAIM] === true;
}

/**
 * Callback-side fence for every path that persists a personal owner. Requires
 * both the signed start-time verification and a non-machine subject.
 */
export function personalOwnerStateAccepted(state: {
  ownership: ConnectionOwnership;
  subjectId: string;
  personalOwnerVerified: boolean;
}): boolean {
  if (state.ownership !== "personal") {
    return true;
  }
  return state.personalOwnerVerified && isPersonalConnectionOwnerSubject(state.subjectId);
}
