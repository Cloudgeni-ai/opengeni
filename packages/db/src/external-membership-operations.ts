import { sql } from "drizzle-orm";
import { z } from "zod";
import { organizationAccessPresetPermissions, type Permission } from "@opengeni/contracts";
import { permissionSetCovers } from "@opengeni/contracts/personal-integration-setup";
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
import {
  grantWorkspaceAccess,
  insertWorkspaceMembershipIfAbsent,
  listWorkspaceMembers,
} from "./workspace-membership-access";
import { removeWorkspaceMember } from "./organization-membership-lifecycle";
import { normalizeWorkspaceMembershipPermissions } from "./workspace-membership-permissions";
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
): Promise<{ permissions: Permission[]; permissionMode: "legacy" | "explicit" }> {
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
      (requested.some((permission) => !permissionSetCovers(authority.permissions, permission)) ||
        (requested.includes("workspace:admin") &&
          organizationAccessPresetPermissions("full").some(
            (permission) =>
              !accountOnlyPermissions.has(permission) &&
              !permissionSetCovers(authority.permissions, permission),
          ))))
  ) {
    throw Object.assign(new Error("External membership organization key authority changed"), {
      code: "42501",
    });
  }
  return authority;
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

/** SDK-provisioned per-user workspaces stay single-user: never auto-admitted. */
export const USER_ISOLATION_WORKSPACE_SOURCE_PREFIX = "opengeni-sdk:user-isolation:";

/**
 * First-use membership for an organization key acting as an external user
 * (`asUser`). This is the explicit keyed onboarding effect, not new authority:
 * the same organization lifecycle fence, the same live key check
 * (`members:manage`, or a legacy `workspace:admin` key, holding every requested
 * permission, with the workspace in the key's scope), the same in-database
 * identity re-check (`ensure_external_identity` locks the identity and its
 * organization membership and requires both active), and the same receipt and
 * lifecycle event attributed to the key. It only inserts a missing row (insert
 * ... on conflict do nothing): an existing membership is returned unchanged.
 * There is no tombstone: a member removed from a shared workspace is created
 * again on their next request, because the host owns its users. Personal and
 * SDK per-user (`opengeni-sdk:user-isolation:*`) workspaces are refused.
 * Concurrent first requests serialize on the organization fence.
 */
