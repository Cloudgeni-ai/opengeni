import type { ConnectionMetadata } from "@opengeni/contracts";

type AccountFailure =
  | "account_mismatch"
  | "account_already_connected"
  | "account_identity_unavailable";

export function oauthAccountFailureMessage(reason: AccountFailure): string {
  switch (reason) {
    case "account_mismatch":
      return "Sign in to the same account to reconnect. Use Add account for a different account.";
    case "account_already_connected":
      return "This account is already connected. Reconnect the existing account in connection settings.";
    case "account_identity_unavailable":
      return "This service does not provide enough account information to safely add another connection. Manage or reconnect the existing connection in settings.";
  }
}

/** Identity fields are declared by a trusted verification adapter. Neither
 * presentation labels, decoded JWTs nor arbitrary token fields are identity proof.
 * A tenant-scoped identity must include its tenant in the tuple. */
function verifiedIdentity(metadata: Record<string, unknown>, keys: readonly string[] | undefined) {
  if (!keys?.length) return null;
  const values = keys.map((key) => metadata[key]);
  return values.every((value) => typeof value === "string" && value.length > 0)
    ? JSON.stringify(values)
    : null;
}

/** Call under the shared owner/resource transaction lock. Unknown identity is
 * not evidence of equality OR inequality: it cannot justify another account or
 * silently replacing an existing credential. This rule applies to every MCP. */
export function decideOAuthAccountConnection(input: {
  accounts: readonly ConnectionMetadata[];
  ownerSubjectId: string | null;
  providerDomain: string;
  mcpUrl: string;
  metadata: Record<string, unknown>;
  grantedScopes: readonly string[];
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
      connection.metadata.mcpUrl === input.mcpUrl,
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
  if (!live.length) return { kind: "write" };
  if (!identity) return { kind: "reject", reason: "account_identity_unavailable" };
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
  if (
    live.some(
      (connection) =>
        !sameIssuer(connection) || !verifiedIdentity(connection.metadata, input.identityKeys),
    )
  ) {
    return { kind: "reject", reason: "account_identity_unavailable" };
  }
  return { kind: "write" };
}
