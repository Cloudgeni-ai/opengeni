import type {
  WorkspaceArtifact,
  WorkspaceArtifactDetailResponse,
  WorkspaceArtifactEvent,
  WorkspaceArtifactMutationResponse,
  WorkspaceArtifactVersion,
} from "@opengeni/contracts";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Database } from "./index";
import { withRlsContext, withWorkspaceRls } from "./index";
import * as schema from "./schema";

type ArtifactRow = typeof schema.workspaceArtifacts.$inferSelect;
type VersionRow = typeof schema.workspaceArtifactVersions.$inferSelect;
type EventRow = typeof schema.workspaceArtifactEvents.$inferSelect;

export class WorkspaceArtifactNotFoundError extends Error {
  readonly name = "WorkspaceArtifactNotFoundError";
}

export class WorkspaceArtifactConflictError extends Error {
  readonly name = "WorkspaceArtifactConflictError";
  constructor(
    message: string,
    readonly currentVersionId: string | null = null,
  ) {
    super(message);
  }
}

export class WorkspaceArtifactOperationError extends Error {
  readonly name = "WorkspaceArtifactOperationError";
}

function iso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function versionFromRow(row: VersionRow): WorkspaceArtifactVersion {
  return {
    id: row.id,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    artifactId: row.artifactId,
    revision: row.revision,
    contentType: "text/html",
    contentSha256: row.contentSha256,
    sizeBytes: row.sizeBytes,
    sourceSessionId: row.sourceSessionId,
    sourceTurnId: row.sourceTurnId,
    createdBySubjectId: row.createdBySubjectId,
    createdAt: iso(row.createdAt),
  };
}

function eventFromRow(row: EventRow): WorkspaceArtifactEvent {
  return {
    id: row.id,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    artifactId: row.artifactId,
    type: row.type,
    fromVersionId: row.fromVersionId,
    toVersionId: row.toVersionId,
    sourceSessionId: row.sourceSessionId,
    sourceTurnId: row.sourceTurnId,
    actorSubjectId: row.actorSubjectId,
    reason: row.reason,
    createdAt: iso(row.createdAt),
  };
}

function artifactFromRow(row: ArtifactRow, version: VersionRow | null): WorkspaceArtifact {
  return {
    id: row.id,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    slug: row.slug,
    title: row.title,
    description: row.description,
    status: row.status,
    currentVersion: version ? versionFromRow(version) : null,
    createdBySubjectId: row.createdBySubjectId,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

async function currentVersion(scopedDb: any, artifact: ArtifactRow): Promise<VersionRow | null> {
  if (!artifact.currentVersionId) return null;
  const [row] = await scopedDb
    .select()
    .from(schema.workspaceArtifactVersions)
    .where(
      and(
        eq(schema.workspaceArtifactVersions.workspaceId, artifact.workspaceId),
        eq(schema.workspaceArtifactVersions.id, artifact.currentVersionId),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function artifactRow(scopedDb: any, workspaceId: string, artifactId: string, lock = false) {
  let query = scopedDb
    .select()
    .from(schema.workspaceArtifacts)
    .where(
      and(
        eq(schema.workspaceArtifacts.workspaceId, workspaceId),
        eq(schema.workspaceArtifacts.id, artifactId),
      ),
    )
    .limit(1);
  if (lock) query = query.for("update");
  const [row] = await query;
  return (row as ArtifactRow | undefined) ?? null;
}

export async function listWorkspaceArtifacts(
  db: Database,
  workspaceId: string,
): Promise<WorkspaceArtifact[]> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await scopedDb
      .select()
      .from(schema.workspaceArtifacts)
      .where(eq(schema.workspaceArtifacts.workspaceId, workspaceId))
      .orderBy(desc(schema.workspaceArtifacts.updatedAt))
      .limit(100);
    return await Promise.all(
      rows.map(async (row) => artifactFromRow(row, await currentVersion(scopedDb, row))),
    );
  });
}

export async function getWorkspaceArtifact(
  db: Database,
  workspaceId: string,
  artifactId: string,
): Promise<WorkspaceArtifactDetailResponse> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const artifact = await artifactRow(scopedDb, workspaceId, artifactId);
    if (!artifact) throw new WorkspaceArtifactNotFoundError("Artifact not found");
    const [versions, events, current] = await Promise.all([
      scopedDb
        .select()
        .from(schema.workspaceArtifactVersions)
        .where(
          and(
            eq(schema.workspaceArtifactVersions.workspaceId, workspaceId),
            eq(schema.workspaceArtifactVersions.artifactId, artifactId),
          ),
        )
        .orderBy(desc(schema.workspaceArtifactVersions.revision))
        .limit(100),
      scopedDb
        .select()
        .from(schema.workspaceArtifactEvents)
        .where(
          and(
            eq(schema.workspaceArtifactEvents.workspaceId, workspaceId),
            eq(schema.workspaceArtifactEvents.artifactId, artifactId),
          ),
        )
        .orderBy(desc(schema.workspaceArtifactEvents.createdAt))
        .limit(100),
      currentVersion(scopedDb, artifact),
    ]);
    return {
      artifact: artifactFromRow(artifact, current),
      versions: versions.map(versionFromRow),
      events: events.map(eventFromRow),
    };
  });
}

