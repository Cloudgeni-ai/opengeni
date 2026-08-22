import {
  ConnectionAuthorityGrant,
  ConnectionAuthoritySummary,
  ConnectionUseDenialReason,
  ConnectionUseAttribution,
  ConnectionUseAuthorizationResult,
  ConnectionUseAuthoritySnapshot,
  type IssueConnectionUseGrantRequest,
  type ConnectionUseDenialReason as ConnectionUseDenialReasonValue,
} from "@opengeni/contracts/connection-authority";
import {
  ConnectionKind,
  type ConnectionKind as ConnectionKindValue,
  type UserResourceDelegation,
} from "@opengeni/contracts";
import { sql } from "drizzle-orm";
import { rawRows, setSubjectRlsContext, withRlsContext, type Database } from "./database";
import {
  issueSelfUserResourceGrant,
  listSelfUserResourceAuthorities,
  revokeSelfUserResourceGrant,
} from "./user-resource-authority";

async function withOwnerContext<T>(
  db: Database,
  input: { accountId: string; workspaceId: string; subjectId: string },
  fn: (db: Database) => Promise<T>,
): Promise<T> {
  return await withRlsContext(db, input, async (scopedDb) => {
    await setSubjectRlsContext(scopedDb, input.subjectId);
    return await fn(scopedDb);
  });
}

export async function listSelfConnectionAuthorities(
  db: Database,
  input: { accountId: string; workspaceId: string; subjectId: string },
): Promise<ConnectionAuthoritySummary[]> {
  const page = await listSelfUserResourceAuthorities(db, {
    ...input,
    resourceKind: "connection",
    limit: 100,
  });
  return page.authorities.map(({ resourceKind: _resourceKind, ...authority }) =>
    ConnectionAuthoritySummary.parse(authority),
  );
}

export async function issueSelfConnectionUseGrant(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    subjectId: string;
    authorityId: string;
    request: IssueConnectionUseGrantRequest;
  },
) {
  return ConnectionAuthorityGrant.parse(
    await issueSelfUserResourceGrant(db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      subjectId: input.subjectId,
      authorityId: input.authorityId,
      resourceKind: "connection",
      mode: input.request.mode,
      context: input.request.context,
      sessionId: input.request.sessionId ?? null,
      expectedAuthorityEpoch: input.request.expectedAuthorityEpoch ?? null,
      workspaceSharedAcknowledged: input.request.workspaceSharedAcknowledged,
    }),
  );
}

export async function revokeSelfConnectionUseGrant(
  db: Database,
  input: { accountId: string; workspaceId: string; subjectId: string; grantId: string },
): Promise<{ grantId: string; generation: number; status: "revoked"; revokedAt: string }> {
  return await revokeSelfUserResourceGrant(db, input);
}

/**
 * Resolves the immutable physical origin for one explicit common-user
 * connection selection. The SECURITY DEFINER database boundary proves the
 * owning human, active organization membership, target-workspace access, and
 * exact authority/grant generations without exposing credentials or allowing
 * an ambient cross-workspace inventory.
 */
export async function resolvePersonalConnectionAuthoritySelectionOrigin(
  db: Database,
  input: {
    accountId: string;
    targetWorkspaceId: string;
    subjectId: string;
    connectionId: string;
    delegation: UserResourceDelegation;
  },
): Promise<string | null> {
  return await withOwnerContext(
    db,
    {
      accountId: input.accountId,
      workspaceId: input.targetWorkspaceId,
      subjectId: input.subjectId,
    },
    async (scopedDb) => {
      const [row] = await rawRows<{ originWorkspaceId: string }>(
        scopedDb,
        sql`
          select origin_workspace_id as "originWorkspaceId"
          from resolve_personal_connection_authority_selection(
            ${input.accountId}::uuid, ${input.targetWorkspaceId}::uuid,
            ${input.subjectId}, ${input.connectionId}::uuid,
            ${JSON.stringify(input.delegation)}::text::jsonb
          )
        `,
      );
      return row?.originWorkspaceId ?? null;
    },
  );
}

