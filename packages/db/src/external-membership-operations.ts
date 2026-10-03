import { sql } from "drizzle-orm";
import { z } from "zod";
import { organizationAccessPresetPermissions, type Permission } from "@opengeni/contracts";
import {
  ExternalIdentity,
  ExternalIdentityLookup,
  CancelExternalWorkspaceMemberGrantResponse,
  type AddExternalWorkspaceMemberRequest,
  type CancelExternalWorkspaceMemberGrantRequest,
  UpdateExternalWorkspaceMemberResponse,
  type UpdateExternalWorkspaceMemberRequest,
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
import {
  lockActiveExternalOrganizationKeyAuthority,
  lockExternalWorkspaceMembershipLifecycle,
} from "./external-identities";

type ServiceScope = { organizationId: string; actorSubjectId: string };

// These organization-only grants cannot be delegated by workspace membership.
const accountOnlyPermissions = new Set<Permission>([
  "account:read",
  "account:admin",
  "workspace:create",
  "billing:read",
  "billing:manage",
  "usage_allowances:manage",
]);

/** Retain the canonical organization/key lock order through receipt and effect.
 * Scope is read after the key lock, including on exact operation replays. */
async function requireLiveServiceKey(
  tx: Database,
  scope: ServiceScope & { workspaceId?: string },
  requested: readonly Permission[] = [],
) {
  const keyId = /^api_key:([0-9a-f-]{36})$/i.exec(scope.actorSubjectId)?.[1];
  await lockExternalWorkspaceMembershipLifecycle(tx, scope.organizationId);
  const authority = keyId
    ? await lockActiveExternalOrganizationKeyAuthority(
        tx,
        scope.organizationId,
        keyId,
        scope.workspaceId,
      )
    : null;
  if (
    !authority ||
    !(
      authority.permissions.includes("members:manage") ||
      (authority.permissionMode === "legacy" && authority.permissions.includes("workspace:admin"))
    ) ||
    (authority.permissionMode === "explicit" &&
      (requested.some((permission) => !authority.permissions.includes(permission)) ||
        (requested.includes("workspace:admin") &&
          organizationAccessPresetPermissions("full").some(
            (permission) =>
              !accountOnlyPermissions.has(permission) &&
              !authority.permissions.includes(permission),
          ))))
  ) {
    throw Object.assign(new Error("External membership organization key authority changed"), {
      code: "42501",
    });
  }
}

export async function lookupExternalIdentity(
  db: Database,
  scope: ServiceScope,
  identity: ExternalIdentityReference,
) {
  return withAccountRls(db, scope.organizationId, async (tx) => {
    await setSubjectRlsContext(tx, scope.actorSubjectId);
    await requireLiveServiceKey(tx, scope);
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
    await requireLiveServiceKey(tx, scope, command.permissions);
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
    await requireLiveServiceKey(tx, scope);
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

/** One keyed permission update of an existing external member's workspace
 * access. The database applies the effect under the organization fence and
 * advances the member's authorization revision when the set narrows, so live
 * authority snapshots re-check; nothing is cancelled or torn down. A replay
 * returns the original receipt even after later changes. */
export async function updateExternalWorkspaceMemberOperation(
  db: Database,
  scope: ServiceScope & { workspaceId: string; membershipId: string },
  request: UpdateExternalWorkspaceMemberRequest,
) {
  const command = {
    ...scope,
    action: "update",
    operationId: request.operationId,
    permissions: [...new Set(request.permissions)].sort(),
  };
  return withWorkspaceSubjectRls(db, scope.workspaceId, scope.actorSubjectId, async (tx) => {
    await requireLiveServiceKey(tx, scope, command.permissions);
    const prepared = await prepare(tx, command);
    if (prepared.replay) {
      const stored = z
        .object({
          identity: z.object({ subjectId: z.string(), organizationMembershipId: z.string() }),
          permissions: z.array(z.string()),
          narrowed: z.boolean(),
        })
        .parse(prepared.result);
      return UpdateExternalWorkspaceMemberResponse.parse({
        subjectId: stored.identity.subjectId,
        organizationMembershipId: stored.identity.organizationMembershipId,
        permissions: stored.permissions,
        narrowed: stored.narrowed,
        replay: true,
      });
    }
    const identity = z
      .object({ subjectId: z.string(), organizationMembershipId: z.string() })
      .parse(prepared.identity);
    const existing = (await listWorkspaceMembers(tx, scope.workspaceId)).find(
      (member) => member.subjectId === identity.subjectId,
    );
    if (!existing) {
      await tx.execute(
        sql`do $$ begin raise exception 'external workspace member not found' using errcode = 'P0002'; end $$`,
      );
    }
    const narrowed = (existing?.permissions ?? []).some(
      (permission) => !command.permissions.includes(permission),
    );
    const result = {
      workspaceId: scope.workspaceId,
      identity,
      permissions: command.permissions,
      narrowed,
    };
    await record(tx, command, result);
    return UpdateExternalWorkspaceMemberResponse.parse({
      subjectId: identity.subjectId,
      organizationMembershipId: identity.organizationMembershipId,
      permissions: command.permissions,
      narrowed,
      replay: false,
    });
  });
}
