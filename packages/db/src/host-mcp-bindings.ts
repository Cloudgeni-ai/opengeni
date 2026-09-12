import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { stableJson, type McpCredentialsRequest } from "@opengeni/contracts";
import { getHostMcpLiveAttempt } from "./live-session-attempt";
import { hostMcpBindingMatchesRequest } from "./host-mcp-binding-match";
import {
  HostMcpBinding,
  CreateHostMcpBindingRequest,
  HostMcpDelegation,
  IssueHostMcpDelegationRequest,
  HostMcpAcceptedAuthority,
  HostMcpOwnerSubject,
  hostMcpBindingMatchesSelection,
} from "@opengeni/contracts/host-mcp-bindings";
import { rawRows, withWorkspaceSubjectRls, type Database } from "./database";
import { listSelfOrganizationMemberships } from "./organization-membership-lifecycle";
import { lockExternalWorkspaceMembershipLifecycle } from "./external-identities";
import { subjectHasLiveWorkspaceAuthorityInScope } from "./workspace-authority";

export type HostMcpBindingOwner = {
  accountId: string;
  workspaceId: string;
  subjectId: string;
  authorizationRevision: number;
};

/** Resolve the effective member's revision, not the authenticating external
 * identity revision. Caller must separately prove its authority to act as them. */
export async function resolveHostMcpBindingOwner(
  db: Database,
  input: Omit<HostMcpBindingOwner, "authorizationRevision">,
): Promise<HostMcpBindingOwner> {
  if (!HostMcpOwnerSubject.safeParse(input.subjectId).success)
    throw new HostMcpDelegationAuthorityError("Host owner unavailable");
  return withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (tx) => {
    await lockExternalWorkspaceMembershipLifecycle(tx, input.accountId);
    const membership = (await listSelfOrganizationMemberships(tx, input.subjectId)).find(
      (value) => value.organizationId === input.accountId,
    );
    if (
      !membership ||
      membership.status !== "active" ||
      !(await subjectHasLiveWorkspaceAuthorityInScope(tx, input))
    )
      throw new HostMcpDelegationAuthorityError("Host owner unavailable");
    return { ...input, authorizationRevision: membership.authorizationRevision };
  });
}
export class HostMcpBindingConflictError extends Error {
  constructor() {
    super("Host binding changed or operation conflicts");
    this.name = "HostMcpBindingConflictError";
  }
}
export class HostMcpDelegationAuthorityError extends Error {}
type Row = {
  id: string;
  account_id: string;
  workspace_id: string;
  owner_subject_id: string;
  authorization_revision: number | string;
  generation: number | string;
  status: string;
  definition: unknown;
  created_at: Date | string;
  revoked_at: Date | string | null;
  request_digest: string;
};
const timestamp = (value: Date | string) => new Date(value).toISOString();
function project(row: Row): HostMcpBinding {
  return HostMcpBinding.parse({
    id: row.id,
    accountId: row.account_id,
    workspaceId: row.workspace_id,
    ownerSubjectId: row.owner_subject_id,
    authorizationRevision: Number(row.authorization_revision),
    generation: Number(row.generation),
    status: row.status,
    definition: row.definition,
    createdAt: timestamp(row.created_at),
    revokedAt: row.revoked_at === null ? null : timestamp(row.revoked_at),
  });
}

async function scoped<T>(
  db: Database,
  owner: HostMcpBindingOwner,
  operation: (tx: Database) => Promise<T>,
): Promise<T> {
  return withWorkspaceSubjectRls(db, owner.workspaceId, owner.subjectId, async (tx) => {
    await lockExternalWorkspaceMembershipLifecycle(tx, owner.accountId);
    const memberships = await listSelfOrganizationMemberships(tx, owner.subjectId);
    const membership = memberships.find((item) => item.organizationId === owner.accountId);
    if (
      !HostMcpOwnerSubject.safeParse(owner.subjectId).success ||
      !membership ||
      membership.status !== "active" ||
      membership.authorizationRevision !== owner.authorizationRevision
    )
      throw new Error("Host binding owner authority unavailable");
    return operation(tx);
  });
}

/** Low-level persistence, not HTTP authentication. Callers must establish the
 * exact external owner and workspace grant before entering this scoped seam. */