export async function getWorkspaceArtifactContentRef(
  db: Database,
  workspaceId: string,
  artifactId: string,
  versionId?: string,
): Promise<{ artifactId: string; version: WorkspaceArtifactVersion; contentKey: string }> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const artifact = await artifactRow(scopedDb, workspaceId, artifactId);
    if (!artifact) throw new WorkspaceArtifactNotFoundError("Artifact not found");
    const targetId = versionId ?? artifact.currentVersionId;
    if (!targetId) throw new WorkspaceArtifactNotFoundError("Artifact has no published version");
    const [version] = await scopedDb
      .select()
      .from(schema.workspaceArtifactVersions)
      .where(
        and(
          eq(schema.workspaceArtifactVersions.workspaceId, workspaceId),
          eq(schema.workspaceArtifactVersions.artifactId, artifactId),
          eq(schema.workspaceArtifactVersions.id, targetId),
        ),
      )
      .limit(1);
    if (!version) throw new WorkspaceArtifactNotFoundError("Artifact version not found");
    return { artifactId, version: versionFromRow(version), contentKey: version.contentKey };
  });
}

type PublishMetadata = {
  accountId: string;
  workspaceId: string;
  contentKey: string;
  contentSha256: string;
  sizeBytes: number;
  operationKey: string;
  actorSubjectId: string;
  sourceSessionId: string | null;
  sourceTurnId: string | null;
};

async function replayForOperation(scopedDb: any, workspaceId: string, operationKey: string) {
  const [event] = await scopedDb
    .select()
    .from(schema.workspaceArtifactEvents)
    .where(
      and(
        eq(schema.workspaceArtifactEvents.workspaceId, workspaceId),
        eq(schema.workspaceArtifactEvents.operationKey, operationKey),
      ),
    )
    .limit(1);
  if (!event) return null;
  const artifact = await artifactRow(scopedDb, workspaceId, event.artifactId);
  if (!artifact) return null;
  const [version] = await scopedDb
    .select()
    .from(schema.workspaceArtifactVersions)
    .where(eq(schema.workspaceArtifactVersions.id, event.toVersionId))
    .limit(1);
  if (!version) return null;
  return { artifact, version, event, current: await currentVersion(scopedDb, artifact) } as const;
}

async function lockOperation(scopedDb: any, workspaceId: string, operationKey: string) {
  await scopedDb.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${workspaceId}:${operationKey}`}, 0))`,
  );
}

function assertCreateReplay(replay: Awaited<ReturnType<typeof replayForOperation>>) {
  if (
    !replay ||
    replay.event.type !== "published" ||
    replay.event.fromVersionId !== null ||
    replay.version.revision !== 1
  ) {
    throw new WorkspaceArtifactConflictError(
      "Idempotency key was already used for a different operation",
    );
  }
}

function assertPublishReplay(
  replay: Awaited<ReturnType<typeof replayForOperation>>,
  artifactId: string,
  expectedCurrentVersionId: string,
) {
  if (
    !replay ||
    replay.event.type !== "published" ||
    replay.event.artifactId !== artifactId ||
    replay.event.fromVersionId !== expectedCurrentVersionId
  ) {
    throw new WorkspaceArtifactConflictError(
      "Idempotency key was already used for a different operation",
    );
  }
}

function assertRollbackReplay(
  replay: Awaited<ReturnType<typeof replayForOperation>>,
  artifactId: string,
  versionId: string,
  expectedCurrentVersionId: string,
  reason: string,
) {
  if (
    !replay ||
    replay.event.type !== "rolled_back" ||
    replay.event.artifactId !== artifactId ||
    replay.event.toVersionId !== versionId ||
    replay.event.fromVersionId !== expectedCurrentVersionId ||
    replay.event.reason !== reason
  ) {
    throw new WorkspaceArtifactConflictError(
      "Idempotency key was already used for a different operation",
    );
  }
}

function mutationResult(
  artifact: ArtifactRow,
  version: VersionRow,
  event: EventRow,
  replayed: boolean,
  displayedCurrentVersion: VersionRow = version,
): WorkspaceArtifactMutationResponse {
  return {
    artifact: artifactFromRow(artifact, displayedCurrentVersion),
    version: versionFromRow(version),
    event: eventFromRow(event),
    replayed,
  };
}

