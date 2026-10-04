import { createHash } from "node:crypto";
import { organizationApiKeyAllowsWorkspace } from "./organization-api-key-access";
import { and, eq, sql } from "drizzle-orm";
import {
  AppendArchivedSessionEventsRequest,
  ImportArchivedSessionRequest,
  type ArchivedSessionImportEvent,
  type Session,
  type SessionEvent,
  type TurnInitiator,
  type TurnInitiatorContext,
  type Permission,
  type AccessGrant,
  type FileAsset,
} from "@opengeni/contracts";
import {
  rawRows,
  withAccountRls,
  withWorkspaceSubjectRls,
  withWorkspaceSubjectSessionActivityRls,
  type Database,
} from "./database";
import { fromPostgresLosslessJson, withLosslessContentWriteVersion } from "./lossless-json";
import { lockSessionEventWriteRows } from "./session-control";
import { acceptArchivedSessionFileAttachments } from "./session-file-attachments";
import { subjectHasLiveWorkspaceAuthorityInScope } from "./workspace-authority";
import * as schema from "./schema";

type ArchivedImportDependencies = {
  createSessionWithIdempotencyKeyResult: (
    db: Database,
    input: {
      accountId: string;
      workspaceId: string;
      subjectId: string;
      visibility: "user_private" | "workspace_shared";
      createIdempotencyKey: string;
      initialMessage: string;
      resources: never[];
      skills: never[];
      tools: never[];
      metadata: Record<string, unknown>;
      createdBy: TurnInitiator;
      createdByContext?: TurnInitiatorContext;
      model: string;
      reasoningEffort: "low";
      latencyMode: "standard";
      sandboxBackend: "none";
      variableSetIds: string[];
      firstPartyMcpTools: never[];
      firstPartyMcpPermissions: never[];
      beforeCreateCommit: (
        tx: Database,
        sessionId: string,
        context?: { created: boolean },
      ) => Promise<void>;
    },
  ) => Promise<{ denied: false; created: boolean; session: { id: string } } | { denied: true }>;
  getFilesForSubject: (
    db: Database,
    input: {
      accountId: string;
      workspaceId: string;
      subjectId: string | null;
      fileIds: readonly string[];
    },
  ) => Promise<FileAsset[]>;
  getSession: (db: Database, workspaceId: string, sessionId: string) => Promise<Session | null>;
  getWorkspaceGrant: (
    db: Database,
    subjectId: string,
    workspaceId: string,
  ) => Promise<AccessGrant | null>;
  isCreateConflict: (error: unknown) => boolean;
  isCreateUnavailable: (error: unknown) => boolean;
};

/** Bind canonical session/file helpers at the root composition, never by
 * importing that barrel back into a reexported leaf. No permissive defaults. */
export function createArchivedSessionImportPersistence(dependencies: ArchivedImportDependencies) {
  return {
    importArchivedSession: (db: Database, input: Parameters<typeof importArchivedSession>[1]) =>
      importArchivedSession(db, input, dependencies),
    appendArchivedSessionEvents: (
      db: Database,
      input: Parameters<typeof appendArchivedSessionEvents>[1],
    ) => appendArchivedSessionEvents(db, input, dependencies),
  };
}

export type ArchivedSessionImportErrorCode =
  | "SESSION_IMPORT_CONFLICT"
  | "SESSION_IMPORT_OFFSET_CONFLICT"
  | "SESSION_IMPORT_NOT_FOUND"
  | "SESSION_IMPORT_INVALID_FILE"
  | "SESSION_IMPORTED_READ_ONLY";

export class ArchivedSessionImportError extends Error {
  readonly name = "ArchivedSessionImportError";
  constructor(readonly code: ArchivedSessionImportErrorCode) {
    super(
      {
        SESSION_IMPORT_CONFLICT: "Import identity was reused with different input",
        SESSION_IMPORT_OFFSET_CONFLICT: "Import event offset does not match the durable prefix",
        SESSION_IMPORT_NOT_FOUND: "Imported session not found or access denied",
        SESSION_IMPORT_INVALID_FILE: "Imported event references an unavailable workspace file",
        SESSION_IMPORTED_READ_ONLY: "Imported session history is read-only",
      }[code],
    );
  }
}