export async function createHostMcpBinding(
  db: Database,
  owner: HostMcpBindingOwner,
  raw: unknown,
): Promise<HostMcpBinding> {
  const input = CreateHostMcpBindingRequest.parse(raw);
  const digest = createHash("sha256").update(stableJson(input.definition)).digest("hex");
  return scoped(db, owner, async (tx) => {
    await tx.execute(sql`insert into host_mcp_bindings (id, account_id, workspace_id, owner_subject_id, authorization_revision, operation_id, request_digest, definition)
      values (${randomUUID()}::uuid, ${owner.accountId}::uuid, ${owner.workspaceId}::uuid, ${owner.subjectId}, ${owner.authorizationRevision}, ${input.operationId}::uuid, ${digest}, ${JSON.stringify(input.definition)}::jsonb)
      on conflict (workspace_id, owner_subject_id, operation_id) do nothing`);
    const [row] = await rawRows<Row>(
      tx,
      sql`select * from host_mcp_bindings where workspace_id = ${owner.workspaceId}::uuid and owner_subject_id = ${owner.subjectId} and operation_id = ${input.operationId}::uuid`,
    );
    if (!row || row.request_digest !== digest) throw new HostMcpBindingConflictError();
    return project(row);
  });
}

export async function getHostMcpBinding(
  db: Database,
  owner: HostMcpBindingOwner,
  id: string,
): Promise<HostMcpBinding | null> {
  return scoped(db, owner, async (tx) => {
    const [row] = await rawRows<Row>(
      tx,
      sql`select * from host_mcp_bindings where id = ${id}::uuid and account_id = ${owner.accountId}::uuid and workspace_id = ${owner.workspaceId}::uuid and owner_subject_id = ${owner.subjectId}`,
    );
    return row ? project(row) : null;
  });
}

export async function revokeHostMcpBinding(
  db: Database,
  owner: HostMcpBindingOwner,
  id: string,
  expectedGeneration: number,
): Promise<HostMcpBinding> {
  if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 1)
    throw new Error("Invalid binding generation");
  return scoped(db, owner, async (tx) => {
    const [row] = await rawRows<Row>(
      tx,
      sql`select * from host_mcp_bindings where id = ${id}::uuid and account_id = ${owner.accountId}::uuid and workspace_id = ${owner.workspaceId}::uuid and owner_subject_id = ${owner.subjectId} for update`,
    );
    if (!row) throw new Error("Host binding unavailable");
    const current = project(row);
    if (current.status === "revoked" && current.generation === expectedGeneration + 1)
      return current;
    if (current.status !== "active" || current.generation !== expectedGeneration)
      throw new HostMcpBindingConflictError();
    const [updated] = await rawRows<Row>(
      tx,
      sql`update host_mcp_bindings set status = 'revoked', generation = generation + 1, revoked_at = clock_timestamp() where id = ${id}::uuid returning *`,
    );
    if (!updated) throw new Error("Host binding unavailable");
    return project(updated);
  });
}

type DelegationRow = {
  id: string;
  account_id: string;
  workspace_id: string;
  owner_subject_id: string;
  owner_authorization_revision: number | string;
  binding_id: string;
  binding_generation: number | string;
  grant_definition: unknown;
  generation: number | string;
  status: string;
  created_at: Date | string;
  revoked_at: Date | string | null;
  request_digest: string;
};
function projectDelegation(row: DelegationRow): HostMcpDelegation {
  return HostMcpDelegation.parse({
    id: row.id,
    accountId: row.account_id,
    workspaceId: row.workspace_id,
    ownerSubjectId: row.owner_subject_id,
    ownerAuthorizationRevision: Number(row.owner_authorization_revision),
    bindingId: row.binding_id,
    bindingGeneration: Number(row.binding_generation),
    grant: row.grant_definition,
    generation: Number(row.generation),
    status: row.status,
    createdAt: timestamp(row.created_at),
    revokedAt: row.revoked_at === null ? null : timestamp(row.revoked_at),
  });
}

/** Internal persistence only. Caller must first verify owner identity and grant
 * issuance permission. No worker consumes these rows without accepted-work capture. */
