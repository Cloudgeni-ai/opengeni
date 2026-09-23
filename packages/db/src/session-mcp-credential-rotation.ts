import { and, eq, inArray, sql } from "drizzle-orm";
import { RotateSessionMcpCredentialsReceipt, SessionTurnStatus } from "@opengeni/contracts";
import { rawRows, setSubjectRlsContext, withRlsContext, type Database } from "./database";
import { lockSessionEventWriteRows } from "./session-control";
import * as schema from "./schema";

const action = "session.mcp.credentials.rotate";
const liveTurnStatuses = SessionTurnStatus.exclude([
  "completed",
  "failed",
  "cancelled",
  "superseded",
  "withdrawn_for_edit",
]).options;

export class SessionMcpCredentialRotationError extends Error {
  constructor(
    readonly code:
      | "invalid_request"
      | "not_found"
      | "not_quiescent"
      | "version_conflict"
      | "destination_conflict"
      | "brokered_server"
      | "operation_reuse"
      | "receipt_key_unavailable"
      | "authority_revoked",
  ) {
    super(code);
    this.name = "SessionMcpCredentialRotationError";
  }
}

export type AtomicSessionMcpCredentialRotationInput = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  subjectId: string;
  actorType: "human" | "service";
  operationKey: string;
  requestDigest: string;
  digestKeyTag: string;
  updates: Array<{
    id: string;
    expectedCredentialVersion: number;
    expectedServerUrl: string;
    headersEncrypted: Record<string, string>;
  }>;
  /** Trusted request authorizer, mandatory even for a committed receipt replay.
   * Revalidate the original authenticated subject and permissions on this tx. */
  authorize: (tx: Database) => Promise<void>;
};

/** Existing command receipts own durable idempotency; this is not a new queue
 * command. No session/event/history/attempt/control/wake rows are mutated. */
