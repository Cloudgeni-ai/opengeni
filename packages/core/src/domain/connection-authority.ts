import type {
  ConnectionKind,
  ConnectionStatus,
  SessionTenancyVisibility,
  UserResourceDelegation,
  UserResourceGrantMode,
  UserResourceGrantStatus,
} from "@opengeni/contracts";
import {
  ConnectionAuthorityEnvelope,
  ConnectionUseAttribution,
  ConnectionUseAuthoritySnapshot,
  type ConnectionUseAuthorizationResult,
  type ConnectionAuthoritySelectionSource,
  type ConnectionUseDenialReason,
  type ConnectionUseSelectionSource,
} from "@opengeni/contracts/connection-authority";

export type ConnectionAuthorityCandidate = {
  id: string;
  organizationId: string;
  workspaceId: string;
  generation: number;
  status: ConnectionStatus;
  providerDomain: string;
  kind: ConnectionKind;
  subjectId: string | null;
  ownerOrganizationMembershipId: string | null;
};

export type UserConnectionAuthorityCandidate = {
  id: string;
  organizationId: string;
  resourceKind: "connection";
  resourceId: string;
  originWorkspaceId: string;
  ownerSubjectId: string;
  ownerOrganizationMembershipId: string;
  ownerMembershipAuthorizationRevision: number;
  generation: number;
  status: "active" | "retained" | "revoked";
};

export class ConnectionAuthorityInvariantError extends Error {
  constructor(readonly code: string) {
    super(`connection authority invariant failed: ${code}`);
    this.name = "ConnectionAuthorityInvariantError";
  }
}

export function captureConnectionUseAuthority(input: {
  organizationId: string;
  targetWorkspaceId: string;
  targetSessionId: string;
  targetSessionVisibility: SessionTenancyVisibility;
  targetSessionAuthorityEpoch: number;
  acceptedWork:
    | { kind: "turn"; turnId: string }
    | {
        kind: "scheduled_task";
        taskId: string;
        taskAuthorityRevision: number;
        runId: string;
      };
  connection: ConnectionAuthorityCandidate;
  authority?: unknown;
  authorityWasOmitted?: boolean;
  userAuthority?: UserConnectionAuthorityCandidate | null;
  selectionSources: ConnectionUseSelectionSource[];
}): ConnectionUseAuthoritySnapshot {
  const authority = ConnectionAuthorityEnvelope.parse(input.authority ?? {});
  const connection = input.connection;
  if (connection.organizationId !== input.organizationId) {
    throw new ConnectionAuthorityInvariantError("tenant_mismatch");
  }
  if (connection.status !== "active") {
    throw new ConnectionAuthorityInvariantError("connection_status_inactive");
  }

  let authoritySource: ConnectionAuthoritySelectionSource;
  let userDelegation: UserResourceDelegation | null = null;
  if (authority.scope === "workspace") {
    if (connection.subjectId !== null || connection.ownerOrganizationMembershipId !== null) {
      throw new ConnectionAuthorityInvariantError("workspace_borrowed_personal_connection");
    }
    if (connection.workspaceId !== input.targetWorkspaceId) {
      throw new ConnectionAuthorityInvariantError("workspace_connection_scope_mismatch");
    }
    authoritySource = input.authorityWasOmitted
      ? "legacy_workspace_omission"
      : "explicit_workspace";
  } else {
    const delegation = authority.userDelegation;
    const resourceAuthority = input.userAuthority;
    if (!delegation || !resourceAuthority) {
      throw new ConnectionAuthorityInvariantError("user_authority_missing");
    }
    if (!connection.subjectId || !connection.ownerOrganizationMembershipId) {
      throw new ConnectionAuthorityInvariantError("personal_owner_missing");
    }
    if (
      resourceAuthority.id !== delegation.authorityId ||
      resourceAuthority.organizationId !== input.organizationId ||
      resourceAuthority.resourceKind !== "connection" ||
      resourceAuthority.resourceId !== connection.id ||
      resourceAuthority.originWorkspaceId !== connection.workspaceId ||
      resourceAuthority.ownerSubjectId !== connection.subjectId ||
      resourceAuthority.ownerOrganizationMembershipId !==
        connection.ownerOrganizationMembershipId ||
      resourceAuthority.generation !== delegation.authorityGeneration ||
      resourceAuthority.status !== "active"
    ) {
      throw new ConnectionAuthorityInvariantError("user_authority_mismatch");
    }
    userDelegation = delegation;
    authoritySource = "user_delegation";
  }

  return ConnectionUseAuthoritySnapshot.parse({
    organizationId: input.organizationId,
    originWorkspaceId: connection.workspaceId,
    targetWorkspaceId: input.targetWorkspaceId,
    targetSessionId: input.targetSessionId,
    targetSessionVisibility: input.targetSessionVisibility,
    targetSessionAuthorityEpoch: input.targetSessionAuthorityEpoch,
    acceptedWork: input.acceptedWork,
    connectionId: connection.id,
    connectionGeneration: connection.generation,
    connectionStatus: "active",
    providerDomain: connection.providerDomain.toLowerCase(),
    connectionKind: connection.kind,
    scope: authority.scope,
    ownerSubjectId: connection.subjectId,
    ownerOrganizationMembershipId: connection.ownerOrganizationMembershipId,
    ownerMembershipAuthorizationRevision:
      authority.scope === "user" ? input.userAuthority!.ownerMembershipAuthorizationRevision : null,
    authoritySource,
    selectionSources: input.selectionSources,
    userDelegation,
  });
}

