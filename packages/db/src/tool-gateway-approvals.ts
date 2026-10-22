import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { ToolGatewayIdentity } from "@opengeni/contracts";
import type { Database } from "./database";
import { withWorkspaceSubjectRls } from "./database";
import * as schema from "./schema";

const MAX_LIVE_APPROVALS_PER_SUBJECT = 100;

export class ToolGatewayApprovalRateLimitError extends Error {
  readonly name = "ToolGatewayApprovalRateLimitError";
}

export class ToolGatewayApprovalOperationStartedError extends Error {
  readonly name = "ToolGatewayApprovalOperationStartedError";
}

export async function issueToolGatewayApproval(
  db: Database,
  input: {
    tokenHash: string;
    accountId: string;
    workspaceId: string;
    subjectId: string;
    operationId: string;
    identity: ToolGatewayIdentity;
    argumentsDigest: string;
    approvalAuthorityDigest: string;
    expiresAt: Date;
  } & (
    | { bindingVersion?: 1; catalogDigest: string; targetBindingDigest?: never }
    | { bindingVersion: 2; targetBindingDigest: string; catalogDigest?: never }
  ),
): Promise<void> {
  await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (scopedDb) => {
    await lockApprovalSubject(scopedDb, input.workspaceId, input.subjectId);
    await lockApprovalOperation(scopedDb, input.workspaceId, input.subjectId, input.operationId);
    const [existing] = await scopedDb
      .select({
        tokenHash: schema.toolGatewayApprovalCapabilities.tokenHash,
        consumedAt: schema.toolGatewayApprovalCapabilities.consumedAt,
      })
      .from(schema.toolGatewayApprovalCapabilities)
      .where(
        and(
          eq(schema.toolGatewayApprovalCapabilities.workspaceId, input.workspaceId),
          eq(schema.toolGatewayApprovalCapabilities.subjectId, input.subjectId),
          eq(schema.toolGatewayApprovalCapabilities.operationId, input.operationId),
        ),
      )
      .limit(1);
    if (existing?.consumedAt) {
      throw new ToolGatewayApprovalOperationStartedError(
        "The tool operation has already consumed its approval",
      );
    }
    if (existing) {
      // Reapproval before execution is allowed when catalog or provider
      // authority changed. Once consumed, the row is retained permanently as
      // the operation tombstone above and is never replaced.
      await scopedDb
        .delete(schema.toolGatewayApprovalCapabilities)
        .where(eq(schema.toolGatewayApprovalCapabilities.tokenHash, existing.tokenHash));
    }
    await scopedDb.execute(sql`
      delete from tool_gateway_approval_capabilities
      where token_hash in (
        select token_hash
        from tool_gateway_approval_capabilities
        where workspace_id = ${input.workspaceId}
          and subject_id = ${input.subjectId}
          and expires_at <= clock_timestamp()
          and consumed_at is null
        order by expires_at, token_hash
        limit 128
      )
    `);
    const [count] = await scopedDb
      .select({ value: sql<number>`count(*)::integer` })
      .from(schema.toolGatewayApprovalCapabilities)
      .where(
        and(
          eq(schema.toolGatewayApprovalCapabilities.workspaceId, input.workspaceId),
          eq(schema.toolGatewayApprovalCapabilities.subjectId, input.subjectId),
          isNull(schema.toolGatewayApprovalCapabilities.consumedAt),
          gt(schema.toolGatewayApprovalCapabilities.expiresAt, new Date()),
        ),
      );
    if ((count?.value ?? 0) >= MAX_LIVE_APPROVALS_PER_SUBJECT) {
      throw new ToolGatewayApprovalRateLimitError("Too many live tool approvals");
    }
    await scopedDb.insert(schema.toolGatewayApprovalCapabilities).values({
      tokenHash: input.tokenHash,
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      subjectId: input.subjectId,
      operationId: input.operationId,
      bindingVersion: input.bindingVersion ?? 1,
      catalogDigest: input.catalogDigest ?? null,
      targetBindingDigest: input.targetBindingDigest ?? null,
      serverId: input.identity.serverId,
      toolName: input.identity.toolName,
      argumentsDigest: input.argumentsDigest,
      authorityDigest: input.approvalAuthorityDigest,
      expiresAt: input.expiresAt,
    });
  });
}