export async function issueHostMcpDelegation(
  db: Database,
  owner: HostMcpBindingOwner,
  raw: unknown,
): Promise<HostMcpDelegation> {
  const input = IssueHostMcpDelegationRequest.parse(raw);
  const digest = createHash("sha256").update(stableJson(input)).digest("hex");
  return scoped(db, owner, async (tx) => {
    if (!(await subjectHasLiveWorkspaceAuthorityInScope(tx, owner)))
      throw new HostMcpDelegationAuthorityError("Host delegation workspace unavailable");
    // Serialize operation replays without re-running INSERT guards on a revoked binding.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`host-delegation:${owner.workspaceId}:${owner.subjectId}:${input.operationId}`}, 0))`,
    );
    const [prior] = await rawRows<DelegationRow>(
      tx,
      sql`select * from host_mcp_delegations where workspace_id = ${owner.workspaceId}::uuid and owner_subject_id = ${owner.subjectId} and operation_id = ${input.operationId}::uuid`,
    );
    if (prior) {
      if (prior.request_digest !== digest) throw new HostMcpBindingConflictError();
      return projectDelegation(prior);
    }
    const [binding] = await rawRows<Row>(
      tx,
      sql`select * from host_mcp_bindings where id = ${input.bindingId}::uuid and account_id = ${owner.accountId}::uuid and workspace_id = ${owner.workspaceId}::uuid and owner_subject_id = ${owner.subjectId} for share`,
    );
    if (
      !binding ||
      binding.status !== "active" ||
      Number(binding.generation) !== input.expectedBindingGeneration ||
      Number(binding.authorization_revision) !== owner.authorizationRevision
    )
      throw new HostMcpBindingConflictError();
    if (input.grant.sessionId) {
      const [session] = await rawRows<{
        visibility: string;
        authority_epoch: number;
        owner_subject_id: string | null;
      }>(
        tx,
        sql`select visibility, authority_epoch, owner_subject_id from sessions where id = ${input.grant.sessionId}::uuid and workspace_id = ${owner.workspaceId}::uuid and account_id = ${owner.accountId}::uuid for share`,
      );
      if (
        !session ||
        session.visibility !== input.grant.context ||
        session.authority_epoch !== input.grant.expectedAuthorityEpoch ||
        (session.visibility === "user_private" && session.owner_subject_id !== owner.subjectId)
      )
        throw new HostMcpDelegationAuthorityError("Host delegation session authority unavailable");
    } else if (input.grant.expectedAuthorityEpoch != null)
      throw new HostMcpDelegationAuthorityError("Host delegation epoch requires a session");
    const [row] = await rawRows<DelegationRow>(
      tx,
      sql`insert into host_mcp_delegations (id, account_id, workspace_id, owner_subject_id, owner_authorization_revision, binding_id, binding_generation, operation_id, request_digest, grant_definition)
      values (${randomUUID()}::uuid, ${owner.accountId}::uuid, ${owner.workspaceId}::uuid, ${owner.subjectId}, ${owner.authorizationRevision}, ${input.bindingId}::uuid, ${input.expectedBindingGeneration}, ${input.operationId}::uuid, ${digest}, ${JSON.stringify(input.grant)}::jsonb) returning *`,
    );
    if (!row) throw new Error("Host delegation unavailable");
    return projectDelegation(row);
  });
}

export async function getHostMcpDelegation(
  db: Database,
  owner: HostMcpBindingOwner,
  id: string,
): Promise<HostMcpDelegation | null> {
  return scoped(db, owner, async (tx) => {
    const [row] = await rawRows<DelegationRow>(
      tx,
      sql`select * from host_mcp_delegations where id = ${id}::uuid and account_id = ${owner.accountId}::uuid and workspace_id = ${owner.workspaceId}::uuid and owner_subject_id = ${owner.subjectId}`,
    );
    return row ? projectDelegation(row) : null;
  });
}

export async function revokeHostMcpDelegation(
  db: Database,
  owner: HostMcpBindingOwner,
  id: string,
  expectedGeneration: number,
): Promise<HostMcpDelegation> {
  if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 1)
    throw new Error("Invalid delegation generation");
  return scoped(db, owner, async (tx) => {
    const [row] = await rawRows<DelegationRow>(
      tx,
      sql`select * from host_mcp_delegations where id = ${id}::uuid and account_id = ${owner.accountId}::uuid and workspace_id = ${owner.workspaceId}::uuid and owner_subject_id = ${owner.subjectId} for update`,
    );
    if (!row) throw new Error("Host delegation unavailable");
    const current = projectDelegation(row);
    if (current.status === "revoked" && current.generation === expectedGeneration + 1)
      return current;
    if (current.status !== "active" || current.generation !== expectedGeneration)
      throw new HostMcpBindingConflictError();
    const [updated] = await rawRows<DelegationRow>(
      tx,
      sql`update host_mcp_delegations set status = 'revoked', generation = generation + 1, revoked_at = clock_timestamp() where id = ${id}::uuid returning *`,
    );
    if (!updated) throw new Error("Host delegation unavailable");
    return projectDelegation(updated);
  });
}

