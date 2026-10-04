import type { ConnectorActionPolicySnapshotEntry } from "./schema";
import type { McpConnectionAccountBinding } from "@opengeni/contracts";
import { stableJson } from "@opengeni/contracts";
import { createHash } from "node:crypto";

export function connectorToolPolicyRevision(
  policies: readonly ConnectorActionPolicySnapshotEntry[],
  connectionId: string,
  serverId: string,
): string {
  return createHash("sha256")
    .update(
      stableJson(
        policies
          .filter(
            (policy) =>
              policy.connectionId === connectionId &&
              (policy.serverId === serverId || policy.serverId === "*"),
          )
          .map(({ id, version, serverId: policyServerId, toolName, actionName, policy }) => ({
            id,
            version,
            serverId: policyServerId,
            toolName,
            actionName,
            policy,
          }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      ),
    )
    .digest("hex");
}

export class ConnectorToolPermissionConflictError extends Error {
  constructor() {
    super("Tool permissions changed. Reload before saving.");
  }
}

/** Map preferences through accepted account routes, never through caller arguments.
 * Execution identities and fingerprints continue to use the account-qualified ID. */
export function connectorActionPoliciesForAccountRoutes(
  policies: readonly ConnectorActionPolicySnapshotEntry[],
  bindings: readonly McpConnectionAccountBinding[] | null,
): ConnectorActionPolicySnapshotEntry[] {
  return policies.flatMap((policy) => [
    policy,
    ...(bindings ?? [])
      .filter(
        (binding) =>
          binding.canonicalServerId === policy.serverId &&
          binding.connectionId === policy.connectionId &&
          binding.serverId !== policy.serverId,
      )
      .map((binding) => ({ ...policy, serverId: binding.serverId })),
  ]);
}

export type ResolvedConnectorActionPolicy =
  | { managed: false }
  | {
      managed: true;
      source: "explicit";
      entry: ConnectorActionPolicySnapshotEntry;
    }
  | {
      managed: true;
      source: "default";
      entry: null;
      decision: "allow" | "ask";
      actionName: string;
    }
  | {
      managed: true;
      source: "ambiguous";
      entry: null;
      decision: "block";
    };

/** Resolve one immutable snapshot. Recommendations apply only without a choice. */
export function resolveConnectorActionPolicy(
  snapshot: readonly ConnectorActionPolicySnapshotEntry[],
  input: {
    connectionId: string;
    serverId: string;
    toolName: string;
    actionName: string;
    defaultDecision?: "allow" | "ask";
  },
): ResolvedConnectorActionPolicy {
  const candidates = snapshot
    .filter(
      (entry) =>
        entry.connectionId === input.connectionId &&
        (entry.serverId === input.serverId || entry.serverId === "*") &&
        (entry.toolName === input.toolName || entry.toolName === "*") &&
        (entry.actionName === input.actionName || entry.actionName === "*"),
    )
    .map((entry) => ({
      entry,
      specificity:
        Number(entry.serverId !== "*") +
        Number(entry.toolName !== "*") +
        Number(entry.actionName !== "*"),
    }))
    .sort(
      (left, right) =>
        right.specificity - left.specificity || left.entry.id.localeCompare(right.entry.id),
    );
  const selected = candidates[0];
  if (!selected) {
    return input.defaultDecision === undefined
      ? { managed: false }
      : {
          managed: true,
          source: "default",
          entry: null,
          decision: input.defaultDecision,
          // A free-form action argument is never durable audit evidence.
          actionName: input.toolName,
        };
  }
  if (candidates[1]?.specificity === selected.specificity) {
    return { managed: true, source: "ambiguous", entry: null, decision: "block" };
  }
  return { managed: true, source: "explicit", entry: selected.entry };
}

export function connectorActionPolicyDecision(
  resolved: Exclude<ResolvedConnectorActionPolicy, { managed: false }>,
): "allow" | "ask" | "block" {
  return resolved.entry ? resolved.entry.policy : resolved.decision;
}

/** A settings preview enumerates actual action rules, rather than querying only '*'. */
export function projectConnectorToolPermission(
  snapshot: readonly ConnectorActionPolicySnapshotEntry[],
  input: {
    connectionId: string;
    serverId: string;
    toolName: string;
    defaultDecision: "allow" | "ask";
  },
) {
  const resolved = resolveConnectorActionPolicy(snapshot, {
    ...input,
    actionName: input.toolName,
  });
  if (!resolved.managed) throw new Error("Tool permission projection requires a default");
  const permission = connectorActionPolicyDecision(resolved);
  const actions = new Set(
    snapshot
      .filter(
        (entry) =>
          entry.connectionId === input.connectionId &&
          (entry.serverId === input.serverId || entry.serverId === "*") &&
          (entry.toolName === input.toolName || entry.toolName === "*") &&
          entry.actionName !== "*" &&
          entry.actionName !== input.toolName,
      )
      .map((entry) => entry.actionName),
  );
  const actionPermissions = [...actions].sort().map((actionName) => {
    const action = resolveConnectorActionPolicy(snapshot, { ...input, actionName });
    if (!action.managed) throw new Error("Action permission projection requires a default");
    return { actionName, permission: connectorActionPolicyDecision(action) };
  });
  return {
    permission,
    inherited: resolved.source === "default" || resolved.entry?.toolName === "*",
    source:
      resolved.source === "default"
        ? ("recommended" as const)
        : resolved.source === "ambiguous"
          ? ("conflict" as const)
          : resolved.entry.toolName === "*"
            ? ("connector_default" as const)
            : resolved.entry.actionName === "*"
              ? ("tool" as const)
              : ("action" as const),
    conditional: actionPermissions.some((action) => action.permission !== permission),
    actionPermissions,
    approvalRequired: permission === "ask" || actionPermissions.some((p) => p.permission === "ask"),
  };
}
