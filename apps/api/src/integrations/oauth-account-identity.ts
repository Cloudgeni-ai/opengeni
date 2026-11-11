import type { ConnectionMetadata } from "@opengeni/contracts";
import {
  accountIdentityKeysFor,
  accountMcpUrlGroup,
  builtInOAuthProfileFor,
} from "./oauth-profiles";

export type AccountFailure =
  | "account_mismatch"
  | "account_already_connected"
  | "account_identity_unavailable"
  | "account_limit_one"
  | "account_reconnect_required";

export const ACCOUNT_FAILURES: readonly AccountFailure[] = [
  "account_mismatch",
  "account_already_connected",
  "account_identity_unavailable",
  "account_limit_one",
  "account_reconnect_required",
];

export function oauthAccountFailureMessage(reason: AccountFailure): string {
  switch (reason) {
    case "account_mismatch":
      return "Sign in to the same account to reconnect. Use Add account for a different account.";
    case "account_already_connected":
      return "This account is already connected. Reconnect the existing account in connection settings.";
    case "account_identity_unavailable":
      return "We couldn't confirm which account this is, so another connection can't be added safely. Reconnect the existing connection in settings, then try again.";
    case "account_limit_one":
      return "This service doesn't tell us which account you signed in with, so you can connect one account. Disconnect it to use a different one.";
    case "account_reconnect_required":
      return "Reconnect your existing account once, then add another.";
  }
}

/** Identity fields are declared by a trusted verification adapter. Neither
 * presentation labels, unverified JWTs nor undeclared token fields are identity
 * proof. A tenant-scoped identity must include its tenant in the tuple. */
function verifiedIdentity(metadata: Record<string, unknown>, keys: readonly string[] | undefined) {
  if (!keys?.length) return null;
  const values = keys.map((key) => metadata[key]);
  return values.every((value) => typeof value === "string" && value.length > 0)
    ? JSON.stringify(values)
    : null;
}

/** Same accounts behind the URL (see accountMcpUrlGroup). */
function sameResource(connection: ConnectionMetadata, mcpUrl: string): boolean {
  const url = connection.metadata.mcpUrl;
  return typeof url === "string" && accountMcpUrlGroup(url) === accountMcpUrlGroup(mcpUrl);
}

/** Call under the shared owner/resource transaction lock. Unknown identity is
 * not evidence of equality OR inequality: it cannot justify another account or
 * silently replacing an existing credential. This rule applies to every MCP.
 *
 * Without a verified identity, each person sees at most one connection to the
 * resource: a second one in the same owner bucket is refused, and so is a
 * personal one while a shared one exists, or a shared one while the requester
 * has a personal one. Other people's personal connections are invisible to the
 * requester, so they never block. Reconnecting an existing connection is
 * unaffected. */