export async function ensureExternalWorkspaceMemberOnFirstUse(
  db: Database,
  scope: ServiceScope & { workspaceId: string },
  input: {
    subjectId: string;
    identity: { source: string; externalId: string };
    permissions: readonly Permission[];
  },
): Promise<"created" | "existing"> {
  const permissions = [...new Set(input.permissions)].sort();
  const refuse = (message: string): never => {
    throw Object.assign(new Error(message), { code: "42501" });
  };
  return withWorkspaceSubjectRls(db, scope.workspaceId, scope.actorSubjectId, async (tx) => {
    const authority = await requireLiveServiceKey(tx, scope, permissions);
    if (
      authority.permissionMode === "legacy" &&
      !authority.permissions.includes("workspace:admin") &&
      permissions.some((permission) => !permissionSetCovers(authority.permissions, permission))
    )
      refuse("External membership exceeds organization key authority");
    const [workspace] = await rawRows<{ account_id: string; external_source: string | null }>(
      tx,
      sql`select account_id, external_source from workspaces where id = ${scope.workspaceId}::uuid`,
    );
    if (
      !workspace ||
      workspace.account_id !== scope.organizationId ||
      workspace.external_source?.startsWith(USER_ISOLATION_WORKSPACE_SOURCE_PREFIX)
    )
      refuse("Workspace does not admit members on first use");
    const existing = (await listWorkspaceMembers(tx, scope.workspaceId)).some(
      (member) => member.subjectId === input.subjectId,
    );
    if (existing) return "existing";
    const command = {
      ...scope,
      action: "grant",
      identity: input.identity,
      permissions,
      operationId: crypto.randomUUID(),
    };
    // Re-validates the identity and its organization membership under the
    // fence (suspended/offboarded -> 42501) and refuses Personal workspaces.
    const prepared = await prepare(tx, command);
    const identity = ExternalIdentity.parse(prepared.identity);
    if (identity.subjectId !== input.subjectId || identity.status !== "active")
      refuse("External identity changed");
    const inserted = await insertWorkspaceMembershipIfAbsent(tx, {
      accountId: scope.organizationId,
      workspaceId: scope.workspaceId,
      subjectId: input.subjectId,
      role: "member",
      permissions,
    });
    if (!inserted) return "existing";
    await record(tx, command, { workspaceId: scope.workspaceId, identity });
    return "created";
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
    // The removal also stamps the revocation marker under the fence, even
    // when no row was removed: a request that authenticated before this
    // revoke must not create the member afterwards.
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

/** Revocation markers order an app's revoke against requests that state a
 * membership. Both run under the organization membership fence, so the last
 * value read there when a request authenticates is a strict watermark: every
 * revoke committed before it is at or below it, every later revoke above. */
export async function readExternalWorkspaceRevocationWatermark(tx: Database): Promise<string> {
  const [row] = await rawRows<{ watermark: string }>(
    tx,
    sql`select coalesce(pg_sequence_last_value('external_workspace_member_revocation_seq'::regclass), 0)::text as watermark`,
  );
  if (!row) throw new Error("External workspace revocation watermark was not read");
  return row.watermark;
}

/** The audit reason recorded on receipts written for a stated membership. */
export const STATED_EXTERNAL_MEMBERSHIP_REASON = "membership stated by request";

/** A stated narrowing would leave the workspace without an administering member. */
export class StatedExternalMembershipLastAdminError extends Error {
  constructor() {
    super("the workspace must keep at least one administrator");
    this.name = "StatedExternalMembershipLastAdminError";
  }
}

export type StatedExternalWorkspaceMembershipOutcome =
  /** The stored grant already equals the stated one; nothing was written. */
  | "unchanged"
  | "created"
  | "updated"
  /** The app revoked this member after the request authenticated, so the
   * request's older statement writes nothing and the stored state stands. */
  | "superseded";

const administers = (permissions: readonly string[]): boolean =>
  permissions.includes("workspace:admin") || permissions.includes("members:manage");

/**
 * Make an external member's grant in one shared workspace exactly the
 * permissions its app stated on this request. The same authority as the
 * keyed external-members grant and update: the organization lifecycle fence,
 * the live key check (`members:manage`, or a legacy `workspace:admin` key,
 * covering every stated permission under its policy, with the workspace in
 * scope), the database's own grant ceiling (literal `secrets:read`, no
 * permission outside a non-admin key), the identity's active status, and the
 * same receipts and lifecycle events attributed to the key, with
 * {@link STATED_EXTERNAL_MEMBERSHIP_REASON} as the reason. Narrowing advances
 * the member's authorization revision exactly like the keyed update.
 *
 * Writes only when the stored grant differs, after re-reading it under the
 * fence, so concurrent equal statements write once. A revoke stamped after
 * `revocationWatermark` (read when the request authenticated) wins: the
 * statement is `superseded` and nothing is created or changed. Never narrows
 * the workspace's last administering member. Personal and SDK per-user
 * workspaces are refused (42501).
 */
export async function applyStatedExternalWorkspaceMembership(
  db: Database,
  scope: ServiceScope & { workspaceId: string },
  input: {
    identity: ExternalIdentity;
    permissions: readonly Permission[];
    revocationWatermark: string;
  },
): Promise<StatedExternalWorkspaceMembershipOutcome> {
  const permissions = [...new Set(input.permissions)].sort();
  const refuse = (message: string): never => {
    throw Object.assign(new Error(message), { code: "42501" });
  };
  return withWorkspaceSubjectRls(db, scope.workspaceId, scope.actorSubjectId, async (tx) => {
    await requireLiveServiceKey(tx, scope, permissions);
    // Personal workspaces are refused by the operation's own preparation.
    const [workspace] = await rawRows<{ account_id: string; external_source: string | null }>(
      tx,
      sql`select account_id, external_source from workspaces where id = ${scope.workspaceId}::uuid`,
    );
    if (
      !workspace ||
      workspace.account_id !== scope.organizationId ||
      workspace.external_source?.startsWith(USER_ISOLATION_WORKSPACE_SOURCE_PREFIX)
    )
      refuse("Workspace does not admit stated membership");
    const subjectId = input.identity.subjectId;
    // The administering roster and the target, locked in id order like the
    // native member update, so the last-admin check holds until commit.
    const roster = await rawRows<{ subject_id: string; permissions: unknown }>(
      tx,
      sql`select subject_id, permissions from workspace_memberships
        where workspace_id = ${scope.workspaceId}::uuid
          and (subject_id = ${subjectId}
            or permissions ?| array['workspace:admin', 'members:manage'])
        order by id for update`,
    );
    const existingRow = roster.find((member) => member.subject_id === subjectId);
    const existing = existingRow
      ? normalizeWorkspaceMembershipPermissions(existingRow.permissions)
      : null;
    if (
      existing &&
      existing.length === permissions.length &&
      existing.every((permission) => permissions.includes(permission))
    )
      return "unchanged";
    const [revocation] = await rawRows<{ newer: boolean }>(
      tx,
      sql`select revocation_sequence > ${input.revocationWatermark}::bigint as newer
        from external_workspace_member_revocations
        where account_id = ${scope.organizationId}::uuid
          and workspace_id = ${scope.workspaceId}::uuid and subject_id = ${subjectId}`,
    );
    if (revocation?.newer) return "superseded";
    if (!existing) {
      const command = {
        ...scope,
        action: "grant",
        identity: { source: input.identity.source, externalId: input.identity.externalId },
        permissions,
        operationId: crypto.randomUUID(),
      };
      // Re-validates the identity and its organization membership under the
      // fence (suspended/offboarded -> 42501) and the grant ceiling.
      const prepared = await prepare(tx, command);
      const identity = ExternalIdentity.parse(prepared.identity);
      if (identity.subjectId !== subjectId || identity.status !== "active")
        refuse("External identity changed");
      const inserted = await insertWorkspaceMembershipIfAbsent(tx, {
        accountId: scope.organizationId,
        workspaceId: scope.workspaceId,
        subjectId,
        role: "member",
        permissions,
      });
      if (!inserted) throw new Error("Stated membership row appeared under the fence");
      await record(tx, command, {
        workspaceId: scope.workspaceId,
        identity,
        reason: STATED_EXTERNAL_MEMBERSHIP_REASON,
      });
      return "created";
    }
    if (
      administers(existing) &&
      !administers(permissions) &&
      !roster.some(
        (member) =>
          member.subject_id !== subjectId &&
          administers(normalizeWorkspaceMembershipPermissions(member.permissions)),
      )
    )
      throw new StatedExternalMembershipLastAdminError();
    const command = {
      ...scope,
      membershipId: input.identity.organizationMembershipId,
      action: "update",
      operationId: crypto.randomUUID(),
      permissions,
    };
    const prepared = await prepare(tx, command);
    const identity = z
      .object({ subjectId: z.string(), organizationMembershipId: z.string() })
      .parse(prepared.identity);
    if (identity.subjectId !== subjectId) refuse("External identity changed");
    await record(tx, command, {
      workspaceId: scope.workspaceId,
      identity,
      permissions,
      narrowed: existing.some((permission) => !permissions.includes(permission)),
      reason: STATED_EXTERNAL_MEMBERSHIP_REASON,
    });
    return "updated";
  });
}