export async function createWorkspaceArtifact(
  db: Database,
  input: PublishMetadata & {
    artifactId: string;
    slug: string;
    title: string;
    description: string | null;
  },
): Promise<WorkspaceArtifactMutationResponse> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const replay = await replayForOperation(scopedDb, input.workspaceId, input.operationKey);
      if (replay) {
        assertCreateReplay(replay);
        if (replay.version.contentSha256 !== input.contentSha256) {
          throw new WorkspaceArtifactConflictError(
            "Idempotency key was already used with different content",
          );
        }
        return mutationResult(
          replay.artifact,
          replay.version,
          replay.event,
          true,
          replay.current ?? replay.version,
        );
      }
      return await scopedDb.transaction(async (tx) => {
        await lockOperation(tx, input.workspaceId, input.operationKey);
        const concurrentReplay = await replayForOperation(
          tx,
          input.workspaceId,
          input.operationKey,
        );
        if (concurrentReplay) {
          assertCreateReplay(concurrentReplay);
          if (concurrentReplay.version.contentSha256 !== input.contentSha256) {
            throw new WorkspaceArtifactConflictError(
              "Idempotency key was already used with different content",
            );
          }
          return mutationResult(
            concurrentReplay.artifact,
            concurrentReplay.version,
            concurrentReplay.event,
            true,
            concurrentReplay.current ?? concurrentReplay.version,
          );
        }
        const [artifact] = await tx
          .insert(schema.workspaceArtifacts)
          .values({
            id: input.artifactId,
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            slug: input.slug,
            title: input.title,
            description: input.description,
            createdBySubjectId: input.actorSubjectId,
          })
          .returning();
        const [version] = await tx
          .insert(schema.workspaceArtifactVersions)
          .values({
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            artifactId: input.artifactId,
            revision: 1,
            contentKey: input.contentKey,
            contentSha256: input.contentSha256,
            sizeBytes: input.sizeBytes,
            operationKey: input.operationKey,
            sourceSessionId: input.sourceSessionId,
            sourceTurnId: input.sourceTurnId,
            createdBySubjectId: input.actorSubjectId,
          })
          .returning();
        const [updated] = await tx
          .update(schema.workspaceArtifacts)
          .set({
            currentVersionId: version!.id,
            updatedAt: new Date(),
          })
          .where(eq(schema.workspaceArtifacts.id, artifact!.id))
          .returning();
        const [event] = await tx
          .insert(schema.workspaceArtifactEvents)
          .values({
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            artifactId: input.artifactId,
            type: "published",
            fromVersionId: null,
            toVersionId: version!.id,
            operationKey: input.operationKey,
            sourceSessionId: input.sourceSessionId,
            sourceTurnId: input.sourceTurnId,
            actorSubjectId: input.actorSubjectId,
            reason: "Initial publication",
          })
          .returning();
        return mutationResult(updated!, version!, event!, false);
      });
    },
  );
}

export async function publishWorkspaceArtifactVersion(
  db: Database,
  input: PublishMetadata & {
    artifactId: string;
    expectedCurrentVersionId: string;
    title?: string;
    description?: string | null;
  },
): Promise<WorkspaceArtifactMutationResponse> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const replay = await replayForOperation(scopedDb, input.workspaceId, input.operationKey);
      if (replay) {
        assertPublishReplay(replay, input.artifactId, input.expectedCurrentVersionId);
        if (replay.version.contentSha256 !== input.contentSha256)
          throw new WorkspaceArtifactConflictError(
            "Idempotency key was already used with different content",
          );
        return mutationResult(
          replay.artifact,
          replay.version,
          replay.event,
          true,
          replay.current ?? replay.version,
        );
      }
      return await scopedDb.transaction(async (tx) => {
        await lockOperation(tx, input.workspaceId, input.operationKey);
        const concurrentReplay = await replayForOperation(
          tx,
          input.workspaceId,
          input.operationKey,
        );
        if (concurrentReplay) {
          assertPublishReplay(concurrentReplay, input.artifactId, input.expectedCurrentVersionId);
          if (concurrentReplay.version.contentSha256 !== input.contentSha256) {
            throw new WorkspaceArtifactConflictError(
              "Idempotency key was already used with different content",
            );
          }
          return mutationResult(
            concurrentReplay.artifact,
            concurrentReplay.version,
            concurrentReplay.event,
            true,
            concurrentReplay.current ?? concurrentReplay.version,
          );
        }
        const artifact = await artifactRow(tx, input.workspaceId, input.artifactId, true);
        if (!artifact) throw new WorkspaceArtifactNotFoundError("Artifact not found");
        if (artifact.currentVersionId !== input.expectedCurrentVersionId) {
          throw new WorkspaceArtifactConflictError(
            "Artifact changed in another request",
            artifact.currentVersionId,
          );
        }
        const [latest] = await tx
          .select()
          .from(schema.workspaceArtifactVersions)
          .where(
            and(
              eq(schema.workspaceArtifactVersions.workspaceId, input.workspaceId),
              eq(schema.workspaceArtifactVersions.artifactId, input.artifactId),
            ),
          )
          .orderBy(desc(schema.workspaceArtifactVersions.revision))
          .limit(1);
        const [version] = await tx
          .insert(schema.workspaceArtifactVersions)
          .values({
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            artifactId: input.artifactId,
            revision: (latest?.revision ?? 0) + 1,
            contentKey: input.contentKey,
            contentSha256: input.contentSha256,
            sizeBytes: input.sizeBytes,
            operationKey: input.operationKey,
            sourceSessionId: input.sourceSessionId,
            sourceTurnId: input.sourceTurnId,
            createdBySubjectId: input.actorSubjectId,
          })
          .returning();
        const update: Partial<typeof schema.workspaceArtifacts.$inferInsert> = {
          currentVersionId: version!.id,
          updatedAt: new Date(),
        };
        if (input.title !== undefined) update.title = input.title;
        if (input.description !== undefined) update.description = input.description;
        const [updated] = await tx
          .update(schema.workspaceArtifacts)
          .set(update)
          .where(eq(schema.workspaceArtifacts.id, artifact.id))
          .returning();
        const [event] = await tx
          .insert(schema.workspaceArtifactEvents)
          .values({
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            artifactId: input.artifactId,
            type: "published",
            fromVersionId: artifact.currentVersionId,
            toVersionId: version!.id,
            operationKey: input.operationKey,
            sourceSessionId: input.sourceSessionId,
            sourceTurnId: input.sourceTurnId,
            actorSubjectId: input.actorSubjectId,
            reason: `Published revision ${version!.revision}`,
          })
          .returning();
        return mutationResult(updated!, version!, event!, false);
      });
    },
  );
}

