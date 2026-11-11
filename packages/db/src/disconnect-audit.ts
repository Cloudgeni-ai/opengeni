/**
 * One `audit_events` row for each successful disconnect of a model
 * subscription or a connector, written by the disconnect's own writer inside
 * the transaction that removes or revokes it. The disconnect and its record
 * commit together: a failed audit insert rolls the disconnect back, and a
 * refused, missing or already-disconnected target writes nothing.
 *
 * The metadata names who acted and through which surface, never a credential:
 * only identifiers, provider names and the acting principal's provenance.
 */
import type { Database } from "./database";
import { withLosslessContentWriteVersion } from "./lossless-json";
import * as schema from "./schema";

/** A connector (MCP/OAuth/API-key connection, vault provider, bot, installation) was disconnected. */
export const CONNECTION_DISCONNECTED_AUDIT_ACTION = "connection.disconnected";
/** A model subscription account (Codex, Claude, SuperGrok) was disconnected. */
export const SUBSCRIPTION_CONNECTION_DISCONNECTED_AUDIT_ACTION =
  "subscription_connection.disconnected";

/**
 * The surface that asked for the disconnect: a person in the app ("app"), an
 * API, organization or configured key or a service principal ("api"), or an
 * agent ("agent").
 */
export type DisconnectAuditSource = "app" | "api" | "agent";

const DISCONNECT_AUDIT_SOURCES: ReadonlySet<string> = new Set(["app", "api", "agent"]);

/** Who disconnected, resolved by the API from the request's authenticated principal. */
export type DisconnectAuditActor = {
  subjectId: string;
  source: DisconnectAuditSource;
  /** The authenticated principal kind, for example `human_session` or `agent_attempt`. */
  principalKind: string | null;
  /** How an agent or key reached the route, for example `session_admin_access`. */
  via?: string | null;
  /** The agent's session, turn and attempt, when the principal carries them. */
  sessionId?: string | null;
  turnId?: string | null;
  attemptId?: string | null;
  /** The connected agent's organization connection, for a connected agent. */
  organizationMcpConnectionId?: string | null;
};

export type DisconnectAuditTarget = {
  /** The kind of record disconnected, for example `connection` or `subscription_connection`. */
  type: string;
  id: string;
  provider?: string | null;
  providerDomain?: string | null;
};

type AuditDetail = string | number | boolean | null | readonly string[];

/**
 * Insert the disconnect's audit row. The caller holds a transaction whose RLS
 * account is `accountId` (and whose workspace, when set, is `workspaceId`).
 * `workspaceId` null records an organization-level removal.
 */
export async function insertDisconnectAuditEventInScope(
  tx: Database,
  input: {
    accountId: string;
    workspaceId: string | null;
    action:
      | typeof CONNECTION_DISCONNECTED_AUDIT_ACTION
      | typeof SUBSCRIPTION_CONNECTION_DISCONNECTED_AUDIT_ACTION;
    actor: DisconnectAuditActor;
    target: DisconnectAuditTarget;
    /** Extra non-secret facts about the target (kind, ownership, label). */
    details?: Record<string, AuditDetail | undefined>;
  },
): Promise<void> {
  const { actor, target } = input;
  if (!actor.subjectId.trim()) throw new Error("disconnect audit requires an acting subject");
  if (!DISCONNECT_AUDIT_SOURCES.has(actor.source)) {
    throw new Error(`disconnect audit source is invalid: ${String(actor.source)}`);
  }
  const metadata: Record<string, AuditDetail> = {
    source: actor.source,
    principalKind: actor.principalKind ?? null,
    scope: input.workspaceId === null ? "organization" : "workspace",
  };
  const optional: Record<string, AuditDetail | undefined> = {
    via: actor.via,
    sessionId: actor.sessionId,
    turnId: actor.turnId,
    attemptId: actor.attemptId,
    organizationMcpConnectionId: actor.organizationMcpConnectionId,
    provider: target.provider,
    providerDomain: target.providerDomain,
    ...input.details,
  };
  for (const [key, value] of Object.entries(optional)) {
    if (value !== undefined && value !== null && !(key in metadata)) metadata[key] = value;
  }
  await tx.insert(schema.auditEvents).values(
    withLosslessContentWriteVersion(
      {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        subjectId: actor.subjectId,
        action: input.action,
        targetType: target.type,
        targetId: target.id,
        metadata,
      },
      "metadata",
      "metadataCodecVersion",
    ),
  );
}
