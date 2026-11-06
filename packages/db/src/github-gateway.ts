import {
  ResourceRef,
  parseSessionRemovedRepositories,
  resolveSessionUnattended,
  sessionMetadataUnattended,
  type SessionRemovedRepository,
} from "@opengeni/contracts";
import { and, desc, eq, like, or } from "drizzle-orm";
import { type Database, withRlsContext, withWorkspaceRls } from "./database";
import * as schema from "./schema";

/**
 * Approval ids of requests the personal GitHub gateway held for a person's
 * decision (`gh` in a sandbox): `ghgw:<digest of the exact request>`, with a
 * `:<n>` round once the same request already ran in the turn.
 */
export const GITHUB_GATEWAY_APPROVAL_PREFIX = "ghgw:";

export function isGitHubGatewayApprovalId(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(GITHUB_GATEWAY_APPROVAL_PREFIX);
}

/** Live session facts the gateway rechecks on every request. */
export async function getSessionGitHubGatewayState(
  db: Database,
  workspaceId: string,
  sessionId: string,
): Promise<{
  resources: ResourceRef[];
  removedRepositories: SessionRemovedRepository[];
  unattended: boolean;
} | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb
      .select({
        resources: schema.sessions.resources,
        removedRepositories: schema.sessions.removedRepositories,
        unattendedSetting: schema.sessions.unattendedSetting,
        metadata: schema.sessions.metadata,
        forkedFromSessionId: schema.sessions.forkedFromSessionId,
      })
      .from(schema.sessions)
      .where(and(eq(schema.sessions.workspaceId, workspaceId), eq(schema.sessions.id, sessionId)))
      .limit(1);
    if (!row) return null;
    const resources = ResourceRef.array().safeParse(row.resources);
    return {
      resources: resources.success ? resources.data : [],
      removedRepositories: parseSessionRemovedRepositories(row.removedRepositories),
      unattended: resolveSessionUnattended({
        setting: row.unattendedSetting ?? null,
        createdUnattended: sessionMetadataUnattended(row.metadata),
        forked: row.forkedFromSessionId !== null,
      }),
    };
  });
}

/**
 * The approval id for one exact gateway request in a turn. A request still
 * waiting, approved or declined keeps its id, so running the same command
 * again after approval executes it; once it ran (or its outcome is unknown),
 * the same request again is a new round that is decided afresh.
 */
export async function githubGatewayApprovalIdForRequest(
  db: Database,
  input: { accountId: string; workspaceId: string; sessionId: string; turnId: string },
  digest: string,
): Promise<string> {
  const base = `${GITHUB_GATEWAY_APPROVAL_PREFIX}${digest}`;
  return await withRlsContext(db, input, async (scoped) => {
    const rows = await scoped
      .select({
        approvalId: schema.connectorActionRequests.approvalId,
        status: schema.connectorActionRequests.status,
      })
      .from(schema.connectorActionRequests)
      .where(
        and(
          eq(schema.connectorActionRequests.workspaceId, input.workspaceId),
          eq(schema.connectorActionRequests.sessionId, input.sessionId),
          eq(schema.connectorActionRequests.turnId, input.turnId),
          or(
            eq(schema.connectorActionRequests.approvalId, base),
            like(schema.connectorActionRequests.approvalId, `${base}:%`),
          ),
        ),
      )
      .orderBy(desc(schema.connectorActionRequests.createdAt))
      .limit(256);
    if (rows.length === 0) return base;
    const roundOf = (approvalId: string) =>
      approvalId === base ? 0 : Number(approvalId.slice(base.length + 1)) || 0;
    const latest = rows.reduce((best, row) =>
      roundOf(row.approvalId) > roundOf(best.approvalId) ? row : best,
    );
    if (["pending", "approved", "rejected", "blocked"].includes(latest.status)) {
      return latest.approvalId;
    }
    return `${base}:${roundOf(latest.approvalId) + 1}`;
  });
}

export type GitHubGatewayApproval = {
  approvalId: string;
  requestId: string;
  toolName: string;
  status: string;
  title: string | null;
  reviewArguments: string | null;
};

/** Gateway requests of one turn that asked for a decision, oldest first. */
export async function listTurnGitHubGatewayApprovals(
  db: Database,
  input: { accountId: string; workspaceId: string; sessionId: string; turnId: string },
): Promise<GitHubGatewayApproval[]> {
  return await withRlsContext(db, input, async (scoped) => {
    const rows = await scoped
      .select({
        approvalId: schema.connectorActionRequests.approvalId,
        requestId: schema.connectorActionRequests.id,
        toolName: schema.connectorActionRequests.toolName,
        status: schema.connectorActionRequests.status,
        reviewContext: schema.connectorActionRequests.reviewContext,
        reviewArguments: schema.connectorActionRequests.reviewArguments,
      })
      .from(schema.connectorActionRequests)
      .where(
        and(
          eq(schema.connectorActionRequests.workspaceId, input.workspaceId),
          eq(schema.connectorActionRequests.sessionId, input.sessionId),
          eq(schema.connectorActionRequests.turnId, input.turnId),
          like(schema.connectorActionRequests.approvalId, `${GITHUB_GATEWAY_APPROVAL_PREFIX}%`),
        ),
      )
      .orderBy(schema.connectorActionRequests.createdAt)
      .limit(129);
    if (rows.length > 128) throw new Error("Too many GitHub gateway approvals in one turn");
    return rows.map((row) => {
      const context = row.reviewContext as { title?: unknown } | null;
      return {
        approvalId: row.approvalId,
        requestId: row.requestId,
        toolName: row.toolName,
        status: row.status,
        title: typeof context?.title === "string" ? context.title : null,
        reviewArguments: row.reviewArguments,
      };
    });
  });
}
