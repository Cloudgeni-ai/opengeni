import {
  connectionAccountLabel,
  distinctConnectionAccountLabels,
} from "@opengeni/contracts/connection-account-label";
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

// "Yours" is the person the agent acts for; "Shared" is everyone in the workspace.
function accountScope(connection: ConnectionMetadata): "Yours" | "Shared" {
  return connection.subjectId === null ? "Shared" : "Yours";
}

/** "Connected Oct 25" (and "Connected Oct 25 14:05 UTC"), in UTC so every
 * worker words the same account the same way. */
function connectedOn(createdAt: string, withTime: boolean): string | null {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return null;
  const day = date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return withTime ? `Connected ${day} ${date.toISOString().slice(11, 16)} UTC` : `Connected ${day}`;
}

/**
 * Each account's label among one connector's accounts: who it is (identity,
 * else the name its owner gave it, else "<domain> account"), made distinct by
 * when it was connected when two would read the same, then who can use it.
 * People see the same rule in account lists (`connectionAccountRows`).
 */
function accountLabels(connections: readonly ConnectionMetadata[]): Map<string, string> {
  const distinct = distinctConnectionAccountLabels(
    connections.map((connection) => ({
      id: connection.id,
      label: connectionAccountLabel(connection, `${connection.providerDomain} account`),
      scope: accountScope(connection),
      createdAt: connection.createdAt,
    })),
    connectedOn,
  );
  return new Map(
    connections.map((connection) => [
      connection.id,
      `${distinct.get(connection.id)!} · ${accountScope(connection)}`,
    ]),
  );
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

/** A picked account left out of a turn because it can no longer be used. */
export type OmittedMcpAccountSelection = McpConnectionAccountSelection & {
  reason: "account_inactive" | "account_not_visible";
};

type McpAccountBindingsInput = {
  accountId: string;
  workspaceId: string;
  subjectId: string | null;
  servers: McpServerConfig[];
  connections: ConnectionMetadata[];
  selections?: McpConnectionAccountSelection[];
};

/** Pure admission projection over an already authorized inventory. Explicit
 * pairs narrow one connector; omission attaches all eligible accounts. */
export function mcpAccountBindingsFromVisibleConnections(
  input: McpAccountBindingsInput,
): McpConnectionAccountBinding[] {
  return resolveMcpAccountBindings({ ...input, unusableSelections: "reject" }).bindings;
}

/**
 * `mcpAccountBindingsFromVisibleConnections`, but a picked account that has
 * stopped working (for example its sign-in expired) or is no longer visible
 * to the sender can be left out instead of refusing the whole request
 * (`unusableSelections: "omit"`). A left-out pick is never replaced: its
 * connector keeps only the sender's other usable picks, and with none it gets
 * no account at all, so the turn runs without it and says so. A pick that
 * names another connector's account still fails, since that is a malformed
 * request rather than an account that changed after it was shown.
 */
export function resolveMcpAccountBindings(
  input: McpAccountBindingsInput & { unusableSelections: "reject" | "omit" },
): { bindings: McpConnectionAccountBinding[]; omitted: OmittedMcpAccountSelection[] } {
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
    // Every account of this server the turn could use, whichever are chosen.
    const usable = input.connections.filter((connection) => {
      if (
        connection.accountId !== input.accountId ||
        connection.status !== "active" ||
        connection.providerDomain.toLowerCase() !== ref.providerDomain.toLowerCase() ||
        (ref.kind && connection.kind !== ref.kind) ||
        (ref.resource &&
          (typeof connection.metadata.resource !== "string" ||
            canonicalResource(connection.metadata.resource) !== canonicalResource(ref.resource)))
      )
        return false;
      return connection.subjectId !== null
        ? !!input.subjectId && connection.subjectId === input.subjectId && !!connection.authorityId
        : connection.workspaceId === input.workspaceId;
    });
    // Labelled among all of them, so an account reads the same whichever
    // accounts a turn attaches, and two that would read the same differ for
    // the agent as they do in the UI.
    const labels = accountLabels(usable);
    const eligible = usable.filter(
      (connection) =>
        (ref.connectionId === undefined || ref.connectionId === connection.id) &&
        (selectedIds.size === 0 || selectedIds.has(connection.id)),
    );
    for (const connection of eligible) {
      const personal = connection.subjectId !== null;
      remaining.delete(JSON.stringify([server.id, connection.id]));
      bindings.push({
        serverId: mcpAccountRouteId(server.id, connection.id),
        canonicalServerId: server.id,
        connectionId: connection.id,
        originWorkspaceId: connection.workspaceId,
        subjectScope: personal ? "subject" : "workspace",
        ownerSubjectId: connection.subjectId,
        accountLabel: labels.get(connection.id)!,
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
  const unavailable = (input.selections ?? [])
    .filter((selection) =>
      remaining.has(JSON.stringify([selection.serverId, selection.connectionId])),
    )
    .map((selection) => {
      const server = input.servers.find((candidate) => candidate.id === selection.serverId);
      // Only inspect the caller's already-authorized inventory. Never look
      // up an unavailable account globally merely to improve an error.
      const connection = input.connections.find(
        (candidate) => candidate.id === selection.connectionId,
      );
      return {
        serverId: selection.serverId,
        connectionId: selection.connectionId,
        reason:
          !server?.connectionRef || server.connectionRef.authoritySource === "host"
            ? ("connector_unavailable" as const)
            : !connection
              ? ("account_not_visible" as const)
              : connection.status !== "active"
                ? ("account_inactive" as const)
                : ("account_mismatch" as const),
      };
    });
  const omitted: OmittedMcpAccountSelection[] = [];
  const refused: typeof unavailable = [];
  for (const account of unavailable) {
    if (
      input.unusableSelections === "omit" &&
      (account.reason === "account_inactive" || account.reason === "account_not_visible")
    ) {
      omitted.push({ ...account, reason: account.reason });
    } else {
      refused.push(account);
    }
  }
  if (refused.length > 0) {
    throw new ConnectionAccountSelectionError(
      "An attached connector account is unavailable. Review its connection settings.",
      {
        version: 1,
        reason: "selected_account_unavailable",
        // Name every unusable pick, including ones "omit" would leave out, so
        // the person can fix them all at once.
        accounts: unavailable,
      },
    );
  }
  return {
    bindings: McpConnectionAccountBindings.parse(
      bindings.sort((left, right) => left.serverId.localeCompare(right.serverId)),
    ),
    omitted,
  };
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