/** Internal direct-admission boundary, NOT authentication and NOT persistence.
 * The caller must establish a verified external owner and explicit selection,
 * and capture the returned authority with accepted work INSIDE `capture`.
 * Locks remain held through that callback. Historical initiator metadata only
 * narrows the verified caller's selection; it never establishes who called.
 * Schedules, continuations and inherited turns need their own frozen causal
 * authority path and deliberately cannot use this direct-only boundary.
 */
export async function withDirectHostMcpAdmission<T>(
  db: Database,
  owner: HostMcpBindingOwner,
  input: {
    sessionId: string;
    turnId: string;
    delegationId: string;
    expectedDelegationGeneration: number;
  },
  capture: (tx: Database, authority: HostMcpAcceptedAuthority) => Promise<T>,
): Promise<T> {
  if (
    !Number.isSafeInteger(input.expectedDelegationGeneration) ||
    input.expectedDelegationGeneration < 1
  )
    throw new HostMcpDelegationAuthorityError("Invalid host admission generation");
  return scoped(db, owner, async (tx) => {
    const deny = (): never => {
      throw new HostMcpDelegationAuthorityError("Host direct admission unavailable");
    };
    if (!(await subjectHasLiveWorkspaceAuthorityInScope(tx, owner))) deny();
    const membership = (await listSelfOrganizationMemberships(tx, owner.subjectId)).find(
      (value) => value.organizationId === owner.accountId,
    );
    if (
      !membership ||
      membership.status !== "active" ||
      membership.authorizationRevision !== owner.authorizationRevision
    )
      return deny();
    const [session] = await rawRows<{
      visibility: "user_private" | "workspace_shared";
      authority_epoch: number;
      owner_subject_id: string | null;
    }>(
      tx,
      sql`select visibility, authority_epoch, owner_subject_id from sessions where id = ${input.sessionId}::uuid and account_id = ${owner.accountId}::uuid and workspace_id = ${owner.workspaceId}::uuid for update`,
    );
    if (
      !session ||
      (session.visibility === "user_private" && session.owner_subject_id !== owner.subjectId)
    )
      return deny();
    const [turn] = await rawRows<{ id: string }>(
      tx,
      sql`
      select id from session_turns where id = ${input.turnId}::uuid
        and session_id = ${input.sessionId}::uuid and account_id = ${owner.accountId}::uuid and workspace_id = ${owner.workspaceId}::uuid
        and status = 'queued' and active_attempt_id is null and source in ('user', 'api')
        and initiator_kind = 'subject' and initiator_subject_id = ${owner.subjectId}
        and (initiating_human_subject_id is null or initiating_human_subject_id = ${owner.subjectId})
        and not (initiator_context ?| array['via','viaTruncated','provenanceError','backfill'])
        and not exists (select 1 from session_turn_attempts a where a.turn_id = session_turns.id and a.workspace_id = session_turns.workspace_id)
      for update`,
    );
    if (!turn) return deny();
    const [row] = await rawRows<DelegationRow>(
      tx,
      sql`select * from host_mcp_delegations where id = ${input.delegationId}::uuid and account_id = ${owner.accountId}::uuid and workspace_id = ${owner.workspaceId}::uuid and owner_subject_id = ${owner.subjectId} for share`,
    );
    if (!row) return deny();
    const delegation = projectDelegation(row);
    if (
      delegation.status !== "active" ||
      delegation.revokedAt !== null ||
      delegation.generation !== input.expectedDelegationGeneration ||
      delegation.ownerAuthorizationRevision !== owner.authorizationRevision ||
      delegation.grant.context !== session.visibility
    )
      return deny();
    if (
      delegation.grant.mode === "session" &&
      (delegation.grant.sessionId !== input.sessionId ||
        delegation.grant.expectedAuthorityEpoch !== session.authority_epoch)
    )
      return deny();
    const [bindingRow] = await rawRows<Row>(
      tx,
      sql`select * from host_mcp_bindings where id = ${delegation.bindingId}::uuid and account_id = ${owner.accountId}::uuid and workspace_id = ${owner.workspaceId}::uuid and owner_subject_id = ${owner.subjectId} for share`,
    );
    if (!bindingRow) return deny();
    const binding = project(bindingRow);
    if (
      binding.status !== "active" ||
      binding.revokedAt !== null ||
      binding.generation !== delegation.bindingGeneration ||
      binding.authorizationRevision !== owner.authorizationRevision
    )
      return deny();
    const authority = HostMcpAcceptedAuthority.parse({
      version: 1,
      accountId: owner.accountId,
      workspaceId: owner.workspaceId,
      targetSessionId: input.sessionId,
      targetSessionVisibility: session.visibility,
      targetSessionAuthorityEpoch: session.authority_epoch,
      acceptedWork: { kind: "turn", turnId: turn.id },
      bindingId: binding.id,
      bindingGeneration: binding.generation,
      definition: binding.definition,
      ownerSubjectId: owner.subjectId,
      ownerOrganizationMembershipId: membership.id,
      ownerMembershipAuthorizationRevision: membership.authorizationRevision,
      delegationId: delegation.id,
      delegationGeneration: delegation.generation,
      source: { kind: "direct" },
    });
    return capture(tx, authority);
  });
}