export async function rotateSessionMcpCredentialsAtomically(
  db: Database,
  input: AtomicSessionMcpCredentialRotationInput,
): Promise<RotateSessionMcpCredentialsReceipt> {
  if (
    !input.updates.length ||
    input.updates.length > 64 ||
    new Set(input.updates.map((update) => update.id)).size !== input.updates.length ||
    !/^[a-f0-9]{64}$/.test(input.requestDigest) ||
    !/^[a-f0-9]{64}$/.test(input.digestKeyTag)
  ) {
    throw new SessionMcpCredentialRotationError("invalid_request");
  }
  return withRlsContext(
    db,
    input,
    async (tx) => {
      // Membership before tenancy/control/session is the canonical claim/removal
      // order. External continuation authorization reacquires this exclusive
      // membership fence, so taking shared first would introduce an upgrade.
      // Do not upgrade a previously acquired shared tenancy lock.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(
      ${`organization-membership:${input.accountId}`}, 0))`);
      await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtextextended(
      ${`session-tenancy:${input.workspaceId}`}, 0))`);
      await setSubjectRlsContext(tx, input.subjectId);
      const [target] = await tx
        .select({ id: schema.sessions.id })
        .from(schema.sessions)
        .where(
          and(
            eq(schema.sessions.accountId, input.accountId),
            eq(schema.sessions.workspaceId, input.workspaceId),
            eq(schema.sessions.id, input.sessionId),
          ),
        );
      if (!target) throw new SessionMcpCredentialRotationError("not_found");
      const locks = await lockSessionEventWriteRows(tx, {
        workspaceId: input.workspaceId,
        controlLock: "share",
        sessionIds: [input.sessionId],
      });
      const session = locks.sessions[0];
      if (!session || session.accountId !== input.accountId) {
        throw new SessionMcpCredentialRotationError("not_found");
      }
      // Hold a current API key through commit. The ordinary access resolver's
      // last-used write alone does not recheck a revocation racing its first read.
      // Take UPDATE directly because fresh resolution writes lastUsedAt.
      if (input.subjectId.startsWith("api_key:")) {
        const keyId = input.subjectId.slice("api_key:".length);
        const [key] = await tx
          .select({ id: schema.apiKeys.id, permissions: schema.apiKeys.permissions })
          .from(schema.apiKeys)
          .where(
            and(
              eq(schema.apiKeys.id, keyId),
              eq(schema.apiKeys.accountId, input.accountId),
              sql`(${schema.apiKeys.workspaceId} is null or ${schema.apiKeys.workspaceId} = ${input.workspaceId}::uuid)`,
              sql`${schema.apiKeys.revokedAt} is null`,
              sql`(${schema.apiKeys.expiresAt} is null or ${schema.apiKeys.expiresAt} > clock_timestamp())`,
            ),
          )
          .for("update");
        if (
          !key ||
          (!key.permissions.includes("workspace:admin") &&
            (!key.permissions.includes("sessions:control") ||
              !key.permissions.includes("mcp_servers:attach")))
        )
          throw new SessionMcpCredentialRotationError("authority_revoked");
      }
      await input.authorize(tx);
      const [prior] = await tx
        .select()
        .from(schema.sessionCommandReceipts)
        .where(
          and(
            eq(schema.sessionCommandReceipts.accountId, input.accountId),
            eq(schema.sessionCommandReceipts.workspaceId, input.workspaceId),
            eq(schema.sessionCommandReceipts.targetSessionId, input.sessionId),
            eq(schema.sessionCommandReceipts.actorType, input.actorType),
            eq(schema.sessionCommandReceipts.actorSubjectId, input.subjectId),
            eq(schema.sessionCommandReceipts.action, action),
            eq(schema.sessionCommandReceipts.operationKey, input.operationKey),
          ),
        );
      if (prior) {
        if (prior.result.digestKeyTag !== input.digestKeyTag)
          throw new SessionMcpCredentialRotationError("receipt_key_unavailable");
        if (prior.canonicalRequestHash !== input.requestDigest)
          throw new SessionMcpCredentialRotationError("operation_reuse");
        return RotateSessionMcpCredentialsReceipt.parse(prior.result.receipt);
      }
      // Session lock serializes admission, claim, realtime start, interruption
      // settlement, and attempt-owned provider admission. Dormant goals/schedules
      // and unrelated viewers are deliberately not credential consumers.
      // Retained run snapshots and tool receipts need a live turn/attempt to
      // consume credentials; their historical presence alone is not activity.
      const [busy] = await rawRows<{ present: boolean }>(
        tx,
        sql`select (
      exists(select 1 from session_turns where workspace_id = ${input.workspaceId}::uuid
        and session_id = ${input.sessionId}::uuid and status in (${sql.join(
          liveTurnStatuses.map((status) => sql`${status}`),
          sql`, `,
        )}))
      or exists(select 1 from session_turn_attempts a where a.workspace_id = ${input.workspaceId}::uuid
        and a.session_id = ${input.sessionId}::uuid and (a.state <> 'closed' or
          (a.quiesced_at is null and exists(select 1 from session_attempt_interruptions i
            where i.workspace_id = a.workspace_id and i.attempt_id = a.id))))
      or exists(select 1 from session_system_updates where workspace_id = ${input.workspaceId}::uuid
        and session_id = ${input.sessionId}::uuid and state = 'pending')
      or exists(select 1 from sandbox_workspace_mutation_admissions where workspace_id = ${input.workspaceId}::uuid
        and session_id = ${input.sessionId}::uuid and attempt_id is not null and settled_at is null)
      or exists(select 1 from session_realtime_modes where workspace_id = ${input.workspaceId}::uuid
        and session_id = ${input.sessionId}::uuid and state = 'active')
      or exists(select 1 from session_realtime_connections where workspace_id = ${input.workspaceId}::uuid
        and session_id = ${input.sessionId}::uuid and state not in ('failed', 'closed'))
    ) as present`,
      );
      if (!busy || busy.present) throw new SessionMcpCredentialRotationError("not_quiescent");
      const rows = await tx
        .select()
        .from(schema.sessionMcpServers)
        .where(
          and(
            eq(schema.sessionMcpServers.workspaceId, input.workspaceId),
            eq(schema.sessionMcpServers.sessionId, input.sessionId),
            inArray(
              schema.sessionMcpServers.serverId,
              input.updates.map((update) => update.id),
            ),
          ),
        )
        .orderBy(schema.sessionMcpServers.serverId)
        .for("update");
      for (const update of input.updates) {
        const row = rows.find((server) => server.serverId === update.id);
        if (!row || row.accountId !== input.accountId)
          throw new SessionMcpCredentialRotationError("not_found");
        if (row.connectionRef) throw new SessionMcpCredentialRotationError("brokered_server");
        if (row.url !== update.expectedServerUrl)
          throw new SessionMcpCredentialRotationError("destination_conflict");
        if (
          !Number.isInteger(update.expectedCredentialVersion) ||
          update.expectedCredentialVersion < 1 ||
          update.expectedCredentialVersion >= 2_147_483_647 ||
          row.credentialVersion !== update.expectedCredentialVersion
        )
          throw new SessionMcpCredentialRotationError("version_conflict");
      }
      const receipt: RotateSessionMcpCredentialsReceipt = {
        operationKey: input.operationKey,
        sessionId: input.sessionId,
        appliedAt: new Date().toISOString(),
        servers: input.updates.map((update) => ({
          id: update.id,
          credentialVersion: update.expectedCredentialVersion + 1,
        })),
      };
      for (const update of input.updates) {
        await tx
          .update(schema.sessionMcpServers)
          .set({
            headersEncrypted: update.headersEncrypted,
            credentialVersion: update.expectedCredentialVersion + 1,
            updatedAt: new Date(receipt.appliedAt),
          })
          .where(
            and(
              eq(schema.sessionMcpServers.workspaceId, input.workspaceId),
              eq(schema.sessionMcpServers.sessionId, input.sessionId),
              eq(schema.sessionMcpServers.serverId, update.id),
            ),
          );
      }
      await tx.insert(schema.sessionCommandReceipts).values({
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        actorType: input.actorType,
        actorSubjectId: input.subjectId,
        action,
        targetSessionId: input.sessionId,
        operationKey: input.operationKey,
        canonicalRequestHash: input.requestDigest,
        result: { digestKeyTag: input.digestKeyTag, receipt },
      });
      return receipt;
    },
    undefined,
    "none",
  );
}