export function decideOAuthAccountConnection(input: {
  accounts: readonly ConnectionMetadata[];
  ownerSubjectId: string | null;
  /** Who is connecting; defaults to the owner. Matters for a shared connection. */
  requesterSubjectId?: string | null | undefined;
  providerDomain: string;
  mcpUrl: string;
  metadata: Record<string, unknown>;
  grantedScopes: readonly string[];
  /** Absent when the service cannot identify accounts at all. */
  identityKeys?: readonly string[] | undefined;
  requestedConnectionId?: string | undefined;
}):
  | { kind: "write" }
  | { kind: "reuse"; connection: ConnectionMetadata }
  | { kind: "reject"; reason: AccountFailure } {
  const matching = input.accounts.filter(
    (connection) =>
      connection.subjectId === input.ownerSubjectId &&
      connection.kind === "oauth2" &&
      sameResource(connection, input.mcpUrl),
  );
  const identity = verifiedIdentity(input.metadata, input.identityKeys);
  const sameIssuer = (connection: ConnectionMetadata) =>
    connection.providerDomain === input.providerDomain &&
    connection.metadata.authorizationServerIssuer === input.metadata.authorizationServerIssuer &&
    connection.metadata.clientId === input.metadata.clientId;
  if (input.requestedConnectionId) {
    const requested = matching.find((connection) => connection.id === input.requestedConnectionId);
    if (!requested) return { kind: "reject", reason: "account_mismatch" };
    const expected = verifiedIdentity(requested.metadata, input.identityKeys);
    // A failed identity read is not evidence of a different account.
    if (expected && !identity) return { kind: "reject", reason: "account_identity_unavailable" };
    if (expected && (!sameIssuer(requested) || expected !== identity)) {
      return { kind: "reject", reason: "account_mismatch" };
    }
    if (
      requested.status === "revoked" &&
      matching.some(
        (connection) =>
          connection.id !== requested.id &&
          connection.status !== "revoked" &&
          (!identity ||
            !sameIssuer(connection) ||
            !verifiedIdentity(connection.metadata, input.identityKeys) ||
            verifiedIdentity(connection.metadata, input.identityKeys) === identity),
      )
    )
      return { kind: "reject", reason: "account_already_connected" };
    if (
      !expected &&
      identity &&
      matching.some(
        (connection) =>
          connection.id !== requested.id &&
          connection.status !== "revoked" &&
          sameIssuer(connection) &&
          verifiedIdentity(connection.metadata, input.identityKeys) === identity,
      )
    )
      return { kind: "reject", reason: "account_already_connected" };
    return { kind: "write" };
  }
  const live = matching.filter((connection) => connection.status !== "revoked");
  if (!identity) {
    // A service that can't identify accounts at all gets the one-account rule;
    // one whose identity read failed this time says so instead.
    const reason = input.identityKeys?.length
      ? "account_identity_unavailable"
      : "account_limit_one";
    if (live.length) return { kind: "reject", reason };
    const requester =
      input.requesterSubjectId === undefined ? input.ownerSubjectId : input.requesterSubjectId;
    const otherBucket = input.accounts.some(
      (connection) =>
        connection.kind === "oauth2" &&
        connection.status !== "revoked" &&
        sameResource(connection, input.mcpUrl) &&
        (input.ownerSubjectId === null
          ? requester !== null && connection.subjectId === requester
          : connection.subjectId === null),
    );
    return otherBucket ? { kind: "reject", reason } : { kind: "write" };
  }
  if (!live.length) return { kind: "write" };
  const sameAccount = live.filter(
    (connection) =>
      sameIssuer(connection) &&
      verifiedIdentity(connection.metadata, input.identityKeys) === identity,
  );
  // Legacy duplicate records remain intact: keep a deterministic existing ID,
  // never rewrite accepted session/schedule bindings or union approval policies.
  const active = sameAccount
    .filter(
      (connection) =>
        connection.status === "active" &&
        input.grantedScopes.every((scope) => connection.grantedScopes.includes(scope)),
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  if (active[0]) return { kind: "reuse", connection: active[0] };
  if (sameAccount.length) return { kind: "reject", reason: "account_already_connected" };
  // A connection made before its account could be identified must be signed in
  // again once; until then it cannot be told apart from the new account.
  if (
    live.some(
      (connection) =>
        !sameIssuer(connection) || !verifiedIdentity(connection.metadata, input.identityKeys),
    )
  ) {
    return { kind: "reject", reason: "account_reconnect_required" };
  }
  return { kind: "write" };
}

/**
 * Whether a connected account can be told apart from another of its service,
 * for the connect affordances: "verified" (its account is known), "reconnect"
 * (the service identifies accounts, but this one was connected before that or
 * its check failed: sign in again once), or "single" (the service doesn't say
 * which account it is, so each person gets one). Undefined for connections
 * that are not OAuth MCP accounts.
 */
export function connectionAccountIdentityState(
  connection: Pick<ConnectionMetadata, "kind" | "providerDomain" | "metadata">,
): "verified" | "reconnect" | "single" | undefined {
  const mcpUrl = connection.metadata.mcpUrl;
  if (connection.kind !== "oauth2" || typeof mcpUrl !== "string" || !mcpUrl) return undefined;
  const keys = accountIdentityKeysFor(
    builtInOAuthProfileFor({ mcpUrl, providerDomain: connection.providerDomain }),
    mcpUrl,
    connection.metadata.accountIdentityMethod === "oidc",
  );
  if (!keys?.length) return "single";
  return verifiedIdentity(connection.metadata, keys) ? "verified" : "reconnect";
}

/** Connections as listed to people: each OAuth MCP account says whether it can
 * be told apart from another (see connectionAccountIdentityState). */
export function withAccountIdentityState<T extends ConnectionMetadata>(
  connections: readonly T[],
): T[] {
  return connections.map((connection) => {
    const accountIdentity = connectionAccountIdentityState(connection);
    return accountIdentity ? { ...connection, accountIdentity } : connection;
  });
}