/** Internal direct-turn persistence. The authenticated acceptance transaction
 * must call this before claim; this does not authenticate the supplied owner.
 * Exact replay is allowed, but a turn/server selection cannot be replaced. */
export async function captureDirectHostMcpAuthority(
  db: Database,
  owner: HostMcpBindingOwner,
  input: Parameters<typeof withDirectHostMcpAdmission>[2],
): Promise<HostMcpAcceptedAuthority> {
  return withDirectHostMcpAdmission(db, owner, input, async (tx, authority) => {
    await tx.execute(sql`insert into host_mcp_turn_authorities
      (turn_id, server_id, account_id, workspace_id, session_id, owner_subject_id, binding_id, delegation_id, canonical_snapshot)
      values (${input.turnId}::uuid, ${authority.definition.serverId}, ${owner.accountId}::uuid,
        ${owner.workspaceId}::uuid, ${input.sessionId}::uuid, ${owner.subjectId},
        ${authority.bindingId}::uuid, ${authority.delegationId}::uuid, ${JSON.stringify(authority)}::jsonb)
      on conflict (turn_id, server_id) do nothing`);
    const [stored] = await rawRows<{ canonical_snapshot: unknown }>(
      tx,
      sql`
      select canonical_snapshot from host_mcp_turn_authorities where turn_id = ${input.turnId}::uuid
        and server_id = ${authority.definition.serverId} and account_id = ${owner.accountId}::uuid
        and workspace_id = ${owner.workspaceId}::uuid and owner_subject_id = ${owner.subjectId}`,
    );
    if (!stored || stableJson(stored.canonical_snapshot) !== stableJson(authority))
      throw new HostMcpBindingConflictError();
    return HostMcpAcceptedAuthority.parse(stored.canonical_snapshot);
  });
}

/** Copy only the authority of an exact causal turn after its canonical machine
 * update has been delivered. The insert trigger independently proves delivery,
 * live generations and byte-equivalent authority; no creator fallback exists.
 * Revoked selections are omitted, allowing a continuation to explain loss of
 * access without making its whole session permanently unclaimable. */
export async function inheritCausalHostMcpTurnAuthorities(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    subjectId: string;
    sourceTurnId: string;
    targetTurnId: string;
  },
): Promise<void> {
  if (
    !HostMcpOwnerSubject.safeParse(input.subjectId).success ||
    input.sourceTurnId === input.targetTurnId
  )
    return;
  await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (tx) => {
    await lockExternalWorkspaceMembershipLifecycle(tx, input.accountId);
    const membership = (await listSelfOrganizationMemberships(tx, input.subjectId)).find(
      (m) => m.organizationId === input.accountId && m.status === "active",
    );
    if (!membership || !(await subjectHasLiveWorkspaceAuthorityInScope(tx, input))) return;
    const rows = await rawRows<{ canonical_snapshot: unknown }>(
      tx,
      sql`
      select a.canonical_snapshot from host_mcp_turn_authorities a
      join host_mcp_delegations d on d.id = a.delegation_id
      join host_mcp_bindings b on b.id = a.binding_id
      join sessions s on s.id = a.session_id
      where a.account_id = ${input.accountId}::uuid and a.workspace_id = ${input.workspaceId}::uuid
        and a.session_id = ${input.sessionId}::uuid and a.turn_id = ${input.sourceTurnId}::uuid
        and a.owner_subject_id = ${input.subjectId}
        and d.status = 'active' and b.status = 'active'
        and d.revoked_at is null and b.revoked_at is null
        and d.generation::text = a.canonical_snapshot ->> 'delegationGeneration'
        and b.generation::text = a.canonical_snapshot ->> 'bindingGeneration'
        and s.authority_epoch::text = a.canonical_snapshot ->> 'targetSessionAuthorityEpoch'
        and s.visibility = a.canonical_snapshot ->> 'targetSessionVisibility'
        and d.owner_authorization_revision = ${membership.authorizationRevision}
        and a.canonical_snapshot ->> 'ownerOrganizationMembershipId' = ${membership.id}
      for share of d, b`,
    );
    for (const row of rows) {
      const prior = HostMcpAcceptedAuthority.parse(row.canonical_snapshot);
      const authority = HostMcpAcceptedAuthority.parse({
        ...prior,
        acceptedWork: { kind: "turn", turnId: input.targetTurnId },
        source: { kind: "inherited_turn", sessionId: input.sessionId, turnId: input.sourceTurnId },
      });
      await tx.execute(sql`insert into host_mcp_turn_authorities
        (turn_id, server_id, account_id, workspace_id, session_id, owner_subject_id, binding_id, delegation_id, canonical_snapshot)
        values (${input.targetTurnId}::uuid, ${authority.definition.serverId}, ${input.accountId}::uuid,
          ${input.workspaceId}::uuid, ${input.sessionId}::uuid, ${input.subjectId},
          ${authority.bindingId}::uuid, ${authority.delegationId}::uuid, ${JSON.stringify(authority)}::jsonb)`);
    }
  });
}

