import type { Observability } from "./index";

/**
 * Organization (Console) agent metrics. Labels are closed sets: no
 * organization, agent, workspace, session, user or tool server identity, and
 * never a credential, may become a label. Unknown values collapse to `other`.
 * Telemetry never changes an outcome: registry failures are swallowed.
 */
export const ORG_AGENT_RESOLVE_OUTCOMES = [
  "resolved",
  "agent_not_found",
  "agent_not_published",
  "agent_version_not_found",
  "agent_managed_in_console",
  "agent_override_rejected",
  "agent_ref_conflict",
  "agents_manage_required",
  "tool_server_not_found",
  "invalid",
  "error",
  "other",
] as const;
export type OrgAgentResolveOutcome = (typeof ORG_AGENT_RESOLVE_OUTCOMES)[number];

export const ORG_AGENT_CREDENTIAL_SOURCES = [
  "credential_provider",
  "end_user_store",
  "chat_headers",
  "shared_key",
  "none",
] as const;
export type OrgAgentCredentialSource = (typeof ORG_AGENT_CREDENTIAL_SOURCES)[number];

export const ORG_AGENT_CREDENTIAL_OUTCOMES = [
  "used",
  "refreshed",
  "missing",
  "expired",
  "refresh_failed",
  "error",
  /** Chat headers another person's turn may not use. */
  "refused",
] as const;
export type OrgAgentCredentialOutcome = (typeof ORG_AGENT_CREDENTIAL_OUTCOMES)[number];

export const ORG_AGENT_PUBLISH_MOVE_OUTCOMES = [
  "moved",
  "deferred",
  "skipped",
  "failed",
  "operation_succeeded",
  "operation_failed",
] as const;
export type OrgAgentPublishMoveOutcome = (typeof ORG_AGENT_PUBLISH_MOVE_OUTCOMES)[number];

function closed<T extends string>(values: readonly T[], value: string, fallback: T): T {
  return (values as readonly string[]).includes(value) ? (value as T) : fallback;
}

function increment(
  observability: Observability | null | undefined,
  metric: { name: string; help: string },
  labels: Record<string, string>,
  amount = 1,
): void {
  if (!observability) return;
  try {
    observability.incrementCounter({ ...metric, labels, amount });
  } catch {
    // Product execution stays authoritative over an unhealthy registry.
  }
}

/** `opengeni_org_agent_resolve_total{outcome}`: session creates naming an organization agent. */
export function recordOrgAgentResolve(
  observability: Observability | null | undefined,
  outcome: string,
): void {
  increment(
    observability,
    {
      name: "opengeni_org_agent_resolve_total",
      help: "Session creates that named an organization agent, by outcome.",
    },
    { outcome: closed(ORG_AGENT_RESOLVE_OUTCOMES, outcome, "other") },
  );
}

/** `opengeni_org_agent_credential_source_total{source,outcome}`: turn-time tool server logins. */
export function recordOrgAgentCredentialSource(
  observability: Observability | null | undefined,
  source: OrgAgentCredentialSource,
  outcome: OrgAgentCredentialOutcome,
): void {
  increment(
    observability,
    {
      name: "opengeni_org_agent_credential_source_total",
      help: "Organization tool server logins resolved for a turn, by source and outcome.",
    },
    {
      source: closed(ORG_AGENT_CREDENTIAL_SOURCES, source, "none"),
      outcome: closed(ORG_AGENT_CREDENTIAL_OUTCOMES, outcome, "error"),
    },
  );
}

/** `opengeni_org_agent_publish_move_total{outcome}`: chats moved to a newly published version. */
export function recordOrgAgentPublishMove(
  observability: Observability | null | undefined,
  outcome: OrgAgentPublishMoveOutcome,
  amount = 1,
): void {
  if (amount <= 0) return;
  increment(
    observability,
    {
      name: "opengeni_org_agent_publish_move_total",
      help: "Chats handled by an organization agent publish move, by outcome.",
    },
    { outcome: closed(ORG_AGENT_PUBLISH_MOVE_OUTCOMES, outcome, "failed") },
    amount,
  );
}