export function assertSessionIsNotImported(session: Pick<Session, "importedArchive">): void {
  if (session.importedArchive) throw new ArchivedSessionImportError("SESSION_IMPORTED_READ_ONLY");
}

/** Sort object keys only; preserve array order, exact strings and optional-field
 * presence. Hash the parsed canonical request, not a projection of its payload. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function canonicalArchivedSessionImportHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

type ImportScope = {
  accountId: string;
  workspaceId: string;
  subjectId: string;
  /** Set only from verified request ownership, never from a payload label. */
  fileOwnerSubjectId: string | null;
  requireLiveSubject?: boolean;
  apiKeyId?: string;
  requiredPermission?: Permission;
  beforeCommit?: (tx: Database) => Promise<void>;
};

async function revalidateImporter(
  tx: Database,
  scope: ImportScope,
  dependencies: ArchivedImportDependencies,
): Promise<void> {
  if (scope.apiKeyId) {
    const key = await withAccountRls(tx, scope.accountId, async (keyTx) => {
      const [row] = await rawRows<{
        permissions: string[];
        permission_mode: "legacy" | "explicit";
        workspace_id: string | null;
        workspace_scope: "all" | "selected";
      }>(
        keyTx,
        sql`
        select permissions, permission_mode, workspace_id, workspace_scope from api_keys where account_id = ${scope.accountId}::uuid
          and id = ${scope.apiKeyId}::uuid and (workspace_id is null or workspace_id = ${scope.workspaceId}::uuid)
          and revoked_at is null and (expires_at is null or expires_at > clock_timestamp()) for share`,
      );
      if (
        row?.workspace_id === null &&
        !(await organizationApiKeyAllowsWorkspace(
          keyTx,
          {
            id: scope.apiKeyId!,
            accountId: scope.accountId,
            workspaceScope: row.workspace_scope,
          },
          scope.workspaceId,
        ))
      )
        return undefined;
      return row;
    });
    if (
      !key ||
      (scope.requiredPermission &&
        !key.permissions.includes(scope.requiredPermission) &&
        !(key.permission_mode === "legacy" && key.permissions.includes("workspace:admin")))
    ) {
      throw new ArchivedSessionImportError("SESSION_IMPORT_NOT_FOUND");
    }
  }
  if (scope.requireLiveSubject && !(await subjectHasLiveWorkspaceAuthorityInScope(tx, scope))) {
    throw new ArchivedSessionImportError("SESSION_IMPORT_NOT_FOUND");
  }
  if (scope.requireLiveSubject && scope.requiredPermission) {
    const grant = await dependencies.getWorkspaceGrant(tx, scope.subjectId, scope.workspaceId);
    // An exact verified Personal-workspace owner deliberately has no ordinary
    // workspace_memberships row; the live resolver proved that pointer above.
    if (
      grant &&
      !grant.permissions.includes(scope.requiredPermission) &&
      !grant.permissions.includes("workspace:admin")
    ) {
      throw new ArchivedSessionImportError("SESSION_IMPORT_NOT_FOUND");
    }
  }
  await scope.beforeCommit?.(tx);
}

/** JSON is already bounded by the contract; inspect nested resources as well as
 * the usual top-level attachment refs. Never accept another workspace's file,
 * even when its personal-file ACL happens to allow the importing human. */