/** Initial child turn only. The stored parent-turn pointer was admitted by the
 * native signed-attempt creation boundary; caller metadata never chooses it. */
export async function inheritChildHostMcpTurnAuthorities(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    turnId: string;
    subjectId: string;
  },
): Promise<void> {
  if (!HostMcpOwnerSubject.safeParse(input.subjectId).success) return;
  await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (tx) => {
    await lockExternalWorkspaceMembershipLifecycle(tx, input.accountId);
    const membership = (await listSelfOrganizationMemberships(tx, input.subjectId)).find(
      (m) => m.organizationId === input.accountId && m.status === "active",
    );
    if (!membership || !(await subjectHasLiveWorkspaceAuthorityInScope(tx, input))) return;
    const rows = await rawRows<{
      canonical_snapshot: unknown;
      authority_epoch: number;
      visibility: string;
      parent_session_id: string;
      parent_turn_id: string;
    }>(
      tx,
      sql`
      select a.canonical_snapshot, c.authority_epoch, c.visibility, c.parent_session_id, c.parent_turn_id
      from sessions c join sessions p on p.id = c.parent_session_id and p.workspace_id = c.workspace_id
      join host_mcp_turn_authorities a on a.turn_id = c.parent_turn_id and a.session_id = p.id
      join host_mcp_delegations d on d.id = a.delegation_id
      join host_mcp_bindings b on b.id = a.binding_id
      where c.id = ${input.sessionId}::uuid and c.workspace_id = ${input.workspaceId}::uuid
        and c.account_id = ${input.accountId}::uuid and a.account_id = c.account_id and a.workspace_id = c.workspace_id
        and a.owner_subject_id = ${input.subjectId} and c.visibility = p.visibility
        and a.canonical_snapshot ->> 'targetSessionAuthorityEpoch' = p.authority_epoch::text
        and a.canonical_snapshot ->> 'ownerOrganizationMembershipId' = ${membership.id}
        and a.canonical_snapshot ->> 'ownerMembershipAuthorizationRevision' = ${String(membership.authorizationRevision)}
        and d.status = 'active' and b.status = 'active' and d.grant_definition ->> 'mode' = 'always'
        and d.generation::text = a.canonical_snapshot ->> 'delegationGeneration'
        and b.generation::text = a.canonical_snapshot ->> 'bindingGeneration'
        and exists (select 1 from jsonb_array_elements(c.tools) tool where tool ->> 'kind' = 'mcp' and tool ->> 'id' = a.server_id)
      for share of d, b`,
    );
    for (const row of rows) {
      const parent = HostMcpAcceptedAuthority.parse(row.canonical_snapshot);
      const authority = HostMcpAcceptedAuthority.parse({
        ...parent,
        targetSessionId: input.sessionId,
        targetSessionVisibility: row.visibility,
        targetSessionAuthorityEpoch: row.authority_epoch,
        acceptedWork: { kind: "turn", turnId: input.turnId },
        source: {
          kind: "child_turn",
          sessionId: row.parent_session_id,
          turnId: row.parent_turn_id,
        },
      });
      await tx.execute(sql`insert into host_mcp_turn_authorities
        (turn_id, server_id, account_id, workspace_id, session_id, owner_subject_id, binding_id, delegation_id, canonical_snapshot)
        values (${input.turnId}::uuid, ${authority.definition.serverId}, ${input.accountId}::uuid,
          ${input.workspaceId}::uuid, ${input.sessionId}::uuid, ${input.subjectId}, ${authority.bindingId}::uuid,
          ${authority.delegationId}::uuid, ${JSON.stringify(authority)}::jsonb)`);
    }
  });
}

