import {
  ConnectionUseDenialReason,
  ConnectionUseAttribution,
  type ConnectionUseDenialReason as ConnectionUseDenialReasonValue,
} from "@opengeni/contracts/connection-authority";
import { ConnectionKind, type ConnectionKind as ConnectionKindValue } from "@opengeni/contracts";
import { sql } from "drizzle-orm";
import { getExternalLinkTurnAuthorization } from "./external-link-work";
import { rawRows, setSubjectRlsContext, withRlsContext, type Database } from "./database";

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

/** Called only after the core layer has established the authenticated sender. */
export async function listOwnedConnectionAccounts(
  db: Database,
  input: { accountId: string; workspaceId: string; subjectId: string },
): Promise<Array<{ connectionId: string; originWorkspaceId: string }>> {
  return withOwnerContext(db, input, async (tx) =>
    rawRows<{ connectionId: string; originWorkspaceId: string }>(
      tx,
      sql`
      select connection_id as "connectionId", origin_workspace_id as "originWorkspaceId"
      from list_owned_connection_accounts(${input.accountId}::uuid, ${input.workspaceId}::uuid)
    `,
    ),
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
      const linked = await getExternalLinkTurnAuthorization(scopedDb, input, input.turnId);
      if (
        linked &&
        (!linked.authorized ||
          (!linked.permissions.includes("connections:read") &&
            !linked.permissions.includes("workspace:admin")))
      )
        return { status: "denied", reason: "grant_status_inactive" };
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