export function archivedSessionImportFileIds(
  events: readonly ArchivedSessionImportEvent[],
): string[] {
  const ids = new Set<string>();
  const pending: unknown[] = events.map((event) => event.payload);
  while (pending.length) {
    const value = pending.pop();
    if (Array.isArray(value)) {
      pending.push(...value);
      continue;
    }
    if (!value || typeof value !== "object") continue;
    for (const [key, child] of Object.entries(value)) {
      if (key === "fileId") {
        if (
          typeof child !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(child)
        ) {
          throw new ArchivedSessionImportError("SESSION_IMPORT_INVALID_FILE");
        }
        ids.add(child);
      } else if (key === "fileIds") {
        if (
          !Array.isArray(child) ||
          child.some(
            (id) =>
              typeof id !== "string" ||
              !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
                id,
              ),
          )
        ) {
          throw new ArchivedSessionImportError("SESSION_IMPORT_INVALID_FILE");
        }
        for (const id of child) ids.add(id as string);
      }
      if (child && typeof child === "object") pending.push(child);
    }
  }
  return [...ids];
}

async function validateFiles(
  tx: Database,
  scope: ImportScope,
  events: ArchivedSessionImportEvent[],
  dependencies: ArchivedImportDependencies,
): Promise<void> {
  const ids = archivedSessionImportFileIds(events);
  const files = await dependencies.getFilesForSubject(tx, {
    ...scope,
    subjectId: scope.fileOwnerSubjectId,
    fileIds: ids,
  });
  if (
    files.length !== ids.length ||
    files.some((file) => file.workspaceId !== scope.workspaceId || file.status !== "ready")
  ) {
    throw new ArchivedSessionImportError("SESSION_IMPORT_INVALID_FILE");
  }
}

/** Caller holds the canonical workspace/session/cursor prefix. The sequencer's
 * insert trigger is still the allocation/verification authority; source turn
 * IDs never select or create session_turns and carry no execution association. */
async function appendTimeline(
  tx: Database,
  scope: ImportScope,
  sessionId: string,
  offset: number,
  events: ArchivedSessionImportEvent[],
): Promise<SessionEvent[]> {
  if (!events.length) return [];
  const rows = await tx
    .insert(schema.sessionEvents)
    .values(
      withLosslessContentWriteVersion(
        events.map((event, index) => ({
          accountId: scope.accountId,
          workspaceId: scope.workspaceId,
          sessionId,
          sequence: offset + index + 1,
          type: event.type,
          payload: event.payload,
          occurredAt: new Date(event.createdAt),
          turnId: event.turnId ?? null,
          turnAssociation: null,
        })),
        "payload",
        "payloadCodecVersion",
      ),
    )
    .returning();
  await tx
    .update(schema.sessions)
    .set({ lastSequence: offset + events.length, updatedAt: new Date() })
    .where(
      and(eq(schema.sessions.workspaceId, scope.workspaceId), eq(schema.sessions.id, sessionId)),
    );
  if (scope.fileOwnerSubjectId === scope.subjectId) {
    await acceptArchivedSessionFileAttachments(tx, {
      ...scope,
      sessionId,
      fileIds: archivedSessionImportFileIds(events),
    });
  }
  return rows.map((row) => ({
    id: row.id,
    workspaceId: row.workspaceId,
    sessionId: row.sessionId,
    sequence: row.sequence,
    type: row.type as SessionEvent["type"],
    payload: fromPostgresLosslessJson(row.payload, row.payloadCodecVersion),
    occurredAt: row.occurredAt.toISOString(),
    clientEventId: row.clientEventId,
    turnId: row.turnId,
    turnGeneration: row.turnGeneration,
    turnAttemptId: row.turnAttemptId,
    turnAssociation: null,
    duplicateOfEventId: row.duplicateOfEventId,
    duplicateReason: row.duplicateReason,
  }));
}

