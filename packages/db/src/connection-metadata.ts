import {
  type ConnectionKind,
  type ConnectionMetadata,
  type ConnectionStatus,
  OPENROUTER_CREDENTIAL_OPERATION_DIGEST_METADATA_KEY,
  OPENROUTER_CREDENTIAL_OPERATION_ID_METADATA_KEY,
  VERCEL_AI_GATEWAY_CREDENTIAL_OPERATION_DIGEST_METADATA_KEY,
  VERCEL_AI_GATEWAY_CREDENTIAL_OPERATION_ID_METADATA_KEY,
} from "@opengeni/contracts";
import { and, desc, eq, isNull, or, type SQL } from "drizzle-orm";
import { withWorkspaceRls, withWorkspaceSubjectRls, type Database } from "./database";
import * as schema from "./schema";

/** Server-owned verification facts; public schemas expose them read-only and nullable. */
export type ConnectionMetadataWithVerification = ConnectionMetadata & {
  verifiedInstallAt: string | null;
  verifiedInstallVersion: number | null;
};

export const connectionMetadataColumns = {
  id: schema.connections.id,
  authorityId: schema.connections.authorityId,
  authorityGeneration: schema.connections.authorityGeneration,
  accountId: schema.connections.accountId,
  workspaceId: schema.connections.workspaceId,
  subjectId: schema.connections.subjectId,
  providerDomain: schema.connections.providerDomain,
  kind: schema.connections.kind,
  status: schema.connections.status,
  grantedScopes: schema.connections.grantedScopes,
  expiresAt: schema.connections.expiresAt,
  lastRefreshAt: schema.connections.lastRefreshAt,
  lastUsedAt: schema.connections.lastUsedAt,
  lastError: schema.connections.lastError,
  version: schema.connections.version,
  verifiedInstallAt: schema.connections.verifiedInstallAt,
  verifiedInstallVersion: schema.connections.verifiedInstallVersion,
  metadata: schema.connections.metadata,
  createdBySubjectId: schema.connections.createdBySubjectId,
  updatedBySubjectId: schema.connections.updatedBySubjectId,
  createdAt: schema.connections.createdAt,
  updatedAt: schema.connections.updatedAt,
};

export function connectionSubjectVisibility(subjectId?: string | null): SQL {
  return subjectId
    ? or(isNull(schema.connections.subjectId), eq(schema.connections.subjectId, subjectId))!
    : isNull(schema.connections.subjectId);
}

export async function withConnectionSubjectRls<T>(
  db: Database,
  workspaceId: string,
  subjectId: string | null | undefined,
  fn: (db: Database) => Promise<T>,
): Promise<T> {
  return subjectId
    ? await withWorkspaceSubjectRls(db, workspaceId, subjectId, fn)
    : await withWorkspaceRls(db, workspaceId, fn);
}

export async function listConnectionsMetadata(
  db: Database,
  workspaceId: string,
  subjectId?: string | null,
): Promise<ConnectionMetadataWithVerification[]> {
  return await withConnectionSubjectRls(db, workspaceId, subjectId, async (scopedDb) => {
    const rows = await scopedDb
      .select(connectionMetadataColumns)
      .from(schema.connections)
      .where(
        and(
          eq(schema.connections.workspaceId, workspaceId),
          connectionSubjectVisibility(subjectId),
        ),
      )
      // Legacy rows can share created_at. UUID DESC is the immutable stable
      // tie-breaker, so every caller that intentionally selects the first row
      // collapses duplicates in the same documented direction.
      .orderBy(desc(schema.connections.createdAt), desc(schema.connections.id));
    return rows.map(mapConnectionMetadata);
  });
}

export async function getConnectionMetadata(
  db: Database,
  workspaceId: string,
  connectionId: string,
  subjectId?: string | null,
): Promise<ConnectionMetadataWithVerification | null> {
  return await withConnectionSubjectRls(db, workspaceId, subjectId, async (scopedDb) => {
    const [row] = await scopedDb
      .select(connectionMetadataColumns)
      .from(schema.connections)
      .where(
        and(
          eq(schema.connections.workspaceId, workspaceId),
          eq(schema.connections.id, connectionId),
          connectionSubjectVisibility(subjectId),
        ),
      )
      .limit(1);
    return row ? mapConnectionMetadata(row) : null;
  });
}

export function mapConnectionMetadata(row: {
  id: string;
  authorityId?: string | null;
  authorityGeneration: number;
  accountId: string;
  workspaceId: string;
  subjectId: string | null;
  providerDomain: string;
  kind: string;
  status: string;
  grantedScopes: string[];
  expiresAt: Date | null;
  lastRefreshAt: Date | null;
  lastUsedAt: Date | null;
  lastError: string | null;
  version: number;
  verifiedInstallAt: Date | null;
  verifiedInstallVersion: number | null;
  metadata: Record<string, unknown>;
  createdBySubjectId: string | null;
  updatedBySubjectId: string | null;
  createdAt: Date;
  updatedAt: Date;
}): ConnectionMetadataWithVerification {
  const {
    [OPENROUTER_CREDENTIAL_OPERATION_ID_METADATA_KEY]: _openRouterOperationId,
    [OPENROUTER_CREDENTIAL_OPERATION_DIGEST_METADATA_KEY]: _openRouterOperationDigest,
    [VERCEL_AI_GATEWAY_CREDENTIAL_OPERATION_ID_METADATA_KEY]: _operationId,
    [VERCEL_AI_GATEWAY_CREDENTIAL_OPERATION_DIGEST_METADATA_KEY]: _operationDigest,
    anthropicCredentialOperationId: _anthropicOperationId,
    anthropicCredentialOperationDigest: _anthropicOperationDigest,
    claude_subscriptionCredentialOperationId: _claudeOperationId,
    claude_subscriptionCredentialOperationDigest: _claudeOperationDigest,
    ...publicMetadata
  } = row.metadata;
  return {
    id: row.id,
    ...(row.subjectId !== null && row.authorityId ? { authorityId: row.authorityId } : {}),
    connectionAuthorityGeneration: row.authorityGeneration,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    subjectId: row.subjectId,
    providerDomain: row.providerDomain,
    kind: row.kind as ConnectionKind,
    status: row.status as ConnectionStatus,
    grantedScopes: row.grantedScopes,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    lastRefreshAt: row.lastRefreshAt?.toISOString() ?? null,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    lastError: row.lastError,
    version: row.version,
    verifiedInstallAt: row.verifiedInstallAt?.toISOString() ?? null,
    verifiedInstallVersion: row.verifiedInstallVersion,
    metadata: publicMetadata,
    createdBySubjectId: row.createdBySubjectId,
    updatedBySubjectId: row.updatedBySubjectId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
