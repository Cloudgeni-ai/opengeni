import { createHash } from "node:crypto";
import type { McpServerConfig } from "@opengeni/config";
import {
  McpConnectionAccountBindings,
  type ConnectionMetadata,
  type McpConnectionAccountBinding,
  type McpConnectionAccountSelection,
  type McpPersonalConnectionDelegation,
} from "@opengeni/contracts";
import { ConnectionAccountSelectionError } from "./connection-account-selection-error";

/** Account routes are stable across retries, but are never parsed to discover
 * authority. The canonical server is retained separately in the binding. */
export function mcpAccountRouteId(serverId: string, connectionId: string): string {
  return `account-${createHash("sha256")
    .update(JSON.stringify([serverId, connectionId]))
    .digest("hex")}`;
}

function accountLabel(connection: ConnectionMetadata): string {
  const metadata = connection.metadata;
  const text = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim()
      ? value
          .replace(/[\u0000-\u001f\u007f]/gu, " ")
          .trim()
          .slice(0, 180)
      : undefined;
  const name = [metadata.email, metadata.displayName, metadata.accountName, metadata.name]
    .map(text)
    .find(Boolean);
  const workspace = [metadata.slackTeamName, metadata.teamName, metadata.workspaceName]
    .map(text)
    .find(Boolean);
  const scope = connection.subjectId === null ? "This workspace" : "Only me";
  return [...new Set([name, workspace, scope].filter(Boolean))].join(" · ");
}

function canonicalResource(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    url.pathname = url.pathname.replace(/\/+$/u, "") || "/";
    return url.toString();
  } catch {
    return value.trim();
  }
}

/** Pure admission projection over an already authorized inventory. Explicit
 * pairs narrow one connector; omission attaches all eligible accounts. */
export function mcpAccountBindingsFromVisibleConnections(input: {
  accountId: string;
  workspaceId: string;
  subjectId: string | null;
  servers: McpServerConfig[];
  connections: ConnectionMetadata[];
  selections?: McpConnectionAccountSelection[];
  /** The complete accepted set, including an explicitly empty set. */
  selectionsFrozen?: boolean;
}): McpConnectionAccountBinding[] {
  const remaining = new Set(
    (input.selections ?? []).map((selection) =>
      JSON.stringify([selection.serverId, selection.connectionId]),
    ),
  );
  const bindings: McpConnectionAccountBinding[] = [];
  for (const server of input.servers) {
    const ref = server.connectionRef;
    if (!ref || ref.authoritySource === "host") continue;
    // A selector becomes an exact reference at acceptance; do not persist a
    // selection directive beside the frozen connection UUID.
    const { accountSelection: _accountSelection, ...exactRef } = ref;
    const selections = (input.selections ?? []).filter(
      (selection) => selection.serverId === server.id,
    );
    const selectedIds = new Set(selections.map((selection) => selection.connectionId));
    for (const connection of input.connections) {
      if (
        connection.accountId !== input.accountId ||
        connection.status !== "active" ||
        connection.providerDomain.toLowerCase() !== ref.providerDomain.toLowerCase() ||
        (ref.kind && connection.kind !== ref.kind) ||
        (ref.connectionId !== undefined && ref.connectionId !== connection.id) ||
        (ref.resource &&
          (typeof connection.metadata.resource !== "string" ||
            canonicalResource(connection.metadata.resource) !== canonicalResource(ref.resource))) ||
        ((input.selectionsFrozen || selectedIds.size > 0) && !selectedIds.has(connection.id))
      )
        continue;
      const personal = connection.subjectId !== null;
      if (
        personal
          ? !input.subjectId || connection.subjectId !== input.subjectId || !connection.authorityId
          : connection.workspaceId !== input.workspaceId
      )
        continue;
      remaining.delete(JSON.stringify([server.id, connection.id]));
      bindings.push({
        serverId: mcpAccountRouteId(server.id, connection.id),
        canonicalServerId: server.id,
        connectionId: connection.id,
        originWorkspaceId: connection.workspaceId,
        subjectScope: personal ? "subject" : "workspace",
        ownerSubjectId: connection.subjectId,
        accountLabel: accountLabel(connection),
        providerDomain: connection.providerDomain,
        kind: connection.kind,
        connectionRef: {
          ...exactRef,
          connectionId: connection.id,
          providerDomain: connection.providerDomain,
          kind: connection.kind,
          subjectScope: personal ? "subject" : "workspace",
        },
        ...(connection.connectionAuthorityGeneration
          ? { connectionAuthorityGeneration: connection.connectionAuthorityGeneration }
          : {}),
      });
    }
  }
  if (remaining.size > 0) {
    throw new ConnectionAccountSelectionError(
      "An attached connector account is unavailable. Review its connection settings.",
    );
  }
  return McpConnectionAccountBindings.parse(
    bindings.sort((left, right) => left.serverId.localeCompare(right.serverId)),
  );
}

/** Workspace accounts never acquire a fabricated personal owner/delegation. */
export function personalDelegationsForAccountBindings(
  bindings: McpConnectionAccountBinding[],
): McpPersonalConnectionDelegation[] {
  return bindings.flatMap((binding) =>
    binding.subjectScope === "subject" && binding.ownerSubjectId
      ? [
          {
            serverId: binding.serverId,
            canonicalServerId: binding.canonicalServerId,
            connectionId: binding.connectionId,
            originWorkspaceId: binding.originWorkspaceId,
            ownerSubjectId: binding.ownerSubjectId,
            providerDomain: binding.providerDomain,
            kind: binding.kind,
            connectionType: "mcp" as const,
          },
        ]
      : [],
  );
}