async function importArchivedSession(
  db: Database,
  input: ImportScope & {
    payload: ImportArchivedSessionRequest;
    createdBy: TurnInitiator;
    createdByContext?: TurnInitiatorContext;
  },
  dependencies: ArchivedImportDependencies,
): Promise<{
  session: Session;
  importId: string;
  created: boolean;
  nextOffset: number;
  events: SessionEvent[];
}> {
  const payload = ImportArchivedSessionRequest.parse(input.payload);
  const requestHash = canonicalArchivedSessionImportHash({
    request: payload,
    subjectId: input.subjectId,
    createdByKind: input.createdBy.kind,
  });
  return withWorkspaceSubjectSessionActivityRls(
    db,
    input.workspaceId,
    input.subjectId,
    async (tx) => {
      // The activity scope owns membership -> tenancy before this callback;
      // create then owns workspace-control -> workspace -> session/cursor.
      let committedEvents: SessionEvent[] = [];
      const result = await dependencies
        .createSessionWithIdempotencyKeyResult(tx, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          subjectId: input.subjectId,
          visibility: payload.visibility ?? "workspace_shared",
          createIdempotencyKey: `archived-import:${canonicalArchivedSessionImportHash(payload.importId)}`,
          initialMessage: "",
          resources: [],
          skills: [],
          tools: [],
          metadata: {},
          createdBy: input.createdBy,
          ...(input.createdByContext ? { createdByContext: input.createdByContext } : {}),
          model: "archived-import",
          reasoningEffort: "low",
          latencyMode: "standard",
          sandboxBackend: "none",
          variableSetIds: [],
          firstPartyMcpTools: [],
          firstPartyMcpPermissions: [],
          beforeCreateCommit: async (createTx, sessionId, context) => {
            const locks = await lockSessionEventWriteRows(createTx, {
              workspaceId: input.workspaceId,
              controlLock: "none",
              sessionIds: [sessionId],
            });
            const row = locks.sessions[0];
            if (!row || row.accountId !== input.accountId)
              throw new ArchivedSessionImportError("SESSION_IMPORT_NOT_FOUND");
            await revalidateImporter(createTx, input, dependencies);
            if (!context?.created) {
              if (
                row.importedArchiveImportId !== payload.importId ||
                row.importedArchiveRequestHash !== requestHash ||
                row.importedArchiveSubjectId !== input.subjectId
              ) {
                throw new ArchivedSessionImportError("SESSION_IMPORT_CONFLICT");
              }
              return;
            }
            await validateFiles(createTx, input, payload.events, dependencies);
            await createTx
              .update(schema.sessions)
              .set({
                importedArchiveImportId: payload.importId,
                importedArchiveImportedAt: new Date(),
                importedArchiveRequestHash: requestHash,
                importedArchiveSubjectId: input.subjectId,
                importedArchiveNextOffset: payload.events.length,
                title: payload.title,
                titleSource: "user",
                createdAt: new Date(payload.createdAt),
                status: "idle",
              })
              .where(
                and(
                  eq(schema.sessions.workspaceId, input.workspaceId),
                  eq(schema.sessions.id, sessionId),
                ),
              );
            committedEvents = await appendTimeline(createTx, input, sessionId, 0, payload.events);
          },
        })
        .catch((error: unknown) => {
          if (dependencies.isCreateUnavailable(error)) {
            throw new ArchivedSessionImportError("SESSION_IMPORT_NOT_FOUND");
          }
          if (dependencies.isCreateConflict(error)) {
            throw new ArchivedSessionImportError("SESSION_IMPORT_CONFLICT");
          }
          throw error;
        });
      if (result.denied) throw new ArchivedSessionImportError("SESSION_IMPORT_CONFLICT");
      // The ordinary create seam maps its INSERT RETURNING row. Re-read the
      // marker and canonical event cursor written by beforeCreateCommit.
      const session = await dependencies.getSession(tx, input.workspaceId, result.session.id);
      if (!session) throw new ArchivedSessionImportError("SESSION_IMPORT_NOT_FOUND");
      const [marker] = await tx
        .select({ nextOffset: schema.sessions.importedArchiveNextOffset })
        .from(schema.sessions)
        .where(
          and(
            eq(schema.sessions.workspaceId, input.workspaceId),
            eq(schema.sessions.id, session.id),
          ),
        )
        .limit(1);
      if (marker?.nextOffset === null || marker?.nextOffset === undefined)
        throw new Error("Imported archive offset missing");
      return {
        session,
        importId: payload.importId,
        created: result.created,
        nextOffset: marker.nextOffset,
        events: committedEvents,
      };
    },
    undefined,
    "shared",
    true,
  );
}