export async function rollbackWorkspaceArtifact(
  db: Database,
  input: Omit<PublishMetadata, "contentKey" | "contentSha256" | "sizeBytes"> & {
    artifactId: string;
    versionId: string;
    expectedCurrentVersionId: string;
    reason: string;
  },
): Promise<WorkspaceArtifactMutationResponse> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const replay = await replayForOperation(scopedDb, input.workspaceId, input.operationKey);
      if (replay) {
        assertRollbackReplay(
          replay,
          input.artifactId,
          input.versionId,
          input.expectedCurrentVersionId,
          input.reason,
        );
        return mutationResult(
          replay.artifact,
          replay.version,
          replay.event,
          true,
          replay.current ?? replay.version,
        );
      }
      return await scopedDb.transaction(async (tx) => {
        await lockOperation(tx, input.workspaceId, input.operationKey);
        const concurrentReplay = await replayForOperation(
          tx,
          input.workspaceId,
          input.operationKey,
        );
        if (concurrentReplay) {
          assertRollbackReplay(
            concurrentReplay,
            input.artifactId,
            input.versionId,
            input.expectedCurrentVersionId,
            input.reason,
          );
          return mutationResult(
            concurrentReplay.artifact,
            concurrentReplay.version,
            concurrentReplay.event,
            true,
            concurrentReplay.current ?? concurrentReplay.version,
          );
        }
        const artifact = await artifactRow(tx, input.workspaceId, input.artifactId, true);
        if (!artifact) throw new WorkspaceArtifactNotFoundError("Artifact not found");
        if (artifact.currentVersionId !== input.expectedCurrentVersionId)
          throw new WorkspaceArtifactConflictError(
            "Artifact changed in another request",
            artifact.currentVersionId,
          );
        const [target] = await tx
          .select()
          .from(schema.workspaceArtifactVersions)
          .where(
            and(
              eq(schema.workspaceArtifactVersions.workspaceId, input.workspaceId),
              eq(schema.workspaceArtifactVersions.artifactId, input.artifactId),
              eq(schema.workspaceArtifactVersions.id, input.versionId),
            ),
          )
          .limit(1);
        if (!target) throw new WorkspaceArtifactNotFoundError("Artifact version not found");
        const [updated] = await tx
          .update(schema.workspaceArtifacts)
          .set({ currentVersionId: target.id, updatedAt: new Date() })
          .where(eq(schema.workspaceArtifacts.id, artifact.id))
          .returning();
        const [event] = await tx
          .insert(schema.workspaceArtifactEvents)
          .values({
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            artifactId: input.artifactId,
            type: "rolled_back",
            fromVersionId: artifact.currentVersionId,
            toVersionId: target.id,
            operationKey: input.operationKey,
            sourceSessionId: input.sourceSessionId,
            sourceTurnId: input.sourceTurnId,
            actorSubjectId: input.actorSubjectId,
            reason: input.reason,
          })
          .returning();
        return mutationResult(updated!, target, event!, false);
      });
    },
  );
}