/** Live consumption of captured direct or same-session causal turn authority.
 * Request context must come from the accepted attempt, never caller JSON.
 * Missing/revoked authority denies; infrastructure failures propagate so the
 * broker reports refresh_failed rather than misclassifying an outage.
 * The historical function name is retained for existing internal consumers. */
export async function authorizeDirectHostMcpUse(
  db: Database,
  request: McpCredentialsRequest,
  /** Internal metadata observer; called only after every live authorization fence succeeds. */
  onAuthorized?: (snapshot: HostMcpAcceptedAuthority) => void,
): Promise<boolean> {
  const snapshot = await resolveDirectHostMcpUseAuthority(db, request);
  if (!snapshot) return false;
  onAuthorized?.(snapshot);
  return true;
}

async function resolveDirectHostMcpUseAuthority(
  db: Database,
  request: McpCredentialsRequest,
): Promise<HostMcpAcceptedAuthority | false> {
  if (!request.attemptId || !request.connectionRef.hostBinding) return false;
  const current = await getHostMcpLiveAttempt(
    db,
    request.workspaceId,
    request.sessionId,
    request.attemptId,
  );
  if (
    !current ||
    current.id !== request.turnId ||
    current.executionGeneration !== request.executionGeneration
  )
    return false;
  // The accepted initiator only scopes this read. Permission comes from the
  // immutable captured row and live checks below, not from initiator metadata.
  const direct =
    ["user", "api"].includes(current.source) &&
    current.initiator.kind === "subject" &&
    !["via", "viaTruncated", "provenanceError", "backfill"].some((key) =>
      Object.hasOwn(current.initiatorContext, key),
    );
  const inherited = ["goal", "system"].includes(current.source) && !current.scheduledTaskRunId;
  const scheduled = current.source === "system" && Boolean(current.scheduledTaskRunId);
  const child = ["user", "api"].includes(current.source) && !direct;
  const subjectId =
    direct && current.initiator.kind === "subject"
      ? current.initiator.subjectId
      : inherited || scheduled || child
        ? current.initiatingHumanSubjectId
        : null;
  if (!subjectId) return false;
  return withWorkspaceSubjectRls(db, request.workspaceId, subjectId, async (tx) => {
    await lockExternalWorkspaceMembershipLifecycle(tx, request.accountId);
    const [stored] = await rawRows<{ canonical_snapshot: unknown }>(
      tx,
      sql`
      select canonical_snapshot from host_mcp_turn_authorities where turn_id = ${request.turnId}::uuid
      and server_id = ${request.serverId} and account_id = ${request.accountId}::uuid
      and workspace_id = ${request.workspaceId}::uuid and session_id = ${request.sessionId}::uuid
      and owner_subject_id = ${subjectId}`,
    );
    const parsed = HostMcpAcceptedAuthority.safeParse(stored?.canonical_snapshot);
    if (!parsed.success) return false;
    const a = parsed.data;
    if (
      !(
        (direct && a.source.kind === "direct") ||
        (inherited &&
          a.source.kind === "inherited_turn" &&
          a.source.sessionId === request.sessionId) ||
        (scheduled &&
          a.source.kind === "scheduled_task" &&
          a.acceptedWork.kind === "scheduled_task" &&
          a.acceptedWork.runId === current.scheduledTaskRunId) ||
        (child && a.source.kind === "child_turn" && a.acceptedWork.kind === "turn")
      ) ||
      (a.acceptedWork.kind === "turn" && a.acceptedWork.turnId !== request.turnId) ||
      a.accountId !== request.accountId ||
      a.workspaceId !== request.workspaceId ||
      a.targetSessionId !== request.sessionId ||
      a.ownerSubjectId !== subjectId
    )
      return false;
    if (a.scheduledOrigin) {
      const origin = a.scheduledOrigin;
      const [run] = await rawRows<{ denial: string | null }>(
        tx,
        sql`
        select validate_scheduled_agent_run_live_authority(${request.accountId}::uuid,
          ${request.workspaceId}::uuid, r.id) as denial from scheduled_task_runs r
        where r.id = ${origin.runId}::uuid and r.task_id = ${origin.taskId}::uuid
          and r.task_authority_revision = ${origin.taskAuthorityRevision}
          and r.account_id = ${request.accountId}::uuid and r.workspace_id = ${request.workspaceId}::uuid
          and r.accepted_execution_snapshot ->> 'causalHumanSubjectId' = ${subjectId}`,
      );
      if (!run || run.denial !== null) return false;
    }
    const membership = (await listSelfOrganizationMemberships(tx, subjectId)).find(
      (m) => m.organizationId === request.accountId,
    );
    if (
      !membership ||
      membership.status !== "active" ||
      membership.id !== a.ownerOrganizationMembershipId ||
      membership.authorizationRevision !== a.ownerMembershipAuthorizationRevision ||
      !(await subjectHasLiveWorkspaceAuthorityInScope(tx, {
        accountId: request.accountId,
        workspaceId: request.workspaceId,
        subjectId,
      }))
    )
      return false;
    // Migration 0418's self-membership boundary independently checks active
    // external identity; runtime has no direct external_identities privileges.
    const [session] = await rawRows<{
      visibility: string;
      authority_epoch: number;
      owner_subject_id: string | null;
    }>(
      tx,
      sql`select visibility, authority_epoch, owner_subject_id from sessions where id = ${request.sessionId}::uuid and account_id = ${request.accountId}::uuid and workspace_id = ${request.workspaceId}::uuid`,
    );
    if (
      !session ||
      session.visibility !== a.targetSessionVisibility ||
      session.authority_epoch !== a.targetSessionAuthorityEpoch ||
      (session.visibility === "user_private" && session.owner_subject_id !== subjectId)
    )
      return false;
    const [d] = await rawRows<DelegationRow>(
      tx,
      sql`select * from host_mcp_delegations where id = ${a.delegationId}::uuid and account_id = ${request.accountId}::uuid and workspace_id = ${request.workspaceId}::uuid and owner_subject_id = ${subjectId}`,
    );
    const [b] = await rawRows<Row>(
      tx,
      sql`select * from host_mcp_bindings where id = ${a.bindingId}::uuid and account_id = ${request.accountId}::uuid and workspace_id = ${request.workspaceId}::uuid and owner_subject_id = ${subjectId}`,
    );
    if (!d || !b) return false;
    const delegation = projectDelegation(d),
      binding = project(b);
    if (
      delegation.status !== "active" ||
      delegation.revokedAt !== null ||
      delegation.generation !== a.delegationGeneration ||
      delegation.ownerAuthorizationRevision !== a.ownerMembershipAuthorizationRevision ||
      delegation.bindingId !== a.bindingId ||
      delegation.bindingGeneration !== a.bindingGeneration ||
      delegation.grant.context !== a.targetSessionVisibility ||
      (delegation.grant.mode === "session" &&
        (delegation.grant.sessionId !== request.sessionId ||
          delegation.grant.expectedAuthorityEpoch !== a.targetSessionAuthorityEpoch)) ||
      binding.status !== "active" ||
      binding.revokedAt !== null ||
      binding.authorizationRevision !== a.ownerMembershipAuthorizationRevision ||
      binding.generation !== a.bindingGeneration ||
      stableJson(binding.definition) !== stableJson(a.definition) ||
      !(request.connectionRef.hostBinding && "selection" in request.connectionRef.hostBinding
        ? request.credentialTarget === "mcp" && hostMcpBindingMatchesSelection(binding, request)
        : hostMcpBindingMatchesRequest(binding, request))
    )
      return false;
    const live = await getHostMcpLiveAttempt(
      tx,
      request.workspaceId,
      request.sessionId,
      request.attemptId!,
    );
    return (
      live !== null &&
      live.id === request.turnId &&
      live.executionGeneration === request.executionGeneration &&
      a
    );
  });
}

/** Resolve a configuration selector from the exact live accepted turn, never
 * registry inventory or session creator metadata. The broker still revalidates
 * the resulting concrete reference around resolution and every physical use. */
export async function resolveAcceptedHostMcpBinding(
  db: Database,
  request: McpCredentialsRequest,
): Promise<McpCredentialsRequest["connectionRef"] | null> {
  if (!request.connectionRef.hostBinding || !("selection" in request.connectionRef.hostBinding))
    return null;
  const authority = await resolveDirectHostMcpUseAuthority(db, request);
  return authority
    ? {
        ...authority.definition.connectionRef,
        hostBinding: { bindingId: authority.bindingId, generation: authority.bindingGeneration },
      }
    : null;
}
