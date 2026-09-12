import { sql } from "drizzle-orm";
import { z } from "zod";
import {
  ExternalIdentity,
  ExternalIdentityLookup,
  CancelExternalWorkspaceMemberGrantResponse,
  type AddExternalWorkspaceMemberRequest,
  type CancelExternalWorkspaceMemberGrantRequest,
  type ExternalIdentityReference,
} from "@opengeni/contracts/external-identities";
import {
  rawRows,
  withAccountRls,
  withWorkspaceSubjectRls,
  setSubjectRlsContext,
  type Database,
} from "./database";
import { grantWorkspaceAccess, listWorkspaceMembers } from "./workspace-membership-access";
import { removeWorkspaceMember } from "./organization-membership-lifecycle";

type ServiceScope = { organizationId: string; actorSubjectId: string };

export async function lookupExternalIdentity(
  db: Database,
  scope: ServiceScope,
  identity: ExternalIdentityReference,
) {
  return withAccountRls(db, scope.organizationId, async (tx) => {
    await setSubjectRlsContext(tx, scope.actorSubjectId);
    const [row] = await rawRows<{ result: unknown }>(
      tx,
      sql`select lookup_external_identity(
      ${scope.organizationId}::uuid, ${scope.actorSubjectId}, ${identity.source}, ${identity.externalId}
    ) as result`,
    );
    return ExternalIdentityLookup.parse(row?.result);
  });
}

async function prepare(db: Database, command: Record<string, unknown>) {
  const [row] = await rawRows<{ result: unknown }>(
    db,
    sql`select prepare_external_workspace_membership_operation(${JSON.stringify(command)}::jsonb) as result`,
  );
  return z
    .object({
      replay: z.boolean(),
      result: z.unknown().optional(),
      identity: z.unknown().optional(),
    })
    .parse(row?.result);
}

async function record(db: Database, command: Record<string, unknown>, result: unknown) {
  await db.execute(sql`select record_external_workspace_membership_operation(
    ${JSON.stringify(command)}::jsonb, ${JSON.stringify(result)}::jsonb)`);
}

/** One keyed grant. An operation replay never restores a removed/reduced row. */
export async function addExternalWorkspaceMemberOperation(
  db: Database,
  scope: ServiceScope & { workspaceId: string },
  request: AddExternalWorkspaceMemberRequest & { operationId: string },
) {
  const command = {
    ...scope,
    action: "grant",
    ...request,
    permissions: [...new Set(request.permissions)].sort(),
  };
  return withWorkspaceSubjectRls(db, scope.workspaceId, scope.actorSubjectId, async (tx) => {
    const prepared = await prepare(tx, command);
    if (prepared.replay)
      return z.object({ identity: ExternalIdentity }).parse(prepared.result).identity;
    const identity = ExternalIdentity.parse(prepared.identity);
    const existing = (await listWorkspaceMembers(tx, scope.workspaceId)).find(
      (member) => member.subjectId === identity.subjectId,
    );
    if (
      existing &&
      (existing.permissions.length !== command.permissions.length ||
        existing.permissions.some((permission) => !command.permissions.includes(permission)))
    ) {
      // SQLSTATE matches the native optimistic-concurrency contract.
      await tx.execute(
        sql`do $$ begin raise exception 'existing membership differs' using errcode = '40001'; end $$`,
      );
    }
    if (!existing)
      await grantWorkspaceAccess(tx, {
        accountId: scope.organizationId,
        workspaceId: scope.workspaceId,
        subjectId: identity.subjectId,
        role: "member",
        permissions: command.permissions,
      });
    await record(tx, command, { workspaceId: scope.workspaceId, identity });
    return identity;
  });
}

/** The native removal owns all teardown; this wrapper adds an immutable causal
 * fence even when an earlier grant has not reached the database yet. */
export async function cancelExternalWorkspaceMemberGrant(
  db: Database,
  scope: ServiceScope & { workspaceId: string; membershipId: string },
  request: CancelExternalWorkspaceMemberGrantRequest,
) {
  const command = { ...scope, action: "revoke", ...request };
  return withWorkspaceSubjectRls(db, scope.workspaceId, scope.actorSubjectId, async (tx) => {
    const prepared = await prepare(tx, command);
    if (prepared.replay) {
      const stored = z
        .object({ removed: z.boolean(), fencedGrantOperationId: z.string().uuid() })
        .parse(prepared.result);
      return CancelExternalWorkspaceMemberGrantResponse.parse({ ...stored, replay: true });
    }
    const identity = z.object({ subjectId: z.string() }).parse(prepared.identity);
    const removed = await removeWorkspaceMember(tx, {
      accountId: scope.organizationId,
      workspaceId: scope.workspaceId,
      actorSubjectId: scope.actorSubjectId,
      targetSubjectId: identity.subjectId,
      operationId: request.operationId,
    });
    const result = {
      removed,
      replay: false,
      fencedGrantOperationId: request.cancelGrantOperationId,
    };
    await record(tx, command, { ...result, workspaceId: scope.workspaceId });
    return result;
  });
}