export type LiveConnectionUseState = {
  organizationId: string;
  targetWorkspaceId: string;
  targetWorkspaceAccessActive: boolean;
  session: {
    id: string;
    organizationId: string;
    workspaceId: string;
    visibility: SessionTenancyVisibility;
    authorityEpoch: number;
    active: boolean;
  };
  connection: ConnectionAuthorityCandidate | null;
  ownerMembership: {
    id: string;
    organizationId: string;
    subjectId: string;
    status: "provisioning" | "active" | "suspended" | "revoked";
    authorizationRevision: number;
  } | null;
  userAuthority: UserConnectionAuthorityCandidate | null;
  grant: {
    id: string;
    authorityId: string;
    organizationId: string;
    workspaceId: string;
    sessionId: string | null;
    action: string;
    mode: UserResourceGrantMode;
    context: SessionTenancyVisibility;
    authorityEpoch: number | null;
    generation: number;
    status: UserResourceGrantStatus;
    expiresAt: string | null;
    consumed: boolean;
  } | null;
};

function denied(reason: ConnectionUseDenialReason): ConnectionUseAuthorizationResult {
  return { status: "denied", reason };
}

/**
 * Revalidates every mutable fence immediately before provider use. Callers must
 * resolve the live state in one DB authority boundary; this pure function does
 * not cache, refresh, decrypt, or invoke a provider.
 */
