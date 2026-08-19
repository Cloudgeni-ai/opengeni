import type { ConnectionOwnership } from "@opengeni/contracts";
import type { AccessGrantAuthorization } from "@opengeni/core";
import { HTTPException } from "hono/http-exception";

/**
 * Who may own a *personal* Connection.
 *
 * Connection setup defaults to a workspace-owned Connection; personal ownership
 * is the explicit "Connect only for me" choice (AGENTS.md, "Connection
 * ownership and executable personal authority are separate from turn
 * initiation"). A personal Connection is only ever executable through the exact
 * immutable delegation snapshot frozen on a causal turn or scheduled task, and
 * `bind_connection_authority` (migration 0256) can only mint the `user`
 * authority scope for a subject that holds an active organization membership.
 *
 * Both facts mean the same thing: only a managed human can own one. A
 * non-human principal that reaches a personal-ownership path produces a row on
 * the `legacy_user` compatibility lane that no delegation snapshot can select -
 * an unusable Connection, or worse one that reads as a human's consent.
 *
 * `principalKind` is trusted provenance: the delegated-token contract forbids a
 * `human_session` claim from carrying serviceInitiator or exact agent-attempt
 * authority, managed cookie sessions and the local `dev` bootstrap resolve to
 * `human_session`, API keys resolve to `api_key`, and the shared configured key
 * resolves to `configured_key`. The subject-prefix check is belt-and-braces for
 * a trusted embedding host that signs a human claim over a machine subject.
 */
const NON_HUMAN_SUBJECT_PREFIXES = ["api_key:", "configured:"] as const;

/** True only for an exact authenticated managed human. Unknown provenance fails closed. */
export function isPersonalConnectionOwnerPrincipal(access: AccessGrantAuthorization): boolean {
  const { grant } = access;
  return (
    access.authenticatedSubjectId === grant.subjectId &&
    grant.principalKind === "human_session" &&
    !grant.serviceInitiator &&
    !grant.serviceInitiatorContext &&
    isPersonalConnectionOwnerSubject(grant.subjectId)
  );
}

/**
 * The subject-shape half of the rule, for a path that has only a signed-state
 * subject id and no live principal (an OAuth callback). A state minted before
 * this fence existed is at most one `oauthStateTtlMs` window old, but it must
 * still not land a machine-owned personal Connection.
 */
export function isPersonalConnectionOwnerSubject(subjectId: string): boolean {
  return !NON_HUMAN_SUBJECT_PREFIXES.some((prefix) => subjectId.startsWith(prefix));
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
