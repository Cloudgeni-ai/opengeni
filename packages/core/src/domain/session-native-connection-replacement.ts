import type { ConnectionMetadata, McpServerConnectionRef } from "@opengeni/contracts";
import { connectionMetadataMatchesBinding } from "@opengeni/db/session-mcp-credential-rotation";

/** Selection is restricted to the caller's already-authorized inventory. This
 * projection grants no execution authority: subsequent admission and physical
 * credential use still validate the exact native account normally. */
export function nativeSessionConnectionReplacement(input: {
  accountId: string;
  workspaceId: string;
  subjectId: string | null;
  serverUrl: string;
  replacementServerUrl?: string;
  currentRef: McpServerConnectionRef | null;
  nativeConnectionId: string;
  connections: ConnectionMetadata[];
}): McpServerConnectionRef {
  const connection = input.connections.find(
    (candidate) => candidate.id === input.nativeConnectionId,
  );
  if (
    !connection ||
    connection.accountId !== input.accountId ||
    connection.status !== "active" ||
    (connection.subjectId === null
      ? connection.workspaceId !== input.workspaceId
      : !input.subjectId || connection.subjectId !== input.subjectId || !connection.authorityId)
  ) {
    throw new Error("native connection unavailable");
  }
  const {
    authoritySource: _authoritySource,
    hostBinding: _hostBinding,
    accountSelection: _accountSelection,
    ...retained
  } = input.currentRef ?? {};
  // Preserve provider, resource, scope and selected-resource restrictions.
  // Retired host identity is never interpreted as a native connection ID.
  if (
    input.currentRef &&
    input.currentRef.providerDomain.toLowerCase() !== connection.providerDomain.toLowerCase()
  )
    throw new Error("native connection provider mismatch");
  const ref: McpServerConnectionRef = {
    ...retained,
    ...(!input.currentRef?.resource && typeof connection.metadata.resource === "string"
      ? { resource: connection.metadata.resource }
      : {}),
    connectionId: connection.id,
    providerDomain: connection.providerDomain,
    kind: connection.kind,
    subjectScope: connection.subjectId === null ? "workspace" : "subject",
  };
  const destination = input.replacementServerUrl ?? input.serverUrl;
  // A redirect must be explicitly requested and bound in the account metadata;
  // the broker's legacy provider-host fallback is insufficient for rebinding.
  if (
    input.replacementServerUrl &&
    (typeof connection.metadata.mcpUrl !== "string" || !connection.metadata.mcpUrl.trim())
  )
    throw new Error("native connection destination unavailable");
  if (!connectionMetadataMatchesBinding(connection, ref, destination))
    throw new Error("native connection binding mismatch");
  return ref;
}