async function appendArchivedSessionEvents(
  db: Database,
  input: ImportScope & {
    importId: string;
    payload: AppendArchivedSessionEventsRequest;
    /** A host authorization decision may happen before locking, but its target
     * and mutable database authority are verified again after the prefix. */
    sessionId: string;
  },
  dependencies: ArchivedImportDependencies,
): Promise<{
  sessionId: string;
  importId: string;
  nextOffset: number;
  replayed: boolean;
  events: SessionEvent[];
}> {
  const payload = AppendArchivedSessionEventsRequest.parse(input.payload);
  const requestHash = canonicalArchivedSessionImportHash(payload);
  return withWorkspaceSubjectSessionActivityRls(
    db,
    input.workspaceId,
    input.subjectId,
    async (tx) => {
      const locks = await lockSessionEventWriteRows(tx, {
        workspaceId: input.workspaceId,
        controlLock: "share",
        sessionIds: [input.sessionId],
      });
      const row = locks.sessions[0];
      if (
        !row ||
        row.accountId !== input.accountId ||
        row.importedArchiveImportId !== input.importId ||
        row.importedArchiveSubjectId !== input.subjectId
      ) {
        throw new ArchivedSessionImportError("SESSION_IMPORT_NOT_FOUND");
      }
      await revalidateImporter(tx, input, dependencies);
      const [existing] = await rawRows<{ requestHash: string; nextOffset: number }>(
        tx,
        sql`select request_hash as "requestHash", next_offset as "nextOffset"
          from opengeni_private.read_archived_session_import_batch(
            ${input.accountId}::uuid,${input.workspaceId}::uuid,${input.sessionId}::uuid,
            ${input.importId},${input.subjectId},${payload.batchId})`,
      );
      if (existing) {
        if (existing.requestHash !== requestHash)
          throw new ArchivedSessionImportError("SESSION_IMPORT_CONFLICT");
        return {
          sessionId: input.sessionId,
          importId: input.importId,
          nextOffset: existing.nextOffset,
          replayed: true,
          events: [],
        };
      }
      if (
        row.importedArchiveNextOffset !== payload.offset ||
        payload.offset + payload.events.length > 2_147_483_647 ||
        row.lastSequence + payload.events.length > 2_147_483_647
      ) {
        throw new ArchivedSessionImportError("SESSION_IMPORT_OFFSET_CONFLICT");
      }
      await validateFiles(tx, input, payload.events, dependencies);
      const events = await appendTimeline(
        tx,
        input,
        input.sessionId,
        row.lastSequence,
        payload.events,
      );
      const nextOffset = payload.offset + payload.events.length;
      await tx.execute(sql`select opengeni_private.record_archived_session_import_batch(
        ${input.accountId}::uuid,${input.workspaceId}::uuid,${input.sessionId}::uuid,
        ${input.importId},${input.subjectId},${payload.batchId},${requestHash},
        ${payload.offset}::integer,${payload.events.length}::integer)`);
      return {
        sessionId: input.sessionId,
        importId: input.importId,
        nextOffset,
        replayed: false,
        events,
      };
    },
    undefined,
    "shared",
    true,
  );
}

/** Scoped lookup only. Core authorizes the resolved target; another importer
 * never receives a session identity just because its shared timeline is visible. */
export async function getArchivedSessionImportId(
  db: Database,
  workspaceId: string,
  subjectId: string,
  importId: string,
): Promise<string | null> {
  return withWorkspaceSubjectRls(db, workspaceId, subjectId, async (tx) => {
    const [row] = await tx
      .select({ id: schema.sessions.id })
      .from(schema.sessions)
      .where(
        and(
          eq(schema.sessions.workspaceId, workspaceId),
          eq(schema.sessions.importedArchiveImportId, importId),
          eq(schema.sessions.importedArchiveSubjectId, subjectId),
        ),
      )
      .limit(1);
    return row?.id ?? null;
  });
}