export async function consumeToolGatewayApproval(
  db: Database,
  input: {
    tokenHash: string;
    accountId: string;
    workspaceId: string;
    subjectId: string;
    operationId: string;
    catalogDigest: string;
    identity: ToolGatewayIdentity;
    argumentsDigest: string;
    approvalAuthorityDigest: string;
  },
): Promise<boolean> {
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (scopedDb) => {
    await lockApprovalOperation(scopedDb, input.workspaceId, input.subjectId, input.operationId);
    const [consumed] = await scopedDb
      .update(schema.toolGatewayApprovalCapabilities)
      .set({ consumedAt: new Date() })
      .where(
        and(
          eq(schema.toolGatewayApprovalCapabilities.tokenHash, input.tokenHash),
          eq(schema.toolGatewayApprovalCapabilities.accountId, input.accountId),
          eq(schema.toolGatewayApprovalCapabilities.workspaceId, input.workspaceId),
          eq(schema.toolGatewayApprovalCapabilities.subjectId, input.subjectId),
          eq(schema.toolGatewayApprovalCapabilities.operationId, input.operationId),
          eq(schema.toolGatewayApprovalCapabilities.catalogDigest, input.catalogDigest),
          eq(schema.toolGatewayApprovalCapabilities.bindingVersion, 1),
          eq(schema.toolGatewayApprovalCapabilities.serverId, input.identity.serverId),
          eq(schema.toolGatewayApprovalCapabilities.toolName, input.identity.toolName),
          eq(schema.toolGatewayApprovalCapabilities.argumentsDigest, input.argumentsDigest),
          eq(schema.toolGatewayApprovalCapabilities.authorityDigest, input.approvalAuthorityDigest),
          isNull(schema.toolGatewayApprovalCapabilities.consumedAt),
          gt(schema.toolGatewayApprovalCapabilities.expiresAt, new Date()),
        ),
      )
      .returning({ tokenHash: schema.toolGatewayApprovalCapabilities.tokenHash });
    return consumed !== undefined;
  });
}

/** Check provenance even for an Allow decision. No row + Allow is not idempotency. */
export async function beginTargetToolGatewayCall(
  db: Database,
  input: {
    tokenHash?: string;
    accountId: string;
    workspaceId: string;
    subjectId: string;
    operationId: string;
    targetBindingDigest: string;
    identity: ToolGatewayIdentity;
    argumentsDigest: string;
    approvalAuthorityDigest: string;
    approvalRequired: boolean;
  },
): Promise<boolean> {
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (tx) => {
    await lockApprovalOperation(tx, input.workspaceId, input.subjectId, input.operationId);
    const [row] = await tx
      .select()
      .from(schema.toolGatewayApprovalCapabilities)
      .where(
        and(
          eq(schema.toolGatewayApprovalCapabilities.workspaceId, input.workspaceId),
          eq(schema.toolGatewayApprovalCapabilities.subjectId, input.subjectId),
          eq(schema.toolGatewayApprovalCapabilities.operationId, input.operationId),
        ),
      )
      .limit(1);
    if (row?.consumedAt)
      throw new ToolGatewayApprovalOperationStartedError(
        "The tool operation has already consumed its approval",
      );
    if (!row) return !input.approvalRequired && input.tokenHash === undefined;
    if (
      row.bindingVersion !== 2 ||
      row.accountId !== input.accountId ||
      row.targetBindingDigest !== input.targetBindingDigest ||
      row.serverId !== input.identity.serverId ||
      row.toolName !== input.identity.toolName ||
      row.argumentsDigest !== input.argumentsDigest ||
      row.authorityDigest !== input.approvalAuthorityDigest ||
      row.expiresAt.getTime() <= Date.now() ||
      (input.tokenHash !== undefined && row.tokenHash !== input.tokenHash) ||
      (input.approvalRequired && input.tokenHash === undefined)
    )
      return false;
    await tx
      .update(schema.toolGatewayApprovalCapabilities)
      .set({ consumedAt: new Date() })
      .where(eq(schema.toolGatewayApprovalCapabilities.tokenHash, row.tokenHash));
    return true;
  });
}

async function lockApprovalSubject(
  db: Database,
  workspaceId: string,
  subjectId: string,
): Promise<void> {
  await db.execute(
    sql`select pg_advisory_xact_lock(
      hashtextextended(${`tool-gateway-approval-subject:${workspaceId}:${subjectId}`}, 0)
    )`,
  );
}

async function lockApprovalOperation(
  db: Database,
  workspaceId: string,
  subjectId: string,
  operationId: string,
): Promise<void> {
  await db.execute(
    sql`select pg_advisory_xact_lock(
      hashtextextended(${`tool-gateway-approval:${workspaceId}:${subjectId}:${operationId}`}, 0)
    )`,
  );
}