export function revalidateConnectionUseAuthority(input: {
  snapshot: ConnectionUseAuthoritySnapshot;
  live: LiveConnectionUseState;
  now?: Date;
}): ConnectionUseAuthorizationResult {
  const snapshot = ConnectionUseAuthoritySnapshot.parse(input.snapshot);
  const live = input.live;
  const now = input.now ?? new Date();
  if (
    live.organizationId !== snapshot.organizationId ||
    live.targetWorkspaceId !== snapshot.targetWorkspaceId
  ) {
    return denied("tenant_mismatch");
  }
  if (!live.targetWorkspaceAccessActive) return denied("workspace_access_inactive");
  if (!live.session.active) return denied("session_inactive");
  if (
    live.session.id !== snapshot.targetSessionId ||
    live.session.organizationId !== snapshot.organizationId ||
    live.session.workspaceId !== snapshot.targetWorkspaceId
  ) {
    return denied("session_identity_changed");
  }
  if (live.session.visibility !== snapshot.targetSessionVisibility) {
    return denied("session_visibility_changed");
  }
  if (live.session.authorityEpoch !== snapshot.targetSessionAuthorityEpoch) {
    return denied("session_authority_epoch_changed");
  }
  const connection = live.connection;
  if (!connection) return denied("connection_missing");
  if (
    connection.id !== snapshot.connectionId ||
    connection.organizationId !== snapshot.organizationId ||
    connection.workspaceId !== snapshot.originWorkspaceId ||
    connection.providerDomain.toLowerCase() !== snapshot.providerDomain ||
    connection.kind !== snapshot.connectionKind
  ) {
    return denied("connection_identity_changed");
  }
  if (connection.generation !== snapshot.connectionGeneration) {
    return denied("connection_generation_changed");
  }
  if (connection.status !== "active") return denied("connection_status_inactive");
  if (
    connection.subjectId !== snapshot.ownerSubjectId ||
    connection.ownerOrganizationMembershipId !== snapshot.ownerOrganizationMembershipId
  ) {
    return denied("connection_owner_changed");
  }

  if (snapshot.scope === "workspace") {
    if (connection.subjectId !== null || connection.workspaceId !== snapshot.targetWorkspaceId) {
      return denied("connection_owner_changed");
    }
    return {
      status: "authorized",
      attribution: ConnectionUseAttribution.parse({
        organizationId: snapshot.organizationId,
        workspaceId: snapshot.targetWorkspaceId,
        sessionId: snapshot.targetSessionId,
        connectionId: snapshot.connectionId,
        connectionGeneration: snapshot.connectionGeneration,
        scope: "workspace",
        ownerSubjectId: null,
        authorityId: null,
        grantId: null,
      }),
    };
  }

  const delegation = snapshot.userDelegation!;
  const membership = live.ownerMembership;
  if (
    !membership ||
    membership.status !== "active" ||
    membership.id !== snapshot.ownerOrganizationMembershipId ||
    membership.organizationId !== snapshot.organizationId ||
    membership.subjectId !== snapshot.ownerSubjectId ||
    membership.authorizationRevision !== snapshot.ownerMembershipAuthorizationRevision
  ) {
    return denied("owner_membership_inactive");
  }
  const authority = live.userAuthority;
  if (!authority) return denied("authority_missing");
  if (
    authority.id !== delegation.authorityId ||
    authority.organizationId !== snapshot.organizationId ||
    authority.resourceKind !== "connection" ||
    authority.resourceId !== snapshot.connectionId ||
    authority.originWorkspaceId !== snapshot.originWorkspaceId ||
    authority.ownerSubjectId !== snapshot.ownerSubjectId ||
    authority.ownerOrganizationMembershipId !== snapshot.ownerOrganizationMembershipId
  ) {
    return denied("authority_identity_changed");
  }
  if (authority.generation !== delegation.authorityGeneration) {
    return denied("authority_generation_changed");
  }
  if (authority.status !== "active") return denied("authority_status_inactive");

  const grant = live.grant;
  if (!grant) return denied("grant_missing");
  if (
    grant.id !== delegation.grantId ||
    grant.authorityId !== delegation.authorityId ||
    grant.organizationId !== snapshot.organizationId ||
    grant.workspaceId !== snapshot.targetWorkspaceId ||
    grant.sessionId !== delegation.sessionId ||
    grant.action !== "connection.use" ||
    grant.mode !== delegation.mode ||
    grant.context !== snapshot.targetSessionVisibility ||
    grant.authorityEpoch !== delegation.authorityEpoch
  ) {
    return denied("grant_identity_changed");
  }
  if (grant.generation !== delegation.grantGeneration) {
    return denied("grant_generation_changed");
  }
  if (grant.status !== "active") return denied("grant_status_inactive");
  if (grant.expiresAt !== null && Date.parse(grant.expiresAt) <= now.getTime()) {
    return denied("grant_expired");
  }
  if (grant.mode === "once" && grant.consumed) return denied("grant_already_consumed");

  return {
    status: "authorized",
    attribution: ConnectionUseAttribution.parse({
      organizationId: snapshot.organizationId,
      workspaceId: snapshot.targetWorkspaceId,
      sessionId: snapshot.targetSessionId,
      connectionId: snapshot.connectionId,
      connectionGeneration: snapshot.connectionGeneration,
      scope: "user",
      ownerSubjectId: snapshot.ownerSubjectId,
      authorityId: delegation.authorityId,
      grantId: delegation.grantId,
    }),
  };
}