export async function resolveConnectionUseAuthority(
  db: Database,
  input: { snapshot: unknown },
): Promise<ConnectionUseAuthorizationResult> {
  const snapshot = ConnectionUseAuthoritySnapshot.parse(input.snapshot);
  return await withRlsContext(
    db,
    { accountId: snapshot.organizationId, workspaceId: snapshot.targetWorkspaceId },
    async (scopedDb) => {
      if (snapshot.ownerSubjectId) {
        await setSubjectRlsContext(scopedDb, snapshot.ownerSubjectId);
      }
      const [row] = await rawRows<{
        authorizationStatus: "authorized" | "denied";
        denialReason: string | null;
        connectionId: string | null;
        connectionGeneration: number | null;
        authorityScope: "workspace" | "user" | null;
        ownerSubjectId: string | null;
        authorityId: string | null;
        grantId: string | null;
      }>(
        scopedDb,
        sql`
          select authorization_status as "authorizationStatus",
            denial_reason as "denialReason", connection_id as "connectionId",
            connection_generation::int as "connectionGeneration",
            authority_scope as "authorityScope", owner_subject_id as "ownerSubjectId",
            authority_id as "authorityId", grant_id as "grantId"
          from resolve_connection_use_authority(
            ${snapshot.organizationId}::uuid, ${snapshot.targetWorkspaceId}::uuid,
            ${snapshot.targetSessionId}::uuid, ${JSON.stringify(snapshot)}::text::jsonb
          )
        `,
      );
      if (!row) throw new Error("connection use authorization was not returned");
      if (row.authorizationStatus === "denied") {
        return ConnectionUseAuthorizationResult.parse({
          status: "denied",
          reason: row.denialReason,
        });
      }
      return ConnectionUseAuthorizationResult.parse({
        status: "authorized",
        attribution: ConnectionUseAttribution.parse({
          organizationId: snapshot.organizationId,
          workspaceId: snapshot.targetWorkspaceId,
          sessionId: snapshot.targetSessionId,
          connectionId: row.connectionId,
          connectionGeneration: row.connectionGeneration,
          scope: row.authorityScope,
          ownerSubjectId: row.ownerSubjectId,
          authorityId: row.authorityId,
          grantId: row.grantId,
        }),
      });
    },
  );
}

export type AcceptedConnectionUseContext = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  attemptId: string;
  executionGeneration: number;
  physicalRequestId: string;
  usePhase: "credential_resolution" | "provider_request";
};

export type AcceptedConnectionUseResolution =
  | {
      status: "denied";
      reason: ConnectionUseDenialReasonValue;
    }
  | {
      status: "authorized";
      originWorkspaceId: string;
      connectionKind: ConnectionKindValue;
      attribution: ConnectionUseAttribution;
    };

export async function resolveAcceptedConnectionUse(
  db: Database,
  input: AcceptedConnectionUseContext & {
    serverId: string;
    connectionId?: string;
    providerDomain: string;
    connectionKind?: ConnectionKindValue;
    subjectScope?: "workspace" | "subject";
    ownerSubjectId?: string;
  },
): Promise<AcceptedConnectionUseResolution> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const [row] = await rawRows<{
        authorizationStatus: "authorized" | "denied";
        denialReason: string | null;
        connectionId: string | null;
        connectionGeneration: number | null;
        originWorkspaceId: string | null;
        connectionKind: string | null;
        authorityScope: "workspace" | "user" | "legacy_user" | null;
        ownerSubjectId: string | null;
        authorityId: string | null;
        grantId: string | null;
      }>(
        scopedDb,
        sql`
          select authorization_status as "authorizationStatus",
            denial_reason as "denialReason",
            resolved_connection_id as "connectionId",
            connection_generation::int as "connectionGeneration",
            origin_workspace_id as "originWorkspaceId",
            resolved_connection_kind as "connectionKind",
            authority_scope as "authorityScope",
            owner_subject_id as "ownerSubjectId",
            authority_id as "authorityId", grant_id as "grantId"
          from resolve_accepted_connection_use(
            ${input.accountId}::uuid, ${input.workspaceId}::uuid,
            ${input.sessionId}::uuid, ${input.turnId}::uuid,
            ${input.attemptId}::uuid, ${input.executionGeneration},
            ${input.physicalRequestId}::uuid, ${input.usePhase}, ${input.serverId},
            ${input.connectionId ?? null}::uuid, ${input.providerDomain},
            ${input.connectionKind ?? null}, ${input.subjectScope ?? "workspace"},
            ${input.ownerSubjectId ?? null}
          )
        `,
      );
      if (!row) throw new Error("accepted connection use resolution was not returned");
      if (row.authorizationStatus === "denied") {
        return {
          status: "denied",
          reason: ConnectionUseDenialReason.parse(row.denialReason),
        };
      }
      if (
        !row.connectionId ||
        !row.connectionGeneration ||
        !row.originWorkspaceId ||
        !row.connectionKind ||
        !row.authorityScope
      ) {
        throw new Error("authorized connection use resolution is incomplete");
      }
      const scope = row.authorityScope;
      return {
        status: "authorized",
        originWorkspaceId: row.originWorkspaceId,
        connectionKind: ConnectionKind.parse(row.connectionKind),
        attribution: ConnectionUseAttribution.parse({
          organizationId: input.accountId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          connectionId: row.connectionId,
          connectionGeneration: row.connectionGeneration,
          scope,
          ownerSubjectId: row.ownerSubjectId,
          authorityId: row.authorityId,
          grantId: row.grantId,
        }),
      };
    },
  );
}
